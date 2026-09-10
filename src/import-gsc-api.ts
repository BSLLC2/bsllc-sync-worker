#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import pg from "pg";
import { runDashboardSync, type SyncEntry } from "./emit.js";

/**
 * Google Search Console → dashboard importer (LIVE API). Replaces the CSV-only
 * import-gsc.ts so organic search data auto-refreshes like every other source
 * instead of going stale. Uses the shared service account + Search Console API,
 * reads each client's property from Admin → Connectors (source='gsc'), and
 * plants a trailing-30-day gsc.* snapshot per client via `npm run sync`.
 *
 * Prereqs (one-time, per property — no new secret):
 *   1. In Search Console, add the service account's client_email as a user
 *      (Settings → Users and permissions → Add user, Full or Restricted).
 *   2. Enter the property in Admin → Connectors → Search Console. The external_id
 *      is the GSC property: "sc-domain:example.com" (domain) or
 *      "https://example.com/" (URL-prefix).
 *
 * Usage:  npm run import-gsc-api [-- --dry-run] [--days=30] [--client=<clientId>] [--since=2023-01-01]
 *
 * --since switches from the normal trailing-window pull to a one-time
 * historical catch-up: one gsc.* snapshot per CALENDAR MONTH from that date
 * to today (mirroring import-ga4.ts's --since), so a client's search-position
 * trend has real history the moment their property is connected instead of
 * only ever accumulating forward from whenever that happened. Used by
 * backfill-client-since.yml when a contract start date is set.
 */

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://searchconsole.googleapis.com/webmasters/v3";

function serviceAccount(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON.");
  let json: any;
  try { json = JSON.parse(raw); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON."); }
  if (!json.client_email || !json.private_key) throw new Error("Service-account JSON missing client_email / private_key.");
  return json;
}

async function gscToken(): Promise<string> {
  const sa = serviceAccount();
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SCOPE] });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Failed to mint a Search Console access token.");
  return token;
}

/** Which client uses which GSC property — from Admin → Connectors. */
async function mapFromDb(databaseUrl: string): Promise<Record<string, string>> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ client_id: string; external_id: string }>(
      "SELECT client_id, external_id FROM connector_mappings WHERE source = 'gsc' AND enabled = true AND external_id IS NOT NULL AND external_id <> ''",
    );
    const m: Record<string, string> = {};
    for (const r of rows) m[r.client_id] = r.external_id.trim();
    return m;
  } finally {
    await client.end();
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Trailing window totals for a property. No dimensions → one aggregate row
 *  (clicks, impressions, ctr, position) for the whole range. */
async function queryTotals(token: string, siteUrl: string, startDate: string, endDate: string): Promise<
  { clicks: number; impressions: number; ctr: number; position: number } | null
> {
  const res = await fetch(`${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ startDate, endDate, dimensions: [], dataState: "final" }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Never assert a cause on 403 without reading the body. Search Console
    // returns 403 both for "this account is not a user on this property" and
    // for "the Search Console API is disabled on this GCP project", and the
    // fixes are in different consoles. Asserting the first cost days of
    // looking at property permissions while the API sat switched off.
    if (res.status === 403 && /has not been used in project|is disabled/i.test(body)) {
      throw new Error(`GSC API is DISABLED on the Google Cloud project — this is not a property permission. ${body.slice(0, 300)}`);
    }
    if (res.status === 403) throw new Error(`GSC 403 for ${siteUrl}: ${body.slice(0, 300)}`);
    throw new Error(`GSC query ${siteUrl} → ${res.status} ${body.slice(0, 200)}`);
  }
  const json: any = await res.json();
  const row = json.rows?.[0];
  if (!row) return null;
  return { clicks: Number(row.clicks ?? 0), impressions: Number(row.impressions ?? 0), ctr: Number(row.ctr ?? 0), position: Number(row.position ?? 0) };
}

interface DayRow { date: string; clicks: number; impressions: number; position: number }

/** Same query as queryTotals but dimensioned by day, for bucketing into
 *  monthly snapshots. rowLimit covers years of daily rows without pagination
 *  — plenty for any real contract length. */
async function queryDaily(token: string, siteUrl: string, startDate: string, endDate: string): Promise<DayRow[]> {
  const res = await fetch(`${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ startDate, endDate, dimensions: [{ name: "date" }], dataState: "final", rowLimit: 25000 }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403 && /has not been used in project|is disabled/i.test(body)) {
      throw new Error(`GSC API is DISABLED on the Google Cloud project — this is not a property permission. ${body.slice(0, 300)}`);
    }
    if (res.status === 403) throw new Error(`GSC 403 for ${siteUrl}: ${body.slice(0, 300)}`);
    throw new Error(`GSC query ${siteUrl} → ${res.status} ${body.slice(0, 200)}`);
  }
  const j: any = await res.json();
  return (j.rows ?? []).map((r: any) => ({
    date: String(r.keys?.[0] ?? ""),
    clicks: Number(r.clicks ?? 0),
    impressions: Number(r.impressions ?? 0),
    position: Number(r.position ?? 0),
  })).filter((r: DayRow) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
}

/** Calendar-month bounds for a "YYYY-MM" key, matching import-ga4.ts's
 *  monthBounds so a client's GA4 and GSC monthly snapshots line up. */
function monthBoundsYm(ym: string): { start: string; end: string } {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${ym}-${String(last).padStart(2, "0")}`;
  // The --since backfill iterates through the CURRENT, still-in-progress
  // month too -- capping at the calendar month's last day would then stamp
  // period_end/synced_at days or weeks in the future (see import-ga4.ts,
  // which hit this for real). Cap at today; a finished past month's end date
  // is always <= today already, so this only changes the in-progress month.
  const today = new Date().toISOString().slice(0, 10);
  return { start: `${ym}-01`, end: end > today ? today : end };
}

/** Sums daily rows into calendar months. Clicks/impressions add directly;
 *  position is impressions-weighted (not a naive average of daily averages)
 *  so a high-traffic day's ranking counts more than a near-zero-traffic one —
 *  the same principle CTR already gets by being recomputed from the summed
 *  totals rather than averaged. */
function bucketMonthly(rows: DayRow[]): Map<string, { clicks: number; impressions: number; posWeighted: number }> {
  const m = new Map<string, { clicks: number; impressions: number; posWeighted: number }>();
  for (const r of rows) {
    const ym = r.date.slice(0, 7);
    const cur = m.get(ym) ?? { clicks: 0, impressions: 0, posWeighted: 0 };
    cur.clicks += r.clicks;
    cur.impressions += r.impressions;
    cur.posWeighted += r.position * r.impressions;
    m.set(ym, cur);
  }
  return m;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const days = Number(argv.find((a) => a.startsWith("--days="))?.slice(7) || 30);
  const onlyClient = (argv.find((a) => a.startsWith("--client="))?.slice(9) || "").trim();
  const since = (argv.find((a) => a.startsWith("--since="))?.slice(8) || "").trim();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const dashboardDir = process.env.DASHBOARD_DIR?.trim();
  if (!databaseUrl || !dashboardDir) throw new Error("Missing DATABASE_URL / DASHBOARD_DIR.");

  let map = await mapFromDb(databaseUrl);
  if (onlyClient) map = Object.fromEntries(Object.entries(map).filter(([clientId]) => clientId === onlyClient));
  if (!Object.keys(map).length) { console.log("No GSC properties in Admin → Connectors — nothing to import."); return; }

  const token = await gscToken();
  const syncs: SyncEntry[] = [];

  if (since) {
    // Historical catch-up: one snapshot per calendar month from `since` to
    // today, same shape as import-ga4.ts's --since path.
    const end = iso(new Date(Date.now() - 2 * 86_400_000)); // GSC lags ~2 days
    console.log(`GSC historical import — ${Object.keys(map).length} propert(ies), ${since}…${end}${dryRun ? " (dry-run)" : ""}`);
    for (const [slug, siteUrl] of Object.entries(map)) {
      try {
        const daily = await queryDaily(token, siteUrl, since, end);
        const monthly = bucketMonthly(daily);
        let planted = 0;
        for (const [ym, agg] of monthly) {
          const { start, end: monthEnd } = monthBoundsYm(ym);
          if (agg.impressions === 0) continue;
          syncs.push({
            client_id: slug, source: "gsc", external_id: siteUrl,
            period_start: start, period_end: monthEnd, synced_at: `${monthEnd}T12:00:00.000Z`,
            data_state: "live", error_message: null,
            metrics: {
              "gsc.clicks": agg.clicks, "gsc.impressions": agg.impressions,
              "gsc.ctr": agg.impressions > 0 ? agg.clicks / agg.impressions : 0,
              "gsc.avg_position": agg.impressions > 0 ? agg.posWeighted / agg.impressions : 0,
            },
          });
          planted++;
        }
        console.log(`  ${slug} (${siteUrl}) — ${planted} month(s) from ${daily.length} daily row(s)`);
      } catch (e) {
        syncs.push({
          client_id: slug, source: "gsc", external_id: siteUrl,
          period_start: since, period_end: end, synced_at: new Date().toISOString(),
          data_state: "error", error_message: (e instanceof Error ? e.message : String(e)).slice(0, 300), metrics: {},
        });
        console.log(`  ✗ ${slug} (${siteUrl}) — ${e instanceof Error ? e.message : e}`);
      }
    }
  } else {
    // Normal trailing-window pull (daily cron + the on-demand Refresh
    // button) — unchanged from before --since existed.
    const end = new Date(Date.now() - 2 * 86_400_000);
    const start = new Date(end.getTime() - (days - 1) * 86_400_000);
    // Alongside the trailing window: the calendar month to date (so the
    // month-by-month table gets a real current-month cell), and the month
    // that just closed for its first week so its final figure lands.
    const windows: Array<{ start: string; end: string; label: string }> = [{ start: iso(start), end: iso(end), label: "trailing" }];
    const monthStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    if (monthStart <= end) windows.push({ start: iso(monthStart), end: iso(end), label: "month-to-date" });
    if (end.getUTCDate() <= 7) {
      const prevStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
      const prevEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 0));
      windows.push({ start: iso(prevStart), end: iso(prevEnd), label: "previous month" });
    }
    console.log(`GSC import — ${Object.keys(map).length} propert(ies), ${iso(start)}…${iso(end)} + ${windows.length - 1} calendar window(s)${dryRun ? " (dry-run)" : ""}`);
    for (const [slug, siteUrl] of Object.entries(map)) {
      for (const w of windows) {
        const base = {
          client_id: slug, source: "gsc" as const, external_id: siteUrl,
          period_start: w.start, period_end: w.end, synced_at: new Date().toISOString(),
        };
        try {
          const t = await queryTotals(token, siteUrl, w.start, w.end);
          if (!t || t.impressions === 0) {
            syncs.push({ ...base, data_state: "no_data", error_message: null, metrics: {} });
            console.log(`  ${slug} (${siteUrl}) ${w.label} — no data`);
            continue;
          }
          syncs.push({
            ...base, data_state: "live", error_message: null,
            metrics: { "gsc.clicks": t.clicks, "gsc.impressions": t.impressions, "gsc.ctr": t.ctr, "gsc.avg_position": t.position },
          });
          console.log(`  ${slug} (${siteUrl}) ${w.label} — ${t.clicks} clicks · ${t.impressions} impr · pos ${t.position.toFixed(1)}`);
        } catch (e) {
          syncs.push({ ...base, data_state: "error", error_message: (e instanceof Error ? e.message : String(e)).slice(0, 300), metrics: {} });
          console.log(`  ✗ ${slug} (${siteUrl}) ${w.label} — ${e instanceof Error ? e.message : e}`);
          break; // a 403 will repeat for every window; record it once
        }
      }
    }
  }

  const code = runDashboardSync({ databaseUrl, dashboardDir }, syncs, { dryRun });

  // A per-property fetch failure (e.g. GSC 403) still lets the sync itself
  // succeed — it persists an 'error' row rather than crashing. That let this
  // job report green in GitHub Actions for days while every property 403'd
  // and gsc.* metrics silently went stale. Fail loud when nothing came back
  // live so a broken credential/permission shows up as a red run, not silence.
  const errored = syncs.filter((s) => s.data_state === "error");
  if (syncs.length > 0 && errored.length === syncs.length) {
    console.error(`\nAll ${syncs.length} GSC propert(ies) failed. When EVERY property fails at once the`);
    console.error(`cause is almost never per-property permissions — look at the credential and`);
    console.error(`at whether the Search Console API is enabled on the Cloud project. First error:`);
    console.error(`  ${errored[0]?.error_message ?? "(none recorded)"}`);
    process.exit(1);
  }
  process.exit(code);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

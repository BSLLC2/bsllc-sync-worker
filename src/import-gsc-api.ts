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
 * Usage:  npm run import-gsc-api [-- --dry-run] [--days=30]
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
    if (res.status === 403) throw new Error(`GSC 403 for ${siteUrl} — add the service account as a user in Search Console.`);
    throw new Error(`GSC query ${siteUrl} → ${res.status} ${body.slice(0, 200)}`);
  }
  const json: any = await res.json();
  const row = json.rows?.[0];
  if (!row) return null;
  return { clicks: Number(row.clicks ?? 0), impressions: Number(row.impressions ?? 0), ctr: Number(row.ctr ?? 0), position: Number(row.position ?? 0) };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const days = Number(argv.find((a) => a.startsWith("--days="))?.slice(7) || 30);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const dashboardDir = process.env.DASHBOARD_DIR?.trim();
  if (!databaseUrl || !dashboardDir) throw new Error("Missing DATABASE_URL / DASHBOARD_DIR.");

  const map = await mapFromDb(databaseUrl);
  if (!Object.keys(map).length) { console.log("No GSC properties in Admin → Connectors — nothing to import."); return; }

  // GSC data lags ~2 days; end the window there and go back `days`.
  const end = new Date(Date.now() - 2 * 86_400_000);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const token = await gscToken();
  console.log(`GSC import — ${Object.keys(map).length} propert(ies), ${iso(start)}…${iso(end)}${dryRun ? " (dry-run)" : ""}`);

  const syncs: SyncEntry[] = [];
  for (const [slug, siteUrl] of Object.entries(map)) {
    const base = {
      client_id: slug, source: "gsc" as const, external_id: siteUrl,
      period_start: iso(start), period_end: iso(end), synced_at: new Date().toISOString(),
    };
    try {
      const t = await queryTotals(token, siteUrl, iso(start), iso(end));
      if (!t || t.impressions === 0) {
        syncs.push({ ...base, data_state: "no_data", error_message: null, metrics: {} });
        console.log(`  ${slug} (${siteUrl}) — no data`);
        continue;
      }
      syncs.push({
        ...base, data_state: "live", error_message: null,
        metrics: { "gsc.clicks": t.clicks, "gsc.impressions": t.impressions, "gsc.ctr": t.ctr, "gsc.avg_position": t.position },
      });
      console.log(`  ${slug} (${siteUrl}) — ${t.clicks} clicks · ${t.impressions} impr · pos ${t.position.toFixed(1)}`);
    } catch (e) {
      syncs.push({ ...base, data_state: "error", error_message: (e instanceof Error ? e.message : String(e)).slice(0, 300), metrics: {} });
      console.log(`  ✗ ${slug} (${siteUrl}) — ${e instanceof Error ? e.message : e}`);
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
    console.error(`\nAll ${syncs.length} GSC propert(ies) failed — likely missing Search Console permission for the service account.`);
    process.exit(1);
  }
  process.exit(code);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

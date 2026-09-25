#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import pg from "pg";
import { runDashboardSync, type SyncEntry, type ChannelMetricRow } from "./emit.js";
import { monthSnapshot } from "./dates.js";
import { evidencedMetric } from "./metric-evidence.js";
import { channelRows, channelSince, DEFAULT_CHANNEL_MONTHS } from "./ga4/channel-rows.js";

/**
 * GA4 → dashboard conversions importer. For clients where we have no CRM to
 * read, GA4 (or GTM) conversions are the next-best proof of results. This reads
 * the GA4 Data API with the shared service account, monthly, and plants
 * `ga4.conversions` per client — which the Marketing tab's source waterfall
 * already prefers over Ads conversions.
 *
 * The worker owns zero DB writes — it hands the payload to `npm run sync`.
 *
 * Prereqs (one-time):
 *   1. Add the service account's client_email as a Viewer on each GA4 property
 *      (Admin → Property Access Management).
 *   2. Provide the client→property map (slug:propertyId). Either:
 *        --map=slug:123,slug2:456
 *      or the GA4_PROPERTY_MAP env as JSON: {"slug":"123","slug2":"456"}
 *
 * Usage:
 *   npm run import-ga4 -- --map=diesel-power-group:460370940 [--since=2023-01-01] [--dry-run] [--client=<clientId>]
 */

interface Args {
  map: Record<string, string>;
  since: string;
  dryRun: boolean;
  onlyClient: string;
  /** How many months back the per-channel breakdown reads. See
   *  DEFAULT_CHANNEL_MONTHS — nothing is backfilled unless somebody widens it. */
  channelMonths: number;
}

function parseArgs(argv: string[]): Args {
  let mapStr = "";
  let since = "2023-01-01";
  let dryRun = false;
  let onlyClient = "";
  let channelMonths = DEFAULT_CHANNEL_MONTHS;
  for (const a of argv) {
    if (a.startsWith("--map=")) mapStr = a.slice("--map=".length);
    else if (a.startsWith("--since=")) since = a.slice("--since=".length);
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--client=")) onlyClient = a.slice("--client=".length).trim();
    else if (a.startsWith("--channel-months=")) channelMonths = Math.max(0, Number(a.slice("--channel-months=".length)) || 0);
  }
  const map: Record<string, string> = {};
  if (mapStr) {
    for (const pair of mapStr.split(",")) {
      const [slug, prop] = pair.split(":");
      if (slug && prop) map[slug.trim()] = prop.trim();
    }
  }
  return { map, since, dryRun, onlyClient, channelMonths };
}

/**
 * The source of truth for which client uses which GA4 property is the dashboard
 * itself: Admin → Connectors, stored in connector_mappings (source='ga4',
 * external_id = property id). Reading it here means "add the number in the
 * admin" just works — no secret to maintain. The GA4_PROPERTY_MAP secret and
 * --map arg are merged in as optional extras/overrides.
 */
async function mapFromDb(databaseUrl: string): Promise<Record<string, string>> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ client_id: string; external_id: string; name: string | null }>(
      `SELECT cm.client_id, cm.external_id, c.name
         FROM connector_mappings cm LEFT JOIN clients c ON c.id = cm.client_id
        WHERE cm.source = 'ga4' AND cm.enabled = true
          AND cm.external_id IS NOT NULL AND cm.external_id <> ''`,
    );
    const m: Record<string, string> = {};
    // Keep a client_id → name side table purely so failures can name the client.
    // A bare UUID in an error tells whoever reads the log nothing they can act on.
    for (const r of rows) { m[r.client_id] = propertyId(r.external_id); if (r.name) CLIENT_NAMES[r.client_id] = r.name; }
    return m;
  } finally {
    await client.end();
  }
}

/**
 * Accept a GA4 property id in either form people actually paste into Admin →
 * Connectors: the bare number the GA4 UI shows, or the "properties/123"
 * resource name from the API docs. runReport's path adds the prefix itself, so
 * the second form produced .../properties/properties/123 and a bare HTML 404 --
 * which surfaced as a dead connector rather than as a fixable typo.
 */
const propertyId = (raw: string) => raw.trim().replace(/^properties\//i, "").trim();

/** client_id → display name, populated from the connector query, for error output. */
const CLIENT_NAMES: Record<string, string> = {};
const label = (clientId: string) => CLIENT_NAMES[clientId] ?? clientId;

function serviceAccount(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON.");
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }
  if (!json.client_email || !json.private_key) throw new Error("Service-account JSON missing client_email / private_key.");
  return json;
}

async function ga4Token(): Promise<string> {
  const sa = serviceAccount();
  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Failed to mint a GA4 access token from the service account.");
  return token;
}

/** Run a monthly conversions report. Falls back to `keyEvents` (GA4's newer
 *  name for conversions) if `conversions` is rejected by the property.
 *
 *  `extraDimension` adds a SECOND dimension to the request and is how the
 *  per-channel breakdown is asked for. Omitted — which is what every existing
 *  caller does — the request body is exactly what it has always been, so the
 *  three blended keys every figure in the dashboard reads cannot move. */
async function runReport(token: string, propertyId: string, since: string, metrics: string[], extraDimension?: string): Promise<any> {
  const dimensions = extraDimension ? [{ name: "yearMonth" }, { name: extraDimension }] : [{ name: "yearMonth" }];
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: since, endDate: "today" }],
      dimensions,
      metrics: metrics.map((name) => ({ name })),
      orderBys: [{ dimension: { dimensionName: "yearMonth" } }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403) throw new Error(`GA4 403 for property ${propertyId} — in GA4 Admin → Property access, add ${serviceAccount().client_email} as a Viewer.`);
    const err = new Error(`GA4 runReport ${propertyId} (${metrics.join(",")}) → ${res.status} ${body}`);
    (err as any).status = res.status;
    (err as any).body = body;
    throw err;
  }
  return res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const dashboardDir = process.env.DASHBOARD_DIR?.trim();
  if (!databaseUrl || !dashboardDir) throw new Error("Missing DATABASE_URL / DASHBOARD_DIR.");

  // Source of truth: GA4 property IDs entered in the dashboard (Admin →
  // Connectors). Merge in the optional secret + --map as extras/overrides.
  const map: Record<string, string> = await mapFromDb(databaseUrl);
  const fromDb = Object.keys(map).length;
  if (process.env.GA4_PROPERTY_MAP) {
    try { Object.assign(map, JSON.parse(process.env.GA4_PROPERTY_MAP)); } catch { throw new Error("GA4_PROPERTY_MAP is not valid JSON."); }
  }
  Object.assign(map, args.map); // --map wins
  for (const k of Object.keys(map)) map[k] = propertyId(map[k]!);
  if (args.onlyClient) {
    for (const clientId of Object.keys(map)) if (clientId !== args.onlyClient) delete map[clientId];
  }
  if (!Object.keys(map).length) {
    throw new Error("No GA4 property IDs found. Add them in the dashboard (Admin → Connectors → GA4) or set GA4_PROPERTY_MAP.");
  }
  console.log(`GA4 import — ${Object.keys(map).length} client(s) (${fromDb} from dashboard connectors), since ${args.since}${args.dryRun ? " (dry-run)" : ""}`);
  const token = await ga4Token();

  const syncs: SyncEntry[] = [];
  const channels: ChannelMetricRow[] = [];
  /** One line per property about the breakdown, printed with the rest at the
   *  end. A note here is never fatal: the three blended keys are already in
   *  `syncs` by the time the second call runs. */
  const channelNotes: string[] = [];
  const chanSince = channelSince(args.channelMonths, args.since, new Date());
  if (!chanSince) console.log("  (per-channel breakdown off: --channel-months=0)");
  const denied: string[] = [];
  for (const [slug, propertyId] of Object.entries(map)) {
    // GA4 renamed "conversions" → "keyEvents". Ask for keyEvents first (current
    // properties), fall back to conversions (older ones) on a 400. Always pull
    // sessions too so the traffic tile lights up even when 0 conversions exist.
    // totalRevenue is GA4's own e-commerce revenue metric (e.g. Tablespoon's
    // class-ticket purchases tracked as GA4 purchase events) — a genuinely
    // separate income stream from HubSpot/Square, not an alternate read of
    // the same number. See shared/schema.ts SIGNAL_CONNECTOR_KEYS.revenue.
    let report: any;
    let convMetric = "keyEvents";
    try {
      try {
        report = await runReport(token, propertyId, args.since, ["sessions", "keyEvents", "totalRevenue"]);
      } catch (e) {
        if ((e as any).status === 400) {
          convMetric = "conversions";
          report = await runReport(token, propertyId, args.since, ["sessions", "conversions", "totalRevenue"]);
        } else throw e;
      }
    } catch (e) {
      // One client's missing grant must not blank every other client. This used
      // to throw straight out of the loop, so a single un-shared property cost
      // the whole run — and the log named only that first property, hiding how
      // many others were also broken. Record it, keep going, and report the
      // full list at the end so every grant can be fixed in one pass.
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      console.error(`  ${label(slug)} (property ${propertyId}) — FAILED: ${msg}`);
      denied.push(`${label(slug)} → GA4 property ${propertyId}`);
      continue;
    }
    const rows: any[] = report.rows ?? [];
    // What this property demonstrably reports, read off its OWN history before
    // any month is planted. GA4 answers 0 both for "nobody converted" and for
    // "no key event is configured on this property", and the API never says
    // which — so a live 0 is only honest where the property has reported a
    // non-zero figure for that metric at some point in the window. Everywhere
    // else the metric goes in as null, which the dashboard's sync records as
    // no_data for that one key: the run happened, the metric has nothing
    // behind it. See metric-evidence.ts for why this is not read from the
    // Admin API, and for how it corrects itself the moment one event fires.
    //
    // Revenue was already held back this way (an unconfigured property answers
    // $0 forever and a live $0 would land in every revenue breakdown); it was
    // OMITTED rather than nulled, which left no row at all and so read as
    // "never imported". Both metrics now take the same route, and the run is
    // always on the record.
    const convWindow = rows.map((r: any) => Number(r.metricValues?.[1]?.value ?? 0));
    const revWindow = rows.map((r: any) => Number(r.metricValues?.[2]?.value ?? 0));
    let planted = 0;
    let convUnevidenced = 0;
    for (const row of rows) {
      const ym = row.dimensionValues?.[0]?.value; // "YYYYMM"
      if (!ym || !/^\d{6}$/.test(ym)) continue;
      const sessions = Number(row.metricValues?.[0]?.value ?? 0);
      const conv = Number(row.metricValues?.[1]?.value ?? 0);
      const revenueCents = Math.round(Number(row.metricValues?.[2]?.value ?? 0) * 100);
      // GA4 reports the CURRENT, in-progress month too — monthSnapshot caps
      // it at today so period_end/synced_at never land in the future.
      const { start, end, syncedAt } = monthSnapshot(ym);
      const convValue = evidencedMetric(conv, convWindow);
      if (convValue == null) convUnevidenced++;
      const metrics: Record<string, number | null> = {
        "ga4.conversions": convValue,
        "ga4.sessions": sessions,
        "ga4.revenue_cents": evidencedMetric(revenueCents, revWindow),
      };
      syncs.push({
        client_id: slug,
        source: "ga4",
        external_id: propertyId,
        period_start: start,
        period_end: end,
        synced_at: syncedAt,
        data_state: "live",
        error_message: null,
        // namespaced keys — sync.ts stores them verbatim; dashboard reads ga4.*
        metrics,
      });
      planted++;
    }
    console.log(
      `  ${slug} (property ${propertyId}) — ${planted} months via ${convMetric} (+sessions)` +
        (convUnevidenced === planted && planted > 0
          ? ` · ${convMetric} recorded as no data, not as zeros: this property has never reported one, so there is probably no key event configured on it`
          : ""),
    );

    // ── The same months, split by where the traffic came from ──────────────
    //
    // A SECOND call, and never a re-derivation of the one above. GA4's totals
    // are not always the sum of a dimensioned breakdown of themselves —
    // sampling, thresholding and its own "(other)" bucket all move them — so
    // adding these rows up to produce the three keys would change every
    // sessions, conversion and revenue figure the dashboard shows, on every
    // client, with nothing failing. The request above is untouched, and these
    // rows land in their own table (client_channel_metrics, app schema v201).
    //
    // A failure here must not cost the aggregate import. Those three keys are
    // what every existing figure reads and they are already in `syncs`.
    if (chanSince) try {
      const chanReport = await runReport(
        token, propertyId, chanSince,
        ["sessions", convMetric, "totalRevenue"],
        "sessionDefaultChannelGroup",
      );
      // The property's OWN history decides what a nought means, for a channel
      // exactly as for the site: one channel converting once is what makes
      // every other channel's nought a real nought.
      const outcome = channelRows(chanReport, { clientId: slug, propertyId, convWindow, revWindow });
      if (outcome.refused) {
        channelNotes.push(`${label(slug)} — no channel breakdown written: ${outcome.refused}`);
      } else {
        channels.push(...outcome.rows);
        console.log(`    ↳ ${outcome.channels} channel(s) × ${outcome.months} month(s) since ${chanSince}`);
        if (outcome.refusedLabels.length) {
          channelNotes.push(`${label(slug)} — ${outcome.refusedLabels.length} channel label(s) this table cannot store, named and not trimmed to fit: ${outcome.refusedLabels.join(", ")}`);
        }
        if (outcome.droppedRows) {
          channelNotes.push(`${label(slug)} — ${outcome.droppedRows} row(s) carried no usable month and were dropped`);
        }
      }
    } catch (e) {
      // Named, never silent, and never fatal. A property that answers the
      // aggregate report and refuses the dimensioned one is a real state (a
      // permission, a quota, a custom channel grouping), and losing the three
      // blended keys over it would blank figures the dashboard already shows.
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      channelNotes.push(`${label(slug)} — channel breakdown FAILED, the monthly totals above still imported: ${msg}`);
    }
  }

  // The denied list is deliberately printed AFTER the sync summary, below.
  // The summary is one line per client-month -- hundreds of them -- so anything
  // printed before it scrolls out of reach in CI. The actionable part has to be
  // the last thing in the log or nobody sees it.
  const reportDenied = () => {
    if (!denied.length) return;
    console.error(`\n${denied.length} GA4 propert(ies) the service account cannot read:`);
    for (const d of denied) console.error(`  ${d}`);
    console.error(`\nFix: add ${serviceAccount().client_email} as a Viewer on each`);
    console.error(`(GA4 → Admin → Property access management → +). Everything else imported fine.`);
  };

  if (!syncs.length) {
    // No rows can mean "no data in range" (fine) or "every property was denied"
    // (not fine). Only the second is a failure, so distinguish them rather than
    // exiting 0 on a run where nothing worked.
    if (denied.length) { reportDenied(); console.error(`\nEvery GA4 property failed — nothing imported.`); process.exit(1); }
    console.log("GA4 returned no rows for any property — nothing to plant.");
    process.exit(0);
  }
  console.log(`\nPlanting ${syncs.length} monthly snapshots from ${Object.keys(map).length - denied.length} propert(ies).`);
  if (channels.length) {
    console.log(`Plus ${channels.length} per-channel row(s) for client_channel_metrics.`);
  }
  const code = runDashboardSync({ databaseUrl, dashboardDir }, syncs, { dryRun: args.dryRun }, undefined, channels);
  // Printed AFTER the sync summary for the same reason the denied list is: the
  // summary is one line per entry and anything above it scrolls away.
  if (channelNotes.length) {
    console.error(`\n${channelNotes.length} note(s) about the per-channel breakdown:`);
    for (const n of channelNotes) console.error(`  ${n}`);
    console.error(`\nThe monthly totals are unaffected by any of these — they come from a separate call.`);
  }
  reportDenied();
  process.exit(code || (denied.length ? 1 : 0));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

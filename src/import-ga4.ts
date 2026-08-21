#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import pg from "pg";
import { runDashboardSync, type SyncEntry } from "./emit.js";

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
}

function parseArgs(argv: string[]): Args {
  let mapStr = "";
  let since = "2023-01-01";
  let dryRun = false;
  let onlyClient = "";
  for (const a of argv) {
    if (a.startsWith("--map=")) mapStr = a.slice("--map=".length);
    else if (a.startsWith("--since=")) since = a.slice("--since=".length);
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--client=")) onlyClient = a.slice("--client=".length).trim();
  }
  const map: Record<string, string> = {};
  if (mapStr) {
    for (const pair of mapStr.split(",")) {
      const [slug, prop] = pair.split(":");
      if (slug && prop) map[slug.trim()] = prop.trim();
    }
  }
  return { map, since, dryRun, onlyClient };
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
    const { rows } = await client.query<{ client_id: string; external_id: string }>(
      "SELECT client_id, external_id FROM connector_mappings WHERE source = 'ga4' AND enabled = true AND external_id IS NOT NULL AND external_id <> ''",
    );
    const m: Record<string, string> = {};
    for (const r of rows) m[r.client_id] = propertyId(r.external_id);
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
 *  name for conversions) if `conversions` is rejected by the property. */
async function runReport(token: string, propertyId: string, since: string, metrics: string[]): Promise<any> {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: since, endDate: "today" }],
      dimensions: [{ name: "yearMonth" }],
      metrics: metrics.map((name) => ({ name })),
      orderBys: [{ dimension: { dimensionName: "yearMonth" } }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403) throw new Error(`GA4 403 for property ${propertyId} — add the service account as a Viewer.`);
    const err = new Error(`GA4 runReport ${propertyId} (${metrics.join(",")}) → ${res.status} ${body}`);
    (err as any).status = res.status;
    (err as any).body = body;
    throw err;
  }
  return res.json();
}

function monthBounds(ym: string): { start: string; end: string } {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(4, 6));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${ym.slice(0, 4)}-${ym.slice(4, 6)}-01`, end: `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(last).padStart(2, "0")}` };
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
  const denied: string[] = [];
  for (const [slug, propertyId] of Object.entries(map)) {
    // GA4 renamed "conversions" → "keyEvents". Ask for keyEvents first (current
    // properties), fall back to conversions (older ones) on a 400. Always pull
    // sessions too so the traffic tile lights up even when 0 conversions exist.
    let report: any;
    let convMetric = "keyEvents";
    try {
      try {
        report = await runReport(token, propertyId, args.since, ["sessions", "keyEvents"]);
      } catch (e) {
        if ((e as any).status === 400) {
          convMetric = "conversions";
          report = await runReport(token, propertyId, args.since, ["sessions", "conversions"]);
        } else throw e;
      }
    } catch (e) {
      // One client's missing grant must not blank every other client. This used
      // to throw straight out of the loop, so a single un-shared property cost
      // the whole run — and the log named only that first property, hiding how
      // many others were also broken. Record it, keep going, and report the
      // full list at the end so every grant can be fixed in one pass.
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      console.error(`  ${slug} (property ${propertyId}) — FAILED: ${msg}`);
      denied.push(`${slug} → property ${propertyId}`);
      continue;
    }
    const rows: any[] = report.rows ?? [];
    let planted = 0;
    for (const row of rows) {
      const ym = row.dimensionValues?.[0]?.value; // "YYYYMM"
      if (!ym || !/^\d{6}$/.test(ym)) continue;
      const sessions = Number(row.metricValues?.[0]?.value ?? 0);
      const conv = Number(row.metricValues?.[1]?.value ?? 0);
      const { start, end } = monthBounds(ym);
      syncs.push({
        client_id: slug,
        source: "ga4",
        external_id: propertyId,
        period_start: start,
        period_end: end,
        synced_at: `${end}T12:00:00.000Z`,
        data_state: "live",
        error_message: null,
        // namespaced keys — sync.ts stores them verbatim; dashboard reads ga4.*
        metrics: { "ga4.conversions": conv, "ga4.sessions": sessions },
      });
      planted++;
    }
    console.log(`  ${slug} (property ${propertyId}) — ${planted} months via ${convMetric} (+sessions)`);
  }

  if (denied.length) {
    console.error(`\n${denied.length} propert(ies) the service account cannot read:`);
    for (const d of denied) console.error(`  ${d}`);
    console.error(`Add ${serviceAccount().client_email} as a Viewer on each`);
    console.error(`(GA4 → Admin → Property access management).`);
  }

  if (!syncs.length) {
    // No rows can mean "no data in range" (fine) or "every property was denied"
    // (not fine). Only the second is a failure, so distinguish them rather than
    // exiting 0 on a run where nothing worked.
    if (denied.length) { console.error(`\nEvery GA4 property failed — nothing imported.`); process.exit(1); }
    console.log("GA4 returned no rows for any property — nothing to plant.");
    process.exit(0);
  }
  console.log(`\nPlanting ${syncs.length} monthly snapshots from ${Object.keys(map).length - denied.length} propert(ies).`);
  const code = runDashboardSync({ databaseUrl, dashboardDir }, syncs, { dryRun: args.dryRun });
  process.exit(code || (denied.length ? 1 : 0));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

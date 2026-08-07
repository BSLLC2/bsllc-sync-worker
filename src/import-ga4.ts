#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
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
 *   npm run import-ga4 -- --map=diesel-power-group:460370940 [--since=2023-01-01] [--dry-run]
 */

interface Args {
  map: Record<string, string>;
  since: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let mapStr = "";
  let since = "2023-01-01";
  let dryRun = false;
  for (const a of argv) {
    if (a.startsWith("--map=")) mapStr = a.slice("--map=".length);
    else if (a.startsWith("--since=")) since = a.slice("--since=".length);
    else if (a === "--dry-run") dryRun = true;
  }
  const map: Record<string, string> = {};
  if (mapStr) {
    for (const pair of mapStr.split(",")) {
      const [slug, prop] = pair.split(":");
      if (slug && prop) map[slug.trim()] = prop.trim();
    }
  } else if (process.env.GA4_PROPERTY_MAP) {
    try {
      Object.assign(map, JSON.parse(process.env.GA4_PROPERTY_MAP));
    } catch {
      throw new Error("GA4_PROPERTY_MAP is not valid JSON.");
    }
  }
  if (!Object.keys(map).length) {
    throw new Error("No property map. Pass --map=slug:propertyId,... or set GA4_PROPERTY_MAP.");
  }
  return { map, since, dryRun };
}

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
async function runReport(token: string, propertyId: string, since: string, metric: string): Promise<any> {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: since, endDate: "today" }],
      dimensions: [{ name: "yearMonth" }],
      metrics: [{ name: metric }],
      orderBys: [{ dimension: { dimensionName: "yearMonth" } }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403) throw new Error(`GA4 403 for property ${propertyId} — add the service account as a Viewer.`);
    const err = new Error(`GA4 runReport ${propertyId} (${metric}) → ${res.status} ${body}`);
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
  console.log(`GA4 conversions import — ${Object.keys(args.map).length} client(s), since ${args.since}${args.dryRun ? " (dry-run)" : ""}`);
  const token = await ga4Token();

  const syncs: SyncEntry[] = [];
  for (const [slug, propertyId] of Object.entries(args.map)) {
    let report: any;
    let metricUsed = "conversions";
    try {
      report = await runReport(token, propertyId, args.since, "conversions");
    } catch (e) {
      // Newer GA4 properties expose "keyEvents" instead of "conversions".
      if ((e as any).status === 400) {
        metricUsed = "keyEvents";
        report = await runReport(token, propertyId, args.since, "keyEvents");
      } else throw e;
    }
    const rows: any[] = report.rows ?? [];
    console.log(`  ${slug} (property ${propertyId}) — ${rows.length} months via ${metricUsed}`);
    for (const row of rows) {
      const ym = row.dimensionValues?.[0]?.value; // "YYYYMM"
      const val = Number(row.metricValues?.[0]?.value ?? 0);
      if (!ym || !/^\d{6}$/.test(ym)) continue;
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
        metrics: { "ga4.conversions": val }, // namespaced — sync.ts stores the key verbatim
      });
    }
  }

  if (!syncs.length) throw new Error("GA4 returned 0 rows across all properties.");
  console.log(`\nPlanting ${syncs.length} monthly snapshots.`);

  const databaseUrl = process.env.DATABASE_URL?.trim();
  const dashboardDir = process.env.DASHBOARD_DIR?.trim();
  if (!databaseUrl || !dashboardDir) throw new Error("Missing DATABASE_URL / DASHBOARD_DIR.");
  const code = runDashboardSync({ databaseUrl, dashboardDir }, syncs, { dryRun: args.dryRun });
  process.exit(code);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

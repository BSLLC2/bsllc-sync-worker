import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { Config } from "./config.js";

/** One entry in the dashboard's sync contract (see SYNC_INTERFACE.md). */
export interface SyncEntry {
  client_id: string;
  // "meta" is Meta (Facebook/Instagram) paid social, written by
  // src/import-meta.ts. The dashboard's own sync validates this against
  // CONNECTOR_SOURCES in its shared/schema.ts, which has carried "meta" since
  // the connector row was made mappable; this union is the worker's half of
  // the same contract and simply had no producer until now.
  source: "google_ads" | "meta" | "gsc" | "ga4" | "d365" | "hubspot" | "seo" | "aeo" | "authority" | "manual";
  external_id?: string;
  /** Identity of ONE upstream record (e.g. a D365 opportunity id) for a
   *  per-item row, as opposed to an aggregate. Separate from `external_id`
   *  above, which is the connector's ACCOUNT identifier written back to
   *  connector_mappings -- conflating the two would corrupt that mapping.
   *  Dashboard-side dedup key: (client, source, metricKey, item_id), so a
   *  daily re-run of the same items is a harmless no-op. */
  item_id?: string;
  period_start: string;
  period_end: string;
  /** Omitted for incremental (defaults to now()); set for backfill (backdated). */
  synced_at?: string;
  data_state: "live" | "no_data" | "error";
  error_message: string | null;
  metrics: Record<string, number | string | boolean | null>;
}

/** One per-admission record behind a monthly admissions rollup — an explicit
 *  dashboard drill-down click reads these; see admissions in the dashboard's
 *  shared/schema.ts. Optional and additive: omitting it changes nothing. */
export interface AdmissionRecord {
  client_id: string;
  admitted_on: string;
  name: string | null;
  phone: string | null;
  dob: string | null;
  referent: string | null;
  attributable: boolean;
  attribution_source: string | null;
}

/**
 * One month of one marketing channel, for the dashboard's client_channel_metrics
 * (app schema v201). Optional and additive in exactly the way AdmissionRecord
 * above is: a payload with no `channels` key behaves precisely as before.
 *
 * NEVER SUMMED INTO A SyncEntry, and no SyncEntry is ever split into these. An
 * analytics platform's totals are not always the sum of a dimensioned breakdown
 * of themselves, so the two come from two separate calls and stay apart. See
 * src/ga4/channel-rows.ts for the whole argument.
 *
 * A null measure is UNANSWERED, never a nought — the property never reported
 * that metric at all (metric-evidence.ts).
 */
export interface ChannelMetricRow {
  client_id: string;
  source: "ga4";
  external_id?: string;
  /** YYYY-MM. */
  period: string;
  /** The platform's own label, verbatim. */
  channel: string;
  sessions: number | null;
  conversions: number | null;
  revenue_cents: number | null;
}

/**
 * Write the payload to a temp file and hand it to the dashboard's `npm run sync`.
 * The worker owns zero database writes — sync.ts validates and inserts. Returns
 * the child exit code (0 ok · 1 bad input · 2 one or more entries failed).
 */
export function runDashboardSync(
  cfg: Pick<Config, "dashboardDir" | "databaseUrl">,
  syncs: SyncEntry[],
  opts: { dryRun: boolean },
  admissions?: AdmissionRecord[],
  channels?: ChannelMetricRow[],
): number {
  const dir = mkdtempSync(join(tmpdir(), "adsync-"));
  const file = join(dir, "sync.json");
  const payload: Record<string, unknown> = { syncs };
  if (admissions?.length) payload.admissions = admissions;
  if (channels?.length) payload.channels = channels;
  writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`\n→ Wrote ${syncs.length} sync entr${syncs.length === 1 ? "y" : "ies"}${admissions?.length ? ` + ${admissions.length} admission record(s)` : ""}${channels?.length ? ` + ${channels.length} channel row(s)` : ""} to ${file}`);

  const args = ["run", "sync", "--", `--input=${file}`];
  if (opts.dryRun) args.push("--dry-run");

  const res = spawnSync("npm", args, {
    cwd: cfg.dashboardDir,
    stdio: "inherit",
    // The dashboard checkout reads DATABASE_URL; pass ours through so the two
    // stay in lockstep even if its own .env is absent.
    env: { ...process.env, DATABASE_URL: cfg.databaseUrl },
  });

  if (res.error) {
    console.error(`Failed to run \`npm run sync\` in ${cfg.dashboardDir}:`, res.error.message);
    return 1;
  }
  return res.status ?? 1;
}

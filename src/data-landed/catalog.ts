/**
 * "Did the data land?" The sources a client can be expected to have, how often
 * each should receive a row, and where a row of it lives.
 *
 * WHY (2026-11-16): a scheduled run can finish GREEN while nothing arrived. A
 * property the service account cannot read, an account that answered with no
 * rows, a sheet nobody shared: each prints "no data" in the log and exits 0, so
 * the heartbeat is fresh and nothing says the client's figures have stopped.
 * This catalog is half of the reading that asks the table, not the job.
 *
 * "Expected" is the simplest rule that does not need a second copy of the app's
 * scope rules: a client is expected to have a source when somebody SWITCHED IT
 * ON for them (an enabled connector row with an account number) or, for rank
 * checks, when they have active tracked searches and a site. Whether that source
 * belongs to the account's scope of work is the app's question
 * (shared/scope-applies.ts) and the app asks it when it reads these rows, so the
 * rule is written once and never copied here.
 *
 * Pure: no database, no clock (the caller supplies `now`).
 */

export const LANDED_SOURCES = [
  "ga4", "gsc", "google_ads", "meta", "hubspot", "rank_checks", "gsc_inspect", "gbp", "bing", "ctm",
] as const;
export type LandedSource = (typeof LANDED_SOURCES)[number];

export const LANDED_STATES = ["ok", "stale", "never", "not_applicable"] as const;
export type LandedState = (typeof LANDED_STATES)[number];

/** Where the newest row of a source is found. */
export type LandedWhere =
  | { kind: "metric_snapshots"; source: string }
  | { kind: "ads_daily_scans" }
  | { kind: "rank_history" }
  | { kind: "signal_runs"; source: string };

export interface SourceSpec {
  source: LandedSource;
  label: string;
  /** How old the newest landed row may be before the source is stale. One missed firing past the cadence. */
  expectedHours: number;
  /** What switches the source on for a client. */
  switchedOn: { connector: string } | { rankTargets: true };
  where: LandedWhere;
  /** When set, only clients with one of these statuses are read by the job that fills the source. */
  readsStatuses?: readonly string[];
}

const DAILY = 48;
const WEEKLY = 216;

export const SOURCE_SPECS: readonly SourceSpec[] = [
  { source: "ga4", label: "Analytics", expectedHours: DAILY, switchedOn: { connector: "ga4" }, where: { kind: "metric_snapshots", source: "ga4" } },
  { source: "gsc", label: "Search Console", expectedHours: DAILY, switchedOn: { connector: "gsc" }, where: { kind: "metric_snapshots", source: "gsc" } },
  { source: "google_ads", label: "Google Ads", expectedHours: DAILY, switchedOn: { connector: "google_ads" }, where: { kind: "ads_daily_scans" }, readsStatuses: ["launch", "active"] },
  { source: "meta", label: "Meta ads", expectedHours: DAILY, switchedOn: { connector: "meta" }, where: { kind: "metric_snapshots", source: "meta" } },
  { source: "hubspot", label: "HubSpot", expectedHours: DAILY, switchedOn: { connector: "hubspot" }, where: { kind: "metric_snapshots", source: "hubspot" } },
  { source: "rank_checks", label: "Position checks", expectedHours: WEEKLY, switchedOn: { rankTargets: true }, where: { kind: "rank_history" } },
  { source: "gsc_inspect", label: "Page checks (Search Console)", expectedHours: WEEKLY, switchedOn: { connector: "gsc" }, where: { kind: "signal_runs", source: "gsc_inspect" } },
  { source: "gbp", label: "Business Profile", expectedHours: DAILY, switchedOn: { connector: "gbp" }, where: { kind: "signal_runs", source: "gbp" } },
  { source: "bing", label: "Bing", expectedHours: DAILY, switchedOn: { connector: "bing" }, where: { kind: "signal_runs", source: "bing" } },
  { source: "ctm", label: "Call tracker", expectedHours: DAILY, switchedOn: { connector: "ctm" }, where: { kind: "signal_runs", source: "ctm" } },
];

export const specFor = (source: LandedSource): SourceSpec => SOURCE_SPECS.find((s) => s.source === source)!;

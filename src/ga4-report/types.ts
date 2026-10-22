/**
 * Shapes and constants for the "Website performance" reader: a Looker-Studio-style
 * report (overview totals, a daily trend, visitors by region, traffic sources,
 * landing pages, form submissions, and named page groups) read from Google
 * Analytics 4 and kept as counts in three tables the dashboard app declares.
 *
 * THE TABLES BELONG TO THE APP. It declares them in shared/schema.ts and creates
 * them in ensureSchema(). This repository only writes rows. The lists below are
 * mirrored there; docs/GA4-REPORT.md is the contract in words.
 *
 * NOTHING HERE STORES A VISITOR. Counts and aggregates only: no user id, no IP, no
 * client id from analytics. A measure GA4 did not return is NULL, never 0. The one
 * exception is the explicit zero for a day inside the span that was read in full,
 * because GA4 sends no row for a day with no sessions.
 */
import type { FetchLike } from "../page-behaviour/types.js";
export type { FetchLike };

/** What a client's run can end as. Same words as the sibling readers. */
export const RUN_STATUSES = ["ok", "off", "no_key", "error", "no_data", "capped"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The report kinds written to ga4_report_rows. */
export const REPORT_KINDS = ["region", "source_medium", "landing_page", "form_page", "event_name", "group_page", "group_form"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Rows kept per month per kind. The ceiling cuts the smallest. OURS. */
export const TOP_N: Record<ReportKind, number> = {
  region: 100, source_medium: 100, landing_page: 100, form_page: 100, event_name: 100, group_page: 300, group_form: 300,
};

/** Months of history read by default, and the most a run may be asked for. */
export const DEFAULT_MONTHS = 24;
export const MAX_MONTHS = 36;
/** Days before today that GA4 data is treated as complete. The same assumption the page-behaviour reader makes. */
export { GA4_LAG_DAYS } from "../page-behaviour/types.js";

/** Rows asked for in one page of one report, and the most rows read for one report before it is called too big. OURS. */
export const PAGE_SIZE = 25_000;
export const ROW_CEILING = 200_000;
/** Pause between calls to the one property. */
export const PAUSE_MS = 450;
/** Retries after a 429 or 5xx, and the waits before each. */
export const RETRY_WAITS_MS: readonly number[] = [1_000, 3_000, 9_000];

/** The form event used when nothing is configured. */
export const DEFAULT_FORM_EVENT = "form_submit";

export const CONFIG_LIMITS = { countries: 25, groups: 5, prefixChars: 120, nameChars: 60, countryChars: 80 } as const;

export interface ReportGroup { name: string; prefix: string }
/** What the dashboard's `web_report_config:<clientId>` setting holds, after sanitising. */
export interface ReportConfig {
  excludeCountries: string[];
  groups: ReportGroup[];
  formEvent: string;
}

export interface DailyRowOut {
  day: string;
  sessions: number | null;
  engagedSessions: number | null;
  engagementSeconds: number | null;
  users: number | null;
  keyEvents: number | null;
}

export interface ReportRowOut {
  month: string;
  kind: ReportKind;
  parent: string;
  key: string;
  sessions: number | null;
  engagedSessions: number | null;
  engagementSeconds: number | null;
  events: number | null;
}

export interface ClientCtx {
  id: string;
  name: string;
  ga4Property: string | null;
}

/** What one client's read produced and what the store should do with it. */
export interface ClientReportResult {
  status: RunStatus;
  detail: string | null;
  /** Null where the daily read did not complete: nothing is written for the client but the run row. */
  daily: DailyRowOut[] | null;
  firstDay: string | null;
  lastDay: string | null;
  firstMonth: string | null;
  lastMonth: string | null;
  /** Months whose rows a kind that read in full replaces. */
  months: string[];
  /** Rows by kind, only for kinds that read in full. */
  kinds: Partial<Record<ReportKind, ReportRowOut[]>>;
  cappedKinds: ReportKind[];
  failedKinds: ReportKind[];
  config: ReportConfig;
  /** Rows the run will write (daily plus report). */
  rows: number;
}

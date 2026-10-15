/**
 * Shapes and constants for the page-behaviour reader: what visitors do on a
 * client's pages, read from analytics, Search Console, Chrome's field data, an
 * optional lab test, Microsoft Clarity and the site's own events.
 *
 * The dashboard app owns the tables (schema v252) and every sentence. This
 * repository reads the sources and writes counts. The lists below are mirrored in
 * the app (`shared/schema.ts` and `shared/seo-ux-readings.ts`) and
 * `npm run verify:wiring` there compares both sides.
 *
 * NOTHING HERE STORES A VISITOR. No person, no session id, no recording, no search
 * term tied to anyone. A measure a source did not return is NULL, never 0.
 */

/** The sources a run reports on, one status each per account. */
export const UX_SOURCES = ["ga4_pages", "gsc_pages", "events", "crux", "psi", "clarity"] as const;
export type UxSource = (typeof UX_SOURCES)[number];

/** What a run of one source can end as. `off` is "not switched on for this account". */
export const RUN_STATUSES = ["ok", "off", "no_key", "no_token", "error", "capped", "no_data"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const BEHAVIOUR_SOURCES = ["ga4", "gsc"] as const;
export type BehaviourSource = (typeof BEHAVIOUR_SOURCES)[number];

export const PERIODS = ["current", "prior"] as const;
export type Period = (typeof PERIODS)[number];

export const VITAL_SOURCES = ["crux_url", "crux_origin", "psi_lab"] as const;
export type VitalSource = (typeof VITAL_SOURCES)[number];

export const FORM_FACTORS = ["PHONE", "DESKTOP"] as const;
export type FormFactor = (typeof FORM_FACTORS)[number];

export const VITAL_STATES = ["ok", "no_data", "error"] as const;
export type VitalState = (typeof VITAL_STATES)[number];

/** The most pages one account's page-level reads keep. Past it the run says `capped` and by how much. */
export const PAGE_CAP = 100;
/** Pages asked about in Chrome's field data (two form factors each). */
export const CRUX_PAGES = 20;
/** Pages given a lab test. Each takes many seconds, so this stays small. */
export const PSI_PAGES = 5;
/** Days in each comparison window. */
export const WINDOW_DAYS = 28;
/** Days before today that GA4 data is treated as complete. Our assumption, said as one. */
export const GA4_LAG_DAYS = 2;
/** Days before today that Search Console data is final. Our assumption, said as one. */
export const GSC_LAG_DAYS = 3;
/** Queries kept per page, counts only. */
export const TOP_QUERIES = 5;

export interface Window { start: string; end: string }
export interface Windows { current: Window; prior: Window }

export interface BehaviourRowOut {
  source: BehaviourSource;
  pagePath: string;
  device: string;
  period: Period;
  windowStart: string;
  windowEnd: string;
  sessions: number | null;
  engagedSessions: number | null;
  engagementSeconds: number | null;
  keyEvents: number | null;
  clicks: number | null;
  impressions: number | null;
  topQueriesJson: string | null;
}

export interface EventRowOut {
  pagePath: string;
  device: string;
  eventName: string;
  section: string;
  period: Period;
  windowStart: string;
  windowEnd: string;
  eventCount: number;
}

export interface VitalRowOut {
  pagePath: string;
  formFactor: FormFactor;
  source: VitalSource;
  lcpMs: number | null;
  inpMs: number | null;
  cls: number | null;
  collectionFirst: string | null;
  collectionLast: string | null;
  state: VitalState;
  detail: string | null;
}

export interface ClarityDayOut {
  pagePath: string;
  day: string;
  sessions: number | null;
  scrollDepthAvg: number | null;
  engagementSeconds: number | null;
  deadClickPct: number | null;
  rageClickPct: number | null;
  quickbackPct: number | null;
}

export interface RunOut {
  source: UxSource;
  status: RunStatus;
  detail: string | null;
  rows: number;
  capped: boolean;
  totalFound: number | null;
  windowEnd: string | null;
}

/** A fetch the reader can be handed, so the guard drives the real code with no network. */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

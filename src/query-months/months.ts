/**
 * Branded and other Search Console searches for one COMPLETE calendar month, as COUNTS.
 *
 * The dashboard app owns `seo_query_months` and every sentence. This file builds the
 * two Search Console requests, adds up the answers and holds the SQL. The matching
 * rule is in ./brand.ts.
 *
 * ── RULES ──────────────────────────────────────────────────────────────────
 *  1. A SEARCH IS NEVER KEPT. `tallyQueryPage` reads each row's search text only to
 *     ask "is it branded?" and adds the row's clicks and impressions to one of two
 *     running sums. No function here returns, stores, logs or throws a search, and
 *     no column of seo_query_months could hold one (the guard reads the DDL, the
 *     INSERT and every log line for that).
 *  2. ONLY A FINISHED MONTH IS WRITTEN: its last day is at least GSC_LAG_DAYS behind
 *     today (`completeMonths`, shared with the page-months job). A month is replaced
 *     as a whole, so a rerun costs nothing.
 *  3. HIDDEN IS GOOGLE'S OWN. Search Console withholds rare searches from the
 *     per-search list, so the sum of the rows is below the site total (read with no
 *     dimension). The gap is hidden_clicks / hidden_impressions, floored at 0, and it
 *     makes branded and other FLOORS: a hidden search might have been either.
 *  4. A CAPPED READ IS A FLOOR TOO. Search Console pages at 25,000 rows; this reads
 *     at most QUERY_ROW_CEILING. Past that `rows_capped` is true, and `hidden` is NULL
 *     (the unread tail and Google's withheld searches cannot be told apart).
 *  5. A FIGURE NOBODY HAS IS NULL. A client with no usable brand term gets null
 *     branded and other (everything would otherwise read as "other"); a month in
 *     which Search Console returned nothing at all is not written.
 *
 * NONE OF THE REQUEST SHAPES HAS BEEN RUN AGAINST A LIVE PROPERTY. They follow the
 * Search Analytics documentation the other Search Console readers follow.
 */
import { createHash } from "node:crypto";
import { GSC_ROW_LIMIT } from "../page-behaviour/gsc.js";
import { completeMonths, DEFAULT_MONTHS, MAX_MONTHS, type MonthSpan } from "../page-behaviour/months.js";
import type { Queryable } from "../page-behaviour/store.js";
import { matchesBrand, type PreparedTerm } from "./brand.js";

export { completeMonths, DEFAULT_MONTHS, MAX_MONTHS, type MonthSpan };

/** Months read by default. The brief for this job: sixteen, which is what Search Console keeps. */
export const QUERY_MONTHS_DEFAULT = 16;
export const QUERY_PAGE_SIZE = GSC_ROW_LIMIT;
/** The most search rows read for one month. OURS. Three full pages. */
export const QUERY_ROW_CEILING = 75_000;

export function queryRequest(span: MonthSpan, startRow: number) {
  return { startDate: span.start, endDate: span.end, dimensions: ["query"], dataState: "final", rowLimit: QUERY_PAGE_SIZE, startRow };
}

/** The site's own total for the month: no dimension, so anonymised searches are in it. */
export function totalRequest(span: MonthSpan) {
  return { startDate: span.start, endDate: span.end, dataState: "final" };
}

export interface Pair { clicks: number; impressions: number }
export const zeroPair = (): Pair => ({ clicks: 0, impressions: 0 });

const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/** The site total, or null where Search Console returned no row at all (nothing to report, never a nought). */
export function parseTotal(json: unknown): Pair | null {
  const rows = ((json ?? {}) as { rows?: Array<{ clicks?: number; impressions?: number }> }).rows;
  const r = Array.isArray(rows) ? rows[0] : undefined;
  if (!r) return null;
  return { clicks: Math.round(n(r.clicks)), impressions: Math.round(n(r.impressions)) };
}

export interface Tally { branded: Pair; other: Pair; rows: number }
export const newTally = (): Tally => ({ branded: zeroPair(), other: zeroPair(), rows: 0 });

/**
 * Add one page of the per-search answer to the running sums. Reads `keys[0]` to test
 * it and DISCARDS it. Returns how many rows the page held.
 */
export function tallyQueryPage(json: unknown, terms: readonly PreparedTerm[], into: Tally): number {
  const rows = ((json ?? {}) as { rows?: Array<{ keys?: unknown[]; clicks?: number; impressions?: number }> }).rows;
  if (!Array.isArray(rows)) return 0;
  for (const r of rows) {
    const side = matchesBrand(r.keys?.[0], terms) ? into.branded : into.other;
    side.clicks += n(r.clicks);
    side.impressions += n(r.impressions);
  }
  into.rows += rows.length;
  return rows.length;
}

export type TermsSource = "typed" | "derived";

export interface MonthRowOut {
  month: string;
  coveredTo: string;
  brandedClicks: number | null; brandedImpressions: number | null;
  otherClicks: number | null; otherImpressions: number | null;
  totalClicks: number; totalImpressions: number;
  hiddenClicks: number | null; hiddenImpressions: number | null;
  rowsRead: number; rowsCapped: boolean;
  brandTerms: number; termsFingerprint: string; termsSource: TermsSource;
}

export interface BuildInput {
  span: MonthSpan;
  total: Pair;
  tally: Tally;
  capped: boolean;
  termCount: number;
  fingerprint: string;
  source: TermsSource;
}

/** Totals in, one row out. No search text passes through here. */
export function buildMonthRow(i: BuildInput): MonthRowOut {
  const r = (x: number) => Math.round(x);
  const noTerms = i.termCount === 0;
  const sumC = i.tally.branded.clicks + i.tally.other.clicks;
  const sumI = i.tally.branded.impressions + i.tally.other.impressions;
  return {
    month: i.span.month,
    coveredTo: i.span.end,
    brandedClicks: noTerms ? null : r(i.tally.branded.clicks),
    brandedImpressions: noTerms ? null : r(i.tally.branded.impressions),
    otherClicks: noTerms ? null : r(i.tally.other.clicks),
    otherImpressions: noTerms ? null : r(i.tally.other.impressions),
    totalClicks: i.total.clicks,
    totalImpressions: i.total.impressions,
    hiddenClicks: i.capped ? null : Math.max(0, r(i.total.clicks - sumC)),
    hiddenImpressions: i.capped ? null : Math.max(0, r(i.total.impressions - sumI)),
    rowsRead: i.tally.rows,
    rowsCapped: i.capped,
    brandTerms: i.termCount,
    termsFingerprint: i.fingerprint,
    termsSource: i.source,
  };
}

/**
 * The table, spelled out. The app declares the same one (`seo_query_months`); whichever
 * side creates it first wins and the other's IF NOT EXISTS is a no-op, so the two
 * statements are kept identical. A second month for one client is a replace.
 */
export const CREATE_QUERY_MONTHS = `CREATE TABLE IF NOT EXISTS seo_query_months (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  month TEXT NOT NULL,
  covered_to TEXT NOT NULL,
  branded_clicks INTEGER,
  branded_impressions INTEGER,
  other_clicks INTEGER,
  other_impressions INTEGER,
  total_clicks INTEGER,
  total_impressions INTEGER,
  hidden_clicks INTEGER,
  hidden_impressions INTEGER,
  rows_read INTEGER,
  rows_capped BOOLEAN,
  brand_terms INTEGER,
  terms_fingerprint TEXT,
  terms_source TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;
export const CREATE_QUERY_MONTHS_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS idx_seo_query_months_key ON seo_query_months (client_id, month)`;

export async function ensureQueryMonthsTable(c: Queryable): Promise<void> {
  await c.query(CREATE_QUERY_MONTHS);
  await c.query(CREATE_QUERY_MONTHS_INDEX);
}

/** Literal column list on purpose: the app's `npm run verify:wiring` reads every INSERT here against shared/schema.ts. */
export const INSERT_QUERY_MONTH = `INSERT INTO seo_query_months
  (id, client_id, month, covered_to, branded_clicks, branded_impressions, other_clicks, other_impressions,
   total_clicks, total_impressions, hidden_clicks, hidden_impressions, rows_read, rows_capped,
   brand_terms, terms_fingerprint, terms_source, synced_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
 ON CONFLICT (client_id, month) DO UPDATE SET
   covered_to = EXCLUDED.covered_to,
   branded_clicks = EXCLUDED.branded_clicks, branded_impressions = EXCLUDED.branded_impressions,
   other_clicks = EXCLUDED.other_clicks, other_impressions = EXCLUDED.other_impressions,
   total_clicks = EXCLUDED.total_clicks, total_impressions = EXCLUDED.total_impressions,
   hidden_clicks = EXCLUDED.hidden_clicks, hidden_impressions = EXCLUDED.hidden_impressions,
   rows_read = EXCLUDED.rows_read, rows_capped = EXCLUDED.rows_capped,
   brand_terms = EXCLUDED.brand_terms, terms_fingerprint = EXCLUDED.terms_fingerprint,
   terms_source = EXCLUDED.terms_source, synced_at = EXCLUDED.synced_at`;

const rowId = (clientId: string, month: string) => createHash("sha256").update(`qm\u0001${clientId}\u0001${month}`).digest("hex").slice(0, 40);

export function insertParams(clientId: string, r: MonthRowOut, at: Date): unknown[] {
  return [
    rowId(clientId, r.month), clientId, r.month, r.coveredTo,
    r.brandedClicks, r.brandedImpressions, r.otherClicks, r.otherImpressions,
    r.totalClicks, r.totalImpressions, r.hiddenClicks, r.hiddenImpressions,
    r.rowsRead, r.rowsCapped, r.brandTerms, r.termsFingerprint, r.termsSource, at,
  ];
}

/** One transaction per client: every month that was read, or none of them. */
export async function writeClientMonths(c: Queryable, clientId: string, rows: readonly MonthRowOut[], at: Date): Promise<void> {
  await c.query("BEGIN");
  try {
    for (const r of rows) await c.query(INSERT_QUERY_MONTH, insertParams(clientId, r, at));
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}

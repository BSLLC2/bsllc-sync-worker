/**
 * Each page's figures for one COMPLETE calendar month, from Search Console and
 * analytics. The rolling 28-day windows in seo_page_behaviour are overwritten every
 * run, so they cannot say what a page did in September against August; this can.
 *
 * Pure builders and parsers plus two small readers that take a fetch, so the guard
 * drives them with no network. NONE OF THE REQUEST SHAPES HAS BEEN RUN AGAINST A
 * LIVE PROPERTY (they follow the same documentation the 28-day reader does).
 * docs/SEO-PAGE-BEHAVIOUR.md and docs/worker-handoffs/121 list that.
 *
 * ── RULES ──────────────────────────────────────────────────────────────────
 *  1. ONLY A FINISHED MONTH IS WRITTEN. A month counts once its last day is at
 *     least GSC_LAG_DAYS behind today, so Search Console's final figures are in.
 *     The month in progress is never written, and a part month is never labelled
 *     as a whole one (`covered_to` is the last day the figures reach).
 *  2. A MONTH IS REWRITTEN AS A WHOLE. Search Console restates a month a little
 *     after it ends, so the rows of one (client, source, month) are replaced in
 *     one transaction. A page that no longer has a row had no clicks.
 *  3. A FIGURE THE SOURCE DID NOT RETURN IS NULL. Analytics sessions are unpaid
 *     search only (the channel analytics itself names "Organic Search"); Search
 *     Console position is the average Search Console reports, weighted here by
 *     impressions when addresses are merged.
 *  4. THE ROWS ARE CAPPED PER MONTH (PAGE_MONTH_ROWS), busiest first, and the run
 *     says when the cap cut anything. The dashboard reads a page with no row as
 *     a page with none, so the cap is far above any real site's busy pages.
 *  5. NOTHING TIES A FIGURE TO A PERSON. Counts per page and an average position.
 */
import { HttpError, postJson } from "./http.js";
import { addDays, isRealPath, normPath } from "./paths.js";
import { GSC_LAG_DAYS, type FetchLike } from "./types.js";
import { GA4_BASE } from "./ga4.js";
import { GSC_BASE, GSC_ROW_LIMIT } from "./gsc.js";

/** The most pages written per source per month. OURS. */
export const PAGE_MONTH_ROWS = 1000;
/** Months written by default: the pair a fall is read from. `--months=14` backfills a year earlier too. */
export const DEFAULT_MONTHS = 3;
/** Search Console keeps about sixteen months, so no backfill reaches past this. */
export const MAX_MONTHS = 16;

export interface MonthSpan { month: string; start: string; end: string }

const pad = (n: number) => String(n).padStart(2, "0");

/** The last `n` finished months before `today`, newest first. A month is finished once its last day is GSC_LAG_DAYS behind today. */
export function completeMonths(today: string, n: number): MonthSpan[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m) return [];
  const out: MonthSpan[] = [];
  let y = Number(m[1]), mo = Number(m[2]);
  // Step back from the month containing today.
  for (let guard = 0; guard < 40 && out.length < Math.min(n, MAX_MONTHS); guard++) {
    mo -= 1;
    if (mo === 0) { mo = 12; y -= 1; }
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const end = `${y}-${pad(mo)}-${pad(last)}`;
    if (addDays(end, GSC_LAG_DAYS) > today) continue;
    out.push({ month: `${y}-${pad(mo)}`, start: `${y}-${pad(mo)}-01`, end });
  }
  return out;
}

export interface MonthPageAgg {
  path: string;
  clicks: number | null;
  impressions: number | null;
  position: number | null;
  sessions: number | null;
}

interface GscRow { keys?: string[]; clicks?: number; impressions?: number; position?: number }

export function gscMonthRequest(span: MonthSpan) {
  return { startDate: span.start, endDate: span.end, dimensions: ["page"], dataState: "final", rowLimit: GSC_ROW_LIMIT };
}

/** Search Console rows to one aggregate per path. Addresses that normalise to one path are summed; position is weighted by impressions. */
export function parseGscMonth(json: unknown): { rows: MonthPageAgg[]; full: boolean } {
  const rows = ((json ?? {}) as { rows?: GscRow[] }).rows ?? [];
  const by = new Map<string, { clicks: number; impressions: number; weighted: number; weight: number }>();
  for (const r of rows) {
    const page = String(r.keys?.[0] ?? "");
    if (!isRealPath(page)) continue;
    const path = normPath(page);
    const imp = Number(r.impressions ?? 0) || 0;
    const cur = by.get(path) ?? { clicks: 0, impressions: 0, weighted: 0, weight: 0 };
    cur.clicks += Number(r.clicks ?? 0) || 0;
    cur.impressions += imp;
    if (typeof r.position === "number" && Number.isFinite(r.position) && imp > 0) { cur.weighted += r.position * imp; cur.weight += imp; }
    by.set(path, cur);
  }
  const out: MonthPageAgg[] = Array.from(by.entries()).map(([path, v]) => ({
    path, clicks: Math.round(v.clicks), impressions: Math.round(v.impressions),
    position: v.weight > 0 ? Math.round((v.weighted / v.weight) * 10) / 10 : null, sessions: null,
  }));
  return { rows: out, full: rows.length >= GSC_ROW_LIMIT };
}

export function ga4MonthRequest(span: MonthSpan) {
  return {
    dateRanges: [{ startDate: span.start, endDate: span.end }],
    dimensions: [{ name: "landingPage" }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } } },
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 50000,
  };
}

interface GaRow { dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }

export function parseGa4Month(json: unknown): MonthPageAgg[] {
  const rows = ((json ?? {}) as { rows?: GaRow[] }).rows ?? [];
  const by = new Map<string, number>();
  for (const r of rows) {
    const page = String(r.dimensionValues?.[0]?.value ?? "");
    if (!isRealPath(page)) continue;
    const n = Number(r.metricValues?.[0]?.value);
    if (!Number.isFinite(n)) continue;
    const path = normPath(page);
    by.set(path, (by.get(path) ?? 0) + n);
  }
  return Array.from(by.entries()).map(([path, s]) => ({ path, clicks: null, impressions: null, position: null, sessions: Math.round(s) }));
}

export interface MonthRowOut extends MonthPageAgg { source: "gsc" | "ga4"; month: string; coveredTo: string }

/** Busiest first, cut at PAGE_MONTH_ROWS. Returns how many were cut. */
export function capMonth(rows: readonly MonthPageAgg[], source: "gsc" | "ga4", span: MonthSpan, cap = PAGE_MONTH_ROWS): { rows: MonthRowOut[]; cut: number } {
  const v = (r: MonthPageAgg) => (source === "gsc" ? r.clicks ?? 0 : r.sessions ?? 0);
  const sorted = rows.slice().sort((a, b) => v(b) - v(a) || a.path.localeCompare(b.path));
  return { rows: sorted.slice(0, cap).map((r) => ({ ...r, source, month: span.month, coveredTo: span.end })), cut: Math.max(0, sorted.length - cap) };
}

export interface MonthRead { source: "gsc" | "ga4"; month: string; rows: MonthRowOut[]; cut: number; apiFull: boolean }

export async function readGscMonth(f: FetchLike, token: string, property: string, span: MonthSpan): Promise<MonthRead> {
  const url = `${GSC_BASE}/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const parsed = parseGscMonth(await postJson(f, url, { Authorization: `Bearer ${token}` }, gscMonthRequest(span), "Search Console (pages by month)"));
  const capped = capMonth(parsed.rows, "gsc", span);
  return { source: "gsc", month: span.month, rows: capped.rows, cut: capped.cut, apiFull: parsed.full };
}

export async function readGa4Month(f: FetchLike, token: string, property: string, span: MonthSpan): Promise<MonthRead> {
  let json: unknown;
  try {
    json = await postJson(f, `${GA4_BASE}/properties/${property}:runReport`, { Authorization: `Bearer ${token}` }, ga4MonthRequest(span), "GA4 runReport (organic landing pages by month)");
  } catch (e) {
    // An invalid-argument answer is the property rejecting the channel filter: nothing is guessed in its place.
    if (e instanceof HttpError && e.status === 400) throw new HttpError(400, e.body, "GA4 rejected the unpaid-search filter for this property");
    throw e;
  }
  const capped = capMonth(parseGa4Month(json), "ga4", span);
  return { source: "ga4", month: span.month, rows: capped.rows, cut: capped.cut, apiFull: false };
}

/**
 * The write, spelled out. The column list is a literal on purpose: the app's
 * `npm run verify:wiring` reads every INSERT in this repo and checks each column
 * against shared/schema.ts.
 */
export const INSERT_PAGE_MONTH = `INSERT INTO seo_page_months
  (id, client_id, source, page_path, month, covered_to, clicks, impressions, position, sessions, synced_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
 ON CONFLICT (client_id, source, page_path, month) DO UPDATE SET
   covered_to = EXCLUDED.covered_to, clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
   position = EXCLUDED.position, sessions = EXCLUDED.sessions, synced_at = EXCLUDED.synced_at`;

export const DELETE_PAGE_MONTH = `DELETE FROM seo_page_months WHERE client_id = $1 AND source = $2 AND month = $3`;

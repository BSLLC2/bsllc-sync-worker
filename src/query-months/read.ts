/**
 * Read one month of Search Console, by search, as counts. Takes a fetch so the guard
 * drives it with no network, and retries the answers Google asks a caller to retry
 * (429 and 5xx, and a connection that fell over) a few times before giving up.
 *
 * READ-ONLY: the only request made is Search Analytics `query`, with the read-only
 * scope the token carries. NO SEARCH TEXT LEAVES THIS FILE: errors name a status,
 * never a body (a body is Google's words about our request, and nothing here needs it).
 */
import { HttpError } from "../page-behaviour/http.js";
import { GSC_BASE } from "../page-behaviour/gsc.js";
import type { FetchLike } from "../page-behaviour/types.js";
import { serviceUrl, sleep } from "../signals/common.js";
import type { PreparedTerm } from "./brand.js";
import {
  buildMonthRow, newTally, parseTotal, QUERY_PAGE_SIZE, QUERY_ROW_CEILING, queryRequest, tallyQueryPage, totalRequest,
  type MonthRowOut, type MonthSpan, type TermsSource,
} from "./months.js";

export const RETRY_TRIES = 3;
const backoffMs = () => { const v = Number(process.env.QUERY_MONTHS_BACKOFF_MS); return Number.isFinite(v) && v >= 0 ? v : 1500; };

/** A status we will try again; everything else (401, 403, 404, 400) is an answer. */
export const retryable = (status: number) => status === 429 || status >= 500;

export async function postRetry(f: FetchLike, url: string, token: string, body: unknown): Promise<unknown> {
  let last: unknown;
  for (let attempt = 1; attempt <= RETRY_TRIES; attempt++) {
    try {
      const res = await f(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const text = await res.text();
      if (res.ok) {
        try { return JSON.parse(text); } catch { throw new HttpError(res.status, "", "Search Console (not JSON)"); }
      }
      // The body is dropped on purpose: it is never needed and must never be printed.
      last = new HttpError(res.status, "", "Search Console");
      if (!retryable(res.status)) throw last;
    } catch (e) {
      if (e instanceof HttpError && !retryable(e.status)) throw e;
      last = e;
    }
    if (attempt < RETRY_TRIES) await sleep(backoffMs() * attempt);
  }
  throw last;
}

/** What a failure is called in a log or a heartbeat: a status and a plain reason, never a body, never a search. */
export function describeFailure(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status === 401 || e.status === 403) return `Search Console refused the service account (${e.status}); it needs to be a user on the property`;
    if (e.status === 404) return "Search Console does not know this property (404)";
    if (e.status === 429) return "Search Console is limiting requests (429)";
    return `Search Console answered ${e.status}`;
  }
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, " ").slice(0, 200);
}

/** Access problems that will be the same for every month of this property: stop asking. */
export const isAccessFailure = (e: unknown): boolean => e instanceof HttpError && (e.status === 401 || e.status === 403 || e.status === 404);

export interface MonthCtx {
  f: FetchLike;
  token: string;
  property: string;
  terms: readonly PreparedTerm[];
  fingerprint: string;
  source: TermsSource;
}

export type MonthResult =
  | { kind: "row"; row: MonthRowOut }
  | { kind: "no_data" };

export async function readQueryMonth(ctx: MonthCtx, span: MonthSpan): Promise<MonthResult> {
  const url = serviceUrl("gsc", `${GSC_BASE}/sites/${encodeURIComponent(ctx.property)}/searchAnalytics/query`);
  const total = parseTotal(await postRetry(ctx.f, url, ctx.token, totalRequest(span)));
  const tally = newTally();
  let capped = false;
  let read = 0;
  for (let startRow = 0; ; startRow += QUERY_PAGE_SIZE) {
    const got = tallyQueryPage(await postRetry(ctx.f, url, ctx.token, queryRequest(span, startRow)), ctx.terms, tally);
    read += got;
    if (got < QUERY_PAGE_SIZE) break;
    if (read >= QUERY_ROW_CEILING) { capped = true; break; }
  }
  // Nothing at all came back for the month (a property younger than the month, or a month with no impressions).
  // That is not a month with nought clicks; it is a month with nothing to say, so no row is written.
  if (!total && tally.rows === 0) return { kind: "no_data" };
  // A per-search list with no site total is a reading we cannot complete: the total is the other half of the identity.
  if (!total) throw new Error("Search Console gave searches for the month but no site total");
  return {
    kind: "row",
    row: buildMonthRow({ span, total, tally, capped, termCount: ctx.terms.length, fingerprint: ctx.fingerprint, source: ctx.source }),
  };
}

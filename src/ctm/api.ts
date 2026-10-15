/**
 * The calls, and the answers read defensively.
 *
 * Authentication is HTTP Basic with the account's access key and secret key. Both stay in
 * the request header and nowhere else; `safeMessage` removes them from anything printed.
 * The parser is pure: it takes what CTM sent and returns the records and the paging, and
 * refuses an answer that is not a list of calls rather than reading it as "no calls".
 */
import { HttpError, getJson } from "../page-behaviour/http.js";
import { num, serviceUrl } from "../signals/common.js";
import type { FetchLike } from "../page-behaviour/types.js";
import type { CtmKeys } from "../signals/secrets.js";
import { CTM_BASE, CTM_PER_PAGE } from "./types.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);

export const basicAuth = (k: CtmKeys): Record<string, string> => ({
  Authorization: `Basic ${Buffer.from(`${k.accessKey}:${k.secretKey}`).toString("base64")}`,
  Accept: "application/json",
});

export function callsUrl(accountId: string, start: string, end: string, page: number, perPage = CTM_PER_PAGE): string {
  const q = new URLSearchParams({ start_date: start, end_date: end, per_page: String(perPage), page: String(page) });
  return serviceUrl("ctm", `${CTM_BASE}/accounts/${encodeURIComponent(accountId)}/calls.json?${q.toString()}`);
}

export async function fetchCalls(f: FetchLike, keys: CtmKeys, accountId: string, start: string, end: string, page: number, perPage = CTM_PER_PAGE): Promise<unknown> {
  return getJson(f, callsUrl(accountId, start, end, page, perPage), basicAuth(keys), "CallTrackingMetrics calls");
}

export interface CallsPage { calls: Obj[]; totalPages: number | null; totalEntries: number | null }
export function parseCallsPage(json: unknown): CallsPage {
  const top = obj(json);
  const list = top ? (top.calls ?? top.data ?? top.results) : null;
  if (!top || !Array.isArray(list)) throw new Error("CallTrackingMetrics answered with something that is not a list of calls.");
  return {
    calls: list.filter((x): x is Obj => Boolean(obj(x))),
    totalPages: num(top.total_pages),
    totalEntries: num(top.total_entries),
  };
}

/** A key CTM does not accept, from the status. */
export const isKeyRefusal = (e: unknown): boolean => e instanceof HttpError && (e.status === 401 || e.status === 403);

/**
 * The calls, and the answers read defensively.
 *
 * The parsers are pure: they take what Bing sent and return rows, a count of what they
 * could not read, and nothing else. A figure Bing did not send is NULL, never a nought.
 *
 * Bing's key travels in the address (`apikey=`). That is how the API takes it, so the
 * address is never printed, stored or put in a message: `safeMessage` removes it, and
 * the guard fails if a stored value ever carries it.
 */
import { HttpError, getJson } from "../page-behaviour/http.js";
import { num, serviceUrl, text } from "../signals/common.js";
import type { FetchLike } from "../page-behaviour/types.js";
import {
  AI_CITATION_PROBE_METHOD, BING_BASE, BING_METHODS, BING_STRING_MAX,
  type BingIssueRow, type BingPageRow, type BingQueryRow, type BingSiteDayRow,
} from "./types.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The address of one method for one site. The key is in it. */
export function methodUrl(method: string, apiKey: string, siteUrl: string | null): string {
  const q = new URLSearchParams();
  q.set("apikey", apiKey);
  if (siteUrl) q.set("siteUrl", siteUrl);
  return serviceUrl("bing", `${BING_BASE}/${method}?${q.toString()}`);
}

export async function callMethod(f: FetchLike, method: string, apiKey: string, siteUrl: string | null): Promise<unknown> {
  return getJson(f, methodUrl(method, apiKey, siteUrl), { Accept: "application/json" }, `Bing ${method}`);
}

/** Bing wraps an answer in { "d": ... }. Where it does not, the body itself is the answer. */
export const unwrap = (json: unknown): unknown => {
  const o = obj(json);
  return o && "d" in o ? o.d : json;
};

/** A key Bing does not accept, from the answer rather than from a guess about the status. */
export function isKeyRefusal(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  if (e.status === 401 || e.status === 403) return true;
  return /InvalidApiKey|NotAuthorized|not authorized|invalid api ?key/i.test(e.body);
}

/**
 * The documented way an unknown method answers: a not-found status, or a body that says
 * the method does not exist. Anything else (a 500, a timeout, a key refusal) is
 * UNCLEAR and is never read as "absent", because a feature marked unavailable on a
 * network blip would stay unavailable until somebody noticed.
 */
export function classifyMethodAnswer(e: unknown): "absent" | "unclear" {
  if (!(e instanceof HttpError)) return "unclear";
  if (e.status === 404 || e.status === 405) return "absent";
  if (/method[^.]{0,40}(not found|does not exist|is not supported|not implemented)|no such method|unknown method|not a valid method/i.test(e.body)) return "absent";
  return "unclear";
}

/* ── dates ── */

/** "/Date(1693872000000)/", optionally with an offset, to YYYY-MM-DD in UTC; or a plain ISO date. */
export function bingDay(v: unknown): string | null {
  if (typeof v === "string") {
    const m = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(v);
    if (m) {
      const ms = Number(m[1]);
      if (!Number.isFinite(ms)) return null;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
    const iso = /^(\d{4}-\d{2}-\d{2})/.exec(v);
    if (iso) {
      const t = Date.UTC(Number(iso[1]!.slice(0, 4)), Number(iso[1]!.slice(5, 7)) - 1, Number(iso[1]!.slice(8, 10)));
      return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso[1] ? null : iso[1]!;
    }
  }
  return null;
}

const count = (v: unknown): number | null => {
  const n = num(v);
  return n != null && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
const position = (v: unknown): number | null => {
  const n = num(v);
  // Bing uses -1 (or 0) where it has no position.
  return n != null && Number.isFinite(n) && n > 0 && n < 1000 ? Math.round(n * 10) / 10 : null;
};

/* ── sites ── */

export interface SiteInfo { url: string; verified: boolean | null }
export function parseSites(json: unknown): SiteInfo[] {
  const rows = unwrap(json);
  if (!Array.isArray(rows)) throw new Error("Bing answered with something that is not a list of sites.");
  const out: SiteInfo[] = [];
  for (const r of rows) {
    const o = obj(r);
    const url = text(o?.Url, BING_STRING_MAX);
    if (!url) continue;
    out.push({ url, verified: typeof o?.IsVerified === "boolean" ? o.IsVerified : null });
  }
  return out;
}

/** The same site however it was typed: scheme, case, www and the trailing slash do not make a different site. */
export const siteKey = (u: string): string => u.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");

/* ── queries and pages ── */

/** A search that looks like a person's contact detail is not kept. */
const LOOKS_PERSONAL = /@|\d{7,}/;

export interface QueryParse { rows: BingQueryRow[]; skipped: number }
export function parseQueries(json: unknown): QueryParse {
  const rows = unwrap(json);
  if (!Array.isArray(rows)) throw new Error("Bing answered with something that is not a list of searches.");
  const out: BingQueryRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    const o = obj(r);
    const raw = text(o?.Query, 200);
    const query = raw ? raw.replace(/\s+/g, " ").toLowerCase().slice(0, 120) : null;
    const day = bingDay(o?.Date);
    const clicks = count(o?.Clicks), impressions = count(o?.Impressions);
    if (!query || LOOKS_PERSONAL.test(query) || !day || clicks == null || impressions == null) { skipped += 1; continue; }
    out.push({ day, query, clicks, impressions, avgPosition: position(o?.AvgImpressionPosition) });
  }
  return { rows: out, skipped };
}

export interface PageParse { rows: BingPageRow[]; skipped: number }
export function parsePages(json: unknown): PageParse {
  const rows = unwrap(json);
  if (!Array.isArray(rows)) throw new Error("Bing answered with something that is not a list of pages.");
  const out: BingPageRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    const o = obj(r);
    const pageUrl = text(o?.Query, BING_STRING_MAX);
    const day = bingDay(o?.Date);
    const clicks = count(o?.Clicks), impressions = count(o?.Impressions);
    // A page address is the client's own public page; one with a query string is kept without it.
    if (!pageUrl || !/^https?:\/\//i.test(pageUrl) || !day || clicks == null || impressions == null) { skipped += 1; continue; }
    out.push({ day, pageUrl: pageUrl.split("#")[0]!.split("?")[0]!, clicks, impressions, avgPosition: position(o?.AvgImpressionPosition) });
  }
  return { rows: out, skipped };
}

/** Rows kept for the busiest items, every day of each, up to a row cap. Returns what was dropped. */
export function capByTotal<T extends { clicks: number; impressions: number }>(rows: T[], key: (r: T) => string, cap: number): { rows: T[]; dropped: number } {
  if (rows.length <= cap) return { rows, dropped: 0 };
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(key(r), (totals.get(key(r)) ?? 0) + r.clicks * 1000 + r.impressions);
  const order = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const per = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); (per.get(k) ?? per.set(k, []).get(k)!).push(r); }
  const kept: T[] = [];
  for (const k of order) {
    const group = per.get(k)!;
    if (kept.length + group.length > cap) continue;
    kept.push(...group);
  }
  return { rows: kept, dropped: rows.length - kept.length };
}

/* ── site-level days: traffic and crawl ── */

export interface TrafficParse { days: Map<string, { clicks: number | null; impressions: number | null }>; skipped: number }
export function parseTraffic(json: unknown): TrafficParse {
  const rows = unwrap(json);
  if (!Array.isArray(rows)) throw new Error("Bing answered with something that is not a list of days.");
  const days: TrafficParse["days"] = new Map();
  let skipped = 0;
  for (const r of rows) {
    const o = obj(r);
    const day = bingDay(o?.Date);
    if (!day) { skipped += 1; continue; }
    days.set(day, { clicks: count(o?.Clicks), impressions: count(o?.Impressions) });
  }
  return { days, skipped };
}

export function parseCrawl(json: unknown): { days: Map<string, Omit<BingSiteDayRow, "day" | "clicks" | "impressions">>; skipped: number } {
  const rows = unwrap(json);
  if (!Array.isArray(rows)) throw new Error("Bing answered with something that is not a list of crawl days.");
  const days = new Map<string, Omit<BingSiteDayRow, "day" | "clicks" | "impressions">>();
  let skipped = 0;
  for (const r of rows) {
    const o = obj(r);
    const day = bingDay(o?.Date);
    if (!day) { skipped += 1; continue; }
    days.set(day, {
      crawledPages: count(o?.CrawledPages), crawlErrors: count(o?.CrawlErrors), inIndex: count(o?.InIndex), inLinks: count(o?.InLinks),
      blockedRobots: count(o?.BlockedByRobotsTxt), code4xx: count(o?.Code4xx), code5xx: count(o?.Code5xx), dnsFailures: count(o?.DnsFailures), timeouts: count(o?.ConnectionTimeout),
    });
  }
  return { days, skipped };
}

/** Traffic and crawl joined by day. A day only one of them has keeps the other's fields null. */
export function joinSiteDays(traffic: TrafficParse["days"] | null, crawl: ReturnType<typeof parseCrawl>["days"] | null): BingSiteDayRow[] {
  const keys = new Set<string>([...(traffic?.keys() ?? []), ...(crawl?.keys() ?? [])]);
  const none = { crawledPages: null, crawlErrors: null, inIndex: null, inLinks: null, blockedRobots: null, code4xx: null, code5xx: null, dnsFailures: null, timeouts: null };
  return Array.from(keys).sort().map((day) => ({ day, clicks: traffic?.get(day)?.clicks ?? null, impressions: traffic?.get(day)?.impressions ?? null, ...(crawl?.get(day) ?? none) }));
}

/* ── crawl issues ── */

export function parseIssues(json: unknown): { rows: BingIssueRow[]; skipped: number } {
  const rows = unwrap(json);
  if (!Array.isArray(rows)) throw new Error("Bing answered with something that is not a list of crawl issues.");
  const out: BingIssueRow[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    const o = obj(r);
    const url = text(o?.Url, BING_STRING_MAX);
    if (!url || !/^https?:\/\//i.test(url)) { skipped += 1; continue; }
    const clean = url.split("#")[0]!;
    if (seen.has(clean)) continue;
    seen.add(clean);
    const issues = o?.Issues;
    out.push({
      url: clean, httpCode: count(o?.HttpCode),
      issueFlags: typeof issues === "number" ? count(issues) : null,
      issueText: typeof issues === "string" ? text(issues, 120) : null,
      inLinks: count(o?.InLinks),
    });
  }
  return { rows: out, skipped };
}

/* ── the AI citation probe ── */

export const aiProbeUrl = (apiKey: string, siteUrl: string): string => methodUrl(AI_CITATION_PROBE_METHOD, apiKey, siteUrl);
export { BING_METHODS };

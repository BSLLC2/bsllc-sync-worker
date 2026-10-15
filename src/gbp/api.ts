/**
 * The three calls, and the answers read defensively.
 *
 * The parsers are pure: they take what Google sent and return rows, a count of what
 * they could not read, and nothing else. A value Google did not send is NO ROW, never a
 * nought (a day with no entry is unanswered, and the dashboard says "no count recorded"
 * rather than "0"). The one assumption written down: a listed day with no `value` is
 * skipped too, because proto3 JSON leaves a zero out and this reader cannot tell that
 * from "no data". The sum over a period is the same either way; the number of days with
 * a count is what differs, and the dashboard says it counts only days with a count.
 */
import { HttpError, getJson } from "../page-behaviour/http.js";
import { num, serviceUrl, text } from "../signals/common.js";
import type { FetchLike } from "../page-behaviour/types.js";
import type { GbpClient } from "../signals/secrets.js";
import {
  GBP_DAILY_METRICS, GBP_KEYWORD_PAGE_SIZE, GBP_PERFORMANCE_BASE, GBP_TOKEN_URL, type GbpDayRow, type GbpKeywordRow,
} from "./types.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Google refused the saved authorisation (revoked, expired, or the client changed). */
export class TokenRefused extends Error {}

/** A refresh token to an access token. Throws TokenRefused where Google says the grant is no longer good. */
export async function exchangeRefreshToken(f: FetchLike, client: GbpClient, refreshToken: string): Promise<string> {
  const body = new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString();
  const res = await f(serviceUrl("oauth", GBP_TOKEN_URL), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const raw = await res.text();
  let j: Obj | null = null;
  try { j = obj(JSON.parse(raw)); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = text(j?.error, 60) ?? "";
    if (res.status === 400 || res.status === 401) {
      if (err === "invalid_grant") throw new TokenRefused("Google no longer accepts the saved authorisation (it was revoked, or it expired).");
      if (err === "invalid_client" || err === "unauthorized_client") throw new TokenRefused("Google does not accept the OAuth client in GBP_OAUTH_CLIENT_JSON.");
    }
    throw new HttpError(res.status, raw, "Google token exchange");
  }
  const token = text(j?.access_token, 4000);
  if (!token) throw new HttpError(res.status, "no access_token in the answer", "Google token exchange");
  return token;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export function dailyUrl(locationId: string, start: string, end: string): string {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const q = new URLSearchParams();
  for (const m of Object.keys(GBP_DAILY_METRICS)) q.append("dailyMetrics", m);
  q.set("dailyRange.startDate.year", String(sy)); q.set("dailyRange.startDate.month", String(sm)); q.set("dailyRange.startDate.day", String(sd));
  q.set("dailyRange.endDate.year", String(ey)); q.set("dailyRange.endDate.month", String(em)); q.set("dailyRange.endDate.day", String(ed));
  return serviceUrl("gbp", `${GBP_PERFORMANCE_BASE}/locations/${locationId}:fetchMultiDailyMetricsTimeSeries?${q.toString()}`);
}

export async function fetchDaily(f: FetchLike, token: string, locationId: string, start: string, end: string): Promise<unknown> {
  return getJson(f, dailyUrl(locationId, start, end), bearer(token), "Business Profile daily counts");
}

const pad = (n: number) => String(n).padStart(2, "0");
function dayOf(d: unknown): string | null {
  const o = obj(d);
  const y = num(o?.year), m = num(o?.month), dd = num(o?.day);
  if (y == null || m == null || dd == null || !Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(dd)) return null;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || dd < 1 || dd > 31) return null;
  return `${y}-${pad(m)}-${pad(dd)}`;
}

export interface DailyParse { rows: GbpDayRow[]; unknownMetrics: string[]; skipped: number }

/** The daily answer to rows. Throws where there is no time series at all, so an empty answer is never "zero everywhere". */
export function parseDaily(json: unknown): DailyParse {
  const top = obj(json);
  if (!top || !Array.isArray(top.multiDailyMetricTimeSeries)) throw new Error("Business Profile answered with no time series for this location.");
  const rows: GbpDayRow[] = [];
  const unknown = new Set<string>();
  let skipped = 0;
  for (const group of top.multiDailyMetricTimeSeries) {
    for (const s of arr(obj(group)?.dailyMetricTimeSeries)) {
      const so = obj(s);
      const name = text(so?.dailyMetric, 80);
      const key = name ? GBP_DAILY_METRICS[name] : undefined;
      if (!name) { skipped += 1; continue; }
      if (!key) { unknown.add(name); continue; }
      for (const dv of arr(obj(so?.timeSeries)?.datedValues)) {
        const day = dayOf(obj(dv)?.date);
        const v = num(obj(dv)?.value);
        if (!day || v == null || !Number.isInteger(v) || v < 0) { skipped += 1; continue; }
        rows.push({ day, metric: key, value: v });
      }
    }
  }
  return { rows, unknownMetrics: Array.from(unknown).sort(), skipped };
}

/** One month's search terms, one page. The range is a single month so each count is for that month whatever the API sums. */
export function keywordsUrl(locationId: string, month: string, pageToken: string | null): string {
  const [y, m] = month.split("-").map(Number);
  const q = new URLSearchParams();
  q.set("monthlyRange.startMonth.year", String(y)); q.set("monthlyRange.startMonth.month", String(m));
  q.set("monthlyRange.endMonth.year", String(y)); q.set("monthlyRange.endMonth.month", String(m));
  q.set("pageSize", String(GBP_KEYWORD_PAGE_SIZE));
  if (pageToken) q.set("pageToken", pageToken);
  return serviceUrl("gbp", `${GBP_PERFORMANCE_BASE}/locations/${locationId}/searchkeywords/impressions/monthly?${q.toString()}`);
}

export async function fetchKeywords(f: FetchLike, token: string, locationId: string, month: string, pageToken: string | null): Promise<unknown> {
  return getJson(f, keywordsUrl(locationId, month, pageToken), bearer(token), "Business Profile search terms");
}

/** A search term that looks like a person's contact detail is not kept. */
const LOOKS_PERSONAL = /@|\d{7,}/;

export interface KeywordParse { rows: GbpKeywordRow[]; next: string | null; skipped: number }

export function parseKeywords(json: unknown, month: string): KeywordParse {
  const top = obj(json);
  if (!top) throw new Error("Business Profile answered with something that is not a list of search terms.");
  const rows: GbpKeywordRow[] = [];
  let skipped = 0;
  for (const e of arr(top.searchKeywordsCounts)) {
    const o = obj(e);
    const raw = text(o?.searchKeyword, 200);
    const keyword = raw ? raw.replace(/\s+/g, " ").toLowerCase().slice(0, 80) : null;
    const iv = obj(o?.insightsValue);
    const exact = num(iv?.value), below = num(iv?.threshold);
    if (!keyword || LOOKS_PERSONAL.test(keyword) || (exact == null && below == null)) { skipped += 1; continue; }
    if (exact != null) { if (!Number.isInteger(exact) || exact < 0) { skipped += 1; continue; } rows.push({ month, keyword, impressions: exact, bound: "exact" }); }
    else if (below != null && Number.isInteger(below) && below >= 0) rows.push({ month, keyword, impressions: below, bound: "below" });
    else skipped += 1;
  }
  return { rows, next: text(top.nextPageToken, 500), skipped };
}

/**
 * Microsoft Clarity's data export, one day at a time, per page.
 *
 * The export API is small on purpose: one call returns a day of aggregates for a
 * project with the page address as a dimension, it reaches back three days, and it
 * allows ten calls a day per project. So this reads ONE call a day per client and
 * the history exists only because a row is kept for each day (`seo_clarity_days`).
 * The sessions, the share of sessions with rapid repeated clicks, with clicks that
 * did nothing and with a quick return to the previous page, the average scroll
 * depth and the active time are kept per page. COUNTS AND SHARES ONLY: the export
 * has no recording, no visitor and no element, and this stores none.
 *
 * THE RESPONSE SHAPES HERE HAVE NOT BEEN RUN AGAINST A LIVE PROJECT. The names of
 * the metrics and of the fields inside them are written from the export
 * documentation and read DEFENSIVELY: a metric or field that is not there is null,
 * never a nought, and a page the traffic metric does not list is not written. The
 * guard drives the parser with variants of the shape. The URL dimension's key is
 * looked up case-insensitively because the documentation spells it two ways.
 *
 * The export token is a secret of this repository (the `CLARITY_TOKENS_JSON` secret,
 * keyed by client slug). The dashboard app never holds it, never receives it and
 * records only the project id, which is what builds the link to Clarity's own
 * heatmaps.
 */
import { getJson } from "./http.js";
import { isRealPath, normPath } from "./paths.js";
import type { ClarityDayOut, FetchLike } from "./types.js";

export const CLARITY_URL = "https://www.clarity.ms/export-data/api/v1/project-live-insights";
export const CLARITY_ROW_LIMIT = 1000;

/** A second read inside this long is refused: the export allows ten calls a day per project. */
export const SKIP_WITHIN_MS = 6 * 3_600_000;

/** True where the last read for an account was good and recent enough that reading again would spend the daily budget. */
export function recentlyRead(last: { ranAt: Date | string; status: string } | undefined, now: Date): boolean {
  if (!last || (last.status !== "ok" && last.status !== "capped")) return false;
  return now.getTime() - new Date(last.ranAt).getTime() < SKIP_WITHIN_MS;
}

export function clarityUrlFor(): string {
  return `${CLARITY_URL}?numOfDays=1&dimension1=URL`;
}

type Info = Record<string, unknown>;
interface Metric { metricName?: string; information?: Info[] }

const find = (o: Info, ...names: string[]): unknown => {
  const keys = Object.keys(o);
  for (const n of names) {
    const hit = keys.find((k) => k.toLowerCase() === n.toLowerCase());
    if (hit !== undefined) return o[hit];
  }
  return undefined;
};
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const urlOf = (o: Info): string | null => {
  const v = find(o, "url", "Url", "URL");
  return typeof v === "string" && v.trim() ? v : null;
};
const metricNamed = (all: Metric[], name: string): Info[] =>
  all.find((m) => String(m.metricName ?? "").toLowerCase() === name.toLowerCase())?.information ?? [];

export interface ClarityParsed { rows: ClarityDayOut[]; urlsSeen: number; capped: boolean }

/** A day's export to one row per page. A page is a row only if the traffic metric lists it. */
export function parseClarity(json: unknown, day: string): ClarityParsed {
  const all: Metric[] = Array.isArray(json) ? (json as Metric[]) : [];
  const by = new Map<string, ClarityDayOut>();
  const row = (path: string): ClarityDayOut => {
    let r = by.get(path);
    if (!r) { r = { pagePath: path, day, sessions: null, scrollDepthAvg: null, engagementSeconds: null, deadClickPct: null, rageClickPct: null, quickbackPct: null }; by.set(path, r); }
    return r;
  };
  const traffic = metricNamed(all, "Traffic");
  for (const t of traffic) {
    const u = urlOf(t);
    if (!u || !isRealPath(u)) continue;
    const sessions = num(find(t, "totalSessionCount", "sessionsCount", "sessions"));
    if (sessions == null) continue;
    const r = row(normPath(u));
    r.sessions = (r.sessions ?? 0) + sessions;
  }
  const listed = new Set(by.keys());
  const share = (name: string, set: (r: ClarityDayOut, v: number | null) => void) => {
    for (const info of metricNamed(all, name)) {
      const u = urlOf(info);
      if (!u) continue;
      const path = normPath(u);
      if (!listed.has(path)) continue;
      set(row(path), num(find(info, "sessionsWithMetricPercentage", "sessionsWithMetricPercent", "percentage")));
    }
  };
  share("RageClickCount", (r, v) => { r.rageClickPct = v; });
  share("DeadClickCount", (r, v) => { r.deadClickPct = v; });
  share("QuickbackClick", (r, v) => { r.quickbackPct = v; });
  for (const info of metricNamed(all, "ScrollDepth")) {
    const u = urlOf(info); if (!u || !listed.has(normPath(u))) continue;
    row(normPath(u)).scrollDepthAvg = num(find(info, "averageScrollDepth", "average"));
  }
  for (const info of metricNamed(all, "EngagementTime")) {
    const u = urlOf(info); if (!u || !listed.has(normPath(u))) continue;
    row(normPath(u)).engagementSeconds = num(find(info, "activeTime", "totalTime"));
  }
  return { rows: Array.from(by.values()), urlsSeen: traffic.length, capped: traffic.length >= CLARITY_ROW_LIMIT };
}

export async function readClarity(f: FetchLike, token: string, day: string): Promise<ClarityParsed> {
  return parseClarity(await getJson(f, clarityUrlFor(), { Authorization: `Bearer ${token}` }, "Clarity export"), day);
}

/** `{"slug": "token"}` to a lookup. A value that is not a non-empty string is no token. */
export function parseTokens(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || !raw.trim()) return out;
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new Error("CLARITY_TOKENS_JSON is not valid JSON."); }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("CLARITY_TOKENS_JSON must be an object of client slug to token.");
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) if (typeof v === "string" && v.trim()) out.set(k.trim().toLowerCase(), v.trim());
  return out;
}

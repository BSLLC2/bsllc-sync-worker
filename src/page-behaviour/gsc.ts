/**
 * Search Console, by page: clicks and impressions per page and device for the
 * last 28 days and the 28 before, and each page's few biggest searches as counts.
 *
 * Request shapes are written from the Search Analytics documentation and have NOT
 * been run against a live property (see docs/SEO-PAGE-BEHAVIOUR.md). A search term
 * is stored only as `{query, clicks, impressions}` against a page: Search Console
 * itself withholds the rare ones, and nothing here ties a term to a person.
 */
import { postJson } from "./http.js";
import { addDays, isRealPath, normPath } from "./paths.js";
import { windowsFor } from "./ga4.js";
import { GSC_LAG_DAYS, PAGE_CAP, TOP_QUERIES, type BehaviourRowOut, type FetchLike, type Period, type Window, type Windows } from "./types.js";

export const GSC_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
export const GSC_ROW_LIMIT = 25000;

export const gscWindows = (today: string): Windows => windowsFor(today, GSC_LAG_DAYS);

export function gscRequest(w: Window, dimensions: readonly string[]) {
  return { startDate: w.start, endDate: w.end, dimensions: [...dimensions], dataState: "final", rowLimit: GSC_ROW_LIMIT };
}

interface GscRow { keys?: string[]; clicks?: number; impressions?: number }

export interface GscPageAgg { path: string; device: string; clicks: number; impressions: number }

export function parsePageDevice(json: unknown): { rows: GscPageAgg[]; full: boolean } {
  const rows = ((json ?? {}) as { rows?: GscRow[] }).rows ?? [];
  const by = new Map<string, GscPageAgg>();
  for (const r of rows) {
    const page = String(r.keys?.[0] ?? "");
    if (!isRealPath(page)) continue;
    const path = normPath(page);
    const device = String(r.keys?.[1] ?? "").toLowerCase() || "unknown";
    const key = `${path}\u0000${device}`;
    const cur = by.get(key) ?? { path, device, clicks: 0, impressions: 0 };
    cur.clicks += Number(r.clicks ?? 0) || 0;
    cur.impressions += Number(r.impressions ?? 0) || 0;
    by.set(key, cur);
  }
  return { rows: Array.from(by.values()), full: rows.length >= GSC_ROW_LIMIT };
}

export interface TopQuery { query: string; clicks: number; impressions: number }

export function parsePageQuery(json: unknown, perPage = TOP_QUERIES): Map<string, TopQuery[]> {
  const rows = ((json ?? {}) as { rows?: GscRow[] }).rows ?? [];
  const by = new Map<string, Map<string, TopQuery>>();
  for (const r of rows) {
    const page = String(r.keys?.[0] ?? "");
    const q = String(r.keys?.[1] ?? "").trim().slice(0, 120);
    if (!isRealPath(page) || !q) continue;
    const path = normPath(page);
    const m = by.get(path) ?? new Map<string, TopQuery>();
    const cur = m.get(q) ?? { query: q, clicks: 0, impressions: 0 };
    cur.clicks += Number(r.clicks ?? 0) || 0;
    cur.impressions += Number(r.impressions ?? 0) || 0;
    m.set(q, cur);
    by.set(path, m);
  }
  const out = new Map<string, TopQuery[]>();
  for (const [path, m] of by) {
    out.set(path, Array.from(m.values()).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.query.localeCompare(b.query)).slice(0, perPage));
  }
  return out;
}

export interface GscResult { rows: BehaviourRowOut[]; totalFound: number; capped: boolean; truncatedByApi: boolean }

export async function readGscPages(f: FetchLike, token: string, property: string, w: Windows, cap = PAGE_CAP): Promise<GscResult> {
  const url = `${GSC_BASE}/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const headers = { Authorization: `Bearer ${token}` };
  const cur = parsePageDevice(await postJson(f, url, headers, gscRequest(w.current, ["page", "device"]), "Search Console (pages)"));
  const prior = parsePageDevice(await postJson(f, url, headers, gscRequest(w.prior, ["page", "device"]), "Search Console (pages, earlier)"));
  const queries = parsePageQuery(await postJson(f, url, headers, gscRequest(w.current, ["page", "query"]), "Search Console (page queries)"));

  const clicksBy = new Map<string, { clicks: number; impressions: number }>();
  for (const r of cur.rows) {
    const c = clicksBy.get(r.path) ?? { clicks: 0, impressions: 0 };
    c.clicks += r.clicks; c.impressions += r.impressions;
    clicksBy.set(r.path, c);
  }
  const ranked = Array.from(clicksBy.entries()).map(([path, v]) => ({ path, ...v })).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.path.localeCompare(b.path));
  const keep = new Set(ranked.slice(0, cap).map((r) => r.path));
  const out: BehaviourRowOut[] = [];
  for (const [period, list, win] of [["current", cur.rows, w.current], ["prior", prior.rows, w.prior]] as const) {
    const totals = new Map<string, { clicks: number; impressions: number }>();
    for (const r of list) {
      if (!keep.has(r.path)) continue;
      out.push({ source: "gsc", pagePath: r.path, device: r.device, period: period as Period, windowStart: win.start, windowEnd: win.end, sessions: null, engagedSessions: null, engagementSeconds: null, keyEvents: null, clicks: Math.round(r.clicks), impressions: Math.round(r.impressions), topQueriesJson: null });
      const t = totals.get(r.path) ?? { clicks: 0, impressions: 0 };
      t.clicks += r.clicks; t.impressions += r.impressions;
      totals.set(r.path, t);
    }
    // One "all devices" row per page, which is where the page's biggest searches live (current window only).
    for (const [path, t] of totals) {
      const top = period === "current" ? queries.get(path) ?? null : null;
      out.push({ source: "gsc", pagePath: path, device: "all", period: period as Period, windowStart: win.start, windowEnd: win.end, sessions: null, engagedSessions: null, engagementSeconds: null, keyEvents: null, clicks: Math.round(t.clicks), impressions: Math.round(t.impressions), topQueriesJson: top && top.length ? JSON.stringify(top) : null });
    }
  }
  return { rows: out, totalFound: ranked.length, capped: ranked.length > cap, truncatedByApi: cur.full || prior.full };
}

export { addDays };

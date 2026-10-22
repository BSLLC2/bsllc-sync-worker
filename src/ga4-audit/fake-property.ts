/**
 * A pretend GA4 property and Search Console for the guard. Honours date ranges
 * (several at once, with the dateRange dimension GA4 adds), dimension filters
 * (string, in-list, not, and, or), and aggregation. EVERY ROW IS INVENTED.
 *
 * The invented site is "Harbor Travel", shaped like the real one the audit is for:
 * advisor microsites under /plan-your-trip/advisor/<name>/, a directory at the bare
 * path, a homepage that also fires the form event on a search, and a flood of Direct
 * visits from one country onto the advisor path that engages almost nobody and is
 * throttled on a stated date.
 */
import { addDays } from "../page-behaviour/paths.js";
import type { FetchLike } from "../page-behaviour/types.js";
import type { GscRow, GscQuery, GscReader } from "./gsc.js";

export interface FactRow {
  kind: "s" | "e";
  date: string;
  sessionDefaultChannelGroup: string;
  sessionSourceMedium: string;
  country: string;
  city: string;
  landingPage: string;
  pagePath: string;
  pagePathPlusQueryString: string;
  eventName: string;
  isKeyEvent: string;
  // metrics
  sessions: number; engagedSessions: number; userEngagementDuration: number; activeUsers: number; screenPageViews: number; eventCount: number;
}

type Dict = Record<string, unknown>;

const dimValue = (r: FactRow, dim: string): string => {
  if (dim === "date") return r.date.replace(/-/g, "");
  if (dim === "yearMonth") return r.date.slice(0, 7).replace("-", "");
  return String((r as unknown as Dict)[dim] ?? "");
};

export function matches(f: Dict | undefined | null, r: FactRow): boolean {
  if (!f) return true;
  if (f.andGroup) return ((f.andGroup as Dict).expressions as Dict[]).every((e) => matches(e, r));
  if (f.orGroup) return ((f.orGroup as Dict).expressions as Dict[]).some((e) => matches(e, r));
  if (f.notExpression) return !matches(f.notExpression as Dict, r);
  const leaf = f.filter as Dict | undefined;
  if (!leaf) throw new Error("fake property: unknown filter shape");
  const v = dimValue(r, String(leaf.fieldName));
  if (leaf.inListFilter) return ((leaf.inListFilter as Dict).values as string[]).includes(v);
  const s = leaf.stringFilter as Dict;
  const want = String(s.value);
  switch (s.matchType) {
    case "EXACT": return v === want;
    case "BEGINS_WITH": return v.startsWith(want);
    case "CONTAINS": return v.includes(want);
    default: throw new Error(`fake property: match type ${String(s.matchType)}`);
  }
}

export interface Fake { fetch: FetchLike; calls: number; bodies: Dict[]; }

/** A GA4 runReport answerer over a table of facts. Records every request body. */
export function fakeGa4(facts: readonly FactRow[], opt: { failOn?: (body: Dict) => number | null } = {}): Fake {
  const state: Fake = { calls: 0, bodies: [], fetch: undefined as never };
  state.fetch = async (_url, init) => {
    state.calls++;
    const body = JSON.parse(init?.body ?? "{}") as Dict;
    state.bodies.push(body);
    const fail = opt.failOn?.(body);
    if (fail) return { ok: false, status: fail, text: async () => JSON.stringify({ error: { message: "pretend failure" } }) };
    const dims = ((body.dimensions as Dict[]) ?? []).map((d) => String(d.name));
    const metrics = ((body.metrics as Dict[]) ?? []).map((m) => String(m.name));
    const ranges = (body.dateRanges as Dict[]) ?? [];
    const wantEvents = metrics.includes("eventCount");
    const filter = body.dimensionFilter as Dict | undefined;
    const buckets = new Map<string, { dv: string[]; sums: number[] }>();
    ranges.forEach((rg, ri) => {
      for (const r of facts) {
        if ((r.kind === "e") !== wantEvents) continue;
        if (r.date < String(rg.startDate) || r.date > String(rg.endDate)) continue;
        if (!matches(filter, r)) continue;
        const dv = dims.map((d) => dimValue(r, d));
        const withRange = ranges.length > 1 ? [...dv, String(rg.name ?? `r${ri}`)] : dv;
        const key = withRange.join("\u0000");
        const b = buckets.get(key) ?? { dv: withRange, sums: metrics.map(() => 0) };
        metrics.forEach((m, i) => { b.sums[i]! += Number((r as unknown as Dict)[m] ?? 0); });
        buckets.set(key, b);
      }
    });
    let rows = [...buckets.values()].map((b) => ({ dimensionValues: b.dv.map((value) => ({ value })), metricValues: b.sums.map((v) => ({ value: String(v) })) }));
    const order = (body.orderBys as Dict[] | undefined)?.[0];
    const om = order && (order.metric as Dict | undefined)?.metricName;
    if (om) { const idx = metrics.indexOf(String(om)); rows = rows.sort((a, b) => Number(b.metricValues[idx]!.value) - Number(a.metricValues[idx]!.value)); }
    const limit = Number(body.limit ?? 25000), offset = Number(body.offset ?? 0);
    const page = rows.slice(offset, offset + limit);
    const out = {
      dimensionHeaders: [...dims, ...(ranges.length > 1 ? ["dateRange"] : [])].map((name) => ({ name })),
      metricHeaders: metrics.map((name) => ({ name })),
      rows: page, rowCount: rows.length,
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };
  return state;
}

/* ───────────── the invented site ───────────── */

export const FLOOD_START = "2025-11-01", FLOOD_END = "2026-08-31", THROTTLE = "2026-07-30";
const ADVISORS = ["jane-doe", "sam-lee", "ana-ruiz", "kim-park", "omar-ali", "lee-chen"];

function* eachDay(start: string, end: string) { for (let d = start; d <= end; d = addDays(d, 1)) yield d; }
const sRow = (date: string, o: Partial<FactRow> & { sessions: number; engaged: number }): FactRow => {
  const { engaged, ...rest } = o;
  return {
  kind: "s", date, sessionDefaultChannelGroup: "Organic Search", sessionSourceMedium: "google / organic", country: "United States", city: "Chicago",
  landingPage: "/", pagePath: "/", pagePathPlusQueryString: "/", eventName: "page_view", isKeyEvent: "false",
  engagedSessions: engaged, userEngagementDuration: engaged * 70 + (o.sessions - engaged) * 2, activeUsers: Math.max(1, Math.round(o.sessions * 0.9)), screenPageViews: o.sessions * 2, eventCount: 0, ...rest,
  } as FactRow;
};
const eRow = (date: string, o: Partial<FactRow> & { eventCount: number; eventName: string }): FactRow => ({
  kind: "e", date, sessionDefaultChannelGroup: "Organic Search", sessionSourceMedium: "google / organic", country: "United States", city: "Chicago",
  landingPage: "/", pagePath: "/", pagePathPlusQueryString: "/", isKeyEvent: o.eventName === "form_submit" ? "true" : "false",
  sessions: 0, engagedSessions: 0, userEngagementDuration: 0, activeUsers: 0, screenPageViews: 0, ...o,
}) as FactRow;

/**
 * Daily facts from 2022-11-01 to `end`. Real traffic is steady with a mild weekend dip.
 * The flood is Direct, Singapore, landing on /plan-your-trip/advisor, 3% engaged, until the throttle.
 * Form events fire on advisor microsites, the homepage (a search) and the directory (a search with destination=).
 */
export function harborFacts(end: string): FactRow[] {
  const out: FactRow[] = [];
  for (const d of eachDay("2022-11-01", end)) {
    const dow = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
    const wk = dow >= 5 ? 0.8 : 1;
    const n = (x: number) => Math.round(x * wk);
    out.push(sRow(d, { sessions: n(50), engaged: n(36) }));
    out.push(sRow(d, { sessions: n(22), engaged: n(15), landingPage: "/hotel-destinations/paris/", pagePath: "/hotel-destinations/paris/" }));
    ADVISORS.forEach((a, i) => {
      const main = `/plan-your-trip/advisor/${a}/`;
      out.push(sRow(d, { sessions: n(10 - i), engaged: n(8 - i), landingPage: main, pagePath: main, sessionSourceMedium: "google / organic" }));
      out.push(sRow(d, { sessions: n(4), engaged: n(3), landingPage: main, pagePath: `${main}about/` }));
    });
    out.push(sRow(d, { sessions: n(18), engaged: n(12), sessionDefaultChannelGroup: "Direct", sessionSourceMedium: "(direct) / (none)", landingPage: "/", pagePath: "/" }));
    out.push(sRow(d, { sessions: n(4), engaged: n(2), sessionDefaultChannelGroup: "Organic Social", sessionSourceMedium: "facebook / social" }));
    out.push(sRow(d, { sessions: n(3), engaged: n(2), sessionDefaultChannelGroup: "Organic Social", sessionSourceMedium: "instagram / social" }));
    out.push(sRow(d, { sessions: n(2), engaged: n(2), sessionDefaultChannelGroup: "Referral", sessionSourceMedium: "chatgpt.com / referral" }));
    out.push(sRow(d, { sessions: n(2), engaged: n(1), sessionDefaultChannelGroup: "Unassigned", sessionSourceMedium: "(not set) / (not set)" }));
    const flooding = d >= FLOOD_START && d <= FLOOD_END;
    out.push(sRow(d, { sessions: flooding ? (d < THROTTLE ? 1_000 : 600) : 4, engaged: flooding ? (d < THROTTLE ? 30 : 18) : 0, sessionDefaultChannelGroup: "Direct", sessionSourceMedium: "(direct) / (none)", country: "Singapore", city: "Singapore", landingPage: "/plan-your-trip/advisor", pagePath: "/plan-your-trip/advisor" }));
    // Events.
    ADVISORS.forEach((a, i) => { const p = `/plan-your-trip/advisor/${a}/`; out.push(eRow(d, { eventName: "form_submit", eventCount: i < 2 ? 2 : (i === 5 ? 0 : 1), pagePath: p, pagePathPlusQueryString: p })); out.push(eRow(d, { eventName: "form_start", eventCount: i < 2 ? 3 : 2, pagePath: p, pagePathPlusQueryString: p })); });
    out.push(eRow(d, { eventName: "form_submit", eventCount: n(6), pagePath: "/", pagePathPlusQueryString: "/?destination=paris" }));
    out.push(eRow(d, { eventName: "form_submit", eventCount: n(3), pagePath: "/plan-your-trip/advisor/", pagePathPlusQueryString: "/plan-your-trip/advisor/?destination=rome" }));
    out.push(eRow(d, { eventName: "form_submit", eventCount: 2, pagePath: "/contact", pagePathPlusQueryString: "/contact", sessionDefaultChannelGroup: "Direct", sessionSourceMedium: "(direct) / (none)" }));
    out.push(eRow(d, { eventName: "scroll", eventCount: 40, pagePath: "/", pagePathPlusQueryString: "/" }));
  }
  return out;
}

/* ───────────── Search Console ───────────── */

export interface GscFake { read: GscReader; queries: GscQuery[] }

/** Clicks track organic sessions at a steady ratio; the first day is the stated start. */
export function fakeGsc(opt: { firstDay: string; lastDay: string; ratio?: number }): GscFake {
  const queries: GscQuery[] = [];
  const ratio = opt.ratio ?? 1.2;
  const read: GscReader = async (q) => {
    queries.push(q);
    const rows: GscRow[] = [];
    const dayRows: Array<{ d: string; clicks: number }> = [];
    for (const d of eachDay(q.range.start, q.range.end)) { if (d < opt.firstDay || d > opt.lastDay) continue; dayRows.push({ d, clicks: Math.round(((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7 >= 5 ? 0.8 : 1) * 80 / ratio) }); }
    const total = dayRows.reduce((n, r) => n + r.clicks, 0);
    const mk = (keys: string[], clicks: number, impr: number, pos: number): GscRow => ({ keys, clicks, impressions: impr, ctr: impr ? clicks / impr : 0, position: pos });
    const dim = q.dimensions.join(",");
    if (dim === "date") for (const r of dayRows) rows.push(mk([r.d], r.clicks, r.clicks * 20, 12));
    else if (dim === "page") {
      rows.push(mk(["https://harbor.example/"], Math.round(total * 0.4), Math.round(total * 0.4) * 20, 9));
      ADVISORS.forEach((a, i) => rows.push(mk([`https://harbor.example/plan-your-trip/advisor/${a}/`], Math.round(total * 0.08 * (1 - i * 0.1)), 500 * (6 - i), 14)));
      rows.push(mk(["https://harbor.example/hotel-destinations/paris/"], Math.round(total * 0.1), 4000, 11));
    } else if (dim === "query") {
      rows.push(mk(["harbor travel"], Math.round(total * 0.15), 900, 1.2));
      rows.push(mk(["paris hotels"], Math.round(total * 0.1), 3000, 9));
      rows.push(mk(["jane doe travel advisor"], Math.round(total * 0.03), 100, 3));
      rows.push(mk(["travel advisor near me"], Math.round(total * 0.1), 4000, 15));
    } else if (dim === "device") { rows.push(mk(["MOBILE"], Math.round(total * 0.6), total * 12, 12)); rows.push(mk(["DESKTOP"], Math.round(total * 0.4), total * 8, 11)); }
    else if (dim === "country") { rows.push(mk(["usa"], Math.round(total * 0.9), total * 15, 11)); rows.push(mk(["can"], Math.round(total * 0.1), total * 4, 13)); }
    return { rows, truncated: false };
  };
  return { read, queries };
}

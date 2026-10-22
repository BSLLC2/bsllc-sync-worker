/**
 * Google Analytics 4 for the Website performance report: builders and parsers that
 * are pure, and readers that take a fetch so the guard drives them with no network.
 *
 * NONE OF THE REQUEST SHAPES BELOW HAS BEEN RUN AGAINST A LIVE PROPERTY. They are
 * written from the Data API's documentation. docs/GA4-REPORT.md lists the ones that
 * are least certain.
 *
 * RULES
 *  1. A metric the property rejected is a column of NULLs, never a column of
 *     noughts. A 400 moves down the metric ladder; nothing else does.
 *  2. THE COUNTRY EXCLUSION GOES ON EVERY REQUEST, the daily one included, so the
 *     totals, the trend and every list leave out the same traffic. No other bot
 *     filter is applied and none is invented.
 *  3. A report is read in full or not at all. Paging runs to ROW_CEILING; past it
 *     the report is called too big and written as nothing, never as a cut list.
 *  4. 429 and 5xx are retried a few times with a wait. A 4xx other than 429 is not.
 *  5. An error message names no token and no row.
 */
import { HttpError, postJson } from "../page-behaviour/http.js";
import { isRealPath, normPath } from "../page-behaviour/paths.js";
import { dayFromGa4Date, daysBetween, monthFromYearMonth } from "./months.js";
import {
  PAGE_SIZE, RETRY_WAITS_MS, ROW_CEILING, TOP_N,
  type DailyRowOut, type FetchLike, type ReportGroup, type ReportKind, type ReportRowOut,
} from "./types.js";
import type { ReadWindow } from "./months.js";

export const GA4_BASE = "https://analyticsdata.googleapis.com/v1beta";
export const reportUrl = (property: string) => `${GA4_BASE}/properties/${property}:runReport`;

/** Most complete first. A dropped metric becomes a NULL column. */
export const DAILY_METRIC_LADDER: ReadonlyArray<readonly string[]> = [
  ["sessions", "engagedSessions", "userEngagementDuration", "totalUsers", "keyEvents"],
  ["sessions", "engagedSessions", "userEngagementDuration", "totalUsers", "conversions"],
  ["sessions", "engagedSessions", "userEngagementDuration", "totalUsers"],
  ["sessions", "engagedSessions", "userEngagementDuration"],
  ["sessions", "engagedSessions"],
  ["sessions"],
];
export const SESSION_METRIC_LADDER: ReadonlyArray<readonly string[]> = [
  ["sessions", "engagedSessions", "userEngagementDuration"],
  ["sessions", "engagedSessions"],
  ["sessions"],
];
export const EVENT_METRICS: readonly string[] = ["eventCount"];

/* ───────────────────────── filters ───────────────────────── */

export type Filter = Record<string, unknown>;

const stringFilter = (fieldName: string, matchType: "EXACT" | "BEGINS_WITH", value: string): Filter =>
  ({ filter: { fieldName, stringFilter: { matchType, value } } });

/** Leaves out every listed country. Null where nothing is excluded. */
export function exclusionFilter(countries: readonly string[]): Filter | null {
  return countries.length
    ? { notExpression: { filter: { fieldName: "country", inListFilter: { values: [...countries] } } } }
    : null;
}

/** One filter as it is, several as an andGroup, none as undefined. */
export function andFilters(...parts: Array<Filter | null>): Filter | undefined {
  const list = parts.filter((p): p is Filter => p != null);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return { andGroup: { expressions: list } };
}

/* ───────────────────────── requests ───────────────────────── */

export function dailyRequest(w: ReadWindow, metrics: readonly string[], countries: readonly string[]) {
  const dimensionFilter = andFilters(exclusionFilter(countries));
  return {
    dateRanges: [{ startDate: w.start, endDate: w.end }],
    dimensions: [{ name: "date" }],
    metrics: metrics.map((name) => ({ name })),
    orderBys: [{ dimension: { dimensionName: "date" } }],
    ...(dimensionFilter ? { dimensionFilter } : {}),
  };
}

export interface KindSpec {
  kind: ReportKind;
  /** The dimensions after yearMonth. */
  dimensions: readonly string[];
  /** Metric ladder: a list of rungs, most complete first. */
  ladder: ReadonlyArray<readonly string[]>;
  /** The metric the rows are ordered by. */
  orderBy: string;
  filter: Filter | null;
  parent: string;
}

/** The report requests a client's config calls for, in the order they are read. */
export function kindSpecs(groups: readonly ReportGroup[], formEvent: string): KindSpec[] {
  const formFilter = stringFilter("eventName", "EXACT", formEvent);
  const specs: KindSpec[] = [
    { kind: "region", dimensions: ["country", "region"], ladder: SESSION_METRIC_LADDER, orderBy: "sessions", filter: null, parent: "" },
    { kind: "source_medium", dimensions: ["sessionSourceMedium"], ladder: SESSION_METRIC_LADDER, orderBy: "sessions", filter: null, parent: "" },
    { kind: "landing_page", dimensions: ["landingPage"], ladder: SESSION_METRIC_LADDER, orderBy: "sessions", filter: null, parent: "" },
    { kind: "form_page", dimensions: ["pagePath"], ladder: [EVENT_METRICS], orderBy: "eventCount", filter: formFilter, parent: "" },
  ];
  for (const g of groups) {
    specs.push({ kind: "group_page", dimensions: ["landingPage"], ladder: SESSION_METRIC_LADDER, orderBy: "sessions", filter: stringFilter("landingPage", "BEGINS_WITH", g.prefix), parent: g.prefix });
  }
  for (const g of groups) {
    specs.push({
      kind: "group_form", dimensions: ["pagePath"], ladder: [EVENT_METRICS], orderBy: "eventCount",
      filter: andFilters(stringFilter("pagePath", "BEGINS_WITH", g.prefix), formFilter) ?? null, parent: g.prefix,
    });
  }
  return specs;
}

export function reportRequest(w: ReadWindow, spec: KindSpec, metrics: readonly string[], countries: readonly string[]) {
  const dimensionFilter = andFilters(spec.filter, exclusionFilter(countries));
  return {
    dateRanges: [{ startDate: w.start, endDate: w.end }],
    dimensions: [{ name: "yearMonth" }, ...spec.dimensions.map((name) => ({ name }))],
    metrics: metrics.map((name) => ({ name })),
    orderBys: [{ dimension: { dimensionName: "yearMonth" } }, { metric: { metricName: spec.orderBy }, desc: true }],
    ...(dimensionFilter ? { dimensionFilter } : {}),
  };
}

/* ───────────────────────── parsers ───────────────────────── */

interface GaRow { dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }
interface GaReport { dimensionHeaders?: Array<{ name?: string }>; metricHeaders?: Array<{ name?: string }>; rows?: GaRow[]; rowCount?: number }

const num = (v: string | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const add = (a: number | null, b: number | null): number | null => (b == null ? a : (a ?? 0) + b);
const whole = (n: number | null): number | null => (n == null ? null : Math.round(n));

function metricIndex(r: GaReport) {
  const names = (r.metricHeaders ?? []).map((h) => String(h.name ?? ""));
  const at = (n: string) => names.indexOf(n);
  return {
    sessions: at("sessions"), engaged: at("engagedSessions"), duration: at("userEngagementDuration"), users: at("totalUsers"),
    keyEvents: at("keyEvents") >= 0 ? at("keyEvents") : at("conversions"), events: at("eventCount"),
  };
}

export interface DailyParsed { byDay: Map<string, Omit<DailyRowOut, "day">>; present: { sessions: boolean; engaged: boolean; duration: boolean; users: boolean; keyEvents: boolean } }

/** The daily report to a map by day. A metric the report did not carry is absent, not zero. */
export function parseDaily(report: unknown): DailyParsed {
  const r = (report ?? {}) as GaReport;
  const ix = metricIndex(r);
  const byDay = new Map<string, Omit<DailyRowOut, "day">>();
  for (const row of r.rows ?? []) {
    const day = dayFromGa4Date(row.dimensionValues?.[0]?.value);
    if (!day) continue;
    const mv = row.metricValues ?? [];
    const get = (i: number) => (i >= 0 ? num(mv[i]?.value) : null);
    const cur = byDay.get(day) ?? { sessions: null, engagedSessions: null, engagementSeconds: null, users: null, keyEvents: null };
    cur.sessions = add(cur.sessions, whole(get(ix.sessions)));
    cur.engagedSessions = add(cur.engagedSessions, whole(get(ix.engaged)));
    cur.engagementSeconds = add(cur.engagementSeconds, get(ix.duration));
    cur.users = add(cur.users, whole(get(ix.users)));
    cur.keyEvents = add(cur.keyEvents, get(ix.keyEvents));
    byDay.set(day, cur);
  }
  return { byDay, present: { sessions: ix.sessions >= 0, engaged: ix.engaged >= 0, duration: ix.duration >= 0, users: ix.users >= 0, keyEvents: ix.keyEvents >= 0 } };
}

/**
 * Daily rows for the span from the first day with traffic to `end`. GA4 sends no
 * row for a day with no sessions, so a missing day INSIDE the span is an explicit
 * zero; a metric the report did not carry stays null. Nothing outside the span is
 * written: the dashboard reads a day outside it as unread. Null where the report
 * had no traffic at all.
 */
export function dailyRows(parsed: DailyParsed, end: string): { rows: DailyRowOut[]; firstDay: string; lastDay: string } | null {
  const days = Array.from(parsed.byDay.keys()).filter((d) => d <= end).sort();
  if (!days.length) return null;
  const firstDay = days[0]!;
  const p = parsed.present;
  const rows: DailyRowOut[] = daysBetween(firstDay, end).map((day) => {
    const hit = parsed.byDay.get(day);
    if (hit) return { day, ...hit };
    return {
      day,
      sessions: p.sessions ? 0 : null, engagedSessions: p.engaged ? 0 : null, engagementSeconds: p.duration ? 0 : null,
      users: p.users ? 0 : null, keyEvents: p.keyEvents ? 0 : null,
    };
  });
  return { rows, firstDay, lastDay: end };
}

const keyText = (v: string | undefined, max = 300): string => {
  const t = String(v ?? "").trim();
  return (t === "" ? "(not set)" : t).slice(0, max);
};

/** One report's rows to one row per (month, parent, key). Several spellings of one path are summed. */
export function parseReport(report: unknown, spec: KindSpec, validMonths: ReadonlySet<string>): ReportRowOut[] {
  const r = (report ?? {}) as GaReport;
  const ix = metricIndex(r);
  const isEvents = spec.kind === "form_page" || spec.kind === "group_form";
  const by = new Map<string, ReportRowOut>();
  for (const row of r.rows ?? []) {
    const dv = row.dimensionValues ?? [];
    const month = monthFromYearMonth(dv[0]?.value);
    if (!month || !validMonths.has(month)) continue;
    let parent = spec.parent;
    let key: string;
    if (spec.kind === "region") {
      parent = keyText(dv[1]?.value, 120);
      key = keyText(dv[2]?.value, 160);
    } else if (spec.kind === "source_medium") {
      key = keyText(dv[1]?.value, 160);
    } else {
      const raw = String(dv[1]?.value ?? "");
      if (!isRealPath(raw)) continue;
      key = normPath(raw).slice(0, 300);
    }
    const mv = row.metricValues ?? [];
    const get = (i: number) => (i >= 0 ? num(mv[i]?.value) : null);
    const id = `${month}\u0000${parent}\u0000${key}`;
    const cur = by.get(id) ?? { month, kind: spec.kind, parent, key, sessions: null, engagedSessions: null, engagementSeconds: null, events: null };
    if (isEvents) cur.events = add(cur.events, whole(get(ix.events)));
    else {
      cur.sessions = add(cur.sessions, whole(get(ix.sessions)));
      cur.engagedSessions = add(cur.engagedSessions, whole(get(ix.engaged)));
      cur.engagementSeconds = add(cur.engagementSeconds, get(ix.duration));
    }
    by.set(id, cur);
  }
  return Array.from(by.values());
}

/** The busiest `n` rows of each month (and each parent, for groups), ties by key. Says whether anything was cut. */
export function topPerMonth(rows: readonly ReportRowOut[], kind: ReportKind, n: number = TOP_N[kind]): { kept: ReportRowOut[]; cut: boolean } {
  const value = (r: ReportRowOut) => (r.events ?? r.sessions ?? 0);
  const groups = new Map<string, ReportRowOut[]>();
  for (const r of rows) {
    // A region list is per month; a group list is per month and group.
    const g = kind === "group_page" || kind === "group_form" ? `${r.month}\u0000${r.parent}` : r.month;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(r);
  }
  const kept: ReportRowOut[] = [];
  let cut = false;
  for (const list of groups.values()) {
    list.sort((a, b) => value(b) - value(a) || a.key.localeCompare(b.key) || a.parent.localeCompare(b.parent));
    if (list.length > n) cut = true;
    kept.push(...list.slice(0, n));
  }
  return { kept, cut };
}

/* ───────────────────────── readers ───────────────────────── */

export interface Io {
  fetch: FetchLike;
  token: string;
  property: string;
  /** Wait between calls and before a retry. Zero or a no-op in the guard. */
  sleep: (ms: number) => Promise<void>;
  pauseMs: number;
  /** Calls made so far, so the first one is not delayed. */
  calls: number;
}

/** A 429 or 5xx, or a connection that dropped, is worth trying again. Anything else is not. */
export const isRetryable = (e: unknown): boolean => (e instanceof HttpError ? e.status === 429 || e.status >= 500 : true);

export async function post(io: Io, body: unknown, what: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    if (io.calls++ > 0 && io.pauseMs > 0) await io.sleep(io.pauseMs);
    try {
      return await postJson(io.fetch, reportUrl(io.property), { Authorization: `Bearer ${io.token}` }, body, what);
    } catch (e) {
      if (!isRetryable(e) || attempt >= RETRY_WAITS_MS.length) throw e;
      await io.sleep(RETRY_WAITS_MS[attempt]!);
    }
  }
}

export interface Paged { report: GaReport; truncated: boolean; rowCount: number }

/** Every row of one report, paged with `offset`, up to ROW_CEILING. Past it the report is flagged, not cut quietly. */
export async function postAll(io: Io, body: Record<string, unknown>, what: string): Promise<Paged> {
  const rows: GaRow[] = [];
  let first: GaReport | null = null;
  let rowCount = 0;
  for (;;) {
    // The offset follows the rows actually received, so a property that gives fewer
    // rows a page than asked for is still read to the end.
    const page = (await post(io, { ...body, limit: PAGE_SIZE, offset: rows.length }, what)) as GaReport;
    first ??= page;
    if (rows.length === 0) rowCount = Number(page.rowCount ?? 0) || 0;
    const got = page.rows ?? [];
    rows.push(...got);
    const total = Math.max(rowCount, rows.length);
    if (got.length === 0 || rows.length >= total) return { report: { ...first, rows }, truncated: false, rowCount: total };
    if (rows.length >= ROW_CEILING) return { report: { ...first, rows }, truncated: true, rowCount: total };
  }
}

/** Tries each rung of a metric ladder. Only a 400 moves to the next; the last error is thrown. */
async function ladder<T>(rungs: ReadonlyArray<readonly string[]>, run: (metrics: readonly string[]) => Promise<T>): Promise<T> {
  let last: unknown = null;
  for (const metrics of rungs) {
    try { return await run(metrics); }
    catch (e) {
      last = e;
      if (!(e instanceof HttpError) || e.status !== 400) throw e;
    }
  }
  throw last;
}

export interface DailyRead { rows: DailyRowOut[]; firstDay: string; lastDay: string }
export type DailyResult = { kind: "rows"; read: DailyRead } | { kind: "empty" } | { kind: "too_big" };

export async function readDaily(io: Io, w: ReadWindow, countries: readonly string[]): Promise<DailyResult> {
  const paged = await ladder(DAILY_METRIC_LADDER, (metrics) => postAll(io, dailyRequest(w, metrics, countries), "GA4 runReport (daily totals)"));
  if (paged.truncated) return { kind: "too_big" };
  const rows = dailyRows(parseDaily(paged.report), w.end);
  return rows ? { kind: "rows", read: rows } : { kind: "empty" };
}

export interface KindRead { rows: ReportRowOut[]; cut: boolean; tooBig: boolean }

/** One kind (every group of it, for the group kinds). Any group that cannot be read fails the whole kind. */
export async function readKind(io: Io, w: ReadWindow, specs: readonly KindSpec[], countries: readonly string[], months: ReadonlySet<string>): Promise<KindRead> {
  const all: ReportRowOut[] = [];
  for (const spec of specs) {
    const paged = await ladder(spec.ladder, (metrics) => postAll(io, reportRequest(w, spec, metrics, countries), `GA4 runReport (${spec.kind})`));
    if (paged.truncated) return { rows: [], cut: false, tooBig: true };
    all.push(...parseReport(paged.report, spec, months));
  }
  const kind = specs[0]!.kind;
  const { kept, cut } = topPerMonth(all, kind);
  return { rows: kept, cut, tooBig: false };
}

/**
 * Google Analytics 4, by page: sessions, engagement and key events per landing
 * page and device, and the site's own events per page. Pure builders and parsers
 * plus two small runners that take a fetch, so the guard drives them with no
 * network.
 *
 * NONE OF THE REQUEST SHAPES BELOW HAS BEEN RUN AGAINST A LIVE PROPERTY. They are
 * written from the Data API's documentation. Where two readings of the
 * documentation are plausible the code tries the likelier one and falls back, and
 * the run records what it fell back to. `docs/SEO-PAGE-BEHAVIOUR.md` lists every
 * one of them as unverified.
 *
 * A figure GA4 did not return is null. A metric the property rejected is a column
 * of nulls, never a column of noughts.
 */
import { HttpError, postJson } from "./http.js";
import { addDays, isRealPath } from "./paths.js";
import { normPath } from "./paths.js";
import { PAGE_CAP, GA4_LAG_DAYS, WINDOW_DAYS, type BehaviourRowOut, type EventRowOut, type FetchLike, type Period, type Window, type Windows } from "./types.js";
import { PACK_EVENT_NAMES, SECTION_DIMENSION } from "./pack.js";

export const GA4_BASE = "https://analyticsdata.googleapis.com/v1beta";

/** The last 28 complete days and the 28 before them. `end` is today minus the lag. */
export function windowsFor(today: string, lagDays: number): Windows {
  const end = addDays(today, -lagDays);
  const curStart = addDays(end, -(WINDOW_DAYS - 1));
  return {
    current: { start: curStart, end },
    prior: { start: addDays(curStart, -WINDOW_DAYS), end: addDays(curStart, -1) },
  };
}
export const ga4Windows = (today: string): Windows => windowsFor(today, GA4_LAG_DAYS);

/** Most complete first. Dropped metrics become nulls. */
export const PAGE_METRIC_LADDER: ReadonlyArray<readonly string[]> = [
  ["sessions", "engagedSessions", "userEngagementDuration", "keyEvents"],
  ["sessions", "engagedSessions", "userEngagementDuration", "conversions"],
  ["sessions", "engagedSessions", "keyEvents"],
  ["sessions", "engagedSessions", "conversions"],
  ["sessions", "engagedSessions"],
];

export function pagesRequest(w: Window, metrics: readonly string[]) {
  return {
    dateRanges: [{ startDate: w.start, endDate: w.end }],
    dimensions: [{ name: "landingPage" }, { name: "deviceCategory" }],
    metrics: metrics.map((name) => ({ name })),
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 50000,
  };
}

export function eventsRequest(w: Window, withSection: boolean) {
  return {
    dateRanges: [{ startDate: w.start, endDate: w.end }],
    dimensions: [{ name: "pagePath" }, { name: "eventName" }, { name: "deviceCategory" }, ...(withSection ? [{ name: SECTION_DIMENSION }] : [])],
    metrics: [{ name: "eventCount" }],
    dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: [...PACK_EVENT_NAMES] } } },
    limit: 100000,
  };
}

interface GaRow { dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }
interface GaReport { dimensionHeaders?: Array<{ name?: string }>; metricHeaders?: Array<{ name?: string }>; rows?: GaRow[]; rowCount?: number }

const num = (v: string | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface PageAgg {
  path: string;
  device: string;
  sessions: number | null;
  engagedSessions: number | null;
  engagementSeconds: number | null;
  keyEvents: number | null;
}

/** One report to per-(path, device) aggregates. Several landing-page spellings of one path are summed. */
export function parsePages(report: unknown): PageAgg[] {
  const r = (report ?? {}) as GaReport;
  const names = (r.metricHeaders ?? []).map((h) => String(h.name ?? ""));
  const idx = (n: string) => names.indexOf(n);
  const iS = idx("sessions"), iE = idx("engagedSessions"), iD = idx("userEngagementDuration");
  const iK = idx("keyEvents") >= 0 ? idx("keyEvents") : idx("conversions");
  const by = new Map<string, PageAgg>();
  for (const row of r.rows ?? []) {
    const rawPage = String(row.dimensionValues?.[0]?.value ?? "");
    if (!isRealPath(rawPage)) continue;
    const path = normPath(rawPage);
    const device = String(row.dimensionValues?.[1]?.value ?? "").toLowerCase() || "unknown";
    const mv = row.metricValues ?? [];
    const get = (i: number) => (i >= 0 ? num(mv[i]?.value) : null);
    const key = `${path}\u0000${device}`;
    const cur = by.get(key) ?? { path, device, sessions: null, engagedSessions: null, engagementSeconds: null, keyEvents: null };
    const add = (a: number | null, b: number | null) => (b == null ? a : (a ?? 0) + b);
    cur.sessions = add(cur.sessions, get(iS));
    cur.engagedSessions = add(cur.engagedSessions, get(iE));
    cur.engagementSeconds = add(cur.engagementSeconds, get(iD));
    cur.keyEvents = add(cur.keyEvents, get(iK));
    by.set(key, cur);
  }
  return Array.from(by.values());
}

export interface EventAgg { path: string; device: string; event: string; section: string; count: number }

/** `(not set)` is GA4's word for "no value", so an event with no section reads as "". */
export function cleanSection(v: string | undefined): string {
  const s = String(v ?? "").trim();
  if (!s || /^\(.*\)$/.test(s)) return "";
  return s.slice(0, 60);
}

export function parseEvents(report: unknown, withSection: boolean): EventAgg[] {
  const r = (report ?? {}) as GaReport;
  const by = new Map<string, EventAgg>();
  for (const row of r.rows ?? []) {
    const rawPage = String(row.dimensionValues?.[0]?.value ?? "");
    if (!isRealPath(rawPage)) continue;
    const event = String(row.dimensionValues?.[1]?.value ?? "");
    if (!PACK_EVENT_NAMES.includes(event)) continue;
    const device = String(row.dimensionValues?.[2]?.value ?? "").toLowerCase() || "unknown";
    const section = withSection ? cleanSection(row.dimensionValues?.[3]?.value) : "";
    const n = num(row.metricValues?.[0]?.value);
    if (n == null) continue;
    const path = normPath(rawPage);
    const key = `${path}\u0000${device}\u0000${event}\u0000${section}`;
    const cur = by.get(key) ?? { path, device, event, section, count: 0 };
    cur.count += n;
    by.set(key, cur);
  }
  return Array.from(by.values());
}

/* ───────────────────────── runners ───────────────────────── */

const reportUrl = (property: string) => `${GA4_BASE}/properties/${property}:runReport`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export interface PagesResult {
  rows: BehaviourRowOut[];
  /** Pages with traffic in the current window, before the cap. */
  totalFound: number;
  capped: boolean;
  /** The metrics the property answered, so the run can say what it fell back to. */
  metrics: readonly string[];
  /** The kept paths, for the events read and the field-data reads. */
  keep: string[];
  /** Kept paths by current-window visits, busiest first. */
  ranked: Array<{ path: string; sessions: number }>;
}

export async function readGa4Pages(f: FetchLike, token: string, property: string, w: Windows, cap = PAGE_CAP): Promise<PagesResult> {
  let used: readonly string[] | null = null;
  let current: PageAgg[] = [];
  let lastErr: unknown = null;
  for (const metrics of PAGE_METRIC_LADDER) {
    try {
      current = parsePages(await postJson(f, reportUrl(property), auth(token), pagesRequest(w.current, metrics), "GA4 runReport (pages)"));
      used = metrics;
      break;
    } catch (e) {
      lastErr = e;
      // Only an invalid-argument answer is a reason to ask for fewer metrics.
      if (!(e instanceof HttpError) || e.status !== 400) throw e;
    }
  }
  if (!used) throw lastErr;
  const prior = parsePages(await postJson(f, reportUrl(property), auth(token), pagesRequest(w.prior, used), "GA4 runReport (pages, earlier)"));

  const totals = new Map<string, number>();
  for (const r of current) totals.set(r.path, (totals.get(r.path) ?? 0) + (r.sessions ?? 0));
  const ranked = Array.from(totals.entries()).map(([path, sessions]) => ({ path, sessions })).sort((a, b) => b.sessions - a.sessions || a.path.localeCompare(b.path));
  const kept = ranked.slice(0, cap);
  const keep = new Set(kept.map((k) => k.path));
  const out: BehaviourRowOut[] = [];
  for (const [period, list, win] of [["current", current, w.current], ["prior", prior, w.prior]] as const) {
    for (const r of list) {
      if (!keep.has(r.path)) continue;
      out.push({
        source: "ga4", pagePath: r.path, device: r.device, period: period as Period, windowStart: win.start, windowEnd: win.end,
        sessions: r.sessions == null ? null : Math.round(r.sessions),
        engagedSessions: r.engagedSessions == null ? null : Math.round(r.engagedSessions),
        engagementSeconds: r.engagementSeconds, keyEvents: r.keyEvents,
        clicks: null, impressions: null, topQueriesJson: null,
      });
    }
  }
  return { rows: out, totalFound: ranked.length, capped: ranked.length > cap, metrics: used, keep: kept.map((k) => k.path), ranked: kept };
}

export interface EventsResult { rows: EventRowOut[]; sectionsReadable: boolean }

export async function readGa4Events(f: FetchLike, token: string, property: string, w: Windows, keep: ReadonlySet<string> | null, cap = PAGE_CAP): Promise<EventsResult> {
  let withSection = true;
  let cur: EventAgg[];
  const ask = async (win: Window, sec: boolean) => parseEvents(await postJson(f, reportUrl(property), auth(token), eventsRequest(win, sec), "GA4 runReport (events)"), sec);
  try {
    cur = await ask(w.current, true);
  } catch (e) {
    // The section label is only readable once it is registered as an event-scoped custom dimension.
    if (!(e instanceof HttpError) || e.status !== 400) throw e;
    withSection = false;
    cur = await ask(w.current, false);
  }
  const prior = await ask(w.prior, withSection);
  let allow = keep;
  if (!allow) {
    const views = new Map<string, number>();
    for (const r of cur) if (r.event === "page_view") views.set(r.path, (views.get(r.path) ?? 0) + r.count);
    allow = new Set(Array.from(views.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, cap).map(([p]) => p));
  }
  const out: EventRowOut[] = [];
  for (const [period, list, win] of [["current", cur, w.current], ["prior", prior, w.prior]] as const) {
    for (const r of list) {
      if (!allow.has(r.path)) continue;
      out.push({ pagePath: r.path, device: r.device, eventName: r.event, section: r.section, period: period as Period, windowStart: win.start, windowEnd: win.end, eventCount: Math.round(r.count) });
    }
  }
  return { rows: out, sectionsReadable: withSection };
}

/**
 * The form funnel. form_start and form_submit by page group, step changes by week,
 * and the figure that is left once homepage and directory searches are taken out.
 *
 * A form submit event is NOT an enquiry. Nothing here calls it one. It fires on the
 * homepage advisor search and on the directory as well as on real request forms, and
 * it counts repeats. The page groups below are our classification of the page the
 * event fired on.
 */
import { and, eq, inList, type Filter } from "./filters.js";
import { keyed, type Reader } from "./ga4.js";
import { classifyPath, type AuditConfig } from "./classify.js";
import { column, change, ratio, table, type Table } from "./metrics.js";
import { label, periodsFor, type Window } from "./periods.js";

export interface FunnelGroup { group: string; start: [number | null, number | null, number | null]; submit: [number | null, number | null, number | null] }

export interface Funnel {
  groups: FunnelGroup[];
  /** Submit events in each period: all, and without homepage and directory. */
  submitAll: [number | null, number | null, number | null];
  submitRequestLike: [number | null, number | null, number | null];
  searchSubmits: [number | null, number | null, number | null];
  tables: { byGroup: Table; excludingSearches: Table };
  byChannel: Table;
  organic: Table;
}

const trio = (): [number | null, number | null, number | null] => [null, null, null];
const bump = (a: [number | null, number | null, number | null], i: number, v: number | null | undefined) => { if (v != null) a[i] = (a[i] ?? 0) + v; };

export async function readFunnel(read: Reader, w: Window, cfg: AuditConfig, formEvent: string, startEvent: string, headline: Filter | undefined, countriesOnly: Filter | undefined): Promise<Funnel> {
  const p = periodsFor(w);
  const ranges = [p.current, p.prior, p.priorYear];
  const ev = await read({ dims: ["pagePath", "eventName"], metrics: ["eventCount"], ranges, filter: and(inList("eventName", [formEvent, startEvent]), headline) ?? null, orderBy: "eventCount" });
  const groups = new Map<string, FunnelGroup>();
  const submitAll = trio(), reqLike = trio();
  for (const r of ev.rows) {
    const path = r.dims[0] ?? "";
    const name = r.dims[1] ?? "";
    const c = classifyPath(path, cfg);
    const g = groups.get(c.group) ?? { group: c.group, start: trio(), submit: trio() };
    groups.set(c.group, g);
    if (name === formEvent) {
      bump(g.submit, r.range, r.m.eventCount);
      bump(submitAll, r.range, r.m.eventCount);
      if (c.kind !== "homepage" && c.kind !== "directory") bump(reqLike, r.range, r.m.eventCount);
    } else if (name === startEvent) bump(g.start, r.range, r.m.eventCount);
  }
  // Searches: submit events whose address carries destination=.
  const search = await read({ dims: ["pagePathPlusQueryString"], metrics: ["eventCount"], ranges, filter: and(eq("eventName", formEvent), { filter: { fieldName: "pagePathPlusQueryString", stringFilter: { matchType: "CONTAINS", value: "destination=" } } }, headline) ?? null });
  const searchSubmits = trio();
  for (const r of search.rows) bump(searchSubmits, r.range, r.m.eventCount);

  const rng = `${label(p.current)} against ${label(p.prior)} and ${label(p.priorYear)}`;
  const list = [...groups.values()].sort((a, b) => (b.submit[0] ?? 0) - (a.submit[0] ?? 0));
  const filt = `form event "${formEvent}" and start event "${startEvent}"; page group is our classification of the page the event fired on; headline rule applied`;
  const byGroup = table({
    id: "funnel-by-group", title: "Form starts and submit events by page group", range: rng, filter: filt,
    columns: [column("group", "Page group", "inference", "text"), column("start", "Starts", "confirmed from data"), column("submit", "Submit events", "confirmed from data"), column("per", "Submit events per start", "confirmed from data", "ratio"), column("prior", "Submit events, period before", "confirmed from data"), column("chg", "Change", "confirmed from data", "percent"), column("yr", "Submit events, year earlier", "confirmed from data")],
    rows: list.map((g) => ({ group: g.group, start: g.start[0], submit: g.submit[0], per: ratio(g.submit[0], g.start[0]), prior: g.submit[1], chg: change(g.submit[0], g.submit[1]), yr: g.submit[2] })),
    note: "A start without a matching submit is a form someone began and did not send. Several submit events can come from one person.",
  });
  const excl = table({
    id: "funnel-excluding-searches", title: "Submit events with homepage and directory searches taken out", range: rng, filter: `form event "${formEvent}"; headline rule applied`,
    columns: [column("what", "Figure", "confirmed from data", "text"), column("now", "Chosen window", "confirmed from data"), column("prior", "Period before", "confirmed from data"), column("chg", "Change", "confirmed from data", "percent"), column("yr", "Year earlier", "confirmed from data"), column("chgYr", "Change on year", "confirmed from data", "percent")],
    rows: [
      { what: "All submit events", now: submitAll[0], prior: submitAll[1], chg: change(submitAll[0], submitAll[1]), yr: submitAll[2], chgYr: change(submitAll[0], submitAll[2]) },
      { what: "Submit events on pages that are not the homepage or the directory", now: reqLike[0], prior: reqLike[1], chg: change(reqLike[0], reqLike[1]), yr: reqLike[2], chgYr: change(reqLike[0], reqLike[2]) },
      { what: "Submit events whose address carries destination= (directory or homepage searches)", now: searchSubmits[0], prior: searchSubmits[1], chg: change(searchSubmits[0], searchSubmits[1]), yr: searchSubmits[2], chgYr: change(searchSubmits[0], searchSubmits[2]) },
    ],
    note: "None of these is a count of enquiries. They are firings of one event. The second row still includes repeats.",
  });
  const ch = await read({ dims: ["sessionDefaultChannelGroup"], metrics: ["eventCount"], ranges, filter: and(eq("eventName", formEvent), countriesOnly) ?? null, orderBy: "eventCount" });
  const sess = await read({ dims: ["sessionDefaultChannelGroup"], metrics: ["sessions"], ranges, filter: countriesOnly ?? null, orderBy: "sessions" });
  const [fc, fp] = keyed(ch.rows, (d) => d[0] ?? "", 3);
  const [sc] = keyed(sess.rows, (d) => d[0] ?? "", 3);
  let totalF = 0, totalS = 0;
  for (const v of fc.values()) totalF += v.eventCount ?? 0;
  for (const v of sc.values()) totalS += v.sessions ?? 0;
  const byChannel = table({
    id: "funnel-by-channel", title: "Form submit events by channel", range: label(p.current), filter: `form event "${formEvent}"; only the country rule applied, so no channel is hidden`,
    columns: [column("channel", "Channel", "confirmed from data", "text"), column("submits", "Submit events", "confirmed from data"), column("shareF", "Share of submit events", "confirmed from data", "percent"), column("shareS", "Share of sessions", "confirmed from data", "percent"), column("prior", "Submit events, period before", "confirmed from data"), column("hint", "Reading", "inference", "text")],
    rows: [...fc.entries()].sort((a, b) => (b[1].eventCount ?? 0) - (a[1].eventCount ?? 0)).map(([k, v]) => {
      const shareF = ratio(v.eventCount, totalF), shareS = ratio(sc.get(k)?.sessions, totalS);
      const high = shareF != null && shareS != null && shareF - shareS >= 0.15;
      return { channel: k, submits: v.eventCount, shareF, shareS, prior: fp.get(k)?.eventCount ?? null, hint: high ? "Its share of submit events is 15 points above its share of visits. A place to look. It is not a count of robots." : "" };
    }),
  });
  const org = await read({ dims: ["pagePath"], metrics: ["eventCount"], ranges, filter: and(eq("sessionDefaultChannelGroup", "Organic Search"), eq("eventName", formEvent), countriesOnly) ?? null });
  const oAll = trio(), oReq = trio();
  for (const r of org.rows) { bump(oAll, r.range, r.m.eventCount); const k = classifyPath(r.dims[0] ?? "", cfg).kind; if (k !== "homepage" && k !== "directory") bump(oReq, r.range, r.m.eventCount); }
  const organic = table({
    id: "funnel-organic", title: "Organic Search: submit events, with and without homepage and directory searches", range: rng, filter: `channel Organic Search only; form event "${formEvent}"; only the country rule applied`,
    columns: [column("what", "Figure", "confirmed from data", "text"), column("now", "Chosen window", "confirmed from data"), column("prior", "Period before", "confirmed from data"), column("chg", "Change", "confirmed from data", "percent"), column("yr", "Year earlier", "confirmed from data")],
    rows: [
      { what: "All Organic Search submit events", now: oAll[0], prior: oAll[1], chg: change(oAll[0], oAll[1]), yr: oAll[2] },
      { what: "Without homepage and directory pages", now: oReq[0], prior: oReq[1], chg: change(oReq[0], oReq[1]), yr: oReq[2] },
    ],
    note: "If the first row fell and the second held, the fall was in homepage or directory searches. If both fell, it was not.",
  });
  return { organic, groups: list, submitAll, submitRequestLike: reqLike, searchSubmits, tables: { byGroup, excludingSearches: excl }, byChannel };
}

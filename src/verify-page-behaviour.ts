#!/usr/bin/env tsx
/**
 * Guard for the page-behaviour reader: what it asks Google and Clarity for, what it
 * keeps, and what it refuses to turn into a number.
 *
 * No network, no database, no token. A pretend Google answers the real builders,
 * the real parsers and the real orchestration end to end, and a recording client
 * stands in for Postgres so the real INSERTs are read as text and as parameters.
 *
 * EVERY CLIENT, PAGE, PROPERTY, KEY AND FIGURE BELOW IS INVENTED.
 *
 * WHAT THIS CANNOT PROVE. The request and response shapes are written from the
 * published documentation and have not been run against a live property, a live
 * Search Console site, the live Chrome UX Report or a live Clarity project. A green
 * run here means the code does what it says against the shapes it expects, not that
 * Google answers in them. docs/SEO-PAGE-BEHAVIOUR.md lists each one as unverified.
 *
 *   npx tsx src/verify-page-behaviour.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { normPath, siteOrigin, addDays, isRealPath } from "./page-behaviour/paths.js";
import { ga4Windows, parsePages, parseEvents, pagesRequest, eventsRequest, PAGE_METRIC_LADDER, readGa4Pages, readGa4Events, cleanSection, windowsFor } from "./page-behaviour/ga4.js";
import { gscRequest, parsePageDevice, parsePageQuery, readGscPages, gscWindows, GSC_ROW_LIMIT } from "./page-behaviour/gsc.js";
import { parseCrux, readCrux, vitalRow, parsePsi, psiRow, psiUrl, cruxRequest, isCruxNoData } from "./page-behaviour/vitals.js";
import { parseClarity, parseTokens, clarityUrlFor, recentlyRead, SKIP_WITHIN_MS, CLARITY_ROW_LIMIT } from "./page-behaviour/clarity.js";
import { HttpError, safeMessage } from "./page-behaviour/http.js";
import { readClientBehaviour, type ClientCtx, type Deps } from "./page-behaviour/run.js";
import { INSERT_BEHAVIOUR, INSERT_EVENTS, INSERT_VITALS, INSERT_CLARITY, INSERT_RUN, writeBehaviour, writeEvents, writeVitals, writeClarity, writeRun, type Queryable } from "./page-behaviour/store.js";
import { PACK_EVENT_NAMES, SECTION_DIMENSION } from "./page-behaviour/pack.js";
import { PAGE_CAP, WINDOW_DAYS, GA4_LAG_DAYS, GSC_LAG_DAYS, CRUX_PAGES, PSI_PAGES, TOP_QUERIES, UX_SOURCES, RUN_STATUSES, type FetchLike } from "./page-behaviour/types.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);

/** A check that reads text with a pattern proves nothing until the pattern is shown to catch a bad sample. */
function selfTest(label: string, test: (text: string) => boolean, good: string, bad: string) {
  ok(`${label} (self-test: passes a good sample)`, test(good) === true);
  ok(`${label} (self-test: fails a planted bad sample)`, test(bad) === false);
}

/* ───────────────────────── a pretend Google ───────────────────────── */

type Reply = { status?: number; body: unknown } | ((url: string, body: string) => { status?: number; body: unknown });
function pretend(routes: Array<[RegExp, Reply]>): { fetch: FetchLike; calls: Array<{ url: string; method: string; body: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; method: string; body: string; headers: Record<string, string> }> = [];
  const f: FetchLike = async (url, init) => {
    const body = init?.body ?? "";
    calls.push({ url, method: init?.method ?? "GET", body, headers: init?.headers ?? {} });
    for (const [re, reply] of routes) {
      if (!re.test(url + " " + body)) continue;
      const r = typeof reply === "function" ? reply(url, body) : reply;
      const status = r.status ?? 200;
      return { ok: status >= 200 && status < 300, status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
    }
    return { ok: false, status: 599, text: async () => "no route" };
  };
  return { fetch: f, calls };
}

const TODAY = "2026-10-14";

/* ═════════════════════════ 1. addresses ═════════════════════════ */
hr("1. every source's address is brought to one path");
{
  const cases: Array<[string, string]> = [
    ["https://www.example.test/services/?utm=1#top", "/services"], ["/services/", "/services"], ["services", "/services"], ["", "/"],
    ["https://example.test", "/"], ["/a//b///c/", "/a/b/c"], ["*", "*"], ["HTTPS://EXAMPLE.TEST/Contact?x=1", "/Contact"],
  ];
  for (const [i, o] of cases) ok(`normPath(${JSON.stringify(i)}) = ${o}`, normPath(i) === o, normPath(i));
  ok("normPath is idempotent over every case", cases.every(([, o]) => normPath(o) === o));
  ok("(not set) is not a page", !isRealPath("(not set)") && !isRealPath("") && isRealPath("/x"));
  ok("an origin comes from a page we actually reached before a typed domain", siteOrigin("example.test", ["https://www.example.test/about"]) === "https://www.example.test");
  ok("a typed domain with no scheme gets https", siteOrigin("Example.test/") === "https://example.test");
  ok("no domain and no page is no origin", siteOrigin(null, []) === null && siteOrigin("  ", []) === null);
}

/* ═════════════════════════ 2. windows ═════════════════════════ */
hr("2. two windows of 28 complete days, the later one ending before the lag");
{
  const w = ga4Windows(TODAY);
  ok(`current ends ${GA4_LAG_DAYS} days before today`, w.current.end === addDays(TODAY, -GA4_LAG_DAYS), w.current.end);
  const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;
  ok(`current is ${WINDOW_DAYS} days`, days(w.current.start, w.current.end) === WINDOW_DAYS);
  ok(`prior is ${WINDOW_DAYS} days and ends the day before current starts`, days(w.prior.start, w.prior.end) === WINDOW_DAYS && addDays(w.prior.end, 1) === w.current.start);
  ok(`Search Console ends ${GSC_LAG_DAYS} days before today`, gscWindows(TODAY).current.end === addDays(TODAY, -GSC_LAG_DAYS));
  ok("a window never includes today", w.current.end < TODAY && windowsFor(TODAY, 1).current.end < TODAY);
}

/* ═════════════════════════ 3. analytics, by page ═════════════════════════ */
hr("3. analytics by page: the request, the parse, the ladder, the cap");
const gaReport = (rows: Array<[string, string, ...number[]]>, metrics = ["sessions", "engagedSessions", "userEngagementDuration", "keyEvents"]) => ({
  dimensionHeaders: [{ name: "landingPage" }, { name: "deviceCategory" }], metricHeaders: metrics.map((name) => ({ name })),
  rows: rows.map(([p, d, ...m]) => ({ dimensionValues: [{ value: p }, { value: d }], metricValues: m.map((v) => ({ value: String(v) })) })),
});
{
  const req = pagesRequest({ start: "2026-09-17", end: "2026-10-12" }, PAGE_METRIC_LADDER[0]!);
  ok("asks for landing page and device", req.dimensions.map((d) => d.name).join(",") === "landingPage,deviceCategory");
  ok("asks for sessions, engaged sessions, engagement time and key events", req.metrics.map((m) => m.name).join(",") === "sessions,engagedSessions,userEngagementDuration,keyEvents");
  ok("the ladder ends at sessions and engaged sessions only", PAGE_METRIC_LADDER[PAGE_METRIC_LADDER.length - 1]!.join(",") === "sessions,engagedSessions");
  ok("the ladder never asks for fewer than sessions and engaged sessions", PAGE_METRIC_LADDER.every((m) => m[0] === "sessions" && m[1] === "engagedSessions"));

  const parsed = parsePages(gaReport([["/services/", "Mobile", 200, 90, 4000, 12], ["/services?x=1", "mobile", 50, 20, 900, 3], ["(not set)", "desktop", 99, 9, 9, 9], ["/", "desktop", 300, 200, 9000, 20]]));
  const m = parsed.find((r) => r.path === "/services" && r.device === "mobile");
  ok("two spellings of one path on one device are summed", m?.sessions === 250 && m?.engagedSessions === 110 && m?.keyEvents === 15);
  ok("device is lower-cased", parsed.every((r) => r.device === r.device.toLowerCase()));
  ok("(not set) is dropped as a page", !parsed.some((r) => r.sessions === 99));
  const noKey = parsePages(gaReport([["/a", "mobile", 10, 5]], ["sessions", "engagedSessions"]));
  ok("a metric the property did not return is NULL and never 0", noKey[0]!.keyEvents === null && noKey[0]!.engagementSeconds === null && noKey[0]!.sessions === 10);
  const conv = parsePages(gaReport([["/a", "mobile", 10, 5, 7]], ["sessions", "engagedSessions", "conversions"]));
  ok("the older name `conversions` fills key events", conv[0]!.keyEvents === 7);
  ok("an empty report is no rows", parsePages({}).length === 0 && parsePages(null).length === 0);
}
{
  // The ladder: reject keyEvents AND conversions; accept the minimal set. Everything else errors out.
  const bodies: string[] = [];
  const g = pretend([[/runReport/, (_u, b) => {
    bodies.push(b);
    const asked = (JSON.parse(b).metrics as Array<{ name: string }>).map((x) => x.name);
    if (asked.includes("keyEvents") || asked.includes("conversions") || asked.includes("userEngagementDuration")) return { status: 400, body: { error: { message: "Incompatible" } } };
    return { body: gaReport([["/a", "mobile", 10, 5]], asked) };
  }]]);
  const r = await readGa4Pages(g.fetch, "T", "123", ga4Windows(TODAY));
  ok("a 400 steps down the ladder until a request is accepted", r.metrics.join(",") === "sessions,engagedSessions", r.metrics.join(","));
  ok("the fallback leaves those columns null", r.rows.every((x) => x.keyEvents === null && x.engagementSeconds === null));
  ok("the earlier window is asked with the metric set that worked", JSON.parse(bodies[bodies.length - 1]!).metrics.length === 2);
  const g500 = pretend([[/runReport/, { status: 500, body: "boom" }]]);
  let threw = false; try { await readGa4Pages(g500.fetch, "T", "123", ga4Windows(TODAY)); } catch (e) { threw = e instanceof HttpError && e.status === 500; }
  ok("a 500 is an error, not a reason to ask for less", threw && g500.calls.length === 1);
  const g403 = pretend([[/runReport/, { status: 403, body: "denied" }]]);
  threw = false; try { await readGa4Pages(g403.fetch, "T", "123", ga4Windows(TODAY)); } catch (e) { threw = e instanceof HttpError && e.status === 403; }
  ok("a 403 is an error too", threw);
}
{
  const many: Array<[string, string, ...number[]]> = [];
  for (let i = 0; i < PAGE_CAP + 30; i++) many.push([`/p${i}`, "mobile", 1000 - i, 400, 1, 1]);
  const g = pretend([[/runReport/, (_u, b) => ({ body: gaReport(JSON.parse(b).dateRanges[0].startDate < ga4Windows(TODAY).current.start ? [["/p0", "mobile", 5, 2, 1, 1], ["/p129", "mobile", 7, 3, 1, 1]] : many) })]]);
  const r = await readGa4Pages(g.fetch, "T", "1", ga4Windows(TODAY));
  ok(`only the ${PAGE_CAP} busiest pages are kept`, r.keep.length === PAGE_CAP && r.keep[0] === "/p0");
  ok("the run knows it was capped and by how much", r.capped && r.totalFound === PAGE_CAP + 30);
  ok("earlier-window rows are kept only for pages that were kept", !r.rows.some((x) => x.period === "prior" && x.pagePath === "/p129") && r.rows.some((x) => x.period === "prior" && x.pagePath === "/p0"));
  ok("each row carries its own window dates", r.rows.every((x) => x.windowStart <= x.windowEnd) && r.rows.some((x) => x.period === "prior" && x.windowEnd < "2026-09-17"));
}

/* ═════════════════════════ 4. the site's own events ═════════════════════════ */
hr("4. events: only the declared pack, the section label only if the property can give it");
const evReport = (rows: Array<[string, string, string, string | null, number]>) => ({
  rows: rows.map(([p, e, d, s, n]) => ({ dimensionValues: [{ value: p }, { value: e }, { value: d }, ...(s === null ? [] : [{ value: s }])], metricValues: [{ value: String(n) }] })),
});
{
  const req = eventsRequest({ start: "2026-09-17", end: "2026-10-12" }, true);
  ok("filters to exactly the pack's event names", JSON.stringify(req.dimensionFilter.filter.inListFilter.values) === JSON.stringify([...PACK_EVENT_NAMES]));
  ok("the section dimension is the custom event dimension", req.dimensions.some((d) => d.name === SECTION_DIMENSION) && SECTION_DIMENSION === "customEvent:section");
  ok("without the section it asks for three dimensions", eventsRequest({ start: "a", end: "b" }, false).dimensions.length === 3);
  const p = parseEvents(evReport([["/a/", "cta_click", "Mobile", "Hero", 5], ["/a", "cta_click", "mobile", "Hero", 2], ["/a", "quote_click", "mobile", "Hero", 99], ["/a", "page_view", "mobile", "(not set)", 40]]), true);
  ok("two spellings of one path sum", p.find((r) => r.event === "cta_click")?.count === 7 && p.find((r) => r.event === "cta_click")?.path === "/a");
  ok("an event outside the pack is ignored", !p.some((r) => r.event === "quote_click"));
  ok("(not set) section is the empty string", p.find((r) => r.event === "page_view")?.section === "");
  ok("a section label is capped", cleanSection("x".repeat(200)).length === 60);
  const noSec = parseEvents(evReport([["/a", "cta_click", "mobile", null, 3]]), false);
  ok("without the section dimension every row has an empty section", noSec[0]!.section === "");
}
{
  const g = pretend([[/runReport/, (_u, b) => {
    const dims = (JSON.parse(b).dimensions as Array<{ name: string }>).map((d) => d.name);
    if (dims.includes(SECTION_DIMENSION)) return { status: 400, body: { error: { message: "Field customEvent:section is not a valid dimension" } } };
    return { body: evReport([["/a", "page_view", "mobile", null, 400], ["/a", "cta_click", "mobile", null, 12]]) };
  }]]);
  const r = await readGa4Events(g.fetch, "T", "1", ga4Windows(TODAY), new Set(["/a"]));
  ok("an unregistered section dimension is retried without it", r.sectionsReadable === false && r.rows.length > 0);
  ok("both windows are asked", g.calls.filter((c) => !JSON.parse(c.body).dimensions.some((d: { name: string }) => d.name === SECTION_DIMENSION)).length === 2);
  const gEv500 = pretend([[/runReport/, { status: 500, body: "boom" }]]);
  let evThrew = false; try { await readGa4Events(gEv500.fetch, "T", "1", ga4Windows(TODAY), new Set(["/a"])); } catch (e) { evThrew = e instanceof HttpError && e.status === 500; }
  ok("a server error on the events read is an error, not a reason to drop the section", evThrew && gEv500.calls.length === 1);
  const g2 = pretend([[/runReport/, { body: evReport([["/a", "page_view", "mobile", "", 400], ["/zzz", "page_view", "mobile", "", 900]]) }]]);
  const r2 = await readGa4Events(g2.fetch, "T", "1", ga4Windows(TODAY), new Set(["/a"]));
  ok("only pages in the kept set are written", r2.rows.every((x) => x.pagePath === "/a") && r2.sectionsReadable);
  const g3 = pretend([[/runReport/, { body: evReport([["/a", "page_view", "mobile", "", 400], ["/b", "page_view", "mobile", "", 900]]) }]]);
  const r3 = await readGa4Events(g3.fetch, "T", "1", ga4Windows(TODAY), null, 1);
  ok("with no kept set, the busiest pages by page views are used and capped", r3.rows.every((x) => x.pagePath === "/b"));
}

/* ═════════════════════════ 5. Search Console ═════════════════════════ */
hr("5. Search Console: clicks per page and device, each page's biggest searches as counts");
{
  const req = gscRequest({ start: "a", end: "b" }, ["page", "device"]);
  ok("asks for final data and the documented row limit", req.dataState === "final" && req.rowLimit === GSC_ROW_LIMIT);
  const pd = parsePageDevice({ rows: [{ keys: ["https://x.test/services/", "MOBILE"], clicks: 10, impressions: 100 }, { keys: ["https://x.test/services", "MOBILE"], clicks: 5, impressions: 40 }, { keys: ["https://x.test/", "DESKTOP"], clicks: 3, impressions: 30 }] });
  ok("spellings of one page sum and the device is lower-cased", pd.rows.find((r) => r.path === "/services")?.clicks === 15 && pd.rows.every((r) => r.device === r.device.toLowerCase()));
  const q = parsePageQuery({ rows: Array.from({ length: 9 }, (_, i) => ({ keys: ["https://x.test/services", `term ${i}`], clicks: i, impressions: 10 + i })) });
  ok(`only the ${TOP_QUERIES} biggest searches are kept, biggest first`, q.get("/services")!.length === TOP_QUERIES && q.get("/services")![0]!.query === "term 8");
  ok("a search is stored as a query and two counts and nothing else", q.get("/services")!.every((t) => Object.keys(t).sort().join(",") === "clicks,impressions,query"));
  const full = parsePageDevice({ rows: Array.from({ length: GSC_ROW_LIMIT }, (_, i) => ({ keys: [`https://x.test/p${i}`, "MOBILE"], clicks: 1, impressions: 1 })) });
  ok("an answer at the row limit says it may be cut short", full.full === true && parsePageDevice({ rows: [] }).full === false);
  const g = pretend([[/searchAnalytics\/query/, (_u, b) => {
    const dims = JSON.parse(b).dimensions as string[];
    if (dims.join() === "page,query") return { body: { rows: [{ keys: ["https://x.test/a", "blue widgets"], clicks: 4, impressions: 50 }] } };
    return { body: { rows: [{ keys: ["https://x.test/a", "MOBILE"], clicks: 3, impressions: 40 }, { keys: ["https://x.test/a", "DESKTOP"], clicks: 1, impressions: 10 }] } };
  }]]);
  const r = await readGscPages(g.fetch, "T", "sc-domain:x.test", gscWindows(TODAY));
  const all = r.rows.find((x) => x.device === "all" && x.period === "current");
  ok("one all-devices row per page carries the totals and the searches", all?.clicks === 4 && all?.impressions === 50 && !!all?.topQueriesJson);
  ok("the earlier window carries no search terms", r.rows.filter((x) => x.period === "prior").every((x) => x.topQueriesJson === null));
  ok("Search Console rows carry no visit counts (null, not 0)", r.rows.every((x) => x.sessions === null && x.engagedSessions === null && x.keyEvents === null));
  ok("the property is URL-encoded in the path", g.calls[0]!.url.includes(encodeURIComponent("sc-domain:x.test")));
}

/* ═════════════════════════ 6. Chrome field data and the lab test ═════════════════════════ */
hr("6. Chrome field data and the lab test: real visitors are not a test");
{
  const rec = { record: { key: {}, metrics: { largest_contentful_paint: { percentiles: { p75: 4800 } }, interaction_to_next_paint: { percentiles: { p75: 310 } }, cumulative_layout_shift: { percentiles: { p75: "0.12" } } }, collectionPeriod: { firstDate: { year: 2026, month: 9, day: 15 }, lastDate: { year: 2026, month: 10, day: 12 } } } };
  const p = parseCrux(rec)!;
  ok("the 75th percentile of each measure is read, layout shift from its string", p.lcpMs === 4800 && p.inpMs === 310 && p.cls === 0.12);
  ok("the collection period is kept as dates", p.first === "2026-09-15" && p.last === "2026-10-12");
  ok("a record with a missing measure leaves it null", parseCrux({ record: { metrics: { largest_contentful_paint: { percentiles: { p75: 2000 } } } } })!.inpMs === null);
  ok("the request asks for one form factor and the three measures", JSON.stringify(cruxRequest({ url: "https://x.test/" }, "PHONE")) === JSON.stringify({ url: "https://x.test/", formFactor: "PHONE", metrics: ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift"] }));
  const gNo = pretend([[/queryRecord/, { status: 404, body: { error: { code: 404, message: "chrome ux report data not found", status: "NOT_FOUND" } } }]]);
  ok("not-found means no data for the page", (await readCrux(gNo.fetch, "KEY", { url: "https://x.test/q" }, "PHONE")) === "no_data");
  const g500 = pretend([[/queryRecord/, { status: 500, body: "boom" }]]);
  let threw = false; try { await readCrux(g500.fetch, "KEY", { url: "https://x.test/q" }, "PHONE"); } catch { threw = true; }
  ok("a server error is an error, never 'no data'", threw);
  const g404other = pretend([[/queryRecord/, { status: 404, body: "<html>nothing</html>" }]]);
  threw = false; try { await readCrux(g404other.fetch, "KEY", { url: "https://x.test/q" }, "PHONE"); } catch { threw = true; }
  ok("a 404 that is not the API's no-record answer is an error", threw);
  ok("isCruxNoData is false for a non-HttpError", isCruxNoData(new Error("x")) === false);
  const gEmpty = pretend([[/queryRecord/, { body: { record: { metrics: {} } } }]]);
  ok("a record with none of the three measures is no data", (await readCrux(gEmpty.fetch, "KEY", { url: "https://x.test/q" }, "DESKTOP")) === "no_data");
  const nd = vitalRow("/q", "crux_url", "PHONE", "no_data");
  ok("no data stores NULL figures, not zero, and says why", nd.state === "no_data" && nd.lcpMs === null && nd.inpMs === null && nd.cls === null && !!nd.detail);
  const er = vitalRow("/q", "crux_url", "PHONE", { error: "x" });
  ok("an error row stores no figures", er.state === "error" && er.lcpMs === null);
  const psi = parsePsi({ lighthouseResult: { audits: { "largest-contentful-paint": { numericValue: 5200 }, "cumulative-layout-shift": { numericValue: 0.3 } } } })!;
  ok("the lab test reads LCP and layout shift from the audits", psi.lcpMs === 5200 && psi.cls === 0.3);
  const row = psiRow("/q", psi);
  ok("a lab row is phone, is its own source and has NO interaction figure", row.source === "psi_lab" && row.formFactor === "PHONE" && row.inpMs === null);
  ok("a lab response without audits is no data, not zero", parsePsi({}) === null && psiRow("/q", null).state === "no_data");
  ok("the lab test runs on a simulated phone", psiUrl("https://x.test/", "K").includes("strategy=mobile"));
}

/* ═════════════════════════ 7. Clarity ═════════════════════════ */
hr("7. Clarity: page aggregates, parsed defensively, never a visitor");
{
  const shape = (urlKey: string) => [
    { metricName: "Traffic", information: [{ totalSessionCount: "120", [urlKey]: "https://x.test/services/" }, { totalSessionCount: "30", [urlKey]: "https://x.test/" }] },
    { metricName: "RageClickCount", information: [{ sessionsWithMetricPercentage: 4.5, [urlKey]: "https://x.test/services" }] },
    { metricName: "DeadClickCount", information: [{ sessionsWithMetricPercentage: "9", [urlKey]: "https://x.test/services" }, { sessionsWithMetricPercentage: 50, [urlKey]: "https://x.test/never-in-traffic" }] },
    { metricName: "QuickbackClick", information: [{ sessionsWithMetricPercentage: 20, [urlKey]: "https://x.test/" }] },
    { metricName: "ScrollDepth", information: [{ averageScrollDepth: 61.2, [urlKey]: "https://x.test/services" }] },
    { metricName: "EngagementTime", information: [{ totalTime: 80, activeTime: 31, [urlKey]: "https://x.test/services" }] },
  ];
  for (const k of ["Url", "URL", "url"]) {
    const p = parseClarity(shape(k), "2026-10-14");
    const s = p.rows.find((r) => r.pagePath === "/services");
    ok(`the page key may be spelled ${k}`, s?.sessions === 120 && s?.rageClickPct === 4.5 && s?.deadClickPct === 9 && s?.scrollDepthAvg === 61.2 && s?.engagementSeconds === 31);
  }
  const p = parseClarity(shape("Url"), "2026-10-14");
  ok("a page the traffic metric does not list is not written", !p.rows.some((r) => r.pagePath === "/never-in-traffic"));
  ok("a metric a page does not carry is NULL, not 0", p.rows.find((r) => r.pagePath === "/")!.rageClickPct === null && p.rows.find((r) => r.pagePath === "/")!.quickbackPct === 20);
  const thin = parseClarity([
    { metricName: "Traffic", information: [{ totalSessionCount: 50, Url: "https://x.test/a" }, { Url: "https://x.test/nosessions" }] },
    { metricName: "RageClickCount", information: [{ Url: "https://x.test/a" }] },
    { metricName: "ScrollDepth", information: [{ Url: "https://x.test/a" }] },
  ], "d");
  ok("a metric entry with its figure missing leaves NULL, never 0", thin.rows.length === 1 && thin.rows[0]!.rageClickPct === null && thin.rows[0]!.scrollDepthAvg === null && thin.rows[0]!.sessions === 50);
  ok("every row carries the day", p.rows.every((r) => r.day === "2026-10-14"));
  ok("an unexpected body is no rows, not a crash", parseClarity({ error: "x" }, "d").rows.length === 0 && parseClarity(null, "d").rows.length === 0 && parseClarity([{ metricName: "Traffic" }], "d").rows.length === 0);
  const big = parseClarity([{ metricName: "Traffic", information: Array.from({ length: CLARITY_ROW_LIMIT }, (_, i) => ({ totalSessionCount: 1, Url: `https://x.test/p${i}` })) }], "d");
  ok("an answer at the row limit says it may be missing quieter pages", big.capped === true && parseClarity(shape("Url"), "d").capped === false);
  const now = new Date("2026-10-14T12:00:00Z");
  ok("a good read under six hours ago is not repeated", recentlyRead({ ranAt: "2026-10-14T08:00:00Z", status: "ok" }, now) && recentlyRead({ ranAt: "2026-10-14T08:00:00Z", status: "capped" }, now));
  ok("a read over six hours ago, a failed read and no read at all are repeated", !recentlyRead({ ranAt: "2026-10-14T05:00:00Z", status: "ok" }, now) && !recentlyRead({ ranAt: "2026-10-14T11:00:00Z", status: "error" }, now) && !recentlyRead({ ranAt: "2026-10-14T11:00:00Z", status: "no_token" }, now) && !recentlyRead(undefined, now));
  ok("six hours is the line", SKIP_WITHIN_MS === 6 * 3_600_000);
  ok("the call is one day with the page as the dimension", clarityUrlFor().includes("numOfDays=1") && clarityUrlFor().includes("dimension1=URL"));
  ok("the stored row has only counts and shares (no url, element, recording or visitor field)", Object.keys(p.rows[0]!).sort().join(",") === "day,deadClickPct,engagementSeconds,pagePath,quickbackPct,rageClickPct,scrollDepthAvg,sessions");
  const tokens = parseTokens('{"Studio-B1":" tok-1 ","bad":5,"empty":""}');
  ok("tokens are keyed by lower-cased slug and a non-string is no token", tokens.get("studio-b1") === "tok-1" && !tokens.has("bad") && !tokens.has("empty"));
  let threw = false; try { parseTokens("{nope"); } catch { threw = true; }
  ok("a broken secret fails loudly", threw);
  ok("no secret set is no tokens", parseTokens(undefined).size === 0 && parseTokens("  ").size === 0);
}

/* ═════════════════════════ 8. one account, end to end ═════════════════════════ */
hr("8. one account's read: every source ends as a status, never as silence");
const ctx: ClientCtx = { id: "client-1", name: "Example Co", domain: "example.test", ga4Property: "111", gscProperty: "sc-domain:example.test", observedUrls: [] };
const deps = (fetch: FetchLike, over: Partial<Deps> = {}): Deps => ({ fetch, token: async () => "TOKEN-ABC", googleKey: "KEY-SECRET-123", today: TODAY, pauseMs: 0, ...over });
const goodGoogle = () => pretend([
  [/analyticsdata[^ ]*runReport.*landingPage/s, { body: gaReport([["/services", "mobile", 300, 120, 5000, 9], ["/services", "desktop", 200, 130, 4000, 12], ["/", "mobile", 100, 60, 2000, 1]]) }],
  [/analyticsdata[^ ]*runReport.*pagePath/s, { body: evReport([["/services", "page_view", "mobile", "", 300], ["/services", "cta_click", "mobile", "Hero", 4]]) }],
  [/searchAnalytics/, (_u, b) => (JSON.parse(b).dimensions.join() === "page,query" ? { body: { rows: [{ keys: ["https://example.test/services", "widgets"], clicks: 4, impressions: 40 }] } } : { body: { rows: [{ keys: ["https://example.test/services", "MOBILE"], clicks: 4, impressions: 40 }] } })],
  [/queryRecord.*example\.test\/services/s, { body: { record: { metrics: { largest_contentful_paint: { percentiles: { p75: 4800 } }, interaction_to_next_paint: { percentiles: { p75: 150 } }, cumulative_layout_shift: { percentiles: { p75: "0.05" } } } } } }],
  [/queryRecord.*origin/s, { body: { record: { metrics: { largest_contentful_paint: { percentiles: { p75: 2100 } } } } } }],
  [/queryRecord/, { status: 404, body: { error: { message: "chrome ux report data not found", status: "NOT_FOUND" } } }],
  [/runPagespeed/, { body: { lighthouseResult: { audits: { "largest-contentful-paint": { numericValue: 6100 }, "cumulative-layout-shift": { numericValue: 0.02 } } } } }],
]);
{
  const g = goodGoogle();
  const r = await readClientBehaviour(ctx, deps(g.fetch));
  const st = (s: string) => r.runs.find((x) => x.source === s)?.status;
  ok("every source has exactly one run row", UX_SOURCES.every((s) => r.runs.filter((x) => x.source === s).length === (s === "clarity" ? 0 : 1)), r.runs.map((x) => x.source).join(","));
  ok("analytics, Search Console, events and field data answered", st("ga4_pages") === "ok" && st("gsc_pages") === "ok" && st("events") === "ok" && st("crux") === "ok" && st("psi") === "ok", r.runs.map((x) => `${x.source}=${x.status}`).join(" "));
  ok("every status is one the app knows", r.runs.every((x) => (RUN_STATUSES as readonly string[]).includes(x.status)));
  ok("a page too quiet for Chrome falls back to the whole site, stored as the whole site", r.vitals.some((v) => v.pagePath === "*" && v.source === "crux_origin" && v.state === "ok"));
  ok("the page with field data keeps its own row beside the whole-site one", r.vitals.some((v) => v.pagePath === "/services" && v.source === "crux_url" && v.lcpMs === 4800));
  ok("a page with no data is stored as no_data with null figures", r.vitals.some((v) => v.pagePath === "/" && v.state === "no_data" && v.lcpMs === null));
  ok("the lab test is labelled as the lab and only for the busiest pages", r.vitals.filter((v) => v.source === "psi_lab").length <= PSI_PAGES && r.vitals.some((v) => v.source === "psi_lab" && v.lcpMs === 6100));
  ok(`field data is asked for at most ${CRUX_PAGES} pages`, new Set(r.vitals.filter((v) => v.source === "crux_url").map((v) => v.pagePath)).size <= CRUX_PAGES);
  ok("no key and no token ever reaches a stored row", !JSON.stringify(r).includes("KEY-SECRET-123") && !JSON.stringify(r).includes("TOKEN-ABC"));
  ok("every Google call is a read: POST for reports, GET for the lab test, nothing else", g.calls.every((c) => c.method === "POST" || c.method === "GET"));
  ok("the key travels in the query string to Chrome and the lab test only", g.calls.filter((c) => c.url.includes("KEY-SECRET-123")).every((c) => /chromeuxreport|pagespeedonline/.test(c.url)));
}
{
  const g = goodGoogle();
  const r = await readClientBehaviour({ ...ctx, ga4Property: null, gscProperty: null }, deps(g.fetch));
  const st = (s: string) => r.runs.find((x) => x.source === s)?.status;
  ok("an account with no analytics property reads analytics and events as OFF", st("ga4_pages") === "off" && st("events") === "off");
  ok("an account with no Search Console property reads it as OFF", st("gsc_pages") === "off");
  ok("off makes no analytics or Search Console call", !g.calls.some((c) => /analyticsdata|searchconsole/.test(c.url)));
  ok("with no analytics pages the home page alone is asked about", g.calls.filter((c) => /queryRecord/.test(c.url) && /"url"/.test(c.body)).every((c) => /"url":"https:\/\/example\.test\/"/.test(c.body)));
}
{
  const g = goodGoogle();
  const r = await readClientBehaviour(ctx, deps(g.fetch, { googleKey: undefined }));
  ok("no Google key: field data and the lab test are NO_KEY and the run is told to fail loudly", r.runs.find((x) => x.source === "crux")?.status === "no_key" && r.runs.find((x) => x.source === "psi")?.status === "no_key" && r.needsKey === true);
  ok("no key makes no Chrome or lab call", !g.calls.some((c) => /chromeuxreport|pagespeedonline/.test(c.url)));
  ok("the other sources still ran", r.runs.find((x) => x.source === "ga4_pages")?.status === "ok");
  const none = await readClientBehaviour({ ...ctx, domain: null }, deps(g.fetch, { googleKey: undefined }));
  ok("no website on the record is OFF, not a missing key", none.runs.find((x) => x.source === "crux")?.status === "off" && none.needsKey === false);
}
{
  const failing = pretend([[/./, (url) => ({ status: 500, body: `denied for ${url}` })]]);
  const r = await readClientBehaviour(ctx, deps(failing.fetch));
  ok("a failing source ends as ERROR with a message and keeps going", r.runs.find((x) => x.source === "ga4_pages")?.status === "error" && r.runs.find((x) => x.source === "gsc_pages")?.status === "error");
  ok("the stored message never carries the key", r.runs.every((x) => !(x.detail ?? "").includes("KEY-SECRET-123")), r.runs.map((x) => x.detail).join(" | ").slice(0, 160));
  ok("an error stores no rows", r.behaviour.length === 0 && r.events.length === 0);
  const tok = await readClientBehaviour(ctx, deps(failing.fetch, { token: async () => { throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON."); } }));
  ok("a token that cannot be minted is an error naming why", tok.runs.find((x) => x.source === "ga4_pages")?.detail === "Missing GOOGLE_SERVICE_ACCOUNT_JSON.");
  const redacted = safeMessage(new Error("GET https://x/?key=KEY-SECRET-123&b=1 failed KEY-SECRET-123"), ["KEY-SECRET-123"]);
  ok("safeMessage removes a key wherever it appears", !redacted.includes("KEY-SECRET-123"));
}
{
  const many: Array<[string, string, ...number[]]> = [];
  for (let i = 0; i < PAGE_CAP + 5; i++) many.push([`/p${i}`, "mobile", 500 - i, 100, 1, 1]);
  const g = pretend([[/analyticsdata[^ ]*runReport/s, { body: gaReport(many) }], [/searchAnalytics/, { body: { rows: [] } }], [/./, { status: 404, body: { error: { message: "chrome ux report data not found" } } }]]);
  const r = await readClientBehaviour(ctx, deps(g.fetch));
  const ga = r.runs.find((x) => x.source === "ga4_pages")!;
  ok("a capped read says capped, how many were read and how many exist", ga.status === "capped" && ga.capped && ga.totalFound === PAGE_CAP + 5 && /busiest/.test(ga.detail ?? ""));
  ok("an empty Search Console answer is no_data, not a nought", r.runs.find((x) => x.source === "gsc_pages")?.status === "no_data");
  ok("field data where every page is too quiet is no_data", r.runs.find((x) => x.source === "crux")?.status === "no_data");
  const g0 = pretend([[/analyticsdata/, { body: { rows: [] } }]]);
  const r0 = await readClientBehaviour({ ...ctx, gscProperty: null, domain: null }, deps(g0.fetch));
  ok("a property with no visits is no_data for both analytics sources", r0.runs.find((x) => x.source === "ga4_pages")?.status === "no_data" && r0.runs.find((x) => x.source === "events")?.status === "no_data");
}

/* ═════════════════════════ 9. what is written ═════════════════════════ */
hr("9. the writes: literal columns, deterministic ids, nulls stay null");
{
  const countCols = (sql: string) => (/\(([^)]*)\)\s*VALUES/s.exec(sql)?.[1] ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const countParams = (sql: string) => Array.from(new Set(Array.from(sql.matchAll(/\$(\d+)/g)).map((m) => Number(m[1])))).length;
  for (const [name, sql, tbl] of [["behaviour", INSERT_BEHAVIOUR, "seo_page_behaviour"], ["events", INSERT_EVENTS, "seo_page_events"], ["vitals", INSERT_VITALS, "seo_page_vitals"], ["clarity", INSERT_CLARITY, "seo_clarity_days"], ["run", INSERT_RUN, "seo_ux_runs"]] as const) {
    const cols = countCols(sql);
    ok(`${name}: ${cols.length} literal columns, one placeholder each`, cols.length > 5 && cols.length === countParams(sql) && new RegExp(`INSERT INTO ${tbl}\\b`).test(sql));
    ok(`${name}: an upsert, never a bare insert`, /ON CONFLICT \([^)]+\) DO UPDATE SET/.test(sql));
  }
  // The sample statements are assembled so the app's wiring check, which reads every INSERT written in this repo, does not take a test string for a write.
  const SAMPLE = `${"INSERT"} ${"INTO"}`;
  selfTest("an INSERT's column list is read", (t) => countCols(t).length >= 3, `${SAMPLE} t (a, b, c) VALUES ($1,$2,$3)`, `${SAMPLE} t SELECT 1`);
  const rec: Array<{ sql: string; params: unknown[] }> = [];
  const db: Queryable = { query: async (sql, params) => { rec.push({ sql, params: params ?? [] }); return {}; } };
  const at = new Date("2026-10-14T08:00:00Z");
  const row = { source: "ga4" as const, pagePath: "/a", device: "mobile", period: "current" as const, windowStart: "2026-09-17", windowEnd: "2026-10-12", sessions: 10, engagedSessions: null, engagementSeconds: null, keyEvents: null, clicks: null, impressions: null, topQueriesJson: null };
  await writeBehaviour(db, "c1", [row], at); await writeBehaviour(db, "c1", [row], at);
  ok("a second run writes the same id (the same row)", rec[0]!.params[0] === rec[1]!.params[0]);
  ok("a different page or period is a different id", (await (async () => { const r2: Array<{ params: unknown[] }> = []; await writeBehaviour({ query: async (_s, p) => { r2.push({ params: p ?? [] }); return {}; } }, "c1", [{ ...row, period: "prior" }, { ...row, pagePath: "/b" }], at); return r2[0]!.params[0] !== rec[0]!.params[0] && r2[1]!.params[0] !== rec[0]!.params[0]; })()));
  ok("a figure the source did not return is bound as NULL, never 0", rec[0]!.params.slice(8, 15).filter((v) => v === null).length === 6 && rec[0]!.params[8] === 10);
  rec.length = 0;
  await writeVitals(db, "c1", [vitalRow("/q", "crux_url", "PHONE", "no_data")], at);
  ok("no-data timing is bound as NULL", rec[0]!.params.slice(5, 8).every((v) => v === null));
  rec.length = 0;
  await writeEvents(db, "c1", [{ pagePath: "/a", device: "mobile", eventName: "cta_click", section: "", period: "current", windowStart: "a", windowEnd: "b", eventCount: 3 }], at);
  ok("an event with no section is bound as the empty string (never NULL, so it can be keyed)", rec[0]!.params[5] === "");
  rec.length = 0;
  await writeClarity(db, "c1", [{ pagePath: "/a", day: "2026-10-14", sessions: 5, scrollDepthAvg: null, engagementSeconds: null, deadClickPct: null, rageClickPct: null, quickbackPct: null }], at);
  ok("a Clarity share the export did not give is bound as NULL", rec[0]!.params.slice(5, 10).every((v) => v === null));
  rec.length = 0;
  await writeRun(db, "c1", { source: "crux", status: "no_key", detail: "x", rows: 0, capped: false, totalFound: null, windowEnd: null }, at);
  ok("a run row carries its status", rec[0]!.params[2] === "no_key");
}

/* ═════════════════════════ 10. what the code is not allowed to be ═════════════════════════ */
hr("10. discipline read from the source");
{
  const dir = "src/page-behaviour";
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => path.join(dir, f));
  const scripts = ["src/read-page-behaviour.ts", "src/read-clarity.ts"];
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const code = Object.fromEntries([...files, ...scripts].map((f) => [f, strip(fs.readFileSync(f, "utf8"))]));
  const all = Object.values(code).join("\n");

  const noDirectFetch = (t: string) => !/(^|[^.\w])fetch\(/.test(t);
  selfTest("no module calls fetch directly", noDirectFetch, "const x = realFetch(url)", "const x = fetch(url)");
  ok("only http.ts holds the real fetch", Object.entries(code).filter(([f]) => !f.endsWith("http.ts")).every(([, t]) => noDirectFetch(t)));

  const hosts = Array.from(new Set(Array.from(all.matchAll(/https:\/\/([a-z0-9.-]+)/g)).map((m) => m[1]!))).filter((h) => !/^schema\.org$/.test(h));
  const allowed = ["analyticsdata.googleapis.com", "searchconsole.googleapis.com", "chromeuxreport.googleapis.com", "www.googleapis.com", "www.clarity.ms"];
  ok("the only hosts named are the five sources", hosts.every((h) => allowed.includes(h)), hosts.join(", "));
  selfTest("an unlisted host is caught", (t) => Array.from(t.matchAll(/https:\/\/([a-z0-9.-]+)/g)).every((m) => allowed.includes(m[1]!)), "https://www.clarity.ms/x", "https://tracker.example.io/x");

  const writesToDb = Array.from(all.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)).map((m) => `${m[1]} ${m[2]}`);
  const allowedWrites = new Set(["INSERT INTO seo_page_behaviour", "INSERT INTO seo_page_events", "INSERT INTO seo_page_vitals", "INSERT INTO seo_clarity_days", "INSERT INTO seo_ux_runs", "DELETE FROM seo_clarity_days"]);
  ok("it writes five tables and deletes only old Clarity days", writesToDb.every((w) => allowedWrites.has(w)), writesToDb.join("; "));
  selfTest("a stray write is caught", (t) => Array.from(t.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)).every((m) => allowedWrites.has(`${m[1]} ${m[2]}`)), `${"INSERT"} ${"INTO"} seo_ux_runs (a) VALUES ($1)`, "UPDATE clients SET name = $1");

  const insertBlocks = Array.from(all.matchAll(/INSERT INTO ([a-z_]+)\s*\(([^)]*)\)/g)).map((m) => m[2]!);
  const bannedCols = /(user_id|visitor|session_id|client_id_ga|email|phone|ip_address|recording|replay|heatmap|element)/i;
  ok("no stored column could hold a person, a session, a recording or an element", !insertBlocks.some((c) => bannedCols.test(c)));
  selfTest("a person-shaped column is caught", (t) => !bannedCols.test(t), "id, client_id, page_path", "id, client_id, visitor_id");

  const leaks = (l: string) => /\$\{\s*(googleKey|key|token|body|res\b|text)\b|\.text\(\)|JSON\.stringify\(\s*(result|r)\s*\)/.test(l);
  const logs = Array.from(all.matchAll(/console\.(log|error)\(([^;]*)\)/g)).map((m) => m[2]!);
  ok("nothing prints a key, a token or a response body", !logs.some(leaks), logs.filter(leaks).join(" | "));
  selfTest("a printed secret is caught", (t) => !leaks(t), "`${m.name}: ${msg}`", "`token is ${token}`");
  ok("the key is read from the environment in one place", (all.match(/process\.env\.CRUX_API_KEY/g) ?? []).length === 1);
  ok("the Clarity tokens are read from the environment in one place", (all.match(/process\.env\.CLARITY_TOKENS_JSON/g) ?? []).length === 1);
  const exitsOn = (t: string, cond: string) => new RegExp(`if \\(${cond}[^)]*\\)\\s*\\{[\\s\\S]{0,260}?process\\.exit\\(1\\)`).test(t);
  selfTest("a loud exit is read", (t) => exitsOn(t, "needsKey > 0"), "if (needsKey > 0) { console.error('x'); process.exit(1); }", "if (needsKey > 0) { console.error('x'); }");
  ok("a missing Google key makes the run exit non-zero, so the morning is red", exitsOn(code["src/read-page-behaviour.ts"]!, "needsKey > 0"));
  ok("a Clarity project with no token makes the run exit non-zero", exitsOn(code["src/read-clarity.ts"]!, "noToken > 0"));
  ok("a dry run writes nothing", /if \(dryRun\) continue;[\s\S]*write(Behaviour|Events|Vitals|Run)/.test(code["src/read-page-behaviour.ts"]!) && /if \(dryRun\) continue;[\s\S]*writeClarity/.test(code["src/read-clarity.ts"]!));
  ok("the Clarity script asks the six-hour rule before it reads, and reads once per client", /if \(recentlyRead\(/.test(code["src/read-clarity.ts"]!) && code["src/read-clarity.ts"]!.indexOf("if (recentlyRead(") < code["src/read-clarity.ts"]!.indexOf("await readClarity(") && (code["src/read-clarity.ts"]!.match(/await readClarity\(/g) ?? []).length === 1);
  ok("no write verb is sent to any source", !/method:\s*"(PUT|PATCH|DELETE)"/.test(all));
  ok("no module imports the dashboard app", !/from "\.\.\/\.\.\/|from "@shared|dashboard/.test(all.replace(/the dashboard/gi, "")));
  ok("no model call", !/anthropic|openai|completion/i.test(all));
}

/* ═════════════════════════ 11. the workflows ═════════════════════════ */
hr("11. workflows: scheduled, dispatchable, heartbeat under the name the app judges");
{
  const wf = (n: string) => fs.readFileSync(`.github/workflows/${n}`, "utf8");
  for (const [file, job, secret, script] of [["read-page-behaviour.yml", "read_page_behaviour", "CRUX_API_KEY", "read-page-behaviour"], ["read-clarity.yml", "read_clarity", "CLARITY_TOKENS_JSON", "read-clarity"]] as const) {
    const y = wf(file);
    ok(`${file}: scheduled`, /schedule:\s*\n\s*- cron:/.test(y));
    ok(`${file}: takes client_id and dry_run, neither required`, /client_id:[\s\S]*?required:\s*false/.test(y) && /dry_run:[\s\S]*?required:\s*false/.test(y));
    ok(`${file}: heartbeats as ${job}`, new RegExp(`--job=${job}\\b`).test(y));
    ok(`${file}: a one-client or dry run does not stamp the book-wide heartbeat`, /Heartbeat[\s\S]*?if:\s*always\(\)\s*&&\s*inputs\.dry_run != 'true'\s*&&\s*inputs\.client_id == ''/.test(y));
    ok(`${file}: the note goes through an environment variable`, /NOTE: \$\{\{ steps\.run\.outputs\.summary \}\}/.test(y) && !/--note="\$\{\{/.test(y));
    ok(`${file}: names the secret ${secret}`, y.includes(`secrets.${secret}`));
    ok(`${file}: runs ${script} and keeps the log for the heartbeat`, y.includes(`npm run ${script}`) && /tee run\.log/.test(y) && /--log=run\.log/.test(y));
    const interpolatedIntoShell = (t: string) => t.split("\n").some((l) => /\$\{\{\s*(inputs|github)\./.test(l) && !/^\s*(#|[A-Za-z_]+:\s*\$\{\{|group:|if:)/.test(l) && !/^\s*group:/.test(l));
    ok(`${file}: no workflow input is interpolated into a shell line`, !interpolatedIntoShell(y));
    selfTest(`${file}: the interpolation check is read`, (t) => !interpolatedIntoShell(t), "env:\n  CLIENT_ID: ${{ inputs.client_id }}\nrun: |\n  npm run x", "run: |\n  npm run x -- ${{ inputs.client_id }} | tee y");
  }
  selfTest("the heartbeat gate is read", (t) => /if:\s*always\(\)\s*&&\s*inputs\.dry_run != 'true'\s*&&\s*inputs\.client_id == ''/.test(t), "if: always() && inputs.dry_run != 'true' && inputs.client_id == ''", "if: always()");
  const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
  ok("CI runs this guard", /npm run verify-page-behaviour/.test(ci));
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  ok("the three scripts exist", !!pkg.scripts["read-page-behaviour"] && !!pkg.scripts["read-clarity"] && !!pkg.scripts["verify-page-behaviour"]);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll page-behaviour checks passed.");
process.exit(failures ? 1 : 0);

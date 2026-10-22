#!/usr/bin/env tsx
/**
 * Guard for the Website performance reader: what it asks Google Analytics for, what
 * it keeps, and what it refuses to turn into a number.
 *
 * No network, no token. A pretend Google (a small in-memory property that honours
 * dates, filters, paging and a rejected-metric list) answers the real builders, the
 * real parsers and the real orchestration end to end; a recording client stands in
 * for Postgres so the real INSERTs are read as text and as parameters; and, when
 * ADS_VERIFY_DATABASE_URL is set, the real store runs against a scratch schema.
 *
 * EVERY CLIENT, PAGE, REGION, PROPERTY AND FIGURE BELOW IS INVENTED.
 *
 * WHAT THIS CANNOT PROVE. The request and response shapes are written from the Data
 * API's published documentation and have not been run against a live property. A
 * green run means the code does what it says against the shapes it expects, not that
 * Google answers in them. docs/GA4-REPORT.md lists the least certain.
 *
 *   npx tsx src/verify-ga4-report.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { addDays } from "./page-behaviour/paths.js";
import { HttpError, safeMessage } from "./page-behaviour/http.js";
import { configKey, sanitiseConfig, defaultConfig } from "./ga4-report/config.js";
import { readWindow, monthFromYearMonth, dayFromGa4Date, monthsBetween, daysBetween } from "./ga4-report/months.js";
import {
  DAILY_METRIC_LADDER, SESSION_METRIC_LADDER, andFilters, dailyRequest, dailyRows, exclusionFilter, groupFilter, isRetryable, kindSpecs,
  parseDaily, parseReport, reportRequest, topPerMonth, type Filter,
} from "./ga4-report/ga4.js";
import { readClientReport, type Deps } from "./ga4-report/run.js";
import { GROUP_MATCH_MODES, cleanMatch, groupKey, mergeKey, parseGroupKey, pathInGroup } from "./ga4-report/groups.js";
import { processClients } from "./ga4-report/pipeline.js";
import {
  DELETE_KIND_MONTHS, INSERT_REPORT_ROW, INSERT_RUN, INSERT_RUN_KEEP, INSERT_SITE_DAY, writeClientReport, type Queryable,
} from "./ga4-report/store.js";
import { CONFIG_LIMITS, DEFAULT_FORM_EVENT, REPORT_KINDS, RETRY_WAITS_MS, ROW_CEILING, PAGE_SIZE, TOP_N, type ClientReportResult, type FetchLike, type ReportRowOut } from "./ga4-report/types.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);
function selfTest(label: string, test: (text: string) => boolean, good: string, bad: string) {
  ok(`${label} (self-test: passes a good sample)`, test(good) === true);
  ok(`${label} (self-test: fails a planted bad sample)`, test(bad) === false);
}

const DDL = `
CREATE TABLE clients (id text PRIMARY KEY);
CREATE TABLE ga4_site_days (
  id text PRIMARY KEY, client_id text NOT NULL REFERENCES clients(id), day text NOT NULL,
  sessions integer, engaged_sessions integer, engagement_seconds double precision, users integer, key_events double precision,
  synced_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX idx_ga4_site_days_key ON ga4_site_days(client_id, day);
CREATE TABLE ga4_report_rows (
  id text PRIMARY KEY, client_id text NOT NULL REFERENCES clients(id), month text NOT NULL, kind text NOT NULL,
  parent text NOT NULL DEFAULT '', key text NOT NULL, sessions integer, engaged_sessions integer, engagement_seconds double precision,
  events integer, synced_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX idx_ga4_report_rows_key ON ga4_report_rows(client_id, month, kind, parent, key);
CREATE TABLE ga4_report_runs (
  id text PRIMARY KEY, client_id text NOT NULL UNIQUE REFERENCES clients(id), status text NOT NULL, detail text,
  first_day text, last_day text, first_month text, last_month text, rows integer NOT NULL DEFAULT 0,
  capped_kinds text, failed_kinds text, excluded_countries text, form_event text, groups_json text,
  ran_at timestamptz NOT NULL DEFAULT now(), excluded_channels text);
`;

/* ───────────────────────── a pretend property ───────────────────────── */

interface SRow { date: string; country: string; region: string; sm: string; landing: string; sessions: number; engaged: number; secs: number; users: number; keyEvents: number }
interface ERow { date: string; country: string; page: string; event: string; count: number; channel: string }
interface Dataset { sessions: SRow[]; events: ERow[] }

interface Opts {
  /** Metrics the property refuses (a 400 when asked for). */
  reject?: ReadonlySet<string>;
  /** Called first with the parsed request; a reply here wins. */
  fail?: (body: Record<string, unknown>) => { status: number; body: unknown } | null;
  /** Rows per page the property will give regardless of the limit asked. */
  pageCap?: number;
}

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function matches(f: unknown, rec: Record<string, string | undefined>): boolean {
  const o = f as Record<string, any> | undefined;
  if (!o) return true;
  if (o.andGroup) return (o.andGroup.expressions as unknown[]).every((e) => matches(e, rec));
  if (o.orGroup) return (o.orGroup.expressions as unknown[]).some((e) => matches(e, rec));
  if (o.notExpression) return !matches(o.notExpression, rec);
  const fl = o.filter;
  if (!fl) return true;
  const v = rec[fl.fieldName as string];
  if (v === undefined) return true; // a field this kind of row does not carry
  if (fl.inListFilter) return (fl.inListFilter.values as string[]).includes(v);
  if (fl.stringFilter) {
    const { matchType, value } = fl.stringFilter as { matchType: string; value: string };
    if (matchType === "EXACT") return v === value;
    if (matchType === "BEGINS_WITH") return v.startsWith(value);
  }
  return true;
}

/** The channel group GA4 would file a source and medium under, for the pretend property. */
const channelOf = (sm: string): string =>
  sm.startsWith("(direct)") ? "Direct" : sm.endsWith("/ organic") ? "Organic Search" : sm.endsWith("/ cpc") ? "Paid Search" : sm.endsWith("/ paid_social") ? "Paid Social" : "Unassigned";

function property(data: Dataset, opts: Opts = {}): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, any>;
    calls.push({ url, body, headers: init?.headers ?? {} });
    const reply = (status: number, b: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof b === "string" ? b : JSON.stringify(b)) });
    const failed = opts.fail?.(body);
    if (failed) return reply(failed.status, failed.body);
    const metrics = (body.metrics as Array<{ name: string }>).map((m) => m.name);
    for (const m of metrics) if (opts.reject?.has(m)) return reply(400, { error: { message: `Field ${m} is not a valid metric` } });
    const dims = (body.dimensions as Array<{ name: string }>).map((d) => d.name);
    const range = (body.dateRanges as Array<{ startDate: string; endDate: string }>)[0]!;
    const isEvents = metrics.includes("eventCount");
    const groups = new Map<string, { dv: string[]; sums: Record<string, number> }>();
    const rowsIn: Array<{ f: Record<string, string | undefined>; m: Record<string, number> }> = isEvents
      ? data.events.map((e) => ({ f: { date: e.date, country: e.country, pagePath: e.page, eventName: e.event, sessionDefaultChannelGroup: e.channel }, m: { eventCount: e.count } }))
      : data.sessions.map((s) => ({
          f: { date: s.date, country: s.country, region: s.region, sessionSourceMedium: s.sm, landingPage: s.landing, pagePath: s.landing, sessionDefaultChannelGroup: channelOf(s.sm) },
          m: { sessions: s.sessions, engagedSessions: s.engaged, userEngagementDuration: s.secs, totalUsers: s.users, keyEvents: s.keyEvents, conversions: s.keyEvents },
        }));
    for (const r of rowsIn) {
      const d = r.f.date!;
      if (d < range.startDate.replace(/-/g, "") || d > range.endDate.replace(/-/g, "")) continue;
      if (!matches(body.dimensionFilter, r.f)) continue;
      const dv = dims.map((n) => (n === "yearMonth" ? d.slice(0, 6) : String(r.f[n] ?? "")));
      const k = dv.join("\u0000");
      const g = groups.get(k) ?? { dv, sums: {} };
      for (const m of metrics) g.sums[m] = (g.sums[m] ?? 0) + (r.m[m] ?? 0);
      groups.set(k, g);
    }
    const all = Array.from(groups.values()).sort((a, b) => a.dv.join("|").localeCompare(b.dv.join("|")));
    const limit = Math.min(Number(body.limit ?? 10000), opts.pageCap ?? Infinity);
    const offset = Number(body.offset ?? 0);
    const page = all.slice(offset, offset + limit);
    return reply(200, {
      dimensionHeaders: dims.map((name) => ({ name })), metricHeaders: metrics.map((name) => ({ name })),
      rows: page.map((g) => ({ dimensionValues: g.dv.map((value) => ({ value })), metricValues: metrics.map((m) => ({ value: String(g.sums[m] ?? 0) })) })),
      rowCount: all.length,
    });
  };
  return { fetch: f, calls };
}

/* ───────────────────────── the invented client ───────────────────────── */

const TODAY = "2026-10-14";
const MONTHS = 4;                               // window 2026-06-01 .. 2026-10-12
const S = (date: string, country: string, region: string, sm: string, landing: string, sessions: number, engaged = Math.floor(sessions / 2), secs = sessions * 30, users = sessions, keyEvents = 0): SRow =>
  ({ date, country, region, sm, landing, sessions, engaged, secs, users, keyEvents });
const E = (date: string, country: string, page: string, event: string, count: number, channel = "Organic Search"): ERow => ({ date, country, page, event, count, channel });

function dataset(): Dataset {
  const sessions: SRow[] = [
    // The property has no traffic before 2026-06-10, and none on 06-12, 06-13 (a quiet stretch), nor on 10-11 and 10-12.
    S("20260610", "United States", "Ohio", "google / organic", "/plan-your-trip/advisor/ohio?utm=1", 10, 6, 300, 9, 1),
    S("20260610", "United States", "Ohio", "google / organic", "/plan-your-trip/advisor/ohio/", 5, 3, 100, 5, 0),
    S("20260610", "United States", "Texas", "(direct) / (none)", "/", 4, 2, 40, 4, 0),
    S("20260610", "India", "Delhi", "google / organic", "/", 50, 1, 5, 50, 0),
    S("20260611", "United States", "", "facebook / paid_social", "(not set)", 7, 4, 90, 7, 0),
    S("20260614", "United States", "Ohio", "google / organic", "/plan-your-trip/advisor/ohio", 8, 5, 200, 8, 2),
    S("20260705", "United States", "Ohio", "google / organic", "/plan-your-trip/advisor/cincinnati", 12, 8, 400, 11, 1),
    S("20260705", "Canada", "Ontario", "(direct) / (none)", "/", 3, 1, 30, 3, 0),
    S("20260801", "United States", "Ohio", "google / cpc", "/lp/spring", 20, 9, 500, 18, 3),
    S("20260901", "United States", "Texas", "google / organic", "/", 15, 10, 450, 14, 1),
    S("20261001", "United States", "Ohio", "google / organic", "/plan-your-trip/advisor/ohio", 9, 6, 210, 9, 0),
    S("20261010", "India", "Delhi", "google / organic", "/plan-your-trip/advisor/ohio", 40, 0, 0, 40, 0),
    S("20261010", "United States", "Ohio", "google / organic", "/contact", 6, 4, 120, 6, 1),
  ];
  const events: ERow[] = [
    E("20260610", "United States", "/plan-your-trip/advisor/ohio?x=1", "form_submit", 3),
    E("20260610", "United States", "/plan-your-trip/advisor/ohio/", "form_submit", 1),
    E("20260610", "United States", "/contact", "page_view", 99),
    E("20260705", "United States", "/plan-your-trip/advisor/cincinnati", "form_submit", 2),
    E("20260705", "India", "/contact", "form_submit", 30, "Direct"),
    E("20261010", "United States", "/contact", "form_submit", 4),
    E("20260801", "United States", "/lp/spring", "lead_form", 5),
  ];
  return { sessions, events };
}

const CTX = { id: "client-a", name: "Alpine Travel Test", ga4Property: "111222333" };
const SECRET = "TOKEN-SECRET-9f8e7d";
const noSleep = async () => {};
function deps(f: FetchLike, extra: Partial<Deps> = {}): Deps {
  return { fetch: f, token: async () => SECRET, today: TODAY, months: MONTHS, sleep: noSleep, pauseMs: 0, ...extra };
}
const cfg = (o: Record<string, unknown>) => sanitiseConfig(JSON.stringify(o));
const GROUP = { name: "Advisor pages", prefix: "/plan-your-trip/advisor/", match: "starts" as const };

/* ═════════════════════════ 1. the settings are cleaned ═════════════════════════ */
hr("1. settings: hostile input is cleaned, never trusted");
{
  const d = defaultConfig();
  ok("nothing configured: no exclusions, no groups, the default event", d.excludeCountries.length === 0 && d.groups.length === 0 && d.formEvent === DEFAULT_FORM_EVENT && DEFAULT_FORM_EVENT === "form_submit");
  ok("the setting key is web_report_config:<clientId>", configKey("abc") === "web_report_config:abc");
  for (const bad of [undefined, null, "", "{", "[]", "42", "\"x\"", "null", "{\"excludeCountries\":\"India\"}"]) {
    const c = sanitiseConfig(bad as unknown);
    ok(`unusable value ${JSON.stringify(bad)} reads as no settings`, c.excludeCountries.length === 0 && c.groups.length === 0 && c.formEvent === DEFAULT_FORM_EVENT);
  }
  const c1 = cfg({ excludeCountries: ["India", " India ", "india", 7, null, "", "A".repeat(200), "Bad\u0000Name", "Russia"], by: "x", at: "y" });
  ok("countries: trimmed, de-duplicated without regard to case, non-strings and overlong and control characters dropped", JSON.stringify(c1.excludeCountries) === JSON.stringify(["India", "Russia"]), JSON.stringify(c1.excludeCountries));
  const many = cfg({ excludeCountries: Array.from({ length: 60 }, (_, i) => `Country ${i}`) });
  ok(`at most ${CONFIG_LIMITS.countries} countries`, many.excludeCountries.length === CONFIG_LIMITS.countries);
  const g = cfg({ groups: [
    { name: "Good", prefix: "/a/" }, { name: "No slash", prefix: "a/" }, { name: "", prefix: "/b/" }, { name: "Long", prefix: `/${"x".repeat(CONFIG_LIMITS.prefixChars)}` },
    { name: "Space", prefix: "/a b/" }, { name: "Dup", prefix: "/a/" }, { name: 3, prefix: "/c/" }, "str", null, { name: "Ctl", prefix: "/c\n/" },
    { name: "Edge", prefix: `/${"y".repeat(CONFIG_LIMITS.prefixChars - 1)}` },
  ] });
  ok("groups: only a named group with a prefix starting with / and at most 120 characters, no spaces, no repeats", g.groups.length === 2 && g.groups[0]!.prefix === "/a/" && g.groups[1]!.prefix.length === CONFIG_LIMITS.prefixChars, JSON.stringify(g.groups.map((x) => x.name)));
  ok(`at most ${CONFIG_LIMITS.groups} groups`, cfg({ groups: Array.from({ length: 12 }, (_, i) => ({ name: `G${i}`, prefix: `/g${i}/` })) }).groups.length === CONFIG_LIMITS.groups);
  ok("a valid form event is kept", cfg({ formEvent: "quote_request" }).formEvent === "quote_request");
  for (const e of ["Form_Submit", "1form", "form submit", "form-submit", "x".repeat(41), "", 5, null, "form_submit;drop", "\"}]"]) {
    ok(`a bad event name ${JSON.stringify(e)} falls back to the default`, cfg({ formEvent: e }).formEvent === DEFAULT_FORM_EVENT);
  }
}

/* ═════════════════════════ 2. months and days ═════════════════════════ */
hr("2. the window, month keys and days");
{
  const w = readWindow(TODAY, MONTHS)!;
  ok("the window starts on the first of the month N months back", w.start === "2026-06-01", w.start);
  ok("it ends two days before today (the GA4 lag)", w.end === "2026-10-12", w.end);
  ok("24 months by default reaches back to October 2024", readWindow(TODAY, 24)!.start === "2024-10-01");
  ok("a year boundary is crossed correctly", readWindow("2026-02-10", 3)!.start === "2025-11-01");
  ok("the months are clamped to 1..36", readWindow(TODAY, 999)!.start === "2023-10-01" && readWindow(TODAY, 0)!.start === "2026-09-01");
  ok("a date that is not a date has no window", readWindow("nope", 3) === null);
  ok("202607 is 2026-07", monthFromYearMonth("202607") === "2026-07");
  ok("month 13, 00, text and short values are not months", monthFromYearMonth("202613") === null && monthFromYearMonth("202600") === null && monthFromYearMonth("2026-07") === null && monthFromYearMonth("2026") === null && monthFromYearMonth(undefined) === null);
  ok("20260714 is 2026-07-14", dayFromGa4Date("20260714") === "2026-07-14");
  ok("an impossible day is not a day", dayFromGa4Date("20260231") === null && dayFromGa4Date("20261301") === null && dayFromGa4Date("x") === null);
  ok("monthsBetween lists every month, oldest first", JSON.stringify(monthsBetween("2026-11-20", "2027-02-03")) === JSON.stringify(["2026-11", "2026-12", "2027-01", "2027-02"]));
  ok("daysBetween is inclusive", daysBetween("2026-02-27", "2026-03-02").length === 4);
}

/* ═════════════════════════ 3. requests ═════════════════════════ */
hr("3. what is asked: the country exclusion rides on every request");
{
  const w = readWindow(TODAY, MONTHS)!;
  const India = ["India", "Russia"];
  ok("no exclusion when none is configured", exclusionFilter([]) === null && andFilters(null) === undefined);
  ok("the exclusion is a notExpression over an inListFilter on country", JSON.stringify(exclusionFilter(India)) === JSON.stringify({ notExpression: { filter: { fieldName: "country", inListFilter: { values: India } } } }));
  ok("one filter stands alone and several are an andGroup", JSON.stringify(andFilters({ a: 1 }, null)) === JSON.stringify({ a: 1 }) && (andFilters({ a: 1 }, { b: 2 }) as any).andGroup.expressions.length === 2);
  const withEx = dailyRequest(w, DAILY_METRIC_LADDER[0]!, India);
  const without = dailyRequest(w, DAILY_METRIC_LADDER[0]!, []);
  ok("the daily request carries the exclusion when configured", JSON.stringify(withEx).includes("\"country\"") && JSON.stringify(withEx).includes("India"));
  ok("and carries no filter at all when not", !("dimensionFilter" in without));
  ok("the daily request asks for the date and is ordered by it", (withEx.dimensions as any)[0].name === "date");

  // Every request of a real run, with and without the exclusion.
  const run = async (config: ReturnType<typeof cfg>) => { const p = property(dataset()); await readClientReport(CTX, config, deps(p.fetch)); return p.calls; };
  const full = await run(cfg({ excludeCountries: India, groups: [GROUP, { name: "Lps", prefix: "/lp/" }] }));
  ok("a configured run makes the daily, the eight reports and four requests per group", full.length === 1 + 8 + 4 * 2, `${full.length} requests`);
  const rawCall = (c: { body: Record<string, any> }) => (c.body.dimensions as any[]).length === 1 && c.body.dimensions[0].name === "yearMonth" && !("dimensionFilter" in c.body);
  ok("EVERY request of the run carries the exclusion, except the one unfiltered monthly total", full.filter((c) => !rawCall(c)).every((c) => JSON.stringify(c.body.dimensionFilter ?? {}).includes("inListFilter") && JSON.stringify(c.body.dimensionFilter).includes("Russia")) && full.filter(rawCall).length === 1);
  const plain = await run(cfg({ groups: [GROUP] }));
  ok("with nothing excluded no request names a country filter", plain.every((c) => !JSON.stringify(c.body).includes("inListFilter")));
  ok("every request goes to the property's runReport with the token", full.every((c) => c.url === "https://analyticsdata.googleapis.com/v1beta/properties/111222333:runReport" && c.headers.Authorization === `Bearer ${SECRET}`));
  ok("every report request carries yearMonth as its first dimension", full.slice(1).every((c) => (c.body.dimensions as any)[0].name === "yearMonth"));

  const specs = kindSpecs([GROUP], "form_submit");
  const kinds = specs.map((s) => s.kind);
  ok("one spec per kind, plus a landing, a visits and a form spec per group", JSON.stringify(kinds) === JSON.stringify(["region", "source_medium", "landing_page", "form_page", "event_name", "channel_sessions", "channel_forms", "month_raw", "group_page", "group_visits", "group_sessions", "group_form"]));
  const byKind = Object.fromEntries(specs.map((s) => [s.kind, reportRequest(w, s, s.ladder[0]!, [])])) as Record<string, any>;
  ok("region asks for country and region", byKind.region.dimensions.map((d: any) => d.name).join() === "yearMonth,country,region");
  ok("sources ask for sessionSourceMedium", byKind.source_medium.dimensions[1].name === "sessionSourceMedium");
  ok("landing pages ask for landingPage with no filter", byKind.landing_page.dimensions[1].name === "landingPage" && !("dimensionFilter" in byKind.landing_page));
  ok("form pages ask for pagePath and eventCount, filtered to the form event", byKind.form_page.dimensions[1].name === "pagePath" && byKind.form_page.metrics[0].name === "eventCount" && JSON.stringify(byKind.form_page.dimensionFilter) === JSON.stringify({ filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "form_submit" } } }));
  ok("a group's pages filter landingPage BEGINS_WITH its prefix", JSON.stringify(byKind.group_page.dimensionFilter) === JSON.stringify({ filter: { fieldName: "landingPage", stringFilter: { matchType: "BEGINS_WITH", value: GROUP.prefix } } }));
  ok("a group's forms are pagePath BEGINS_WITH the prefix AND the form event", (() => { const e = byKind.group_form.dimensionFilter.andGroup.expressions; return e.length === 2 && e[0].filter.fieldName === "pagePath" && e[0].filter.stringFilter.matchType === "BEGINS_WITH" && e[1].filter.fieldName === "eventName"; })());
  const over = kindSpecs([], "quote_request").find((s) => s.kind === "form_page")!;
  ok("the form event can be overridden", JSON.stringify(reportRequest(w, over, over.ladder[0]!, [])).includes("quote_request"));
  ok("no groups means no group requests", kindSpecs([], "form_submit").every((s) => s.kind !== "group_page" && s.kind !== "group_form"));
  const gspec = specs.find((x) => x.kind === "group_page")!;
  const ex = reportRequest(w, gspec, gspec.ladder[0]!, India) as any;
  ok("a group request with an exclusion is the prefix filter AND the exclusion", ex.dimensionFilter.andGroup.expressions.length === 2);
}

/* ═════════════════════════ 4. parsing ═════════════════════════ */
hr("4. what is kept: months, paths, regions");
{
  const w = readWindow(TODAY, MONTHS)!;
  const months = new Set(monthsBetween(w.start, w.end));
  const specs = kindSpecs([GROUP], "form_submit");
  const sp = (k: string) => specs.find((s) => s.kind === k)!;
  const rep = (dims: string[][], metrics: string[], vals: number[][]) => ({
    metricHeaders: metrics.map((name) => ({ name })),
    rows: dims.map((d, i) => ({ dimensionValues: d.map((value) => ({ value })), metricValues: vals[i]!.map((v) => ({ value: String(v) })) })),
  });
  const lp = parseReport(rep([["202607", "/a/b?x=1"], ["202607", "/a/b/"], ["202607", "https://x.test/a/b#top"], ["202607", "(not set)"], ["202607", ""], ["202608", "/a/b"], ["202501", "/old"], ["junk", "/j"]], ["sessions", "engagedSessions", "userEngagementDuration"], [[1, 1, 10], [2, 1, 20], [3, 2, 30], [9, 9, 9], [9, 9, 9], [4, 2, 8], [5, 5, 5], [6, 6, 6]]), sp("landing_page"), months);
  ok("several spellings of one path are summed and the query string is gone", lp.filter((r) => r.month === "2026-07").length === 1 && lp[0]!.key === "/a/b" && lp[0]!.sessions === 6 && lp[0]!.engagedSessions === 4 && lp[0]!.engagementSeconds === 60, JSON.stringify(lp[0]));
  ok("(not set) and empty landing pages are not pages", !lp.some((r) => r.key === "(not set)" || r.key === ""));
  ok("a month outside the window and a malformed month are dropped", !lp.some((r) => r.month === "2025-01") && lp.length === 2);
  ok("202607 becomes 2026-07 on the row", lp.every((r) => /^2026-0[78]$/.test(r.month)));
  ok("a landing page row carries sessions columns and no events", lp.every((r) => r.events === null && r.parent === ""));

  const rg = parseReport(rep([["202607", "United States", "Ohio"], ["202607", "United States", ""], ["202607", "(not set)", "(not set)"], ["202607", "Canada", "Ohio"]], ["sessions"], [[5], [3], [1], [2]]), sp("region"), months);
  ok("a region keeps its country as the parent", rg.find((r) => r.key === "Ohio" && r.parent === "United States")?.sessions === 5 && rg.find((r) => r.key === "Ohio" && r.parent === "Canada")?.sessions === 2);
  ok("Ohio in two countries is two rows", rg.filter((r) => r.key === "Ohio").length === 2);
  ok("an empty region and a (not set) region are kept as their own key", rg.some((r) => r.parent === "United States" && r.key === "(not set)" && r.sessions === 3) && rg.some((r) => r.parent === "(not set)" && r.key === "(not set)"));
  ok("a metric the report did not carry is null, not zero", rg.every((r) => r.engagedSessions === null && r.engagementSeconds === null));

  const sm = parseReport(rep([["202607", "google / organic"], ["202607", ""]], ["sessions"], [[4], [1]]), sp("source_medium"), months);
  ok("sources are kept as written, an empty one as (not set)", sm.some((r) => r.key === "google / organic") && sm.some((r) => r.key === "(not set)"));

  const fp = parseReport(rep([["202607", "/c?x=1"], ["202607", "/c/"], ["202607", "(not set)"]], ["eventCount"], [[2], [3], [9]]), sp("form_page"), months);
  ok("form submissions are summed per normalised path into events", fp.length === 1 && fp[0]!.key === "/c" && fp[0]!.events === 5 && fp[0]!.sessions === null);
  const gp = parseReport(rep([["202607", "/plan-your-trip/advisor/ohio?q=1"]], ["sessions"], [[7]]), sp("group_page"), months);
  ok("a group's rows have the group's prefix as the parent", gp[0]!.parent === GROUP.prefix && gp[0]!.key === "/plan-your-trip/advisor/ohio");
  const en = parseReport(rep([["202607", "form_submit"], ["202607", "page_view"], ["202607", ""], ["202607", "Scroll"]], ["eventCount"], [[2], [90], [1], [4]]), sp("event_name"), months);
  ok("event names are kept verbatim as keys with events, nothing else", en.length === 4 && en.find((r) => r.key === "page_view")?.events === 90 && en.find((r) => r.key === "Scroll")?.events === 4 && en.every((r) => r.parent === "" && r.sessions === null && r.engagedSessions === null && r.engagementSeconds === null));
  ok("an empty event name reads as (not set), never as a path", en.some((r) => r.key === "(not set)"));
  ok("event_name asks for eventName and eventCount with no filter but the exclusion", (() => { const q = reportRequest(w, sp("event_name"), sp("event_name").ladder[0]!, []) as any; return q.dimensions.map((d: any) => d.name).join() === "yearMonth,eventName" && q.metrics.length === 1 && q.metrics[0].name === "eventCount" && !("dimensionFilter" in q) && !JSON.stringify(q).includes("totalUsers"); })());
  ok("event_name keeps the top 100 a month", TOP_N.event_name === 100);
  const gf = parseReport(rep([["202607", "/plan-your-trip/advisor/ohio"]], ["eventCount"], [[2]]), sp("group_form"), months);
  ok("a group's form rows carry events", gf[0]!.events === 2 && gf[0]!.parent === GROUP.prefix);

  // Top N per month.
  const mk = (month: string, i: number, kind: ReportRowOut["kind"] = "region"): ReportRowOut => ({ month, kind, parent: "US", key: `k${String(i).padStart(3, "0")}`, sessions: 1000 - i, engagedSessions: null, engagementSeconds: null, events: null });
  const rows = [...Array.from({ length: 130 }, (_, i) => mk("2026-07", i)), ...Array.from({ length: 40 }, (_, i) => mk("2026-08", i))];
  const t = topPerMonth(rows, "region");
  ok(`only the top ${TOP_N.region} of each month are kept`, t.kept.filter((r) => r.month === "2026-07").length === 100 && t.kept.filter((r) => r.month === "2026-08").length === 40 && t.cut === true);
  ok("the busiest are the ones kept", t.kept.some((r) => r.key === "k000") && !t.kept.some((r) => r.month === "2026-07" && r.key === "k129"));
  ok("nothing cut when every month is under the limit", topPerMonth(rows.slice(130), "region").cut === false);
  const gr = [...Array.from({ length: 320 }, (_, i) => ({ ...mk("2026-07", i, "group_page"), parent: "/a/" })), ...Array.from({ length: 320 }, (_, i) => ({ ...mk("2026-07", i, "group_page"), parent: "/b/" }))];
  const gt = topPerMonth(gr, "group_page");
  ok(`a group keeps ${TOP_N.group_page} per month for EACH group`, gt.kept.filter((r) => r.parent === "/a/").length === 300 && gt.kept.filter((r) => r.parent === "/b/").length === 300);
  const tie = topPerMonth([{ ...mk("2026-07", 1), sessions: 500 }, { ...mk("2026-07", 2), sessions: 999 }, { ...mk("2026-07", 3), sessions: 999, key: "a" }], "region", 2);
  ok("ties break by key so a rerun keeps the same rows", tie.kept.map((r) => r.key).join() === "a,k002", tie.kept.map((r) => r.key).join());
}

/* ═════════════════════════ 5. the daily series ═════════════════════════ */
hr("5. daily totals: explicit zeros only inside the span that was read");
{
  const w = readWindow(TODAY, MONTHS)!;
  const p = property(dataset());
  const r = await readClientReport(CTX, defaultConfig(), deps(p.fetch));
  const d = r.daily!;
  ok("the daily read succeeds", r.status === "ok" && !!d, r.status);
  ok("the span starts on the first day with traffic, not the window's first day", r.firstDay === "2026-06-10" && d[0]!.day === "2026-06-10", `${r.firstDay}`);
  ok("and ends on the window's last day", r.lastDay === w.end && d[d.length - 1]!.day === w.end);
  ok("NO day before the span or after its end is written", d.every((x) => x.day >= "2026-06-10" && x.day <= w.end) && !d.some((x) => x.day < "2026-06-10"));
  ok("one row per day with no gaps", d.length === daysBetween("2026-06-10", w.end).length);
  const zero = d.find((x) => x.day === "2026-06-12")!;
  ok("a quiet day inside the span is an explicit zero", zero.sessions === 0 && zero.engagedSessions === 0 && zero.engagementSeconds === 0 && zero.users === 0 && zero.keyEvents === 0);
  ok("the trailing quiet days to the window's end are zeros too", d.filter((x) => x.day > "2026-10-10").every((x) => x.sessions === 0));
  const first = d[0]!;
  ok("a busy day sums every row of the day", first.sessions === 10 + 5 + 4 + 50 && first.keyEvents === 1 && first.engagementSeconds === 445, JSON.stringify(first));
  ok("month keys of the run span run from the first day's month", r.firstMonth === "2026-06" && r.lastMonth === "2026-10" && r.months.join() === "2026-06,2026-07,2026-08,2026-09,2026-10");

  // The pure rule, on its own.
  const parsed = parseDaily({ metricHeaders: [{ name: "sessions" }], rows: [{ dimensionValues: [{ value: "20260102" }], metricValues: [{ value: "4" }] }, { dimensionValues: [{ value: "20260105" }], metricValues: [{ value: "2" }] }] });
  const pure = dailyRows(parsed, "2026-01-07")!;
  ok("pure: Jan 2 to Jan 7 is six rows, Jan 1 is not written", pure.rows.length === 6 && pure.rows[0]!.day === "2026-01-02" && !pure.rows.some((x) => x.day === "2026-01-01"));
  ok("pure: a metric the report did not carry stays null on a zero-filled day", pure.rows[1]!.sessions === 0 && pure.rows[1]!.engagedSessions === null && pure.rows[1]!.users === null && pure.rows[1]!.keyEvents === null);
  ok("pure: no rows at all is not a series", dailyRows(parseDaily({ rows: [] }), "2026-01-07") === null && dailyRows(parseDaily(undefined), "2026-01-07") === null);
  ok("pure: a row after the end is not written", dailyRows(parseDaily({ metricHeaders: [{ name: "sessions" }], rows: [{ dimensionValues: [{ value: "20260108" }], metricValues: [{ value: "9" }] }] }), "2026-01-07") === null);

  // The ladder.
  const noKey = property(dataset(), { reject: new Set(["keyEvents", "conversions"]) });
  const a = await readClientReport(CTX, defaultConfig(), deps(noKey.fetch));
  ok("a property that refuses key events gives a NULL column, not zeros", a.daily!.every((x) => x.keyEvents === null) && a.daily![0]!.sessions === 69 && a.daily![0]!.users === 68);
  ok("the ladder tried keyEvents, then conversions, then neither", noKey.calls.slice(0, 3).map((c) => (c.body.metrics as any[]).map((m) => m.name).join()).join(" | ").includes("conversions") && !(noKey.calls[2]!.body.metrics as any[]).some((m) => /keyEvents|conversions/.test(m.name)));
  const noUsers = property(dataset(), { reject: new Set(["keyEvents", "conversions", "totalUsers", "userEngagementDuration"]) });
  const b = await readClientReport(CTX, defaultConfig(), deps(noUsers.fetch));
  ok("a property that refuses more still answers with what it has, the rest null", b.daily![0]!.sessions === 69 && b.daily![0]!.engagementSeconds === null && b.daily![0]!.users === null && b.daily![0]!.engagedSessions === 12);
  ok("a dropped metric on a zero-filled day is null, a kept one is zero", b.daily!.find((x) => x.day === "2026-06-12")!.engagementSeconds === null && b.daily!.find((x) => x.day === "2026-06-12")!.sessions === 0);
  ok("the ladders start with the fullest rung", DAILY_METRIC_LADDER[0]!.length === 5 && SESSION_METRIC_LADDER[0]!.length === 3);
  const countries = await readClientReport(CTX, cfg({ excludeCountries: ["India"] }), deps(property(dataset()).fetch));
  ok("with a country excluded the daily total leaves that traffic out", countries.daily![0]!.sessions === 19 && countries.daily!.find((x) => x.day === "2026-10-10")!.sessions === 6, JSON.stringify(countries.daily![0]));
}

/* ═════════════════════════ 6. a whole run ═════════════════════════ */
hr("6. a whole run against the pretend property");
{
  const excl = cfg({ excludeCountries: ["India"], groups: [GROUP] });
  const p = property(dataset());
  const r = await readClientReport(CTX, excl, deps(p.fetch));
  ok("the run is ok", r.status === "ok" && r.failedKinds.length === 0, `${r.status} ${r.detail ?? ""}`);
  const region = r.kinds.region!;
  ok("regions: the excluded country is absent everywhere", !region.some((x) => x.parent === "India") && region.some((x) => x.parent === "United States" && x.key === "Ohio" && x.month === "2026-06"));
  ok("regions: (not set) is its own key", region.some((x) => x.key === "(not set)" && x.parent === "United States"));
  const lps = r.kinds.landing_page!;
  ok("landing pages: spellings summed, (not set) not a page, query gone", lps.find((x) => x.month === "2026-06" && x.key === "/plan-your-trip/advisor/ohio")?.sessions === 23 && !lps.some((x) => x.key === "(not set)" || x.key.includes("?")));
  ok("sources: source / medium keys", r.kinds.source_medium!.some((x) => x.key === "google / organic" && x.month === "2026-06"));
  ok("form pages: only the form event, the excluded country's submissions left out", r.kinds.form_page!.some((x) => x.key === "/plan-your-trip/advisor/ohio" && x.events === 4 && x.month === "2026-06") && !r.kinds.form_page!.some((x) => x.key === "/contact" && x.month === "2026-07"));
  ok("form pages: another event name is not read", !r.kinds.form_page!.some((x) => x.key === "/lp/spring"));
  ok("group pages: only paths under the prefix, parent is the prefix", r.kinds.group_page!.length > 0 && r.kinds.group_page!.every((x) => x.parent === GROUP.prefix && x.key.startsWith("/plan-your-trip/advisor/")));
  ok("group forms: under the prefix and the form event", r.kinds.group_form!.length > 0 && r.kinds.group_form!.every((x) => x.parent === GROUP.prefix && (x.events ?? 0) > 0));
  ok("event names: every event the property counts, excluded country left out, per month", (() => { const e = r.kinds.event_name!; return e.some((x) => x.key === "page_view" && x.month === "2026-06" && x.events === 99) && e.some((x) => x.key === "form_submit" && x.month === "2026-07" && x.events === 2) && e.some((x) => x.key === "lead_form") && !e.some((x) => x.key === "form_submit" && x.month === "2026-07" && (x.events ?? 0) > 2); })());
  const withOverride = await readClientReport(CTX, cfg({ formEvent: "lead_form" }), deps(property(dataset()).fetch));
  ok("a configured form event is the one counted", withOverride.kinds.form_page!.length === 1 && withOverride.kinds.form_page![0]!.key === "/lp/spring" && withOverride.kinds.form_page![0]!.events === 5);
  const noGroups = await readClientReport(CTX, defaultConfig(), deps(property(dataset()).fetch));
  ok("with no groups the group kinds are read in full as nothing (so a removed group's rows clear)", Array.isArray(noGroups.kinds.group_page) && noGroups.kinds.group_page!.length === 0 && Array.isArray(noGroups.kinds.group_form) && noGroups.kinds.group_form!.length === 0);
  ok("the config this run applied is on the result", r.config.excludeCountries.join() === "India" && r.config.groups.length === 1 && r.config.formEvent === "form_submit");
  ok("the row count is the daily plus every kept row", r.rows === r.daily!.length + Object.values(r.kinds).reduce((n, l) => n + (l?.length ?? 0), 0));
  ok("no request is made twice", new Set(p.calls.map((c) => JSON.stringify(c.body))).size === p.calls.length);

  // No property.
  const off = await readClientReport({ ...CTX, ga4Property: null }, defaultConfig(), deps(property(dataset()).fetch));
  ok("no property: status off, one sentence, nothing read", off.status === "off" && off.detail === "No analytics property is connected for this account." && off.daily === null && off.rows === 0);
  // Empty property.
  const empty = await readClientReport(CTX, defaultConfig(), deps(property({ sessions: [], events: [] }).fetch));
  ok("a property with no visits: no_data, nothing to write", empty.status === "no_data" && empty.daily === null && Object.keys(empty.kinds).length === 0);
  // Token failure.
  const tokenFail = await readClientReport(CTX, defaultConfig(), deps(property(dataset()).fetch, { token: async () => { throw new Error("Google refused the service account (401)."); } }));
  ok("a token that cannot be minted is an error with the plain message", tokenFail.status === "error" && /refused/.test(tokenFail.detail ?? "") && tokenFail.daily === null);
}

/* ═════════════════════════ 7. a failure is contained ═════════════════════════ */
hr("7. failures: a kind that fails keeps its rows; a daily failure writes nothing");
{
  const failRegion = property(dataset(), { fail: (b) => ((b.dimensions as any[]).some((d) => d.name === "region") ? { status: 403, body: "no region for you" } : null) });
  const r = await readClientReport(CTX, cfg({ groups: [GROUP] }), deps(failRegion.fetch));
  ok("a failed kind is named and absent from the rows to replace", r.failedKinds.join() === "region" && r.kinds.region === undefined && r.kinds.source_medium !== undefined && r.kinds.landing_page !== undefined);
  ok("the daily totals are still kept and the status is ok with the failure said", r.status === "ok" && r.daily!.length > 0 && /region/.test(r.detail ?? ""));
  ok("a 403 is not retried", failRegion.calls.filter((c) => (c.body.dimensions as any[]).some((d) => d.name === "region")).length === 1);

  const failDaily = property(dataset(), { fail: (b) => ((b.dimensions as any[]).length === 1 && (b.dimensions as any[])[0].name === "date" ? { status: 403, body: "denied" } : null) });
  const d = await readClientReport(CTX, cfg({ groups: [GROUP] }), deps(failDaily.fetch));
  ok("a failed daily read is an error with nothing to write", d.status === "error" && d.daily === null && Object.keys(d.kinds).length === 0 && d.rows === 0);
  ok("and nothing else is even asked for", failDaily.calls.length === 1);

  const failAll = property(dataset(), { fail: (b) => ((b.dimensions as any[])[0].name === "yearMonth" ? { status: 403, body: "denied" } : null) });
  const all = await readClientReport(CTX, defaultConfig(), deps(failAll.fetch));
  ok("every report failing is an error, the daily totals still written", all.status === "error" && all.daily!.length > 0 && all.failedKinds.length === 8);

  // Retries.
  let n = 0;
  const flaky = property(dataset(), { fail: () => (n++ < 2 ? { status: 503, body: "busy" } : null) });
  const waits: number[] = [];
  const f = await readClientReport(CTX, defaultConfig(), deps(flaky.fetch, { sleep: async (ms) => { waits.push(ms); } }));
  ok("a 503 is retried with a wait and the run still succeeds", f.status === "ok" && waits.length >= 2 && waits[0] === RETRY_WAITS_MS[0] && waits[1] === RETRY_WAITS_MS[1], waits.join());
  let m = 0;
  const limited = property(dataset(), { fail: () => (m++ < 1 ? { status: 429, body: "slow down" } : null) });
  ok("a 429 is retried too", (await readClientReport(CTX, defaultConfig(), deps(limited.fetch))).status === "ok");
  const dead = property(dataset(), { fail: () => ({ status: 500, body: "down" }) });
  const dw: number[] = [];
  const dd = await readClientReport(CTX, defaultConfig(), deps(dead.fetch, { sleep: async (ms) => { dw.push(ms); } }));
  ok("a property that stays down is retried a bounded number of times, then an error", dd.status === "error" && dead.calls.length === 1 + RETRY_WAITS_MS.length, `${dead.calls.length} calls`);
  ok("the retry predicate: 429 and 5xx and a dropped connection yes, 400 and 403 no", isRetryable(new HttpError(429, "", "x")) && isRetryable(new HttpError(502, "", "x")) && isRetryable(new TypeError("fetch failed")) && !isRetryable(new HttpError(400, "", "x")) && !isRetryable(new HttpError(403, "", "x")));
  const pauses: number[] = [];
  const paced = property(dataset());
  await readClientReport(CTX, defaultConfig(), deps(paced.fetch, { pauseMs: 450, sleep: async (ms) => { pauses.push(ms); } }));
  ok("one request at a time with a pause between calls, none before the first", pauses.length === paced.calls.length - 1 && pauses.length > 0 && pauses.every((x) => x === 450), `${pauses.length} pauses, ${paced.calls.length} calls`);

  // Paging and ceilings.
  const big: Dataset = { sessions: Array.from({ length: 30 }, (_, i) => S(`202607${String((i % 28) + 1).padStart(2, "0")}`, "United States", `R${i}`, "google / organic", "/", 1)), events: [] };
  const paged = property(big, { pageCap: 7 });
  const pr = await readClientReport(CTX, defaultConfig(), deps(paged.fetch));
  ok("a property that gives a few rows a page is paged with offset until complete", pr.status === "ok" && pr.kinds.region!.length === 30 && paged.calls.some((c) => Number(c.body.offset) >= 7), `${paged.calls.length} calls`);
  ok("each page asks the declared page size", paged.calls.every((c) => c.body.limit === PAGE_SIZE));
  ok("the ceiling and page size are sane", ROW_CEILING >= PAGE_SIZE * 2 && ROW_CEILING <= 1_000_000);
  // A report too big to read in full: pretend the property always has more.
  const endless: FetchLike = async (_u, init) => {
    const b = JSON.parse(init?.body ?? "{}");
    const dims = (b.dimensions as any[]).map((x) => x.name);
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) => ({ dimensionValues: dims.map((dn) => ({ value: dn === "yearMonth" ? "202607" : dn === "date" ? "20260701" : `v${b.offset}-${i}` })), metricValues: [{ value: "1" }] }));
    return { ok: true, status: 200, text: async () => JSON.stringify({ dimensionHeaders: dims.map((name) => ({ name })), metricHeaders: [{ name: "sessions" }], rows, rowCount: ROW_CEILING * 5 }) };
  };
  const eb = await readClientReport(CTX, defaultConfig(), deps(endless, { months: 1 }));
  ok("a daily read past the ceiling is `capped` and writes nothing for the client", eb.status === "capped" && eb.daily === null && eb.rows === 0);
  const halfEndless: FetchLike = async (u, init) => {
    const b = JSON.parse(init?.body ?? "{}");
    if ((b.dimensions as any[]).length === 1) return property(dataset()).fetch(u, init);
    return endless(u, init);
  };
  const hb = await readClientReport(CTX, defaultConfig(), deps(halfEndless));
  ok("reports past the ceiling are `capped`, named failed and left untouched, never written cut", hb.status === "capped" && hb.failedKinds.length === 7 && hb.daily!.length > 0 && hb.kinds.region === undefined);
}

/* ═════════════════════════ 8. no secret and no row text in anything said ═════════════════════════ */
hr("8. nothing secret or per-row in an error, a detail or a log");
{
  const leaky = property(dataset(), { fail: (b) => ((b.dimensions as any[]).some((d) => d.name === "sessionSourceMedium") ? { status: 400, body: `bad request for token ${SECRET} and key=${SECRET}` } : null) });
  const r = await readClientReport(CTX, defaultConfig(), deps(leaky.fetch));
  ok("a Google error that echoes the token is scrubbed in the detail", !(r.detail ?? "").includes(SECRET) && /\[secret\]/.test(r.detail ?? ""), r.detail ?? "");
  ok("safeMessage removes a token, a key and a query-string key", !safeMessage(new Error(`x ${SECRET} y`), [SECRET]).includes(SECRET) && !/abc123/.test(safeMessage(new Error("https://x?key=abc123&z=1"))));
  ok("a long error is cut", safeMessage(new Error("x".repeat(900))).length <= 240);
  const tokenErr = await readClientReport(CTX, defaultConfig(), deps(property(dataset()).fetch, { token: async () => { throw new Error(`could not mint ${SECRET}`); } }));
  ok("a token failure message is cleaned by the same function", typeof tokenErr.detail === "string");

  // Logs of a real (non-dry) run and of a dry run.
  const out: string[] = [];
  const oldLog = console.log, oldErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  const rec = recorder();
  const live = await processClients({ clients: [{ id: "client-a", name: "Alpine Travel Test", property: "111222333" }, { id: "client-b", name: "No Property Co", property: null }], settings: new Map([[configKey("client-a"), JSON.stringify({ groups: [GROUP] })]]), deps: deps(leaky.fetch), db: rec.db, dryRun: false });
  const dry = await processClients({ clients: [{ id: "client-a", name: "Alpine Travel Test", property: "111222333" }], settings: new Map([[configKey("client-a"), JSON.stringify({ groups: [GROUP] })]]), deps: deps(property(dataset()).fetch), db: rec.db, dryRun: true });
  console.log = oldLog; console.error = oldErr;
  const allText = [...live.lines, ...live.casualties, live.summary, ...dry.lines, dry.summary, ...out].join("\n");
  ok("no run output contains the token", !allText.includes(SECRET));
  const everyKey = new Set<string>();
  {
    const full = await readClientReport(CTX, cfg({ groups: [GROUP] }), deps(property(dataset()).fetch));
    for (const list of Object.values(full.kinds)) for (const row of list ?? []) { everyKey.add(row.key); if (row.parent) everyKey.add(row.parent); }
  }
  const liveText = live.lines.join("\n");
  ok("a live run prints no key at all (no path, region, source or event name)", everyKey.size > 20 && Array.from(everyKey).every((k) => !liveText.includes(k)), `${everyKey.size} keys checked`);
  ok("a dry run prints at most five keys per list", dry.lines.filter((l) => /first keys:/.test(l)).every((l) => l.split("first keys: ")[1]!.split(" | ").length <= 5) && dry.lines.some((l) => /first keys:/.test(l)));
  ok("a dry run prints counts per kind", REPORT_KINDS.every((k) => dry.lines.some((l) => l.includes(`  ${k}: `))));
  ok("a dry run prints no metric value or per-row numbers beyond counts", !dry.lines.some((l) => /sessions=|engaged|\b445\b/.test(l)));
  ok("a casualty is listed for the failed client, and the summary counts accounts", live.casualties.length >= 1 && /1 account/.test(live.summary) && /1 without a property/.test(live.summary), live.summary);
}

/* ═════════════════════════ 9. what is written ═════════════════════════ */
hr("9. the writes, as text and as parameters");
function recorder() {
  const q: Array<{ sql: string; params: unknown[] }> = [];
  const db: Queryable = { query: async (sql, params = []) => { q.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
  return { db, q };
}
const kindOf = (sql: string) => (/^INSERT INTO ga4_site_days/.test(sql) ? "day" : /^INSERT INTO ga4_report_rows/.test(sql) ? "row" : /^INSERT INTO ga4_report_runs/.test(sql) ? "run" : /^DELETE FROM ga4_report_rows/.test(sql) ? "delete" : sql.trim());
{
  const cl = async (o: Record<string, unknown>, opts: Opts = {}) => readClientReport(CTX, cfg(o), deps(property(dataset(), opts).fetch));
  const ok1 = await cl({ excludeCountries: ["India"], groups: [GROUP] });
  const rec = recorder();
  const at = new Date("2026-10-14T07:40:00Z");
  const w = await writeClientReport(rec.db, "client-a", ok1, at);
  const seq = rec.q.map((x) => kindOf(x.sql));
  ok("one transaction: BEGIN first, COMMIT last", w.ok && seq[0] === "BEGIN" && seq[seq.length - 1] === "COMMIT");
  ok("the run row is written last before the commit", seq[seq.length - 2] === "run");
  const delIdx = (k: string) => rec.q.findIndex((x) => kindOf(x.sql) === "delete" && x.params[1] === k);
  ok("every kind that read in full is deleted for the months read, before its rows", REPORT_KINDS.every((k) => delIdx(k) >= 0));
  ok("each delete names the client, the kind and the months read", rec.q.filter((x) => kindOf(x.sql) === "delete").every((x) => x.params[0] === "client-a" && JSON.stringify(x.params[2]) === JSON.stringify(ok1.months)));
  ok("a kind's rows come after its delete and before the next kind's", REPORT_KINDS.every((k, i) => { const d = delIdx(k); const rowsOf = rec.q.map((x, j) => ({ x, j })).filter(({ x }) => kindOf(x.sql) === "row" && x.params[3] === k); return rowsOf.every(({ j }) => j > d) && (i === REPORT_KINDS.length - 1 || rowsOf.every(({ j }) => j < delIdx(REPORT_KINDS[i + 1]!))); }));
  ok("daily rows are upserts keyed on client and day", rec.q.filter((x) => kindOf(x.sql) === "day").length === ok1.daily!.length && /ON CONFLICT \(client_id, day\)/.test(INSERT_SITE_DAY));
  const run = rec.q.find((x) => kindOf(x.sql) === "run")!;
  ok("the run row records the applied config as the contract says", run.params[11] === JSON.stringify(["India"]) && run.params[12] === "form_submit" && run.params[13] === JSON.stringify([GROUP]));
  ok("the run row records the spans and rows", run.params[4] === ok1.firstDay && run.params[5] === ok1.lastDay && run.params[6] === "2026-06" && run.params[7] === "2026-10" && run.params[8] === ok1.rows);
  ok("a fixed id per row so a rerun is the same row", new Set(rec.q.filter((x) => kindOf(x.sql) === "row").map((x) => x.params[0])).size === rec.q.filter((x) => kindOf(x.sql) === "row").length);

  // A failed kind is never deleted.
  const failedRegion = await cl({}, { fail: (b) => ((b.dimensions as any[]).some((d) => d.name === "region") ? { status: 403, body: "no" } : null) });
  const r2 = recorder();
  await writeClientReport(r2.db, "client-a", failedRegion, at);
  ok("a kind that FAILED is not deleted and not written", !r2.q.some((x) => kindOf(x.sql) === "delete" && x.params[1] === "region") && !r2.q.some((x) => kindOf(x.sql) === "row" && x.params[3] === "region"));
  ok("the other kinds still are", r2.q.some((x) => kindOf(x.sql) === "delete" && x.params[1] === "source_medium"));
  const run2 = r2.q.find((x) => kindOf(x.sql) === "run")!;
  ok("and the run row names the failed kind", run2.params[10] === "region");

  // A failed daily read writes the run row only, and keeps the earlier span.
  const failedDaily = await cl({}, { fail: (b) => ((b.dimensions as any[]).length === 1 ? { status: 403, body: "no" } : null) });
  const r3 = recorder();
  await writeClientReport(r3.db, "client-a", failedDaily, at);
  const kinds3 = r3.q.map((x) => kindOf(x.sql));
  ok("a failed daily read writes no day, no row and no delete", !kinds3.includes("day") && !kinds3.includes("row") && !kinds3.includes("delete"), kinds3.join());
  ok("only the run row is written, and it keeps the earlier span and config", kinds3.filter((k) => k === "run").length === 1 && r3.q.find((x) => kindOf(x.sql) === "run")!.sql === INSERT_RUN_KEEP && !/first_day = EXCLUDED/.test(INSERT_RUN_KEEP) && !/excluded_countries = EXCLUDED/.test(INSERT_RUN_KEEP));
  const failedCfg = await cl({ excludeCountries: ["India"] });
  ok("a run that wrote rows replaces the span and the config", (INSERT_RUN as string) !== (INSERT_RUN_KEEP as string) && /first_day = EXCLUDED\.first_day/.test(INSERT_RUN) && /excluded_countries = EXCLUDED\.excluded_countries/.test(INSERT_RUN) && failedCfg.daily !== null);

  // A write that fails rolls back and says error.
  const boom: Queryable = { query: async (sql) => { if (/^INSERT INTO ga4_report_rows/.test(sql)) throw new Error("disk full"); return {}; } };
  const calls: string[] = [];
  const spy: Queryable = { query: async (sql, p) => { calls.push(kindOf(sql)); return boom.query(sql, p); } };
  const wr = await writeClientReport(spy, "client-a", ok1, at);
  ok("a failing write rolls back and writes an error run row, never ok", !wr.ok && calls.includes("ROLLBACK") && !calls.includes("COMMIT") && calls[calls.length - 1] === "run");

  // The dry run writes nothing at all.
  const r4 = recorder();
  const dry = await processClients({ clients: [{ id: "client-a", name: "Alpine Travel Test", property: "111222333" }], settings: new Map(), deps: deps(property(dataset()).fetch), db: r4.db, dryRun: true });
  ok("a dry run makes no query at all", r4.q.length === 0 && dry.answered === 1);
  const r5 = recorder();
  await processClients({ clients: [{ id: "client-a", name: "Alpine Travel Test", property: "111222333" }], settings: new Map(), deps: deps(property(dataset()).fetch), db: r5.db, dryRun: false });
  ok("a real run does write", r5.q.length > 10);

  // Literals read by the app's wiring check.
  for (const [name, sql] of [["INSERT_SITE_DAY", INSERT_SITE_DAY], ["INSERT_REPORT_ROW", INSERT_REPORT_ROW], ["INSERT_RUN", INSERT_RUN], ["INSERT_RUN_KEEP", INSERT_RUN_KEEP]] as const) {
    const cols = /\(([^)]*)\)\s*VALUES/s.exec(sql)![1]!.split(",").map((c) => c.trim());
    const params = (sql.match(/\$\d+/g) ?? []).filter((v, i, a) => a.indexOf(v) === i).length;
    ok(`${name}: one parameter per column`, params === cols.length, `${cols.length} columns, ${params} parameters`);
  }
  ok("the delete is scoped to the client, the kind and the months", /WHERE client_id = \$1 AND kind = \$2 AND month = ANY\(\$3::text\[\]\)/.test(DELETE_KIND_MONTHS));
  const colsOf = (sql: string) => /\(([^)]*)\)\s*VALUES/s.exec(sql)![1]!.split(",").map((c) => c.trim());
  ok("the day columns are the contract's", colsOf(INSERT_SITE_DAY).join() === "id,client_id,day,sessions,engaged_sessions,engagement_seconds,users,key_events,synced_at");
  ok("the row columns are the contract's", colsOf(INSERT_REPORT_ROW).join() === "id,client_id,month,kind,parent,key,sessions,engaged_sessions,engagement_seconds,events,synced_at");
  ok("the run columns are the contract's", colsOf(INSERT_RUN).join() === "id,client_id,status,detail,first_day,last_day,first_month,last_month,rows,capped_kinds,failed_kinds,excluded_countries,form_event,groups_json,ran_at,excluded_channels");
}

/* ═════════════════════════ 10. the workflow and the wiring ═════════════════════════ */
hr("10. the workflow, the scripts and CI");
{
  const here = path.dirname(new URL(import.meta.url).pathname);
  const root = path.join(here, "..");
  const wf = fs.readFileSync(path.join(root, ".github/workflows/read-ga4-report.yml"), "utf8");
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const cli = fs.readFileSync(path.join(here, "read-ga4-report.ts"), "utf8");
  const runLines = (text: string) => text.split("\n").filter((l) => /^\s+run:/.test(l) || /^\s{12,}\S/.test(l)).join("\n");

  ok("daily at 07:40 UTC", /cron: "40 7 \* \* \*"/.test(wf));
  ok("a dispatch has client_id and a dry_run input that defaults to true", /client_id:[\s\S]{0,200}default: ""/.test(wf) && /dry_run:[\s\S]{0,200}default: "true"/.test(wf));
  ok("a scheduled run is live (dry only when the input says true)", /\[ "\$DRY_RUN" = "true" \] && ARGS="\$ARGS --dry-run"/.test(wf));
  ok("inputs reach the command through the environment", /CLIENT_ID: \$\{\{ inputs\.client_id \}\}/.test(wf) && !/run:[^\n]*\$\{\{ inputs\./.test(wf));
  selfTest("the heartbeat step is conditional on a live whole-book run", (t) => /if: always\(\) && inputs\.dry_run != 'true' && inputs\.client_id == ''/.test(t), "if: always() && inputs.dry_run != 'true' && inputs.client_id == ''", "if: always()");
  ok("the heartbeat step is conditional on a live whole-book run", /Heartbeat\n\s+if: always\(\) && inputs\.dry_run != 'true' && inputs\.client_id == ''/.test(wf));
  ok("the heartbeat names the job read_ga4_report", /--job=read_ga4_report/.test(wf));
  selfTest("the heartbeat note is never interpolated into the shell", (t) => !/run:[^\n]*\$\{\{ *steps\./.test(t) && /NOTE: \$\{\{ steps\.run\.outputs\.summary \}\}/.test(t), "env:\n NOTE: ${{ steps.run.outputs.summary }}\nrun: npm run heartbeat -- --note=\"$NOTE\"", "run: npm run heartbeat -- --note=\"${{ steps.run.outputs.summary }}\"");
  ok("the heartbeat note is never interpolated into the shell", !/run:[^\n]*\$\{\{ *steps\./.test(wf) && /NOTE: \$\{\{ steps\.run\.outputs\.summary \}\}/.test(wf) && !/\$\{\{ *steps\.[^}]*\}\}/.test(runLines(wf)));
  ok("the heartbeat passes the run's log so a failure says why", /--log=run\.log/.test(wf) && /tee run\.log/.test(wf));
  ok("the run does not overlap itself", /concurrency:[\s\S]{0,120}cancel-in-progress: false/.test(wf));
  ok("it needs only the two existing secrets", /DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/.test(wf) && /GOOGLE_SERVICE_ACCOUNT_JSON: \$\{\{ secrets\.GOOGLE_SERVICE_ACCOUNT_JSON \}\}/.test(wf) && (wf.match(/secrets\.[A-Z_]+/g) ?? []).every((s) => /DATABASE_URL|GOOGLE_SERVICE_ACCOUNT_JSON/.test(s)));
  ok("npm scripts exist", pkg.scripts["read-ga4-report"] === "tsx src/read-ga4-report.ts" && pkg.scripts["verify-ga4-report"] === "tsx src/verify-ga4-report.ts");
  {
    const cut = ci.indexOf("ads-store:");
    ok("CI runs the guard in the main job and again, against a real database, in the store job", cut > 0 && /npm run verify-ga4-report/.test(ci.slice(0, cut)) && /npm run verify-ga4-report/.test(ci.slice(cut)));
  }
  ok("the command sums the summary to the workflow output", /GITHUB_OUTPUT/.test(cli) && /summary=/.test(cli));
  ok("the command exits non-zero only when no client with a property could be read", /if \(pipe\.allFailed\)/.test(cli) && fs.readFileSync(path.join(here, "ga4-report/pipeline.ts"), "utf8").includes("res.attempted > 0 && res.answered === 0"));
  ok("the command creates no table", ![cli, ...fs.readdirSync(path.join(here, "ga4-report")).map((f) => fs.readFileSync(path.join(here, "ga4-report", f), "utf8"))].some((t) => /CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX/i.test(t)));
  const wiringSources = fs.readdirSync(path.join(here, "ga4-report")).map((f) => fs.readFileSync(path.join(here, "ga4-report", f), "utf8")).join("\n");
  const written = Array.from(wiringSources.matchAll(/(?:INSERT INTO|DELETE FROM|UPDATE)\s+([a-z0-9_]+)/g)).map((m) => m[1]!);
  ok("the only tables written are the three (the heartbeat is stamped by the workflow)", written.length > 0 && written.every((t) => ["ga4_site_days", "ga4_report_rows", "ga4_report_runs"].includes(t)), Array.from(new Set(written)).join());
  {
    const p = property(dataset());
    await readClientReport(CTX, cfg({ groups: [GROUP], excludeCountries: ["India"] }), deps(p.fetch));
    const used = new Set(p.calls.flatMap((c) => (c.body.dimensions as Array<{ name: string }>).map((d) => d.name)));
    const allowed = new Set(["date", "yearMonth", "country", "region", "sessionSourceMedium", "landingPage", "pagePath", "eventName", "sessionDefaultChannelGroup"]);
    ok("no visitor-level dimension is ever requested (only dates, places, sources and pages)", Array.from(used).every((n) => allowed.has(n)), Array.from(used).join());
    const metricsUsed = new Set(p.calls.flatMap((c) => (c.body.metrics as Array<{ name: string }>).map((m) => m.name)));
    ok("and only counts are asked for", Array.from(metricsUsed).every((n) => ["sessions", "engagedSessions", "userEngagementDuration", "totalUsers", "keyEvents", "eventCount"].includes(n)), Array.from(metricsUsed).join());
  }
  ok("Google is read, never written: only runReport is ever called", !/batchRunReports|:batchRun|PATCH|PUT\b|DELETE\b/.test(fs.readFileSync(path.join(here, "ga4-report/ga4.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")) && /:runReport/.test(wiringSources));
}

/* ═════════════════════════ 11. the real store ═════════════════════════ */
const dbUrl = process.env.ADS_VERIFY_DATABASE_URL;
if (!dbUrl) {
  hr("11. the real store, on a throwaway schema");
  console.log("  ⏭  skipped: ADS_VERIFY_DATABASE_URL is not set. CI runs this section in the `ads-store` job against a Postgres service container.");
} else {
  await storeSection(dbUrl);
}

async function storeSection(url: string) {
  hr("11. the real store, on a throwaway schema");
  const schema = `ga4rep_${Math.random().toString(36).slice(2, 10)}`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await c.query(DDL);
    await c.query(`INSERT INTO clients VALUES ('client-a'), ('client-b')`);
    const at = new Date("2026-10-14T07:40:00Z");
    const count = async (sql: string, p: unknown[] = []) => Number(((await c.query(sql, p)).rows[0] as { n: string }).n);
    const run = async (o: Record<string, unknown>, opts: Opts = {}, id = "client-a") => {
      const r = await readClientReport({ ...CTX, id }, cfg(o), deps(property(dataset(), opts).fetch));
      return { r, w: await writeClientReport(c, id, r, at) };
    };

    const first = await run({ excludeCountries: ["India"], groups: [GROUP] });
    ok("the first run writes", first.w.ok);
    const days = await count(`SELECT count(*) AS n FROM ga4_site_days WHERE client_id = 'client-a'`);
    ok("one row per day of the span", days === first.r.daily!.length, `${days}`);
    ok("no day outside the span", (await count(`SELECT count(*) AS n FROM ga4_site_days WHERE day < '2026-06-10' OR day > '2026-10-12'`)) === 0);
    const nullKey = (await c.query(`SELECT key_events FROM ga4_site_days WHERE day = '2026-06-12'`)).rows[0] as { key_events: number | null };
    ok("a zero-filled day is a stored zero", nullKey.key_events === 0);
    const rows1 = await count(`SELECT count(*) AS n FROM ga4_report_rows WHERE client_id = 'client-a'`);
    const run1 = (await c.query(`SELECT * FROM ga4_report_runs WHERE client_id = 'client-a'`)).rows[0] as Record<string, unknown>;
    ok("the run row is ok with the applied config", run1.status === "ok" && run1.excluded_countries === JSON.stringify(["India"]) && run1.form_event === "form_submit" && run1.groups_json === JSON.stringify([GROUP]) && run1.rows === first.r.rows);
    ok("the run row's spans are the daily and the month spans", run1.first_day === "2026-06-10" && run1.last_day === "2026-10-12" && run1.first_month === "2026-06" && run1.last_month === "2026-10");

    // A row of a month this run did not read (an older month, kept from a longer read) is never touched.
    await c.query(`INSERT INTO ga4_report_rows (id, client_id, month, kind, parent, key, sessions) VALUES ('old1', 'client-a', '2025-01', 'landing_page', '', '/old-month', 7), ('old2', 'client-a', '2026-07', 'landing_page', '', '/other-clients-twin', 1)`);
    await c.query(`INSERT INTO ga4_report_rows (id, client_id, month, kind, parent, key, sessions) VALUES ('oldb', 'client-b', '2026-07', 'landing_page', '', '/belongs-to-b', 3)`);
    await run({ excludeCountries: ["India"], groups: [GROUP] });
    ok("a month the run did not read keeps its rows", (await count(`SELECT count(*) AS n FROM ga4_report_rows WHERE id = 'old1'`)) === 1);
    ok("a month the run did read is replaced whole (a stray row in it is gone)", (await count(`SELECT count(*) AS n FROM ga4_report_rows WHERE id = 'old2'`)) === 0);
    ok("another client's rows are never touched", (await count(`SELECT count(*) AS n FROM ga4_report_rows WHERE id = 'oldb'`)) === 1);

    // A second identical run adds nothing.
    await run({ excludeCountries: ["India"], groups: [GROUP] });
    ok("a rerun adds no row and removes none", (await count(`SELECT count(*) AS n FROM ga4_report_rows WHERE client_id = 'client-a' AND id NOT IN ('old1')`)) === rows1 && (await count(`SELECT count(*) AS n FROM ga4_site_days WHERE client_id = 'client-a'`)) === days);

    // GA4 restates a month: a path that had visits no longer does, and a new one appears. The month is replaced whole.
    const before = (await c.query(`SELECT key FROM ga4_report_rows WHERE client_id='client-a' AND kind='landing_page' AND month='2026-07' ORDER BY key`)).rows.map((x) => (x as { key: string }).key);
    const restated = dataset();
    restated.sessions = restated.sessions.filter((s) => !(s.date === "20260705" && s.landing.includes("cincinnati"))).concat(S("20260706", "United States", "Ohio", "google / organic", "/brand-new", 3));
    const r6 = await readClientReport(CTX, cfg({ excludeCountries: ["India"], groups: [GROUP] }), deps(property(restated).fetch));
    await writeClientReport(c, "client-a", r6, at);
    const after = (await c.query(`SELECT key FROM ga4_report_rows WHERE client_id='client-a' AND kind='landing_page' AND month='2026-07' ORDER BY key`)).rows.map((x) => (x as { key: string }).key);
    ok("a restated month replaces itself (a vanished path is gone, a new one is there)", before.includes("/plan-your-trip/advisor/cincinnati") && !after.includes("/plan-your-trip/advisor/cincinnati") && after.includes("/brand-new"), `${before.join()} -> ${after.join()}`);
    ok("other months are untouched by a restated month's content", (await count(`SELECT count(*) AS n FROM ga4_report_rows WHERE client_id='client-a' AND kind='landing_page' AND month='2026-08'`)) > 0);

    // A removed group's rows are cleared when no group is configured.
    await run({});
    ok("removing every group clears the group rows", (await count(`SELECT count(*) AS n FROM ga4_report_rows WHERE client_id='client-a' AND kind IN ('group_page','group_form')`)) === 0);
    const run2 = (await c.query(`SELECT excluded_countries, groups_json FROM ga4_report_runs WHERE client_id='client-a'`)).rows[0] as Record<string, string>;
    ok("and the run row now says no exclusion and no groups were applied", run2.excluded_countries === "[]" && run2.groups_json === "[]");
    ok("with the exclusion lifted the excluded country's regions return", (await count(`SELECT count(*) AS n FROM ga4_report_rows WHERE client_id='client-a' AND kind='region' AND parent='India'`)) > 0);

    // A failed kind leaves its earlier rows exactly as they were.
    const regionBefore = (await c.query(`SELECT id, key, sessions, synced_at FROM ga4_report_rows WHERE client_id='client-a' AND kind='region' ORDER BY id`)).rows;
    const lateAt = new Date("2026-10-15T07:40:00Z");
    const failRegion = await readClientReport(CTX, cfg({ excludeCountries: ["India"] }), deps(property(dataset(), { fail: (b) => ((b.dimensions as any[]).some((d) => d.name === "region") ? { status: 403, body: "no" } : null) }).fetch));
    await writeClientReport(c, "client-a", failRegion, lateAt);
    const regionAfter = (await c.query(`SELECT id, key, sessions, synced_at FROM ga4_report_rows WHERE client_id='client-a' AND kind='region' ORDER BY id`)).rows;
    ok("a failed kind keeps its earlier rows byte for byte (even though the exclusion changed)", JSON.stringify(regionBefore) === JSON.stringify(regionAfter) && regionBefore.length > 0);
    ok("while the kinds that read are replaced", (await count(`SELECT count(*) AS n FROM ga4_report_rows WHERE client_id='client-a' AND kind='source_medium' AND synced_at = $1`, [lateAt])) > 0);
    const run3 = (await c.query(`SELECT failed_kinds, status FROM ga4_report_runs WHERE client_id='client-a'`)).rows[0] as Record<string, string>;
    ok("the run row names the failed kind", run3.failed_kinds === "region" && run3.status === "ok");

    // A failed daily read writes nothing but the run row, which keeps the span and config of the last good run.
    const spanBefore = (await c.query(`SELECT first_day, last_day, first_month, last_month, excluded_countries, groups_json FROM ga4_report_runs WHERE client_id='client-a'`)).rows[0];
    const daysBefore = await count(`SELECT count(*) AS n FROM ga4_site_days`);
    const rowsBefore = await count(`SELECT count(*) AS n FROM ga4_report_rows`);
    await run({ excludeCountries: ["Canada"], groups: [GROUP] }, { fail: (b) => ((b.dimensions as any[]).length === 1 ? { status: 403, body: "denied" } : null) });
    const runFail = (await c.query(`SELECT * FROM ga4_report_runs WHERE client_id='client-a'`)).rows[0] as Record<string, unknown>;
    ok("a failed daily read changes no day and no report row", (await count(`SELECT count(*) AS n FROM ga4_site_days`)) === daysBefore && (await count(`SELECT count(*) AS n FROM ga4_report_rows`)) === rowsBefore);
    ok("the run row says error", runFail.status === "error" && /daily totals could not be read/.test(String(runFail.detail)));
    ok("and keeps the earlier span and the earlier applied config", JSON.stringify({ first_day: runFail.first_day, last_day: runFail.last_day, first_month: runFail.first_month, last_month: runFail.last_month, excluded_countries: runFail.excluded_countries, groups_json: runFail.groups_json }) === JSON.stringify(spanBefore));

    // A client with no property still gets a run row.
    const offR = await readClientReport({ id: "client-b", name: "B", ga4Property: null }, defaultConfig(), deps(property(dataset()).fetch));
    await writeClientReport(c, "client-b", offR, at);
    const off = (await c.query(`SELECT status, detail, rows FROM ga4_report_runs WHERE client_id='client-b'`)).rows[0] as Record<string, unknown>;
    ok("an account with no property has an off run row and no data", off.status === "off" && off.detail === "No analytics property is connected for this account." && off.rows === 0 && (await count(`SELECT count(*) AS n FROM ga4_site_days WHERE client_id='client-b'`)) === 0);

    // A write that fails halfway leaves nothing behind.
    const snapshot = JSON.stringify((await c.query(`SELECT id, synced_at FROM ga4_report_rows ORDER BY id`)).rows);
    const bad = await readClientReport(CTX, defaultConfig(), deps(property(dataset()).fetch));
    bad.kinds.region = [...(bad.kinds.region ?? []), { month: "2026-07", kind: "region", parent: "x", key: null as unknown as string, sessions: 1, engagedSessions: null, engagementSeconds: null, events: null }];
    const bw = await writeClientReport(c, "client-a", bad, new Date("2026-10-16T00:00:00Z"));
    ok("a write that fails halfway rolls the whole client back", !bw.ok && JSON.stringify((await c.query(`SELECT id, synced_at FROM ga4_report_rows ORDER BY id`)).rows) === snapshot);
    const rbRun = (await c.query(`SELECT status FROM ga4_report_runs WHERE client_id='client-a'`)).rows[0] as { status: string };
    ok("and the run row then says error, not ok", rbRun.status === "error");
    // The tables hold no column that could carry a visitor.
    const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name LIKE 'ga4_%'`, [schema])).rows.map((x) => (x as { column_name: string }).column_name);
    ok("no table has a visitor-level column", !cols.some((n) => /user_id|visitor|session_id|ip|client_id_ga|device_id/.test(n) && n !== "client_id"));
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
}

/* ═════════════════════════ 12. channels left out, channel reports, visits to a group's pages ═════════════════════════ */
hr("12. channels left out of the report, the two channel reports, and visits that looked at a group's pages");
{
  ok("no channel configured: none left out", defaultConfig().excludeChannels.length === 0);
  const c1 = cfg({ excludeChannels: ["direct", " Unassigned ", "Unassigned", "(not set)", "Made Up", 7, null, "paid social"] });
  ok("channels: only GA4's own names, matched whatever the case, written as GA4 spells them, once each", JSON.stringify(c1.excludeChannels) === JSON.stringify(["Direct", "Unassigned", "Paid Social"]), JSON.stringify(c1.excludeChannels));
  ok("a channel list that is not a list reads as none", cfg({ excludeChannels: "Direct" }).excludeChannels.length === 0);
  ok(`at most ${CONFIG_LIMITS.channels} channels`, cfg({ excludeChannels: ["Direct", "Unassigned", "Email", "Display", "Affiliates", "Audio", "SMS", "Referral"] }).excludeChannels.length === CONFIG_LIMITS.channels);

  const CH = ["Direct", "Unassigned"];
  const w = readWindow(TODAY, MONTHS)!;
  const withCh = dailyRequest(w, ["sessions"], [], CH) as Record<string, any>;
  ok("the daily request leaves the channels out through the channel group dimension", JSON.stringify(withCh.dimensionFilter).includes("sessionDefaultChannelGroup") && JSON.stringify(withCh.dimensionFilter).includes("Unassigned") && "notExpression" in withCh.dimensionFilter);
  ok("with country and channel both, the two filters are ANDed", (dailyRequest(w, ["sessions"], ["India"], CH) as any).dimensionFilter.andGroup.expressions.length === 2);

  const specs = kindSpecs([GROUP], "form_submit");
  const kindOf = (k: string) => specs.find((x) => x.kind === k)!;
  ok("the two channel reports ask for the channel group and ignore the channel exclusion", ["channel_sessions", "channel_forms"].every((k) => {
    const req = reportRequest(w, kindOf(k), kindOf(k).ladder[0]!, [], CH) as Record<string, any>;
    return (req.dimensions as any[])[1].name === "sessionDefaultChannelGroup" && !JSON.stringify(req.dimensionFilter ?? {}).includes("Unassigned");
  }));
  ok("the channel form report counts only the form event", JSON.stringify(reportRequest(w, kindOf("channel_forms"), ["eventCount"], [], CH)).includes('"value":"form_submit"'));
  ok("every other report carries the channel exclusion", specs.filter((x) => !x.ignoreChannels).every((x) => JSON.stringify(reportRequest(w, x, x.ladder[0]!, [], CH)).includes("Unassigned")));
  ok("the visits report for a group asks pagePath, sessions and the prefix", (() => { const sp = kindOf("group_visits"); const r = reportRequest(w, sp, sp.ladder[0]!, [], []) as Record<string, any>; return (r.dimensions as any[])[1].name === "pagePath" && JSON.stringify(r.dimensionFilter).includes("BEGINS_WITH") && (r.metrics as any[]).some((m) => m.name === "sessions"); })());

  ok("the distinct sessions report for a group has NO page dimension, so a session counts once", (() => { const sp = kindOf("group_sessions"); const r = reportRequest(w, sp, sp.ladder[0]!, [], []) as Record<string, any>; return (r.dimensions as any[]).length === 1 && (r.dimensions as any[])[0].name === "yearMonth" && JSON.stringify(r.dimensionFilter).includes("BEGINS_WITH") && JSON.stringify(r.dimensionFilter).includes(GROUP.prefix) && (r.metrics as any[]).some((m) => m.name === "sessions"); })());
  const run = await readClientReport(CTX, cfg({ groups: [GROUP], excludeChannels: CH }), deps(property(dataset()).fetch));
  ok("the run is ok with channels left out", run.status === "ok" && run.failedKinds.length === 0, `${run.status} ${run.detail ?? ""}`);
  ok("the channel left out is absent from the daily total and from the lists", run.daily![0]!.sessions === 65, String(run.daily![0]!.sessions));
  const cs = run.kinds.channel_sessions!;
  ok("channel sessions: unfiltered by channel, so the left-out channels are counted", cs.some((x) => x.key === "Direct" && x.month === "2026-06" && x.sessions === 4) && cs.some((x) => x.key === "Organic Search"));
  ok("channel sessions: keyed by the channel group, month by month", cs.every((x) => /^\d{4}-\d{2}$/.test(x.month) && x.parent === ""));
  const cf = run.kinds.channel_forms!;
  ok("channel forms: the form event only, by channel, events not sessions", cf.some((x) => x.key === "Organic Search" && x.month === "2026-06" && x.events === 4) && cf.every((x) => x.sessions === null && (x.events ?? 0) > 0) && !cf.some((x) => x.key === "Paid Social"));
  ok("the sources list leaves the excluded channels' traffic out", !run.kinds.source_medium!.some((x) => x.key.startsWith("(direct)")));
  const gv = run.kinds.group_visits!;
  ok("group visits: pages under the prefix, query gone, parent is the prefix", gv.length > 0 && gv.every((x) => x.parent === GROUP.prefix && x.key.startsWith("/plan-your-trip/advisor/") && !x.key.includes("?")));
  const gsx = run.kinds.group_sessions!;
  ok("group sessions: one row a month for the group, parent is the prefix, a count and no page", gsx.length > 0 && gsx.every((x) => x.parent === GROUP.prefix && x.key === "all" && (x.sessions ?? 0) > 0) && new Set(gsx.map((x) => x.month)).size === gsx.length);
  ok("the applied channel list is on the result", run.config.excludeChannels.join() === "Direct,Unassigned");
  const none = await readClientReport(CTX, defaultConfig(), deps(property(dataset()).fetch));
  ok("with no groups the visits kind clears as nothing, like the other group kinds", Array.isArray(none.kinds.group_visits) && none.kinds.group_visits!.length === 0);
  ok("the channel kinds have a row cap", TOP_N.group_sessions >= 1 && TOP_N.channel_sessions > 0 && TOP_N.channel_forms > 0 && TOP_N.group_visits > 0);
  ok("the run row stores the channels it applied", INSERT_RUN.includes("excluded_channels") && INSERT_RUN_KEEP.includes("excluded_channels") && !/excluded_channels = EXCLUDED/.test(INSERT_RUN_KEEP.split("DO UPDATE SET")[1] ?? ""));
}

/* ═════════════════════════ 13. page group match modes, and the unfiltered monthly total ═════════════════════════ */
hr("13. match modes: starts with, exactly, one level deeper; the filter and the rule agree; no pattern is ever sent");
{
  const DIR = "/plan-your-trip/advisor/";
  const landings = [
    DIR, `${DIR}?destination=Paris`, "/plan-your-trip/advisor", `${DIR}jane-doe/`, `${DIR}jane-doe/about`, `${DIR}jane-doe-2/`, `${DIR}john`,
    `${DIR}john/?utm=1`, "/", "/contact", "/contact/", "/contact-us", "/contact/thanks", "/plan-your-trip/advisors-list/",
  ];
  const ds = (): Dataset => ({
    sessions: landings.map((l, i) => S("20260705", "United States", "Ohio", "google / organic", l, 10 + i)),
    events: landings.map((l, i) => E("20260705", "United States", l.split("?")[0]!, "form_submit", 1 + i)),
  });
  const modes: Array<{ m: "starts" | "exact" | "child"; prefix: string }> = [
    { m: "starts", prefix: DIR }, { m: "exact", prefix: DIR }, { m: "child", prefix: DIR }, { m: "exact", prefix: "/contact" }, { m: "starts", prefix: "/contact" },
  ];
  for (const { m, prefix } of modes) {
    const g = { prefix, match: m };
    for (const field of ["landingPage", "pagePath"] as const) {
      const filter = groupFilter(field, g);
      const wrong = landings.filter((l) => {
        // A page path never carries a query, so the address under test is the path for that field.
        const value = field === "pagePath" ? l.split("?")[0]! : l;
        return matches(filter, { [field]: value }) !== pathInGroup(value, g);
      });
      ok(`${m} on ${prefix} (${field}): the request filter and pathInGroup agree on every address`, wrong.length === 0, wrong.join(" | "));
    }
  }
  ok("every mode is spelled the same in both lists, and an unknown one is the original behaviour", GROUP_MATCH_MODES.join() === "starts,exact,child" && cleanMatch(undefined) === "starts" && cleanMatch("regex") === "starts" && cleanMatch("EXACT") === "starts");
  ok("a group's rows are filed under its key: the plain prefix for starts with, a marked one for the others", groupKey({ prefix: DIR }) === DIR && groupKey({ prefix: DIR, match: "starts" }) === DIR && groupKey({ prefix: DIR, match: "exact" }) === `=${DIR}` && groupKey({ prefix: DIR, match: "child" }) === `>${DIR}`);
  ok("a key reads back to its mode and address", parseGroupKey(`=${DIR}`).match === "exact" && parseGroupKey(`>${DIR}`).prefix === DIR && parseGroupKey(DIR).match === "starts");

  const child = { prefix: DIR, match: "child" as const };
  ok("one level deeper: the directory itself, with or without a slash or a query, is never a member", !pathInGroup(DIR, child) && !pathInGroup("/plan-your-trip/advisor", child) && !pathInGroup(`${DIR}?destination=Paris`, child));
  ok("one level deeper: an advisor and the pages under the advisor are members", pathInGroup(`${DIR}jane-doe/`, child) && pathInGroup(`${DIR}jane-doe/about`, child));
  ok("one level deeper: a deeper page folds into its advisor, and a -2 copy folds into the original", mergeKey(`${DIR}jane-doe/about`, child) === `${DIR}jane-doe/` && mergeKey(`${DIR}jane-doe-2/`, child) === `${DIR}jane-doe/` && mergeKey(`${DIR}john`, child) === `${DIR}john/`);
  ok("exactly: only the address and its slash twin, and nothing folds", pathInGroup("/contact", { prefix: "/contact", match: "exact" }) && pathInGroup("/contact/", { prefix: "/contact", match: "exact" }) && !pathInGroup("/contact-us", { prefix: "/contact", match: "exact" }) && !pathInGroup("/contact/thanks", { prefix: "/contact", match: "exact" }) && mergeKey("/contact/", { prefix: "/contact", match: "exact" }) === "/contact/");
  ok("starts with: the original rule (a -2 copy folds, deeper pages stay their own rows)", mergeKey(`${DIR}jane-doe-2/`, { prefix: DIR }) === `${DIR}jane-doe/` && mergeKey(`${DIR}jane-doe/about`, { prefix: DIR }) === `${DIR}jane-doe/about/`);

  // No pattern is ever sent, whatever was typed.
  const typed = "/a.b(c)*[d]+x$/";
  const allFilters = (["starts", "exact", "child"] as const).flatMap((m) => (["landingPage", "pagePath"] as const).map((f) => JSON.stringify(groupFilter(f, { prefix: typed, match: m }))));
  ok("no filter uses a regular expression, so nothing typed can be read as a pattern", allFilters.every((f) => !/REGEXP|regex/i.test(f)));
  ok("the typed text goes into the request as a literal value, unchanged", JSON.stringify(groupFilter("pagePath", { prefix: "/a.b(c)*/", match: "starts" })).includes('"value":"/a.b(c)*/"'));

  // The settings.
  const same = cfg({ groups: [{ name: "Directory", prefix: DIR, match: "exact" }, { name: "Advisors", prefix: DIR, match: "child" }, { name: "Everything", prefix: DIR }] });
  ok("one address can be three groups when the modes differ", same.groups.length === 3 && same.groups.map((g) => g.match).join() === "exact,child,starts");
  ok("two groups with the same mode and the same address are one group", cfg({ groups: [{ name: "A", prefix: DIR, match: "child" }, { name: "B", prefix: DIR, match: "child" }, { name: "C", prefix: DIR }, { name: "D", prefix: DIR, match: "starts" }] }).groups.map((g) => g.name).join() === "A,C");
  ok("a stored group with no mode is starts with, exactly as before", cfg({ groups: [{ name: "Old", prefix: "/old/" }] }).groups[0]!.match === "starts");
  ok("an unknown mode is starts with, never a thing that is passed on", cfg({ groups: [{ name: "X", prefix: "/x/", match: "regex" }, { name: "Y", prefix: "/y/", match: { toString: () => "exact" } }] }).groups.every((g) => g.match === "starts"));
  ok("one level deeper needs a directory: the bare root is refused", cfg({ groups: [{ name: "Root", prefix: "/", match: "child" }] }).groups.length === 0);
  ok("exactly and one level deeper refuse an address with a query or fragment", cfg({ groups: [{ name: "Q", prefix: "/a/?x=1", match: "exact" }, { name: "F", prefix: "/a/#top", match: "child" }] }).groups.length === 0);
  ok("the root can be an exact group (the home page)", cfg({ groups: [{ name: "Home", prefix: "/", match: "exact" }] }).groups.length === 1);

  // A real run with the directory and the microsites as two groups on one address.
  const two = cfg({ groups: [{ name: "Directory", prefix: DIR, match: "exact" }, { name: "Advisors", prefix: DIR, match: "child" }] });
  const p = property(ds());
  const r = await readClientReport(CTX, two, deps(p.fetch));
  ok("both groups are read, and the run is ok", r.status === "ok" && r.failedKinds.length === 0, `${r.status} ${r.detail ?? ""}`);
  const keyOf = (rows: ReportRowOut[] | undefined, parent: string) => (rows ?? []).filter((x) => x.parent === parent && x.month === "2026-07").map((x) => x.key).sort();
  const dirRows = keyOf(r.kinds.group_page, `=${DIR}`);
  const advRows = keyOf(r.kinds.group_page, `>${DIR}`);
  ok("the directory group holds the directory page only (its search form and its slashless twin are the same page)", dirRows.join() === "/plan-your-trip/advisor", dirRows.join());
  ok("the directory group's sessions add the three spellings of the one page", (r.kinds.group_page ?? []).find((x) => x.parent === `=${DIR}`)?.sessions === 10 + 11 + 12);
  ok("the advisors group holds the advisors' pages, deeper pages included, and never the directory", advRows.length > 0 && advRows.every((k) => k.startsWith("/plan-your-trip/advisor/") && k !== "/plan-your-trip/advisor") && advRows.some((k) => k.endsWith("/jane-doe/about")) && advRows.some((k) => k.endsWith("/jane-doe-2")), advRows.join());
  ok("each group's rows are under its own key and the two never meet", (r.kinds.group_visits ?? []).every((x) => x.parent === `=${DIR}` || x.parent === `>${DIR}`) && (r.kinds.group_form ?? []).every((x) => x.parent === `=${DIR}` || x.parent === `>${DIR}`));
  ok("the distinct-session report is one row a month for each group", (r.kinds.group_sessions ?? []).filter((x) => x.month === "2026-07").length === 2);
  ok("the result carries each group's mode", r.config.groups.length === 2 && r.config.groups[0]!.match === "exact" && r.config.groups[1]!.match === "child");
  ok("a starts-with group still files its rows under the plain prefix (rows written before modes existed still belong to it)", (await readClientReport(CTX, cfg({ groups: [{ name: "Old", prefix: DIR }] }), deps(property(ds()).fetch))).kinds.group_page!.every((x) => x.parent === DIR));

  // The unfiltered monthly total.
  const mr = await readClientReport(CTX, cfg({ excludeCountries: ["India"], excludeChannels: ["Direct"] }), deps(property(dataset()).fetch));
  const raw = (mr.kinds.month_raw ?? []).find((x) => x.month === "2026-06");
  ok("the unfiltered monthly total counts every session whatever was left out", raw?.sessions === 10 + 5 + 4 + 50 + 7 + 8 && raw?.key === "all" && raw?.parent === "", JSON.stringify(raw));
  ok("it carries engagement too, for the folded raw column", raw?.engagedSessions != null && raw?.engagementSeconds != null);
  ok("and the filtered daily total leaves them out, so the two can be set side by side", mr.daily!.filter((x) => x.day.startsWith("2026-06")).reduce((a, x) => a + (x.sessions ?? 0), 0) < (raw?.sessions ?? 0));
  const spec = kindSpecs([], "form_submit").find((x) => x.kind === "month_raw")!;
  ok("the request for it has no filter at all and no dimension but the month", !("dimensionFilter" in (reportRequest(readWindow(TODAY, MONTHS)!, spec, spec.ladder[0]!, ["India"], ["Direct"]) as object)) && spec.dimensions.length === 0);
  ok("one row a month is kept", TOP_N.month_raw === 1 && REPORT_KINDS.includes("month_raw"));
}

console.log("\n" + "─".repeat(72));
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");

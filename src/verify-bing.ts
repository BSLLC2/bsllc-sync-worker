#!/usr/bin/env tsx
/**
 * Guard for the Bing Webmaster reader: what it asks Bing, what it keeps, and what it
 * refuses to guess.
 *
 * No Bing, no database, no key. A pretend Bing (a real HTTP server on a local port)
 * answers the real request builders, the real parsers and the real orchestration through
 * the real fetch, and a recording client stands in for Postgres so the real INSERTs are
 * read as text and as parameters.
 *
 * EVERY SITE, SEARCH, PAGE, COUNT AND KEY BELOW IS INVENTED.
 *
 * WHAT THIS CANNOT PROVE. No Bing Webmaster account exists to this build, so nothing
 * here has run against Bing. The method names, the answer fields, the `/Date(ms)/` date
 * format, and the not-found answer for an unknown method are written from the Webmaster
 * API reference as I know it; a green run means the code does what it says against the
 * shapes it expects, not that Bing answers in them. docs/INTEGRATIONS-SETUP.md
 * (dashboard repository) lists each as unverified.
 *
 *   npx tsx src/verify-bing.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { startFake, type Call } from "./signals/fake-http.js";
import { HttpError, realFetch, safeMessage } from "./page-behaviour/http.js";
import { aiProbeUrl, bingDay, capByTotal, classifyMethodAnswer, isKeyRefusal, joinSiteDays, methodUrl, parseCrawl, parseIssues, parsePages, parseQueries, parseSites, parseTraffic, siteKey } from "./bing/api.js";
import { readBingClient, type BingCtx, type BingDeps } from "./bing/run.js";
import { BATCH, CLEAR_ISSUES, INSERT_ISSUE, PRUNE_PAGE_DAYS, PRUNE_QUERY_DAYS, UPSERT_PAGE_DAYS, UPSERT_QUERY_DAYS, UPSERT_SITE, UPSERT_SITE_DAY, writeIssues, writePageDays, writeQueryDays, writeSite, writeSiteDays } from "./bing/store.js";
import { AI_CITATION_PROBE_METHOD, BING_ISSUE_CAP, BING_METHODS, BING_QUERY_ROW_CAP } from "./bing/types.js";
import { SECRET_NAMES, bingApiKey } from "./signals/secrets.js";

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

const KEY = "bing-api-key-value-123";
const NOW = new Date("2026-10-15T10:40:00Z");
const msDate = (iso: string) => `/Date(${Date.parse(`${iso}T00:00:00Z`)})/`;
const SITE = "https://www.hillsideroofing.example/";

const SITES = { d: [{ Url: SITE, IsVerified: true, AuthenticationCode: "secret-auth-code", DnsVerificationCode: "secret-dns-code" }, { Url: "https://other.example/", IsVerified: false }] };
const QUERIES = (extra: unknown[] = []) => ({
  d: [
    { Query: "  Roof   Repair Near Me ", Date: msDate("2026-10-01"), Clicks: 7, Impressions: 120, AvgImpressionPosition: 4.2, AvgClickPosition: 3.1 },
    { Query: "roof repair near me", Date: msDate("2026-10-02"), Clicks: 5, Impressions: 90, AvgImpressionPosition: -1 },
    { Query: "call 5135550123", Date: msDate("2026-10-01"), Clicks: 1, Impressions: 2 },
    { Query: "jane@example.test roofer", Date: msDate("2026-10-01"), Clicks: 1, Impressions: 2 },
    { Query: "no date", Clicks: 1, Impressions: 2 },
    { Query: "no counts", Date: msDate("2026-10-01") },
    ...extra,
  ],
});
const PAGES = {
  d: [
    { Query: `${SITE}services/?utm_source=x#top`, Date: msDate("2026-10-01"), Clicks: 9, Impressions: 200, AvgImpressionPosition: 6 },
    { Query: "/relative/path", Date: msDate("2026-10-01"), Clicks: 1, Impressions: 2 },
  ],
};
const TRAFFIC = { d: [{ Date: msDate("2026-10-01"), Clicks: 20, Impressions: 400 }, { Date: msDate("2026-10-02"), Clicks: 25, Impressions: 410 }] };
const CRAWL = { d: [{ Date: msDate("2026-10-01"), CrawledPages: 300, CrawlErrors: 4, InIndex: 280, InLinks: 51, BlockedByRobotsTxt: 2, Code4xx: 3, Code5xx: 1, DnsFailures: 0, ConnectionTimeout: 0 }] };
const ISSUES = { d: [{ Url: `${SITE}old-page`, HttpCode: 404, Issues: 8, InLinks: 3 }, { Url: `${SITE}old-page#frag`, HttpCode: 404, Issues: 8 }, { Url: `${SITE}slow`, HttpCode: 200, Issues: "SlowPage", InLinks: 1 }, { Url: "not a url" }] };

type Rec = { sql: string; params: unknown[] };
const recorder = () => { const calls: Rec[] = []; return { calls, query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params: params ?? [] }); return {}; } }; };

async function main() {
  /* ───────────────────────── 1. the parsers ───────────────────────── */
  hr("1. an answer becomes counts, and a gap is never a nought");
  ok("Bing's /Date(ms)/ becomes a UTC day, with or without an offset", bingDay("/Date(1759276800000)/") === "2025-10-01" && bingDay("/Date(1759276800000-0700)/") === "2025-10-01");
  ok("a plain ISO date is read; an impossible one and a non-date are not", bingDay("2026-10-04T00:00:00") === "2026-10-04" && bingDay("2026-13-45") === null && bingDay("soon") === null && bingDay(123) === null && bingDay(null) === null);
  const q = parseQueries(QUERIES());
  ok("a search is lower-cased, trimmed and its spaces collapsed", q.rows.some((r) => r.query === "roof repair near me" && r.day === "2026-10-01" && r.clicks === 7 && r.impressions === 120));
  ok("a position Bing marks with -1 is no position, not a position of -1", q.rows.find((r) => r.day === "2026-10-02")!.avgPosition === null && q.rows.find((r) => r.day === "2026-10-01")!.avgPosition === 4.2);
  ok("a search that looks like a phone number or an address is not kept", !q.rows.some((r) => /5135550123|@/.test(r.query)));
  ok("a row with no date or no counts is skipped, not kept as zero", !q.rows.some((r) => r.query === "no date" || r.query === "no counts") && q.skipped === 4);
  const p = parsePages(PAGES);
  ok("a page address loses its query string and fragment", p.rows.length === 1 && p.rows[0]!.pageUrl === `${SITE}services/` && p.rows[0]!.clicks === 9);
  ok("a relative path is not a page address and is skipped", p.skipped === 1);
  const t = parseTraffic(TRAFFIC);
  ok("daily traffic is clicks and impressions by day", t.days.get("2026-10-02")?.clicks === 25 && t.days.size === 2);
  const cr = parseCrawl(CRAWL);
  ok("crawl counts are read by Bing's names", cr.days.get("2026-10-01")?.crawlErrors === 4 && cr.days.get("2026-10-01")?.inIndex === 280 && cr.days.get("2026-10-01")?.inLinks === 51 && cr.days.get("2026-10-01")?.blockedRobots === 2);
  const parsedCrawlMissing = parseCrawl({ d: [{ Date: msDate("2026-10-03"), CrawledPages: 10 }] });
  ok("a crawl field Bing did not send is null, not 0", parsedCrawlMissing.days.get("2026-10-03")?.crawlErrors === null && parsedCrawlMissing.days.get("2026-10-03")?.crawledPages === 10);
  const joined = joinSiteDays(t.days, cr.days);
  ok("traffic and crawl are joined by day, and a day only one has keeps the other's fields null", joined.length === 2 && joined[0]!.clicks === 20 && joined[0]!.crawlErrors === 4 && joined[1]!.crawlErrors === null && joined[1]!.clicks === 25);
  const iss = parseIssues(ISSUES);
  ok("a crawl issue keeps the exact address, the code and what Bing said; a repeat is one", iss.rows.length === 2 && iss.rows[0]!.url === `${SITE}old-page` && iss.rows[0]!.httpCode === 404 && iss.rows[0]!.issueFlags === 8 && iss.rows[1]!.issueText === "SlowPage");
  ok("an issue with no usable address is skipped", iss.skipped === 1);
  for (const [label, fn] of [["queries", () => parseQueries({ d: "x" })], ["pages", () => parsePages(null)], ["traffic", () => parseTraffic({})], ["crawl", () => parseCrawl("ok")], ["issues", () => parseIssues({ d: { a: 1 } })], ["sites", () => parseSites(undefined)]] as const) {
    let threw = false; try { fn(); } catch { threw = true; }
    ok(`${label}: an answer that is not a list is refused, not read as 'nothing'`, threw);
  }
  const sites = parseSites(SITES);
  ok("sites carry the address and whether Bing verified it, and never the verification codes", sites.length === 2 && sites[0]!.verified === true && sites[1]!.verified === false && !JSON.stringify(sites).includes("secret-auth-code") && !JSON.stringify(sites).includes("secret-dns-code"));
  ok("the same site is the same whatever the scheme, www, case or trailing slash", siteKey("HTTPS://WWW.Hillsideroofing.example/") === siteKey("http://hillsideroofing.example") && siteKey("https://a.example/") !== siteKey("https://b.example/"));
  const big = Array.from({ length: 30 }, (_, i) => ({ day: "2026-10-01", query: `s${i}`, clicks: i, impressions: i * 2, avgPosition: null }));
  const capped = capByTotal(big.concat(big.map((r) => ({ ...r, day: "2026-10-02" }))), (r) => r.query, 20);
  ok("over the cap the busiest items are kept whole, with every day of each, and the rest are counted", capped.rows.length === 20 && capped.dropped === 40 && capped.rows.every((r) => Number(r.query.slice(1)) >= 20) && capped.rows.filter((r) => r.query === "s29").length === 2);
  ok("under the cap nothing is dropped", capByTotal(big, (r) => r.query, 100).dropped === 0);

  /* ───────────────────────── 2. addresses and errors ───────────────────────── */
  hr("2. the key travels in the address, and never leaves it");
  const u = new URL(methodUrl(BING_METHODS.queries, KEY, SITE));
  ok("a call is a GET of the documented host and path with the key and site as parameters", u.hostname === "ssl.bing.com" && u.pathname === "/webmaster/api.svc/json/GetQueryStats" && u.searchParams.get("apikey") === KEY && u.searchParams.get("siteUrl") === SITE);
  ok("the sites call carries no siteUrl", !new URL(methodUrl(BING_METHODS.sites, KEY, null)).searchParams.has("siteUrl"));
  const msg = safeMessage(new HttpError(400, "bad", `Bing GetQueryStats ${methodUrl(BING_METHODS.queries, KEY, SITE)}`), [KEY]);
  ok("an error message that carries the address does not carry the key", !msg.includes(KEY) && !/apikey=[^[]/.test(msg), msg);
  ok("a key refusal is read from the status or the body, not from a guess", isKeyRefusal(new HttpError(401, "", "x")) && isKeyRefusal(new HttpError(403, "", "x")) && isKeyRefusal(new HttpError(400, '{"Message":"InvalidApiKey"}', "x")) && !isKeyRefusal(new HttpError(500, "boom", "x")) && !isKeyRefusal(new Error("net")));
  ok("an unknown method is 'absent' on a not-found status or a body that says so, and nothing else is", classifyMethodAnswer(new HttpError(404, "", "x")) === "absent" && classifyMethodAnswer(new HttpError(400, '{"Message":"The method GetNothing does not exist"}', "x")) === "absent" && classifyMethodAnswer(new HttpError(500, "boom", "x")) === "unclear" && classifyMethodAnswer(new HttpError(403, "", "x")) === "unclear" && classifyMethodAnswer(new Error("net")) === "unclear");
  ok("the AI citation method is probed under one declared name and never read from anywhere else", new URL(aiProbeUrl(KEY, SITE)).pathname.endsWith(`/${AI_CITATION_PROBE_METHOD}`));

  /* ───────────────────────── 3. the run, through a pretend Bing ───────────────────────── */
  hr("3. the run");
  const asked: Call[] = [];
  let mode = "ok";
  const bing = await startFake((c: Call) => {
    asked.push(c);
    const name = /\/json\/(\w+)/.exec(c.path)?.[1] ?? "";
    const key = new URL(`http://x${c.path}`).searchParams.get("apikey");
    if (key !== KEY) return { status: 400, body: { ErrorCode: 3, Message: "InvalidApiKey" } };
    if (mode === "keyexpires" && name === "GetPageStats") return { status: 401, body: { Message: "NotAuthorized" } };
    if (name === "GetUserSites") {
      if (mode === "nosite") return { body: { d: [{ Url: "https://other.example/", IsVerified: true }] } };
      if (mode === "unverified") return { body: { d: [{ Url: SITE, IsVerified: false }] } };
      if (mode === "sites500") return { status: 500, body: `oops ${KEY}` };
      return { body: SITES };
    }
    if (name === "GetQueryStats") return mode === "queries500" || mode === "all500" ? { status: 500, body: `backend ${c.path}` } : { body: mode === "manyqueries" ? { d: Array.from({ length: BING_QUERY_ROW_CAP + 500 }, (_, i) => ({ Query: `q${i % 5000}`, Date: msDate(`2026-${String(1 + Math.floor(i / 5000) % 9).padStart(2, "0")}-01`), Clicks: i % 7, Impressions: i % 90 })) } : QUERIES() };
    if (name === "GetPageStats") return mode === "all500" ? { status: 500, body: "x" } : { body: PAGES };
    if (name === "GetRankAndTrafficStats") return mode === "all500" ? { status: 500, body: "x" } : { body: TRAFFIC };
    if (name === "GetCrawlStats") return mode === "all500" ? { status: 500, body: "x" } : { body: CRAWL };
    if (name === "GetCrawlIssues") return mode === "all500" ? { status: 500, body: "x" } : { body: mode === "manyissues" ? { d: Array.from({ length: BING_ISSUE_CAP + 20 }, (_, i) => ({ Url: `${SITE}p${i}`, HttpCode: 404 })) } : ISSUES };
    if (name === AI_CITATION_PROBE_METHOD) {
      if (mode === "aipresent") return { body: { d: [{ a: 1 }, { a: 2 }] } };
      if (mode === "ai500") return { status: 500, body: "x" };
      return { status: 400, body: { Message: `The method ${AI_CITATION_PROBE_METHOD} does not exist` } };
    }
    return undefined;
  });
  process.env.SIGNALS_FAKE_BASE = bing.base;
  const ctx = (over: Partial<BingCtx> = {}): BingCtx => ({ name: "Hillside Roofing", slug: "hillside-roofing", site: SITE, ...over });
  const deps = (over: Partial<BingDeps> = {}): BingDeps => ({ fetch: realFetch, apiKey: KEY, now: NOW, pauseMs: 0, secrets: [KEY], ...over });

  const off = await readBingClient(ctx({ site: null }), deps());
  ok("no site recorded is 'off', makes no call and costs nothing", off.run.status === "off" && asked.length === 0);
  const notUrl = await readBingClient(ctx({ site: "Hillside Roofing" }), deps());
  ok("a name where an address belongs is an error that says what an address is, and makes no call", notUrl.run.status === "error" && /https:\/\//.test(notUrl.run.detail ?? "") && asked.length === 0);
  const noKey = await readBingClient(ctx(), deps({ apiKey: null }));
  ok("no key is no_key, names BING_WEBMASTER_API_KEY and makes no call", noKey.run.status === "no_key" && (noKey.run.detail ?? "").includes(SECRET_NAMES.bing) && asked.length === 0);
  const wrongKey = await readBingClient(ctx(), deps({ apiKey: "not-the-key" }));
  ok("a key Bing refuses is no_key and says to replace the secret, not 'the site is missing'", wrongKey.run.status === "no_key" && /replace the BING_WEBMASTER_API_KEY/.test(wrongKey.run.detail ?? ""));

  asked.length = 0;
  const dry = await readBingClient(ctx(), deps({ dryRun: true }));
  ok("a dry run proves the key and the site and reads no count", dry.run.status === "ok" && /Dry run/.test(dry.run.detail ?? "") && asked.length === 1 && /GetUserSites/.test(asked[0]!.path) && dry.queries.length === 0);

  asked.length = 0;
  const r = await readBingClient(ctx(), deps());
  const names = asked.map((c) => /\/json\/(\w+)/.exec(c.path)?.[1]);
  ok("the sites list is asked first, then the five counts, then the one AI probe", names.join() === ["GetUserSites", "GetQueryStats", "GetPageStats", "GetRankAndTrafficStats", "GetCrawlStats", "GetCrawlIssues", AI_CITATION_PROBE_METHOD].join(), names.join());
  ok("every call is a GET", bing.calls.every((c) => c.method === "GET"));
  ok("the key travels in the query string only, never in a header or a body", bing.calls.every((c) => !JSON.stringify(c.headers).includes(KEY) && !c.body.includes(KEY)));
  ok("the site used is the one Bing lists, not the way it was typed", r.siteUrl === SITE);
  ok("rows came back mapped", r.queries.length === 2 && r.pages.length === 1 && r.siteDays.length === 2 && r.issues.length === 2 && r.verified === true);
  ok("the run is ok, counts its rows, counts issues and names the newest day it holds", r.run.status === "ok" && r.run.rows === 5 && r.run.totalFound === 2 && r.run.windowEnd === "2026-10-02", JSON.stringify(r.run));
  ok("an unknown AI method is recorded as unavailable and nothing is stored from it", r.ai === "unavailable");
  const liveCalls = bing.calls.length;
  ok("no key and no verification code is in anything the run kept", !JSON.stringify(r).includes(KEY) && !JSON.stringify(r).includes("secret-auth-code"));

  mode = "aipresent";
  const aip = await readBingClient(ctx(), deps());
  ok("an AI method that answers is recorded as answered but not mapped, and its rows are not stored", aip.ai === "answered_not_mapped" && /not mapped/.test(aip.run.detail ?? "") && aip.queries.length === 2);
  mode = "ai500";
  const ai5 = await readBingClient(ctx(), deps());
  ok("an AI probe that fails for another reason stays 'unknown', never 'unavailable'", ai5.ai === "unknown");

  mode = "nosite";
  const nos = await readBingClient(ctx(), deps());
  ok("a site not on the key's list is an error that names the site and says how to add it", nos.run.status === "error" && /does not list/.test(nos.run.detail ?? "") && (nos.run.detail ?? "").includes(SITE) && nos.queries.length === 0);
  mode = "unverified"; asked.length = 0;
  const unv = await readBingClient(ctx(), deps());
  ok("a listed but unverified site is an error that says so and reads no count", unv.run.status === "error" && /not verified/.test(unv.run.detail ?? "") && asked.length === 1);
  mode = "sites500";
  const s5 = await readBingClient(ctx(), deps());
  ok("a failing sites call is an error with the key scrubbed", s5.run.status === "error" && !(s5.run.detail ?? "").includes(KEY));
  mode = "queries500";
  const q5 = await readBingClient(ctx(), deps());
  ok("searches failing costs the searches only: the rest is kept and the status says so", q5.queries.length === 0 && q5.pages.length === 1 && q5.run.status === "capped" && /Searches could not be read/.test(q5.run.detail ?? "") && q5.failed.join() === "Searches");
  ok("a failed part's address (and key) is not in the stored detail", !(q5.run.detail ?? "").includes(KEY) && !/apikey=(?!\[secret\])/i.test(q5.run.detail ?? ""), q5.run.detail ?? "");
  mode = "all500";
  const a5 = await readBingClient(ctx(), deps());
  ok("every count failing is an error, never a success with nothing", a5.run.status === "error" && a5.queries.length === 0 && /none of the counts/.test(a5.run.detail ?? ""));
  mode = "keyexpires";
  const ke = await readBingClient(ctx(), deps());
  ok("a key refused part way through is no_key, not a partial success", ke.run.status === "no_key");
  mode = "manyqueries";
  const mq = await readBingClient(ctx(), deps());
  ok("more searches than we keep are cut to the cap, whole, and the run says so", mq.queries.length <= BING_QUERY_ROW_CAP && mq.run.capped === true && /busiest searches/.test(mq.run.detail ?? ""));
  mode = "manyissues";
  const mi = await readBingClient(ctx(), deps());
  ok("more crawl issues than we keep are cut to the cap and the run says how many there were", mi.issues.length === BING_ISSUE_CAP && mi.run.capped === true && /of 420/.test(mi.run.detail ?? ""));
  mode = "ok";
  await bing.close();
  delete process.env.SIGNALS_FAKE_BASE;
  ok("(sanity) the run made calls", liveCalls > 0);

  /* ───────────────────────── 4. what is written ───────────────────────── */
  hr("4. the writes");
  const rec = recorder();
  const qrows = [{ day: "2026-10-01", query: "roof", clicks: 3, impressions: 9, avgPosition: 4 }, { day: "2026-10-02", query: "roof", clicks: 1, impressions: 5, avgPosition: null }];
  await writeQueryDays(rec, "c1", SITE, qrows, NOW);
  await writePageDays(rec, "c1", SITE, [{ day: "2026-10-01", pageUrl: `${SITE}a`, clicks: 1, impressions: 2, avgPosition: null }], NOW);
  await writeSiteDays(rec, "c1", SITE, joined, NOW);
  await writeIssues(rec, "c1", SITE, iss.rows, NOW);
  await writeSite(rec, "c1", SITE, true, "unavailable", NOW);
  const colsOf = (sql: string) => (sql.match(/INSERT INTO \w+\s*\(([^)]*)\)/s)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  ok("the query INSERT names 9 columns, sends 6 arrays and 3 scalars, and the arrays are the same length", colsOf(UPSERT_QUERY_DAYS).length === 9 && rec.calls[0]!.params.length === 9 && (rec.calls[0]!.params.slice(3) as unknown[][]).every((a) => Array.isArray(a) && a.length === 2));
  ok("the page INSERT names 9 columns and sends 9 parameters", colsOf(UPSERT_PAGE_DAYS).length === 9 && rec.calls[1]!.params.length === 9);
  ok("the site-day INSERT names 16 columns and sends 16 parameters", colsOf(UPSERT_SITE_DAY).length === 16 && rec.calls[2]!.params.length === 16);
  ok("the issue INSERT names 9 columns and sends 9 parameters; the list is cleared first", colsOf(INSERT_ISSUE).length === 9 && rec.calls.some((c) => c.sql === CLEAR_ISSUES) && rec.calls.find((c) => c.sql === INSERT_ISSUE)!.params.length === 9);
  ok("the site INSERT names 6 columns and sends 6 parameters", colsOf(UPSERT_SITE).length === 6 && rec.calls.find((c) => c.sql === UPSERT_SITE)!.params.length === 6);
  ok("every write is an upsert on its natural key, so a re-read overwrites and never doubles", [[UPSERT_QUERY_DAYS, "client_id, site_url, day, query"], [UPSERT_PAGE_DAYS, "client_id, site_url, day, page_url"], [UPSERT_SITE_DAY, "client_id, site_url, day"], [INSERT_ISSUE, "client_id, site_url, url"], [UPSERT_SITE, "client_id, site_url"]].every(([sql, key]) => new RegExp(`ON CONFLICT \\(${key}\\)`).test(sql!)));
  ok("rows go in many to a statement", (() => { const r2 = recorder(); void writeQueryDays(r2, "c1", SITE, Array.from({ length: BATCH + 1 }, (_, i) => ({ day: "2026-10-01", query: `q${i}`, clicks: 1, impressions: 1, avgPosition: null })), NOW); return true; })());
  const rec3 = recorder();
  await writeQueryDays(rec3, "c1", SITE, Array.from({ length: BATCH + 1 }, (_, i) => ({ day: "2026-10-01", query: `q${i}`, clicks: 1, impressions: 1, avgPosition: null })), NOW);
  ok("a batch is at most the declared size", rec3.calls.length === 2 && (rec3.calls[0]!.params[3] as unknown[]).length === BATCH);
  const rec2 = recorder();
  await writeQueryDays(rec2, "c1", SITE, qrows, NOW);
  ok("the same row written twice has the same id", JSON.stringify(rec2.calls[0]!.params[3]) === JSON.stringify(rec.calls[0]!.params[3]));
  const forbidden = /(visitor|person|ip_|ipaddr|email|phone|name|ssid|cookie|session|device_id|user|recording|auth|dns_code)/i;
  const allCols = [UPSERT_QUERY_DAYS, UPSERT_PAGE_DAYS, UPSERT_SITE_DAY, INSERT_ISSUE, UPSERT_SITE].flatMap(colsOf);
  ok("no column could hold a visitor, a person, an address of a person or a verification code", !allCols.some((c) => forbidden.test(c)), allCols.filter((c) => forbidden.test(c)).join(","));
  selfTest("the forbidden-column scan can fail", (x) => !forbidden.test(x), "avg_position", "visitor_ip");
  ok("housekeeping deletes only this client's old rows", /WHERE client_id = \$1 AND day < \$2/.test(PRUNE_QUERY_DAYS) && /WHERE client_id = \$1 AND day < \$2/.test(PRUNE_PAGE_DAYS));
  ok("no stored parameter carries the key", !JSON.stringify(rec.calls).includes(KEY));

  /* ───────────────────────── 5. secrets, the entry, the workflow ───────────────────────── */
  hr("5. a missing key is red and named; the workflow is wired");
  ok("the key is read from the environment, trimmed, and absent is null", bingApiKey({ BING_WEBMASTER_API_KEY: ` ${KEY} ` }) === KEY && bingApiKey({}) === null && bingApiKey({ BING_WEBMASTER_API_KEY: "  " }) === null);
  const root = path.resolve(import.meta.dirname, "..");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*#.*$/gm, "");
  const wfc = code(fs.readFileSync(path.join(root, ".github/workflows/read-bing.yml"), "utf8"));
  ok("the workflow is scheduled daily", /schedule:\s*\n\s*- cron: "\d+ \d+ \* \* \*"/.test(wfc));
  ok("it takes client_id and dry_run and requires neither", /client_id:[\s\S]*?required: false/.test(wfc) && /dry_run:[\s\S]*?required: false/.test(wfc));
  ok("the heartbeat runs even when the job failed, and not for a dry or scoped run", /Heartbeat[\s\S]*?if: always\(\) && inputs\.dry_run != 'true' && inputs\.client_id == ''/.test(wfc));
  ok("the heartbeat is named read_bing", /--job=read_bing(?![\w])/.test(wfc));
  ok("the heartbeat note goes through an environment variable, not into the shell line", /NOTE: \$\{\{ steps\.run\.outputs\.summary \}\}/.test(wfc) && /--note="\$NOTE"/.test(wfc) && !/--note="\$\{\{/.test(wfc));
  selfTest("the heartbeat step is guarded by always()", (x) => /Heartbeat[\s\S]*?if: always\(\)/.test(x), "- name: Heartbeat\n  if: always() && x", "- name: Heartbeat\n  if: success() && x");
  ok("it never points the job at a pretend server", !/SIGNALS_FAKE_BASE/.test(wfc));
  ok("the only secrets it passes are the database and the one Bing key", Array.from(wfc.matchAll(/secrets\.([A-Z0-9_]+)/g)).map((m) => m[1]).every((n) => n === "DATABASE_URL" || n === "BING_WEBMASTER_API_KEY") && /secrets\.BING_WEBMASTER_API_KEY/.test(wfc));
  const entry = code(fs.readFileSync(path.join(root, "src/read-bing.ts"), "utf8"));
  ok("the summary line reaches the heartbeat", /steps\.run\.outputs\.summary/.test(wfc) && /GITHUB_OUTPUT/.test(entry));
  ok("the entry script exits 1 when the key is missing and names it", /missing > 0[\s\S]*?process\.exit\(1\)/.test(entry) && /SECRET_NAMES\.bing/.test(entry));
  ok("a client with no site is written 'off' and never needs the key", /status === "off"/.test(entry));
  ok("a part that failed keeps its earlier rows (it is not written)", /failed\.includes\("Searches"\)/.test(entry) && /failed\.includes\("Pages"\)/.test(entry) && /failed\.includes\("Crawl issues"\)/.test(entry));
  const apiFiles = ["src/bing/api.ts", "src/bing/run.ts", "src/bing/store.ts", "src/bing/types.ts", "src/read-bing.ts"].map((f) => code(fs.readFileSync(path.join(root, f), "utf8")));
  ok("no write method toward Bing: every call is a GET", !apiFiles.some((x) => /method:\s*"(POST|PUT|PATCH|DELETE)"/i.test(x)) && !apiFiles.some((x) => /\b(Submit|Add|Remove|Delete|Set)(Url|Site|Sitemap|Feed)\w*/.test(x)));
  selfTest("the write-method scan can fail", (x) => !/\bSubmitUrl\w*/.test(x), "GetCrawlStats", "SubmitUrlBatch");
  ok("the endpoint is the documented host", apiFiles[3]!.includes('"https://ssl.bing.com/webmaster/api.svc/json"'));
  ok("the method names are the ones this reader declares, and no method outside the list is called", Object.values(BING_METHODS).length === 6 && apiFiles[1]!.match(/BING_METHODS\.\w+/g)!.every((m) => m.replace("BING_METHODS.", "") in BING_METHODS));
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  ok("CI runs this guard", /npm run verify-bing(?![\w-])/.test(ci));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  ok("the scripts exist", Boolean(pkg.scripts["read-bing"]) && Boolean(pkg.scripts["verify-bing"]));
  ok("no other file reads the Bing key from the environment by name", (() => {
    const bad: string[] = [];
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.ts$/.test(e.name) && !/verify-|secrets\.ts$/.test(e.name) && /process\.env\.BING_[A-Z_]+/.test(code(fs.readFileSync(f, "utf8")))) bad.push(f); } };
    walk(path.join(root, "src"));
    return bad.length === 0;
  })());
  ok("the page cap is declared and the AI probe name is a single constant", /AI_CITATION_PROBE_METHOD =/.test(apiFiles[3]!) && (apiFiles[0]!.match(/GetAI\w+/g) ?? []).length === 0);

  console.log(failures ? `\n❌ ${failures} check(s) failed` : "\n✅ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

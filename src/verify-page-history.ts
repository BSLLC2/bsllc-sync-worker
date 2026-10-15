#!/usr/bin/env tsx
/**
 * Guard for the page-level history jobs: the top results the weekly rank pull now
 * keeps, the reading of the pages that rank above a client, and each page's figures
 * by complete calendar month.
 *
 * No network, no database, no token. A pretend website answers the real fetcher and
 * the real reader, a recording client stands in for Postgres so the real SQL is read
 * as text and as parameters, and the pure builders run on invented figures.
 *
 * EVERY CLIENT, SITE, PAGE, SEARCH AND FIGURE BELOW IS INVENTED.
 *
 * WHAT THIS CANNOT PROVE. The Search Console and analytics request shapes follow the
 * published documentation and have not been run against a live property. A green
 * run means the code does what it says against the shapes it expects.
 *
 *   npx tsx src/verify-page-history.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { topOrganic, SERP_ORGANIC_KEPT } from "./dataforseo.js";
import { INSERT_SERP_RESULT, PRUNE_SERP_RESULTS, SERP_CAPTURES_KEPT, writeSerpCapture } from "./serp-results.js";
import {
  chooseSearches, resultsToRead, reusable, SERP_PAGES_PER_SEARCH, SERP_REREAD_DAYS, SERP_SEARCHES_PER_CLIENT, type SearchFact,
} from "./serp-pages/select.js";
import { HEADING_CUT, HEADINGS_KEPT, makeReader } from "./serp-pages/read.js";
import {
  capMonth, completeMonths, DELETE_PAGE_MONTH, ga4MonthRequest, INSERT_PAGE_MONTH, PAGE_MONTH_ROWS, parseGa4Month, parseGscMonth,
  readGa4Month, readGscMonth,
} from "./page-behaviour/months.js";
import type { FetchLike } from "./page-behaviour/types.js";

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
const src = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const noComments = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/* ───────────────────────── 1. the top results come out of the response already paid for ───────────────────────── */

hr("1. The top results are taken from the one response the rank pull already makes");
const items: any[] = [
  { type: "featured_snippet", url: "https://snippet.example/x", rank_absolute: 1 },
  { type: "organic", url: "https://www.alpha.example/guide#top", title: "  Alpha   guide  ", rank_absolute: 2, domain: "www.alpha.example" },
  { type: "organic", url: "javascript:alert(1)", title: "Bad", rank_absolute: 3 },
  { type: "organic", url: "https://user:pw@beta.example/page", title: "Credentials", rank_absolute: 4 },
  { type: "organic", url: "https://gamma.example/a", title: "G".repeat(400), rank_absolute: 5 },
  { type: "organic", url: "https://delta.example/", rank_group: 3 },
  ...Array.from({ length: 14 }, (_, i) => ({ type: "organic", url: `https://many${i}.example/p`, title: `Many ${i}`, rank_absolute: 10 + i })),
];
const top = topOrganic(items);
ok("only organic results are kept", !top.some((r) => r.url.includes("snippet.example")));
ok("a result with no usable address is dropped, one with credentials too", !top.some((r) => r.url.startsWith("javascript") || r.url.includes("user:pw")));
ok("the list is in position order", top.every((r, i) => i === 0 || top[i - 1]!.position <= r.position));
ok(`at most ${SERP_ORGANIC_KEPT} are kept`, top.length === SERP_ORGANIC_KEPT, `${top.length}`);
ok("a title is trimmed, squeezed and cut to 200 characters", top.find((r) => r.url.includes("gamma"))?.title?.length === 200 && top.find((r) => r.url.includes("alpha"))?.title === "Alpha guide");
ok("the domain is the host without www, and the fragment is gone", top.find((r) => r.url.includes("alpha"))?.domain === "alpha.example" && !top.some((r) => r.url.includes("#")));
ok("nothing but position, address, domain and title is kept", top.every((r) => Object.keys(r).sort().join(",") === "domain,position,title,url"));
{
  const ds = src("src/dataforseo.ts");
  const start = ds.indexOf("export async function serpRanks"), end = ds.indexOf("// ── AEO");
  ok("the serpRanks function was found to be counted", start > 0 && end > start);
  const fn = noComments(ds.slice(start, end));
  const posts = (fn.match(/\bpost\(/g) ?? []).length;
  ok("serpRanks makes exactly one provider call per search, as before", posts === 1, `${posts} post() call(s)`);
  selfTest("the one-call check", (t) => (t.match(/\bpost\(/g) ?? []).length === 1, "await post(a)", "await post(a); await post(b);");
  const imp = noComments(src("src/import-seo.ts"));
  ok("the rank pull calls serpRanks once per batch and nothing else for the results", (imp.match(/serpRanks\(/g) ?? []).length === 1 && !/serpFor|organic\/live|\bpost\(/.test(imp));
}

/* ───────────────────────── 2. what is written, and how little is kept ───────────────────────── */

hr("2. The results are written once, and only the newest captures are kept");
interface Call { sql: string; params: unknown[] }
function recorder(): { c: any; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, c: { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rowCount: 0, rows: [] }; } } };
}
{
  const { c, calls } = recorder();
  const when = new Date("2026-10-12T06:00:00Z");
  const n = await writeSerpCapture(c, { clientId: "c1", targetId: "t1", keyword: "suboxone clinic near me", device: "desktop", capturedAt: when, organic: top });
  const inserts = calls.filter((x) => x.sql === INSERT_SERP_RESULT);
  ok("one row per kept result", n === top.length && inserts.length === top.length);
  ok("the prune runs once, after the inserts", calls.filter((x) => x.sql === PRUNE_SERP_RESULTS).length === 1 && calls[calls.length - 1]!.sql === PRUNE_SERP_RESULTS);
  ok(`the prune keeps the newest ${SERP_CAPTURES_KEPT} captures of the SAME search and device`, /LIMIT 4/.test(PRUNE_SERP_RESULTS) && /client_id = \$1 AND keyword = \$2 AND device = \$3/.test(PRUNE_SERP_RESULTS));
  ok("a repeated write of one capture is a no-op, not a duplicate", /ON CONFLICT \(client_id, keyword, device, captured_at, position\) DO NOTHING/.test(INSERT_SERP_RESULT));
  ok("no read_* column is written by the rank pull", !/read_state|read_at|word_count|headings_json|schema_types_json|phrase_bits/.test(INSERT_SERP_RESULT));
  const empty = recorder();
  const z = await writeSerpCapture(empty.c, { clientId: "c1", targetId: null, keyword: "k", device: "desktop", capturedAt: when, organic: [] });
  ok("a search with no organic result writes nothing, and prunes nothing", z === 0 && empty.calls.length === 0);
  selfTest("the prune is bounded to the same search", (t) => /client_id = \$1 AND keyword = \$2 AND device = \$3/.test(t), "WHERE client_id = $1 AND keyword = $2 AND device = $3", "WHERE client_id = $1");
}
{
  const imp = noComments(src("src/import-seo.ts"));
  ok("the check keeps the place it asked about, exactly as sent", /tasks\[i\]\?\.locationName/.test(imp) && /location_name, items_returned/.test(imp));
  ok("the details are written only where both columns exist", /hasCheckDetail/.test(imp) && /column_name IN \('location_name', 'items_returned'\)/.test(imp));
  ok("a failed check records no result count", /r\.error \? null : \(r\.itemsReturned \?\? null\)/.test(imp));
  ok("a failed check keeps no top results", /if \(!r \|\| r\.error \|\| !r\.organic\?\.length\) continue/.test(imp));
  ok("the older INSERTs remain for a database that has not been updated", (imp.match(/INSERT INTO seo_rank_history/g) ?? []).length === 3);
}

/* ───────────────────────── 3. which searches, which results ───────────────────────── */

hr("3. Only the searches where it changes the work are read, and only a few results of each");
const t = (day: number, rank: number | null, failed = false) => ({ at: new Date(Date.UTC(2026, 8, day)), rank, failed });
const facts: SearchFact[] = [
  { keyword: "push a", device: "desktop", points: [t(1, 22), t(8, 14)] },
  { keyword: "push b", device: "desktop", points: [t(1, 19), t(8, 12)] },
  { keyword: "fell out", device: "desktop", points: [t(1, 9), t(8, null)] },
  { keyword: "slipped", device: "desktop", points: [t(1, 6), t(8, 19)] },
  { keyword: "page one", device: "desktop", points: [t(1, 5), t(8, 4)] },
  { keyword: "never ranked", device: "desktop", points: [t(1, null), t(8, null)] },
  { keyword: "errored", device: "desktop", points: [t(1, 9), t(8, null, true)] },
  { keyword: "too far", device: "desktop", points: [t(1, 60), t(8, 45)] },
];
const chosen = chooseSearches(facts);
const names = chosen.chosen.map((c) => c.keyword);
ok("a search that fell out is chosen, and so are the ones just off page one", ["fell out", "slipped", "push a", "push b"].every((k) => names.includes(k)));
ok("a search on page one, one never ranked, one far down, and a failed check are not chosen", ["page one", "never ranked", "too far"].every((k) => !names.includes(k)) && !names.includes("errored"));
ok("a failed check is not a fall", !names.includes("errored"));
ok("lost searches come before pushes, nearest first", names.indexOf("slipped") < names.indexOf("push b") && names.indexOf("push b") < names.indexOf("push a"), names.join(", "));
{
  const many: SearchFact[] = Array.from({ length: 30 }, (_, i) => ({ keyword: `p${i}`, device: "desktop", points: [t(1, 30), t(8, 11 + (i % 10))] }));
  const r = chooseSearches(many);
  ok(`a client gets at most ${SERP_SEARCHES_PER_CLIENT} searches, and the rest are counted`, r.chosen.length === SERP_SEARCHES_PER_CLIENT && r.left === 30 - SERP_SEARCHES_PER_CLIENT);
}
const res = [1, 2, 3, 4, 5].map((p) => ({ position: p, url: `https://s${p}.example/x`, domain: p === 2 ? "www.client.example" : p === 3 ? "blog.client.example" : `s${p}.example` }));
const readList = resultsToRead(res, "client.example");
ok(`the client's own pages (and its subdomains) are never read, and at most ${SERP_PAGES_PER_SEARCH} are`, readList.length === SERP_PAGES_PER_SEARCH && readList.every((r) => !r.domain.includes("client.example")), readList.map((r) => r.position).join(","));
ok("a page read lately is reused, a stale one is not", reusable(new Date("2026-10-01"), new Date("2026-10-15")) && !reusable(new Date("2026-08-01"), new Date("2026-10-15")) && !reusable(null, new Date()) && SERP_REREAD_DAYS === 28);

/* ───────────────────────── 4. reading a page that ranks ───────────────────────── */

hr("4. A page that ranks is read politely, and only facts are kept");
const PAGE = (extra = "") => `<!doctype html><html><head><title>Suboxone treatment in Ohio</title>
<script type="application/ld+json">{"@type":["MedicalClinic","LocalBusiness"]}</script></head><body>
<nav><h2>Menu</h2></nav><h1>Suboxone clinic near me</h1>
<p>${"This is a long paragraph of invented clinic copy that must never be stored anywhere. ".repeat(40)}</p>
${Array.from({ length: 16 }, (_, i) => `<h2>Section number ${i} ${"x".repeat(i === 3 ? 120 : 0)}</h2>`).join("")}${extra}
</body></html>`;
interface Hit { url: string; at: number }
function site(opts: { robots?: { status: number; body?: string }; pages?: Record<string, { status: number; body?: string; headers?: Record<string, string> }> } = {}) {
  const hits: Hit[] = [];
  const f = (async (input: any) => {
    const url = String(input);
    hits.push({ url, at: Date.now() });
    if (url.endsWith("/robots.txt")) {
      const r = opts.robots ?? { status: 404 };
      return new Response(r.body ?? "", { status: r.status, headers: { "content-type": "text/plain" } });
    }
    const p = opts.pages?.[new URL(url).pathname];
    if (!p) return new Response("", { status: 404 });
    return new Response(p.body ?? PAGE(), { status: p.status, headers: { "content-type": "text/html", ...(p.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { f, hits };
}
{
  const s = site({ pages: { "/guide": { status: 200 } } });
  const sleeps: number[] = [];
  const read = makeReader({ fetchImpl: s.f, allowPrivate: true, sleep: async (ms) => { sleeps.push(ms); }, now: () => new Date("2026-10-12T08:00:00Z") });
  const got = await read("https://rival.example/guide", "suboxone clinic near me");
  ok("robots.txt is asked for first", s.hits[0]?.url === "https://rival.example/robots.txt");
  ok("the page is read", got.state === "read" && (got.wordCount ?? 0) > 100);
  ok("headings are level 2 and 3 only, at most 12, each cut to 70 characters", (got.headings?.length ?? 0) === HEADINGS_KEPT && (got.headings ?? []).every((h) => h.length <= HEADING_CUT) && !(got.headings ?? []).includes("Menu"));
  ok("structured-data types are kept as labels", (got.schemaTypes ?? []).includes("MedicalClinic"));
  ok("the search words are recorded as one small number", typeof got.phraseBits === "number" && (got.phraseBits ?? 0) > 0);
  const json = JSON.stringify(got);
  ok("no page text is kept", !json.includes("invented clinic copy") && Object.keys(got).sort().join(",") === "h1,headings,phraseBits,readAt,schemaTypes,state,wordCount");
  ok("a second request to one host waits (one a second)", sleeps.length >= 1 && sleeps.every((ms) => ms > 0));
}
{
  const s = site({ robots: { status: 200, body: "User-agent: *\nDisallow: /private" }, pages: { "/private/a": { status: 200 } } });
  const read = makeReader({ fetchImpl: s.f, allowPrivate: true, sleep: async () => {} });
  const got = await read("https://rival.example/private/a", "x");
  ok("a path robots.txt forbids is not fetched", got.state === "blocked_robots" && !s.hits.some((h) => h.url.endsWith("/private/a")));
}
{
  const s = site({ robots: { status: 503 }, pages: { "/a": { status: 200 } } });
  const read = makeReader({ fetchImpl: s.f, allowPrivate: true, sleep: async () => {} });
  const got = await read("https://rival.example/a", "x");
  ok("where robots.txt cannot be read, nothing is fetched", got.state === "blocked_robots" && !s.hits.some((h) => h.url.endsWith("/a")));
}
{
  const s = site({ pages: { "/old": { status: 301, headers: { location: "https://elsewhere.example/new" } } } });
  const read = makeReader({ fetchImpl: s.f, allowPrivate: true, sleep: async () => {} });
  const got = await read("https://rival.example/old", "x");
  ok("a redirect to another site is an answer, not followed", got.state === "off_site_redirect" && !s.hits.some((h) => h.url.includes("elsewhere.example/new")));
  const priv = await makeReader({ fetchImpl: s.f, sleep: async () => {} })("http://localhost/x", "x");
  ok("a private address is never fetched", priv.state === "fetch_failed" || priv.state === "blocked_robots");
  const missing = await read("https://rival.example/gone", "x");
  ok("a page that does not exist is a state with no facts", missing.state === "not_found" && missing.wordCount == null && missing.headings == null);
}

/* ───────────────────────── 5. pages by complete month ───────────────────────── */

hr("5. Each page's figures for a complete calendar month");
ok("on Oct 15 the last three finished months are Sep, Aug and Jul", completeMonths("2026-10-15", 3).map((m) => m.month).join(",") === "2026-09,2026-08,2026-07");
ok("on Oct 2 September is not final yet (three days behind), August is the newest", completeMonths("2026-10-02", 2).map((m) => m.month).join(",") === "2026-08,2026-07");
ok("on Oct 3 September is final", completeMonths("2026-10-03", 1)[0]?.month === "2026-09");
ok("the month in progress is never listed", !completeMonths("2026-10-31", 5).some((m) => m.month === "2026-10"));
ok("a month spans its first to its last day, a leap February included", completeMonths("2028-03-20", 1)[0]?.end === "2028-02-29" && completeMonths("2026-10-15", 1)[0]?.start === "2026-09-01");
ok("a backfill stops at sixteen months", completeMonths("2026-10-15", 40).length === 16);
const gsc = parseGscMonth({ rows: [
  { keys: ["https://client.example/suboxone-treatment/?utm=1"], clicks: 100, impressions: 1000, position: 8 },
  { keys: ["https://client.example/suboxone-treatment"], clicks: 20, impressions: 3000, position: 12 },
  { keys: ["(not set)"], clicks: 5, impressions: 5, position: 1 },
  { keys: ["https://client.example/zero"], clicks: 0, impressions: 0, position: 0 },
] });
const merged = gsc.rows.find((r) => r.path === "/suboxone-treatment");
ok("two spellings of one address are one page", gsc.rows.filter((r) => r.path === "/suboxone-treatment").length === 1 && merged?.clicks === 120 && merged?.impressions === 4000);
ok("position is weighted by impressions when pages merge", merged?.position === 11, `${merged?.position}`);
ok("a place holder that is not a page is dropped", !gsc.rows.some((r) => r.path.includes("not set")));
ok("a page with no impressions has no position, not a nought", gsc.rows.find((r) => r.path === "/zero")?.position === null);
const ga = parseGa4Month({ rows: [
  { dimensionValues: [{ value: "/suboxone-treatment/" }], metricValues: [{ value: "412" }] },
  { dimensionValues: [{ value: "/suboxone-treatment" }], metricValues: [{ value: "8" }] },
  { dimensionValues: [{ value: "(not set)" }], metricValues: [{ value: "99" }] },
] });
ok("analytics sessions are summed per page and the unplaced row is dropped", ga.length === 1 && ga[0]?.sessions === 420 && ga[0]?.clicks === null);
ok("analytics is asked for unpaid search only", /Organic Search/.test(JSON.stringify(ga4MonthRequest({ month: "2026-09", start: "2026-09-01", end: "2026-09-30" }))));
selfTest("the unpaid-search filter", (x) => /Organic Search/.test(x), "stringFilter Organic Search", "dimensions landingPage only");
{
  const rows = Array.from({ length: PAGE_MONTH_ROWS + 5 }, (_, i) => ({ path: `/p${i}`, clicks: PAGE_MONTH_ROWS + 5 - i, impressions: 1, position: 3, sessions: null }));
  const c = capMonth(rows, "gsc", { month: "2026-09", start: "2026-09-01", end: "2026-09-30" });
  ok(`a month is cut at ${PAGE_MONTH_ROWS} pages, busiest first, and the cut is counted`, c.rows.length === PAGE_MONTH_ROWS && c.cut === 5 && c.rows[0]!.path === "/p0");
  ok("the per-month page cap is the one the dashboard's reading assumes (1000, ours)", PAGE_MONTH_ROWS === 1000);
  ok("each row says the last day it covers", c.rows.every((r) => r.coveredTo === "2026-09-30"));
}
{
  const calls: string[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push(`${init?.method} ${url}`);
    const body = url.includes("searchAnalytics") ? { rows: [{ keys: ["https://client.example/a"], clicks: 3, impressions: 30, position: 4 }] } : { rows: [{ dimensionValues: [{ value: "/a" }], metricValues: [{ value: "9" }] }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const span = { month: "2026-09", start: "2026-09-01", end: "2026-09-30" };
  const g = await readGscMonth(f, "tok", "sc-domain:client.example", span);
  const a = await readGa4Month(f, "tok", "123", span);
  ok("one Search Console call and one analytics call per month", calls.length === 2 && g.rows.length === 1 && a.rows.length === 1);
  const reqBody = JSON.stringify({ x: 1 });
  void reqBody;
  ok("both reads are read-only questions", calls.every((c) => c.startsWith("POST ")) && !calls.some((c) => /\b(PUT|PATCH|DELETE)\b/.test(c)));
}
{
  ok("a month is replaced as a whole, from the source's answer only", /DELETE FROM seo_page_months WHERE client_id = \$1 AND source = \$2 AND month = \$3/.test(DELETE_PAGE_MONTH) && /ON CONFLICT \(client_id, source, page_path, month\) DO UPDATE/.test(INSERT_PAGE_MONTH));
  const runner = noComments(src("src/read-page-months.ts"));
  ok("the delete and the inserts sit in one transaction, rolled back on a failure", /BEGIN[\s\S]*DELETE_PAGE_MONTH[\s\S]*INSERT_PAGE_MONTH[\s\S]*COMMIT[\s\S]*ROLLBACK/.test(runner));
  ok("a source that failed is never written over", /try \{[\s\S]*?readGscMonth[\s\S]*?writeMonth[\s\S]*?\} catch/.test(runner));
  selfTest("the transaction check", (x) => /BEGIN[\s\S]*COMMIT[\s\S]*ROLLBACK/.test(x), "BEGIN; COMMIT; ROLLBACK", "COMMIT only");
}

/* ───────────────────────── 6. wiring ───────────────────────── */

hr("6. Scheduling and heartbeats");
for (const [file, job] of [[".github/workflows/read-page-months.yml", "read_page_months"], [".github/workflows/read-serp-pages.yml", "read_serp_pages"]] as const) {
  const y = src(file);
  ok(`${file} is scheduled and dispatchable with a client_id`, /schedule:\s*\n\s*- cron:/.test(y) && /workflow_dispatch/.test(y) && /client_id:/.test(y));
  ok(`${file} heartbeats as ${job}, on failure too, and not from a scoped or dry run`, new RegExp(`--job=${job}`).test(y) && /if: always\(\) && inputs\.dry_run != 'true' && inputs\.client_id == ''/.test(y));
}
ok("the weekly rank pull is before both readers", /cron: "0 6 \* \* 1"/.test(src(".github/workflows/import-seo.yml")) && /cron: "0 8 \* \* 1"/.test(src(".github/workflows/read-serp-pages.yml")));
ok("the new modules call no search provider and no ad platform", !/dataforseo|googleads|google-ads|graph\.facebook/i.test(noComments(src("src/serp-pages/read.ts") + src("src/serp-pages/select.ts") + src("src/page-behaviour/months.ts"))));

console.log(`\n${failures === 0 ? "ALL PAGE-HISTORY CHECKS PASSED" : `${failures} PAGE-HISTORY CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

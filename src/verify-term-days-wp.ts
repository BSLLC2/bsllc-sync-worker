#!/usr/bin/env tsx
/**
 * Guard for two readers: search terms by day (Google Ads) and WordPress site
 * changes (a site's public REST API).
 *
 * No network, no ad account, no client. The "sites" are a throwaway HTTP server
 * on 127.0.0.1 and the reader's `fetch` is pointed at it by a function that
 * prefixes the made-up host onto the path. The real parser, the real robots
 * rules, the real fetcher and the real run are driven end to end. The store
 * section runs only when ADS_VERIFY_DATABASE_URL is set (CI's `ads-store` job).
 *
 * EVERY SITE, TERM, PAGE AND FIGURE BELOW IS INVENTED. The GAQL field names and
 * the WordPress REST shapes are written from the published references and have
 * never been tried against a live account or a live site.
 *
 *   npx tsx src/verify-term-days-wp.ts
 */
import * as http from "node:http";
import * as fs from "node:fs";
import pg from "pg";
import {
  MAX_ROWS, SEARCH_TERM_DAYS_GAQL, TERM_MAX, buildSearchTermRows, ensureSearchTermTables, normalizeSearchTermDay,
  recordSearchTermFailure, storeSearchTermDays, termWindow,
} from "./ads/search-term-days.js";
import { parseWpList, pathOfLink, readWpSite, summaryLine, EDIT_GAP_MINUTES, READABLE_KINDS, KINDS, FIELDS } from "./wp-changes/wp.js";
import { ensureSiteChangeTables, storeWpResult } from "./wp-changes/store.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);

// ── 1. Search term rows ──────────────────────────────────────────────────────
section("1. Search terms by day: the rows");
const raw = (term: string, date: string, over: Record<string, unknown> = {}, m: Record<string, unknown> = {}) => ({
  campaign: { id: "11", name: "Brand Core" }, ad_group: { id: "21", name: "Core" },
  search_term_view: { search_term: term }, segments: { date, keyword: { info: { text: "Acme Co", match_type: 3 } } },
  metrics: { impressions: 10, clicks: 2, cost_micros: 3_500_000, conversions: 0, conversions_value: 0, ...m }, ...over,
});
ok("the query is a SELECT on search_term_view with a date segment", /^\s*SELECT[\s\S]*FROM search_term_view[\s\S]*segments\.date BETWEEN/.test(SEARCH_TERM_DAYS_GAQL) && !/mutate|INSERT|UPDATE|DELETE/i.test(SEARCH_TERM_DAYS_GAQL));
const w = termWindow("2026-11-10");
ok("the window is 90 days ending yesterday", w.end === "2026-11-09" && w.start === "2026-08-12", `${w.start} to ${w.end}`);
const n1 = normalizeSearchTermDay(raw("Acme Co Phone Number", "2026-11-01"));
ok("a term is lower-cased and capped", n1?.term === "acme co phone number" && normalizeSearchTermDay(raw("x".repeat(500), "2026-11-01"))!.term.length === TERM_MAX);
ok("money stays in micros", n1?.costMicros === 3_500_000);
ok("a row with no term, no date or no campaign is dropped", normalizeSearchTermDay(raw("", "2026-11-01")) === null && normalizeSearchTermDay(raw("a b", "11/01/2026")) === null && normalizeSearchTermDay({ ...raw("a b", "2026-11-01"), campaign: {} }) === null);
const rows0 = buildSearchTermRows([raw("alpha", "2026-11-01"), raw("alpha", "2026-11-01"), raw("beta", "2026-11-01")]);
ok("repeats of one key are summed", rows0.length === 2 && rows0.find((r) => r.term === "alpha")!.clicks === 4 && rows0.find((r) => r.term === "alpha")!.costMicros === 7_000_000);
ok("no conversion anywhere in the window means NULL, not 0", rows0.every((r) => r.conversions === null && r.conversionsValue === null));
const rows1 = buildSearchTermRows([raw("alpha", "2026-11-01", {}, { conversions: 2, conversions_value: 120 }), raw("beta", "2026-11-01")]);
ok("once one conversion is reported the others are a real 0", rows1.find((r) => r.term === "beta")!.conversions === 0 && rows1.find((r) => r.term === "alpha")!.conversions === 2);
ok("the matched keyword and match type are kept; a term with no keyword has none", n1?.matchedKeyword === "acme co" && n1?.matchType === "PHRASE" && normalizeSearchTermDay({ ...raw("z y", "2026-11-01"), segments: { date: "2026-11-01" } })!.matchedKeyword === "");
ok("the row ceiling is a number the job refuses at", MAX_ROWS >= 50_000);
const jobSrc = fs.readFileSync(new URL("./ads-search-term-days.ts", import.meta.url), "utf8");
ok("the job refuses a read at the row ceiling and writes nothing", /list\.length >= MAX_ROWS[\s\S]{0,400}throw new Error/.test(jobSrc));
ok("a failure writes a failure row, not silence", /recordSearchTermFailure/.test(jobSrc));
ok("a dry run writes nothing", /if \(dryRun\) \{ console\.log\(`      \(dry run, nothing written\)`\); continue; \}[\s\S]{0,80}storeSearchTermDays/.test(jobSrc));
const wfT = fs.readFileSync(new URL("../.github/workflows/ads-search-term-days.yml", import.meta.url), "utf8");
ok("the term workflow is scheduled, dry by default, heartbeats on failure and never for a dry or scoped run",
  /schedule:\s*\n\s*(?:#[^\n]*\n\s*)*- cron:/.test(wfT) && /dry_run:[\s\S]*?default: "true"/.test(wfT) && /if: always\(\) && inputs\.dry_run != 'true' && inputs\.client == ''/.test(wfT) && /--job=ads_search_term_days/.test(wfT));

// ── 2. WordPress reads, against a pretend site ───────────────────────────────
section("2. WordPress changes: the parser");
const SITE = "shop.example.test";
const d = (s: string) => s; // an ISO GMT string without a Z, as WordPress writes it
const NOW = Date.parse("2026-11-10T12:00:00Z");
const cutoff = NOW - 120 * 86_400_000;
const item = (id: number, link: string, pub: string, mod: string, extra: Record<string, unknown> = {}) => ({ id, link, date_gmt: d(pub), modified_gmt: d(mod), status: "publish", ...extra });
const list = [
  item(1, `https://${SITE}/blog/new-post/?utm=1#x`, "2026-11-05T10:00:00", "2026-11-05T10:00:00", { title: { rendered: "A SECRET TITLE" }, content: { rendered: "BODY TEXT" } }),
  item(2, `https://${SITE}/services/`, "2026-06-01T10:00:00", "2026-11-08T09:30:00"),
  item(3, `https://other.example.test/x`, "2026-11-01T10:00:00", "2026-11-01T10:00:00"),
  item(4, `https://${SITE}/draft`, "2026-11-01T10:00:00", "2026-11-01T10:00:00", { status: "draft" }),
  item(5, `https://${SITE}/touched`, "2026-11-01T10:00:00", "2026-11-01T10:30:00"),
];
const p = parseWpList(list, "post", SITE, cutoff)!;
ok("a published item is a 'published' change at its published time, path only", p.changes.some((c) => c.externalId === "post:1" && c.event === "published" && c.urlPath === "/blog/new-post" && c.at === "2026-11-05T10:00:00.000Z"));
ok("a later modified time is an 'edited' change", p.changes.some((c) => c.externalId === "post:2" && c.event === "edited" && c.at === "2026-11-08T09:30:00.000Z"));
ok("an item modified within an hour of publication is not an edit", !p.changes.some((c) => c.externalId === "post:5" && c.event === "edited") && EDIT_GAP_MINUTES === 60);
ok("a link on another site, and a draft, are dropped and counted", !p.changes.some((c) => c.externalId === "post:3" || c.externalId === "post:4") && p.dropped === 2);
ok("NO TITLE AND NO CONTENT survive into a change", !/SECRET TITLE|BODY TEXT/.test(JSON.stringify(p)) && p.changes.every((c) => Object.keys(c).sort().join() === "at,event,externalId,kind,urlPath"));
ok("the request asks for only the five fields", FIELDS === "id,link,date_gmt,modified_gmt,status");
ok("only posts and pages are read without a login", READABLE_KINDS.join() === "post,page" && KINDS.includes("plugin") && KINDS.includes("core"));
ok("a link's query and fragment never reach the path", pathOfLink(`https://${SITE}/a/b/?x=1#y`, SITE) === "/a/b" && pathOfLink("javascript:alert(1)", SITE) === null);
ok("an answer that is not a list is not a list", parseWpList({ code: "rest_forbidden" }, "post", SITE, cutoff) === null);
ok("a change older than the lookback is not listed", parseWpList([item(9, `https://${SITE}/old`, "2025-01-01T00:00:00", "2025-01-02T00:00:00")], "post", SITE, cutoff)!.changes.length === 0);

section("3. WordPress changes: the whole read against pretend sites");
type Reply = { status?: number; type?: string; body?: string };
const routes = new Map<string, Reply | ((u: URL) => Reply)>();
const requests: string[] = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  requests.push(`${req.method} ${u.pathname}${u.search}`);
  const key = u.pathname;
  const hit = routes.get(key);
  const r: Reply = typeof hit === "function" ? hit(u) : hit ?? { status: 404, type: "text/html", body: "<h1>nothing</h1>" };
  res.statusCode = r.status ?? 200;
  res.setHeader("content-type", r.type ?? "text/html");
  res.end(r.body ?? "");
});
let port = 0;
const fakeFetch: typeof fetch = (input, init) => {
  const u = new URL(String(input));
  return fetch(`http://127.0.0.1:${port}/${u.hostname.replace(/^www\./, "")}${u.pathname}${u.search}`, init);
};
const json = (v: unknown): Reply => ({ type: "application/json", body: JSON.stringify(v) });
const deps = { fetchImpl: fakeFetch, allowPrivate: true, delayMs: 0, timeoutMs: 800, sleep: async () => {}, now: () => NOW };
const setSite = (host: string, o: { robots?: Reply; root?: Reply; posts?: Reply | ((u: URL) => Reply); pages?: Reply | ((u: URL) => Reply) }) => {
  routes.set(`/${host}/robots.txt`, o.robots ?? { status: 404 });
  if (o.root) routes.set(`/${host}/wp-json/`, o.root);
  if (o.posts) routes.set(`/${host}/wp-json/wp/v2/posts`, o.posts);
  if (o.pages) routes.set(`/${host}/wp-json/wp/v2/pages`, o.pages);
};
const rootOk = json({ name: "Shop", namespaces: ["oembed/1.0", "wp/v2"] });

async function checkReads() {
  setSite("shop.example.test", { root: rootOk, posts: json(list), pages: json([item(30, "https://shop.example.test/about/", "2026-10-01T10:00:00", "2026-11-02T10:00:00")]) });
  const good = await readWpSite("https://www.shop.example.test/", deps);
  ok("a readable site is 'read' with its changes", good.state === "read" && good.changes.length === 5, `${good.state}, ${good.changes.length}`);
  ok("only GETs were sent, and only to the public paths", requests.every((r) => r.startsWith("GET ")) && requests.filter((r) => !r.includes("/robots.txt") && !r.includes("/wp-json/")).length === 0);
  ok("the request carried the field filter", requests.some((r) => r.includes(`_fields=${FIELDS}`)));

  setSite("norest.example.test", { root: { status: 404, type: "text/html", body: "<h1>Not Found</h1>" } });
  const norest = await readWpSite("norest.example.test", deps);
  ok("A SITE WITH NO REST API IS 'no_rest', NEVER 'read' WITH NO EDITS", norest.state === "no_rest" && norest.changes.length === 0, norest.note);

  setSite("htmlwall.example.test", { root: { status: 200, type: "text/html", body: "<html>please log in</html>" } });
  ok("a 200 HTML page at /wp-json/ is no_rest", (await readWpSite("htmlwall.example.test", deps)).state === "no_rest");
  setSite("nons.example.test", { root: json({ namespaces: ["oembed/1.0"] }), posts: json(list), pages: json([]) });
  ok("a JSON answer without wp/v2 is no_rest", (await readWpSite("nons.example.test", deps)).state === "no_rest");
  setSite("locked.example.test", { root: rootOk, posts: { status: 401, type: "application/json", body: json({ code: "rest_cannot_access" }).body } });
  ok("a posts list closed to visitors is no_rest, not 'no edits'", (await readWpSite("locked.example.test", deps)).state === "no_rest");

  setSite("closed.example.test", { robots: { type: "text/plain", body: "User-agent: *\nDisallow: /wp-json/\n" }, root: rootOk, posts: json(list) });
  const before = requests.length;
  const closed = await readWpSite("closed.example.test", deps);
  ok("robots.txt forbidding /wp-json/ stops the read before any API call", closed.state === "blocked_robots" && requests.slice(before).every((r) => r.includes("robots.txt")));
  setSite("brokenrobots.example.test", { robots: { status: 503, type: "text/plain", body: "" }, root: rootOk, posts: json(list) });
  const br = await readWpSite("brokenrobots.example.test", deps);
  ok("a robots.txt that cannot be read means nothing is fetched", br.state === "robots_unreadable" && br.changes.length === 0);
  ok("no site address is no_site", (await readWpSite("  ", deps)).state === "no_site");
  const dead = await readWpSite("never.example.test", { ...deps, fetchImpl: (async () => { throw new Error("connection refused"); }) as typeof fetch });
  ok("an unreachable site is 'unreachable'", dead.state === "unreachable");

  // Paging: a first page of exactly 100 items asks for page 2; page 2 answers 400 and ends the read.
  const many = Array.from({ length: 100 }, (_, i) => item(100 + i, `https://paged.example.test/p${i}`, "2026-11-01T10:00:00", "2026-11-09T10:00:00"));
  setSite("paged.example.test", { root: rootOk, posts: (u) => (u.searchParams.get("page") === "1" ? json(many) : { status: 400, type: "application/json", body: json({ code: "rest_post_invalid_page_number" }).body }), pages: json([]) });
  const paged = await readWpSite("paged.example.test", deps);
  ok("a full page asks for the next; a page past the end is the end, not a failure", paged.state === "read" && paged.items === 100 && !paged.capped);

  ok("the summary line counts what it did", /^\d+ sites?: \d+ read, \d+ changes? listed, \d+ not readable, \d+ could not be reached$/.test(summaryLine([good, norest, closed, dead])));
}

async function checkStore() {
  const url = process.env.ADS_VERIFY_DATABASE_URL;
  section("4. The real store, on a throwaway schema");
  if (!url) {
    console.log("  ⏭  skipped: ADS_VERIFY_DATABASE_URL is not set. CI runs this in the `ads-store` job against a Postgres service container.");
    return;
  }
  const schema = `termwp_${Math.random().toString(36).slice(2, 10)}`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await ensureSearchTermTables(c); await ensureSearchTermTables(c);
    await ensureSiteChangeTables(c); await ensureSiteChangeTables(c);
    ok("the four tables are created, twice, without error", true);
    const win = { start: "2026-08-12", end: "2026-11-09" };
    const rows = buildSearchTermRows([raw("alpha", "2026-11-01", {}, { conversions: 2, conversions_value: 50 }), raw("beta", "2026-11-02")]);
    await storeSearchTermDays(c, "CL", "999", rows, win);
    let n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_search_term_days`)).rows[0]!.n;
    ok("rows are stored", n === "2");
    const beta = (await c.query<{ conversions: number | null; cost_micros: string; impression_share: number | null }>(`SELECT conversions, cost_micros, impression_share FROM ads_search_term_days WHERE term='beta'`)).rows[0]!;
    ok("a zero conversion is stored as 0 once evidenced; impression share is NULL; money is micros", beta.conversions === 0 && beta.impression_share === null && beta.cost_micros === "3500000");
    const none = buildSearchTermRows([raw("gamma", "2026-11-03")]);
    await storeSearchTermDays(c, "CL", "999", none, win);
    n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_search_term_days`)).rows[0]!.n;
    const gamma = (await c.query<{ conversions: number | null }>(`SELECT conversions FROM ads_search_term_days WHERE term='gamma'`)).rows[0]!;
    ok("a re-read REPLACES the window (a term that stopped leaves no stale row) and an unevidenced zero is NULL", n === "1" && gamma.conversions === null);
    await recordSearchTermFailure(c, "CL", "999", "auth expired");
    const scan = (await c.query<{ ok: boolean; covered_to: string | null; note: string }>(`SELECT ok, covered_to, note FROM ads_search_term_scans WHERE account_id='999'`)).rows[0]!;
    ok("a failure marks the scan not ok and keeps the earlier span", scan.ok === false && scan.covered_to === "2026-11-09" && /auth expired/.test(scan.note));
    n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_search_term_days`)).rows[0]!.n;
    ok("a failure leaves the earlier rows", n === "1");

    const good = await readWpSite("shop.example.test", deps);
    let r1 = await storeWpResult(c, "CL", good);
    const ev = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM site_change_events`)).rows[0]!.n;
    ok("changes are stored once", r1.inserted === 5 && ev === "5");
    r1 = await storeWpResult(c, "CL", good);
    ok("a second read of the same site adds nothing", r1.inserted === 0);
    const cols = (await c.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'site_change_events'`)).rows.map((x) => x.column_name);
    ok("THE EVENT TABLE HAS NO COLUMN THAT COULD HOLD A TITLE OR CONTENT", !cols.some((x) => /title|content|body|excerpt|name|text/.test(x)), cols.join(","));
    const scan1 = (await c.query<{ last_read_at: Date }>(`SELECT last_read_at FROM site_change_scans WHERE client_id='CL'`)).rows[0]!;
    const norest = await readWpSite("norest.example.test", deps);
    await storeWpResult(c, "CL", norest);
    const scan2 = (await c.query<{ state: string; last_read_at: Date | null; items_read: number }>(`SELECT state, last_read_at, items_read FROM site_change_scans WHERE client_id='CL'`)).rows[0]!;
    ok("a later 'no REST API' answer is recorded as such and keeps the last good read time and the earlier events", scan2.state === "no_rest" && scan2.last_read_at !== null && scan2.last_read_at.getTime() === scan1.last_read_at.getTime() && scan2.items_read > 0 && (await c.query(`SELECT 1 FROM site_change_events`)).rowCount === 5);
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
}

section("5. Wiring");
const wfW = fs.readFileSync(new URL("../.github/workflows/read-wp-changes.yml", import.meta.url), "utf8");
ok("the WordPress workflow is scheduled, dry by default and heartbeats on failure", /schedule:\s*\n\s*(?:#[^\n]*\n\s*)*- cron:/.test(wfW) && /dry_run:[\s\S]*?default: "true"/.test(wfW) && /if: always\(\) && inputs\.dry_run != 'true' && inputs\.client_id == ''/.test(wfW) && /--job=read_wp_changes/.test(wfW));
const wpSrc = fs.readFileSync(new URL("./wp-changes/wp.ts", import.meta.url), "utf8");
const storeSrc = fs.readFileSync(new URL("./wp-changes/store.ts", import.meta.url), "utf8");
ok("the reader sends only GETs and keeps no title field", !/method:\s*"(POST|PUT|PATCH|DELETE)"/i.test(wpSrc) && !/title|content\.rendered|excerpt/.test(storeSrc.replace(/\/\*[\s\S]*?\*\//g, "")));
ok("a state other than 'read' never writes events", /if \(r\.state === "read"\) \{[\s\S]{0,400}INSERT INTO site_change_events/.test(storeSrc));

async function main() {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => { port = (server.address() as { port: number }).port; resolve(); }));
  try {
    await checkReads();
    await checkStore();
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll term-day and WordPress checks passed.");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

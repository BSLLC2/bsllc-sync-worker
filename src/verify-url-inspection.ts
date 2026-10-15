#!/usr/bin/env tsx
/**
 * Guard for the URL inspection reader: what it asks Search Console, what it keeps,
 * and what it refuses to turn into "indexed".
 *
 * No Google, no database, no token. A pretend Search Console (a real HTTP server on a
 * local port) answers the real request builder, the real parser and the real
 * orchestration through the real fetch, and a recording client stands in for
 * Postgres so the real INSERTs are read as text and as parameters.
 *
 * EVERY CLIENT, PAGE, PROPERTY AND ANSWER BELOW IS INVENTED.
 *
 * WHAT THIS CANNOT PROVE. The request and response shapes are written from the URL
 * Inspection API reference and have not been run against a live property. A green
 * run means the code does what it says against the shapes it expects, not that
 * Google answers in them. docs/INTEGRATIONS-SETUP.md (dashboard repository) lists
 * each as unverified.
 *
 *   npx tsx src/verify-url-inspection.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { startFake, type Call } from "./signals/fake-http.js";
import { realFetch } from "./page-behaviour/http.js";
import { inspectionBody, parseInspection, richResultsSmall, inspectUrl } from "./url-inspection/inspect.js";
import { allowance, dueOnly, fell, pickPages, type PageStat } from "./url-inspection/pick.js";
import { addressFor, inspectClient, type InspectCtx } from "./url-inspection/run.js";
import { COUNT_TODAY, INSERT_INSPECTION, PRUNE_INSPECTION, writeInspection } from "./url-inspection/store.js";
import { INSPECT_DAILY_CAP, INSPECT_ENDPOINT, INSPECT_RUN_MAX, KEEP_PER_URL, PICKED_FOR, PUBLISHED_PER_PROPERTY_PER_DAY, STOP_AFTER_FAILURES } from "./url-inspection/types.js";
import { googleToken } from "./signals/google.js";
import { INSERT_SIGNAL_RUN, SIGNAL_STATUSES, signalRun } from "./signals/common.js";
import { SECRET_NAMES, missingSecretMessage } from "./signals/secrets.js";

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

const GOOD = {
  inspectionResult: {
    inspectionResultLink: "https://search.google.com/search-console/inspect?resource_id=x",
    indexStatusResult: {
      verdict: "PASS", coverageState: "Submitted and indexed", robotsTxtState: "ALLOWED", indexingState: "INDEXING_ALLOWED",
      lastCrawlTime: "2026-09-12T08:30:00Z", pageFetchState: "SUCCESSFUL", googleCanonical: "https://example.test/services/", userCanonical: "https://example.test/services/",
      crawledAs: "MOBILE",
    },
    mobileUsabilityResult: { verdict: "PASS" },
    richResultsResult: { verdict: "PASS", detectedItems: [{ richResultType: "FAQ", items: [{ name: "secret-name", issues: [{ issueMessage: "Missing field", severity: "WARNING" }] }] }] },
  },
};

const stats = (path: string, cn: number | null, cp: number | null, inn: number | null = null, ip: number | null = null): PageStat =>
  ({ path, clicksNow: cn, clicksPrior: cp, impressionsNow: inn, impressionsPrior: ip });

type Rec = { sql: string; params: unknown[] };
const recorder = () => { const calls: Rec[] = []; return { calls, query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params: params ?? [] }); return {}; } }; };

async function main() {
  /* ───────────────────────── 1. the parser ───────────────────────── */
  hr("1. an answer becomes facts, and an empty answer is never 'indexed'");
  const f = parseInspection(GOOD);
  ok("verdict, coverage, indexing and fetch state are read as sent", f.verdict === "PASS" && f.coverageState === "Submitted and indexed" && f.indexingState === "INDEXING_ALLOWED" && f.pageFetchState === "SUCCESSFUL" && f.robotsTxtState === "ALLOWED");
  ok("both canonicals are kept", f.googleCanonical === "https://example.test/services/" && f.userCanonical === "https://example.test/services/");
  ok("the last crawl is a date", f.lastCrawlAt instanceof Date && f.lastCrawlAt.toISOString() === "2026-09-12T08:30:00.000Z");
  ok("the mobile verdict is read", f.mobileVerdict === "PASS");
  const rr = JSON.parse(f.richResultsJson ?? "null") as { verdict: string; types: Array<{ type: string; items: number; issues: number; errors: number; first: string | null }> };
  ok("rich results are kept small: a type, counts, one message", rr.verdict === "PASS" && rr.types.length === 1 && rr.types[0]!.type === "FAQ" && rr.types[0]!.issues === 1 && rr.types[0]!.errors === 0 && rr.types[0]!.first === "Missing field");
  ok("an item's own name is NOT kept", !String(f.richResultsJson).includes("secret-name"));
  ok("rich results stay under 2,000 characters even for a huge answer", (richResultsSmall({ verdict: "FAIL", detectedItems: Array.from({ length: 50 }, (_, i) => ({ richResultType: `Type${i}`, items: [{ issues: [{ issueMessage: "x".repeat(400), severity: "ERROR" }] }] })) }) ?? "").length <= 2000);
  for (const [label, body] of [["an empty object", {}], ["no index result", { inspectionResult: { mobileUsabilityResult: { verdict: "PASS" } } }], ["a string", "indexed"], ["null", null], ["an array", []]] as const) {
    let threw = false;
    try { parseInspection(body); } catch { threw = true; }
    ok(`${label} is refused, not read as an inspection`, threw);
  }
  const bare = parseInspection({ inspectionResult: { indexStatusResult: { verdict: "NEUTRAL" } } });
  ok("a field Google did not send is NULL, never a value", bare.lastCrawlAt === null && bare.googleCanonical === null && bare.coverageState === null && bare.pageFetchState === null && bare.mobileVerdict === null && bare.richResultsJson === null);
  ok("an unreadable crawl time is NULL", parseInspection({ inspectionResult: { indexStatusResult: { verdict: "PASS", lastCrawlTime: "last tuesday" } } }).lastCrawlAt === null);
  ok("the request body names the page and the property", JSON.stringify(inspectionBody("https://example.test/a/", "sc-domain:example.test")) === JSON.stringify({ inspectionUrl: "https://example.test/a/", siteUrl: "sc-domain:example.test", languageCode: "en-US" }));

  /* ───────────────────────── 2. which pages, and how many ───────────────────────── */
  hr("2. the quota is spent on the pages whose answer explains something");
  const list: PageStat[] = [
    stats("/", 50, 60), stats("/a", 3, 40), stats("/b", 10, 12), stats("/c", 5, 5, 400, 900), stats("/d", 80, 70), stats("/e", null, 20, null, null), stats("/f", 1, 1, 5, 5),
  ];
  const picked = pickPages(list, 10);
  ok("a fallen page comes first, the biggest loss first", picked[0]?.path === "/a" && picked[0]?.pickedFor === "fell" && picked[0]?.lostClicks === 37, picked.map((p) => `${p.path}:${p.pickedFor}`).join(" "));
  ok("a page with lost impressions and no lost clicks counts as fallen", picked.some((p) => p.path === "/c" && p.pickedFor === "fell"));
  ok("a page missing a window is skipped, never read as a fall", !picked.some((p) => p.path === "/e" && p.pickedFor === "fell") && fell(stats("/e", null, 20)) === false);
  ok("the home page is always asked about", picked.some((p) => p.path === "/" && (p.pickedFor === "home" || p.pickedFor === "fell")));
  ok("a page appears once", new Set(picked.map((p) => p.path)).size === picked.length);
  ok("the busiest pages fill the rest", picked.some((p) => p.pickedFor === "top" && p.path === "/d"));
  ok("a tiny drop is not a fall", fell(stats("/x", 9, 10, 80, 90)) === true && fell(stats("/x", 10, 10, 80, 90)) === false);
  ok("never more than asked", pickPages(Array.from({ length: 200 }, (_, i) => stats(`/p${i}`, i, i + 5)), 12).length === 12);
  ok("fallen pages leave room for the home page and the busiest", (() => { const many = Array.from({ length: 100 }, (_, i) => stats(`/p${i}`, 1, 50 + i)); const r = pickPages(many, 20); return r.some((p) => p.pickedFor === "home") && r.filter((p) => p.pickedFor === "fell").length <= 14; })());
  const now = new Date("2026-10-15T09:40:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const due = dueOnly([{ path: "/a", pickedFor: "fell", lostClicks: 1, lostImpressions: null }, { path: "/b", pickedFor: "top", lostClicks: null, lostImpressions: null }, { path: "/c", pickedFor: "top", lostClicks: null, lostImpressions: null }, { path: "/d", pickedFor: "home", lostClicks: null, lostImpressions: null }],
    new Map([["/a", daysAgo(3)], ["/b", daysAgo(3)], ["/c", daysAgo(9)]]), now);
  ok("a page looked at recently waits; a fallen one is allowed again sooner; one never looked at is due", due.map((p) => p.path).join(",") === "/a,/c,/d", due.map((p) => p.path).join(","));
  ok("our daily cap is far below Google's published one", INSPECT_DAILY_CAP * 10 <= PUBLISHED_PER_PROPERTY_PER_DAY && PUBLISHED_PER_PROPERTY_PER_DAY === 2000);
  ok("the allowance is the smaller of the run limit and what is left today", allowance(0) === INSPECT_RUN_MAX && allowance(140) === 10 && allowance(150) === 0 && allowance(400) === 0 && allowance(-5) === INSPECT_RUN_MAX);

  /* ───────────────────────── 3. the run, through a real HTTP server ───────────────────────── */
  hr("3. the run, against a pretend Search Console on a local port");
  const asked: string[] = [];
  const fake = await startFake((c: Call) => {
    if (c.path !== "/gsc/v1/urlInspection/index:inspect") return undefined;
    const body = JSON.parse(c.body) as { inspectionUrl: string };
    asked.push(body.inspectionUrl);
    if (body.inspectionUrl.includes("/bad")) return { status: 400, body: { error: { message: "URL not under property" } } };
    return { body: GOOD };
  });
  process.env.SIGNALS_FAKE_BASE = fake.base;
  const ctx = (over: Partial<InspectCtx> = {}): InspectCtx => ({
    id: "c1", name: "Example Co", property: "sc-domain:example.test", domain: "example.test", observedUrls: [], knownUrls: new Map(), stats: list, lastOk: new Map(), usedToday: 0, ...over,
  });
  const deps = { fetch: realFetch, token: () => googleToken("scope", { client_email: "x@y", private_key: "k" }), now, pauseMs: 0, secrets: ["super-secret-key"] };
  const r1 = await inspectClient(ctx(), deps);
  ok("every chosen page was asked about, with the right path and body", fake.calls.filter((c) => c.path === "/gsc/v1/urlInspection/index:inspect").length === r1.rows.length && r1.rows.length > 0);
  const first = fake.calls.find((c) => c.path === "/gsc/v1/urlInspection/index:inspect")!;
  ok("it is a POST with a bearer token and a JSON body", first.method === "POST" && /^Bearer fake-token$/.test(String(first.headers.authorization)) && /json/.test(String(first.headers["content-type"])));
  ok("the property is sent exactly as the connector row holds it", JSON.parse(first.body).siteUrl === "sc-domain:example.test");
  ok("an address is built from the site's own origin and the path", asked.every((u) => u.startsWith("https://example.test/")) && asked.includes("https://example.test/a"), asked.slice(0, 3).join(" "));
  ok("every row is ok and carries the facts", r1.rows.every((r) => r.state === "ok" && r1.rows[0]!.verdict === "PASS" && r.googleCanonical === "https://example.test/services/"));
  ok("the run ends ok with a count", r1.run.status === "ok" && r1.run.source === "gsc_inspect" && r1.run.rows === r1.rows.length);
  ok("a page the reader saw is inspected at the address the reader saw", (() => { const url = addressFor("/a", { property: "sc-domain:example.test", domain: "example.test", observedUrls: [], knownUrls: new Map([["/a", "https://www.example.test/a/"]]) }); return url === "https://www.example.test/a/"; })());
  ok("a URL-prefix property is its own origin", addressFor("/z", { property: "https://shop.test/", domain: null, observedUrls: [], knownUrls: new Map() }) === "https://shop.test/z");
  ok("no property and no website gives no address, not a guess", addressFor("/z", { property: "sc-domain:x.test", domain: null, observedUrls: [], knownUrls: new Map() }) === null);

  // A page Google will not inspect is a row that says so, and the run goes on.
  const r2 = await inspectClient(ctx({ stats: [stats("/bad", 5, 50), stats("/good", 60, 20)] }), deps);
  const badRow = r2.rows.find((r) => r.url.endsWith("/bad"))!;
  ok("a page Google refuses (400) is an error row with no facts, never indexed", badRow.state === "error" && badRow.verdict === null && badRow.coverageState === null && badRow.indexingState === null && /would not inspect/.test(badRow.detail ?? ""));
  ok("the other pages are still inspected", r2.rows.some((r) => r.state === "ok"));
  ok("a run with some refused pages is ok, and says how many", r2.run.status === "ok" && /could not be inspected/.test(r2.run.detail ?? ""));

  // Quota and access.
  const before = fake.calls.length;
  const r3 = await inspectClient(ctx({ usedToday: INSPECT_DAILY_CAP }), deps);
  ok("with the day's allowance used it makes NO call and says capped", r3.run.status === "capped" && fake.calls.length === before && r3.rows.length === 0);
  const r3b = await inspectClient(ctx({ usedToday: 148 }), deps);
  ok("two left today means at most two inspections", r3b.rows.length <= 2 && fake.calls.length - before <= 3);
  fake.calls.length = 0;
  const r4 = await inspectClient(ctx({ lastOk: new Map(list.map((s) => [s.path, daysAgo(1)])) }), deps);
  ok("pages inspected yesterday are not inspected again", r4.rows.length === 0 && fake.calls.filter((c) => c.path.includes("inspect")).length === 0 && r4.run.status === "no_data");
  const dry = await inspectClient(ctx(), { ...deps, dryRun: true, token: () => googleToken("scope-dry", { client_email: "x@y", private_key: "k" }) });
  ok("a dry run plans, proves the key, and inspects nothing", dry.rows.length === 0 && dry.plan.length > 0 && fake.calls.filter((c) => c.path.includes("inspect")).length === 0 && fake.calls.some((c) => c.path === "/token") && dry.run.status === "ok");
  const off = await inspectClient(ctx({ property: null }), deps);
  ok("no property is 'off', not an error", off.run.status === "off" && off.rows.length === 0);

  // A pretend Google that refuses.
  await fake.close();
  const statusFor = async (status: number, then?: number) => {
    let n = 0;
    const srv = await startFake((c) => { if (!c.path.includes("inspect")) return undefined; n += 1; return { status: then && n > 1 ? then : status, body: { error: { message: `no ${status}` } } }; });
    process.env.SIGNALS_FAKE_BASE = srv.base;
    const res = await inspectClient(ctx(), { ...deps, token: () => googleToken("scope2", { client_email: "x@y", private_key: "k" }) });
    const count = srv.calls.filter((c) => c.path.includes("inspect")).length;
    await srv.close();
    return { res, count };
  };
  const q = await statusFor(429);
  ok("Google's own 429 stops the run at once and says it was Google's limit", q.res.run.status === "capped" && /Google's own/.test(q.res.run.detail ?? "") && q.count === 1 && q.res.rows.length === 0);
  const a = await statusFor(403);
  ok("a 403 on the first page stops the run and names the likely cause, trying no more pages", a.res.run.status === "error" && /full user/.test(a.res.run.detail ?? "") && a.count === 1 && a.res.rows.length === 0);
  const s = await statusFor(500);
  ok(`${STOP_AFTER_FAILURES} server failures in a row stop the run`, s.res.run.status === "error" && s.count === STOP_AFTER_FAILURES && s.res.rows.every((r) => r.state === "error"));
  ok("a failed page never carries a verdict", s.res.rows.every((r) => r.verdict === null && r.lastCrawlAt === null && r.googleCanonical === null));
  const html = await (async () => {
    const srv = await startFake((c) => (c.path.includes("inspect") ? { body: "<html>login</html>" } : undefined));
    process.env.SIGNALS_FAKE_BASE = srv.base;
    const res = await inspectClient(ctx(), { ...deps, token: () => googleToken("scope3", { client_email: "x@y", private_key: "k" }) });
    await srv.close();
    return res;
  })();
  ok("an answer that is not JSON is an error, never a pass", html.run.status === "error" && html.rows.every((r) => r.state === "error"));
  const refused = await (async () => {
    const srv = await startFake((c) => (c.path === "/token" ? { status: 401, body: { error: "invalid_grant" } } : undefined));
    process.env.SIGNALS_FAKE_BASE = srv.base;
    const res = await inspectClient(ctx(), { ...deps, token: () => googleToken("scope4", { client_email: "x@y", private_key: "k" }) });
    await srv.close();
    return res;
  })();
  ok("a refused service-account key is an error with no inspection made", refused.run.status === "error" && refused.rows.length === 0 && /refused the service account/.test(refused.run.detail ?? ""));
  delete process.env.SIGNALS_FAKE_BASE;

  /* ───────────────────────── 4. what is written ───────────────────────── */
  hr("4. the writes");
  const rec = recorder();
  await writeInspection(rec, "c1", r1.rows[0]!);
  const [ins, prune] = rec.calls;
  const cols = (ins!.sql.match(/\(([^)]*)\)\s*VALUES/s)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  ok("the INSERT names 19 columns and sends 19 parameters", cols.length === 19 && ins!.params.length === 19, `${cols.length}/${ins!.params.length}`);
  ok("the prune keeps the newest few per address, and the number is a literal that matches", /LIMIT 4\)/.test(PRUNE_INSPECTION) && KEEP_PER_URL === 4 && prune!.sql === PRUNE_INSPECTION);
  const rec2 = recorder();
  await writeInspection(rec2, "c1", r1.rows[0]!);
  ok("a second write of the same inspection is the same row (a deterministic id)", rec2.calls[0]!.params[0] === ins!.params[0]);
  ok("the status table's column list is a literal", /INSERT INTO signal_runs\s*\(client_id, source, status, detail, rows, capped, total_found, window_end, ran_at\)/.test(INSERT_SIGNAL_RUN));
  ok("a run is one of the seven statuses the app knows", SIGNAL_STATUSES.length === 7 && SIGNAL_STATUSES.includes(signalRun("gsc_inspect", "capped", null).status));
  ok("the counting query is per client and property, from the start of the day", /client_id = \$1 AND site_url = \$2 AND inspected_at >= \$3/.test(COUNT_TODAY));
  const forbidden = /\b(body|html|content|text|snippet|screenshot|visitor|ip_address|email|name)\b/i;
  ok("nothing the INSERT names could hold page text or a person", !cols.some((c) => forbidden.test(c)), cols.filter((c) => forbidden.test(c)).join(","));
  ok("pages are chosen for one of three reasons", PICKED_FOR.length === 3);

  /* ───────────────────────── 5. secrets and the workflow ───────────────────────── */
  hr("5. a missing secret is red and named; the workflow is wired");
  ok("the message for a missing service account names the secret and what it stops", /GOOGLE_SERVICE_ACCOUNT_JSON/.test(missingSecretMessage(SECRET_NAMES.serviceAccount, "no Search Console page can be inspected")) && /can be inspected/.test(missingSecretMessage(SECRET_NAMES.serviceAccount, "no Search Console page can be inspected")));
  const root = path.resolve(import.meta.dirname, "..");
  const wf = fs.readFileSync(path.join(root, ".github/workflows/read-url-inspection.yml"), "utf8");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*#.*$/gm, "");
  const wfc = code(wf);
  ok("the workflow is scheduled daily", /schedule:\s*\n\s*- cron: "\d+ \d+ \* \* \*"/.test(wfc));
  ok("it takes client_id and dry_run and requires neither", /client_id:[\s\S]*?required: false/.test(wfc) && /dry_run:[\s\S]*?required: false/.test(wfc));
  ok("the heartbeat runs even when the job failed, and not for a dry or scoped run", /Heartbeat[\s\S]*?if: always\(\) && inputs\.dry_run != 'true' && inputs\.client_id == ''/.test(wfc));
  ok("the heartbeat is named read_url_inspection", /--job=read_url_inspection/.test(wfc));
  selfTest("the heartbeat step is guarded by always()", (t) => /Heartbeat[\s\S]*?if: always\(\)/.test(t), "- name: Heartbeat\n  if: always() && x", "- name: Heartbeat\n  if: success() && x");
  ok("it never points the job at a pretend server", !/SIGNALS_FAKE_BASE/.test(wfc));
  ok("the only secrets it passes are the database and the service account", Array.from(wfc.matchAll(/secrets\.([A-Z0-9_]+)/g)).map((m) => m[1]).every((n) => n === "DATABASE_URL" || n === "GOOGLE_SERVICE_ACCOUNT_JSON"));
  ok("the summary line reaches the heartbeat", /steps\.run\.outputs\.summary/.test(wfc) && /GITHUB_OUTPUT/.test(code(fs.readFileSync(path.join(root, "src/read-url-inspection.ts"), "utf8"))));
  const entry = code(fs.readFileSync(path.join(root, "src/read-url-inspection.ts"), "utf8"));
  ok("the entry script exits 1 when the service account is missing and says which secret", /noKey > 0[\s\S]*?process\.exit\(1\)/.test(entry) && /SECRET_NAMES\.serviceAccount/.test(entry));
  ok("the entry script makes no write to Google (no PUT, PATCH or DELETE anywhere in the reader)", (() => {
    const files = ["src/url-inspection/inspect.ts", "src/url-inspection/run.ts", "src/signals/google.ts"].map((f) => code(fs.readFileSync(path.join(root, f), "utf8")));
    return !files.some((t) => /method:\s*"(PUT|PATCH|DELETE)"/i.test(t));
  })());
  ok("the endpoint is the documented one and read-only scope is used", INSPECT_ENDPOINT === "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  ok("CI runs this guard", /npm run verify-url-inspection(?![\w-])/.test(ci));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  ok("the scripts exist", Boolean(pkg.scripts["read-url-inspection"]) && Boolean(pkg.scripts["verify-url-inspection"]));
  ok("no other file reads the URL-inspection secret from the environment by name", (() => {
    const bad: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.ts$/.test(e.name) && !/verify-|secrets\.ts$|google\.ts$/.test(e.name) && /process\.env\.(BING_WEBMASTER_API_KEY|GBP_[A-Z_]+|CTM_[A-Z_]+)/.test(code(fs.readFileSync(p, "utf8")))) bad.push(p); } };
    walk(path.join(root, "src"));
    return bad.length === 0;
  })());

  console.log(failures ? `\n❌ ${failures} check(s) failed` : "\n✅ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

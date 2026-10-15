#!/usr/bin/env tsx
/**
 * Guard for the Business Profile reader: what it asks Google, what it keeps, and what
 * it refuses to turn into a nought.
 *
 * No Google, no database, no token. A pretend Google (a real HTTP server on a local
 * port) answers the real request builders, the real parsers and the real orchestration
 * through the real fetch, and a recording client stands in for Postgres so the real
 * INSERTs are read as text and as parameters.
 *
 * EVERY CLIENT, LOCATION, COUNT, TERM AND TOKEN BELOW IS INVENTED.
 *
 * WHAT THIS CANNOT PROVE. No Business Profile API access has been approved yet, so
 * nothing here has run against Google. The request addresses, the response field names
 * and the daily metric names are written from the API reference as I know it; a green
 * run means the code does what it says against the shapes it expects, not that Google
 * answers in them. docs/INTEGRATIONS-SETUP.md (dashboard repository) lists each as
 * unverified.
 *
 *   npx tsx src/verify-gbp.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { startFake, type Call } from "./signals/fake-http.js";
import { realFetch } from "./page-behaviour/http.js";
import { dailyUrl, exchangeRefreshToken, keywordsUrl, parseDaily, parseKeywords, TokenRefused } from "./gbp/api.js";
import { keywordMonths, locationIdOf, readGbpClient, type GbpCtx, type GbpDeps } from "./gbp/run.js";
import { PRUNE_DAILY, PRUNE_KEYWORDS, UPSERT_DAILY, UPSERT_KEYWORD, writeDaily, writeKeywords } from "./gbp/store.js";
import { GBP_DAILY_METRICS, GBP_KEYWORDS_PER_MONTH, GBP_KEYWORD_MAX_PAGES, GBP_KEYWORD_MONTHS, GBP_METRIC_KEYS, GBP_WINDOW_DAYS } from "./gbp/types.js";
import { SECRET_NAMES, gbpOAuthClient, gbpRefreshTokens } from "./signals/secrets.js";

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

const d = (y: number, m: number, day: number) => ({ year: y, month: m, day });
const DAILY = {
  multiDailyMetricTimeSeries: [{
    dailyMetricTimeSeries: [
      { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ date: d(2026, 10, 1), value: "4" }, { date: d(2026, 10, 2), value: "6" }, { date: d(2026, 10, 3) }] } },
      { dailyMetric: "WEBSITE_CLICKS", timeSeries: { datedValues: [{ date: d(2026, 10, 1), value: "12" }] } },
      { dailyMetric: "BUSINESS_DIRECTION_REQUESTS", timeSeries: { datedValues: [{ date: d(2026, 10, 1), value: "3" }] } },
      { dailyMetric: "SOMETHING_NEW_FROM_GOOGLE", timeSeries: { datedValues: [{ date: d(2026, 10, 1), value: "99" }] } },
    ],
  }],
};
const TERMS = (extra: unknown[] = [], next?: string) => ({
  searchKeywordsCounts: [
    { searchKeyword: "  Roof   Repair Near Me ", insightsValue: { value: "120" } },
    { searchKeyword: "emergency roofer", insightsValue: { threshold: "15" } },
    { searchKeyword: "call 5135550123", insightsValue: { value: "40" } },
    { searchKeyword: "jane@example.test roofer", insightsValue: { value: "40" } },
    { searchKeyword: "no count", insightsValue: {} },
    ...extra,
  ],
  ...(next ? { nextPageToken: next } : {}),
});

type Rec = { sql: string; params: unknown[] };
const recorder = () => { const calls: Rec[] = []; return { calls, query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params: params ?? [] }); return {}; } }; };

const CLIENT = { clientId: "client-id.example", clientSecret: "client-secret-value" };
const REFRESH = "refresh-token-value-123";
const NOW = new Date("2026-10-15T10:20:00Z");

async function main() {
  /* ───────────────────────── 1. the parsers ───────────────────────── */
  hr("1. an answer becomes counts, and a gap is never a nought");
  const p = parseDaily(DAILY);
  ok("each listed day with a value is a row, under our short key", p.rows.length === 4 && p.rows.some((r) => r.metric === "calls" && r.day === "2026-10-02" && r.value === 6) && p.rows.some((r) => r.metric === "website_clicks" && r.value === 12) && p.rows.some((r) => r.metric === "directions"));
  ok("a listed day with NO value is no row (unanswered), not a nought", !p.rows.some((r) => r.metric === "calls" && r.day === "2026-10-03") && p.skipped >= 1);
  ok("a metric Google sent that we have no name for is named and not stored", p.unknownMetrics.join() === "SOMETHING_NEW_FROM_GOOGLE" && !p.rows.some((r) => r.value === 99));
  for (const [label, body] of [["an empty object", {}], ["a string", "ok"], ["null", null], ["an array", []], ["no series key", { somethingElse: 1 }]] as const) {
    let threw = false;
    try { parseDaily(body); } catch { threw = true; }
    ok(`${label} is refused, not read as 'zero everywhere'`, threw);
  }
  const odd = parseDaily({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [
    { date: d(2026, 10, 4), value: "-3" }, { date: d(2026, 10, 5), value: "2.5" }, { date: d(2026, 13, 5), value: "1" }, { date: d(1999, 1, 5), value: "1" }, { date: d(2026, 10, 6), value: "abc" }, { date: d(2026, 10, 7), value: 7 },
  ] } }] }] });
  ok("a negative, fractional, impossible-date or non-numeric value is skipped; a plain number is kept", odd.rows.length === 1 && odd.rows[0]!.value === 7 && odd.skipped === 5, JSON.stringify(odd.rows));
  ok("an empty series is valid (a place with no activity), and returns no rows", parseDaily({ multiDailyMetricTimeSeries: [] }).rows.length === 0);
  const k = parseKeywords(TERMS([], "tok2"), "2026-09");
  ok("a term is lower-cased, trimmed and its spaces collapsed", k.rows.some((r) => r.keyword === "roof repair near me" && r.impressions === 120 && r.bound === "exact"));
  ok("a threshold is kept as a floor ('fewer than'), not as an exact count", k.rows.some((r) => r.keyword === "emergency roofer" && r.impressions === 15 && r.bound === "below"));
  ok("a term that looks like a phone number or an address is not kept", !k.rows.some((r) => /5135550123|@/.test(r.keyword)));
  ok("a term with no count at all is skipped", !k.rows.some((r) => r.keyword === "no count") && k.skipped === 3);
  ok("the next page token is carried", k.next === "tok2" && parseKeywords(TERMS(), "2026-09").next === null);
  let threwK = false; try { parseKeywords("nope", "2026-09"); } catch { threwK = true; }
  ok("an answer that is not an object is refused", threwK);
  ok("a location id is the digits, whether typed as locations/N or N", locationIdOf("locations/1234567890") === "1234567890" && locationIdOf(" 1234567890 ") === "1234567890" && locationIdOf("Hillside Roofing") === null && locationIdOf("123") === null && locationIdOf("12345678901234567890123456789") === null && locationIdOf(null) === null);
  ok("the request names every metric we store, once, and the whole window", (() => {
    const u = new URL(dailyUrl("1234567890", "2026-08-01", "2026-10-14"));
    return u.searchParams.getAll("dailyMetrics").length === Object.keys(GBP_DAILY_METRICS).length && u.searchParams.get("dailyRange.startDate.month") === "8" && u.searchParams.get("dailyRange.endDate.day") === "14" && u.pathname.endsWith("/locations/1234567890:fetchMultiDailyMetricsTimeSeries");
  })());
  ok("a month of search terms is asked for one month at a time", (() => {
    const u = new URL(keywordsUrl("1234567890", "2026-09", null));
    return u.searchParams.get("monthlyRange.startMonth.month") === "9" && u.searchParams.get("monthlyRange.endMonth.month") === "9" && u.searchParams.get("monthlyRange.endMonth.year") === "2026" && !u.searchParams.has("pageToken");
  })());
  ok("the stored metric keys are the values of the declared map", GBP_METRIC_KEYS.length === 9 && new Set(GBP_METRIC_KEYS).size === 9);

  hr("2. which months of search terms");
  const none = keywordMonths(NOW, new Set());
  ok("with none stored it reads the last complete months, newest first", none.length === GBP_KEYWORD_MONTHS && none[0] === "2026-09" && none.at(-1) === "2026-04", none.join());
  const some = keywordMonths(NOW, new Set(["2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04"]));
  ok("the newest complete month is always re-read, older stored months are not", some.join() === "2026-09");
  ok("a January run reads December of last year", keywordMonths(new Date("2027-01-10T00:00:00Z"), new Set(["2026-12"]))[0] === "2026-12");

  /* ───────────────────────── 3. the token ───────────────────────── */
  hr("3. the authorisation");
  let tokenForm = "";
  const fake = await startFake((c: Call) => {
    if (c.path === "/oauth/token") {
      tokenForm = c.body;
      const form = new URLSearchParams(c.body);
      if (form.get("refresh_token") === "revoked") return { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
      if (form.get("refresh_token") === "badclient") return { status: 401, body: { error: "invalid_client" } };
      if (form.get("refresh_token") === "boom") return { status: 500, body: `server said refresh-token-value-123 and client-secret-value` };
      return { body: { access_token: "gbp-access-token", expires_in: 3600 } };
    }
    return undefined;
  });
  process.env.SIGNALS_FAKE_BASE = fake.base;
  const tok = await exchangeRefreshToken(realFetch, CLIENT, REFRESH);
  ok("a refresh token becomes an access token", tok === "gbp-access-token");
  const form = new URLSearchParams(tokenForm);
  ok("the request is a form with the grant type, client and refresh token", form.get("grant_type") === "refresh_token" && form.get("client_id") === CLIENT.clientId && form.get("client_secret") === CLIENT.clientSecret && form.get("refresh_token") === REFRESH);
  const tokCall = fake.calls.find((c) => c.path === "/oauth/token")!;
  ok("it is a POST with a form content type", tokCall.method === "POST" && /x-www-form-urlencoded/.test(String(tokCall.headers["content-type"])));
  for (const [rt, label] of [["revoked", "a revoked grant"], ["badclient", "a refused OAuth client"]] as const) {
    let refused = false; try { await exchangeRefreshToken(realFetch, CLIENT, rt); } catch (e) { refused = e instanceof TokenRefused; }
    ok(`${label} is a TokenRefused, so the status can say 'authorise again'`, refused);
  }
  let plain = ""; try { await exchangeRefreshToken(realFetch, CLIENT, "boom"); } catch (e) { plain = String((e as Error).message); }
  ok("a server error is not a TokenRefused", plain.length > 0 && !plain.includes("authorisation"));
  await fake.close();

  /* ───────────────────────── 4. the run, through a pretend Google ───────────────────────── */
  hr("4. the run");
  const asked: Call[] = [];
  let mode = "ok";
  const g = await startFake((c: Call) => {
    if (c.path === "/oauth/token") {
      const f = new URLSearchParams(c.body);
      if (f.get("refresh_token") === "revoked") return { status: 400, body: { error: "invalid_grant" } };
      return { body: { access_token: "gbp-access-token" } };
    }
    asked.push(c);
    if (c.path.includes(":fetchMultiDailyMetricsTimeSeries")) {
      if (mode === "403") return { status: 403, body: { error: { message: "The caller does not have permission", status: "PERMISSION_DENIED" } } };
      if (mode === "429") return { status: 429, body: { error: { message: "Quota exceeded for quota metric ... limit 0", status: "RESOURCE_EXHAUSTED" } } };
      if (mode === "404") return { status: 404, body: { error: { message: "not found" } } };
      if (mode === "html") return { body: "<html>nope</html>" };
      if (mode === "empty") return { body: { multiDailyMetricTimeSeries: [] } };
      if (mode === "leak") return { status: 500, body: `oops refresh-token-value-123 client-secret-value` };
      return { body: DAILY };
    }
    if (c.path.includes("/searchkeywords/impressions/monthly")) {
      if (mode === "terms500") return { status: 500, body: { error: { message: "backend error" } } };
      const u = new URL(`http://x${c.path}`);
      const month = `${u.searchParams.get("monthlyRange.startMonth.year")}-${String(u.searchParams.get("monthlyRange.startMonth.month")).padStart(2, "0")}`;
      if (mode === "manyterms") {
        const extra = Array.from({ length: 200 }, (_, i) => ({ searchKeyword: `term ${month} ${i}`, insightsValue: { value: String(200 - i) } }));
        return { body: { searchKeywordsCounts: extra, nextPageToken: u.searchParams.get("pageToken") ? undefined : "more" } };
      }
      return { body: TERMS() };
    }
    return undefined;
  });
  process.env.SIGNALS_FAKE_BASE = g.base;
  const ctx = (over: Partial<GbpCtx> = {}): GbpCtx => ({ name: "Hillside Roofing", slug: "hillside-roofing", location: "locations/1234567890", storedMonths: new Set(), ...over });
  const deps = (over: Partial<GbpDeps> = {}): GbpDeps => ({ fetch: realFetch, oauthClient: CLIENT, refreshTokens: new Map([["hillside-roofing", REFRESH]]), now: NOW, pauseMs: 0, secrets: [REFRESH, CLIENT.clientSecret], ...over });

  const off = await readGbpClient(ctx({ location: null }), deps());
  ok("no location recorded is 'off', makes no call and costs nothing", off.run.status === "off" && asked.length === 0 && off.daily.length === 0);
  const bad = await readGbpClient(ctx({ location: "Hillside Roofing, 12 Main St" }), deps());
  ok("a name or an address where an id belongs is an error that says what an id is, and makes no call", bad.run.status === "error" && /location id/.test(bad.run.detail ?? "") && asked.length === 0);
  const noClient = await readGbpClient(ctx(), deps({ oauthClient: null }));
  ok("no OAuth client secret is no_key and names GBP_OAUTH_CLIENT_JSON", noClient.run.status === "no_key" && (noClient.run.detail ?? "").includes(SECRET_NAMES.gbpClient) && asked.length === 0);
  const noTok = await readGbpClient(ctx(), deps({ refreshTokens: new Map() }));
  ok("no entry for the client is no_token and names GBP_TOKENS_JSON and the client", noTok.run.status === "no_token" && (noTok.run.detail ?? "").includes(SECRET_NAMES.gbpTokens) && (noTok.run.detail ?? "").includes("hillside-roofing") && asked.length === 0);
  const rev = await readGbpClient(ctx(), deps({ refreshTokens: new Map([["hillside-roofing", "revoked"]]) }));
  ok("a revoked authorisation is no_token, says to authorise again, names the secret and reads nothing", rev.run.status === "no_token" && /again/.test(rev.run.detail ?? "") && (rev.run.detail ?? "").includes(SECRET_NAMES.gbpTokens) && asked.length === 0);

  const dry = await readGbpClient(ctx(), deps({ dryRun: true }));
  ok("a dry run proves the authorisation and reads no count", dry.run.status === "ok" && /Dry run/.test(dry.run.detail ?? "") && asked.length === 0 && dry.daily.length === 0);

  const r = await readGbpClient(ctx(), deps());
  ok("the daily counts are asked for with a bearer token on a GET", asked.filter((c) => c.path.includes(":fetchMultiDailyMetricsTimeSeries")).length === 1 && asked[0]!.method === "GET" && asked[0]!.headers.authorization === "Bearer gbp-access-token");
  ok("the window ends yesterday and is the declared number of days", (() => {
    const u = new URL(`http://x${asked[0]!.path}`);
    const end = `${u.searchParams.get("dailyRange.endDate.year")}-${String(u.searchParams.get("dailyRange.endDate.month")).padStart(2, "0")}-${String(u.searchParams.get("dailyRange.endDate.day")).padStart(2, "0")}`;
    const start = `${u.searchParams.get("dailyRange.startDate.year")}-${String(u.searchParams.get("dailyRange.startDate.month")).padStart(2, "0")}-${String(u.searchParams.get("dailyRange.startDate.day")).padStart(2, "0")}`;
    return end === "2026-10-14" && (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000 === GBP_WINDOW_DAYS - 1;
  })());
  ok("the location id in the address is the digits only", asked[0]!.path.includes("/locations/1234567890:fetch") && !asked[0]!.path.includes("locations/locations"));
  ok("every month of search terms was asked for, one month each", asked.filter((c) => c.path.includes("/searchkeywords/")).length === GBP_KEYWORD_MONTHS);
  ok("the daily rows and the terms came back mapped", r.daily.length === 4 && r.keywords.length === GBP_KEYWORD_MONTHS * 2 && r.keywords.every((x) => x.keyword !== "no count"));
  ok("the run is ok, counts its rows, and names the newest day it holds", r.run.status === "ok" && r.run.rows === 4 && r.run.windowEnd === "2026-10-02");
  ok("a metric Google sent that we do not know is reported in the run, not hidden", /no name for/.test(r.run.detail ?? ""));
  ok("only a GET and the one token POST were ever sent", g.calls.every((c) => c.method === "GET" || (c.method === "POST" && c.path === "/oauth/token")));

  for (const [m, status, text] of [["403", "error", /approved by Google/], ["404", "error", /does not know this location/], ["429", "capped", /limit of zero until/], ["html", "error", null], ["leak", "error", null]] as const) {
    mode = m; asked.length = 0;
    const x = await readGbpClient(ctx(), deps());
    ok(`a ${m} answer is ${status}${text ? " and says what to check" : ""}, never an empty success`, x.run.status === status && (text ? text.test(x.run.detail ?? "") : true) && x.daily.length === 0);
    if (m === "leak") ok("an error body that echoes a token or a secret is scrubbed before it is stored", !/refresh-token-value-123|client-secret-value/.test(x.run.detail ?? ""), x.run.detail ?? "");
  }
  mode = "empty";
  const empty = await readGbpClient(ctx(), deps());
  ok("an answer with no series is no_data, not a success with zero", empty.run.status === "no_data" && empty.daily.length === 0 && /no counts/.test(empty.run.detail ?? ""));
  mode = "terms500";
  const noTerms = await readGbpClient(ctx(), deps());
  ok("search terms failing costs the terms only: the counts are kept and the status says so", noTerms.daily.length === 4 && noTerms.keywords.length === 0 && noTerms.run.status === "capped" && /Search terms could not be read/.test(noTerms.run.detail ?? ""));
  mode = "manyterms"; asked.length = 0;
  const many = await readGbpClient(ctx({ storedMonths: new Set(["2026-08", "2026-07", "2026-06", "2026-05", "2026-04"]) }), deps());
  ok("a month with more terms than we keep is cut to the cap, and the run says it was", many.keywords.length === GBP_KEYWORDS_PER_MONTH && many.run.capped === true && /most-searched/.test(many.run.detail ?? ""));
  ok("paging is bounded", asked.filter((c) => c.path.includes("/searchkeywords/")).length <= GBP_KEYWORD_MAX_PAGES);
  ok("the terms kept are the most-searched ones", many.keywords[0]!.impressions === 200);
  mode = "ok";
  await g.close();
  delete process.env.SIGNALS_FAKE_BASE;

  /* ───────────────────────── 5. what is written ───────────────────────── */
  hr("5. the writes");
  const rec = recorder();
  await writeDaily(rec, "c1", "1234567890", [{ day: "2026-10-01", metric: "calls", value: 4 }], NOW);
  await writeKeywords(rec, "c1", "1234567890", [{ month: "2026-09", keyword: "roof repair", impressions: 12, bound: "exact" }], NOW);
  const colsOf = (sql: string) => (sql.match(/\(([^)]*)\)\s*VALUES/s)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  ok("the daily INSERT names 7 columns and sends 7 parameters", colsOf(UPSERT_DAILY).length === 7 && rec.calls[0]!.params.length === 7);
  ok("the keyword INSERT names 8 columns and sends 8 parameters", colsOf(UPSERT_KEYWORD).length === 8 && rec.calls[1]!.params.length === 8);
  ok("both are upserts on their natural key, so a re-read overwrites and never doubles", /ON CONFLICT \(client_id, location_id, day, metric\)/.test(UPSERT_DAILY) && /ON CONFLICT \(client_id, location_id, month, keyword\)/.test(UPSERT_KEYWORD));
  const rec2 = recorder();
  await writeDaily(rec2, "c1", "1234567890", [{ day: "2026-10-01", metric: "calls", value: 4 }], NOW);
  ok("the same count written twice has the same id", rec2.calls[0]!.params[0] === rec.calls[0]!.params[0]);
  const forbidden = /(review|rating|comment|author|photo|name|email|phone|text|body|address)/i;
  const allCols = [...colsOf(UPSERT_DAILY), ...colsOf(UPSERT_KEYWORD)];
  ok("no column could hold a review, a reviewer, a photo or a person", !allCols.some((c) => forbidden.test(c)), allCols.filter((c) => forbidden.test(c)).join(","));
  selfTest("the forbidden-column scan can fail", (t) => !forbidden.test(t), "impressions_bound", "reviewer_name");
  ok("housekeeping deletes only this client's old rows", /WHERE client_id = \$1 AND day < \$2/.test(PRUNE_DAILY) && /WHERE client_id = \$1 AND month < \$2/.test(PRUNE_KEYWORDS));

  /* ───────────────────────── 6. secrets, the entry, the workflow ───────────────────────── */
  hr("6. a missing secret is red and named; the workflow is wired");
  ok("the OAuth client secret reads {clientId, clientSecret}", gbpOAuthClient({ GBP_OAUTH_CLIENT_JSON: JSON.stringify(CLIENT) })?.clientId === "client-id.example");
  let threw = false; try { gbpOAuthClient({ GBP_OAUTH_CLIENT_JSON: JSON.stringify({ clientId: "x" }) }); } catch { threw = true; }
  ok("an OAuth client secret missing a half is refused, not half-used", threw);
  ok("the tokens secret reads {slug: {refreshToken}} keyed by lower-case slug", gbpRefreshTokens({ GBP_TOKENS_JSON: JSON.stringify({ "Hillside-Roofing": { refreshToken: "t" }, empty: { refreshToken: " " } }) }).get("hillside-roofing") === "t" && gbpRefreshTokens({ GBP_TOKENS_JSON: JSON.stringify({ empty: { refreshToken: " " } }) }).size === 0);
  const root = path.resolve(import.meta.dirname, "..");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*#.*$/gm, "");
  const wfc = code(fs.readFileSync(path.join(root, ".github/workflows/read-gbp.yml"), "utf8"));
  ok("the workflow is scheduled daily", /schedule:\s*\n\s*- cron: "\d+ \d+ \* \* \*"/.test(wfc));
  ok("it takes client_id and dry_run and requires neither", /client_id:[\s\S]*?required: false/.test(wfc) && /dry_run:[\s\S]*?required: false/.test(wfc));
  ok("the heartbeat runs even when the job failed, and not for a dry or scoped run", /Heartbeat[\s\S]*?if: always\(\) && inputs\.dry_run != 'true' && inputs\.client_id == ''/.test(wfc));
  ok("the heartbeat is named read_gbp", /--job=read_gbp(?![\w])/.test(wfc));
  selfTest("the heartbeat step is guarded by always()", (t) => /Heartbeat[\s\S]*?if: always\(\)/.test(t), "- name: Heartbeat\n  if: always() && x", "- name: Heartbeat\n  if: success() && x");
  ok("it never points the job at a pretend server", !/SIGNALS_FAKE_BASE/.test(wfc));
  ok("the only secrets it passes are the database and the two Business Profile ones", Array.from(wfc.matchAll(/secrets\.([A-Z0-9_]+)/g)).map((m) => m[1]).every((n) => n === "DATABASE_URL" || n === "GBP_OAUTH_CLIENT_JSON" || n === "GBP_TOKENS_JSON") && /secrets\.GBP_TOKENS_JSON/.test(wfc) && /secrets\.GBP_OAUTH_CLIENT_JSON/.test(wfc));
  const entry = code(fs.readFileSync(path.join(root, "src/read-gbp.ts"), "utf8"));
  ok("the summary line reaches the heartbeat", /steps\.run\.outputs\.summary/.test(wfc) && /GITHUB_OUTPUT/.test(entry));
  ok("the entry script exits 1 when a key or token is missing and names both secrets", /missing > 0[\s\S]*?process\.exit\(1\)/.test(entry) && /SECRET_NAMES\.gbpClient/.test(entry) && /SECRET_NAMES\.gbpTokens/.test(entry));
  ok("a client with no location is written 'off' and never needs a secret", /status === "off"/.test(entry));
  const apiFiles = ["src/gbp/api.ts", "src/gbp/run.ts", "src/gbp/store.ts", "src/gbp/types.ts", "src/read-gbp.ts"].map((f) => code(fs.readFileSync(path.join(root, f), "utf8")));
  ok("no write method toward Google: the only POST is the token exchange", !apiFiles.some((t) => /method:\s*"(PUT|PATCH|DELETE)"/i.test(t)) && (apiFiles[0]!.match(/method: "POST"/g) ?? []).length === 1);
  ok("no review, reviewer, place or account-management API is touched", !apiFiles.some((t) => /mybusiness\.googleapis\.com|mybusinessaccountmanagement|mybusinessbusinessinformation|\/reviews\b|reviewer/i.test(t)));
  selfTest("the review-API scan can fail", (t) => !/\/reviews\b|reviewer/i.test(t), "searchkeywords/impressions", "https://x/v4/accounts/1/locations/2/reviews");
  ok("the endpoints are the documented hosts", apiFiles[3]!.includes('"https://businessprofileperformance.googleapis.com/v1"') && apiFiles[3]!.includes('"https://oauth2.googleapis.com/token"') && apiFiles[3]!.includes("business.manage"));
  ok("the daily metric names are the documented enum values", ["CALL_CLICKS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS", "BUSINESS_CONVERSATIONS", "BUSINESS_BOOKINGS"].every((m) => m in GBP_DAILY_METRICS));
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  ok("CI runs this guard", /npm run verify-gbp(?![\w-])/.test(ci));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  ok("the scripts exist", Boolean(pkg.scripts["read-gbp"]) && Boolean(pkg.scripts["verify-gbp"]));
  ok("no other file reads a Business Profile secret from the environment by name", (() => {
    const bad: string[] = [];
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.ts$/.test(e.name) && !/verify-|secrets\.ts$/.test(e.name) && /process\.env\.(GBP_[A-Z_]+)/.test(code(fs.readFileSync(f, "utf8")))) bad.push(f); } };
    walk(path.join(root, "src"));
    return bad.length === 0;
  })());

  console.log(failures ? `\n❌ ${failures} check(s) failed` : "\n✅ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

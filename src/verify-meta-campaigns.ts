#!/usr/bin/env tsx
/**
 * Meta campaigns, ad sets and ads by day.
 *
 * Proves, over INVENTED rows (no Meta account, no network, no token):
 *
 *   1. it only READS: GET only, no write to Meta, nothing under the account that changes anything
 *   2. the units: spend is micros, clicks are LINK clicks (with a named fallback), Meta's own ctr is not stored,
 *      a lead is counted once, a null is unanswered, reach and frequency are per day and never summed
 *   3. the request: level, one row a day, the window, the fields, the limit, and a token only in the url
 *   4. paging, an error message that carries no token, and the row ceiling that writes nothing
 *   5. the window: ends yesterday, first read wide, later reads re-read
 *   6. the job: skips churned and internal clients, fails loudly with no token, dry run reads and writes nothing
 *   7. the workflow
 *   8. the real store, on a throwaway schema (when ADS_VERIFY_DATABASE_URL is set)
 *
 *   npm run verify-meta-campaigns
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  BACKFILL_DAYS, MAX_META_ROWS, META_DAY_FIELDS, META_LEVELS, PAGE_LIMIT, RESTATE_DAYS,
  buildMetaDayRows, ensureMetaDayTables, insightsUrl, loadMetaCoverage, readLevel, readWindow,
  recordMetaFailure, storeMetaDays, type FetchJson, type MetaDayRow,
} from "./meta/campaign-days.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const planted = (label: string, predicate: () => boolean) => {
  const caught = !predicate();
  console.log(`  ${caught ? "🧪" : "❌"} planted failure: ${label}${caught ? " — caught" : " — NOT CAUGHT"}`);
  if (!caught) failures++;
};
const section = (s: string) => console.log(`\n${s}`);
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");
const codeOnly = (src: string) => src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

console.log("Meta campaign days: the rules a daily row is read by");
console.log("No network, no token, no account. Every figure is invented.\n");

// An invented campaign-level day, in the shape the Graph API answers `level=campaign&time_increment=1` with.
const day = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  campaign_id: "c1", campaign_name: "Spring leads", date_start: "2026-11-02", date_stop: "2026-11-02",
  spend: "12.50", impressions: "4200", reach: "3100", frequency: "1.35", clicks: "140", inline_link_clicks: "96",
  actions: [
    { action_type: "lead", value: "3" }, { action_type: "offsite_conversion.fb_pixel_lead", value: "3" },
    { action_type: "post_engagement", value: "40" },
  ],
  ...over,
});

// ── 1. It only reads ─────────────────────────────────────────────────────────
section("1. It only reads");
const files = ["meta/campaign-days.ts", "import-meta-campaigns.ts"];
for (const f of files) {
  const code = codeOnly(read(f));
  ok(`${f} makes no write to Meta (no POST, no DELETE, no method override)`, !/method:\s*["'](POST|DELETE|PUT|PATCH)/i.test(code) && !/\.post\(|\.delete\(/i.test(code));
  ok(`${f} touches no other repository table than its own two`, !/(INSERT INTO|UPDATE|DELETE FROM)\s+(?!meta_insight_days|meta_insight_scans)[a-z_]+/i.test(code.replace(/ON CONFLICT[\s\S]*?(?=`)/g, "")));
}
planted("a POST to the platform is seen", () => !/method:\s*["']POST/i.test('await fetch(url, { method: "POST" })'));

// ── 2. The units ─────────────────────────────────────────────────────────────
section("2. Units and null versus zero");
const one = buildMetaDayRows("campaign", [day()]).rows[0]!;
ok("spend is micros: 12.50 → 12,500,000", one.spendMicros === 12_500_000, String(one.spendMicros));
ok("clicks are link clicks (96), not clicks (all) (140)", one.linkClicks === 96 && !one.usedAllClicks);
const fallback = buildMetaDayRows("campaign", [day({ inline_link_clicks: undefined })]).rows[0]!;
ok("Clicks (All) stands in only when the link figure is absent, and the row says so", fallback.linkClicks === 140 && fallback.usedAllClicks);
ok("one lead is counted once through its family (3, not 6)", one.leads === 3, String(one.leads));
ok("reach and frequency are stored for the day as Meta gave them", one.reach === 3100 && one.frequency === 1.35);
ok("Meta's own ctr is never a stored figure (no field, no column)", !("ctr" in one) && !/ctr/i.test(codeOnly(read("meta/campaign-days.ts")).match(/INSERT INTO meta_insight_days[\s\S]*?VALUES/)?.[0] ?? "ctr"));
planted("a ctr column added to the stored row", () => !/ctr/i.test("INSERT INTO meta_insight_days (id, ctr) VALUES"));
planted("spend stored as a decimal instead of micros", () => buildMetaDayRows("campaign", [day()]).rows[0]!.spendMicros === 12.5);
planted("Clicks (All) stored as the click count", () => one.linkClicks === 140);
planted("a lead summed across its three reporting names", () => one.leads === 6);

// A null is unanswered: no lead action anywhere in the pull is null, never 0.
const noLeads = buildMetaDayRows("campaign", [day({ actions: [{ action_type: "post_engagement", value: "9" }] }), day({ date_start: "2026-11-03", actions: undefined })]).rows;
ok("an account that reported no lead anywhere stores leads as NULL", noLeads.every((r) => r.leads === null));
const mixed = buildMetaDayRows("campaign", [day(), day({ date_start: "2026-11-03", actions: [] })]).rows;
ok("a zero is planted only where the account reported a lead somewhere in the pull", mixed[0]!.leads === 3 && mixed[1]!.leads === 0);
planted("a missing figure stored as a nought", () => noLeads.every((r) => r.leads === 0));
const noSpend = buildMetaDayRows("campaign", [day({ spend: undefined, impressions: undefined })]).rows[0]!;
ok("a figure Meta did not return is null", noSpend.spendMicros === null && noSpend.impressions === null);

// Reach is per day and never added.
ok("the module never adds reach or frequency across days", !/reach\s*\+|\+\s*r\.reach|sum\([^)]*reach|reduce\([^)]*reach/i.test(codeOnly(read("meta/campaign-days.ts"))));
planted("reach summed across days is seen", () => !/reach\s*\+|\+\s*r\.reach|sum\([^)]*reach|reduce\([^)]*reach/i.test("const total = rows.reduce((n, r) => n + r.reach, 0) // reach reduce"));
const twice = buildMetaDayRows("campaign", [day({ reach: "100" }), day({ reach: "250" })]);
ok("a repeated entity-day is counted and the last one kept, never summed", twice.repeats === 1 && twice.rows.length === 1 && twice.rows[0]!.reach === 250);

// Rows with no id or date are refused, not guessed.
const bad = buildMetaDayRows("ad", [day({ ad_id: "a1", adset_id: "s1" }), day({ ad_id: "", adset_id: "s1" }), day({ ad_id: "a2", date_start: "yesterday" })]);
ok("a row with no id or no real date is counted and not stored", bad.unplaced === 2 && bad.rows.length === 1);
const adRow = buildMetaDayRows("ad", [day({ ad_id: "a1", ad_name: "Hero", adset_id: "s1" })]).rows[0]!;
ok("an ad row carries its ad set and campaign", adRow.entityId === "a1" && adRow.adsetId === "s1" && adRow.campaignId === "c1");
const campRow = buildMetaDayRows("campaign", [day({ adset_id: "s9" })]).rows[0]!;
ok("a campaign row carries no ad set", campRow.adsetId === null);

// ── 3. The request ───────────────────────────────────────────────────────────
section("3. The request");
const u = new URL(insightsUrl("act_1", "adset", { start: "2026-10-01", end: "2026-10-31" }, "TOKEN-123"));
ok("one row a day, at the level asked for", u.searchParams.get("time_increment") === "1" && u.searchParams.get("level") === "adset");
ok("the window is the since/until pair", u.searchParams.get("time_range") === JSON.stringify({ since: "2026-10-01", until: "2026-10-31" }));
ok("each level asks for its own ids", META_DAY_FIELDS.campaign.includes("campaign_id") && !META_DAY_FIELDS.campaign.includes("adset_id") && META_DAY_FIELDS.adset.includes("adset_id") && !META_DAY_FIELDS.adset.includes("ad_id") && META_DAY_FIELDS.ad.includes("ad_id"));
ok("the page size is the declared one", u.searchParams.get("limit") === String(PAGE_LIMIT));
ok("the three levels are exactly campaign, adset, ad", JSON.stringify([...META_LEVELS]) === JSON.stringify(["campaign", "adset", "ad"]));

// ── 4. Paging, errors, ceiling ───────────────────────────────────────────────
section("4. Paging, errors and the ceiling");
const paged: FetchJson = async (url) => {
  const after = new URL(url).searchParams.get("after");
  if (!after) return { ok: true, status: 200, body: { data: [day({ campaign_id: "c1" })], paging: { next: `${url}&after=2` } } };
  return { ok: true, status: 200, body: { data: [day({ campaign_id: "c2" })] } };
};
const pagedRead = await readLevel(paged, "act_1", "campaign", { start: "2026-11-01", end: "2026-11-02" }, "TOKEN-123");
ok("every page is read, following paging.next", pagedRead.rows.length === 2 && pagedRead.pages === 2 && !pagedRead.tooBig);
const denied: FetchJson = async () => ({ ok: false, status: 400, body: { error: { message: "Invalid OAuth access token", code: 190 } } });
let msg = "";
try { await readLevel(denied, "act_1", "campaign", { start: "a", end: "b" }, "TOKEN-123"); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
ok("an error carries the platform's words and never the token or the url", /Invalid OAuth/.test(msg) && !/TOKEN-123|access_token/.test(msg), msg);
planted("an error that echoes the url", () => !/access_token/.test(`Meta API 400: https://graph.facebook.com/x?access_token=TOKEN-123`));
let calls = 0;
const endless: FetchJson = async (url) => {
  calls++;
  return { ok: true, status: 200, body: { data: Array.from({ length: PAGE_LIMIT }, (_, i) => day({ campaign_id: `c${calls}-${i}` })), paging: { next: `${url}&p=${calls}` } } };
};
const big = await readLevel(endless, "act_1", "campaign", { start: "2026-11-01", end: "2026-11-02" }, "TOKEN-123");
ok("a read at the ceiling is called too big and hands back no rows", big.tooBig && big.rows.length === 0 && calls <= MAX_META_ROWS / PAGE_LIMIT + 1, `${calls} pages`);
planted("a truncated list returned as if complete", () => big.rows.length > 0);

// ── 5. The window ────────────────────────────────────────────────────────────
section("5. The window");
const first = readWindow("2026-11-16", true), later = readWindow("2026-11-16", false);
ok("the window ends yesterday, UTC", first.end === "2026-11-15" && later.end === "2026-11-15");
ok(`the first read is ${BACKFILL_DAYS} days and later reads are ${RESTATE_DAYS}`, first.start === "2026-09-17" && later.start === "2026-11-02");

// ── 6. The job ───────────────────────────────────────────────────────────────
section("6. The job");
const job = read("import-meta-campaigns.ts");
const jobCode = codeOnly(job);
ok("it reads only enabled meta mappings with an ad account id", /cm\.source = 'meta' AND cm\.enabled = true/.test(jobCode) && /btrim\(cm\.external_id\) <> ''/.test(jobCode));
ok("it skips churned clients and the internal account", /c\.status <> 'churned'/.test(jobCode) && /c\.is_internal = false/.test(jobCode));
planted("a job that reads the internal account", () => /c\.is_internal = false/.test(jobCode.replace("c.is_internal = false", "")));
ok("with accounts mapped and no token it fails on purpose", /META_ACCESS_TOKEN is not set/.test(jobCode) && /process\.exit\(1\)/.test(jobCode));
ok("a dry run writes nothing (a --dry-run flag guards every store call)", /if \(!dryRun\) await ensureMetaDayTables/.test(jobCode) && /if \(dryRun\) \{[^}]*continue;/.test(jobCode));
ok("one level failing never costs another (try inside the level loop)", /for \(const level of META_LEVELS[\s\S]*?try \{/.test(jobCode));
ok("it names no secret other than the existing one", !/META_APP_SECRET|META_SYSTEM_USER|GOOGLE/.test(jobCode));

// ── 7. The workflow ──────────────────────────────────────────────────────────
section("7. The workflow");
const wf = read("../.github/workflows/import-meta-campaigns.yml");
ok("it is scheduled", /schedule:\s*\n\s*(#[^\n]*\n\s*)*- cron:/.test(wf));
ok("it can be dispatched with no inputs", /workflow_dispatch:/.test(wf) && !/required:\s*true/.test(wf));
ok("a hand-started run is a dry run unless told otherwise", /dry_run:[\s\S]*?default:\s*"true"/.test(wf));
ok("the heartbeat names the job and records a failure too", /--job=import_meta_campaigns/.test(wf) && /if:\s*always\(\)/.test(wf));
ok("a dry run and a one-client run never stamp the book-wide heartbeat", /inputs\.dry_run != 'true' && inputs\.client == ''/.test(wf));
ok("inputs reach the command through the environment, never the command line", /IN_CLIENT: \$\{\{ inputs\.client \}\}/.test(wf) && !/\$\{\{ inputs\.[a-z_]+ \}\}"?\s*\]/.test(wf.replace(/IN_[A-Z]+: .*/g, "")));

// ── 8. The real store ────────────────────────────────────────────────────────
const dbUrl = process.env.ADS_VERIFY_DATABASE_URL;
section("8. The real store");
if (!dbUrl) console.log("  (skipped: set ADS_VERIFY_DATABASE_URL to run this against a throwaway Postgres)");
else {
  const schema = `meta_verify_${Date.now()}`;
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await ensureMetaDayTables(c);
    await ensureMetaDayTables(c);
    ok("the tables are created, twice, without error", true);
    const ACCT = "act_999";
    const win = { start: "2026-11-01", end: "2026-11-02" };
    const rowsA: MetaDayRow[] = buildMetaDayRows("campaign", [day(), day({ campaign_id: "c2", date_start: "2026-11-02", actions: [] })]).rows;
    await storeMetaDays(c, "CL", ACCT, "campaign", rowsA, win, "first");
    let n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM meta_insight_days`)).rows[0]!.n;
    ok("two day-rows are stored", n === "2");
    const cost = (await c.query<{ spend_micros: string; leads: number | null; reach: string }>(`SELECT spend_micros, leads, reach FROM meta_insight_days WHERE entity_id='c1'`)).rows[0]!;
    ok("spend is stored as micros, leads as 3 and reach as the day's figure", cost.spend_micros === "12500000" && cost.leads === 3 && cost.reach === "3100");
    await storeMetaDays(c, "CL", ACCT, "campaign", buildMetaDayRows("campaign", [day({ spend: "20.00" })]).rows, win, "again");
    n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM meta_insight_days`)).rows[0]!.n;
    const restated = (await c.query<{ spend_micros: string }>(`SELECT spend_micros FROM meta_insight_days WHERE entity_id='c1'`)).rows[0]!;
    ok("a re-read of a day restates it and writes no second row", n === "2" && restated.spend_micros === "20000000");
    const scan = await loadMetaCoverage(c, ACCT, "campaign");
    ok("the scan row dates how far the record reaches", scan?.coveredFrom === "2026-11-01" && scan.coveredTo === "2026-11-02");
    await recordMetaFailure(c, "CL", ACCT, "campaign", "2026-11-03", "token expired");
    const failed = (await c.query<{ ok: boolean; covered_to: string; note: string }>(`SELECT ok, covered_to, note FROM meta_insight_scans WHERE account_id=$1 AND level='campaign'`, [ACCT])).rows[0]!;
    ok("a failure is a dated row and keeps the earlier span", failed.ok === false && failed.covered_to === "2026-11-02" && /token expired/.test(failed.note));
    ok("a failure leaves the earlier day-rows alone", (await c.query<{ n: string }>(`SELECT count(*) AS n FROM meta_insight_days`)).rows[0]!.n === "2");
    // Levels are independent.
    await storeMetaDays(c, "CL", ACCT, "adset", buildMetaDayRows("adset", [day({ adset_id: "s1", adset_name: "Set" })]).rows, win, "adset");
    const scans = (await c.query<{ level: string }>(`SELECT level FROM meta_insight_scans WHERE account_id=$1 ORDER BY level`, [ACCT])).rows.map((r) => r.level);
    ok("each level has its own scan row", scans.join() === "adset,campaign");
    // The same entity id at two levels never collides.
    const sameId = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM meta_insight_days WHERE entity_id='s1'`)).rows[0]!.n;
    ok("an ad set row is stored beside the campaign rows", sameId === "1");
    // A store that fails halfway rolls back whole.
    const before = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM meta_insight_days`)).rows[0]!.n;
    let threw = false;
    try {
      await storeMetaDays(c, "CL", ACCT, "campaign", [{ ...rowsA[0]!, entityId: "z1", date: "2026-11-03" }, { ...rowsA[0]!, entityId: null as unknown as string, date: "2026-11-03" }], { start: "2026-11-03", end: "2026-11-03" }, "bad");
    } catch { threw = true; }
    const afterN = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM meta_insight_days`)).rows[0]!.n;
    ok("a store that fails halfway rolls back whole", threw && before === afterN);
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
}

console.log("\n" + "─".repeat(72));
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");

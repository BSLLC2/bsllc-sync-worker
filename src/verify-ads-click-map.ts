#!/usr/bin/env tsx
/**
 * Ads click map: the reader.
 *
 * Proves, over INVENTED rows (no ad account, no network, no credential):
 *
 *   1. it only READS: no platform write, no write to findings; the query is a SELECT over the click record, one date
 *   2. the window ends YESTERDAY, a first run reads ninety days, a later one fourteen, bounded at ninety
 *   3. a row is read as the API returns it (snake_case); a row with no click id, campaign or date is dropped; the criterion id
 *      is read off the keyword's resource name
 *   4. ONLY A KNOWN CLICK ID IS KEPT: a click that did not become a lead we hold is never stored, and one id is stored once
 *   5. the job refuses a day at the row ceiling and writes a failure, not silence
 *   6. the workflow: scheduled run is live, dispatch defaults to dry, inputs go through the environment, heartbeat excluded
 *      for dry and scoped runs
 *   7. the real store, on a throwaway schema (when ADS_VERIFY_DATABASE_URL is set)
 *
 *   npm run verify-ads-click-map
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  BACKFILL_DAYS, CLICK_GAQL, MAX_DAY_ROWS, RESTATE_DAYS, criterionOf, ensureClickTables, keepKnown, loadClickCoverage, loadKnownClickIds,
  normalizeClick, readDays, recordClickFailure, storeClicks, type ClickRow,
} from "./ads/click-map.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n${s}`);
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");
const codeOnly = (src: string) => src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

section("1. It only reads: nothing here changes an ad account");
export function writeWords(src: string): string[] {
  const code = codeOnly(src);
  return [
    /\.mutate\s*\(/, /mutateResources/i, /applyRecommendation/i, /campaignService/i, /uploadClickConversions/i, /uploadConversionAdjustments/i,
    /INSERT INTO ads_findings/i, /UPDATE ads_findings/i, /ads_finding_events/i,
  ].filter((re) => re.test(code)).map(String);
}
for (const f of ["ads/click-map.ts", "ads-click-map.ts"]) {
  const bad = writeWords(read(f));
  ok(`${f} names no platform write, no conversion upload and no write to findings`, bad.length === 0, bad.join(" "));
}
ok("the query is a SELECT over the click record for one date", /^\s*SELECT\b/i.test(CLICK_GAQL) && /FROM\s+click_view\b/i.test(CLICK_GAQL) && /segments\.date\s*=\s*'\{\{day\}\}'/.test(CLICK_GAQL));
ok("the query asks for no name, phone, email, search text or page", !/(query|search_term|url|email|phone|name)/i.test(CLICK_GAQL.replace(/campaign\.id|ad_group\.id/g, "")));
ok("the write scan sees a planted mutate", writeWords("await customer.campaigns.mutate({})").length > 0);
ok("the write scan sees a planted conversion upload", writeWords("await customer.conversionUploads.uploadClickConversions(x)").length > 0);

section("2. The window");
const days = readDays("2026-10-14", true);
ok("a first run reads ninety days ending yesterday", days.length === BACKFILL_DAYS && days[days.length - 1] === "2026-10-13" && days[0] === "2026-07-16", `${days[0]}..${days[days.length - 1]}`);
ok("a later run reads fourteen", readDays("2026-10-14", false).length === RESTATE_DAYS);
ok("--days is honoured and bounded at ninety", readDays("2026-10-14", true, 5).length === 5 && readDays("2026-10-14", true, 400).length === BACKFILL_DAYS);

section("3. A row is read as the API returns it");
const api = (gclid: string, camp = "11", date = "2026-10-10", kw = "customers/9/adGroupCriteria/222~333", ag = "222") => ({ click_view: { gclid, keyword: kw }, campaign: { id: camp }, ad_group: { id: ag }, segments: { date } });
const n = normalizeClick(api("G1"));
ok("campaign, ad group, criterion and date are read", n?.campaignId === "11" && n.adGroupId === "222" && n.criterionId === "333" && n.date === "2026-10-10");
ok("a row with no click id is dropped", normalizeClick(api("")) === null);
ok("a row with no campaign is dropped", normalizeClick({ click_view: { gclid: "G" }, segments: { date: "2026-10-10" } }) === null);
ok("a row with a bad date is dropped", normalizeClick(api("G", "11", "10/10/2026")) === null);
ok("a click with no keyword has a null criterion", normalizeClick(api("G2", "11", "2026-10-10", ""))?.criterionId === null && criterionOf(undefined) === null);

section("4. Only a known click id is kept");
const known = new Set(["G1", "G3"]);
const kept = keepKnown([api("G1"), api("G2"), api("G3", "12", "2026-10-11"), api("G1", "11", "2026-10-12")], known);
ok("a click that did not become a lead is not kept", !kept.some((r) => r.gclid === "G2"));
ok("a known click is kept once, on its earliest day", kept.filter((r) => r.gclid === "G1").length === 1 && kept.find((r) => r.gclid === "G1")!.date === "2026-10-10");
ok("two known clicks are two rows", kept.length === 2);
ok("with nothing known nothing is kept", keepKnown([api("G1")], new Set()).length === 0);

section("5. The job refuses a truncated day and writes a failure, not silence");
const job = codeOnly(read("ads-click-map.ts"));
ok("a day at the ceiling throws before storing", /list\.length >= MAX_DAY_ROWS[\s\S]{0,300}throw new Error/.test(job) && job.indexOf("MAX_DAY_ROWS") < job.indexOf("storeClicks(c"));
ok("a failed account writes a failure row", /recordClickFailure\(/.test(job));
ok("every account failing is a failed run", /read === 0\) process\.exit\(1\)/.test(job));
ok("a dry run writes nothing", /if \(dryRun\) \{[^}]*continue/.test(job) && /if \(!dryRun\) await recordClickFailure/.test(job));
ok("the ceiling is a real number", MAX_DAY_ROWS >= 10_000);
ok("the known click ids come from this client's enquiries only", /loadKnownClickIds\(c, slugify\(t\.clientName\)/.test(job));

section("6. The workflow");
const wf = readFileSync(join(here, "..", ".github/workflows/ads-click-map.yml"), "utf8");
ok("it is scheduled", /cron: "\d+ \d+ \* \* \*"/.test(wf));
ok("a dispatch defaults to a dry run", /dry_run:[\s\S]{0,200}default: "true"/.test(wf));
ok("a scheduled run is live (dry only when the input says true)", /\[ "\$IN_DRY" = "true" \]/.test(wf));
ok("inputs reach the command through the environment", /IN_CLIENT: \$\{\{ inputs\.client \}\}/.test(wf) && !/run:[^\n]*\$\{\{ inputs\./.test(wf));
ok("the heartbeat is recorded even when the job fails", /Heartbeat[\s\S]{0,80}if: always\(\)/.test(wf));
ok("a dry run and a scoped run do not stamp the book-wide heartbeat", /if: always\(\) && inputs\.dry_run != 'true' && inputs\.client == ''/.test(wf));
ok("the heartbeat names the job", /--job=ads_click_map/.test(wf));
ok("the run can't overlap itself", /concurrency:[\s\S]{0,80}cancel-in-progress: false/.test(wf));

const dbUrl = process.env.ADS_VERIFY_DATABASE_URL;
if (!dbUrl) {
  section("7. The real store functions");
  console.log("  ⏭  skipped: ADS_VERIFY_DATABASE_URL is not set. CI runs this section in the `ads-store` job.");
} else {
  await storeSection(dbUrl);
}

async function storeSection(url: string) {
  section("7. The real store, on a throwaway schema");
  const schema = `ads_click_${Math.random().toString(36).slice(2, 10)}`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await ensureClickTables(c);
    await ensureClickTables(c);
    ok("the tables are created, twice, without error", true);
    await c.query(`CREATE TABLE web_inquiries (client_slug TEXT, gclid TEXT, submitted_at TIMESTAMPTZ)`);
    await c.query(`INSERT INTO web_inquiries VALUES ('och','G1', '2026-10-09'), ('och','  G3  ', '2026-10-09'), ('och', '', '2026-10-09'), ('och', NULL, '2026-10-09'), ('other','GX','2026-10-09'), ('och','OLD','2024-01-01')`);
    const ids = await loadKnownClickIds(c, "och", "2026-10-14");
    ok("the known click ids are this client's, trimmed, non-blank and recent", ids.size === 2 && ids.has("G1") && ids.has("G3") && !ids.has("GX") && !ids.has("OLD"), Array.from(ids).join(","));
    const ACCT = "1112223334";
    const win = { start: "2026-10-01", end: "2026-10-05" };
    const mk = (g: string, camp: string, d: string): ClickRow => ({ gclid: g, campaignId: camp, adGroupId: "7", criterionId: null, date: d });
    const cov = await storeClicks(c, "CL", ACCT, [mk("G1", "11", "2026-10-02"), mk("G3", "12", "2026-10-03")], win, 5, "first");
    ok("the first store covers its window", cov.coveredFrom === "2026-10-01" && !cov.restarted);
    let cnt = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_click_map`)).rows[0]!.n;
    ok("two clicks are stored", cnt === "2");
    const cols = (await c.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'ads_click_map'`, [schema])).rows.map((r) => r.column_name);
    ok("the table holds no name, phone, email, query or page column", !cols.some((x) => /name|phone|email|query|term|url|page/.test(x)), cols.join(","));
    await storeClicks(c, "CL", ACCT, [mk("G1", "13", "2026-10-02")], { start: "2026-10-01", end: "2026-10-06" }, 6, "second");
    cnt = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_click_map`)).rows[0]!.n;
    ok("a re-read restates a click and adds no row", cnt === "2");
    const g1 = (await c.query<{ campaign_id: string }>(`SELECT campaign_id FROM ads_click_map WHERE gclid='G1'`)).rows[0]!;
    ok("the restated click carries the new campaign", g1.campaign_id === "13");
    let cv = await loadClickCoverage(c, ACCT);
    ok("coverage moved to the new end, from the original start", cv?.coveredFrom === "2026-10-01" && cv?.coveredTo === "2026-10-06", JSON.stringify(cv));
    const gap = await storeClicks(c, "CL", ACCT, [], { start: "2026-10-19", end: "2026-10-21" }, 3, "after a gap");
    cv = await loadClickCoverage(c, ACCT);
    ok("a gap restarts the covered span", gap.restarted && cv?.coveredFrom === "2026-10-19");
    await recordClickFailure(c, "CL", ACCT, "2026-10-22", "auth expired");
    const sc = (await c.query<{ ok: boolean; covered_from: string; note: string }>(`SELECT ok, covered_from, note FROM ads_click_scans WHERE account_id=$1`, [ACCT])).rows;
    ok("one scan row per account; a failure marks ok = false and keeps the span", sc.length === 1 && sc[0]!.ok === false && sc[0]!.covered_from === "2026-10-19" && /auth expired/.test(sc[0]!.note));
    await recordClickFailure(c, "CL", "9998887776", "2026-10-22", "first ever");
    const fresh = (await c.query<{ ok: boolean; covered_from: string; covered_to: string }>(`SELECT ok, covered_from, covered_to FROM ads_click_scans WHERE account_id='9998887776'`)).rows[0]!;
    ok("a first-ever failure is a dated row with an empty span", fresh.ok === false && fresh.covered_from > fresh.covered_to);
    await storeClicks(c, "CL", ACCT, [], { start: "2026-10-22", end: "2026-10-22" }, 1, "recovered");
    ok("a good run after a failure marks the scan ok again", (await c.query<{ ok: boolean }>(`SELECT ok FROM ads_click_scans WHERE account_id=$1`, [ACCT])).rows[0]!.ok === true);
    await c.query(`INSERT INTO ads_click_map (id, client_id, platform, account_id, gclid, click_date, campaign_id) VALUES ('old','CL','google_ads',$1,'OLDCLICK','2025-01-01','1')`, [ACCT]);
    await storeClicks(c, "CL", ACCT, [], { start: "2026-10-23", end: "2026-10-23" }, 1, "prune");
    ok("a click older than the platform keeps it is pruned", (await c.query(`SELECT 1 FROM ads_click_map WHERE gclid='OLDCLICK'`)).rowCount === 0);
    const before = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_click_map`)).rows[0]!.n;
    let threw = false;
    try { await storeClicks(c, "CL", ACCT, [mk("G9", "1", "2026-11-01"), { ...mk("G8", "1", "2026-11-02"), campaignId: null as unknown as string }], { start: "2026-11-01", end: "2026-11-02" }, 2, "bad"); } catch { threw = true; }
    const after = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_click_map`)).rows[0]!.n;
    ok("a store that fails halfway rolls back whole", threw && before === after);
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
}

console.log("\n" + "─".repeat(72));
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");

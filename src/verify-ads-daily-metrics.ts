#!/usr/bin/env tsx
/**
 * Ads daily metrics: the reader.
 *
 * Proves, over INVENTED rows (no ad account, no network, no credential):
 *
 *   1. it only READS: neither source file names a platform write, a mutate, or
 *      a write to findings; the query is a SELECT over campaigns and days
 *   2. the window ends YESTERDAY, a first run reads sixty days, a later one
 *      fourteen, and --days is honoured and bounded
 *   3. a row is read as the API returns it (snake_case), a row with no campaign
 *      or date is dropped, a repeated campaign-day is summed, money stays micros
 *   4. a NULL IS UNANSWERED: conversions are nulled when the account reported
 *      none anywhere in the window, a real zero stays zero once one appeared
 *   5. coverage: a continuous run extends the span, a gap restarts it
 *   6. the job refuses a read at the row ceiling, and writes a failure not silence
 *   7. the workflow: scheduled run is live, dispatch defaults to dry, inputs go
 *      through the environment, the heartbeat is excluded for dry and scoped runs
 *   8. the real store, on a throwaway schema (when ADS_VERIFY_DATABASE_URL is set)
 *
 *   npm run verify-ads-daily-metrics
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  BACKFILL_DAYS, DAILY_GAQL, MAX_DAILY_ROWS, RESTATE_DAYS, addDays, buildDailyRows, coverageAfter,
  ensureDailyTables, hasSpan, loadCoverage, readWindow, recordDailyFailure, storeDaily, type DailyRow,
} from "./ads/daily-metrics.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n${s}`);
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");
const codeOnly = (src: string) => src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

// ── 1. It only reads ─────────────────────────────────────────────────────────
section("1. It only reads: nothing here changes an ad account");
export function writeWords(src: string): string[] {
  const code = codeOnly(src);
  return [
    /\.mutate\s*\(/, /mutateResources/i, /applyRecommendation/i, /campaignService/i, /campaignBudgetService/i,
    /INSERT INTO ads_findings/i, /UPDATE ads_findings/i, /ads_finding_events/i,
  ].filter((re) => re.test(code)).map(String);
}
for (const f of ["ads/daily-metrics.ts", "ads-daily-metrics.ts"]) {
  const bad = writeWords(read(f));
  ok(`${f} names no platform write and no write to findings`, bad.length === 0, bad.join(" "));
}
ok("the query is a SELECT over campaigns and days", /^\s*SELECT\b/i.test(DAILY_GAQL) && /FROM\s+campaign\b/i.test(DAILY_GAQL) && /segments\.date/.test(DAILY_GAQL));
ok("the query asks for the five measures", ["metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions"].every((m) => DAILY_GAQL.includes(m)));
ok("the query leaves removed campaigns out", /campaign\.status != 'REMOVED'/.test(DAILY_GAQL));
// The self-test: the instrument must see a planted write.
ok("the write scan sees a planted mutate", writeWords("await customer.campaigns.mutate({})").length > 0);

// ── 2. The window ────────────────────────────────────────────────────────────
section("2. The window ends yesterday");
const w1 = readWindow("2026-10-14", true);
ok("a first run ends yesterday", w1.end === "2026-10-13", w1.end);
ok(`a first run reads ${BACKFILL_DAYS} days`, w1.start === addDays("2026-10-13", -(BACKFILL_DAYS - 1)), `${w1.start} to ${w1.end}`);
const w2 = readWindow("2026-10-14", false);
ok(`a later run reads ${RESTATE_DAYS} days`, w2.start === addDays("2026-10-13", -(RESTATE_DAYS - 1)) && w2.end === "2026-10-13");
ok("today itself is never in the window", ![w1, w2].some((w) => w.end >= "2026-10-14"));
ok("--days is honoured", readWindow("2026-10-14", false, 30).start === "2026-09-14");
ok("--days is bounded", readWindow("2026-10-14", false, 100000).start === addDays("2026-10-13", -399) && readWindow("2026-10-14", false, 0).start === "2026-10-13");
ok("across a month and a year end", readWindow("2027-01-02", false, 3).start === "2026-12-30");

// ── 3. Reading rows ──────────────────────────────────────────────────────────
section("3. A row is read as the API returns it");
const api = (id: string, date: string, m: Record<string, number | string>, name = `Camp ${id}`) =>
  ({ campaign: { id, name }, segments: { date }, metrics: m });
const rows1 = buildDailyRows([
  api("1", "2026-10-01", { impressions: "1200", clicks: "90", cost_micros: "45500000", conversions: 3 }),
  api("1", "2026-10-02", { impressions: 0, clicks: 0, cost_micros: 0, conversions: 0 }),
  { campaign: { id: "", name: "x" }, segments: { date: "2026-10-01" }, metrics: {} },
  { campaign: { id: "2" }, segments: { date: "not a date" }, metrics: {} },
  api("1", "2026-10-01", { impressions: 100, clicks: 10, cost_micros: 5000000, conversions: 1 }),
]);
ok("a row with no campaign or no real date is dropped", rows1.length === 2, `${rows1.length} rows`);
const d1 = rows1.find((r) => r.date === "2026-10-01")!;
ok("a repeated campaign-day is summed", d1.impressions === 1300 && d1.clicks === 100 && d1.conversions === 4);
ok("money stays micros, verbatim", d1.costMicros === 50_500_000);
ok("rows come out in date order", rows1[0]!.date <= rows1[1]!.date);
ok("string numbers are read", d1.impressions === 1300);
ok("a name is kept, a missing one is null", d1.campaignName === "Camp 1" && buildDailyRows([{ campaign: { id: "9" }, segments: { date: "2026-10-01" }, metrics: { conversions: 1 } }])[0]!.campaignName === null);

// ── 4. A null is unanswered ──────────────────────────────────────────────────
section("4. Conversions: a null is unanswered, a nought is an answer");
const none = buildDailyRows([
  api("1", "2026-10-01", { impressions: 500, clicks: 40, cost_micros: 1, conversions: 0 }),
  api("1", "2026-10-02", { impressions: 400, clicks: 30, cost_micros: 1, conversions: 0 }),
]);
ok("an account that reported no conversion anywhere stores null, not nought", none.every((r) => r.conversions === null), JSON.stringify(none.map((r) => r.conversions)));
ok("the other measures are still stored as numbers", none.every((r) => r.impressions > 0 && r.clicks > 0));
const some = buildDailyRows([
  api("1", "2026-10-01", { impressions: 500, clicks: 40, cost_micros: 1, conversions: 0 }),
  api("1", "2026-10-02", { impressions: 400, clicks: 30, cost_micros: 1, conversions: 2 }),
]);
ok("once the account reported one, an earlier nought is a real nought", some[0]!.conversions === 0 && some[1]!.conversions === 2);
ok("the evidence is the account's window, not one campaign's", (() => {
  const r = buildDailyRows([
    api("1", "2026-10-01", { impressions: 5, clicks: 1, cost_micros: 1, conversions: 0 }),
    api("2", "2026-10-01", { impressions: 5, clicks: 1, cost_micros: 1, conversions: 4 }),
  ]);
  return r.find((x) => x.campaignId === "1")!.conversions === 0;
})());
ok("a fractional conversion is kept (the platform counts fractions)", buildDailyRows([api("1", "2026-10-01", { impressions: 5, clicks: 1, cost_micros: 1, conversions: 0.25 })])[0]!.conversions === 0.25);
ok("a non-finite measure is a nought, never NaN", buildDailyRows([api("1", "2026-10-01", { impressions: "x", clicks: 1, cost_micros: 1, conversions: 1 })])[0]!.impressions === 0);
ok("an empty read stores nothing", buildDailyRows([]).length === 0);

// ── 5. Coverage ──────────────────────────────────────────────────────────────
section("5. Coverage: a gap restarts the span");
ok("the first run starts at its own window", coverageAfter(null, { start: "2026-08-15", end: "2026-10-13" }).coveredFrom === "2026-08-15");
const cont = coverageAfter({ coveredFrom: "2026-08-15", coveredTo: "2026-10-12" }, { start: "2026-09-29", end: "2026-10-13" });
ok("a continuous run keeps the earlier start", cont.coveredFrom === "2026-08-15" && !cont.restarted);
const gap = coverageAfter({ coveredFrom: "2026-08-15", coveredTo: "2026-09-20" }, { start: "2026-09-29", end: "2026-10-13" });
ok("a gap restarts the span at this window", gap.coveredFrom === "2026-09-29" && gap.restarted);
const touching = coverageAfter({ coveredFrom: "2026-08-15", coveredTo: "2026-09-28" }, { start: "2026-09-29", end: "2026-10-13" });
ok("a window that begins the day after the last covered day is continuous", !touching.restarted && touching.coveredFrom === "2026-08-15");

ok("an empty span (a first-ever failure) has no coverage", !hasSpan({ coveredFrom: "2026-10-14", coveredTo: "2026-10-13" }) && !hasSpan(null) && hasSpan({ coveredFrom: "2026-10-01", coveredTo: "2026-10-01" }));
ok("after a first-ever failure the next run starts afresh, not as a restart", (() => {
  const c = coverageAfter({ coveredFrom: "2026-10-14", coveredTo: "2026-10-13" }, { start: "2026-08-16", end: "2026-10-14" });
  return c.coveredFrom === "2026-08-16" && !c.restarted;
})());
ok("and the job reads sixty days again then", /readWindow\(today, !hasSpan\(prev\)/.test(codeOnly(read("ads-daily-metrics.ts"))));

// ── 6. The job ───────────────────────────────────────────────────────────────
section("6. The job refuses a truncated read and writes a failure, not silence");
const job = codeOnly(read("ads-daily-metrics.ts"));
ok("the row ceiling is checked before anything is stored", job.indexOf("MAX_DAILY_ROWS") > 0 && job.indexOf("MAX_DAILY_ROWS") < job.indexOf("storeDaily("));
ok("a read at the ceiling throws", /list\.length >= MAX_DAILY_ROWS[\s\S]{0,300}throw new Error/.test(job));
ok("a failed account writes a failure row", /recordDailyFailure\(/.test(job));
ok("every account failing is a failed run", /read === 0\) process\.exit\(1\)/.test(job));
ok("a dry run writes nothing", /if \(dryRun\) \{[^}]*continue/.test(job) && /if \(!dryRun\) await recordDailyFailure/.test(job));
ok("the ceiling is a real number", MAX_DAILY_ROWS >= 10_000);

// ── 7. The workflow ──────────────────────────────────────────────────────────
section("7. The workflow");
const wf = readFileSync(join(here, "..", ".github/workflows/ads-daily-metrics.yml"), "utf8");
ok("it is scheduled", /schedule:\s*\n\s*#?.*\n?\s*-?\s*-?\s*cron:/m.test(wf) || /cron: "\d+ \d+ \* \* \*"/.test(wf));
ok("a dispatch defaults to a dry run", /dry_run:[\s\S]{0,200}default: "true"/.test(wf));
ok("a scheduled run is live (dry only when the input says true)", /\[ "\$IN_DRY" = "true" \]/.test(wf));
ok("inputs reach the command through the environment", /IN_CLIENT: \$\{\{ inputs\.client \}\}/.test(wf) && !/run:[^\n]*\$\{\{ inputs\./.test(wf));
ok("the heartbeat is recorded even when the job fails", /Heartbeat[\s\S]{0,80}if: always\(\)/.test(wf));
ok("a dry run and a scoped run do not stamp the book-wide heartbeat", /if: always\(\) && inputs\.dry_run != 'true' && inputs\.client == ''/.test(wf));
ok("the heartbeat names the job", /--job=ads_daily_metrics/.test(wf));
ok("the run can't overlap itself", /concurrency:[\s\S]{0,80}cancel-in-progress: false/.test(wf));

// ── 8. The real store ────────────────────────────────────────────────────────
const dbUrl = process.env.ADS_VERIFY_DATABASE_URL;
if (!dbUrl) {
  section("8. The real store functions");
  console.log("  ⏭  skipped: ADS_VERIFY_DATABASE_URL is not set. Locally: `node scripts/test-db.mjs start` in the dashboard repo prints a URL.");
  console.log("     CI runs this section in the `ads-store` job against a Postgres service container.");
} else {
  await storeSection(dbUrl);
}

async function storeSection(url: string) {
  section("8. The real store, on a throwaway schema");
  const schema = `ads_daily_${Math.random().toString(36).slice(2, 10)}`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await ensureDailyTables(c);
    await ensureDailyTables(c);
    ok("the tables are created, twice, without error", true);
    const ACCT = "1112223334";
    const win = { start: "2026-10-01", end: "2026-10-05" };
    const mk = (id: string, date: string, imp: number, conv: number | null): DailyRow => ({ campaignId: id, campaignName: `C${id}`, date, impressions: imp, clicks: Math.round(imp / 10), costMicros: imp * 1000, conversions: conv });
    const first = [mk("1", "2026-10-01", 1000, 2), mk("1", "2026-10-02", 900, null), mk("2", "2026-10-01", 50, 0)];
    const cov = await storeDaily(c, "CL", ACCT, first, win, "first");
    ok("the first store covers its window", cov.coveredFrom === "2026-10-01" && !cov.restarted);
    let n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_daily_metrics`)).rows[0]!.n;
    ok("three campaign-days are stored", n === "3");
    const nulls = (await c.query<{ conversions: number | null }>(`SELECT conversions FROM ads_daily_metrics WHERE campaign_id='1' AND metric_date='2026-10-02'`)).rows[0]!;
    ok("a null conversion is stored as NULL, not 0", nulls.conversions === null);
    const bigint = (await c.query<{ cost_micros: string }>(`SELECT cost_micros FROM ads_daily_metrics WHERE campaign_id='1' AND metric_date='2026-10-01'`)).rows[0]!;
    ok("money is stored as micros", bigint.cost_micros === "1000000");

    // A second run over an overlapping window restates, never duplicates.
    await storeDaily(c, "CL", ACCT, [mk("1", "2026-10-01", 1000, 5), mk("1", "2026-10-02", 900, 1)], { start: "2026-10-01", end: "2026-10-06" }, "second");
    n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_daily_metrics`)).rows[0]!.n;
    ok("a re-read restates the day and adds no row", n === "3");
    const restated = (await c.query<{ conversions: number | null }>(`SELECT conversions FROM ads_daily_metrics WHERE campaign_id='1' AND metric_date='2026-10-01'`)).rows[0]!;
    ok("a late conversion is restated", restated.conversions === 5);
    const filled = (await c.query<{ conversions: number | null }>(`SELECT conversions FROM ads_daily_metrics WHERE campaign_id='1' AND metric_date='2026-10-02'`)).rows[0]!;
    ok("a null that became known is replaced", filled.conversions === 1);
    const kept = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_daily_metrics WHERE campaign_id='2'`)).rows[0]!.n;
    ok("a campaign-day not in the re-read is left alone", kept === "1");

    let cv = await loadCoverage(c, ACCT);
    ok("coverage moved to the new end, from the original start", cv?.coveredFrom === "2026-10-01" && cv?.coveredTo === "2026-10-06", JSON.stringify(cv));

    // A gap restarts coverage.
    const g = await storeDaily(c, "CL", ACCT, [mk("1", "2026-10-20", 700, 1)], { start: "2026-10-19", end: "2026-10-21" }, "after a gap");
    cv = await loadCoverage(c, ACCT);
    ok("a gap restarts the covered span", g.restarted && cv?.coveredFrom === "2026-10-19" && cv?.coveredTo === "2026-10-21");

    // A failure keeps the span and says so.
    await recordDailyFailure(c, "CL", ACCT, "2026-10-22", "auth expired");
    const sc = (await c.query<{ ok: boolean; covered_from: string; covered_to: string; note: string }>(`SELECT ok, covered_from, covered_to, note FROM ads_daily_scans WHERE account_id=$1`, [ACCT])).rows;
    ok("one scan row per account", sc.length === 1);
    ok("a failure marks ok = false and keeps the span", sc[0]!.ok === false && sc[0]!.covered_from === "2026-10-19" && sc[0]!.covered_to === "2026-10-21");
    ok("the failure says why", /auth expired/.test(sc[0]!.note));
    await recordDailyFailure(c, "CL", "9998887776", "2026-10-22", "first ever");
    const fresh = (await c.query<{ ok: boolean; covered_from: string; covered_to: string }>(`SELECT ok, covered_from, covered_to FROM ads_daily_scans WHERE account_id='9998887776'`)).rows[0]!;
    ok("a first-ever failure is a dated row with an empty span", fresh.ok === false && fresh.covered_from > fresh.covered_to);

    // A first success after a first-ever failure covers its whole window.
    const fv = await storeDaily(c, "CL", "9998887776", [mk("7", "2026-10-10", 10, 1)], { start: "2026-08-12", end: "2026-10-13" }, "first good run");
    ok("a first good run after a first-ever failure is not a restart", !fv.restarted && fv.coveredFrom === "2026-08-12");

    // A good run after a failure marks ok again.
    await storeDaily(c, "CL", ACCT, [], { start: "2026-10-22", end: "2026-10-22" }, "recovered");
    const back = (await c.query<{ ok: boolean }>(`SELECT ok FROM ads_daily_scans WHERE account_id=$1`, [ACCT])).rows[0]!;
    ok("a good run after a failure marks the scan ok again", back.ok === true);

    // A store that fails halfway leaves nothing behind.
    const before = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_daily_metrics`)).rows[0]!.n;
    let threw = false;
    try {
      await storeDaily(c, "CL", ACCT, [mk("5", "2026-11-01", 1, 1), { ...mk("5", "2026-11-02", 1, 1), campaignId: null as unknown as string }], { start: "2026-11-01", end: "2026-11-02" }, "bad");
    } catch { threw = true; }
    const after = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_daily_metrics`)).rows[0]!.n;
    ok("a store that fails halfway rolls back whole", threw && before === after);
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
}

console.log("\n" + "─".repeat(72));
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");

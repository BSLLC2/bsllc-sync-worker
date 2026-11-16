#!/usr/bin/env tsx
/**
 * Ads share reads: impression share lost to budget and rank, keyword quality and
 * first-page cost, hour and device segments, places.
 *
 * Proves, over INVENTED rows (no ad account, no network, no credential):
 *
 *   1. it only READS: no platform write anywhere, every query a SELECT
 *   2. a share is a fraction or null; a bound stays a bound and is never a nought
 *   3. a day with no share is dropped, not stored as 0
 *   4. quality: score 1..10 else null, components decoded, a 0 CPC is no estimate, unscored kept
 *   5. segments: hour 0..23, device decoded, repeats summed, conversions null without evidence
 *   6. geography: numeric ids, repeats summed, no person
 *   7. the windows: 60 then 14 ending yesterday, slices that cover exactly, 30 for window parts
 *   8. the job: a ceiling writes nothing, a failure is a row, parts are independent, the geo fallback
 *   9. the workflow
 *  10. the real store, on a throwaway schema (when ADS_VERIFY_DATABASE_URL is set)
 *
 *   npm run verify-ads-share-reads
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  DAY_PARTS, GEO_GAQL, GEO_GAQL_COUNTRY_ONLY, KEYWORD_QUALITY_GAQL, MAX_ROWS, PARTS, QUERY_BY_PART, SEGMENT_DEVICES_GAQL,
  SEGMENT_HOURS_GAQL, SHARE_DAYS_GAQL, SHARE_MEASURES, SLICE_DAYS, UNDER_TEN_SENTINEL, WINDOW_DAYS,
  buildGeoRows, buildQualityRows, buildSegmentRows, buildShareRows, dayWindow, ensureShareTables, fillWindow, loadPartCoverage,
  parseShare, recordShareFailure, sliceWindow, storeGeo, storeKeywordQuality, storeSegmentDays, storeShareDays, windowEndingYesterday,
} from "./ads/share-reads.js";
import { daysBetween } from "./ads/daily-metrics.js";

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
for (const f of ["ads/share-reads.ts", "ads-share-reads.ts"]) {
  const bad = writeWords(read(f));
  ok(`${f} names no platform write and no write to findings`, bad.length === 0, bad.join(" "));
}
ok("SELF-TEST: the instrument sees a planted mutate", writeWords("x.mutate(ops)").length === 1);
for (const [part, q] of Object.entries(QUERY_BY_PART)) ok(`the ${part} query is a SELECT`, /^\s*SELECT\b/i.test(q));
ok("the country-only geo fallback is a SELECT that drops only the finer place", /^\s*SELECT\b/i.test(GEO_GAQL_COUNTRY_ONLY) && !GEO_GAQL_COUNTRY_ONLY.includes("geo_target_most_specific_location") && GEO_GAQL.includes("geo_target_most_specific_location"));
ok("the share query names all five share measures", ["search_impression_share", "search_budget_lost_impression_share", "search_rank_lost_impression_share", "search_top_impression_share", "search_absolute_top_impression_share"].every((m) => SHARE_DAYS_GAQL.includes(m)));
ok("the quality query names the score, the three components and both cost estimates", ["quality_score", "search_predicted_ctr", "creative_quality_score", "post_click_quality_score", "first_page_cpc_micros", "top_of_page_cpc_micros"].every((m) => KEYWORD_QUALITY_GAQL.includes(m)));
ok("the segment queries segment by hour and by device", SEGMENT_HOURS_GAQL.includes("segments.hour") && SEGMENT_DEVICES_GAQL.includes("segments.device"));
ok("the day queries carry the window placeholders", [SHARE_DAYS_GAQL, SEGMENT_HOURS_GAQL, SEGMENT_DEVICES_GAQL, GEO_GAQL].every((q) => q.includes("{{start}}") && q.includes("{{end}}")));
ok("the keyword quality read is not date-filtered (a score is what the platform says now)", !KEYWORD_QUALITY_GAQL.includes("segments.date"));

// ── 2. A share ───────────────────────────────────────────────────────────────
section("2. A share is a fraction or null; a bound stays a bound");
ok("a fraction is a figure with no bound", JSON.stringify(parseShare(0.42)) === JSON.stringify({ value: 0.42, bound: null }));
ok("a typed zero is a real zero", parseShare(0).value === 0 && parseShare(0).bound === null);
ok("null, undefined and an empty string are no figure, never a nought", [null, undefined, ""].every((v) => parseShare(v).value === null));
ok('"--" is no figure', parseShare("--").value === null);
ok('"< 10%" is a bound under ten percent, kept as 0.1 with the flag', JSON.stringify(parseShare("< 10%")) === JSON.stringify({ value: 0.1, bound: "lt" }));
ok('"<10%" without a space reads the same', parseShare("<10%").bound === "lt" && parseShare("<10%").value === 0.1);
ok('"> 90%" is a bound over ninety percent', JSON.stringify(parseShare("> 90%")) === JSON.stringify({ value: 0.9, bound: "gt" }));
ok('"45%" is 0.45 with no bound', JSON.stringify(parseShare("45%")) === JSON.stringify({ value: 0.45, bound: null }));
ok("the platform's under-ten sentinel is read as a bound, not as a figure", parseShare(UNDER_TEN_SENTINEL).bound === "lt" && parseShare(UNDER_TEN_SENTINEL).value === UNDER_TEN_SENTINEL);
ok("a value over 1 is refused (it is not a fraction)", parseShare(1.7).value === null && parseShare("170%").value === null);
ok("a negative is refused", parseShare(-0.2).value === null);
ok("text that is not a number is refused", parseShare("n/a").value === null && parseShare(NaN).value === null);

// ── 3. A day with no share ───────────────────────────────────────────────────
section("3. A day with no share is dropped, not stored as 0");
const shareRaw = (id: string, date: string, m: Record<string, unknown>) => ({ campaign: { id, name: "Brand" }, segments: { date }, metrics: m });
const full = { search_impression_share: 0.5, search_budget_lost_impression_share: 0.31, search_rank_lost_impression_share: 0.12, search_top_impression_share: 0.4, search_absolute_top_impression_share: 0.2 };
let rows = buildShareRows([
  shareRaw("9", "2026-10-01", full),
  shareRaw("9", "2026-10-02", {}),
  shareRaw("9", "2026-10-03", { search_impression_share: null, search_budget_lost_impression_share: "--" }),
  shareRaw("", "2026-10-04", full),
  shareRaw("9", "not a date", full),
  shareRaw("9", "2026-10-05", { search_budget_lost_impression_share: "< 10%" }),
]);
ok("only days where the platform gave at least one share are kept", rows.length === 2, `${rows.length} rows`);
ok("a row with no campaign or no real date is dropped", rows.every((r) => r.campaignId === "9" && /^\d{4}-\d{2}-\d{2}$/.test(r.date)));
ok("a share the platform did not give is null on a kept row", rows[1]!.shares.impression_share.value === null && rows[1]!.shares.budget_lost_share.bound === "lt");
ok("the five measures are all carried", SHARE_MEASURES.every((k) => rows[0]!.shares[k].value != null) && rows[0]!.shares.budget_lost_share.value === 0.31);
rows = buildShareRows([shareRaw("9", "2026-10-01", { search_impression_share: 0.3 }), shareRaw("9", "2026-10-01", { search_impression_share: 0.6 })]);
ok("a repeated campaign day is NOT summed (a share cannot be); one row stands", rows.length === 1 && rows[0]!.shares.impression_share.value === 0.6);

// ── 4. Quality ───────────────────────────────────────────────────────────────
section("4. Quality: score 1..10 else null, components decoded, a zero CPC is no estimate");
const qRaw = (crit: string, q: Record<string, unknown>, p: Record<string, unknown>) => ({
  campaign: { id: "9" }, ad_group: { id: "77" },
  ad_group_criterion: { criterion_id: crit, keyword: { text: `kw ${crit}`, match_type: 3 }, quality_info: q, position_estimates: p },
});
const q = buildQualityRows([
  qRaw("1", { quality_score: 4, search_predicted_ctr: 2, creative_quality_score: 3, post_click_quality_score: 4 }, { first_page_cpc_micros: 2_500_000, top_of_page_cpc_micros: 4_100_000 }),
  qRaw("2", { quality_score: 0, search_predicted_ctr: 0, creative_quality_score: 1, post_click_quality_score: null }, { first_page_cpc_micros: 0, top_of_page_cpc_micros: null }),
  qRaw("3", { quality_score: 11 }, {}),
  qRaw("4", {}, {}),
  { campaign: { id: "9" }, ad_group: { id: "77" }, ad_group_criterion: { keyword: { text: "no id" } } },
]);
ok("a keyword with no ids is dropped; the rest are kept, scored or not", q.length === 4, `${q.length} rows`);
const q1 = q.find((r) => r.criterionId === "1")!;
ok("the score is the integer", q1.qualityScore === 4);
ok("the components are decoded to below, average, above", q1.expectedCtr === "below" && q1.adRelevance === "average" && q1.landingPage === "above");
ok("cost estimates stay micros, verbatim", q1.firstPageCpcMicros === 2_500_000 && q1.topOfPageCpcMicros === 4_100_000);
const q2 = q.find((r) => r.criterionId === "2")!;
ok("a score of 0 is no score, and an UNSPECIFIED or UNKNOWN component is null", q2.qualityScore === null && q2.expectedCtr === null && q2.adRelevance === null && q2.landingPage === null);
ok("a CPC of 0 or none is no estimate, never a free click", q2.firstPageCpcMicros === null && q2.topOfPageCpcMicros === null);
ok("a score over 10 is refused", q.find((r) => r.criterionId === "3")!.qualityScore === null);
ok("an unscored keyword is kept with every field null so a reader can count it", q.find((r) => r.criterionId === "4")!.qualityScore === null);
ok("the entity id is the structure snapshot's own (`ag:<ad group>:<criterion>`)", q1.entityId === "ag:77:1");

// ── 5. Segments ──────────────────────────────────────────────────────────────
section("5. Segments: hour 0..23, device decoded, repeats summed, conversions evidenced");
const sRaw = (id: string, date: string, seg: Record<string, unknown>, m: Record<string, unknown>) => ({ campaign: { id }, segments: { date, ...seg }, metrics: m });
const hrs = buildSegmentRows([
  sRaw("9", "2026-10-01", { hour: 9 }, { impressions: 100, clicks: 10, cost_micros: 5_000_000, conversions: 1 }),
  sRaw("9", "2026-10-01", { hour: 9 }, { impressions: 50, clicks: 5, cost_micros: 1_000_000, conversions: 0 }),
  sRaw("9", "2026-10-01", { hour: 24 }, { impressions: 5 }),
  sRaw("9", "2026-10-01", { hour: "x" }, { impressions: 5 }),
  sRaw("9", "2026-10-01", { hour: 0 }, { impressions: 7 }),
  sRaw("", "2026-10-01", { hour: 3 }, { impressions: 7 }),
], "hour");
ok("a bad hour or a missing campaign is dropped", hrs.length === 2, `${hrs.length} rows`);
const h9 = hrs.find((r) => r.value === "9")!;
ok("a repeat of one campaign, day and hour is summed", h9.impressions === 150 && h9.clicks === 15 && h9.costMicros === 6_000_000 && h9.conversions === 1);
ok("hour 0 is a real hour", hrs.some((r) => r.value === "0"));
const noEvidence = buildSegmentRows([sRaw("9", "2026-10-01", { hour: 2 }, { impressions: 10, conversions: 0 })], "hour");
ok("conversions are null where nothing in the window shows they are counted", noEvidence[0]!.conversions === null);
const unseen: { field: string; raw: string }[] = [];
const dev = buildSegmentRows([
  sRaw("9", "2026-10-01", { device: 2 }, { impressions: 10 }), sRaw("9", "2026-10-01", { device: "DESKTOP" }, { impressions: 20 }),
  sRaw("9", "2026-10-01", { device: 0 }, { impressions: 5 }), sRaw("9", "2026-10-01", { device: 99 }, { impressions: 5 }),
], "device", unseen);
ok("devices decode to words, UNSPECIFIED is dropped, an unknown number is kept as UNRECOGNISED and named", dev.map((r) => r.value).sort().join() === "DESKTOP,MOBILE,UNRECOGNISED" && unseen.length === 1 && unseen[0]!.raw === "99");

// ── 6. Geography ─────────────────────────────────────────────────────────────
section("6. Geography: numeric ids and counts, nothing about a person");
const gRaw = (id: string, country: unknown, loc: unknown, tgt: unknown, m: Record<string, unknown>) => ({
  campaign: { id }, user_location_view: { country_criterion_id: country, targeting_location: tgt },
  segments: loc == null ? {} : { geo_target_most_specific_location: loc }, metrics: m,
});
const geo = buildGeoRows([
  gRaw("9", 2840, "geoTargetConstants/1023191", true, { impressions: 100, clicks: 9, cost_micros: 3_000_000, conversions: 2 }),
  gRaw("9", 2840, "geoTargetConstants/1023191", true, { impressions: 50, clicks: 1, cost_micros: 1_000_000, conversions: 0 }),
  gRaw("9", 2840, null, false, { impressions: 5 }),
  gRaw("9", "not a number", null, null, { impressions: 5 }),
  gRaw("9", 2124, "geoTargetConstants/9999", "yes", { impressions: 3 }),
]);
ok("a row with no numeric country is dropped", geo.length === 3, `${geo.length} rows`);
const g1 = geo.find((r) => r.locationId === "1023191")!;
ok("a place is the numeric id from the end of the resource name", g1.countryId === "2840" && g1.locationId === "1023191");
ok("a repeat of one campaign and place is summed", g1.impressions === 150 && g1.costMicros === 4_000_000 && g1.conversions === 2);
ok("a read with no finer place carries an empty location id, never a made-up one", geo.some((r) => r.locationId === "" && r.targetingLocation === false));
ok("a targeting flag the platform did not give as a boolean is null", geo.find((r) => r.countryId === "2124")!.targetingLocation === null);
ok("nothing in a geo row can hold a name", Object.keys(geo[0]!).every((k) => !/name|text|email|phone/i.test(k)));

// ── 7. Windows ───────────────────────────────────────────────────────────────
section("7. The windows: 60 days first, 14 after, in slices; 30 for window parts");
const TODAY = "2026-11-10";
const first = dayWindow(TODAY, true);
const later = dayWindow(TODAY, false);
ok("the first read is 60 days ending yesterday (UTC)", first.end === "2026-11-09" && daysBetween(first.start, first.end) === 59);
ok("every later read is the last 14 days", later.end === "2026-11-09" && daysBetween(later.start, later.end) === 13);
ok("--days overrides, and is capped at 400", daysBetween(dayWindow(TODAY, false, 9999).start, "2026-11-09") === 399);
const wy = windowEndingYesterday(TODAY);
ok("a window part is the 30 days ending yesterday", wy.end === "2026-11-09" && daysBetween(wy.start, wy.end) === WINDOW_DAYS - 1);
const slices = sliceWindow(first);
ok("a 60 day window is cut into slices of at most 14 days", slices.length === 5 && slices.every((s) => daysBetween(s.start, s.end) + 1 <= SLICE_DAYS));
ok("the slices start where the window starts and end where it ends", slices[0]!.start === first.start && slices.at(-1)!.end === first.end);
ok("the slices cover every day exactly once, with no overlap and no gap", slices.every((s, i) => i === 0 || daysBetween(slices[i - 1]!.end, s.start) === 1));
ok("a 14 day window is one slice", sliceWindow(later).length === 1);
ok("a one day window is one slice of one day", JSON.stringify(sliceWindow({ start: "2026-11-09", end: "2026-11-09" })) === JSON.stringify([{ start: "2026-11-09", end: "2026-11-09" }]));
ok("the placeholders are filled with the slice's own dates", fillWindow(SHARE_DAYS_GAQL, slices[1]!).includes(slices[1]!.start) && !fillWindow(SHARE_DAYS_GAQL, slices[1]!).includes("{{"));
ok("three parts are day parts and two are window parts", DAY_PARTS.length === 3 && PARTS.length === 5);

// ── 8. The job ───────────────────────────────────────────────────────────────
section("8. The job: ceiling, failure rows, independent parts, the geo fallback");
const job = codeOnly(read("ads-share-reads.ts"));
ok("a read at the row ceiling throws before anything is written (per slice for a day part)", /length >= MAX_ROWS/.test(job) && /nothing was written/.test(job));
ok("the ceiling is checked for every one of the three kinds of read", (job.match(/>= MAX_ROWS/g) ?? []).length >= 3);
ok("a day part reads in slices", /sliceWindow\(window\)/.test(job));
ok("each part has its own try, so one failing query does not take the others down", /for \(const part of PARTS/.test(job) && /catch \(e\)[\s\S]*?recordShareFailure/.test(job));
ok("an account that cannot be opened records a failure for every part", /for \(const p of PARTS\) await recordShareFailure/.test(job));
ok("the finer place is the optional part: a refusal falls back to country only and says so", /GEO_GAQL_COUNTRY_ONLY/.test(job) && /finer places not read/.test(job));
ok("a dry run writes nothing", (job.match(/if \(!dryRun\)/g) ?? []).length >= 4 && /Dry run complete — nothing written/.test(job));
ok("every account failing is a failed run, not a green one that read nothing", /if \(read === 0\) process\.exit\(1\)/.test(job));
ok("the job's note is its own counts", /formatJobSummary\(\s*\{ accounts: targets\.length/.test(job));
ok("a first-ever failure is dated and covers nothing; a later one keeps the span", /covered_from, covered_to/.test(read("ads/share-reads.ts")) && /ON CONFLICT \(platform, account_id, part\) DO UPDATE SET last_scan_at = now\(\), ok = false/.test(read("ads/share-reads.ts")));

// ── 9. The workflow ──────────────────────────────────────────────────────────
section("9. The workflow");
const wf = readFileSync(join(here, "..", ".github", "workflows", "ads-share-reads.yml"), "utf8");
ok("it is scheduled", /schedule:\s*\n\s*(?:#[^\n]*\n\s*)*- cron:/.test(wf));
ok("it can be dispatched with no inputs", /workflow_dispatch:/.test(wf) && !/required:\s*true/.test(wf));
ok("a hand-started run is a dry run unless told otherwise", /dry_run:[\s\S]*?default:\s*"true"/.test(wf));
ok("the heartbeat is `if: always()` and skipped for a dry run and a one-client run", /if: always\(\) && inputs\.dry_run != 'true' && inputs\.client == ''/.test(wf));
ok("the heartbeat names the job the dashboard judges", /--job=ads_share_reads/.test(wf));
ok("inputs go through the environment, never into the command line", /IN_CLIENT: \$\{\{ inputs\.client \}\}/.test(wf) && !/run:[^\n]*\$\{\{ inputs\./.test(wf));
ok("the workflow does not call a mutate", !/mutate/i.test(wf));

// ── 10. The real store ───────────────────────────────────────────────────────
const dbUrl = process.env.ADS_VERIFY_DATABASE_URL;
if (!dbUrl) {
  section("10. The real store functions");
  console.log("  ⏭  skipped: ADS_VERIFY_DATABASE_URL is not set. Locally: `node scripts/test-db.mjs start` in the dashboard repo prints a URL.");
  console.log("     CI runs this section in the `ads-store` job against a Postgres service container.");
} else {
  await storeSection(dbUrl);
}

async function storeSection(url: string) {
  section("10. The real store, on a throwaway schema");
  const schema = `ads_share_${Math.random().toString(36).slice(2, 10)}`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const one = async (sql: string, args: unknown[] = []) => (await c.query(sql, args)).rows[0] as any;
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await ensureShareTables(c);
    await ensureShareTables(c);
    ok("the tables are created, twice, without error", true);
    const ACCT = "1112223334";
    const win = { start: "2026-10-27", end: "2026-11-09" };

    // share days
    const shareRows = buildShareRows([
      shareRaw("9", "2026-11-08", { search_impression_share: 0.42, search_budget_lost_impression_share: "< 10%", search_rank_lost_impression_share: 0.2 }),
      shareRaw("9", "2026-11-09", { search_impression_share: 0.5 }),
    ]);
    await storeShareDays(c, "CL", ACCT, shareRows, win, "test");
    ok("share rows are stored", (await one(`SELECT count(*) AS n FROM ads_share_days`)).n === "2");
    const d = await one(`SELECT * FROM ads_share_days WHERE metric_date='2026-11-08'`);
    ok("a bound is stored as the number the platform gave plus a flag, never a nought", d.budget_lost_share === 0.1 && d.budget_lost_share_bound === "lt");
    ok("a share the platform did not give is NULL in the table", (await one(`SELECT top_share FROM ads_share_days WHERE metric_date='2026-11-08'`)).top_share === null);
    ok("a plain figure carries no bound", d.impression_share === 0.42 && d.impression_share_bound === null);
    await storeShareDays(c, "CL", ACCT, buildShareRows([shareRaw("9", "2026-11-08", { search_impression_share: 0.44 })]), win, "again");
    ok("a re-read of a day restates it in place and adds no second row", (await one(`SELECT count(*) AS n FROM ads_share_days`)).n === "2" && (await one(`SELECT impression_share FROM ads_share_days WHERE metric_date='2026-11-08'`)).impression_share === 0.44);
    const sc = await one(`SELECT * FROM ads_share_scans WHERE part='share_days'`);
    ok("the scan row says how far the read reaches", sc.covered_from === win.start && sc.covered_to === win.end && sc.ok === true);
    await storeShareDays(c, "CL", ACCT, [], { start: "2026-11-15", end: "2026-11-20" }, "gap");
    ok("a read that starts after a gap restarts the coverage rather than claiming the days between", (await one(`SELECT covered_from FROM ads_share_scans WHERE part='share_days'`)).covered_from === "2026-11-15");

    // quality (replace whole)
    await storeKeywordQuality(c, "CL", ACCT, q, win);
    ok("quality rows are stored with nulls kept as NULL", (await one(`SELECT count(*) AS n FROM ads_keyword_quality`)).n === "4" && (await one(`SELECT quality_score FROM ads_keyword_quality WHERE criterion_id='4'`)).quality_score === null);
    ok("cost estimates are stored as micros", (await one(`SELECT first_page_cpc_micros FROM ads_keyword_quality WHERE criterion_id='1'`)).first_page_cpc_micros === "2500000");
    await storeKeywordQuality(c, "CL", ACCT, [q[0]!], win);
    ok("a re-read of the same window REPLACES it: a keyword no longer returned leaves no stale row", (await one(`SELECT count(*) AS n FROM ads_keyword_quality`)).n === "1");
    await storeKeywordQuality(c, "CL", ACCT, [q[0]!], { start: "2027-03-01", end: "2027-03-30" });
    ok("windows older than the retention are pruned", (await one(`SELECT count(*) AS n FROM ads_keyword_quality`)).n === "1");

    // segments
    await storeSegmentDays(c, "CL", ACCT, "hour", hrs, win, "h");
    await storeSegmentDays(c, "CL", ACCT, "device", dev, win, "d");
    ok("hour and device rows live in one table apart by kind", (await one(`SELECT count(*) AS n FROM ads_segment_days WHERE segment_kind='hour'`)).n === "2" && (await one(`SELECT count(*) AS n FROM ads_segment_days WHERE segment_kind='device'`)).n === "3");
    ok("the two segment parts have their own scan rows", (await one(`SELECT count(*) AS n FROM ads_share_scans WHERE part IN ('segment_hours','segment_devices')`)).n === "2");
    await storeSegmentDays(c, "CL", ACCT, "hour", [{ ...hrs[0]!, impressions: 999 }], win, "h2");
    ok("a re-read hour restates in place", (await one(`SELECT impressions FROM ads_segment_days WHERE segment_kind='hour' AND segment_value='${hrs[0]!.value}'`)).impressions === "999" && (await one(`SELECT count(*) AS n FROM ads_segment_days WHERE segment_kind='hour'`)).n === "2");

    // geo
    await storeGeo(c, "CL", ACCT, geo, win);
    ok("geo rows are stored, an empty place as an empty string", (await one(`SELECT count(*) AS n FROM ads_geo_windows`)).n === "3" && (await one(`SELECT count(*) AS n FROM ads_geo_windows WHERE location_id=''`)).n === "1");
    await storeGeo(c, "CL", ACCT, [geo[0]!], win);
    ok("a re-read of the same window REPLACES it", (await one(`SELECT count(*) AS n FROM ads_geo_windows`)).n === "1");

    // failure
    await recordShareFailure(c, "CL", ACCT, "keyword_quality", "2026-11-10", "auth expired");
    const f = await one(`SELECT ok, note FROM ads_share_scans WHERE part='keyword_quality'`);
    ok("a failure marks only its own part not ok and says why", f.ok === false && /auth expired/.test(f.note) && (await one(`SELECT ok FROM ads_share_scans WHERE part='geo'`)).ok === true);
    ok("a failure leaves the earlier rows alone", (await one(`SELECT count(*) AS n FROM ads_keyword_quality`)).n === "1");
    await recordShareFailure(c, "CL", "9998887776", "share_days", "2026-11-10", "first ever");
    const nf = await one(`SELECT covered_from, covered_to FROM ads_share_scans WHERE account_id='9998887776'`);
    ok("a first-ever failure is dated and covers nothing (its span is empty)", nf.covered_from > nf.covered_to);
    ok("hasSpan reads that empty span as no coverage", (await loadPartCoverage(c, "9998887776", "share_days"))!.coveredFrom > (await loadPartCoverage(c, "9998887776", "share_days"))!.coveredTo);

    // rollback
    const before = (await one(`SELECT count(*) AS n FROM ads_segment_days`)).n;
    let threw = false;
    try {
      await storeSegmentDays(c, "CL", ACCT, "hour", [{ ...hrs[0]!, value: "5", campaignId: "5" }, { ...hrs[0]!, value: "6", campaignId: null as unknown as string }], win, "x");
    } catch { threw = true; }
    ok("a store that fails halfway rolls back whole", threw && (await one(`SELECT count(*) AS n FROM ads_segment_days`)).n === before);
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
}

// The lines the other checks are written against, pinned as literals so moving one fails here.
ok("the row ceiling is fifty thousand", MAX_ROWS === 50_000);
ok("the platform's under-ten sentinel is 0.0999 (unverified live)", UNDER_TEN_SENTINEL === 0.0999);
ok("every read of a list checks the ceiling: three day-part, keyword, geo reads", (job.match(/arr\.length >= MAX_ROWS\)/g) ?? []).length === 3, `found ${(job.match(/arr\.length >= MAX_ROWS\)/g) ?? []).length}`);

console.log("\n" + "─".repeat(72));
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");
// Kept so a lint pass sees the constant used: the ceiling is part of the proof above.
void MAX_ROWS;

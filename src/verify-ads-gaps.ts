#!/usr/bin/env tsx
/**
 * Ads data gaps: keyword metrics, ads and negatives in the structure snapshot,
 * conversion actions per campaign.
 *
 * Proves, over INVENTED rows (no ad account, no network, no credential):
 *
 *   1. it only READS: no platform write anywhere in the new code, every query a SELECT
 *   2. the structure snapshot's new kinds: normalised, decoded, nothing personal,
 *      and a FAILED dependent query drops the kind rather than storing it half-described
 *   3. ad-group negatives are already captured (as `keyword` rows, level ad_group)
 *   4. keyword metrics: window ends yesterday, micros, null versus zero, repeats summed
 *   5. conversion actions per campaign: value is account currency units, zero rows dropped
 *   6. the jobs: ceiling refuses to write, a failure is a row, completeness rules
 *   7. the workflow
 *   8. the real store, on a throwaway schema (when ADS_VERIFY_DATABASE_URL is set)
 *
 *   npm run verify-ads-gaps
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  ENTITY_KINDS, MAX_ASSETS_PER_AD, MAX_ASSET_CHARS,
  AD_GAQL, AD_LABEL_GAQL, ACCOUNT_NEGATIVE_GAQL, SHARED_SET_GAQL, CAMPAIGN_SHARED_SET_GAQL,
  SHARED_CRITERION_GAQL, CONVERSION_ACTION_GAQL, CAMPAIGN_CONVERSION_GOAL_GAQL,
  assembleAds, assembleSharedSets, normalizeAccountNegative, normalizeAd, normalizeAdGroupKeyword,
  normalizeCampaignConversionGoal, normalizeConversionAction, normalizeSharedNegative, parseAdGroupAdResource,
  entityHash, UNRECOGNISED_ENUM, type UnrecognisedEnum,
} from "./ads/structure-snapshot.js";
import {
  CONVERSION_ACTION_METRICS_GAQL, KEYWORD_METRICS_GAQL, MAX_ROWS, WINDOW_DAYS, buildConversionActionRows,
  buildKeywordRows, ensureKeywordMetricTables, keywordEntityId, metricsWindow, recordKeywordMetricFailure,
  storeConversionActionMetrics, storeKeywordMetrics, type KeywordMetricRow,
} from "./ads/keyword-metrics.js";

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
for (const f of ["ads/structure-snapshot.ts", "ads-structure-snapshot.ts", "ads/keyword-metrics.ts", "ads-keyword-metrics.ts"]) {
  const bad = writeWords(read(f));
  ok(`${f} names no platform write and no write to findings`, bad.length === 0, bad.join(" "));
}
const allGaql = [AD_GAQL, AD_LABEL_GAQL, ACCOUNT_NEGATIVE_GAQL, SHARED_SET_GAQL, CAMPAIGN_SHARED_SET_GAQL, SHARED_CRITERION_GAQL,
  CONVERSION_ACTION_GAQL, CAMPAIGN_CONVERSION_GOAL_GAQL, KEYWORD_METRICS_GAQL, CONVERSION_ACTION_METRICS_GAQL];
ok("every new query is a SELECT", allGaql.every((q) => /^\s*SELECT\b/i.test(q)));
ok("the write scan sees a planted mutate", writeWords("await customer.campaigns.mutate({})").length > 0);

// ── 2. The structure snapshot's new kinds ────────────────────────────────────
section("2. Structure snapshot: ads, account negatives, shared lists, conversions");
for (const k of ["ad", "account_negative", "shared_set", "shared_negative", "conversion_action", "campaign_conversion_goal"]) {
  ok(`ENTITY_KINDS includes ${k}`, (ENTITY_KINDS as readonly string[]).includes(k));
}
ok("responsive search ads only, removed ads left out", /RESPONSIVE_SEARCH_AD/.test(AD_GAQL) && /!= 'REMOVED'/.test(AD_GAQL));
ok("no per-asset performance rating is selected", !/performance_label|asset_performance|pinned_field/i.test(AD_GAQL));
ok("no tracking template or URL parameters are selected", !/tracking_url|url_custom_parameters|final_url_suffix/i.test(AD_GAQL));
ok("only keyword negative lists", /NEGATIVE_KEYWORDS/.test(SHARED_SET_GAQL));

const rep: UnrecognisedEnum[] = [];
const adRow = {
  ad_group_ad: {
    status: 2,
    ad: {
      id: 555,
      final_urls: ["https://example.test/a"],
      responsive_search_ad: {
        headlines: [{ text: "Brazing Services" }, { text: "  " }, { text: "Call Us" }],
        descriptions: [{ text: "We braze it." }],
        path1: "brazing", path2: null,
      },
    },
  },
  ad_group: { id: 77 }, campaign: { id: 9 },
};
const ad = normalizeAd(adRow, rep)!;
ok("an ad keys on its ad group and ad id", ad.entityId === "77~555" && ad.parentId === "77" && ad.campaignId === "9");
ok("headlines keep their order and drop a blank one", ad.attrs.headlines === JSON.stringify(["Brazing Services", "Call Us"]));
ok("the final url and descriptions are stored", ad.attrs.final_urls === JSON.stringify(["https://example.test/a"]) && ad.attrs.descriptions === JSON.stringify(["We braze it."]));
ok("status is decoded", ad.status === "ENABLED");
ok("an ad row with no ad group is dropped", normalizeAd({ ad_group_ad: { ad: { id: 1 } } }) === null);
const long = normalizeAd({ ...adRow, ad_group_ad: { ...adRow.ad_group_ad, ad: { ...adRow.ad_group_ad.ad, responsive_search_ad: { headlines: [{ text: "x".repeat(500) }], descriptions: [] } } } })!;
ok("an asset is cut at the safety ceiling", JSON.parse(String(long.attrs.headlines))[0].length === MAX_ASSET_CHARS);
const many = normalizeAd({ ...adRow, ad_group_ad: { ...adRow.ad_group_ad, ad: { ...adRow.ad_group_ad.ad, responsive_search_ad: { headlines: Array.from({ length: 40 }, (_, i) => ({ text: `h${i}` })), descriptions: [] } } } })!;
ok("an ad holds at most the platform's number of headlines", JSON.parse(String(many.attrs.headlines)).length === MAX_ASSETS_PER_AD);

ok("a label resource name parses to the ad key", parseAdGroupAdResource("customers/1/adGroupAds/77~555") === "77~555");
const labelled = assembleAds([ad], [{ ad_group_ad: { resource_name: "customers/1/adGroupAds/77~555" }, label: { name: "B" } }, { ad_group_ad: { resource_name: "customers/1/adGroupAds/77~555" }, label: { name: "A" } }]);
ok("labels attach, sorted", labelled[0]!.attrs.labels === JSON.stringify(["A", "B"]));
ok("no labels is a real answer: the ad is kept, labels null", assembleAds([ad], [])[0]?.attrs.labels === null && assembleAds([ad], []).length === 1);
ok("A FAILED LABEL QUERY DROPS THE ADS (never stored with null labels)", assembleAds([ad], null).length === 0);
const h1 = entityHash(labelled[0]!);
const h2 = entityHash(assembleAds([ad], [])[0]!);
ok("a label change is a change", h1 !== h2);

const acctNeg = normalizeAccountNegative({ customer_negative_criterion: { id: 12, keyword: { text: "free", match_type: 3 } } }, rep)!;
ok("an account negative is its own kind, phrase decoded", acctNeg.kind === "account_negative" && acctNeg.attrs.match_type === "PHRASE" && acctNeg.attrs.level === "account" && acctNeg.attrs.negative === true);
const sets = assembleSharedSets(
  [{ shared_set: { id: 30, name: "Junk list", status: 2 } }],
  [{ shared_set: { id: 30 }, campaign: { id: 9 } }, { shared_set: { id: 30 }, campaign: { id: 4 } }],
  rep,
);
ok("a shared list carries the campaigns it is attached to, sorted", sets.length === 1 && sets[0]!.attrs.campaign_ids === JSON.stringify(["4", "9"]) && sets[0]!.name === "Junk list");
ok("A FAILED ATTACHMENT QUERY DROPS THE SHARED LISTS", assembleSharedSets([{ shared_set: { id: 30 } }], null, rep).length === 0);
const sharedNeg = normalizeSharedNegative({ shared_set: { id: 30 }, shared_criterion: { criterion_id: 5, keyword: { text: "cheap", match_type: 2 } } }, rep)!;
ok("a shared negative keys on its list", sharedNeg.entityId === "ss:30:5" && sharedNeg.parentId === "30" && sharedNeg.attrs.match_type === "EXACT");
const ca = normalizeConversionAction({ conversion_action: { id: 8, name: "Form", status: 2, type: 8, category: 6, origin: 2, primary_for_goal: true, include_in_conversions_metric: true, counting_type: 3, value_settings: { default_value: 12.5, always_use_default_value: false } } }, rep)!;
ok("a conversion action decodes type, category and origin", ca.attrs.action_type === "WEBPAGE" && ca.attrs.category === "LEAD" && ca.attrs.origin === "WEBSITE");
ok("the default value is in account units and named so", ca.attrs.default_value_account_currency === 12.5 && !("default_value_micros" in ca.attrs));
ok("primary-for-goal is a boolean, absent stays null", ca.attrs.primary_for_goal === true && normalizeConversionAction({ conversion_action: { id: 9 } })!.attrs.primary_for_goal === null);
const goal = normalizeCampaignConversionGoal({ campaign: { id: 9 }, campaign_conversion_goal: { category: 6, origin: 2, biddable: false } }, rep)!;
ok("a campaign conversion goal keys on campaign, category and origin", goal.entityId === "9:LEAD:WEBSITE" && goal.attrs.biddable === false);
const unk = normalizeConversionAction({ conversion_action: { id: 1, type: 999 } }, rep)!;
ok("an unknown enum is UNRECOGNISED and named", unk.attrs.action_type === UNRECOGNISED_ENUM && rep.some((u) => u.field === "conversion_action.type" && u.raw === "999"));

// ── 3. Ad-group negatives are already in the snapshot ───────────────────────
section("3. Ad-group negatives");
const agNeg = normalizeAdGroupKeyword({ ad_group_criterion: { criterion_id: 4, negative: true, status: 2, keyword: { text: "diy", match_type: 3 } }, ad_group: { id: 77 }, campaign: { id: 9 } })!;
ok("an ad-group negative is a keyword row marked negative at the ad group level", agNeg.kind === "keyword" && agNeg.attrs.negative === true && agNeg.attrs.level === "ad_group");
ok("the ad-group query does not filter negatives out", !/negative\s*=\s*FALSE/i.test(read("ads/structure-snapshot.ts").split("AD_GROUP_KEYWORD_GAQL")[1]?.split("`;")[0] ?? "x"));

// ── 4. Keyword metrics ───────────────────────────────────────────────────────
section("4. Keyword metrics");
const w = metricsWindow("2026-11-02");
ok("the window ends yesterday", w.end === "2026-11-01", w.end);
ok(`the window is ${WINDOW_DAYS} days`, w.start === "2026-10-03", w.start);
ok("--days is bounded", metricsWindow("2026-11-02", 1000).start === "2026-08-04" && metricsWindow("2026-11-02", 0).start === "2026-11-01");
ok("the query leaves negatives and removed keywords out", /negative = FALSE/.test(KEYWORD_METRICS_GAQL) && /!= 'REMOVED'/.test(KEYWORD_METRICS_GAQL));
ok("the keyword query selects no search term text", !/search_term|search_query/i.test(KEYWORD_METRICS_GAQL));
const kwRaw = (id: number, imp: number, clicks: number, cost: number, conv: number) => ({
  campaign: { id: 9 }, ad_group: { id: 77 }, ad_group_criterion: { criterion_id: id, keyword: { text: `kw${id}`, match_type: 3 } },
  metrics: { impressions: imp, clicks, cost_micros: cost, conversions: conv },
});
const kw = buildKeywordRows([kwRaw(1, 1000, 50, 12_340_000, 2), kwRaw(2, 10, 0, 0, 0), kwRaw(1, 100, 5, 1_000_000, 1)]);
ok("a repeated keyword is summed", kw.length === 2 && kw[0]!.impressions === 1100 && kw[0]!.clicks === 55 && kw[0]!.conversions === 3);
ok("money stays in micros", kw[0]!.costMicros === 13_340_000);
ok("the entity id matches the snapshot's keyword id", kw[0]!.entityId === keywordEntityId("77", "1") && kw[0]!.entityId === "ag:77:1");
ok("match type decoded", kw[0]!.matchType === "PHRASE");
const none = buildKeywordRows([kwRaw(1, 1000, 50, 5_000_000, 0), kwRaw(2, 10, 0, 0, 0)]);
ok("conversions are NULL when nothing in the window shows they are counted", none.every((r) => r.conversions === null));
ok("a real zero stays zero once a conversion appeared", kw.find((r) => r.criterionId === "2")!.conversions === 0);
ok("a row with no ad group is dropped", buildKeywordRows([{ campaign: { id: 9 }, ad_group_criterion: { criterion_id: 3 } }]).length === 0);

// ── 5. Conversion actions per campaign ───────────────────────────────────────
section("5. Conversion actions per campaign");
ok("the query is segmented by conversion action", /segments\.conversion_action\b/.test(CONVERSION_ACTION_METRICS_GAQL) && /metrics\.conversions_value/.test(CONVERSION_ACTION_METRICS_GAQL));
const caRaw = (camp: number, action: string, conv: number, val: number, all = conv) => ({
  campaign: { id: camp }, segments: { conversion_action: `customers/1/conversionActions/${action}`, conversion_action_name: `A${action}` },
  metrics: { conversions: conv, conversions_value: val, all_conversions: all },
});
const car = buildConversionActionRows([caRaw(9, "8", 3, 90.5), caRaw(9, "8", 2, 10), caRaw(9, "5", 0, 0), caRaw(4, "8", 1, 0)]);
ok("a repeated campaign and action is summed", car.find((r) => r.campaignId === "9" && r.conversionActionId === "8")!.conversions === 5);
ok("the value is account currency units, never micros", car.find((r) => r.campaignId === "9" && r.conversionActionId === "8")!.conversionsValue === 100.5);
ok("a row where nothing counted is dropped", !car.some((r) => r.conversionActionId === "5"));
ok("the action id is the tail of the resource name", car.every((r) => /^\d+$/.test(r.conversionActionId)));

// ── 6. The jobs ──────────────────────────────────────────────────────────────
section("6. The jobs");
const snapJob = codeOnly(read("ads-structure-snapshot.ts"));
ok("a failed ad-label query drops the ad kind", /adLabels\.rows !== null/.test(snapJob) && /completeKinds\.push\("ad"\)/.test(snapJob));
ok("a failed attachment or set query drops the shared lists", /sets\.rows !== null && attach\.rows !== null/.test(snapJob));
for (const k of ["account_negative", "shared_negative", "conversion_action", "campaign_conversion_goal"]) {
  ok(`${k} is closed only when its own query came back whole`, new RegExp(`completeKinds\\.push\\("${k}"\\)`).test(snapJob));
}
ok("a dependent query at the ceiling counts as a failure", /MAX_ENTITIES_PER_KIND/.test(snapJob.split("async function readRaw")[1]?.split("async function readAccount")[0] ?? ""));
const kwJob = codeOnly(read("ads-keyword-metrics.ts"));
ok("the ceiling refuses to write", /list\.length >= MAX_ROWS/.test(kwJob) && /nothing was written/.test(kwJob));
ok("a failure is recorded, not silence", /recordKeywordMetricFailure/.test(kwJob));
ok("a dry run writes nothing", /if \(dryRun\) \{[^}]*continue/.test(kwJob) && /if \(!dryRun\) await recordKeywordMetricFailure/.test(kwJob));
ok("the ceiling is a real number", MAX_ROWS >= 10_000);
ok("each part is read on its own", /for \(const part of \["keywords", "conversion_actions"\]/.test(kwJob));

// ── 7. The workflow ──────────────────────────────────────────────────────────
section("7. The workflow");
const wf = readFileSync(join(here, "..", ".github/workflows/ads-keyword-metrics.yml"), "utf8");
ok("it is scheduled", /cron: "40 5 \* \* \*"/.test(wf));
ok("a dispatch defaults to a dry run", /dry_run:[\s\S]{0,200}default: "true"/.test(wf));
ok("a scheduled run is live (dry only when the input says true)", /\[ "\$IN_DRY" = "true" \]/.test(wf));
ok("inputs reach the command through the environment", /IN_CLIENT: \$\{\{ inputs\.client \}\}/.test(wf) && !/run:[^\n]*\$\{\{ inputs\./.test(wf));
ok("the heartbeat is recorded even when the job fails", /Heartbeat[\s\S]{0,80}if: always\(\)/.test(wf));
ok("a dry run and a scoped run do not stamp the book-wide heartbeat", /if: always\(\) && inputs\.dry_run != 'true' && inputs\.client == ''/.test(wf));
ok("the heartbeat names the job", /--job=ads_keyword_metrics/.test(wf));
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
  const schema = `ads_gaps_${Math.random().toString(36).slice(2, 10)}`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await ensureKeywordMetricTables(c);
    await ensureKeywordMetricTables(c);
    ok("the tables are created, twice, without error", true);
    const ACCT = "1112223334";
    const win = { start: "2026-10-03", end: "2026-11-01" };
    const mk = (i: number, imp: number, conv: number | null): KeywordMetricRow => ({
      campaignId: "9", adGroupId: "77", criterionId: String(i), entityId: keywordEntityId("77", String(i)), keywordText: `k${i}`,
      matchType: "PHRASE", impressions: imp, clicks: Math.round(imp / 10), costMicros: imp * 1000, conversions: conv,
    });
    await storeKeywordMetrics(c, "CL", ACCT, [mk(1, 1000, 2), mk(2, 50, null)], win);
    let n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_keyword_metrics`)).rows[0]!.n;
    ok("two keyword rows are stored", n === "2");
    const nul = (await c.query<{ conversions: number | null }>(`SELECT conversions FROM ads_keyword_metrics WHERE criterion_id='2'`)).rows[0]!;
    ok("a null conversion is stored as NULL, not 0", nul.conversions === null);
    const big = (await c.query<{ cost_micros: string }>(`SELECT cost_micros FROM ads_keyword_metrics WHERE criterion_id='1'`)).rows[0]!;
    ok("money is stored as micros", big.cost_micros === "1000000");

    await storeKeywordMetrics(c, "CL", ACCT, [mk(1, 1200, 3)], win);
    n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_keyword_metrics`)).rows[0]!.n;
    ok("a re-read of the same window REPLACES it: a keyword no longer spending leaves no stale row", n === "1");
    const rest = (await c.query<{ conversions: number | null }>(`SELECT conversions FROM ads_keyword_metrics WHERE criterion_id='1'`)).rows[0]!;
    ok("a restated figure lands", rest.conversions === 3);

    await storeKeywordMetrics(c, "CL", ACCT, [mk(1, 900, 1)], { start: "2026-10-04", end: "2026-11-02" });
    n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_keyword_metrics`)).rows[0]!.n;
    ok("a later window is kept beside the earlier one", n === "2");
    await storeKeywordMetrics(c, "CL", ACCT, [mk(1, 800, 1)], { start: "2027-02-09", end: "2027-03-10" });
    n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_keyword_metrics WHERE account_id=$1`, [ACCT])).rows[0]!.n;
    ok("windows older than the retention are pruned", n === "1");

    await storeConversionActionMetrics(c, "CL", ACCT, buildConversionActionRows([caRaw(9, "8", 3, 90.5), caRaw(4, "8", 1, 0)]), win);
    const cn = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_campaign_conversion_actions`)).rows[0]!.n;
    ok("conversion action rows are stored", cn === "2");
    const val = (await c.query<{ conversions_value: number }>(`SELECT conversions_value FROM ads_campaign_conversion_actions WHERE campaign_id='9'`)).rows[0]!;
    ok("the value is stored in account units", val.conversions_value === 90.5);

    const scans = (await c.query<{ part: string; ok: boolean }>(`SELECT part, ok FROM ads_keyword_metric_scans WHERE account_id=$1 ORDER BY part`, [ACCT])).rows;
    ok("one scan row per account and part", scans.length === 2 && scans[0]!.part === "conversion_actions" && scans[1]!.part === "keywords");

    await recordKeywordMetricFailure(c, "CL", ACCT, "keywords", win, "auth expired");
    const after = (await c.query<{ part: string; ok: boolean; note: string }>(`SELECT part, ok, note FROM ads_keyword_metric_scans WHERE account_id=$1 ORDER BY part`, [ACCT])).rows;
    ok("a failure marks only its own part not ok", after[1]!.ok === false && after[0]!.ok === true);
    ok("the failure says why", /auth expired/.test(after[1]!.note));
    const kept = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_keyword_metrics WHERE account_id=$1`, [ACCT])).rows[0]!.n;
    ok("a failure leaves the earlier rows alone", kept === "1");

    const before = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_keyword_metrics`)).rows[0]!.n;
    let threw = false;
    try {
      await storeKeywordMetrics(c, "CL", ACCT, [mk(5, 1, 1), { ...mk(6, 1, 1), adGroupId: null as unknown as string }], { start: "2027-03-03", end: "2027-04-01" });
    } catch { threw = true; }
    const afterN = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ads_keyword_metrics`)).rows[0]!.n;
    ok("a store that fails halfway rolls back whole", threw && before === afterN);
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
}

console.log("\n" + "─".repeat(72));
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");

#!/usr/bin/env tsx
import "dotenv/config";
import { readFileSync } from "node:fs";
import { evaluate, THRESHOLDS, type AuditInput, type KeywordRow } from "./ads/rules.js";
import {
  queryPromotions, keywordCanServe, dormantBecause, keywordWhere, dormantLine,
  type ExistingKeyword,
} from "./ads/query-promotion.js";
import { keywordGaps } from "./ads/keyword-gap.js";

/**
 * THE PROPERTY: a claim about keyword coverage is true of the list behind it.
 *
 * ── WHAT WENT WRONG, AND WHY A SCRIPT ─────────────────────────────────────
 *
 * On 2026-09-23 a reviewer checked this engine's findings against a live
 * account by hand and found two faults with one cause. The adapter's keyword
 * pulls were filtered to what SPENT and to what SERVES, and the readings on top
 * of them treated those lists as the account's keywords:
 *
 *   1. `converting_search_term` told somebody to add a keyword the account
 *      already held — enabled, broad, verbatim the converting query — sitting
 *      in a PAUSED AD GROUP. Its own evidence line said it had checked every
 *      enabled keyword in the account. Acting on that finding creates the
 *      exact duplicate the whole reading exists to prevent.
 *   2. `low_quality_score` reported one keyword under the floor on an account
 *      holding three, because the other two took no clicks in the window and
 *      the count read the performance pull.
 *
 * Neither is visible from a type, a compile or a live log. Both come back the
 * moment somebody adds a WHERE clause for a reason that looks good in
 * isolation, which is why the guard is a script and why every check here is
 * paired with a PLANTED FAILURE: the fix is reverted in a copy of the fixture,
 * or in a copy of the source, and the check has to fail. A check that passes
 * against its own planting is not a check.
 *
 * ── WHAT IS NOT IN HERE ───────────────────────────────────────────────────
 *
 * No network, no database, no ad account, no credential. EVERY FIGURE BELOW IS
 * AN INVENTED FIXTURE. The reviewer's account gave the SHAPE and none of its
 * text, spend or scores. Nothing prints a customer id or an account number.
 *
 *   npm run verify-ads-keyword-coverage
 */

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
/** A planting that does not fail is a check with nothing behind it. */
const planted = (label: string, brokeIt: boolean, detail = "") =>
  ok(`   ⟲ PLANTED: ${label}`, brokeIt, detail);

// ── Fixture ──────────────────────────────────────────────────────────────────
// SYNTHETIC. One campaign, one converting query per case, and a keyword list
// holding a live keyword, a keyword in a paused ad group, a keyword in a paused
// campaign and a keyword nobody has scored yet.
const LIVE: ExistingKeyword = {
  text: "best service provider", matchType: "PHRASE", adGroupName: "Core", campaignName: "Search — Core",
  criterionResourceName: "customers/1/adGroupCriteria/10~1",
  criterionStatus: "ENABLED", adGroupStatus: "ENABLED", campaignStatus: "ENABLED", qualityScore: 3,
};
/** THE REPORTED CASE. Enabled, broad, verbatim the query — ad group paused. */
const IN_PAUSED_GROUP: ExistingKeyword = {
  text: "same day service booking", matchType: "BROAD", adGroupName: "Weekend Push", campaignName: "Search — Core",
  criterionResourceName: "customers/1/adGroupCriteria/11~1",
  criterionStatus: "ENABLED", adGroupStatus: "PAUSED", campaignStatus: "ENABLED", qualityScore: 1,
};
const IN_PAUSED_CAMPAIGN: ExistingKeyword = {
  text: "weekend service call", matchType: "PHRASE", adGroupName: "Retired", campaignName: "Search — Retired",
  criterionResourceName: "customers/1/adGroupCriteria/12~1",
  criterionStatus: "ENABLED", adGroupStatus: "ENABLED", campaignStatus: "PAUSED", qualityScore: 1,
};
/** Live, under the floor, and it took no clicks — so no performance row holds
 *  it. This is the keyword the old quality-score count could not see. */
const LIVE_UNSPENT: ExistingKeyword = {
  text: "emergency service", matchType: "EXACT", adGroupName: "Core", campaignName: "Search — Core",
  criterionResourceName: "customers/1/adGroupCriteria/10~2",
  criterionStatus: "ENABLED", adGroupStatus: "ENABLED", campaignStatus: "ENABLED", qualityScore: 2,
};
/** Live and never served, so Google reports no score. Unanswered, not nought. */
const LIVE_UNSCORED: ExistingKeyword = {
  text: "service quote today", matchType: "PHRASE", adGroupName: "Core", campaignName: "Search — Core",
  criterionResourceName: "customers/1/adGroupCriteria/10~3",
  criterionStatus: "ENABLED", adGroupStatus: "ENABLED", campaignStatus: "ENABLED", qualityScore: null,
};
const HELD = [LIVE, IN_PAUSED_GROUP, IN_PAUSED_CAMPAIGN, LIVE_UNSPENT, LIVE_UNSCORED];

/** What the PERFORMANCE pull holds: only the keyword that spent. */
const SPENT: KeywordRow[] = [{
  criterionResourceName: LIVE.criterionResourceName!, text: LIVE.text, matchType: "PHRASE",
  qualityScore: 3, campaignId: "100", campaignName: "Search — Core", adGroupName: "Core",
  costMicros: 90_000_000, clicks: 60, conversions: 0, finalUrls: [],
}];

const TERMS = [
  // Converts, over both floors, and the account holds no keyword for it.
  { term: "emergency service downtown", campaignId: "100", campaignName: "Search — Core", adGroupName: "Core",
    costMicros: 96_000_000, clicks: 40, conversions: 4, allConversions: 4 },
  // Converts, over both floors — and the account holds it, in a paused group.
  { term: "same day service booking", campaignId: "100", campaignName: "Search — Core", adGroupName: "Core",
    costMicros: 52_000_000, clicks: 28, conversions: 3, allConversions: 3 },
  // Converts, over both floors — and the account holds it, live. Nothing to do.
  { term: "Best Service Provider", campaignId: "100", campaignName: "Search — Core", adGroupName: "Core",
    costMicros: 70_000_000, clicks: 45, conversions: 5, allConversions: 5 },
];

const promote = (held: ExistingKeyword[] | null) => queryPromotions({
  terms: TERMS, existingKeywords: held, columnCountsOutcomes: "yes", protectedPatterns: [],
});
const proposedBy = (held: ExistingKeyword[] | null) =>
  promote(held).byCampaign.flatMap((c) => c.queries.map((q) => q.term.toLowerCase()));

/** The adapter's old filter, applied to the list — i.e. the bug, reverted. */
const asIfNarrowed = (held: ExistingKeyword[]) => held.filter((k) => keywordCanServe(k) === "yes");

function main() {
  console.log(`\n${"═".repeat(72)}`);
  console.log("Keyword coverage: what a claim about the keyword list is true of");
  console.log(`${"═".repeat(72)}`);
  console.log("Every figure below is an invented fixture. No ad account and no database was read.\n");

  // ── 1. The dedupe sees a keyword in a paused ad group ─────────────────────
  console.log("1. THE REPORTED FAILURE: a keyword in a paused ad group");
  ok("a query whose keyword sits in a paused ad group is NEVER proposed as a new one",
    !proposedBy(HELD).includes("same day service booking"),
    "acting on that recommendation creates the duplicate this reading exists to prevent");
  planted("the old narrowed list — the dedupe proposes the duplicate again",
    asIfNarrowed(HELD).every((k) => k.text !== IN_PAUSED_GROUP.text)
    && proposedBy(asIfNarrowed(HELD)).includes("same day service booking"),
    "filtering the list to what serves is the whole cause, restated");

  ok("…and a query whose keyword sits in a paused CAMPAIGN is refused too",
    keywordCanServe(IN_PAUSED_CAMPAIGN) === "no",
    "a second copy beside a paused one becomes a live duplicate the day anybody turns the paused one back on");
  planted("a paused campaign read as able to serve",
    keywordCanServe({ ...IN_PAUSED_CAMPAIGN, campaignStatus: "ENABLED" }) === "yes");

  ok("a status the platform did not report reads as unknown, never as enabled",
    keywordCanServe({ text: "x", matchType: null, adGroupName: null, campaignName: null }) === "unknown",
    "an unread status must not make this rule confident about which kind of match it found");
  planted("an absent status defaulted to enabled",
    keywordCanServe({ ...IN_PAUSED_GROUP, adGroupStatus: undefined }) === "unknown",
    "with the paused level missing there is nothing left saying it cannot serve");

  ok("a match nobody could read the status of is refused like any other",
    !proposedBy([{ ...IN_PAUSED_GROUP, criterionStatus: null, adGroupStatus: null, campaignStatus: null }])
      .includes("same day service booking")
    && promote([{ ...IN_PAUSED_GROUP, criterionStatus: null, adGroupStatus: null, campaignStatus: null }])
      .alreadyStateUnread === 1,
    "a keyword nobody could confirm is off is not a keyword to duplicate");

  // ── 2. …and it is not filed away as a live duplicate ──────────────────────
  console.log("\n2. A switched-off keyword is work, not a closed question");
  const run = promote(HELD);
  ok("the two kinds of match are counted apart",
    run.alreadyServing === 1 && run.dormant.length === 1 && run.alreadyKeywords === 2,
    "a live duplicate means there is nothing to do; a switched-off one means a decision was made and turned off");
  ok("…and the row names where the keyword sits and which level is off",
    /Weekend Push/.test(dormantLine(run.dormant) ?? "") && /ad group is paused/.test(dormantLine(run.dormant) ?? ""),
    "somebody has to find it before they can turn it back on");
  ok("…and says the work is turning it back on rather than adding another",
    /turning the existing keyword back on/i.test(dormantLine(run.dormant) ?? "")
    && !/\badd(ing)? (it|this|a keyword)\b/i.test((dormantLine(run.dormant) ?? "").replace(/Adding a second copy[^.]*\./, "")),
    "the reviewer's own reading: reactivate the ad group or move the keyword");
  planted("dormant matches folded back into the live-duplicate count",
    dormantLine([]) === null,
    "with nothing carried, there is no sentence and the finding goes back to silence");

  {
    const onlyDormant = queryPromotions({
      terms: TERMS.filter((t) => t.term === "same day service booking"),
      existingKeywords: HELD, columnCountsOutcomes: "yes", protectedPatterns: [],
    });
    ok("with nothing new to propose, the silence names the switched-off keyword",
      onlyDormant.verdict === "none" && /cannot serve/.test(onlyDormant.silence ?? ""),
      "'already a keyword, so there is nothing to add' was true of a live duplicate and false of this");
    planted("the old blanket silence sentence",
      !/cannot serve/.test("Every query over the floors is already in the account as a keyword, so there is nothing to add."),
      "it closes a reading that still has work in it");
  }

  ok("dormantBecause names the level and nothing else",
    dormantBecause(IN_PAUSED_GROUP) === "its ad group is paused"
    && dormantBecause(IN_PAUSED_CAMPAIGN) === "its campaign is paused"
    && dormantBecause(LIVE) === null);
  ok("…and keywordWhere never invents a placement it was not given",
    /an ad group this run could not name/.test(keywordWhere({ text: "x", matchType: null, adGroupName: null, campaignName: null })),
    "a null is unanswered, never a name");

  // ── 3. An unread list still refuses rather than guessing ──────────────────
  console.log("\n3. An unread keyword list");
  ok("a list that could not be read proposes nothing at all",
    promote(null).verdict === "keywords_unread" && proposedBy(null).length === 0,
    "a query cannot be called a gap in a list nobody could see");
  planted("an unread list read as an empty account",
    proposedBy([]).length === 3,
    "null in must mean null out, or a failed read reads as an account with no keywords in it");

  // ── 4. Quality score counts what it measured ──────────────────────────────
  console.log("\n4. Quality score: the count and what it was counted over");
  const base: AuditInput = {
    platform: "google_ads", accountId: "1", windowStart: "2026-06-13", windowEnd: "2026-09-10",
    campaigns: [{
      id: "100", name: "Search — Core", channelType: "SEARCH", resourceName: null,
      bidStrategyType: "MANUAL_CPC", hasBidTarget: false,
      dailyBudgetMicros: 80_000_000, budgetResourceName: null,
      costMicros: 900_000_000, clicks: 400, impressions: 20_000, conversions: 12,
      impressionShare: 0.5, budgetLostShare: 0.02, rankLostShare: 0.10,
    }],
    searchTerms: TERMS, keywords: SPENT, ads: [],
    existingNegatives: new Set<string>(), protectedPatterns: [],
    existingKeywords: HELD, economics: null,
    // The promotion rule refuses outright where the conversion column is not
    // counting business outcomes, so without this every check in section 7
    // would pass against a row that was never raised.
    tracking: {
      status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
      actions: [{
        id: "500", name: "Contact form", status: "ENABLED", category: "SUBMIT_LEAD_FORM",
        actionType: "WEBPAGE", primaryForGoal: true, countsIntoConversionsColumn: true,
        conversionsInWindow: 40, defaultValue: null, alwaysUseDefaultValue: null,
      }],
    },
  };
  const qsOf = (i: AuditInput) => evaluate(i).find((f) => f.findingType === "low_quality_score");
  const qs = qsOf(base);
  const qsLines = qs?.evidence.lines.join("\n") ?? "";

  ok(`the count is every SERVING keyword under QS ${THRESHOLDS.qualityScoreFloor}, spending or not`,
    qs?.evidence.metrics.keywordCount === 2 && /emergency service/.test(qsLines),
    "one spent and one did not; the one that did not is what the old reading lost");
  planted("the count taken over the performance pull again",
    (qsOf({ ...base, existingKeywords: null })?.evidence.metrics.keywordCount ?? 0) === 1,
    "three keywords under the floor reported as one is exactly the reviewer's second fault");

  ok("a keyword that cannot serve is left out",
    !/weekend service call/.test(qsLines) && !/Weekend Push/.test(qsLines),
    "it takes no clicks, so no relevance premium is charged on it");
  planted("non-serving keywords counted",
    HELD.filter((k) => (k.qualityScore ?? 0) > 0 && (k.qualityScore as number) < THRESHOLDS.qualityScoreFloor).length === 4,
    "counting everything held gives 4 where 2 is the answer");

  ok("a keyword with no score is left out and NAMED, never counted as nought",
    qs?.evidence.metrics.withoutAScore === 1 && /carr(y|ies) no quality score yet/.test(qsLines),
    "Google reports no score until a keyword has served enough to earn one");
  planted("a null score read as a nought below the floor",
    HELD.filter((k) => keywordCanServe(k) === "yes" && (k.qualityScore ?? 0) < THRESHOLDS.qualityScoreFloor).length === 3,
    "the unscored keyword joins the count and every new keyword reads as the worst possible relevance");

  ok("THE COUNT CARRIES WHAT IT WAS COUNTED OVER",
    typeof qs?.evidence.metrics.keywordsRead === "number"
    && /no spend filter and no row limit/.test(qsLines),
    "a figure carries its basis or it is not printed");
  ok("…and a keyword with no spend prints no spend rather than a nought",
    /no spend recorded in this window/.test(qsLines) && !/\$0\.00/.test(qsLines),
    "a nought here would read as a keyword that served for free");
  planted("a missing spend printed as $0.00",
    `${(0 / 1_000_000).toFixed(2)}` === "0.00",
    "the join misses, the figure defaults, and the row reports a cost nobody measured");

  // ── 5. The fallback is announced ──────────────────────────────────────────
  console.log("\n5. With no keyword list, the fallback says so");
  const fb = qsOf({ ...base, existingKeywords: null });
  ok("the title stops claiming a total it did not measure",
    /^At least /.test(fb?.title ?? ""),
    "the reading is still worth having; a total it did not measure is not");
  ok("…and the basis says what it fell back to",
    /floor rather than a total/.test(fb?.evidence.lines.join("\n") ?? "")
    && /floor rather than a total/.test(fb?.impactAssumption ?? ""),
    "announce every fallback; never take one silently");
  planted("the fallback title written as a total",
    !/^At least /.test(`${2} keyword(s) carry a quality score below 5`),
    "the same sentence with the hedge removed is the overstatement this guards");

  // ── 6. keyword_gap keeps its own narrowing ────────────────────────────────
  // The widened list is SHARED, so widening it without scoping this reading
  // would have made a paused keyword suppress a real gap — the opposite fault,
  // introduced by the fix for the first one.
  console.log("\n6. The gap reading still treats only what serves as covering");
  const gapInput = {
    research: { keywords: [{ keyword: "same day service booking", volume: 900, cpcCents: 400, difficulty: 30, intent: null, clientRank: null, competitorRank: null }], ranAt: "2026-09-01", location: null, seeds: ["service"] },
    services: { services: [{ name: "service booking" }], confirmedBy: "a named person", confirmedAt: "2026-09-01" },
    existingKeywords: HELD,
    seenTerms: [], existingNegatives: new Set<string>(), provenQueries: [],
    protectedPatterns: [], accountTermCoverage: 0.9,
  } as any;
  const gap = keywordGaps(gapInput);
  ok("a term the account holds only in a paused ad group is still a gap",
    gap.verdict === "found" && gap.alreadyCovered === 0,
    "nobody is bidding through a paused keyword, which is exactly what the row claims");
  planted("the widened list used unscoped, so a paused keyword covers the demand",
    keywordGaps({ ...gapInput, existingKeywords: HELD.map((k) => ({ ...k, adGroupStatus: "ENABLED", campaignStatus: "ENABLED" })) }).alreadyCovered === 1,
    "the fix for the dedupe silently suppressing a real gap is the fault this catches");

  // ── 7. Every sentence about coverage is true of its list ──────────────────
  console.log("\n7. The sentences");
  const promoRow = evaluate(base).find((f) => f.findingType === "converting_search_term");
  const promoLines = promoRow?.evidence.lines.join("\n") ?? "";
  ok("the promotion guard says what it checked, including the paused levels",
    /every keyword the account holds that has not been removed/i.test(promoLines)
    && /paused ad groups and paused campaigns included/i.test(promoLines),
    "a guard that overstates what it checked is worse than none, because somebody acts on it");
  planted("the old sentence, which claimed every enabled keyword",
    !/paused/i.test("Checked against every enabled keyword in the account, matched on letters and digits only, so case and punctuation cannot hide a duplicate."),
    "it was false of a list filtered to enabled ad groups in enabled campaigns");
  // The sentence has to reach the ROW, not only exist. Asserting the helper
  // alone passes while the row that goes to a person carries nothing, which is
  // the same shape of gap as a guard nothing invokes.
  ok("…and the switched-off keyword is named ON THE ROW, not only in the helper",
    /cannot serve/.test(promoLines) && /Weekend Push/.test(promoLines)
    && /turning the existing keyword back on/i.test(promoLines),
    "a sentence nobody renders is a sentence nobody reads");
  ok("…and it names the narrowing that is left",
    /close variant/i.test(promoLines) && /plural/i.test(promoLines),
    "the match is on the text as written, so a plural of an existing keyword can still reach the list");
  ok("no sentence about coverage still claims every ENABLED keyword",
    !/every enabled keyword in the account/i.test(promoLines + gap.services.map((s: any) => s.lines.join("\n")).join("\n")));

  // ── 8. The query behind all of it ─────────────────────────────────────────
  // The readings above are only as true as the pull under them, and the pull is
  // a string. This reads the source, so a WHERE clause added back for a reason
  // that looks good in isolation fails here rather than on a client's account.
  console.log("\n8. The pull the claims rest on");
  const adapter = readFileSync(new URL("./ads/google-ads-adapter.ts", import.meta.url), "utf8");
  const listQuery = adapter.slice(adapter.indexOf('tryQuery(customer, "keyword list"'));
  const listBlock = listQuery.slice(0, listQuery.indexOf("`, log)"));
  ok("the keyword-list pull does not filter to enabled ad groups or campaigns",
    !/ad_group\.status\s*=\s*'ENABLED'/.test(listBlock) && !/campaign\.status\s*=\s*'ENABLED'/.test(listBlock),
    "this exact pair of clauses is the cause of both reported faults");
  planted("the two clauses put back",
    /ad_group\.status\s*=\s*'ENABLED'/.test(`${listBlock}\n AND ad_group.status = 'ENABLED'`));
  ok("…and it does keep REMOVED out at all three levels",
    (listBlock.match(/IN \('ENABLED', 'PAUSED'\)/g) ?? []).length === 3,
    "a removed criterion cannot be turned back on, so creating the keyword again is the right thing to do");
  ok("…and it carries the three statuses and the score the readings decide on",
    /ad_group_criterion\.status/.test(listBlock) && /ad_group\.status/.test(listBlock)
    && /campaign\.status/.test(listBlock) && /quality_info\.quality_score/.test(listBlock)
    && /ad_group_criterion\.resource_name/.test(listBlock),
    "the join key is the resource name, never the keyword's text");
  ok("…and it takes no date segment and no row limit",
    !/segments\.date/.test(listBlock) && !/LIMIT/.test(listBlock),
    "what the account HOLDS is read whole; only what it SPENT is cut");
  ok("every query in the adapter's keyword reads is a SELECT",
    !/\b(INSERT|UPDATE|DELETE|MUTATE)\b/i.test(listBlock),
    "read-only, and nothing here is dispatched");

  console.log(`\n${"─".repeat(72)}`);
  console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
  console.log("Every figure above is an invented fixture. No ad account and no database was read.");
  console.log(`${"─".repeat(72)}\n`);
  if (failures) process.exit(1);
}

main();

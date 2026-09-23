#!/usr/bin/env tsx
import "dotenv/config";
import {
  evaluate, evidenceHash, materiallyChanged, trackingReading, costTargets, governingTarget,
  outcomeReadiness, MIN_MONTHLY_OUTCOMES_FOR_BIDDING,
  learningReading, platformSignals, PLATFORM_SIGNALS, LEARNING_EVENTS_CONVENTION,
  ADS_RULESET_VERSION, THRESHOLDS,
  type AuditInput, type TrackingFacts, type ClientEconomics, type AdSetRow, type CampaignRow,
} from "./ads/rules.js";
import { countMetaConversions } from "./ads/meta-adapter.js";
import {
  biddingReadiness, lagReading, onTargetStrategy, whatItWouldNeed,
  TARGET_STRATEGY_MIN_CONVERSIONS_30D, USEFUL_CONVERSION_LAG_DAYS,
  type ConversionLagRow,
} from "./ads/bidding-readiness.js";
import {
  spendVisibility, LOW_COVERAGE_SHARE, BARELY_COVERED_SHARE,
} from "./ads/spend-visibility.js";
import { ADVERTISING_CHANNEL_TYPE } from "./ads/google-ads-adapter.js";
import {
  findTrackingOutage, dataExclusionProposal, MAX_DATA_EXCLUSION_DAYS,
  type DailyConversionRow,
} from "./ads/tracking-outage.js";
import { proxyConversionValue } from "./ads/proxy-value.js";
import {
  queryPromotions, normalizeQueryText, keywordIndex, keywordCanServe, dormantBecause,
  PROMOTE_MIN_CONVERSIONS, PROMOTE_MIN_COST_MICROS,
} from "./ads/query-promotion.js";
import {
  headroomReading, HEADROOM_COMFORT_RATIO, HEADROOM_MIN_CONVERSIONS, HEADROOM_MIN_LOST_SHARE,
} from "./ads/headroom.js";
import { sequenceFindings, stageOf, FINDING_STAGE, DEFAULT_STAGE } from "./ads/sequence.js";
import {
  relevanceOf, termCoversService, relevanceLine, noServicesLine,
  MIN_SERVICE_TOKEN_LENGTH, type ClientServiceFacts,
} from "./ads/service-relevance.js";
import {
  keywordGaps, gapClaim, GAP_MIN_TERM_VOLUME, GAP_MIN_SERVICE_VOLUME, GAP_CLICK_RATE,
  type ResearchFacts,
} from "./ads/keyword-gap.js";
import { splitSeeds, skippedSeedsLine } from "./ads/service-seed.js";
import {
  trafficReadiness, isSiteRoot, CALL_TRACKING_PHONE_SHARE, CALL_TRACKING_MIN_LEADS,
} from "./ads/traffic-readiness.js";
import {
  rankImpact, rankBasisOf, rankedAmount, leadValueCents,
  RANK_BASIS, DEFAULT_RANK_BASIS,
} from "./ads/impact-rank.js";
import { refineNarrative } from "./ads/narrative.js";
import { applyChangeSet, rollbackChangeSet, type ChangeSet, type PriorValue } from "./apply-ads-changes.js";
import { enumName, CONVERSION_CATEGORY, TRACKING_STATUS, BIDDING_STRATEGY_TYPE, CONVERSION_LAG_BUCKET } from "./ads/google-ads-adapter.js";

/**
 * Verifies the ads findings pipeline WITHOUT touching a live ad account.
 *
 * This is a harness, not a live run: the account data is a synthetic fixture
 * shaped like a real search account, and the Google Ads client is a recorder
 * that answers queries from that fixture and refuses to let a mutate through
 * unless a validate_only for the same payload came first. That is what makes it
 * worth running — it proves the ORDER of operations and the guards, which is
 * exactly what you cannot prove by eyeballing a live log.
 *
 * What it checks:
 *   1. determinism — two runs over identical input produce byte-identical findings
 *   2. thresholds  — an item just under a floor produces nothing; just over, one finding
 *   3. memory      — the evidence hash buckets noise, so a dismissed finding is not
 *                    resurrected by spend drifting a few dollars, but IS re-raised
 *                    when the number genuinely moves
 *   4. the loop    — one finding walked propose → approve → validate_only → apply →
 *                    prior values → rollback, with every guard exercised
 *   5. guards      — protected-term collision, budget cap, and duplicate skipping
 *                    each refuse as designed
 *
 * For the LIVE read-only half, run `npm run ads-findings -- --dry-run` with real
 * credentials (or dispatch agent-readonly-run with script=ads-findings, which
 * forces --dry-run).
 *
 *   npm run verify-ads-findings
 */

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

// ── Fixture ──────────────────────────────────────────────────────────────────
// SYNTHETIC. Shaped like a real single-location search account — one campaign
// that converts and is budget-capped, one that spends without converting, a
// spread of search terms either side of the $25/90d waste floor, and a branded
// term that MUST be protected. No real client's numbers are in this file.
const FIXTURE: AuditInput = {
  platform: "google_ads",
  accountId: "1234567890",
  windowStart: "2026-06-13",
  windowEnd: "2026-09-10",
  campaigns: [
    {
      id: "100", name: "Search — Core Services", channelType: "SEARCH",
      // On a target-cost strategy at 36 conversions a month: over the
      // published minimum, so the bidding gate lets a budget step through.
      resourceName: "customers/1234567890/campaigns/100",
      bidStrategyType: "TARGET_CPA", hasBidTarget: true,
      dailyBudgetMicros: 80_000_000, budgetResourceName: "customers/1234567890/campaignBudgets/900",
      costMicros: 2_400_000_000, clicks: 1_180, impressions: 41_000, conversions: 36,
      impressionShare: 0.42, budgetLostShare: 0.31, rankLostShare: 0.27,
    },
    {
      id: "200", name: "Search — Broad Prospecting", channelType: "SEARCH",
      // Bidding manually, so no conversion floor applies to it at all.
      resourceName: "customers/1234567890/campaigns/200",
      bidStrategyType: "MANUAL_CPC", hasBidTarget: false,
      dailyBudgetMicros: 40_000_000, budgetResourceName: "customers/1234567890/campaignBudgets/901",
      costMicros: 910_000_000, clicks: 640, impressions: 88_000, conversions: 0,
      impressionShare: 0.19, budgetLostShare: 0.04, rankLostShare: 0.62,
    },
    // Converts, is not budget-capped, is not rank-limited, and every metric on
    // it reads healthy — and each of those four conversions costs $150 against
    // a $95 ceiling. This is the campaign the old engine had nothing to say
    // about: at identical impression-share numbers it looked like the one above
    // it that converts at $67.
    {
      id: "300", name: "Search — Competitor Conquest", channelType: "SEARCH",
      // Four conversions a month against a target-cost strategy: the shape
      // that has never had a name in this engine and is the OCH scar in
      // miniature — a model with a target to hit and nothing to hit it with.
      resourceName: "customers/1234567890/campaigns/300",
      bidStrategyType: "TARGET_CPA", hasBidTarget: true,
      dailyBudgetMicros: 30_000_000, budgetResourceName: "customers/1234567890/campaignBudgets/902",
      costMicros: 600_000_000, clicks: 300, impressions: 12_000, conversions: 4,
      impressionShare: 0.55, budgetLostShare: 0.02, rankLostShare: 0.11,
    },
    // THE GROWTH CASE. Converts 21 times a month at $40 against a $95 ceiling,
    // is not capped (5% lost to budget, under the budget rule's own floor), is
    // not rank-limited (33%, under the 40% that rule needs) — and gives away
    // more than a third of its impressions. Every metric on it reads healthy,
    // which is precisely why the engine had nothing to say about it.
    {
      id: "400", name: "Search — Service Areas", channelType: "SEARCH",
      resourceName: "customers/1234567890/campaigns/400",
      // Maximize Conversions with no target: no conversion floor applies, so
      // the bidding gate is not what is being tested here.
      bidStrategyType: "MAXIMIZE_CONVERSIONS", hasBidTarget: false,
      dailyBudgetMicros: 35_000_000, budgetResourceName: "customers/1234567890/campaignBudgets/903",
      costMicros: 840_000_000, clicks: 520, impressions: 19_000, conversions: 21,
      impressionShare: 0.54, budgetLostShare: 0.05, rankLostShare: 0.33,
    },
  ],
  searchTerms: [
    { term: "emergency service near me", campaignId: "200", campaignName: "Search — Broad Prospecting", adGroupName: "Broad", costMicros: 142_000_000, clicks: 96, conversions: 0, allConversions: 0 },
    { term: "free service advice", campaignId: "200", campaignName: "Search — Broad Prospecting", adGroupName: "Broad", costMicros: 88_000_000, clicks: 71, conversions: 0, allConversions: 0 },
    { term: "service jobs hiring", campaignId: "200", campaignName: "Search — Broad Prospecting", adGroupName: "Broad", costMicros: 61_000_000, clicks: 55, conversions: 0, allConversions: 0 },
    // Just UNDER the $25 floor — must not be flagged.
    { term: "cheap service quote", campaignId: "200", campaignName: "Search — Broad Prospecting", adGroupName: "Broad", costMicros: 24_000_000, clicks: 19, conversions: 0, allConversions: 0 },
    // Zero primary conversions but a non-primary one — must NOT be flagged.
    { term: "service consultation booking", campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", costMicros: 190_000_000, clicks: 88, conversions: 0, allConversions: 4 },
    // The client's own brand. Must never reach a negatives proposal.
    { term: "northgate clinic reviews", campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Brand", costMicros: 77_000_000, clicks: 40, conversions: 0, allConversions: 0 },

    // Converts nothing and is over the waste floor, so campaign 100 carries a
    // stop-stage row AND two grow-stage ones. That combination is the whole
    // reason the sequencing pass exists and the fixture had no example of it.
    { term: "service diy guide", campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", costMicros: 110_000_000, clicks: 62, conversions: 0, allConversions: 0 },

    // ── Queries that WORK, which the engine read and discarded until v5 ────
    // Over both floors and in no keyword anywhere in the account.
    { term: "emergency service downtown", campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", costMicros: 96_000_000, clicks: 40, conversions: 4, allConversions: 4 },
    { term: "same day service booking", campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", costMicros: 52_000_000, clicks: 28, conversions: 3, allConversions: 3 },
    // Already a keyword, in different case. Must NOT be proposed.
    { term: "Best Service Provider", campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", costMicros: 70_000_000, clicks: 45, conversions: 5, allConversions: 5 },
    // Converts three times on $20 — under the $25/90d spend floor.
    { term: "urgent service quote", campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", costMicros: 20_000_000, clicks: 9, conversions: 3, allConversions: 3 },
    // Spends enough, converted once — under the two-conversion floor.
    { term: "service repair cost", campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", costMicros: 60_000_000, clicks: 30, conversions: 1, allConversions: 1 },
    // Converts well, and is the client's protected brand. Must NOT be proposed.
    { term: "northgate clinic booking", campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Brand", costMicros: 80_000_000, clicks: 30, conversions: 4, allConversions: 4 },
    // Converts only on an action the account does not count. The waste rule
    // reads all_conversions and leaves it alone; this rule reads the PRIMARY
    // column and must leave it alone too, for the opposite reason.
    { term: "service brochure download", campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", costMicros: 65_000_000, clicks: 35, conversions: 0, allConversions: 6 },
  ],
  keywords: [
    { criterionResourceName: "customers/1234567890/adGroupCriteria/300~1", text: "service near me", matchType: "BROAD", qualityScore: 3, campaignId: "200", campaignName: "Search — Broad Prospecting", adGroupName: "Broad", costMicros: 210_000_000, clicks: 150, conversions: 0, finalUrls: [] },
    { criterionResourceName: "customers/1234567890/adGroupCriteria/300~2", text: "best service provider", matchType: "PHRASE", qualityScore: 6, campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", costMicros: 48_000_000, clicks: 30, conversions: 0, finalUrls: ["https://example.com/services"] },
  ],
  ads: [
    { adGroupId: "300", adGroupName: "Broad", campaignName: "Search — Broad Prospecting", adId: "400", adType: "RESPONSIVE_SEARCH_AD", adStrength: "POOR" },
    { adGroupId: "301", adGroupName: "Core", campaignName: "Search — Core Services", adId: "401", adType: "RESPONSIVE_SEARCH_AD", adStrength: "GOOD" },
    { adGroupId: "301", adGroupName: "Core", campaignName: "Search — Core Services", adId: "402", adType: "RESPONSIVE_SEARCH_AD", adStrength: "EXCELLENT" },
  ],
  existingNegatives: new Set(["service jobs"]),
  protectedPatterns: ["northgate clinic"],
  // A healthy conversion column: tracking configured, one action switched on,
  // counting toward the goal, categorised by the platform as a lead form, and
  // recording the conversions the campaigns report. Every rule that argues
  // from a nought needs this to be true before it may argue.
  tracking: {
    status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
    actions: [
      { id: "500", name: "Contact form", status: "ENABLED", category: "SUBMIT_LEAD_FORM", actionType: "WEBPAGE", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 40, defaultValue: null, alwaysUseDefaultValue: null },
      { id: "501", name: "Newsletter signup", status: "ENABLED", category: "ENGAGEMENT", actionType: "WEBPAGE", primaryForGoal: false, countsIntoConversionsColumn: false, conversionsInWindow: 310 },
    ],
  },
  // What the client has recorded about what a customer is worth. A $95
  // cost-per-lead ceiling they stated, plus the two figures a modelled
  // break-even is built from.
  economics: {
    customerValueCents: 240_000,       // $2,400 a customer
    customerValueFromClient: true,
    closeRatePct: 5,                   // → $120 a lead, modelled
    cplCeilingCents: 9_500,            // $95, stated
    cplCeilingMonth: "2026-09",
  },
  // The platform's own lag segmentation. Campaign 100 converts within a couple
  // of days; campaign 300 has four conversions, which is far too few to read a
  // distribution off, and the reading says so rather than calling it fast.
  conversionLag: [
    { campaignId: "100", bucket: "LESS_THAN_ONE_DAY", conversions: 22 },
    { campaignId: "100", bucket: "ONE_TO_TWO_DAYS", conversions: 9 },
    { campaignId: "100", bucket: "TWO_TO_THREE_DAYS", conversions: 4 },
    { campaignId: "100", bucket: "SEVEN_TO_EIGHT_DAYS", conversions: 1 },
    { campaignId: "300", bucket: "LESS_THAN_ONE_DAY", conversions: 4 },
  ],
  // Spend the search-terms report accounts for, per campaign, over the same
  // 30 days the campaign figures above cover. Campaign 200 shows a quarter of
  // its money as queries — which is what the report withholding low-volume
  // searches looks like from the outside, and is the case the waste rule has
  // always reasoned over without saying so.
  searchTermSpendByCampaign: { "100": 2_000_000_000, "200": 250_000_000, "300": 500_000_000, "400": 700_000_000 },
  // Every keyword the account HOLDS, as a settings read. Deliberately NOT the
  // same list as `keywords` above — that one is the performance pull and is
  // filtered to keywords that spent, so a keyword sitting in the account taking
  // no clicks is absent from it. "[emergency service]" is here and in no
  // performance row, which is exactly the case that would produce a duplicate
  // proposal if this rule checked the wrong list.
  //
  // SYNTHETIC, like everything else in this file. The SHAPE is taken from a
  // live account a reviewer checked by hand on 2026-09-23; none of that
  // account's own text, spend or scores is here.
  existingKeywords: [
    { text: "service near me", matchType: "BROAD", adGroupName: "Broad", campaignName: "Search — Broad Prospecting",
      criterionResourceName: "customers/1234567890/adGroupCriteria/300~1",
      criterionStatus: "ENABLED", adGroupStatus: "ENABLED", campaignStatus: "ENABLED", qualityScore: 3 },
    { text: "best service provider", matchType: "PHRASE", adGroupName: "Core", campaignName: "Search — Core Services",
      criterionResourceName: "customers/1234567890/adGroupCriteria/300~2",
      criterionStatus: "ENABLED", adGroupStatus: "ENABLED", campaignStatus: "ENABLED", qualityScore: 6 },
    // Live, under the quality-score floor, and it took no clicks in the window.
    // The performance pull therefore does not hold it, which is how the count
    // came to report one keyword under the floor on an account holding two.
    { text: "[emergency service]", matchType: "EXACT", adGroupName: "Core", campaignName: "Search — Core Services",
      criterionResourceName: "customers/1234567890/adGroupCriteria/300~3",
      criterionStatus: "ENABLED", adGroupStatus: "ENABLED", campaignStatus: "ENABLED", qualityScore: 2 },
    // THE REPORTED FAILURE, in fixture form. Enabled, broad, verbatim the text
    // of a query that converts — sitting in an ad group nobody turned back on.
    // It spent nothing in the window, so no performance row holds it either.
    // A dedupe that cannot see this recommends creating a second copy of it.
    { text: "same day service booking", matchType: "BROAD", adGroupName: "Paused — Weekend Push", campaignName: "Search — Core Services",
      criterionResourceName: "customers/1234567890/adGroupCriteria/301~1",
      criterionStatus: "ENABLED", adGroupStatus: "PAUSED", campaignStatus: "ENABLED", qualityScore: 1 },
    // In a paused CAMPAIGN, and under the quality-score floor. Neither reading
    // may count it: it is not demand nobody thought of, and it is charged no
    // relevance premium, because it takes no clicks.
    { text: "weekend service call", matchType: "PHRASE", adGroupName: "Retired", campaignName: "Search — Retired 2025",
      criterionResourceName: "customers/1234567890/adGroupCriteria/302~1",
      criterionStatus: "ENABLED", adGroupStatus: "ENABLED", campaignStatus: "PAUSED", qualityScore: 1 },
  ],
  // A day-by-day series with a break in it: 84 healthy days, then six days on
  // which the account carried on buying clicks and recorded nothing.
  dailyConversions: healthySeriesWithOutage(),
};

/**
 * SYNTHETIC. Eighty-four days converting at a steady rate, then six days of
 * clicks with no conversion recorded against any of them — the shape a tag
 * removed from a site leaves behind, and the only shape from which a start
 * date and an end date can be read.
 */
function healthySeriesWithOutage(): DailyConversionRow[] {
  const out: DailyConversionRow[] = [];
  const first = Date.parse("2026-06-13T00:00:00Z");
  for (let i = 0; i < 90; i++) {
    const date = new Date(first + i * 86_400_000).toISOString().slice(0, 10);
    const broken = i >= 84;
    out.push({
      date,
      clicks: 24,
      conversions: broken ? 0 : 1,
      costMicros: 43_000_000,
    });
  }
  return out;
}

/** The same account with one thing changed. Used to drive the tracking rules
 *  without a second fixture drifting away from the first. */
function withTracking(tracking: TrackingFacts | null): AuditInput {
  return { ...FIXTURE, tracking };
}
function withEconomics(economics: ClientEconomics | null): AuditInput {
  return { ...FIXTURE, economics };
}

/**
 * A recording Google Ads client.
 *
 * It answers the queries applyChangeSet makes from the fixture, and — the point
 * of the whole thing — it THROWS if a mutate arrives without a matching
 * validate_only first. A test that only checks the end state would pass even if
 * the dry run were silently skipped.
 */
function recorder(opts: {
  /** What `FROM customer ... BETWEEN` reports for the exclusion's own staleness
   *  guard. The proposal was worked out when this was nought. */
  conversionsInRange?: number;
  /** Data exclusions already on the account, for the overlap guard. */
  existingExclusions?: { name: string; start: string; end: string }[];
} = {}) {
  const calls: { method: string; validateOnly: boolean; payload: unknown }[] = [];
  const validated = new Set<string>();
  const key = (m: string, p: unknown) => `${m}:${JSON.stringify(p)}`;

  const mutator = (method: string) => (payload: unknown, opts?: { validate_only?: boolean }) => {
    const validateOnly = Boolean(opts?.validate_only);
    calls.push({ method, validateOnly, payload });
    if (validateOnly) { validated.add(key(method, payload)); return Promise.resolve({ results: [] }); }
    if (!validated.has(key(method, payload))) {
      throw new Error(`GUARD VIOLATION: ${method} was applied without a validate_only first.`);
    }
    // Real resource names, so the rollback plan has something to remove.
    const n = Array.isArray(payload) ? payload.length : 1;
    return Promise.resolve({ results: Array.from({ length: n }, (_, i) => ({ resource_name: `customers/1234567890/campaignCriteria/100~${9000 + i}` })) });
  };

  const customer: any = {
    query: (gaql: string) => {
      const q = gaql.replace(/\s+/g, " ").trim();
      // The data exclusion's own two reads, answered before the campaign
      // branch below because both mention other resources.
      if (/FROM bidding_data_exclusion\b/.test(q)) {
        return Promise.resolve((opts.existingExclusions ?? []).map((x) => ({
          bidding_data_exclusion: {
            resource_name: `customers/1234567890/biddingDataExclusions/${x.name.length}`,
            name: x.name, start_date_time: `${x.start} 00:00:00`, end_date_time: `${x.end} 23:59:59`,
          },
        })));
      }
      if (/FROM customer\b/.test(q) && /segments\.date BETWEEN/.test(q)) {
        return Promise.resolve([{ metrics: { conversions: opts.conversionsInRange ?? 0, all_conversions: opts.conversionsInRange ?? 0 } }]);
      }
      if (q.includes("FROM campaign ") || q.includes("FROM campaign\n") || /FROM campaign\b/.test(q)) {
        if (q.includes("campaign_criterion")) { /* fallthrough below */ }
        const name = /campaign\.name = '([^']+)'/.exec(q)?.[1];
        if (!name) {
          // No name in the WHERE: the exclusion path re-resolving every live
          // campaign by resource name.
          return Promise.resolve(FIXTURE.campaigns.map((c) => ({
            campaign: { id: c.id, name: c.name, resource_name: `customers/1234567890/campaigns/${c.id}` },
            campaign_budget: { resource_name: c.budgetResourceName, amount_micros: c.dailyBudgetMicros },
          })));
        }
        const c = FIXTURE.campaigns.find((x) => x.name === name);
        if (!c) return Promise.resolve([]);
        return Promise.resolve([{
          campaign: { id: c.id, name: c.name, resource_name: `customers/1234567890/campaigns/${c.id}` },
          campaign_budget: { resource_name: c.budgetResourceName, amount_micros: c.dailyBudgetMicros },
        }]);
      }
      if (/FROM campaign_criterion\b/.test(q)) {
        // The negatives already on the campaign, so duplicate-skipping is exercised.
        return Promise.resolve([{ campaign_criterion: { resource_name: "customers/1234567890/campaignCriteria/100~1", keyword: { text: "service jobs hiring", match_type: "3" } } }]);
      }
      return Promise.resolve([]);
    },
    campaignBudgets: { update: mutator("campaignBudgets.update") },
    campaignCriteria: { create: mutator("campaignCriteria.create"), remove: mutator("campaignCriteria.remove") },
    adGroupCriteria: { update: mutator("adGroupCriteria.update") },
    biddingDataExclusions: {
      create: mutator("biddingDataExclusions.create"),
      remove: mutator("biddingDataExclusions.remove"),
    },
  };
  return { customer, calls };
}

async function main() {
  console.log(`\nAds findings pipeline — verification harness (rules v${ADS_RULESET_VERSION})`);
  console.log(`Synthetic fixture. No live ad account is contacted and nothing is applied anywhere.\n`);

  // ── 1. Determinism ────────────────────────────────────────────────────────
  console.log("1. Determinism — the fix for 'the answer switches the next day'");
  const a = evaluate(FIXTURE);
  const b = evaluate(FIXTURE);
  ok("two runs over identical input are byte-identical", JSON.stringify(a) === JSON.stringify(b), `${a.length} findings each`);
  ok("the narrative seam is identity (no model wrote any of this)", refineNarrative(a).engine === "rules");

  console.log(`\n   Findings produced:`);
  for (const f of a) {
    const impact = f.estImpactCents ? `$${Math.round(f.estImpactCents / 100)}/mo` : "no $ claimed";
    console.log(`     · [${f.findingType}] ${f.applicability.padEnd(6)} ${impact.padStart(11)}  ${f.title}`);
  }

  // ── 2. Thresholds ─────────────────────────────────────────────────────────
  console.log("\n2. Thresholds hold, and nothing is flagged on the wrong column");
  const wasted = a.find((f) => f.findingType === "wasted_search_term");
  const negatives = (wasted?.changePayload?.body as { keywords: string[] }[] | undefined)?.[0]?.keywords ?? [];
  ok("a term $1 under the waste floor is not flagged", !negatives.includes("cheap service quote"), `floor ${usd(THRESHOLDS.searchTermWasteMicros)}/90d`);
  ok("a term with non-primary conversions only is not flagged", !negatives.includes("service consultation booking"), "all_conversions is read, not just conversions");
  ok("a term already a negative is not re-proposed", !negatives.includes("service jobs hiring"));
  ok("the client's own brand term is never proposed as a negative", !negatives.some((k) => k.includes("northgate")), "protected-pattern filter at detection");
  ok("the terms that ARE over the floor are proposed", negatives.includes("emergency service near me") && negatives.includes("free service advice"), negatives.join(", "));

  const budget = a.find((f) => f.findingType === "budget_limited" && f.entityName === "Search — Core Services");
  ok("a budget-capped CONVERTING campaign gets an API change", budget?.applicability === "api");
  const rank = a.find((f) => f.findingType === "rank_limited");
  ok("a rank-limited campaign becomes a vendor brief, not a budget increase", rank?.applicability === "vendor");
  const noConv = a.find((f) => f.findingType === "no_conversions");
  ok("a zero-conversion campaign proposes NO automatic pause", noConv?.changePayload === null, "broken tracking and bad traffic look identical");

  // ── 3. Memory ─────────────────────────────────────────────────────────────
  console.log("\n3. Memory — a dismissal survives noise but yields to real change");
  const base = wasted!.evidence.metrics;
  const drift = { ...base, costMicros: (base.costMicros ?? 0) + 3_000_000 };   // +$3
  const real = { ...base, costMicros: (base.costMicros ?? 0) * 2 };            // doubled
  const h0 = evidenceHash(base), h1 = evidenceHash(drift), h2 = evidenceHash(real);
  ok("$3 of drift does NOT count as changed evidence", !materiallyChanged(h0, h1), `${h0} == ${h1}`);
  ok("a doubling DOES count as changed evidence", materiallyChanged(h0, h2), `${h0} -> ${h2}`);

  // ── 4. The loop ───────────────────────────────────────────────────────────
  console.log("\n4. One finding, end to end: propose → approve → validate_only → apply → rollback");
  const payload = wasted!.changePayload!;
  console.log(`   proposed : ${payload.plainEnglish}`);
  console.log(`   guard    : ${payload.guard.slice(0, 110)}…`);

  const cs: ChangeSet = { client: "(harness)", protectedPatterns: FIXTURE.protectedPatterns, campaignNegatives: payload.body as ChangeSet["campaignNegatives"] };

  // Dry run — what the review screen shows before anyone presses Approve.
  const dry = recorder();
  const dryOut = await applyChangeSet(dry.customer, FIXTURE.accountId, cs, { apply: false, onLog: () => {} });
  ok("dry run validates and applies nothing", dry.calls.length > 0 && dry.calls.every((c) => c.validateOnly), `${dry.calls.length} call(s), all validate_only`);
  ok("dry run records no prior values (nothing changed)", dryOut.priorValues.length === 0);

  // Approve — the same function, apply:true.
  const live = recorder();
  const liveOut = await applyChangeSet(live.customer, FIXTURE.accountId, cs, { apply: true, onLog: () => {} });
  const firstMutate = live.calls.findIndex((c) => !c.validateOnly);
  ok("every mutate was preceded by its own validate_only", firstMutate > 0 && live.calls[0]!.validateOnly, "the recorder throws otherwise");
  ok("prior values were captured, so the change is reversible", liveOut.priorValues.length > 0, `${liveOut.priorValues.length} entr(y/ies)`);
  ok("a reversal plan was printed in words too", liveOut.rollback.length > 0);
  console.log(`   reversal :`);
  for (const r of liveOut.rollback.slice(0, 3)) console.log(`     ${r}`);

  // Roll back — validate-only, so even the harness changes nothing.
  const back = recorder();
  // The rollback removes criteria the live run created; pre-seed the recorder's
  // validated set the same way a real run would, by calling with validate_only.
  const rb = await rollbackChangeSet(back.customer, liveOut.priorValues as PriorValue[], { apply: false, onLog: () => {} });
  ok("rollback validates cleanly without applying", back.calls.length > 0 && back.calls.every((c) => c.validateOnly));
  ok("rollback knows exactly what to restore", rb.restored.length > 0, rb.restored.join(" · "));
  ok("nothing in this rollback needs a person", rb.manual.length === 0);

  // ── 5. Guards ─────────────────────────────────────────────────────────────
  console.log("\n5. Guards refuse rather than proceed");
  const protectedCs: ChangeSet = {
    client: "(harness)", protectedPatterns: ["northgate clinic"],
    campaignNegatives: [{ campaign: "Search — Core Services", matchType: "PHRASE", reason: "test", keywords: ["northgate clinic reviews"] }],
  };
  let refused = "";
  try { await applyChangeSet(recorder().customer, FIXTURE.accountId, protectedCs, { apply: false, onLog: () => {} }); }
  catch (e) { refused = e instanceof Error ? e.message : String(e); }
  ok("a protected-term negative aborts the WHOLE run", refused.includes("protected pattern"), refused.slice(0, 90));

  // Both of these now carry `fromDailyMicros`: the fixture campaign sits at
  // $80/day, and a change set that cannot say what it was computed from is
  // refused before the cap is ever reached (see the staleness guard below).
  const bigBudget: ChangeSet = { client: "(harness)", budgets: [{ campaign: "Search — Core Services", newDailyUsd: 500, fromDailyMicros: 80_000_000, reason: "test" }] };
  let budgetRefused = "";
  try { await applyChangeSet(recorder().customer, FIXTURE.accountId, bigBudget, { apply: false, onLog: () => {} }); }
  catch (e) { budgetRefused = e instanceof Error ? e.message : String(e); }
  ok("a budget move over the cap is refused", budgetRefused.includes("exceeds"), budgetRefused.slice(0, 90));

  const okBudget: ChangeSet = { client: "(harness)", budgets: [{ campaign: "Search — Core Services", newDailyUsd: 100, fromDailyMicros: 80_000_000, reason: "within cap" }] };
  const bRec = recorder();
  const bOut = await applyChangeSet(bRec.customer, FIXTURE.accountId, okBudget, { apply: true, onLog: () => {} });
  const pv = bOut.priorValues.find((p) => p.kind === "budget");
  ok("a budget move inside the cap records the exact prior amount", pv?.kind === "budget" && pv.amountMicros === 80_000_000, pv?.kind === "budget" ? usd(pv.amountMicros) : "none");

  // ── 6. A proposal worked out from a budget somebody has since moved ──────
  // `newDailyUsd` is frozen at detection time and the two caps above only ever
  // bound a move UP. Without this guard, a finding raised against a $100/day
  // campaign proposes $125 forever — so once a subcontractor raises that
  // campaign to $300, approving it writes $300 back DOWN to $125, passes both
  // caps, and reads in the log as a clean apply.
  console.log("\n6. A stale budget proposal is refused, not applied");

  const lines: string[] = [];
  const moved: ChangeSet = {
    client: "(harness)",
    // The audit saw $80/day. The fixture account is still at $80 — so to model
    // somebody having raised it we claim a DIFFERENT starting point, which is
    // the same comparison from the other side.
    budgets: [{ campaign: "Search — Core Services", newDailyUsd: 100, fromDailyMicros: 40_000_000, reason: "worked out a week ago" }],
  };
  const mRec = recorder();
  const mOut = await applyChangeSet(mRec.customer, FIXTURE.accountId, moved, { apply: true, onLog: (l: string) => lines.push(l) });
  ok("a budget that moved since detection is not applied",
    !mOut.priorValues.some((p) => p.kind === "budget"), JSON.stringify(mOut.priorValues).slice(0, 90));
  ok("and the run says what moved, so the refusal is readable",
    lines.some((l) => l.includes("refused")) && lines.some((l) => l.includes("Somebody has moved it")),
    lines.join(" | ").slice(0, 120));

  const noFrom: ChangeSet = { client: "(harness)", budgets: [{ campaign: "Search — Core Services", newDailyUsd: 100, reason: "no recorded starting point" }] };
  const nLines: string[] = [];
  const nOut = await applyChangeSet(recorder().customer, FIXTURE.accountId, noFrom, { apply: true, onLog: (l: string) => nLines.push(l) });
  ok("a change set with no recorded starting budget is refused",
    !nOut.priorValues.some((p) => p.kind === "budget"), JSON.stringify(nOut.priorValues).slice(0, 90));
  ok("and it names the way forward rather than failing silently",
    nLines.some((l) => l.includes("Check now")), nLines.join(" | ").slice(0, 120));

  // One stale item must not cost the rest of the batch: the guard SKIPS the
  // item, it does not throw.
  const mixed: ChangeSet = {
    client: "(harness)",
    budgets: [
      { campaign: "Search — Core Services", newDailyUsd: 100, fromDailyMicros: 40_000_000, reason: "stale" },
      { campaign: "Search — Core Services", newDailyUsd: 90, fromDailyMicros: 80_000_000, reason: "current" },
    ],
  };
  const xOut = await applyChangeSet(recorder().customer, FIXTURE.accountId, mixed, { apply: true, onLog: () => {} });
  const xPv = xOut.priorValues.filter((p) => p.kind === "budget");
  ok("a stale item is skipped without costing a current one in the same set",
    xPv.length === 1, `${xPv.length} budget prior value(s)`);


  // ── 7. The conversion column, and what it licenses ────────────────────────
  // Every rule in the engine judges a campaign, a term or a keyword on
  // "converted" or "converted nothing". This section is about what happens
  // when that column cannot be trusted, which until rules v2 was nothing at
  // all: the engine argued from noughts it had never checked.
  console.log("\n7. Conversion tracking decides what the rest of the engine may say");

  const totals = { costMicros: 3_910_000_000, clicks: 2_120, conversions: 40 };
  const healthy = trackingReading(FIXTURE.tracking, totals);
  ok("a configured, counting, lead-shaped column is trusted for both questions",
    healthy.countsAnything === "yes" && healthy.countsOutcomes === "yes" && healthy.defects.length === 0);

  const notTracked = trackingReading({ status: "NOT_CONVERSION_TRACKED", actions: [] }, totals);
  ok("an account with no conversion tracking is read as counting nothing",
    notTracked.countsAnything === "no" && notTracked.defects[0]?.key === "not_tracked");

  const noneEnabled = trackingReading({
    status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
    actions: [{ id: "1", name: "Old form", status: "REMOVED", category: "LEAD", actionType: "WEBPAGE", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 0 }],
  }, totals);
  ok("an account whose only conversion action is switched off counts nothing",
    noneEnabled.countsAnything === "no" && noneEnabled.defects[0]?.key === "not_tracked");

  const noPrimary = trackingReading({
    status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
    actions: [
      { id: "1", name: "Contact form", status: "ENABLED", category: "LEAD", actionType: "WEBPAGE", primaryForGoal: false, countsIntoConversionsColumn: false, conversionsInWindow: 120 },
      { id: "2", name: "Phone click", status: "ENABLED", category: "PHONE_CALL_LEAD", actionType: "WEBPAGE", primaryForGoal: false, countsIntoConversionsColumn: false, conversionsInWindow: 60 },
    ],
  }, totals);
  ok("actions that all count as secondary leave the conversion column at nought",
    noPrimary.countsAnything === "no" && noPrimary.defects[0]?.key === "no_primary",
    "180 conversions recorded and none of them reaches the column every rule reads");

  const silent = trackingReading({
    status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
    actions: [{ id: "1", name: "Contact form", status: "ENABLED", category: "LEAD", actionType: "WEBPAGE", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 0 }],
  }, totals);
  ok("a counting action that has recorded nothing on real spend reads as a broken tag",
    silent.countsAnything === "no" && silent.defects[0]?.key === "primary_silent");

  const quiet = trackingReading({
    status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
    actions: [{ id: "1", name: "Contact form", status: "ENABLED", category: "LEAD", actionType: "WEBPAGE", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 0 }],
  }, { costMicros: 20_000_000, clicks: 40, conversions: 0 });
  ok("…but the same silence under the spend floor is unknown, not a defect",
    quiet.countsAnything === "unknown" && quiet.defects.length === 0 && quiet.unread.length > 0,
    `floor ${usd(THRESHOLDS.trackingSilenceMinSpendMicros)}/window`);

  const pageViews = trackingReading({
    status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
    actions: [{ id: "1", name: "Thank you page", status: "ENABLED", category: "PAGE_VIEW", actionType: "GOOGLE_ANALYTICS_4_CUSTOM", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 900 }],
  }, totals);
  ok("a column counting page views records something but records no outcome",
    pageViews.countsAnything === "yes" && pageViews.countsOutcomes === "no"
      && pageViews.defects[0]?.key === "primary_not_an_outcome",
    "the category is the platform's own, not a guess at the action's name");

  const everyEvent = trackingReading({
    status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
    actions: [{ id: "1", name: "GA4 import", status: "ENABLED", category: "DEFAULT", actionType: "GOOGLE_ANALYTICS_4_CUSTOM", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 5_000 }],
  }, { costMicros: 900_000_000, clicks: 2_000, conversions: 5_000 });
  ok("more conversions than clicks is read as a column counting events",
    everyEvent.countsOutcomes === "no" && everyEvent.defects[0]?.key === "implausible_rate",
    "the fallback signal, used only where the category says nothing");

  const unread = trackingReading({ status: null, actions: null }, totals);
  ok("a failed read is unknown on both questions and never a defect",
    unread.countsAnything === "unknown" && unread.countsOutcomes === "unknown"
      && unread.defects.length === 0 && unread.unread.length === 1);

  const countsUnread = trackingReading({
    status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
    actions: [{ id: "1", name: "Contact form", status: "ENABLED", category: "LEAD", actionType: "WEBPAGE", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: null }],
  }, totals);
  ok("an action whose recorded count was not read is unknown, never a silent tag",
    countsUnread.countsAnything === "unknown" && countsUnread.defects.length === 0,
    "a null count arriving as a nought would invent a broken tag on a working account");

  // ── 8. What a broken column stops the engine proposing ────────────────────
  // The money question in this whole section: the waste rules select on "this
  // converted nothing", and on a broken account everything converted nothing.
  console.log("\n8. A broken conversion column holds back the proposals that argue from a nought");

  const brokenRun = evaluate(withTracking({ status: "NOT_CONVERSION_TRACKED", actions: [] }));
  const brokenNegatives = brokenRun.filter((f) => f.findingType === "wasted_search_term");
  ok("no negative keyword is proposed on an account with no working conversion column",
    brokenNegatives.length === 0,
    "the same terms are proposed on the healthy fixture — the account did not change, the trust in its noughts did");
  ok("no dead-keyword row either, for the same reason",
    brokenRun.every((f) => f.findingType !== "dead_keyword"));
  // NARROWED WHEN THE DATA EXCLUSION SHIPPED, and narrowed rather than
  // relaxed. The rule this check exists for is that the engine proposes
  // nothing that ARGUES FROM A NOUGHT it cannot trust — no negatives, no dead
  // keywords, and above all no extra budget on an account nobody can read.
  // A data exclusion is the opposite kind of change: it does not spend, it
  // does not block traffic, and it is the one thing there IS to do about a
  // column that has been feeding noughts to a bidding model. The check now
  // says both halves.
  ok("nothing in the broken run proposes spending more or blocking traffic",
    brokenRun.filter((f) => f.findingType !== "bidding_data_exclusion").every((f) => f.changePayload === null),
    "including the budget increase, which would be spending more on an account nobody can read");
  const brokenExclusion = brokenRun.find((f) => f.findingType === "bidding_data_exclusion");
  ok("…and the one change it DOES carry is the one that stops the bidding learning from the bad days",
    brokenExclusion?.changePayload?.op === "dataExclusions",
    brokenExclusion?.title ?? "none");

  const trackingRows = brokenRun.filter((f) => f.findingType === "conversion_tracking_gap");
  ok("the account gets a tracking finding instead", trackingRows.length === 1, trackingRows[0]?.title ?? "none");
  const held = trackingRows[0];
  ok("…which NAMES what was held back and what it is worth, rather than the money vanishing",
    Boolean(held) && (held!.evidence.metrics.heldBackItems ?? 0) > 0
      && (held!.evidence.metrics.heldBackMicros ?? 0) > 0
      && held!.summary.includes("negative keywords"),
    `${held?.evidence.metrics.heldBackItems} item(s), ${usd(held?.evidence.metrics.heldBackMicros ?? 0)}`);
  ok("the tracking finding claims no dollar impact",
    held?.estImpactCents === 0,
    "what a false conversion count costs is the decisions taken on it, which nothing here can price");
  ok("no 'converting nothing' row is raised on an account that records nothing",
    brokenRun.every((f) => f.findingType !== "no_conversions"),
    "it would be a second row saying what the tracking row says, with a worse explanation");

  const unreadRun = evaluate(withTracking(null));
  ok("an adapter that never read the tracking is held back the same way",
    unreadRun.every((f) => f.findingType !== "wasted_search_term"),
    "'we did not look' is not 'we looked and it is fine'");
  const unreadRow = unreadRun.find((f) => f.findingType === "conversion_tracking_gap");
  ok("…and the run says so on its own row rather than reading as a clean account",
    Boolean(unreadRow) && unreadRow!.title.includes("could not be read"),
    unreadRow?.title ?? "none");

  // ── 9. The client's own goal ──────────────────────────────────────────────
  // Until rules v2 no rule read any of this, so a campaign hitting the target
  // and one running at three times it produced the identical recommendation.
  console.log("\n9. The rules read what the client said a lead may cost");

  const stated = costTargets(FIXTURE.economics);
  ok("a stated ceiling and a modelled break-even are both produced, and kept apart",
    stated.length === 2 && stated[0]!.basis === "stated" && stated[1]!.basis === "modelled",
    stated.map((t) => `${t.basis} $${(t.cents / 100).toFixed(2)}`).join(" · "));
  ok("the client's own instruction decides the verdict, never the estimate",
    governingTarget(stated)?.basis === "stated");
  ok("the modelled figure says 'estimated' in the sentence it is printed in",
    stated[1]!.line.startsWith("Estimated"),
    "the label is part of the number, not a caveat elsewhere");
  ok("a nought ceiling is never read as a ceiling of nothing",
    costTargets({ ...FIXTURE.economics!, cplCeilingCents: null }).every((t) => t.basis !== "stated"),
    "client_targets.cpl_ceiling_cents is DEFAULT 0 and its dialog says to leave it at 0 to skip");
  ok("half a customer value is no modelled figure at all",
    costTargets({ ...FIXTURE.economics!, closeRatePct: null, cplCeilingCents: null }).length === 0,
    "leads x an assumed rate is a figure that renders identically to a measured one");

  const overTargetRow = a.find((f) => f.findingType === "cpa_above_target");
  ok("a campaign converting above the client's ceiling is a finding of its own",
    Boolean(overTargetRow), overTargetRow?.title ?? "none");
  ok("…and it proposes nothing automatic",
    overTargetRow?.changePayload === null && overTargetRow?.applicability === "vendor");
  ok("…and its figure is the gap, stated as a gap rather than a saving",
    (overTargetRow?.estImpactCents ?? 0) > 0
      && /not a saving/.test(overTargetRow?.impactAssumption ?? ""),
    `$${Math.round((overTargetRow?.estImpactCents ?? 0) / 100)}/mo`);

  // The one the owner asked for: identical impression-share numbers, opposite
  // recommendations, decided by the client's own target.
  const cheapCeiling = evaluate(withEconomics({ ...FIXTURE.economics!, cplCeilingCents: 2_000, cplCeilingMonth: "2026-09" }));
  const cappedUnderCheap = cheapCeiling.find((f) => f.findingType === "budget_limited" && f.entityName === "Search — Core Services");
  const cappedAtTarget = a.find((f) => f.findingType === "budget_limited" && f.entityName === "Search — Core Services");
  ok("the SAME budget-capped campaign is proposed budget under one ceiling and refused it under another",
    cappedAtTarget?.applicability === "api" && cappedUnderCheap?.applicability === "vendor"
      && cappedUnderCheap?.changePayload === null,
    "$95 ceiling → raise it; $20 ceiling → it already costs too much, so more budget buys more of the same");
  ok("…and the refusal says which, rather than going quiet",
    /over its cost target/.test(cappedUnderCheap?.guardNote ?? ""),
    cappedUnderCheap?.title ?? "none");

  const noGoal = evaluate(withEconomics(null));
  const cappedNoGoal = noGoal.find((f) => f.findingType === "budget_limited" && f.entityName === "Search — Core Services");
  ok("with no goal recorded the budget increase is still proposed",
    cappedNoGoal?.applicability === "api", "a missing target is not a reason to stop working the account");
  ok("…but it claims no money and says which figure is missing",
    cappedNoGoal?.estImpactCents === 0
      && /nothing on this client's record says what one is worth/.test(cappedNoGoal?.impactAssumption ?? ""),
    "spending more is not a benefit, and without a customer value there is nothing to price the extra conversions against");
  ok("…and the evidence names the gap where the figure would have been",
    (cappedNoGoal?.evidence.lines ?? []).some((l) => l.includes("No cost-per-lead ceiling")),
    "silence is never a pass");
  ok("no cost-target row is raised on a client who set no target",
    noGoal.every((f) => f.findingType !== "cpa_above_target"),
    "a target nobody stated is never invented");

  // ── 9b. The enum shape, which is where this rule would have died quietly ──
  // Google returns enums as INTEGERS over REST. `trackingReading` decides
  // whether to refuse a money figure by comparing a category to Google's own
  // word for it, so on a live account the category would have arrived as "3"
  // and the comparison would never have matched — on every account, silently,
  // forever. The adapter normalises; these checks pin that it does, and that
  // the rules are strict enough for the normalisation to be load-bearing.
  console.log("\n9b. Google's integer enums are normalised before the rules see them");
  ok("the category integer is decoded to the platform's own word",
    enumName(CONVERSION_CATEGORY, 3) === "PAGE_VIEW" && enumName(CONVERSION_CATEGORY, "3") === "PAGE_VIEW");
  ok("a word that already arrived as a word passes through untouched",
    enumName(CONVERSION_CATEGORY, "SUBMIT_LEAD_FORM") === "SUBMIT_LEAD_FORM"
      && enumName(TRACKING_STATUS, "NOT_CONVERSION_TRACKED") === "NOT_CONVERSION_TRACKED");
  ok("an integer nothing knows is passed through rather than guessed at",
    enumName(CONVERSION_CATEGORY, 99) === "99", "an unknown category reads as ambiguous, which is the safe direction");
  ok("nothing is decoded out of nothing", enumName(CONVERSION_CATEGORY, null) === null);
  const rawRow = { id: "1", name: "Contact form", actionType: "8", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 40 };
  const rawEnum = trackingReading(
    { status: "3", actions: [{ ...rawRow, status: "2", category: "13" }] }, totals);
  const decoded = trackingReading(
    { status: enumName(TRACKING_STATUS, "3"), actions: [{ ...rawRow, status: enumName({ "2": "ENABLED" }, "2"), category: enumName(CONVERSION_CATEGORY, "13") }] }, totals);
  ok("the same healthy account reads as BROKEN if the enums reach the rules undecoded",
    rawEnum.countsAnything === "no" && decoded.countsAnything === "yes" && decoded.countsOutcomes === "yes",
    "an ENABLED action arrives as \"2\", reads as not-enabled, and the engine declares a working account untracked — this check fails loudly if anybody routes raw API rows straight into the engine");

  // ── 10. An account-level row needs a reason to exist ──────────────────────
  console.log("\n10. Account-level rows carry a spend floor");
  const parked: AuditInput = {
    ...FIXTURE,
    campaigns: FIXTURE.campaigns.map((c) => ({ ...c, costMicros: 20_000_000, clicks: 12, conversions: 0 })),
  };
  const parkedRun = evaluate(parked);
  ok("a parked account raises no quality-score, thin-ad-group or ad-strength row",
    parkedRun.every((f) => !["low_quality_score", "thin_ad_group", "weak_ad_strength"].includes(f.findingType)),
    `floor ${usd(THRESHOLDS.accountMinSpendMicros)}/window — three rows on every mapped account is how a class of finding gets scrolled past`);
  ok("the same three rows DO appear on the account that is actually spending",
    ["low_quality_score", "thin_ad_group", "weak_ad_strength"].every((t) => a.some((f) => f.findingType === t)));


  // ── 11. Does anything tell this account which leads became customers? ─────
  // This is the reading that answers the question the OCH offline-conversion
  // upload was the answer to, and it answers it per client rather than by
  // somebody working it out by hand. It says what an account COULD support. It
  // never says to change what a bidding strategy optimises toward.
  console.log("\n11. Closed outcomes: what each account could feed back, and what it could not");

  const noClicks = outcomeReadiness({
    leadsInWindow: 64, gclidLeadsInWindow: 0, newestGclidLeadOn: null,
    crmRowsInWindow: 0, wonInWindow: 0, wonWindowMonths: 6,
    measuredWonValueCents: null, uploadsEver: 0, newestUploadOn: null,
  }, FIXTURE.economics);
  ok("an account capturing no click id at all is the first blocker, before anything else",
    noClicks?.verdict === "no_click_ids" && noClicks.blockers.length > 0,
    "this is a live state on a real account, not a hypothetical");
  ok("…and it says a click id not captured today cannot be recovered later",
    /cannot be recovered/.test(noClicks?.blockers[0] ?? ""));

  const noOutcomes = outcomeReadiness({
    leadsInWindow: 64, gclidLeadsInWindow: 51, newestGclidLeadOn: "2026-09-18",
    crmRowsInWindow: 0, wonInWindow: 0, wonWindowMonths: 6,
    measuredWonValueCents: null, uploadsEver: 0, newestUploadOn: null,
  }, FIXTURE.economics);
  ok("clicks arriving with nothing closing the loop is its own verdict",
    noOutcomes?.verdict === "no_outcomes");

  // THE CASE THAT MATTERS. Small numbers of closed outcomes a month is the
  // ordinary shape of this book, and it is the shape a bidding strategy cannot
  // learn from.
  const thin = outcomeReadiness({
    leadsInWindow: 64, gclidLeadsInWindow: 51, newestGclidLeadOn: "2026-09-18",
    crmRowsInWindow: 22, wonInWindow: 18, wonWindowMonths: 6,
    measuredWonValueCents: 320_000, uploadsEver: 0, newestUploadOn: null,
  }, FIXTURE.economics);
  ok("three closed outcomes a month is read as too thin to bid on, not as a success",
    thin?.verdict === "too_thin_to_bid" && (thin.outcomesPerMonth ?? 0) < MIN_MONTHLY_OUTCOMES_FOR_BIDDING,
    `${(thin?.outcomesPerMonth ?? 0).toFixed(1)}/month against a ${MIN_MONTHLY_OUTCOMES_FOR_BIDDING}/month convention`);

  const thick = outcomeReadiness({
    leadsInWindow: 900, gclidLeadsInWindow: 700, newestGclidLeadOn: "2026-09-18",
    crmRowsInWindow: 400, wonInWindow: 300, wonWindowMonths: 6,
    measuredWonValueCents: 120_000, uploadsEver: 0, newestUploadOn: null,
  }, FIXTURE.economics);
  ok("an account with real volume reads as a decision, never as a recommendation",
    thick?.verdict === "enough_to_consider");

  const noValue = outcomeReadiness({
    leadsInWindow: 900, gclidLeadsInWindow: 700, newestGclidLeadOn: "2026-09-18",
    crmRowsInWindow: 400, wonInWindow: 300, wonWindowMonths: 6,
    measuredWonValueCents: null, uploadsEver: 0, newestUploadOn: null,
  }, { ...FIXTURE.economics!, customerValueFromClient: false });
  ok("a value nobody measured is a blocker, and the figure on the client record does not fill it",
    noValue?.measuredValueCents === null
      && noValue.blockers.some((b) => /assumed value|ours, not theirs/.test(b)),
    "sending an assumed value teaches the platform a preference nobody measured");

  ok("nothing was gathered reads as nothing gathered, never as an account with no outcomes",
    outcomeReadiness(null, FIXTURE.economics) === null);

  const withOutcomes = evaluate({
    ...FIXTURE,
    outcomes: {
      leadsInWindow: 64, gclidLeadsInWindow: 51, newestGclidLeadOn: "2026-09-18",
      crmRowsInWindow: 22, wonInWindow: 18, wonWindowMonths: 6,
      measuredWonValueCents: 320_000, uploadsEver: 0, newestUploadOn: null,
    },
  });
  const feedback = withOutcomes.find((f) => f.findingType === "outcome_feedback_gap");
  ok("the account gets one row saying what it could feed back", Boolean(feedback), feedback?.title ?? "none");
  ok("…and the row proposes nothing and claims no money",
    feedback?.changePayload === null && feedback?.estImpactCents === 0 && feedback?.applicability === "vendor",
    "there is no guarded path for changing what an account bids toward, and there should not be");
  ok("…and it never tells anybody to point bidding at it",
    !/switch|point bidding|use it as|set it as the/i.test(`${feedback?.title} ${feedback?.summary}`),
    "that was tried on the one account with the data and was rolled back");
  ok("…and the measured value is stated as context, never multiplied by anything",
    /measured rather than assumed/.test(feedback?.impactAssumption ?? "")
      && /would be a claim/.test(feedback?.impactAssumption ?? ""));
  ok("no row at all where nothing was gathered",
    evaluate(FIXTURE).every((f) => f.findingType !== "outcome_feedback_gap"));


  // ── 12. Meta — what the engine may and may not say about another platform ─
  // The rules are platform-neutral and two of the account-level ones were not:
  // they made a Google claim on any platform whose adapter supplies no Google
  // input. This section drives a Meta account and asserts the engine is SILENT
  // where it has nothing to say, rather than silent because nothing is wrong.
  console.log("\n12. Meta — a platform declares what its adapter supplies");

  /** A Meta account. No search terms, no keywords, no ads, no impression
   *  share, no conversion-action configuration, no click id on any lead — and
   *  one ad set the platform itself says will not settle. SYNTHETIC. */
  const META_ADSETS: AdSetRow[] = [
    {
      id: "as-1", name: "Prospecting — Broad", campaignId: "mc-1", campaignName: "Leads — Always on",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      learningStatus: "LEARNING_LIMITED", learningEvents: 9, learningThreshold: 50,
      costMicros: 900_000_000, effectiveStatus: "ACTIVE",
    },
    {
      id: "as-2", name: "Retargeting — Site visitors", campaignId: "mc-1", campaignName: "Leads — Always on",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      learningStatus: "SUCCESS", learningEvents: 140, learningThreshold: 50,
      costMicros: 600_000_000, effectiveStatus: "ACTIVE",
    },
    {
      // The ordinary state of a new ad set: still learning, and it resolves by
      // itself. A row on this fires on every launch and teaches people to
      // scroll past the one that matters.
      id: "as-4", name: "Prospecting — Lookalike", campaignId: "mc-1", campaignName: "Leads — Always on",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      learningStatus: "LEARNING", learningEvents: 21, learningThreshold: 50,
      costMicros: 400_000_000, effectiveStatus: "ACTIVE",
    },
    {
      // Under the ad-set spend floor. The platform says LEARNING_LIMITED and it
      // is true and it is not a finding — $12 of spend says the budget is small,
      // which the person who set the budget already knows.
      id: "as-3", name: "Test — new creative", campaignId: "mc-1", campaignName: "Leads — Always on",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      learningStatus: "LEARNING_LIMITED", learningEvents: 1, learningThreshold: 50,
      costMicros: 12_000_000, effectiveStatus: "ACTIVE",
    },
  ];
  const META: AuditInput = {
    platform: "meta",
    accountId: "act_synthetic",
    windowStart: FIXTURE.windowStart, windowEnd: FIXTURE.windowEnd,
    campaigns: [{
      id: "mc-1", name: "Leads — Always on", channelType: "OUTCOME_LEADS",
      dailyBudgetMicros: 60_000_000, budgetResourceName: null,
      costMicros: 1_512_000_000, clicks: 2_100, impressions: 310_000, conversions: 24,
      impressionShare: null, budgetLostShare: null, rankLostShare: null,
      specialAdCategories: [],
    }],
    adSets: META_ADSETS,
    searchTerms: [], keywords: [], ads: [],
    existingNegatives: new Set(), protectedPatterns: [],
    economics: FIXTURE.economics,
  };

  const metaFindings = evaluate(META);

  ok("a platform nobody has declared is asked for nothing",
    platformSignals("tiktok").clickIdOnLead === null
      && platformSignals("tiktok").conversionConfig === false
      && platformSignals("tiktok").learningState === false,
    "default-deny, so a new platform produces no claim until somebody writes the line");

  ok("Meta declares no conversion-action configuration and no click id on a lead",
    PLATFORM_SIGNALS.meta!.conversionConfig === false && PLATFORM_SIGNALS.meta!.clickIdOnLead === null);

  ok("…so no 'part of this could not be read' tracking row is produced on a Meta account",
    !metaFindings.some((f) => f.findingType === "conversion_tracking_gap"),
    "that row named a fix that would never stop producing it");

  ok("…and no closed-outcome row is produced either",
    !metaFindings.some((f) => f.findingType === "outcome_feedback_gap"),
    "there is no fbclid column, so the chain does not exist to be read");

  // The rules gate, on its own. The findings run also refuses to GATHER these
  // facts for a platform with no click id, so this is the second of two
  // defences: hand the engine Google-shaped outcomes under a Meta platform and
  // it must still say nothing, because they are not this platform's outcomes.
  ok("…even when Google-shaped outcomes are handed to it under a Meta platform",
    evaluate({
      ...META,
      outcomes: {
        leadsInWindow: 400, gclidLeadsInWindow: 0, newestGclidLeadOn: null,
        crmRowsInWindow: 30, wonInWindow: 6, wonWindowMonths: 6,
        measuredWonValueCents: 240_000, uploadsEver: 0, newestUploadOn: null,
      },
    }).every((f) => f.findingType !== "outcome_feedback_gap"),
    "otherwise every Meta account reports 'not one lead carries a click id' and sends somebody to fix Google auto-tagging");

  ok("Google still gets both rows from the same engine",
    evaluate(withTracking(null)).some((f) => f.findingType === "conversion_tracking_gap"),
    "the gate is per platform, not a deletion");

  const limited = metaFindings.filter((f) => f.findingType === "learning_limited");
  ok("the ad set the platform says will not settle gets exactly one row", limited.length === 1,
    limited[0]?.title ?? "none");
  ok("…the settled one, the one still learning normally and the one under the spend floor get none",
    !limited.some((f) => /Retargeting|Lookalike|Test — new creative/.test(f.entityName ?? "")),
    "LEARNING is the ordinary state of a new ad set and resolves by itself — a row on it fires on every launch");
  ok("…it proposes nothing, claims no money and is a brief",
    limited[0]?.changePayload === null && limited[0]?.estImpactCents === 0 && limited[0]?.applicability === "vendor",
    "what an unsettled ad set costs is a difference nothing here can see");
  ok("…and it names the one event that counts toward the threshold",
    /only that event counts/.test(limited[0]?.evidence.lines.join(" ") ?? ""));

  ok("no learning row on a platform that reports no learning state",
    evaluate({ ...FIXTURE, adSets: META_ADSETS }).every((f) => f.findingType !== "learning_limited"),
    "Google reports its learning period in no API field, so asserting one would be inventing a verdict");

  // The platform's own verdict decides, never our arithmetic over its counts.
  ok("a platform saying SUCCESS on a thin-looking count is settled",
    learningReading({ ...META_ADSETS[1]!, learningEvents: 3 }).verdict === "settled");
  ok("a platform saying LEARNING_LIMITED on a healthy-looking count is still limited",
    learningReading({ ...META_ADSETS[0]!, learningEvents: 400 }).verdict === "limited");
  ok("a status nobody read says nothing at all",
    learningReading({ ...META_ADSETS[0]!, learningStatus: null }).verdict === "unreadable");

  const ownThreshold = learningReading(META_ADSETS[0]!);
  const ourThreshold = learningReading({ ...META_ADSETS[0]!, learningThreshold: null });
  ok("the platform's own threshold is used and said to be the platform's",
    ownThreshold.thresholdFromPlatform && /threshold the platform reports/.test(ownThreshold.lines.join(" ")));
  ok("…and where it reports none, the convention is used and says it is a convention",
    !ourThreshold.thresholdFromPlatform && ourThreshold.threshold === LEARNING_EVENTS_CONVENTION
      && /convention and not a figure the platform gave us/.test(ourThreshold.lines.join(" ")),
    "a number we chose and a number the platform chose must never render identically");
  ok("an unread event count is never read as a nought",
    learningReading({ ...META_ADSETS[0]!, learningEvents: null }).shortBy === null);

  // Restricted categories change which advice is honest.
  const restricted = evaluate({
    ...META,
    campaigns: [{ ...META.campaigns[0]!, specialAdCategories: ["HOUSING"] }],
  }).find((f) => f.findingType === "learning_limited");
  const plain = limited[0];
  const restrictedLines = restricted?.evidence.lines.join(" ") ?? "";
  ok("a campaign under a restricted category is never told to widen its audience",
    !/A wider audience, so the same budget/.test(restrictedLines)
      && /HOUSING/.test(restrictedLines)
      && /is not an option that exists on it/.test(restrictedLines),
    "age, gender and detailed targeting are stripped, so that control is not there — the row names it rather than offering it");
  ok("…and one that is not under one still gets that advice",
    /A wider audience, so the same budget/.test(plain?.evidence.lines.join(" ") ?? ""));

  // ── The adapter's own counting, which was summing one lead two or three times
  console.log("\n   Counting a Meta conversion once");
  const doubled = countMetaConversions({
    actions: [
      { action_type: "lead", value: "12" },
      { action_type: "offsite_conversion.fb_pixel_lead", value: "12" },
      { action_type: "onsite_conversion.lead_grouped", value: "12" },
      { action_type: "link_click", value: "2100" },
      { action_type: "video_view", value: "8000" },
    ],
  });
  ok("one lead reported under three action names counts once", doubled.conversions === 12,
    `counted ${doubled.conversions} — the old regex summed all three and reported 36`);
  ok("…and a link click or a video view is not a conversion", doubled.basis === "actions");

  ok("the platform's own result count wins where it reports one",
    countMetaConversions({ objective_results: 7, actions: [{ action_type: "lead", value: "12" }] }).conversions === 7,
    "it is what the delivery model is working from and what the learning threshold is measured against");
  ok("a genuine nought from the platform is taken as a nought",
    countMetaConversions({ objective_results: 0, actions: [] }).basis === "objective_results");
  ok("nothing at all reads as nothing, not as a nought conversion count",
    countMetaConversions({}).basis === "none");
  ok("a purchase reported under two names counts once",
    countMetaConversions({ actions: [
      { action_type: "purchase", value: "3" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "3" },
    ] }).conversions === 3);
  ok("two DIFFERENT outcomes are both counted",
    countMetaConversions({ actions: [
      { action_type: "lead", value: "4" },
      { action_type: "purchase", value: "2" },
    ] }).conversions === 6);
  // ── 12. Can this campaign's bidding learn from what it gets? ─────────────
  // The reading nothing in this engine computed. Every published threshold is
  // a conversion count PER CAMPAIGN PER 30 DAYS, and `noConversionClicks` asks
  // a different question — whether a campaign converted at all.
  console.log("\n13. Bidding readiness, and the gate it puts in front of everything else");

  const lagFast = lagReading([
    { campaignId: "100", bucket: "LESS_THAN_ONE_DAY", conversions: 22 },
    { campaignId: "100", bucket: "ONE_TO_TWO_DAYS", conversions: 9 },
    { campaignId: "100", bucket: "TWO_TO_THREE_DAYS", conversions: 4 },
    { campaignId: "100", bucket: "SEVEN_TO_EIGHT_DAYS", conversions: 1 },
  ]);
  ok("a lag distribution reads as a bucketed median and a share inside the useful window",
    lagFast.medianDays === 1 && (lagFast.shareWithinUsefulWindow ?? 0) > 0.95 && (lagFast.shareWithinUsefulWindow ?? 1) < 1,
    `median ${lagFast.medianDays}d · ${Math.round((lagFast.shareWithinUsefulWindow ?? 0) * 100)}% within ${USEFUL_CONVERSION_LAG_DAYS} days`);
  const lagThin = lagReading([{ campaignId: "300", bucket: "LESS_THAN_ONE_DAY", conversions: 4 }]);
  ok("four conversions is too few to read a distribution off, and it says so rather than calling the campaign fast",
    lagThin.medianDays === null && lagThin.unread.length === 1, lagThin.unread[0] ?? "");
  ok("a lag that was never read is unread, never fast",
    lagReading(null).medianDays === null && lagReading(null).unread.length === 1);
  const lagSlow = lagReading([
    { campaignId: "9", bucket: "LESS_THAN_ONE_DAY", conversions: 10 },
    { campaignId: "9", bucket: "THIRTY_TO_FORTY_FIVE_DAYS", conversions: 25 },
  ]);
  ok("a signal arriving a month after the click is read as a month, from the top of its bucket",
    lagSlow.medianDays === 45, `median ${lagSlow.medianDays} day(s) — the top of the bucket, because rounding a lag DOWN is the expensive direction`);

  ok("a strategy with a conversion target is told apart from one without",
    onTargetStrategy({ strategyType: "TARGET_CPA", hasTarget: true }) === true
      && onTargetStrategy({ strategyType: "MANUAL_CPC", hasTarget: false }) === false
      && onTargetStrategy({ strategyType: "MAXIMIZE_CONVERSIONS", hasTarget: false }) === false
      && onTargetStrategy({ strategyType: "MAXIMIZE_CONVERSIONS", hasTarget: true }) === true);
  ok("Maximize Clicks and Target Impression Share carry no conversion floor, whatever their names say",
    onTargetStrategy({ strategyType: "TARGET_SPEND", hasTarget: true }) === false
      && onTargetStrategy({ strategyType: "TARGET_IMPRESSION_SHARE", hasTarget: true }) === false,
    "neither optimises toward a conversion, so the published conversion minimum has nothing to say about either");
  ok("a strategy nobody read is unknown, never manual",
    onTargetStrategy({ strategyType: null, hasTarget: null }) === null,
    "'we did not read it' and 'it needs no volume' are opposite answers and only one of them licenses a change");

  const readyCampaign = biddingReadiness(
    { campaignId: "100", campaignName: "Search — Core Services", strategyType: "TARGET_CPA", hasTarget: true, conversions30d: 36, costMicros30d: 2_400_000_000 },
    FIXTURE.conversionLag, "yes");
  ok("a campaign over the published minimum may be proposed a bid target and a budget step",
    readyCampaign.verdict === "stable" && readyCampaign.mayProposeBidTarget && readyCampaign.mayProposeBudgetStep,
    `${readyCampaign.conversions30d} conversions against a published minimum of ${TARGET_STRATEGY_MIN_CONVERSIONS_30D}`);

  const thinCampaign = biddingReadiness(
    { campaignId: "300", campaignName: "Search — Competitor Conquest", strategyType: "TARGET_CPA", hasTarget: true, conversions30d: 4, costMicros30d: 600_000_000 },
    FIXTURE.conversionLag, "yes");
  ok("a campaign under it may be proposed neither",
    thinCampaign.verdict === "below_minimum" && !thinCampaign.mayProposeBidTarget && !thinCampaign.mayProposeBudgetStep,
    `4 conversions, ${thinCampaign.shortBy} short`);
  ok("…and it says what it would take, in things somebody can do",
    whatItWouldNeed(thinCampaign).length >= 2
      && whatItWouldNeed(thinCampaign).some((l) => /portfolio/i.test(l)),
    "merging campaigns, a portfolio strategy, a shallower action, or a strategy with no target");

  const thinManual = biddingReadiness(
    { campaignId: "200", campaignName: "Search — Broad Prospecting", strategyType: "MANUAL_CPC", hasTarget: false, conversions30d: 4, costMicros30d: 600_000_000 },
    FIXTURE.conversionLag, "yes");
  ok("the SAME thin campaign bidding manually keeps its budget step",
    thinManual.verdict === "below_minimum" && thinManual.mayProposeBudgetStep,
    "nothing is learning, so nothing is reset — and budget is how a small account reaches the minimum in the first place");

  const blindCampaign = biddingReadiness(
    { campaignId: "100", campaignName: "Search — Core Services", strategyType: "TARGET_CPA", hasTarget: true, conversions30d: 36, costMicros30d: 2_400_000_000 },
    FIXTURE.conversionLag, "no");
  ok("36 conversions on a column that records nothing is not 36 conversions",
    blindCampaign.verdict === "column_unreadable" && blindCampaign.conversions30d === null
      && !blindCampaign.mayProposeBidTarget,
    "the count is composed from the tracking reading rather than re-decided here");

  const lateCampaign = biddingReadiness(
    { campaignId: "9", campaignName: "Late", strategyType: "TARGET_CPA", hasTarget: true, conversions30d: 80, costMicros30d: 900_000_000 },
    [{ campaignId: "9", bucket: "LESS_THAN_ONE_DAY", conversions: 10 }, { campaignId: "9", bucket: "THIRTY_TO_FORTY_FIVE_DAYS", conversions: 25 }],
    "yes");
  ok("volume alone does not clear the gate — a signal arriving a month late is refused at 80 conversions",
    lateCampaign.verdict === "stable" && lateCampaign.lagTooLong === true && !lateCampaign.mayProposeBidTarget,
    "this is the half of the OCH failure a conversion count alone never showed");

  const readyRow = a.find((f) => f.findingType === "bidding_not_ready");
  ok("the thin campaign on a target strategy gets a row of its own", Boolean(readyRow), readyRow?.title ?? "none");
  ok("…which proposes nothing and claims no money",
    readyRow?.changePayload === null && readyRow?.estImpactCents === 0 && readyRow?.applicability === "vendor");
  ok("…and names the published minimum as a published minimum, and the convention beside it as a convention",
    /published/i.test(readyRow?.impactAssumption ?? "") && /convention/i.test(readyRow?.impactAssumption ?? ""));
  ok("no bidding-readiness row on a campaign that is not on a target strategy",
    !a.some((f) => f.findingType === "bidding_not_ready" && f.entityName === "Search — Broad Prospecting"),
    "most campaigns on a book this size are under fifteen a month; a row on each is a row telling every client they are small");

  // THE GATE, ON A REAL RUN. Same campaign, same impression share, same
  // conversions — the budget step is proposed on one bidding strategy and
  // refused on another.
  // Six conversions a month, still converting UNDER the client's ceiling, and
  // still giving up a third of its impressions to budget — every reason to
  // raise it, and a target strategy that cannot survive being raised.
  const cappedThin: AuditInput = {
    ...FIXTURE,
    campaigns: FIXTURE.campaigns.map((c): CampaignRow => c.id === "100"
      ? { ...c, conversions: 6, costMicros: 500_000_000 }
      : c),
  };
  const gated = evaluate(cappedThin).find((f) => f.findingType === "budget_limited" && f.entityName === "Search — Core Services");
  ok("a budget step is refused on a budget-capped campaign whose target strategy is under the minimum",
    gated?.applicability === "vendor" && gated?.changePayload === null,
    gated?.title ?? "none");
  ok("…and the refusal says it is the learning period, not the API",
    /learning period/i.test(gated?.guardNote ?? ""), gated?.guardNote?.slice(0, 90) ?? "");
  const cappedThinManual = evaluate({
    ...FIXTURE,
    campaigns: FIXTURE.campaigns.map((c): CampaignRow => c.id === "100"
      ? { ...c, conversions: 6, costMicros: 500_000_000, bidStrategyType: "MANUAL_CPC", hasBidTarget: false }
      : c),
  }).find((f) => f.findingType === "budget_limited" && f.entityName === "Search — Core Services");
  ok("…and the identical campaign bidding manually still gets its budget step",
    cappedThinManual?.applicability === "api" && cappedThinManual?.changePayload !== null,
    "six conversions and a capped budget is exactly the campaign more budget might fix");

  // ── 13. How much of the spend the engine could actually see ──────────────
  console.log("\n14. Every query-based figure says what share of the money it looked at");

  const covered = spendVisibility({ campaignId: "1", campaignName: "c", channelType: "SEARCH", reportedTermCostMicros: 900_000_000, campaignCostMicros: 1_000_000_000 });
  ok("a campaign whose report accounts for most of its spend reads as covered and still names the rest",
    covered.verdict === "covered" && (covered.share ?? 0) >= LOW_COVERAGE_SHARE && Boolean(covered.caveat),
    covered.line);
  const partial = spendVisibility({ campaignId: "1", campaignName: "c", channelType: "SEARCH", reportedTermCostMicros: 500_000_000, campaignCostMicros: 1_000_000_000 });
  ok("half the spend showing up changes the claim rather than adding a footnote",
    partial.verdict === "partial" && /floor/.test(partial.caveat ?? ""), partial.caveat ?? "");
  const barely = spendVisibility({ campaignId: "1", campaignName: "c", channelType: "SEARCH", reportedTermCostMicros: 200_000_000, campaignCostMicros: 1_000_000_000 });
  ok("a fifth showing up says the figure is a small visible corner of the spend",
    barely.verdict === "barely" && (barely.share ?? 1) < BARELY_COVERED_SHARE, barely.caveat ?? "");
  ok("…and both name the causes without asserting one",
    /withheld for privacy/.test(partial.line) && /search partners/.test(barely.line),
    "the privacy threshold is one cause and search partners, display expansion and Performance Max are others");
  const display = spendVisibility({ campaignId: "1", campaignName: "c", channelType: "DISPLAY", reportedTermCostMicros: 0, campaignCostMicros: 1_000_000_000 });
  ok("a display campaign is not low-coverage, it has no search-terms report at all",
    display.verdict === "not_applicable" && display.share === null,
    "a nought there would read as a defect on a campaign that cannot have one");
  const notRead = spendVisibility({ campaignId: "1", campaignName: "c", channelType: "SEARCH", reportedTermCostMicros: null, campaignCostMicros: 1_000_000_000 });
  ok("a report that was not read is unread, never nought coverage",
    notRead.verdict === "unread" && notRead.share === null && Boolean(notRead.caveat));
  const tiny = spendVisibility({ campaignId: "1", campaignName: "c", channelType: "SEARCH", reportedTermCostMicros: 0, campaignCostMicros: 4_000_000 });
  ok("a four-dollar campaign gets no coverage share at all",
    tiny.verdict === "too_small", "a share off a handful of clicks is one rounding");

  ok("the search-term waste finding now says what share of the campaign's money it looked at",
    /shows up as a search term/.test(wasted!.evidence.lines.join(" "))
      && (wasted!.evidence.metrics.searchTermCoverageShare ?? 1) < LOW_COVERAGE_SHARE,
    `${Math.round((wasted!.evidence.metrics.searchTermCoverageShare ?? 0) * 100)}% of the campaign's spend`);
  ok("…and its dollar figure carries the share in the assumption rather than standing alone",
    /spend/.test(wasted!.impactAssumption) && /report/.test(wasted!.impactAssumption),
    wasted!.impactAssumption.slice(-120));
  ok("…and a list worked out over a quarter of the money is not the loudest row on the account",
    wasted!.severity === "medium",
    "it was high before the coverage was known, whatever its dollar figure said");
  const fullyVisible = evaluate({ ...FIXTURE, searchTermSpendByCampaign: { "100": 2_000_000_000, "200": 900_000_000, "300": 500_000_000 } })
    .find((f) => f.findingType === "wasted_search_term");
  ok("…and the same finding on a campaign the report DOES cover keeps its severity",
    fullyVisible?.severity === "high", "the rule is about what was seen, not about the terms");

  // ── 14. The column went quiet, and the platform can be told ───────────────
  console.log("\n15. A tracking break gets a date range, and a data exclusion goes through the guarded path");

  const outage = findTrackingOutage(FIXTURE.dailyConversions);
  ok("a run of zero-conversion days behind a healthy stretch is found, with a start and an end",
    outage.verdict === "found" && outage.startDate === "2026-09-05" && outage.days === 6,
    `${outage.startDate} → ${outage.endDate}, ${outage.days} days, ${outage.clicksInRun} clicks`);
  ok("…and it says how many conversions the account's OWN rate says are missing",
    outage.expectedConversions > 3 && outage.baselineDays >= 7,
    `about ${outage.expectedConversions.toFixed(1)} short, against ${outage.baselineDays} days of baseline`);
  ok("a quiet stretch too small to have swallowed anything is not a break",
    findTrackingOutage([
      ...Array.from({ length: 30 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, "0")}`, clicks: 20, conversions: 1, costMicros: 1_000_000 })),
      { date: "2026-09-01", clicks: 2, conversions: 0, costMicros: 100_000 },
    ]).verdict === "none",
    "two clicks over a weekend expected about a tenth of a conversion");
  ok("an account quiet across the whole window has no baseline and is told so, not given a date range",
    findTrackingOutage(Array.from({ length: 40 }, (_, i) => ({ date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`, clicks: 20, conversions: 0, costMicros: 1_000_000 }))).verdict === "no_baseline",
    "'it broke on this date' and 'it has never worked' are different answers and only one of them can be excluded");
  ok("a series that was never read is unread, never a clean account",
    findTrackingOutage(null).verdict === "unread" && findTrackingOutage(undefined).verdict === "unread");

  const longOutage = findTrackingOutage([
    ...Array.from({ length: 40 }, (_, i) => ({ date: new Date(Date.parse("2026-06-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10), clicks: 30, conversions: 2, costMicros: 5_000_000 })),
    ...Array.from({ length: 25 }, (_, i) => ({ date: new Date(Date.parse("2026-07-11T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10), clicks: 30, conversions: 0, costMicros: 5_000_000 })),
  ]);
  ok(`a break longer than the platform's ${MAX_DATA_EXCLUSION_DAYS}-day ceiling is REFUSED rather than truncated`,
    longOutage.verdict === "found" && !longOutage.exclusionExpressible && /at most/.test(longOutage.refusal ?? ""),
    "excluding the last fortnight of a 25-day outage leaves the rest in the model and reads as handled");

  const exclusionRow = a.find((f) => f.findingType === "bidding_data_exclusion");
  ok("the account gets one row carrying the dates", Boolean(exclusionRow), exclusionRow?.title ?? "none");
  ok("…and it is keyed on the break's START, so an outage that grows a day is the same row",
    (exclusionRow?.entityId ?? "").endsWith(":data_exclusion:2026-09-05"),
    "keying on the end would close one row and open another every week, each closure reading as 'the condition cleared'");
  ok("…and it claims no dollar saving",
    exclusionRow?.estImpactCents === 0 && /not what is recoverable/.test(exclusionRow?.impactAssumption ?? ""));
  const exclPayload = exclusionRow!.changePayload!;
  ok("…and it carries a change through the guarded path", exclPayload.op === "dataExclusions");
  const exclBody = (exclPayload.body as { campaigns: string[]; campaignNames: string[]; startDateTime: string; endDateTime: string }[])[0]!;
  ok("…scoped to the campaigns that actually bid on the conversion column",
    // Three, since v5's fixture added a fourth campaign that bids on
    // conversions. The count is incidental; what this asserts is that the
    // MANUALLY bid one is not in the list.
    exclBody.campaigns.length === 3 && !exclBody.campaignNames.includes("Search — Broad Prospecting"),
    `${exclBody.campaignNames.join(", ")} — a manually bid campaign is unaffected either way, so scoping one would be a change that does nothing`);
  ok("…and the plain English says the tag is still broken",
    /still broken/.test(exclPayload.plainEnglish), exclPayload.plainEnglish.slice(0, 110));
  ok("no exclusion is offered where nothing on the account bids on conversions",
    dataExclusionProposal(outage, [{ id: "1", name: "Manual", resourceName: "customers/1/campaigns/1", smartBidding: false }], { accountLabel: "the account", lagLine: null }) === null,
    "a button that does nothing is worse than no button");
  ok("…nor where the break is longer than the platform allows",
    dataExclusionProposal(longOutage, [{ id: "1", name: "S", resourceName: "customers/1/campaigns/1", smartBidding: true }], { accountLabel: "the account", lagLine: null }) === null);

  const exclCs: ChangeSet = { client: "(harness)", dataExclusions: exclPayload.body as ChangeSet["dataExclusions"] };
  const exclRec = recorder();
  const exclOut = await applyChangeSet(exclRec.customer, FIXTURE.accountId, exclCs, { apply: true, onLog: () => {} });
  ok("every mutate was preceded by its own validate_only, as for every other operation",
    exclRec.calls.length >= 2 && exclRec.calls[0]!.validateOnly && exclRec.calls.some((c) => !c.validateOnly),
    "the recorder throws otherwise");
  const exclPv = exclOut.priorValues.find((pv2) => pv2.kind === "data_exclusion_created");
  ok("…and the created exclusion's own resource name is recorded, so removing it is one step",
    exclPv?.kind === "data_exclusion_created" && exclPv.resourceNames.length > 0);
  const exclBack = recorder();
  const exclRb = await rollbackChangeSet(exclBack.customer, exclOut.priorValues as PriorValue[], { apply: false, onLog: () => {} });
  ok("…and rolling it back puts those days back in front of the bidding",
    exclRb.restored.some((r) => /counts those days again/.test(r)), exclRb.restored.join(" · "));

  // THE GUARD THIS OPERATION EXISTS WITH. Conversions backfill into the click's
  // own date, so a range that was empty when the audit ran can be full by the
  // time somebody presses Approve — and excluding it then throws away signal
  // that is really there, with nothing on any screen going red.
  const filledLines: string[] = [];
  const filled = await applyChangeSet(
    recorder({ conversionsInRange: 9 }).customer, FIXTURE.accountId, exclCs,
    { apply: true, onLog: (l: string) => filledLines.push(l) });
  ok("a date range that has since filled in with real conversions is REFUSED",
    !filled.priorValues.some((pv2) => pv2.kind === "data_exclusion_created"),
    "conversions arrive days after the click; excluding a range that has filled in throws real signal away");
  ok("…and the run says what moved",
    filledLines.some((l) => /filled in since/.test(l)), filledLines.join(" | ").slice(0, 130));

  const overlapLines: string[] = [];
  const overlapped = await applyChangeSet(
    recorder({ existingExclusions: [{ name: "Existing outage", start: "2026-09-01", end: "2026-09-09" }] }).customer,
    FIXTURE.accountId, exclCs, { apply: true, onLog: (l: string) => overlapLines.push(l) });
  ok("an overlapping exclusion already on the account is skipped, not duplicated",
    !overlapped.priorValues.some((pv2) => pv2.kind === "data_exclusion_created")
      && overlapLines.some((l) => /skipped, not duplicated/.test(l)),
    overlapLines.join(" | ").slice(0, 120));

  const futureLines: string[] = [];
  const future = await applyChangeSet(recorder().customer, FIXTURE.accountId, {
    client: "(harness)",
    dataExclusions: [{ ...exclBody, startDateTime: "2099-01-01 00:00:00", endDateTime: "2099-01-05 23:59:59", observedConversionsInRange: 0, name: "Future", reason: "r" }],
  }, { apply: true, onLog: (l: string) => futureLines.push(l) });
  ok("a range that is not yet over is refused — this is a retrospective correction, not a forecast",
    !future.priorValues.some((pv2) => pv2.kind === "data_exclusion_created")
      && futureLines.some((l) => /not yet over/.test(l)),
    futureLines.join(" | ").slice(0, 110));

  const longLines: string[] = [];
  const tooLong = await applyChangeSet(recorder().customer, FIXTURE.accountId, {
    client: "(harness)",
    dataExclusions: [{ ...exclBody, startDateTime: "2026-08-01 00:00:00", endDateTime: "2026-08-25 23:59:59", observedConversionsInRange: 0, name: "Long", reason: "r" }],
  }, { apply: true, onLog: (l: string) => longLines.push(l) });
  ok(`the ${MAX_DATA_EXCLUSION_DAYS}-day ceiling is enforced at the apply path too, not only at detection`,
    !tooLong.priorValues.some((pv2) => pv2.kind === "data_exclusion_created")
      && longLines.some((l) => /at most/.test(l)),
    "this function is the last thing standing between a proposal and a live account");

  // ── 15. What one lead is worth ───────────────────────────────────────────
  console.log("\n16. A proxy value on the conversion, and the absences it refuses to fill");

  const proxyRow = a.find((f) => f.findingType === "proxy_conversion_value");
  ok("an account with both figures and no value on the action gets a row", Boolean(proxyRow), proxyRow?.title ?? "none");
  ok("…carrying the modelled figure, with the word in the sentence",
    proxyRow!.evidence.lines.some((l) => /^Modelled, not measured/.test(l))
      && proxyRow!.evidence.metrics.modelledLeadValueCents === 12_000,
    "$2,400 a customer at a 5% close rate is $120 a lead");
  ok("…and the row proposes nothing, because setting a value changes what the account bids toward",
    proxyRow?.changePayload === null && proxyRow?.applicability === "vendor" && proxyRow?.estImpactCents === 0);
  ok("…and it does not claim the change is worth the lead value",
    /not what setting it is worth/.test(proxyRow?.impactAssumption ?? ""),
    "multiplying a lead value by a conversion count would claim the account gains the whole value of every lead");
  ok("…and it tells the person to leave the campaign alone afterwards",
    proxyRow!.evidence.lines.some((l) => /fortnight/.test(l)),
    "changing what a conversion is worth changes what the bidding optimises for");

  const noRate = proxyConversionValue({ customerValueCents: 240_000, customerValueFromClient: true, closeRatePct: null },
    [{ name: "Contact form", category: "SUBMIT_LEAD_FORM", countsIntoConversionsColumn: true, defaultValue: null, alwaysUseDefaultValue: null }],
    "yes", null);
  ok("a missing close rate names itself and produces no figure",
    noRate.state === "missing_inputs" && noRate.valueCents === null && noRate.missing.length === 1
      && /share of leads/.test(noRate.missing[0] ?? ""));
  ok("…and nothing here picks one",
    noRate.instruction.some((l) => /Nothing here will pick one/.test(l)),
    "a value that was guessed reads on a screen exactly like one the client gave us");
  const zeroes = proxyConversionValue({ customerValueCents: 0, customerValueFromClient: false, closeRatePct: 0 },
    [{ name: "Contact form", category: "LEAD", countsIntoConversionsColumn: true, defaultValue: null, alwaysUseDefaultValue: null }],
    "yes", null);
  ok("a nought in either column is the shape of the blank, never an answer",
    zeroes.state === "missing_inputs" && zeroes.missing.length === 2,
    "client_targets.cpl_ceiling_cents and friends are DEFAULT 0 and their own dialog says to leave a field at 0 to skip it");

  const withMeasured = proxyConversionValue(FIXTURE.economics, FIXTURE.tracking!.actions!.map((x) => ({
    name: x.name, category: x.category, countsIntoConversionsColumn: x.countsIntoConversionsColumn,
    defaultValue: null, alwaysUseDefaultValue: null,
  })), "yes", 320_000);
  ok("a measured value from the CRM is stated beside the modelled one and never blended with it",
    withMeasured.valueCents === 12_000
      && withMeasured.lines.some((l) => /is not averaged with it/.test(l)),
    "one is a price per lead off two typed numbers, the other a price per customer the CRM recorded");

  const valued = proxyConversionValue(FIXTURE.economics, [
    { name: "Contact form", category: "SUBMIT_LEAD_FORM", countsIntoConversionsColumn: true, defaultValue: 125, alwaysUseDefaultValue: true },
  ], "yes", null);
  ok("an account already carrying a value within a quarter of the modelled figure raises nothing",
    valued.state === "already_valued", `$125 against the modelled $${((valued.valueCents ?? 0) / 100).toFixed(2)}`);
  const disagrees = proxyConversionValue(FIXTURE.economics, [
    { name: "Contact form", category: "SUBMIT_LEAD_FORM", countsIntoConversionsColumn: true, defaultValue: 800, alwaysUseDefaultValue: true },
  ], "yes", null);
  ok("…and one a long way from it is its own finding, without saying which is right",
    disagrees.state === "disagrees" && disagrees.instruction.some((l) => /Settle which figure is correct/.test(l)));
  const shop = proxyConversionValue(FIXTURE.economics, [
    { name: "Purchase", category: "PURCHASE", countsIntoConversionsColumn: true, defaultValue: null, alwaysUseDefaultValue: null },
  ], "yes", null);
  ok("an account counting purchases is left alone — the platform already has the real amount",
    shop.state === "transaction_valued",
    "a modelled average over the top of a real transaction value is a worse number replacing a better one");
  const valuedPageViews = proxyConversionValue(FIXTURE.economics, [
    { name: "Thank you", category: "PAGE_VIEW", countsIntoConversionsColumn: true, defaultValue: null, alwaysUseDefaultValue: null },
  ], "no", null);
  ok("a column counting page views is never given a lead's value",
    valuedPageViews.state === "column_unreadable" && valuedPageViews.valueCents === null);
  ok("…and neither is one nobody checked",
    proxyConversionValue(FIXTURE.economics, null, "unknown", null).state === "column_unreadable");
  ok("a working account with a value already on it raises no row at all",
    evaluate({
      ...FIXTURE,
      tracking: { ...FIXTURE.tracking!, actions: FIXTURE.tracking!.actions!.map((x) => x.id === "500" ? { ...x, defaultValue: 125, alwaysUseDefaultValue: true } : x) },
    }).every((f) => f.findingType !== "proxy_conversion_value"),
    "three rows saying what one row already says is how a queue fills with advice nobody reads");

  // ── 15b. The enums these two readings turn on ────────────────────────────
  console.log("\n15b. The bidding strategy and the lag bucket are decoded before the rules see them");
  ok("the bidding strategy integer is decoded to the platform's own word",
    enumName(BIDDING_STRATEGY_TYPE, 6) === "TARGET_CPA" && enumName(BIDDING_STRATEGY_TYPE, "3") === "MANUAL_CPC");
  ok("the lag bucket integer is too",
    enumName(CONVERSION_LAG_BUCKET, 2) === "LESS_THAN_ONE_DAY" && enumName(CONVERSION_LAG_BUCKET, "18") === "THIRTY_TO_FORTY_FIVE_DAYS");
  ok("an undecoded strategy reads as no target strategy rather than as a target one",
    onTargetStrategy({ strategyType: "6", hasTarget: true }) === false,
    "which is why the adapter decodes: a campaign that needs the gate would otherwise never get it");
  ok("an undecoded lag bucket is counted as unmapped rather than guessed at",
    lagReading([{ campaignId: "1", bucket: "18", conversions: 100 }]).unmapped === 100);
  // A Search campaign arrives from the REST API as "2". Undecoded it matched no
  // channel name, so the coverage check treated every search campaign as one
  // with no search-terms report and skipped itself, while printing "no
  // search-terms report exists for a 2 campaign" on a real finding.
  ok("an undecoded channel type is not read as a campaign kind",
    enumName(ADVERTISING_CHANNEL_TYPE, 2) === "SEARCH" && enumName(ADVERTISING_CHANNEL_TYPE, "10") === "PERFORMANCE_MAX");
  ok("a search campaign gets its coverage measured rather than skipped",
    spendVisibility({ campaignId: "c1", campaignName: "Treatment Center Search", channelType: enumName(ADVERTISING_CHANNEL_TYPE, 2), campaignCostMicros: 100_000_000, reportedTermCostMicros: 80_000_000 }).verdict !== "not_applicable");
  ok("the platform declining to name the channel reads as unread, never as not applicable",
    spendVisibility({ campaignId: "c1", campaignName: "Treatment Center Search", channelType: "UNKNOWN", campaignCostMicros: 100_000_000, reportedTermCostMicros: null }).verdict === "unread");

  // ── 16. The queries that WORK ────────────────────────────────────────────
  // Seven of the eight original rules cut waste, and the search-term rule's
  // first line discards every query that converted. This section drives the
  // rule that reads the same report for the opposite thing, and most of it is
  // about what it must NOT propose.
  console.log("\n16. A query that converts and is not a keyword");
  const grown = evaluate(FIXTURE);
  const promo = grown.filter((f) => f.findingType === "converting_search_term");
  ok("the converting queries produce a row", promo.length === 1, promo[0]?.title ?? "none");
  const promoLines = promo[0]?.evidence.lines.join("\n") ?? "";
  // `lines` carries the proposals AND the sentence naming the switched-off
  // matches, so a test that greps the whole block cannot tell a proposal from a
  // refusal. `queries` is the proposal list and is what these assert on.
  const proposed = (promo[0]?.evidence.lines ?? []).filter((l) => /^\d/.test(l)).join("\n");
  ok("…naming the one query that clears both floors and is in no keyword at all",
    /emergency service downtown/.test(proposed) && promo[0]?.evidence.metrics.queryCount === 1);
  ok("…and not the one that is already a keyword in different case",
    !/Best Service Provider/i.test(proposed),
    "case and punctuation cannot hide a duplicate, or the rule proposes a keyword the account already holds");
  ok("…and not the one under the spend floor",
    !/urgent service quote/.test(promoLines),
    `${usd(PROMOTE_MIN_COST_MICROS)} over 90 days, the same floor the waste rule uses to decide a query is worth blocking`);
  ok("…and not the one that converted once",
    !/service repair cost/.test(promoLines),
    `conversions is a float, so under ${PROMOTE_MIN_CONVERSIONS} is one event or a share of somebody else's`);
  ok("…and never the client's protected brand",
    !/northgate clinic booking/.test(promoLines),
    "a protected pattern is the client's instruction to leave those queries alone, and a keyword changes how one is bid");
  ok("…and not the one that only converted on an action the account does not count",
    !/service brochure download/.test(promoLines),
    "the waste rule reads all_conversions so it never blocks a query producing business; this one reads the primary column, because a query the bidding cannot learn from is not one to bid on harder");
  ok("it checks the whole keyword list, not the spending one",
    Boolean(keywordIndex(FIXTURE.existingKeywords!)!.get("emergency service")),
    "keyword_view is filtered to cost_micros > 0, so a keyword taking no clicks is missing from it and would be proposed again");
  ok("IT CLAIMS NO DOLLAR, and says why",
    promo[0]?.estImpactCents === 0 && /counts? the same conversion twice/.test(promo[0]?.impactAssumption ?? ""),
    "the conversions already happen and are already in the campaign's own totals");
  ok("…and proposes nothing through the API",
    promo[0]?.changePayload === null && promo[0]?.applicability === "vendor",
    "a keyword needs an ad group, a match type and a bid chosen for it — three judgements, and none of them is in the guarded operation list");
  ok("an unread keyword list produces nothing at all",
    evaluate({ ...FIXTURE, existingKeywords: null }).every((f) => f.findingType !== "converting_search_term"),
    "a query cannot be called a gap in a list nobody could see");
  ok("…and so does a column that counts page views",
    queryPromotions({ terms: FIXTURE.searchTerms, existingKeywords: FIXTURE.existingKeywords!, columnCountsOutcomes: "no", protectedPatterns: [] }).verdict === "column_not_outcomes",
    "bidding deliberately on the queries producing the most page views is the finding doing active harm");
  ok("…and so does one nobody checked",
    queryPromotions({ terms: FIXTURE.searchTerms, existingKeywords: FIXTURE.existingKeywords!, columnCountsOutcomes: "unknown", protectedPatterns: [] }).verdict === "column_not_outcomes");
  ok("normalisation folds case, punctuation and spacing and nothing else",
    normalizeQueryText("[Emergency  Service!]") === "emergency service"
    && normalizeQueryText("+plumber \"near\" me") === "plumber near me"
    && normalizeQueryText("services") !== normalizeQueryText("service"),
    "it does not stem or fold plurals, so it says 'already there' less often than Google would — which proposes a redundant keyword rather than swallowing a real find");
  ok("the row says how many converting queries it checked and found already there",
    promo[0]?.evidence.metrics.alreadyKeywords === 2
    && promo[0]?.evidence.metrics.alreadyServing === 1
    && promo[0]?.evidence.metrics.alreadyDormant === 1,
    "a check nobody can see the result of is a check nobody trusts");

  // ── 16b. THE KEYWORD IN A PAUSED AD GROUP ────────────────────────────────
  // The reported failure, driven end to end. On 2026-09-23 a reviewer checked
  // this rule against a live account and found it telling somebody to add a
  // keyword that account already held — enabled, broad, verbatim — in an ad
  // group nobody had turned back on. The settings pull behind the dedupe was
  // filtered to enabled ad groups in enabled campaigns, so the one check whose
  // job is to see a duplicate was the one thing that could not see it, while
  // its own evidence line claimed it had checked every keyword in the account.
  //
  // Every figure here is a fixture. No ad account was read to write this.
  console.log("\n16b. A keyword that exists and cannot serve");
  const dormantRun = queryPromotions({
    terms: FIXTURE.searchTerms, existingKeywords: FIXTURE.existingKeywords!,
    columnCountsOutcomes: "yes", protectedPatterns: FIXTURE.protectedPatterns,
  });
  const proposedTerms = dormantRun.byCampaign.flatMap((c) => c.queries.map((q) => q.term.toLowerCase()));
  ok("A KEYWORD IN A PAUSED AD GROUP IS NEVER PROPOSED AS A NEW ONE",
    !proposedTerms.includes("same day service booking"),
    "it is enabled, broad and verbatim the query — creating a second copy is the duplicate this whole reading exists to prevent");
  ok("…and it is not filed away as a live duplicate either",
    dormantRun.dormant.some((d) => d.term === "same day service booking") && dormantRun.alreadyServing === 1,
    "a live duplicate means there is nothing to do; this means somebody already decided to bid on the query and switched it off");
  ok("…the row names where the existing keyword sits and which level is off",
    /Paused — Weekend Push/.test(promoLines) && /ad group is paused/.test(promoLines),
    "somebody has to find it before they can turn it back on");
  ok("…and says the work is turning it back on rather than adding another",
    /turning the existing keyword back on/i.test(promoLines)
    && /compete with the first/i.test(promoLines),
    "the reviewer's own reading: the fix is to reactivate the ad group or move the keyword");
  ok("a keyword in a paused CAMPAIGN is refused on the same rule",
    keywordCanServe(FIXTURE.existingKeywords!.find((k) => k.text === "weekend service call")!) === "no",
    "a second copy beside a paused one becomes a live duplicate the day anybody turns the paused one back on");
  ok("…and a status the platform did not report reads as unknown, never as enabled",
    keywordCanServe({ text: "x", matchType: "BROAD", adGroupName: null, campaignName: null }) === "unknown"
    && keywordCanServe({ text: "x", matchType: "BROAD", adGroupName: null, campaignName: null,
      criterionStatus: "ENABLED", adGroupStatus: "ENABLED", campaignStatus: "ENABLED" }) === "yes",
    "an unread status must not let this rule be confident about which of the two a match is");
  {
    // With no new query left to carry the sentence, the reading still has to
    // say the switched-off ones are there — otherwise the only case where the
    // dormant match is the WHOLE finding is the case that goes silent.
    const onlyDormant = queryPromotions({
      terms: FIXTURE.searchTerms.filter((t) => t.term === "same day service booking"),
      existingKeywords: FIXTURE.existingKeywords!,
      columnCountsOutcomes: "yes", protectedPatterns: [],
    });
    ok("with nothing new to propose, the silence names the switched-off keyword rather than closing",
      onlyDormant.verdict === "none"
      && /cannot serve/.test(onlyDormant.silence ?? "")
      && !/nothing to add\.$/.test(onlyDormant.silence ?? ""),
      "'every query is already a keyword, so there is nothing to add' was true of a live duplicate and false of a switched-off one");
  }

  // ── 16c. The quality-score count measures what it counts ─────────────────
  // It read the PERFORMANCE pull, which is filtered to keywords that spent and
  // cut at the top spenders, and published the answer as a total. The same
  // reviewer found an account with three keywords under the floor reported as
  // one. Fixture figures throughout.
  console.log("\n16c. Quality score is counted over the keywords it can see");
  const qs = grown.find((f) => f.findingType === "low_quality_score");
  ok("a keyword under the floor that took no clicks in the window IS counted",
    /emergency service/.test(qs?.evidence.lines.join("\n") ?? ""),
    "the performance pull does not hold it, and it is charged the relevance premium the moment it serves");
  ok("…so the count is every serving keyword under the floor, not every spending one",
    qs?.evidence.metrics.keywordCount === 2,
    "QS 3 on a keyword that spent and QS 2 on one that did not — the second is the one the old reading lost");
  ok("a keyword that cannot serve is left out of the count",
    !/weekend service call/.test(qs?.evidence.lines.join("\n") ?? "")
    && !/Paused — Weekend Push/.test(qs?.evidence.lines.join("\n") ?? ""),
    "it takes no clicks, so no relevance premium is being charged on it — this is the one place this reading stays narrow where the dedupe went wide");
  ok("THE COUNT CARRIES WHAT IT WAS COUNTED OVER",
    typeof qs?.evidence.metrics.keywordsRead === "number"
    && /with no spend filter and no row limit/.test(qs?.evidence.lines.join("\n") ?? ""),
    "a figure carries its basis or it is not printed");
  ok("…and names the keywords it could not score rather than counting them as nought",
    /carr(y|ies) no quality score yet/.test(qs?.evidence.lines.join("\n") ?? "")
    && typeof qs?.evidence.metrics.withoutAScore === "number",
    "Google reports no score until a keyword has served enough to earn one, so null is unanswered");
  {
    // Announced, never silent. With no settings list the count falls back to
    // the spenders, which is what it always read — and the title stops
    // claiming a total it did not measure.
    const noList = evaluate({ ...FIXTURE, existingKeywords: null });
    const qsFallback = noList.find((f) => f.findingType === "low_quality_score");
    ok("with no keyword list, the count falls back to the spenders AND SAYS SO",
      /^At least /.test(qsFallback?.title ?? "")
      && /floor rather than a total/.test(qsFallback?.evidence.lines.join("\n") ?? ""),
      "the reading is still worth having; a total it did not measure is not");
    ok("…and the fallback shows in the claim a person reads, not only in the lines",
      /floor rather than a total/.test(qsFallback?.impactAssumption ?? ""),
      "announce every fallback; never take one silently");
  }

  // ── 17. Converting profitably, with room to spend more ───────────────────
  console.log("\n17. A campaign converting under target with impressions to buy");
  const head = grown.filter((f) => f.findingType === "headroom");
  ok("the healthy campaign nothing spoke for gets a row", head.length === 1, head[0]?.title ?? "none");
  ok("…and it is the one that is neither budget-capped nor rank-limited",
    head[0]?.entityName === "Search — Service Areas",
    "5% lost to budget is under the budget rule's floor and 33% lost to rank is under the rank rule's, so every other rule was silent on it");
  ok("it names which lever, and it is not the budget",
    /Ad Rank/.test(head[0]?.title ?? "") && /what we are willing to pay/.test(head[0]?.summary ?? ""),
    "impressions are lost to the cap or to Ad Rank and the two have opposite fixes, so saying 'spend more' without saying which is not advice");
  ok("it claims LEADS, projected, never dollars",
    head[0]?.impactUnit === "leads_month" && head[0]!.estImpactCents > 0
    && /projection from this campaign's current performance, not a promise/.test(head[0]?.impactAssumption ?? ""));
  ok("…and says the projection is optimistic at both ends",
    /cost more per click than the ones it wins/.test(head[0]?.impactAssumption ?? "")
    && /Impression share lost is not demand handed over/.test(head[0]?.impactAssumption ?? ""),
    "diminishing returns are real: the auctions a campaign is missing are the ones it is being outbid in");
  ok("…and proposes no change",
    head[0]?.changePayload === null && head[0]?.applicability === "vendor",
    "a bid target has no guarded path here by design, and this campaign's cap is under the floor at which a budget move is proposed at all");
  ok("the extra-spend figure is the same arithmetic the budget rule uses",
    head[0]?.evidence.metrics.projectedExtraSpendMicros === Math.round(840_000_000 * 0.38 * 0.5),
    "two rules printing two different extra-spend figures for one campaign is the disagreement this codebase spends versions removing");

  const headBase = {
    campaignId: "9", campaignName: "T", costMicros: 840_000_000, conversions: 21,
    impressionShare: 0.54, budgetLostShare: 0.05, rankLostShare: 0.33,
    costPerConversionCents: 4_000, targetCents: 9_500, targetBasis: "stated" as const,
    budgetRuleFloor: THRESHOLDS.budgetLostShare, captureRate: 0.5,
    readiness: null, rankRuleAlsoFired: false,
  };
  ok("no target on the client's record means no reading, and it says which figures are missing",
    headroomReading({ ...headBase, targetCents: null, targetBasis: null }).verdict === "cant_tell"
    && /cost-per-lead ceiling, or a customer value and a close rate/.test(headroomReading({ ...headBase, targetCents: null, targetBasis: null }).silence ?? ""),
    "nothing here invents a threshold to measure a margin against");
  ok("a campaign at its target is not headroom",
    headroomReading({ ...headBase, costPerConversionCents: 9_000 }).verdict === "at_or_over_target",
    `inside ${Math.round((1 - HEADROOM_COMFORT_RATIO) * 100)}% of the target, one conversion either way puts it over`);
  ok("…and neither is one with too few conversions to hold a cost per conversion still",
    headroomReading({ ...headBase, conversions: 4 }).verdict === "too_few_conversions",
    `${HEADROOM_MIN_CONVERSIONS} is where a one-conversion swing is a fifth, which is the margin the ratio demands`);
  ok("…and neither is one already taking what is there",
    headroomReading({ ...headBase, impressionShare: 0.95, budgetLostShare: 0.02, rankLostShare: 0.03 }).verdict === "no_room",
    `under ${Math.round(HEADROOM_MIN_LOST_SHARE * 100)}% there is nothing that could absorb meaningful extra spend`);
  ok("a campaign the budget rule already fired on is left to that row",
    headroomReading({ ...headBase, budgetLostShare: 0.31 }).verdict === "budget_rule_owns_it",
    "two rows proposing the same rise is how a queue fills with advice nobody reads");
  ok("neither lost share reported is unreadable, never nought",
    headroomReading({ ...headBase, budgetLostShare: null, rankLostShare: null }).verdict === "cant_tell",
    "1 minus the impression share is lost to SOMETHING, and which of the two decides the whole recommendation");
  ok("an unreadable cost per conversion produces nothing",
    headroomReading({ ...headBase, costPerConversionCents: null }).verdict === "cant_tell");
  ok("THE BIDDING GATE HOLDS HERE TOO",
    headroomReading({
      ...headBase,
      readiness: biddingReadiness(
        { campaignId: "9", campaignName: "T", strategyType: "TARGET_CPA", hasTarget: true, conversions30d: 6, costMicros30d: 840_000_000 },
        null, "yes"),
    }).blockers.some((b) => /does not have the conversions to survive one/.test(b)),
    "a target change on a campaign under the published minimum restarts a learning period it cannot finish — composed from biddingReadiness, not re-decided");

  // ── 18. One campaign's findings, read together ───────────────────────────
  console.log("\n18. The order to do a campaign's findings in");
  const c100 = grown.filter((f) => f.campaignId === "100");
  const stages100 = c100.map((f) => stageOf(f.findingType));
  const stageRank: Record<string, number> = { stop: 0, measure: 1, improve: 2, grow: 3 };
  ok("a campaign's rows come out stop → measure → improve → grow",
    stages100.every((st, idx) => idx === 0 || stageRank[stages100[idx - 1]!]! <= stageRank[st]!),
    `${c100.map((f) => `${f.findingType}(${stageOf(f.findingType)})`).join(" · ")}`);
  ok("…so stopping the waste comes before adding money to the same campaign",
    c100.findIndex((f) => f.findingType === "wasted_search_term") < c100.findIndex((f) => f.findingType === "converting_search_term"),
    "doing them the other way round funds the waste before stopping it");
  const grow100 = c100.find((f) => stageOf(f.findingType) === "grow");
  ok("the grow row says what it is waiting on, naming it",
    /Do this after the money going out for nothing is stopped: "/.test(grow100?.evidence.lines.at(-1) ?? ""),
    grow100?.evidence.lines.at(-1) ?? "no clause");
  ok("…in ONE clause, and only on the row that has something ahead of it",
    grown.filter((f) => f.evidence.lines.some((l) => /^Do this after /.test(l))).every((f) => stageOf(f.findingType) === "grow")
    && grown.every((f) => f.evidence.lines.filter((l) => /^Do this after /.test(l)).length <= 1),
    "a badge on every row flattens the only distinction that matters");
  ok("NOTHING IS SUPPRESSED",
    sequenceFindings(grown).length === grown.length
    && new Set(sequenceFindings(grown).map((f) => `${f.entityId}|${f.findingType}`)).size
       === new Set(grown.map((f) => `${f.entityId}|${f.findingType}`)).size,
    "a hidden row is worse than a badly ordered one");
  ok("…and nothing is re-priced or re-severitied",
    sequenceFindings(grown).every((f) => {
      // Identity is entity AND type: `budget_limited`, `no_conversions` and
      // `rank_limited` all key on the bare campaign id.
      const was = grown.find((g) => g.entityId === f.entityId && g.findingType === f.findingType)!;
      return was.estImpactCents === f.estImpactCents && was.severity === f.severity && was.riskLevel === f.riskLevel;
    }),
    "est_impact_cents carries a basis, so nudging one to move a row up the queue would make a figure mean two things");
  ok("the clause is on the evidence LINES, never the metrics",
    grown.every((f) => Object.keys(f.evidence.metrics).every((k) => !/^Do this after/.test(k)))
    && evidenceHash(grown.find((f) => f.findingType === "wasted_search_term")!.evidence.metrics)
       === evidenceHash(evaluate(FIXTURE).find((f) => f.findingType === "wasted_search_term")!.evidence.metrics),
    "the hash is what decides whether a dismissed finding comes back, and a sentence must never be able to resurrect one");
  ok("a campaign with only one stage on it gets no clause",
    grown.filter((f) => f.campaignId === "400").every((f) => !f.evidence.lines.some((l) => /^Do this after /.test(l))),
    "campaign 400 carries the headroom row and nothing else, so there is nothing for it to wait for");
  ok("an account-level row is never told to wait for a campaign's work",
    grown.filter((f) => f.entityType === "account").every((f) => !f.evidence.lines.some((l) => /^Do this after /.test(l))));
  ok("the group holding the biggest single figure still comes first",
    grown[0]!.estImpactCents === Math.max(...grown.map((f) => f.estImpactCents)),
    "the queue reads the same at the top as it did before");
  ok("…and calling it twice adds nothing",
    JSON.stringify(sequenceFindings(sequenceFindings(grown))) === JSON.stringify(sequenceFindings(grown)),
    "a pure function that grows a line every time it is called is one somebody will call twice and not find out for a month");
  ok("the pass is stable, so two runs order identically",
    JSON.stringify(sequenceFindings(grown)) === JSON.stringify(sequenceFindings([...grown])),
    "the determinism check one section up depends on it");
  ok("a finding type nobody has placed sits in the middle",
    stageOf("something_new_entirely") === DEFAULT_STAGE && DEFAULT_STAGE === "improve",
    "it must not jump ahead of waste-stopping and must not be pushed past a budget rise either");
  ok("every finding type this engine produces has a declared stage",
    Array.from(new Set(grown.map((f) => f.findingType))).every((t) => FINDING_STAGE[t] != null),
    Array.from(new Set(grown.map((f) => f.findingType))).filter((t) => FINDING_STAGE[t] == null).join(", ") || "all declared");


  // ── 19. Is a term something this client actually sells? ──────────────────
  console.log(`\n${"─".repeat(72)}\n19. Relevance — a recorded answer, never a guess\n${"─".repeat(72)}`);
  {
    const confirmed: ClientServiceFacts = {
      services: [{ name: "Commercial Roofing", note: null }, { name: "Gutter Installation", note: null }],
      confirmedBy: "Katy Adams", confirmedAt: "2026-09-20", candidatesWaiting: 2,
    };
    const nobody: ClientServiceFacts =
      { services: null, confirmedBy: null, confirmedAt: null, candidatesWaiting: 5 };
    const proven = [{ term: "commercial roofing contractors", conversions: 6 }];

    ok("a term that covers a confirmed service is relevant",
      relevanceOf("emergency commercial roofing repair", confirmed, proven).verdict === "matched");
    ok("…and it names WHICH service, so the row can say why it is there",
      relevanceOf("emergency commercial roofing repair", confirmed, proven).service === "Commercial Roofing");
    ok("a term missing a word that says which half of the market they are in is NOT relevant",
      relevanceOf("residential roofing repair", confirmed, proven).verdict === "unmatched",
      '"Commercial Roofing" must not match "residential roofing" — that is the failure this whole gate exists for');
    ok("containment runs one way only",
      termCoversService("emergency commercial roofing", "commercial roofing")
      && !termCoversService("roofing", "commercial roofing"));
    ok("case, punctuation and spacing fold and nothing else does",
      termCoversService("COMMERCIAL-ROOFING!! repair", "Commercial Roofing")
      && !termCoversService("commercial roofs", "commercial roofing"),
      "no stemming and no plurals, so a person decides rather than the matcher");
    ok("a converting query under the same service is named as proof",
      relevanceOf("commercial roofing installation", confirmed, proven).provenBy === "commercial roofing contractors");
    ok("…and its absence is not a mark against the term",
      relevanceOf("gutter installation cost", confirmed, proven).verdict === "matched"
      && relevanceOf("gutter installation cost", confirmed, proven).provenBy === null);
    ok("NO CONFIRMED LIST MEANS NO ANSWER AT ALL",
      relevanceOf("commercial roofing", nobody, proven).verdict === "no_services_recorded",
      "not a volume fallback, not the seeds — the reading is refused");
    ok("…and a converting query cannot let one through on its own",
      relevanceOf("commercial roofing contractors", nobody, proven).verdict === "no_services_recorded",
      "a single-term exception would be the volume-only fallback under another name");
    ok("an empty list is treated the same as none",
      relevanceOf("anything", { ...confirmed, services: [] }, proven).verdict === "no_services_recorded");
    ok("a service too short to match safely matches nothing",
      !termCoversService("ac repair near me", "AC"),
      `under ${MIN_SERVICE_TOKEN_LENGTH} characters an abbreviation appears inside ordinary words`);
    ok("the relevance line names the record and the person",
      /Commercial Roofing/.test(relevanceLine(relevanceOf("commercial roofing repair", confirmed, proven), confirmed))
      && /Katy Adams/.test(relevanceLine(relevanceOf("commercial roofing repair", confirmed, proven), confirmed)));
    ok("the refusal says where to answer it and counts what is waiting",
      /client page/i.test(noServicesLine(nobody)) && /5 candidate/.test(noServicesLine(nobody)));

    // ── 20. The gap reading itself ─────────────────────────────────────────
    console.log(`\n${"─".repeat(72)}\n20. What the account is not bidding on\n${"─".repeat(72)}`);
    const research: ResearchFacts = {
      ranAt: "2026-09-15", location: "United States", seeds: ["commercial roofing", "gutters"],
      keywords: [
        // Relevant, uncovered, priced — the row this exists to produce.
        { keyword: "commercial roofing contractors near me", volume: 2_400, cpcDollars: 18.5, difficulty: 42, intent: "commercial", clientRank: 14, competitorRank: null },
        { keyword: "commercial roofing replacement cost", volume: 880, cpcDollars: 12.0, difficulty: 38, intent: "commercial", clientRank: null, competitorRank: 3 },
        // Relevant but already a keyword in the account.
        { keyword: "commercial roofing", volume: 5_000, cpcDollars: 20, difficulty: 50, intent: "commercial", clientRank: 9, competitorRank: null },
        // Relevant but already seen in the search-terms report.
        { keyword: "commercial roofing contractors", volume: 1_100, cpcDollars: 17, difficulty: 40, intent: "commercial", clientRank: null, competitorRank: null },
        // Under the per-term floor.
        { keyword: "commercial roofing warranty transfer", volume: 40, cpcDollars: 9, difficulty: 10, intent: "informational", clientRank: null, competitorRank: null },
        // Huge and NOT something they sell. The one that must never appear.
        { keyword: "roofing jobs hiring", volume: 33_000, cpcDollars: 4, difficulty: 20, intent: "informational", clientRank: null, competitorRank: null },
        // Relevant to the second service but under the per-service floor.
        { keyword: "gutter installation near me", volume: 150, cpcDollars: 8, difficulty: 25, intent: "commercial", clientRank: null, competitorRank: null },
      ],
    };
    const gapInput = {
      research, services: confirmed,
      existingKeywords: [{ text: "Commercial Roofing", matchType: "PHRASE", adGroupName: "Core", campaignName: "Search" }],
      seenTerms: ["commercial roofing contractors", "flat roof repair"],
      existingNegatives: new Set<string>(["jobs"]),
      provenQueries: proven,
      protectedPatterns: [] as string[],
      accountTermCoverage: 0.82,
    };
    const gaps = keywordGaps(gapInput);
    ok("a service with uncovered demand over the floors produces one row",
      gaps.verdict === "found" && gaps.services.length === 1 && gaps.services[0]!.service === "Commercial Roofing");
    ok("…and it is ONE row per service, not one per term",
      gaps.services[0]!.terms.length === 2,
      "a category nobody bids on, not a list of phrases");
    ok("a term with 33,000 searches for something they do not sell is DROPPED",
      gaps.services.every((g) => g.terms.every((t) => !/jobs/.test(t.keyword))) && gaps.droppedAsIrrelevant >= 1,
      "volume is not relevance, and this is the row that would discredit the page");
    ok("a term already in the account as a keyword is not a gap",
      gaps.services[0]!.terms.every((t) => t.keyword !== "commercial roofing"));
    ok("a term the account has been SEEN on is not a gap",
      gaps.services[0]!.terms.every((t) => t.keyword !== "commercial roofing contractors"));
    ok("a term under the per-term volume floor is not a gap",
      gaps.services[0]!.terms.every((t) => t.volume >= GAP_MIN_TERM_VOLUME));
    ok("a service whose uncovered demand is under the per-service floor raises nothing",
      gaps.services.every((g) => g.service !== "Gutter Installation" && g.totalVolume >= GAP_MIN_SERVICE_VOLUME));
    ok("the figure is searches x click rate x cost per click, and nothing else",
      gaps.services[0]!.marketCostCents === Math.round(2_400 * GAP_CLICK_RATE * 18.5 * 100) + Math.round(880 * GAP_CLICK_RATE * 12 * 100));
    ok("…and the claim says it is the SIZE of the demand rather than a gain",
      /size of what is uncovered/i.test(gapClaim(gaps.services[0]!, gaps.coverageTrusted))
      && !/would earn|this client would make|revenue/i.test(gapClaim(gaps.services[0]!, gaps.coverageTrusted)));
    ok("the row says what makes it relevant",
      gaps.services[0]!.lines.some((l) => /Relevant because/.test(l)));
    ok("…and names the converting query that proves the service sells here",
      gaps.services[0]!.lines.some((l) => /commercial roofing contractors/.test(l) && /enquiries/.test(l)));
    ok("no confirmed list means no reading at all",
      keywordGaps({ ...gapInput, services: nobody }).verdict === "no_services_recorded");
    ok("…and no gap rows are produced on that verdict",
      keywordGaps({ ...gapInput, services: nobody }).services.length === 0,
      "a plausible list of services a client does not offer is worse than no list");
    ok("no stored research means no reading, named",
      keywordGaps({ ...gapInput, research: { ...research, keywords: null } }).verdict === "no_research");
    ok("an unread keyword list means nothing can be called missing from it",
      keywordGaps({ ...gapInput, existingKeywords: null }).verdict === "keywords_unread",
      "the same refusal query-promotion makes, for the same reason");
    ok("a negative somebody added deliberately blocks the term rather than raising it",
      keywordGaps({
        ...gapInput,
        existingNegatives: new Set<string>(["cost"]),
      }).services[0]!.terms.every((t) => !/cost/.test(t.keyword)));
    ok("thin search-term coverage weakens the row in words",
      /may already be reached/i.test(gapClaim(
        keywordGaps({ ...gapInput, accountTermCoverage: 0.2 }).services[0]!,
        keywordGaps({ ...gapInput, accountTermCoverage: 0.2 }).coverageTrusted)),
      "'we have not seen it' is only as good as what the report saw");
    ok("every service covered is a real answer and says how many were checked",
      keywordGaps({ ...gapInput, seenTerms: research.keywords!.map((k) => k.keyword) }).verdict === "covered");

    // ── 20b. A SERVICES LIST IS NOT A KEYWORD STRATEGY (2026-09-23) ────────
    //
    // The company owner, handed a proposal built out of a real client's own
    // service list: "keywords like day program won't do anything for our
    // keywords when not more tightly associated to the core services — in fact
    // it will likely burn spend." The list parsed correctly. What was wrong is
    // that a recorded service was being treated as a research seed, and those
    // are two different things.
    //
    // The rule is `service-seed.ts`, copied byte for byte into the app's
    // shared/ so the review a person ticks and this run cannot disagree. What
    // matters here is the BOUNDARY: it skips SEEDING and it changes nothing
    // else about a recorded service.
    //
    // Every service and every figure below is invented. Nothing was read from
    // production and no ad account was touched.
    const roofList = [
      "roofing services", "gutter services", "emergency services", "inspection services",
      "roofing repair", "roofing replacement", "skylight installation",
      "flat roof coating", "day services", "commercial roofing", "gutter installation",
    ];
    const seedFacts: ClientServiceFacts = {
      services: roofList.map((name) => ({ name, note: null })),
      confirmedBy: "Katy Adams", confirmedAt: "2026-09-20", candidatesWaiting: 0,
    };
    const split = splitSeeds(seedFacts.services!, {
      accountTerms: proven.map((q) => q.term),
      research: research.keywords!.map((k) => ({ keyword: k.keyword, intent: k.intent, volume: k.volume })),
    });
    ok("a phrase that names the shape and nothing it is for is not researched from",
      split.skipped.some((x) => x.service === "day services"),
      split.skipped.map((x) => `${x.service} (${x.mark})`).join(", ") || "nothing skipped");
    ok("…and a phrase carrying a subject still is",
      split.seeds.includes("commercial roofing") && split.seeds.includes("gutter installation"),
      "a rule that eats a real service is worse than the broad seed it removes");
    ok("every skip is NAMED, with what is wrong and what it was measured from",
      split.skipped.every((x) => Boolean(x.service && x.mark && x.line && x.basis)));
    ok("…and the line the run and the queue both print names them",
      /day services/.test(skippedSeedsLine(split.skipped) ?? ""));

    // A RESEARCH TERM ONLY A WEAK SEED COVERS. This is the row somebody would
    // act on: 900 searches a month, and the only recorded service that lets it
    // through names a shape and nothing it is for.
    const seedResearch = {
      ...research,
      keywords: [
        ...research.keywords!,
        { keyword: "same day services near me", volume: 900, cpcDollars: 6, difficulty: 20,
          intent: "commercial", clientRank: null, competitorRank: null },
      ],
    };
    const seedGaps = keywordGaps({ ...gapInput, services: seedFacts, research: seedResearch });
    ok("the reading carries every skipped seed so nothing is dropped in silence",
      seedGaps.skippedSeeds.length === split.skipped.length && seedGaps.skippedSeeds.length > 0);
    ok("a research term only a weak seed covers is dropped, never raised",
      seedGaps.services.every((g) => g.terms.every((t) => t.keyword !== "same day services near me"))
      && seedGaps.droppedAsIrrelevant >= 1,
      "this is the row somebody would have bought traffic on");

    // EVERY CONFIRMED SERVICE TOO BROAD TO SEED IS ITS OWN ANSWER, and it is
    // not the same answer as nobody having recorded anything. Somebody DID the
    // work; the list they wrote cannot carry a keyword strategy.
    const allBroad: ClientServiceFacts = {
      ...seedFacts,
      services: [{ name: "day and evening", note: null }, { name: "individual", note: null }],
    };
    const broadGaps = keywordGaps({ ...gapInput, services: allBroad });
    ok("every service being too broad is a DIFFERENT refusal from nobody recording one",
      broadGaps.verdict === "no_usable_seeds" && broadGaps.services.length === 0);
    ok("…and it names each one and says the services are still recorded",
      /day and evening/.test(broadGaps.silence ?? "") && /still recorded/i.test(broadGaps.silence ?? ""));
    ok("…and it never reads as nobody having done the work",
      !/nobody has/i.test(broadGaps.silence ?? "") && !/nothing on this client's record/i.test(broadGaps.silence ?? ""));

    // THE BOUNDARY. Seeding and suppression are separate jobs. Nothing here
    // touches what a recorded service rules out, and a client who does not
    // offer a broad category is entitled to rule it out broadly.
    ok("a weak seed is still a recorded service — nothing here removes or rewrites one",
      seedFacts.services!.some((x) => x.name === "day services")
      && split.skipped.length + split.seeds.length === seedFacts.services!.length,
      "every service is accounted for on one side or the other");
    ok("…and a phrase nobody can judge seeds exactly as it did before",
      splitSeeds([{ name: "partial hospitalization" }], { accountTerms: [], research: null }).seeds.length === 1,
      "a null is unanswered and is never a no");

    // ── 21. What has to exist before traffic is worth sending ──────────────
    console.log(`\n${"─".repeat(72)}\n21. Traffic readiness\n${"─".repeat(72)}`);
    ok("a bare site root is a bare site root, however it is written",
      isSiteRoot("https://example.com") && isSiteRoot("example.com/") && isSiteRoot("http://example.com"));
    ok("…and anything with a path, a query or a fragment is not",
      !isSiteRoot("https://example.com/commercial-roofing")
      && !isSiteRoot("https://example.com/?utm=x") && !isSiteRoot("https://example.com/#quote"));

    const readinessCampaigns = [
      { id: "100", name: "Search — Core Services", costMicros: 2_400_000_000, channelType: "SEARCH" },
      { id: "200", name: "Search — Parked", costMicros: 1_000_000, channelType: "SEARCH" },
    ];
    const allRoot = trafficReadiness({
      campaigns: readinessCampaigns,
      destinations: [
        { campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", finalUrl: "https://example.com/" },
        { campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", finalUrl: "https://example.com" },
      ],
      conversionActions: [{ id: "1", name: "Form", status: "ENABLED", category: "SUBMIT_LEAD_FORM", actionType: "WEBPAGE", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 40 }],
      phone: { phoneLeads: 44, totalLeads: 70 },
      campaignMinSpendMicros: THRESHOLDS.campaignMinSpendMicros,
      windowDays: 30,
    });
    const lp = allRoot.find((r) => r.key === "generic_landing_page" && r.campaignId === "100")!;
    ok("a campaign whose every ad points at the front page is a finding", lp.state === "open");
    ok("…and its figure is the campaign's own monthly spend, at stake rather than saved",
      lp.atStakeCents === Math.round((2_400_000_000 / 10_000) * 1));
    ok("a campaign under the spend floor raises nothing",
      !allRoot.some((r) => r.campaignId === "200"),
      "a parked campaign produces the same row as a live one otherwise");
    const mixed = trafficReadiness({
      campaigns: readinessCampaigns,
      destinations: [
        { campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", finalUrl: "https://example.com/" },
        { campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", finalUrl: "https://example.com/roofing" },
      ],
      conversionActions: [], phone: { phoneLeads: 1, totalLeads: 70 },
      campaignMinSpendMicros: THRESHOLDS.campaignMinSpendMicros, windowDays: 30,
    });
    ok("a campaign with a mix of pages is CLEAR rather than absent",
      mixed.find((r) => r.key === "generic_landing_page")!.state === "clear",
      "silence is not a pass — the reading answers clear, open or cant_tell on every check");
    const unreadUrls = trafficReadiness({
      campaigns: readinessCampaigns,
      destinations: [{ campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", finalUrl: null }],
      conversionActions: null, phone: null,
      campaignMinSpendMicros: THRESHOLDS.campaignMinSpendMicros, windowDays: 30,
    });
    ok("an unread final URL is cant_tell and never a good landing page",
      unreadUrls.find((r) => r.key === "generic_landing_page")!.state === "cant_tell");
    ok("unread conversion actions are cant_tell too",
      unreadUrls.find((r) => r.key === "call_tracking_absent")!.state === "cant_tell");
    const call = allRoot.find((r) => r.key === "call_tracking_absent")!;
    ok("an account whose enquiries are mostly calls and which counts none is a finding",
      call.state === "open" && 44 / 70 >= CALL_TRACKING_PHONE_SHARE);
    ok("…and an account that DOES count calls is clear",
      trafficReadiness({
        campaigns: readinessCampaigns, destinations: [],
        conversionActions: [{ id: "2", name: "Calls", status: "ENABLED", category: "PHONE_CALL_LEAD", actionType: "WEBPAGE", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 12 }],
        phone: { phoneLeads: 44, totalLeads: 70 },
        campaignMinSpendMicros: THRESHOLDS.campaignMinSpendMicros, windowDays: 30,
      }).find((r) => r.key === "call_tracking_absent")!.state === "clear");
    ok("too few leads to read a share is cant_tell rather than clear",
      trafficReadiness({
        campaigns: readinessCampaigns, destinations: [], conversionActions: [],
        phone: { phoneLeads: 3, totalLeads: CALL_TRACKING_MIN_LEADS - 1 },
        campaignMinSpendMicros: THRESHOLDS.campaignMinSpendMicros, windowDays: 30,
      }).find((r) => r.key === "call_tracking_absent")!.state === "cant_tell");
    ok("a lead feed that was not read is never reported as no calls",
      trafficReadiness({
        campaigns: readinessCampaigns, destinations: [], conversionActions: [],
        phone: { phoneLeads: null, totalLeads: null },
        campaignMinSpendMicros: THRESHOLDS.campaignMinSpendMicros, windowDays: 30,
      }).find((r) => r.key === "call_tracking_absent")!.state === "cant_tell");

    // ── 22. One measure, so a queue can be ordered ─────────────────────────
    console.log(`\n${"─".repeat(72)}\n22. The ranking\n${"─".repeat(72)}`);
    const rich: ClientEconomics = {
      customerValueCents: 400_000, customerValueFromClient: true,
      closeRatePct: 25, cplCeilingCents: 9_500, cplCeilingMonth: "2026-09",
    };
    const bare: ClientEconomics = {
      customerValueCents: null, customerValueFromClient: false,
      closeRatePct: null, cplCeilingCents: null, cplCeilingMonth: null,
    };
    const richTargets = costTargets(rich);
    const bareTargets = costTargets(bare);

    ok("a lead is worth the same in a rank as in a cost target",
      leadValueCents(richTargets) === governingTarget(costTargets(rich).filter((t) => t.basis === "modelled"))!.cents,
      "composed from costTargets rather than worked out again from the same columns");
    const waste = rankImpact({ findingType: "wasted_search_term", estImpactCents: 64_500, impactUnit: "usd_month" }, richTargets, rich, null);
    ok("a waste row ranks on the money it keeps", waste.cents === 64_500 && waste.basis === "recoverable");
    const head = rankImpact({ findingType: "headroom", estImpactCents: 2_100, impactUnit: "leads_month" }, richTargets, rich, null);
    ok("a LEADS row is turned into money through the client's own figures",
      head.cents === Math.round(21 * (400_000 * 0.25)) && head.basis === "projected");
    ok("…and it beats the waste row, which is the whole defect",
      head.cents! > waste.cents!,
      "a $645 saving used to outrank a growth finding worth three times it because one column held two units");
    ok("a row that claims nothing on purpose still ranks, on what is already riding on it",
      rankImpact({ findingType: "converting_search_term", estImpactCents: 0, impactUnit: "usd_month" }, richTargets, rich, 80_000).basis === "at_stake",
      "the conversions already happen, so pricing them as a gain counts one twice");
    ok("…and that row's figure is the money at stake, not a gain",
      rankImpact({ findingType: "converting_search_term", estImpactCents: 0, impactUnit: "usd_month" }, richTargets, rich, 80_000).cents === 80_000);
    ok("a leads row on a client with no recorded value is UNPRICED and names the figure",
      rankImpact({ findingType: "headroom", estImpactCents: 2_100, impactUnit: "leads_month" }, bareTargets, bare, null).basis === "unpriced"
      && /what one customer is worth/.test(rankImpact({ findingType: "headroom", estImpactCents: 2_100, impactUnit: "leads_month" }, bareTargets, bare, null).why));
    ok("…and it is not given a nought, which would sink it silently",
      rankImpact({ findingType: "headroom", estImpactCents: 2_100, impactUnit: "leads_month" }, bareTargets, bare, null).cents === null);
    ok("a measurement row has no size in money and is not pretended to",
      rankImpact({ findingType: "conversion_tracking_gap", estImpactCents: 0, impactUnit: "usd_month" }, richTargets, rich, null).basis === "none");
    ok("a type nobody has placed claims no money",
      rankBasisOf("something_new_entirely") === DEFAULT_RANK_BASIS && DEFAULT_RANK_BASIS === "none");
    ok("a figure is never printed without the word that says what it is",
      rankedAmount({ cents: 64_500, basis: "recoverable" }).includes("recoverable")
      && rankedAmount({ cents: 64_500, basis: "projected" }).includes("projected")
      && rankedAmount({ cents: 64_500, basis: "at_stake" }).includes("at stake"));
    ok("…and an unpriced row prints a word rather than a number",
      !/\d/.test(rankedAmount({ cents: null, basis: "unpriced" })));

    const ranked = evaluate({ ...FIXTURE, services: confirmed, research, phone: { phoneLeads: 44, totalLeads: 70 } });
    ok("every finding the engine produces carries a rank reading",
      ranked.every((f) => f.rank != null));
    ok("…and every type it produces has a declared basis",
      Array.from(new Set(ranked.map((f) => f.findingType))).every((t) => RANK_BASIS[t] != null || stageOf(t) != null),
      Array.from(new Set(ranked.map((f) => f.findingType))).filter((t) => RANK_BASIS[t] == null).join(", ") || "all placed or deliberately none");
    ok("the ranking changes no figure, no severity and no risk",
      ranked.every((f, i) => {
        const plain = evaluate({ ...FIXTURE, services: confirmed, research, phone: { phoneLeads: 44, totalLeads: 70 } })[i]!;
        return f.estImpactCents === plain.estImpactCents && f.severity === plain.severity && f.riskLevel === plain.riskLevel;
      }));
    ok("an unpriced row does not move its campaign group",
      sequenceFindings(ranked).length === ranked.length,
      "nothing is suppressed; a row this engine could not price keeps its group and its stage");
    ok("the keyword-gap row reaches the engine's output",
      ranked.some((f) => f.findingType === "keyword_gap"));
    ok("…and the whole account falls silent on it with no confirmed services",
      !evaluate({ ...FIXTURE, services: nobody, research }).some((f) => f.findingType === "keyword_gap"));
    ok("the engine still produces nothing new on the untouched fixture",
      !evaluate(FIXTURE).some((f) => ["keyword_gap", "generic_landing_page", "call_tracking_absent"].includes(f.findingType)),
      "an adapter that reads none of the new inputs behaves exactly as it did");
    // THE ORDER ITSELF. Two campaigns, and the one whose only figure is a
    // LEADS row ranks first once that figure is money — which is the whole
    // point. Ordering on `est_impact_cents` puts it second, because 21 leads
    // is stored as 2,100 and a $645 saving as 64,500.
    {
      const mk = (id: string, type: string, est: number, unit: "usd_month" | "leads_month", rankCents: number) => ({
        entityType: "campaign" as const, entityId: `${id}:${type}`, entityName: `Campaign ${id}`,
        campaignId: id, findingType: type,
        severity: "medium" as const, riskLevel: "low" as const, applicability: "vendor" as const,
        title: `${type} on ${id}`, summary: "",
        evidence: { metrics: {}, windowStart: "2026-06-13", windowEnd: "2026-09-10", lines: [] },
        estImpactCents: est, impactUnit: unit, impactAssumption: "",
        changePayload: null, guardNote: "",
        rank: { cents: rankCents, basis: "projected" as const, why: "", blockedBy: null },
      });
      const pair = sequenceFindings([
        mk("A", "wasted_search_term", 64_500, "usd_month", 64_500),
        mk("B", "headroom", 2_100, "leads_month", 210_000),
      ]);
      ok("the queue is ordered on the one comparable figure, not on est_impact_cents",
        pair[0]!.campaignId === "B",
        "21 leads at $1,000 each is $21,000 a month and is stored in that column as 2,100");
      const unpriced = sequenceFindings([
        mk("A", "wasted_search_term", 64_500, "usd_month", 64_500),
        { ...mk("B", "headroom", 2_100, "leads_month", 0), rank: { cents: null, basis: "unpriced" as const, why: "", blockedBy: null } },
      ]);
      ok("…and a row this engine could not price does not move its group either way",
        unpriced[0]!.campaignId === "A" && unpriced.length === 2,
        "neither sunk nor floated — it keeps its group and its stage");
    }

    ok("the ruleset version moved with the rules", ADS_RULESET_VERSION === 7);
  }

  console.log(`\n${"─".repeat(72)}`);
  console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
  console.log(`${"─".repeat(72)}\n`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

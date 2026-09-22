#!/usr/bin/env tsx
import "dotenv/config";
import {
  evaluate, evidenceHash, materiallyChanged, trackingReading, costTargets, governingTarget,
  outcomeReadiness, MIN_MONTHLY_OUTCOMES_FOR_BIDDING,
  ADS_RULESET_VERSION, THRESHOLDS,
  type AuditInput, type TrackingFacts, type ClientEconomics, type CampaignRow,
} from "./ads/rules.js";
import {
  biddingReadiness, lagReading, onTargetStrategy, whatItWouldNeed,
  TARGET_STRATEGY_MIN_CONVERSIONS_30D, USEFUL_CONVERSION_LAG_DAYS,
  type ConversionLagRow,
} from "./ads/bidding-readiness.js";
import {
  spendVisibility, LOW_COVERAGE_SHARE, BARELY_COVERED_SHARE,
} from "./ads/spend-visibility.js";
import {
  findTrackingOutage, dataExclusionProposal, MAX_DATA_EXCLUSION_DAYS,
  type DailyConversionRow,
} from "./ads/tracking-outage.js";
import { proxyConversionValue } from "./ads/proxy-value.js";
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
  searchTermSpendByCampaign: { "100": 2_000_000_000, "200": 250_000_000, "300": 500_000_000 },
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

  // ── 12. Can this campaign's bidding learn from what it gets? ─────────────
  // The reading nothing in this engine computed. Every published threshold is
  // a conversion count PER CAMPAIGN PER 30 DAYS, and `noConversionClicks` asks
  // a different question — whether a campaign converted at all.
  console.log("\n12. Bidding readiness, and the gate it puts in front of everything else");

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
  console.log("\n13. Every query-based figure says what share of the money it looked at");

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
  console.log("\n14. A tracking break gets a date range, and a data exclusion goes through the guarded path");

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
    exclBody.campaigns.length === 2 && !exclBody.campaignNames.includes("Search — Broad Prospecting"),
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
  console.log("\n15. A proxy value on the conversion, and the absences it refuses to fill");

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

  console.log(`\n${"─".repeat(72)}`);
  console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
  console.log(`${"─".repeat(72)}\n`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

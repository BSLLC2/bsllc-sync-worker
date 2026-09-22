#!/usr/bin/env tsx
import "dotenv/config";
import {
  evaluate, evidenceHash, materiallyChanged, trackingReading, costTargets, governingTarget,
  outcomeReadiness, MIN_MONTHLY_OUTCOMES_FOR_BIDDING,
  ADS_RULESET_VERSION, THRESHOLDS,
  type AuditInput, type TrackingFacts, type ClientEconomics,
} from "./ads/rules.js";
import { refineNarrative } from "./ads/narrative.js";
import { applyChangeSet, rollbackChangeSet, type ChangeSet, type PriorValue } from "./apply-ads-changes.js";
import { enumName, CONVERSION_CATEGORY, TRACKING_STATUS } from "./ads/google-ads-adapter.js";

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
      dailyBudgetMicros: 80_000_000, budgetResourceName: "customers/1234567890/campaignBudgets/900",
      costMicros: 2_400_000_000, clicks: 1_180, impressions: 41_000, conversions: 36,
      impressionShare: 0.42, budgetLostShare: 0.31, rankLostShare: 0.27,
    },
    {
      id: "200", name: "Search — Broad Prospecting", channelType: "SEARCH",
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
      { id: "500", name: "Contact form", status: "ENABLED", category: "SUBMIT_LEAD_FORM", actionType: "WEBPAGE", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 40 },
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
};

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
function recorder() {
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
      if (q.includes("FROM campaign ") || q.includes("FROM campaign\n") || /FROM campaign\b/.test(q)) {
        if (q.includes("campaign_criterion")) { /* fallthrough below */ }
        const name = /campaign\.name = '([^']+)'/.exec(q)?.[1];
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
  ok("and nothing anywhere in the broken run carries a change to apply",
    brokenRun.every((f) => f.changePayload === null),
    "including the budget increase, which would be spending more on an account nobody can read");

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

  console.log(`\n${"─".repeat(72)}`);
  console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
  console.log(`${"─".repeat(72)}\n`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

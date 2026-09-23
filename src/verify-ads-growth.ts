#!/usr/bin/env tsx
/**
 * Guard for the growth readings: `unmet_demand` and `growth_unreadable`.
 *
 * No database and no ad account. It drives the real functions, and the real
 * `evaluate`, over fixtures.
 *
 * EVERY FIGURE HERE IS INVENTED. There is no production database and no Google
 * Ads access in this sandbox. The SHAPE of the first fixture is taken from a
 * person reading one live account's screen — two search campaigns losing 80.2%
 * and 87.0% of their impressions to Ad Rank, one conversion action counting
 * page views, no customer value on record — but every spend, click, impression
 * and conversion figure below was made up to produce that shape. Nothing here
 * was measured and no number here may be quoted as a fact about any client.
 *
 * The refusals are the deliverable. A rule that says "grow" on a campaign that
 * is losing money is worse than no rule, so most of what follows drives the
 * cases where nothing may be claimed.
 *
 *   npx tsx src/verify-ads-growth.ts
 */
import {
  demandCaptureReading, demandCaptureClaim,
  type DemandCaptureInput,
} from "./ads/demand-capture.js";
import {
  growthSilenceReading, growthSilenceClaim,
  type GrowthSilenceFact,
} from "./ads/growth-silence.js";
import { evaluate, THRESHOLDS, type AuditInput, type ClientEconomics, type TrackingFacts } from "./ads/rules.js";
import { rankBasisOf, RANK_BASIS_LABEL } from "./ads/impact-rank.js";
import { stageOf } from "./ads/sequence.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);

/** No `$` figure anywhere in a string. Used where a refusal must not quote one. */
const hasMoney = (s: string) => /\$\d/.test(s);

// ── The base campaign. Invented, in the SHAPE of one real screen ───────────
// A search campaign spending $1,400 a month, 100k impressions at 18% share,
// 82% of what it loses going to Ad Rank. Nothing on the client's record says
// what a lead may cost, and the conversion column counts page views.
const FRANKLIN: DemandCaptureInput = {
  campaignId: "900", campaignName: "Brazing", channelType: "SEARCH",
  costMicros: 1_400_000_000, clicks: 700, impressions: 100_000, conversions: 4,
  impressionShare: 0.18, rankLostShare: 0.802, budgetLostShare: 0.018,
  columnCountsOutcomes: "no",
  targetCents: null, targetBasis: null,
  leadValueCents: null,
  costPerConversionCents: null,   // refused upstream: the column is not outcomes
  captureRate: 0.5,
  rankRuleFloor: THRESHOLDS.rankLostShare,
  minSpendMicros: THRESHOLDS.campaignMinSpendMicros,
};
/** The same campaign on a client who HAS answered everything. */
const PRICED: DemandCaptureInput = {
  ...FRANKLIN,
  columnCountsOutcomes: "yes",
  conversions: 20,
  costPerConversionCents: 7_000,   // $70 each
  targetCents: 12_000,             // $120 a lead
  targetBasis: "modelled",
  leadValueCents: 12_000,
};

hr("1. The account the complaint came from — a clicks-tier row, and it fires");
{
  const r = demandCaptureReading(FRANKLIN);
  ok("a row is raised at all", r.verdict === "demand", r.verdict);
  ok("it reaches the clicks tier and no further", r.tier === "clicks", String(r.tier));
  ok("clicks are projected", (r.extraClicks ?? 0) > 0, `${(r.extraClicks ?? 0).toFixed(1)} clicks/mo`);
  ok("the lost impressions are sized from share, not invented",
    Math.round(r.lostImpressions ?? 0) === Math.round((100_000 / 0.18) * 0.802),
    `${Math.round(r.lostImpressions ?? 0).toLocaleString()} impressions`);
  ok("NO leads figure is claimed", r.extraLeads === null);
  ok("NO money figure is claimed", r.netValueCents === null);
  ok("the missing input is NAMED, not passed over",
    r.unpricedBecause.some((u) => /not an enquiry/.test(u)), r.unpricedBecause[0] ?? "(none)");
  ok("the money tier says why it could not be reached either",
    r.unpricedBecause.some((u) => /no leads figure to multiply/.test(u)));
  ok("a precondition is always stated", r.preconditions.length > 0, `${r.preconditions.length} stated`);
  ok("the precondition names the conversion column first",
    r.preconditions.some((p) => /Settle the conversion column first/.test(p)));
  ok("the precondition names the cheaper half of Ad Rank before the bid",
    r.preconditions.some((p) => /relevance and the landing page buy the same impressions/.test(p)));
  ok("it never tells anybody how to fix Ad Rank — that is the other row's job",
    !/raise (your |the )?bid to/i.test(r.lines.join(" ")));
}

hr("2. THE REFUSAL THAT MATTERS — an over-target campaign gets nothing");
{
  // Converting at $150 against a $120 lead value. There IS demand and it is
  // not worth buying: more impressions buy more conversions at a loss.
  const over = demandCaptureReading({ ...PRICED, costPerConversionCents: 15_000 });
  ok("the verdict is over_target", over.verdict === "over_target", over.verdict);
  ok("NO row is raised", over.verdict !== "demand");
  ok("no clicks, leads or money figure survives",
    over.extraClicks === null && over.extraLeads === null && over.netValueCents === null);
  ok("the refusal says the demand is real and not worth buying at that price",
    /not worth buying at that price/.test(over.silence ?? ""));
  ok("the refusal points at the cost row rather than repeating it",
    /Bringing the cost per conversion under the target comes first/.test(over.silence ?? ""));
  ok("it is over_target at one cent over, not only far over",
    demandCaptureReading({ ...PRICED, costPerConversionCents: 12_001 }).verdict === "over_target");
  ok("it is NOT over_target exactly at the target",
    demandCaptureReading({ ...PRICED, costPerConversionCents: 12_000 }).verdict === "demand");
}

hr("3. A denominator below one is refused, never divided by");
{
  // 0.4 conversions is a share of somebody else's conversion. Dividing by it
  // is the bug that produced a cost per conversion of millions of dollars.
  const thin = demandCaptureReading({ ...PRICED, conversions: 0.4, costPerConversionCents: null });
  ok("the row still exists at the clicks tier", thin.verdict === "demand" && thin.tier === "clicks", `${thin.verdict}/${thin.tier}`);
  ok("no leads figure is produced", thin.extraLeads === null);
  ok("the refusal names the denominator",
    thin.unpricedBecause.some((u) => /under one whole conversion/.test(u)), thin.unpricedBecause[0] ?? "(none)");
  ok("the refusal says a fractional conversion is somebody else's",
    thin.unpricedBecause.some((u) => /share of somebody else's conversion/.test(u)));
  ok("one whole conversion IS enough to divide by",
    (demandCaptureReading({ ...PRICED, conversions: 1, costPerConversionCents: 7_000 }).extraLeads ?? 0) > 0);
  ok("zero conversions on a readable column is silence, not a division",
    demandCaptureReading({ ...PRICED, conversions: 0, costPerConversionCents: null }).verdict === "converting_nothing");
}

hr("4. A projection with every input present, and only then");
{
  const r = demandCaptureReading(PRICED);
  ok("it reaches the money tier", r.tier === "money", String(r.tier));
  ok("a leads figure exists", (r.extraLeads ?? 0) > 0, `${(r.extraLeads ?? 0).toFixed(1)} leads/mo`);
  ok("a net money figure exists", (r.netValueCents ?? 0) > 0, `$${((r.netValueCents ?? 0) / 100).toFixed(2)}/mo`);
  ok("the money figure is leads x value LESS what the clicks cost",
    r.netValueCents === Math.round((r.extraLeads ?? 0) * 12_000 - (r.extraSpendCents ?? 0)));
  ok("nothing is left unpriced", r.unpricedBecause.length === 0, r.unpricedBecause.join(" | "));
  ok("the preconditions are still stated on a fully priced row", r.preconditions.length > 0);
  ok("a losing projection is NOT printed as a gain of nought",
    (() => {
      const loss = demandCaptureReading({ ...PRICED, leadValueCents: 200 });   // $2 a lead
      return loss.verdict === "demand" && loss.netValueCents === null
        && loss.unpricedBecause.some((u) => /arithmetic comes out against it/.test(u));
    })());
}

hr("5. A figure carries its basis, and a projection never wears a saving's word");
{
  const claim = demandCaptureClaim(demandCaptureReading(PRICED), 0.5);
  ok("the claim opens by saying it is a projection", /^A PROJECTION/.test(claim));
  ok("it says it is not money on the record", /not money on the record/.test(claim));
  ok("it never calls itself recoverable", !/recoverable/i.test(claim));
  ok("it names what it was projected from", /impression share/.test(claim) && /click-through rate/.test(claim));
  ok("it says both ends are optimistic", /optimistic/.test(claim));
  ok("it says lost impressions are not demand handed over", /not demand handed over/.test(claim));
  const bare = demandCaptureClaim(demandCaptureReading(FRANKLIN), 0.5);
  ok("an unpriced row's claim carries the missing input", /not an enquiry/.test(bare));
  ok("the rank basis for this type is projected", rankBasisOf("unmet_demand") === "projected", rankBasisOf("unmet_demand"));
  ok("…and the word printed beside the figure says so", RANK_BASIS_LABEL[rankBasisOf("unmet_demand")] === "projected");
  ok("the type is a grow-stage row", stageOf("unmet_demand") === "grow", stageOf("unmet_demand"));
}

hr("6. A null is unanswered, never a nought");
{
  ok("no share lost to Ad Rank is cant_tell, not nought",
    demandCaptureReading({ ...PRICED, rankLostShare: null }).verdict === "cant_tell");
  ok("no impression share is cant_tell, not nought",
    demandCaptureReading({ ...PRICED, impressionShare: null }).verdict === "cant_tell");
  ok("a nought impression share is refused rather than divided by",
    demandCaptureReading({ ...PRICED, impressionShare: 0 }).verdict === "cant_tell");
  ok("the refusal explains that a non-search campaign reports none",
    /not a search campaign/.test(demandCaptureReading({ ...PRICED, rankLostShare: null }).silence ?? ""));
  ok("no budget share reads as nought lost to budget, which it is not asked to be",
    demandCaptureReading({ ...PRICED, budgetLostShare: null }).verdict === "demand");
  ok("a cant_tell quotes no figure",
    !hasMoney(demandCaptureReading({ ...PRICED, rankLostShare: null }).silence ?? ""));
}

hr("7. Silence where there is nothing to say");
{
  ok("under the Ad Rank floor there is no row",
    demandCaptureReading({ ...PRICED, rankLostShare: THRESHOLDS.rankLostShare - 0.001 }).verdict === "not_rank_limited");
  ok("…and the refusal points at where the growth actually is",
    /queries and services it does not bid on yet/.test(
      demandCaptureReading({ ...PRICED, rankLostShare: 0.1 }).silence ?? ""));
  ok("at the floor exactly there IS a row", demandCaptureReading({ ...PRICED, rankLostShare: THRESHOLDS.rankLostShare }).verdict === "demand");
  ok("a campaign under the spend floor raises nothing",
    demandCaptureReading({ ...PRICED, costMicros: 1_000_000 }).verdict === "too_small");
  ok("no clicks means no click-through rate to project through",
    demandCaptureReading({ ...PRICED, clicks: 0 }).verdict === "too_small");
  ok("no impressions likewise",
    demandCaptureReading({ ...PRICED, impressions: 0 }).verdict === "too_small");
}

hr("8. The absence, made visible — growth_unreadable");
{
  const blockedFacts: GrowthSilenceFact[] = [
    { findingType: "keyword_gap", label: "Demand this client sells into that no campaign bids on",
      verdict: "no_services_recorded", silence: "Nobody has confirmed what this client sells.",
      fixable: true, unlock: "Confirm what this client actually sells, on their client page.", owner: "us" },
    { findingType: "converting_search_term", label: "Searches that already convert and are not keywords yet",
      verdict: "column_not_outcomes", silence: "What this account counts as a conversion is not an enquiry.",
      fixable: true, unlock: "Settle what this account counts as a conversion.", owner: "us" },
    { findingType: "headroom", label: "Campaigns converting cheaply enough to buy more of",
      verdict: "cant_tell", silence: "Nothing on this client's record says what a lead may cost.",
      fixable: true, unlock: "Record a customer value and a close rate.", owner: "client" },
  ];
  const r = growthSilenceReading({
    accountId: "900", accountName: "900", facts: blockedFacts,
    accountCostMicros: 4_200_000_000, minSpendMicros: THRESHOLDS.accountMinSpendMicros,
    growthFindingsRaised: 0,
  });
  ok("every reading blocked reads as all_blocked", r.verdict === "all_blocked", r.verdict);
  ok("all three are reported", r.blocked.length === 3, String(r.blocked.length));
  ok("the title says the queue cannot see growth, not that there is none",
    /Nothing on this account can say where growth is/.test(r.title), r.title);
  ok("the summary refuses to claim there IS growth",
    /Nothing here claims there IS growth/.test(r.summary));
  ok("it says none of them refused for want of an opportunity",
    /None of them refused because there is nothing there/.test(r.summary));
  ok("each reading's OWN refusal is quoted verbatim, never rewritten",
    blockedFacts.every((f) => r.lines.some((l) => l.includes(f.silence!))));
  ok("each carries the one thing that would end it",
    blockedFacts.every((f) => r.lines.some((l) => l.includes(f.unlock!))));
  ok("a client-owned answer is marked as the client's",
    r.lines.some((l) => /the client has to answer this/.test(l)));
  ok("it claims no figure and says it is not an opportunity",
    /must not be read as one/.test(growthSilenceClaim(r)) && !hasMoney(growthSilenceClaim(r)));
  ok("the rank basis is `none`, not `unpriced` — no figure would place it",
    rankBasisOf("growth_unreadable") === "none", rankBasisOf("growth_unreadable"));
  ok("it is a measure-stage row, so it neither queue-jumps waste nor sinks below growth",
    stageOf("growth_unreadable") === "measure", stageOf("growth_unreadable"));

  const partly = growthSilenceReading({
    accountId: "900", accountName: "900", facts: blockedFacts.slice(0, 1),
    accountCostMicros: 4_200_000_000, minSpendMicros: THRESHOLDS.accountMinSpendMicros,
    growthFindingsRaised: 2,
  });
  ok("some firing and some blocked reads as partly_blocked", partly.verdict === "partly_blocked", partly.verdict);
  ok("…and says the queue is showing less than there is", /showing less than there is/.test(partly.title));
}

hr("9. A healthy silence is an answer, and raises nothing");
{
  const healthy: GrowthSilenceFact[] = [
    { findingType: "keyword_gap", label: "x", verdict: "covered",
      silence: "Every confirmed service is already covered.", fixable: false, unlock: null, owner: null },
    { findingType: "converting_search_term", label: "y", verdict: "none",
      silence: "Looked, found none over the floors.", fixable: false, unlock: null, owner: null },
  ];
  const r = growthSilenceReading({
    accountId: "900", accountName: "900", facts: healthy,
    accountCostMicros: 4_200_000_000, minSpendMicros: THRESHOLDS.accountMinSpendMicros,
    growthFindingsRaised: 1,
  });
  ok("nothing fixable means no row", r.verdict === "clear", r.verdict);
  ok("the silence says a refusal for want of an opportunity is an answer",
    /which is an answer rather than a gap/.test(r.silence ?? ""));
  ok("a dormant account is told nothing",
    growthSilenceReading({
      accountId: "900", accountName: "900", facts: healthy.map((f) => ({ ...f, fixable: true, unlock: "do a thing", owner: "us" as const })),
      accountCostMicros: 1_000_000, minSpendMicros: THRESHOLDS.accountMinSpendMicros,
      growthFindingsRaised: 0,
    }).verdict === "too_small");
  ok("a healthy silence beside a fixable one is counted, never listed",
    (() => {
      const mixed = growthSilenceReading({
        accountId: "900", accountName: "900",
        facts: [...healthy, { findingType: "headroom", label: "z", verdict: "cant_tell", silence: "no target", fixable: true, unlock: "record one", owner: "client" as const }],
        accountCostMicros: 4_200_000_000, minSpendMicros: THRESHOLDS.accountMinSpendMicros,
        growthFindingsRaised: 0,
      });
      return mixed.blocked.length === 1 && mixed.healthySilences === 2
        && mixed.lines.some((l) => /2 further growth reading\(s\) refused/.test(l));
    })());
}

// ── End to end, through the real engine ───────────────────────────────────
// Everything above drives the modules. This drives `evaluate`, because a pure
// function that is right and a rule that never reaches the queue is the exact
// defect this whole change exists to fix.

const TRACKING_PAGE_VIEWS: TrackingFacts = {
  status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
  actions: [
    { id: "1", name: "Services page view", status: "ENABLED", category: "PAGE_VIEW", actionType: "WEBPAGE",
      primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 39, defaultValue: null, alwaysUseDefaultValue: null },
  ],
};
const TRACKING_GOOD: TrackingFacts = {
  status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
  actions: [
    { id: "1", name: "Quote request", status: "ENABLED", category: "SUBMIT_LEAD_FORM", actionType: "WEBPAGE",
      primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 39, defaultValue: null, alwaysUseDefaultValue: null },
  ],
};
const ECONOMICS_GOOD: ClientEconomics = {
  customerValueCents: 600_000, customerValueFromClient: true, closeRatePct: 20,
  cplCeilingCents: null, cplCeilingMonth: null,
};

const ACCOUNT = (over: Partial<AuditInput> = {}): AuditInput => ({
  platform: "google_ads",
  accountId: "ACCOUNT-UNDER-TEST",
  windowStart: "2026-06-25", windowEnd: "2026-09-22",
  campaigns: [
    { id: "900", name: "Brazing", channelType: "SEARCH",
      dailyBudgetMicros: 50_000_000, budgetResourceName: null,
      costMicros: 1_400_000_000, clicks: 700, impressions: 100_000, conversions: 12,
      impressionShare: 0.18, budgetLostShare: 0.018, rankLostShare: 0.802,
      bidStrategyType: "MAXIMIZE_CONVERSIONS", hasBidTarget: false },
    { id: "901", name: "Assembly", channelType: "SEARCH",
      dailyBudgetMicros: 30_000_000, budgetResourceName: null,
      costMicros: 900_000_000, clicks: 420, impressions: 60_000, conversions: 27,
      impressionShare: 0.13, budgetLostShare: 0.0, rankLostShare: 0.87,
      bidStrategyType: "MAXIMIZE_CONVERSIONS", hasBidTarget: false },
  ],
  searchTerms: [],
  keywords: [],
  ads: [],
  existingNegatives: new Set<string>(),
  protectedPatterns: [],
  existingKeywords: [{ text: "brazing", matchType: "PHRASE", adGroupName: "Brazing", campaignName: "Brazing" }],
  tracking: TRACKING_PAGE_VIEWS,
  economics: null,
  services: { services: null, confirmedBy: null, confirmedAt: null, candidatesWaiting: 2 },
  ...over,
});

hr("10. End to end — the row reaches the queue on the account that produced the complaint");
{
  const found = evaluate(ACCOUNT());
  const demand = found.filter((f) => f.findingType === "unmet_demand");
  ok("both campaigns raise an unmet_demand row", demand.length === 2, `${demand.length} row(s)`);
  ok("each one is a vendor brief, never an api change",
    demand.every((f) => f.applicability === "vendor" && f.changePayload === null));
  ok("the title counts clicks where leads cannot be counted",
    demand.every((f) => /clicks a month it is not getting/.test(f.title)), demand[0]?.title ?? "");
  ok("no leads figure is claimed", demand.every((f) => f.estImpactCents === 0));
  ok("the row's rank basis is projected or unpriced, never recoverable",
    demand.every((f) => f.rank?.basis === "projected" || f.rank?.basis === "unpriced"),
    demand.map((f) => f.rank?.basis).join(","));
  ok("the missing input reaches the finding's own assumption",
    demand.every((f) => /not an enquiry/.test(f.impactAssumption)));
  ok("the preconditions reach the evidence a person reads",
    demand.every((f) => f.evidence.lines.some((l) => /Settle the conversion column first/.test(l))));
  ok("the Ad Rank hygiene row still exists beside it and is not replaced",
    found.filter((f) => f.findingType === "rank_limited").length === 2);
  ok("…and the two rows do not both tell somebody how to fix Ad Rank",
    demand.every((f) => /the row on this campaign's Ad Rank, not this one/.test(f.summary)));

  const silence = found.filter((f) => f.findingType === "growth_unreadable");
  ok("the absence row reaches the queue exactly once", silence.length === 1, `${silence.length} row(s)`);
  ok("it names the unconfirmed services list",
    /candidate\(s\) waiting to be ticked|Confirm what this client actually sells/.test(
      [silence[0]?.summary, ...(silence[0]?.evidence.lines ?? [])].join(" ")));
  ok("it names the conversion column",
    silence[0]!.evidence.lines.some((l) => /Settle what this account counts as a conversion/.test(l)));
  ok("it claims no figure", silence[0]!.estImpactCents === 0 && silence[0]!.rank?.cents == null);
  // NOT `high`, and this is the guard earning its keep: `unmet_demand` DOES
  // fire on this account, so growth is partly readable, not wholly blocked.
  // `high` is reserved for an account whose queue can physically only ever
  // show waste, and conflating the two would make the severity say nothing.
  ok("it is medium, because two growth rows DID fire beside it",
    silence[0]!.severity === "medium", silence[0]!.severity);
  ok("…and it says so rather than claiming the whole account is blind",
    /showing less than there is/.test(silence[0]!.title), silence[0]!.title);
  ok("the count of rows that did fire is on the record",
    silence[0]!.evidence.metrics.growthFindingsRaised === 2,
    String(silence[0]!.evidence.metrics.growthFindingsRaised));
  ok("nothing on it is applied", silence[0]!.changePayload === null);
}

hr("11. End to end — the same account once every figure is recorded");
{
  const found = evaluate(ACCOUNT({ tracking: TRACKING_GOOD, economics: ECONOMICS_GOOD }));
  const demand = found.filter((f) => f.findingType === "unmet_demand");
  ok("the rows now carry leads", demand.length > 0 && demand.every((f) => f.estImpactCents > 0),
    demand.map((f) => `${(f.estImpactCents / 100).toFixed(1)} leads`).join(", "));
  ok("the unit is leads, never dollars", demand.every((f) => f.impactUnit === "leads_month"));
  ok("the rank turns leads into money on THIS client's own figures",
    demand.every((f) => f.rank?.basis === "projected" && (f.rank?.cents ?? 0) > 0),
    demand.map((f) => `$${((f.rank?.cents ?? 0) / 100).toFixed(2)}`).join(", "));
  ok("the rank sentence says it is a forecast",
    demand.every((f) => /forecast of a change nobody has made yet/.test(f.rank?.why ?? "")));
  ok("the assumption still opens as a projection", demand.every((f) => /^A PROJECTION/.test(f.impactAssumption)));
  // The absence row NARROWS rather than vanishing, because one answer is still
  // missing: nobody has confirmed what this client sells, so the keyword-gap
  // reading is still blocked. A row that disappeared here would be claiming
  // the account is fully readable when it is not.
  const still = found.filter((f) => f.findingType === "growth_unreadable");
  ok("the absence row narrows to the one answer still missing", still.length === 1);
  ok("…and it is now only about the services list",
    still[0]!.evidence.metrics.blockedReadings === 1,
    String(still[0]!.evidence.metrics.blockedReadings));
  ok("the conversion column is no longer named on it",
    !still[0]!.evidence.lines.some((l) => /Settle what this account counts as a conversion/.test(l)));
}

hr("11b. …and it disappears entirely once the last answer lands");
{
  const found = evaluate(ACCOUNT({
    tracking: TRACKING_GOOD,
    economics: ECONOMICS_GOOD,
    services: {
      services: [{ name: "brazing", note: null }],
      confirmedBy: "an account manager", confirmedAt: "2026-09-22", candidatesWaiting: 0,
    },
    research: {
      keywords: [{ keyword: "brazing", volume: 900, cpcDollars: 4.2, difficulty: null, intent: null, clientRank: null, competitorRank: null }],
      ranAt: "2026-09-01", location: "United States", seeds: ["brazing"],
    },
  }));
  ok("no absence row remains", found.filter((f) => f.findingType === "growth_unreadable").length === 0);
  ok("the growth rows are still there", found.filter((f) => f.findingType === "unmet_demand").length === 2);
}

hr("12. End to end — an over-target account is never told to grow");
{
  // $1,400 over 700 clicks and 2 conversions is $700 a conversion, against a
  // $60 lead value. Every growth row on this account must refuse.
  const found = evaluate(ACCOUNT({
    tracking: TRACKING_GOOD,
    economics: { customerValueCents: 30_000, customerValueFromClient: true, closeRatePct: 20, cplCeilingCents: null, cplCeilingMonth: null },
    campaigns: [
      { id: "900", name: "Brazing", channelType: "SEARCH",
        dailyBudgetMicros: 50_000_000, budgetResourceName: null,
        costMicros: 1_400_000_000, clicks: 700, impressions: 100_000, conversions: 2,
        impressionShare: 0.18, budgetLostShare: 0.018, rankLostShare: 0.802,
        bidStrategyType: "MAXIMIZE_CONVERSIONS", hasBidTarget: false },
    ],
  }));
  ok("NO unmet_demand row exists", found.filter((f) => f.findingType === "unmet_demand").length === 0);
  ok("NO headroom row exists either", found.filter((f) => f.findingType === "headroom").length === 0);
  ok("the cost row that owns this campaign does exist",
    found.some((f) => f.findingType === "cpa_above_target"));
  ok("nothing anywhere on this account proposes spending more",
    found.every((f) => f.findingType !== "budget_limited"));
}

console.log(`\n${"═".repeat(72)}`);
console.log(failures === 0 ? "✅ growth guard: all checks passed" : `❌ growth guard: ${failures} check(s) failed`);
console.log("Every figure above is an invented fixture. No production database and no ad account was read.");
process.exit(failures === 0 ? 0 : 1);

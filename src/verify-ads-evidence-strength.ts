#!/usr/bin/env tsx
/**
 * Is there enough behind a finding to act on it? (2026-10-05)
 *
 * Checks `src/ads/evidence-strength.ts` on its own, then drives the real rules
 * (`evaluate`) to prove the gates are actually wired in. The shapes come from
 * what a person who ran the Ohio Community Health account declined by hand:
 * a keyword with thin clicks, a cost target on a campaign with 13 conversions,
 * a gap that is inside the noise, one-click negatives, and a core search.
 *
 * Every figure here is invented. Nothing was run against an ad account.
 *
 *   npm run verify-ads-evidence-strength
 */
import {
  keywordZeroReading, targetReadiness, gapAgainstNoise, termHasEnoughClicks,
  TARGET_MIN_CONVERSIONS, ZERO_CHANCE_MAX, MIN_CLICKS_FOR_WASTED_TERM, NOISE_Z,
} from "./ads/evidence-strength.js";
import {
  evaluate, ADS_RULESET_VERSION,
  type AuditInput, type CampaignRow, type KeywordRow, type SearchTermRow, type TrackingFacts,
} from "./ads/rules.js";
import type { ClientServiceFacts } from "./ads/service-relevance.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// ── 1. The pure readings ────────────────────────────────────────────────────
console.log("\n1. A keyword is called dead only on enough clicks, at the campaign's own rate");
const camp = { campaignClicks: 124, campaignConversions: 13 };
const k17 = keywordZeroReading({ clicks: 17, ...camp });
ok("17 clicks on a campaign converting 13 of 124 is not enough", !k17.enough, k17.line);
const k28 = keywordZeroReading({ clicks: 28, ...camp });
ok("28 clicks is enough", k28.enough && (k28.chanceOfNothing ?? 1) <= ZERO_CHANCE_MAX, k28.line);
ok("27 clicks is still short and 28 is the number the reading names",
  !keywordZeroReading({ clicks: 27, ...camp }).enough && k17.clicksNeeded === 28, `needs ${k17.clicksNeeded}`);
ok("the held-back sentence says how many it takes and that the line is ours",
  /about 28 to be sure/.test(k17.line) && /line is ours/.test(k17.line));
const noRate = keywordZeroReading({ clicks: 500, campaignClicks: 0, campaignConversions: 0 });
ok("a campaign with no conversions has no rate, so nothing under it is called dead",
  !noRate.enough && noRate.campaignRate === null && noRate.chanceOfNothing === null, noRate.line);
const noConv = keywordZeroReading({ clicks: 500, campaignClicks: 400, campaignConversions: 0 });
ok("…and 500 clicks against a campaign that never converts is still cannot-tell, not dead", !noConv.enough);

console.log("\n2. A cost target needs conversions to steer on, and tracking it can trust");
ok("a campaign with 13 conversions is not target-ready",
  !targetReadiness({ conversions: 13, trackingTrusted: true }).ready);
ok("…and says what would release it",
  /15 conversions a month/.test(targetReadiness({ conversions: 13, trackingTrusted: true }).line ?? ""));
ok("15 conversions is ready", targetReadiness({ conversions: TARGET_MIN_CONVERSIONS, trackingTrusted: true }).ready
  && targetReadiness({ conversions: 15, trackingTrusted: true }).line === null);
const broken = targetReadiness({ conversions: 60, trackingTrusted: false });
ok("untrusted tracking is never ready, however many conversions it reports",
  !broken.ready && /tracking is not trusted/.test(broken.line ?? ""));

console.log("\n3. A gap is only a gap if it is bigger than the noise on the figure");
const near = gapAgainstNoise({ costPerConversionCents: 5794, targetCents: 4600, conversions: 13 });
ok("13 conversions at $57.94 against a $46 target is inside the noise band",
  near?.withinNoise === true && /inside the noise/.test(near.line ?? ""), near?.line ?? "none");
const far = gapAgainstNoise({ costPerConversionCents: 7830, targetCents: 4600, conversions: 63 });
ok("63 conversions at $78.30 against $46 is not", far?.withinNoise === false && far.line === null);
ok("the band is wider with fewer conversions",
  (near?.bandShare ?? 0) > (far?.bandShare ?? 1) && Math.abs((far?.bandShare ?? 0) - NOISE_Z / Math.sqrt(63)) < 1e-9);
ok("under target is never read as noise", gapAgainstNoise({ costPerConversionCents: 4000, targetCents: 4600, conversions: 13 })?.withinNoise === false);
ok("no conversions or no target is no reading, never a nought",
  gapAgainstNoise({ costPerConversionCents: 5000, targetCents: 4600, conversions: 0 }) === null
  && gapAgainstNoise({ costPerConversionCents: 5000, targetCents: 0, conversions: 13 }) === null);

console.log("\n4. One click is not a pattern");
ok("1 click is not enough", !termHasEnoughClicks(1));
ok("2 clicks is", termHasEnoughClicks(MIN_CLICKS_FOR_WASTED_TERM) && termHasEnoughClicks(2));

// ── 5. The real rules ───────────────────────────────────────────────────────
const TRACKING: TrackingFacts = {
  status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
  actions: [
    { id: "500", name: "Contact form", status: "ENABLED", category: "SUBMIT_LEAD_FORM", actionType: "WEBPAGE", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 40, defaultValue: null, alwaysUseDefaultValue: null },
  ],
};

function campaign(over: Partial<CampaignRow>): CampaignRow {
  return {
    id: "900", name: "Search — Treatment", channelType: "SEARCH",
    resourceName: "customers/1234567890/campaigns/900",
    bidStrategyType: "MAXIMIZE_CONVERSIONS", hasBidTarget: false,
    dailyBudgetMicros: 50_000_000, budgetResourceName: "customers/1234567890/campaignBudgets/950",
    costMicros: 0, clicks: 124, impressions: 9_000, conversions: 13,
    impressionShare: 0.6, budgetLostShare: 0.01, rankLostShare: 0.05,
    ...over,
  };
}
function input(over: Partial<AuditInput>): AuditInput {
  return {
    platform: "google_ads", accountId: "1234567890",
    windowStart: "2026-07-07", windowEnd: "2026-10-04",
    campaigns: [campaign({})], searchTerms: [], keywords: [], ads: [],
    existingNegatives: new Set<string>(), negativesByCampaign: new Map([["900", new Set<string>()]]),
    protectedPatterns: [], tracking: TRACKING,
    economics: { customerValueCents: null, customerValueFromClient: false, closeRatePct: null, cplCeilingCents: 4_600, cplCeilingMonth: "2026-10" },
    conversionLag: [], searchTermSpendByCampaign: { "900": 750_000_000 }, existingKeywords: [], dailyConversions: [],
    ...over,
  } as AuditInput;
}
const kw = (text: string, clicks: number): KeywordRow => ({
  criterionResourceName: `customers/1234567890/adGroupCriteria/9~${text}`, text, matchType: "EXACT", qualityScore: 5,
  campaignId: "900", campaignName: "Search — Treatment", adGroupName: "Core", costMicros: 90_000_000, clicks, conversions: 0, finalUrls: [],
});
const term = (t: string, clicks: number, costMicros: number): SearchTermRow => ({
  term: t, campaignId: "900", campaignName: "Search — Treatment", adGroupName: "Core", costMicros, clicks, conversions: 0, allConversions: 0,
});

console.log("\n5. dead_keyword: the real rule honours the click line");
{
  const thin = evaluate(input({ keywords: [kw("thin keyword", 17)] })).filter((f) => f.findingType === "dead_keyword");
  ok("a keyword with 17 clicks produces no dead_keyword row", thin.length === 0, `${thin.length} rows`);
  const enough = evaluate(input({ keywords: [kw("deep keyword", 40)] })).filter((f) => f.findingType === "dead_keyword");
  ok("a keyword with 40 clicks produces one", enough.length === 1);
  ok("…and it carries the chance sentence", /by chance about \d+% of the time/.test(enough[0]?.evidence.lines.join(" ") ?? ""),
    enough[0]?.evidence.lines.at(-1) ?? "none");
  const noRate = evaluate(input({
    campaigns: [campaign({ conversions: 0 })], keywords: [kw("deep keyword", 400)],
  })).filter((f) => f.findingType === "dead_keyword");
  ok("a keyword under a campaign with no conversion rate is never called dead", noRate.length === 0);
}

console.log("\n6. The cost-target recommendation is held until there is something to steer on");
{
  const run = (conversions: number, cpaCents: number, over: Partial<AuditInput> = {}) =>
    evaluate(input({
      campaigns: [campaign({ conversions, costMicros: Math.round(conversions * cpaCents * 10_000) })], ...over,
    }));
  const few = run(13, 5794);
  ok("13 conversions over target produce cpa_above_target", few.some((f) => f.findingType === "cpa_above_target"));
  ok("…and not bid_target_absent", few.every((f) => f.findingType !== "bid_target_absent"));
  const heldRow = few.find((f) => f.findingType === "cpa_above_target");
  ok("…carrying the held-back line", /A cost target is held back/.test(heldRow?.evidence.lines.join(" ") ?? ""),
    heldRow?.evidence.lines.join(" | ").slice(-170) ?? "none");
  ok("…and the gap inside the noise drops it to low severity",
    heldRow?.severity === "low" && /inside the noise/.test(heldRow?.evidence.lines.join(" ") ?? ""), heldRow?.severity ?? "none");

  const many = run(20, 7830);
  const absent = many.find((f) => f.findingType === "bid_target_absent");
  ok("20 conversions far over target with no target set produce bid_target_absent", Boolean(absent));
  ok("…outside the noise band, so not low severity", absent !== undefined && absent.severity !== "low", absent?.severity ?? "none");
  ok("…and nothing in the run says a target is held back",
    many.every((f) => !/cost target is held back/.test(f.evidence.lines.join(" "))));

  const untrusted = run(20, 7830, { tracking: null });
  ok("with no trusted tracking the target is held back whatever the count",
    untrusted.every((f) => f.findingType !== "bid_target_absent"));
}

console.log("\n7. The wasted-search-term list leaves out one-click terms and core services");
{
  const services: ClientServiceFacts = { services: [{ name: "detox program", note: null }], confirmedBy: "a person", confirmedAt: "2026-10-01", candidatesWaiting: 0 };
  const terms = [
    term("cheap random thing", 20, 60_000_000),
    term("one click wonder", 1, 47_000_000),
    term("detox program near me", 40, 90_000_000),
  ];
  const row = evaluate(input({ searchTerms: terms, services })).find((f) => f.findingType === "wasted_search_term");
  const lines = row?.evidence.lines.join("\n") ?? "";
  ok("an ordinary term stays in the list", /"cheap random thing"/.test(lines));
  ok("a one-click term is absent", !/"one click wonder"/.test(lines));
  ok("a term covering a confirmed service is absent", !/"detox program near me"/.test(lines));
  const notes = row?.evidence.notes?.join("\n") ?? "";
  ok("the row says what it left out and why",
    /1 other term with a single click is left out/.test(lines)
      && /core search, not blocked/.test(notes) && /"detox program near me"/.test(notes) && /carries every word of "detox program"/.test(notes),
    "the core search is named, with its spend, under the row and not among its records");
  ok("no 'services not confirmed' line when they are", !/services are not confirmed/.test(lines));

  const unconfirmed = evaluate(input({
    searchTerms: terms, services: { services: null, confirmedBy: null, confirmedAt: null, candidatesWaiting: 3 },
  })).find((f) => f.findingType === "wasted_search_term");
  const ulines = unconfirmed?.evidence.lines.join("\n") ?? "";
  ok("with no confirmed services the row says so", /services are not confirmed/.test(ulines));
  ok("…and the core-service term is then listed, since nothing can say it is core", /"detox program near me"/.test(ulines));
  ok("…and a one-click term is still absent", !/"one click wonder"/.test(ulines));
}

ok("the ruleset version is 10", ADS_RULESET_VERSION === 10);

console.log(`\n${"─".repeat(72)}`);
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
console.log(`${"─".repeat(72)}\n`);
if (failures) process.exit(1);

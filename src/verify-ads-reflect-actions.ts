#!/usr/bin/env tsx
/**
 * Findings that reflect what was DONE in the account, not only what is still
 * true (ruleset 9).
 *
 * Drives the real rules (`evaluateAudit`) over an OCH-shaped book and proves
 * each of the four findings the owner named stops describing a world from
 * before somebody's change, with every dropped row ACCOUNTED FOR:
 *
 *   1. converting_search_term  — a query a negative already blocks is not
 *      recommended as a keyword (campaign, shared-list and account negatives,
 *      with match types).
 *   2. generic_landing_page    — a keyword's own Final URL counts, and the
 *      front page is accepted for a keyword that is the client's own name.
 *   3. wasted_search_term      — never propose a negative that would block a
 *      service the client sells; list it under the row instead.
 *   4. budget_limited          — an account already spending the budget the
 *      client approved is marked for the client's budget decision.
 *   +  a campaign under the conversions a cost target needs is told to stay as
 *      it is.
 *
 * "Acted on, measuring" (item 4 of the brief) is NOT a worker rule: it is
 * derived from the change history at read time in the dashboard
 * (shared/ads-acted-on.ts) and is proved there. See the notes in CLAUDE.md.
 *
 * EVERY FIGURE, CAMPAIGN AND QUERY HERE IS INVENTED. The names are the ones the
 * owner used so a reader can line each fixture up against the brief; the
 * numbers are not a record of anything. Nothing here ran against an ad account
 * or a database.
 *
 *   npm run verify-ads-reflect-actions
 */
import {
  evaluateAudit, evaluate, ADS_RULESET_VERSION, accountMonthlyBudgetCents, atApprovedBudget,
  APPROVED_BUDGET_REACHED_SHARE,
  type AuditInput, type CampaignRow, type SearchTermRow, type TrackingFacts, type AdGroupAdRow, type KeywordRow,
  type ClientEconomics,
} from "./ads/rules.js";
import {
  negativeBlocks, firstBlockingNegative, combineNegativeRules, rulesForCampaign,
  shapeCampaignNegativeRules, shapeSharedNegativeRules, shapeAccountNegativeRules,
  blockingNegativePhrase, type NegativeRule, type NegativeRuleFacts,
} from "./ads/negative-match.js";
import { isBrandKeyword, classifyKeywordLanding, isSiteRoot } from "./ads/traffic-readiness.js";
import { serviceBlockVerdict, type ClientServiceFacts } from "./ads/service-relevance.js";
import { stayPutLine, targetStep, bidTargetReading } from "./ads/bid-target.js";
import { parseCompetitorNames, matchesRecordedName, competitorKeywordNote, COMPETITOR_NAMES_NOT_RECORDED } from "./ads/competitor-names.js";
import { recordLines, EVIDENCE_LIST_CEILING } from "./ads/evidence-list.js";
import { daysIdle, STOPPED_SPENDING_DAYS, outcomeReadiness, type OutcomeFeedFacts } from "./ads/rules.js";
import { splitOf, missingFigureWhy } from "./ads/store.js";
import { proxyConversionValue } from "./ads/proxy-value.js";
import { accountingLines } from "./ads/run-accounting.js";
import { derivedBrandPatterns } from "./ads/store.js";
import type { ExistingKeyword } from "./ads/query-promotion.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n${s}`);

const dec = (v: unknown) => ({ "2": "EXACT", "3": "PHRASE", "4": "BROAD" } as Record<string, string>)[String(v)] ?? String(v);

// ── 1. The matcher, on its own ──────────────────────────────────────────────
section("1. A negative blocks a query the way Google says it does");
{
  const rule = (text: string, matchType: NegativeRule["matchType"], source: NegativeRule["source"] = "campaign"): NegativeRule => ({ text, matchType, source });
  ok("a phrase negative blocks a longer query holding its words together",
    negativeBlocks("cat house cincinnati", rule("cat house", "PHRASE")));
  ok("…and not the same words apart or reversed",
    !negativeBlocks("house for a cat", rule("cat house", "PHRASE")) && !negativeBlocks("house cat", rule("cat house", "PHRASE")));
  ok("an exact negative blocks that query and nothing longer",
    negativeBlocks("cat house", rule("cat house", "EXACT")) && !negativeBlocks("cat house cincinnati", rule("cat house", "EXACT")));
  ok("a broad negative blocks every query holding the words, in any order",
    negativeBlocks("house for a cat", rule("cat house", "BROAD")) && !negativeBlocks("cat shelter", rule("cat house", "BROAD")));
  ok("case and punctuation never decide it", negativeBlocks("CBH, Hamilton-Ohio", rule("cbh", "PHRASE")));
  ok("a single-word negative blocks only a whole word, never a fragment", !negativeBlocks("cbhx hamilton", rule("cbh", "PHRASE")));
  ok("an undecoded match type is read as a phrase, as the waste rule reads every negative",
    negativeBlocks("ccat house", rule("ccat", "UNKNOWN")));
  ok("an empty query or an empty negative blocks nothing",
    !negativeBlocks("", rule("cbh", "PHRASE")) && !negativeBlocks("cbh", rule("", "PHRASE")));
  const mixed = [rule("cat house", "PHRASE", "account"), rule("cat house", "PHRASE", "campaign")];
  ok("the narrowest place a block lives is the one named", firstBlockingNegative("cat house x", mixed)?.source === "campaign");
  ok("the sentence names the type and the place",
    /phrase negative "cat house" on this campaign/.test(blockingNegativePhrase(rule("cat house", "PHRASE")))
    && /shared list "Brand safety"/.test(blockingNegativePhrase({ ...rule("x", "EXACT", "shared_list"), listName: "Brand safety" }))
    && /\(read as a phrase\)/.test(blockingNegativePhrase(rule("x", "UNKNOWN"))));
}

section("2. The three places a negative can live are read, and a source that failed is NAMED");
{
  const camp = shapeCampaignNegativeRules([
    { campaign: { id: "900" }, campaign_criterion: { keyword: { text: "Cat House", match_type: 3 } } },
    { campaign: { id: "900" }, campaign_criterion: { keyword: { text: "ccat", match_type: 4 } } },
  ], dec);
  const shared = shapeSharedNegativeRules(
    [{ campaign: { id: "900" }, shared_set: { id: "7", name: "Brand safety" } }, { campaign: { id: "901" }, shared_set: { id: "7" } }],
    [{ shared_set: { id: "7", name: "Brand safety" }, shared_criterion: { keyword: { text: "jobs", match_type: 3 } } },
     { shared_set: { id: "8", name: "Orphan" }, shared_criterion: { keyword: { text: "nobody", match_type: 3 } } }],
    dec,
  );
  const account = shapeAccountNegativeRules([{ customer_negative_criterion: { keyword: { text: "free", match_type: 2 } } }], dec);
  const facts = combineNegativeRules(camp, shared, account);
  ok("a campaign negative is placed on its own campaign with its decoded type",
    rulesForCampaign(facts, "900")?.some((r) => r.text === "cat house" && r.matchType === "PHRASE" && r.source === "campaign") === true);
  ok("a shared list reaches every campaign it is attached to, and no other",
    rulesForCampaign(facts, "901")?.some((r) => r.text === "jobs" && r.source === "shared_list") === true
    && rulesForCampaign(facts, "902")?.every((r) => r.text !== "jobs") === true);
  ok("a list attached to nobody blocks nothing", rulesForCampaign(facts, "900")?.every((r) => r.text !== "nobody") === true);
  ok("an account-level negative applies to a campaign that has none of its own",
    rulesForCampaign(facts, "902")?.some((r) => r.text === "free" && r.source === "account") === true);
  ok("a campaign is not silenced by ANOTHER campaign's negative",
    rulesForCampaign(facts, "901")?.every((r) => r.text !== "cat house") === true);

  const sharedFailed = combineNegativeRules(camp, null, account);
  ok("a failed shared-list read is named and the campaign negatives still work",
    sharedFailed.unread.join() === "shared negative keyword lists" && sharedFailed.byCampaign != null);
  const accountFailed = combineNegativeRules(camp, shared, null);
  ok("a failed account-level read is named", accountFailed.unread.join() === "account-level negatives");
  const baseFailed = combineNegativeRules(null, shared, account);
  ok("a failed CAMPAIGN read makes everything standing on it unread (null, not an empty map)",
    baseFailed.byCampaign == null && rulesForCampaign(baseFailed, "900") === null);
  ok("rows that arrive and none of which can be placed in a campaign are a failed read, not 'blocks nothing'",
    shapeCampaignNegativeRules([{ campaign_criterion: { keyword: { text: "cbh", match_type: 3 } } }], dec) === null);
  ok("an empty read is an account that blocks nothing, which is an answer",
    shapeCampaignNegativeRules([], dec)?.size === 0);
}

// ── The OCH-shaped book ─────────────────────────────────────────────────────
const TRACKING: TrackingFacts = {
  status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
  actions: [
    { id: "500", name: "Contact form", status: "ENABLED", category: "SUBMIT_LEAD_FORM", actionType: "WEBPAGE", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 60, defaultValue: null, alwaysUseDefaultValue: null },
  ],
};
const ECON: ClientEconomics = {
  customerValueCents: null, customerValueFromClient: false, closeRatePct: null,
  cplCeilingCents: 4_600, cplCeilingMonth: "2026-10",
  // Recorded for the month: about what the account's three budgets add up to.
  adBudgetMonthlyCents: 343_000, adBudgetMonth: "2026-10",
};
const SERVICES: ClientServiceFacts = {
  services: [
    { name: "Addiction recovery centers", note: null },
    { name: "Alcohol rehab", note: null },
  ],
  confirmedBy: "a person", confirmedAt: "2026-10-01", candidatesWaiting: 0,
};

const RN = (id: string) => `customers/1234567890/campaignBudgets/${id}`;
function campaign(over: Partial<CampaignRow> & { id: string; name: string }): CampaignRow {
  return {
    channelType: "SEARCH",
    resourceName: `customers/1234567890/campaigns/${over.id}`,
    bidStrategyType: "MANUAL_CPC", hasBidTarget: false,
    dailyBudgetMicros: 33_000_000, budgetResourceName: RN(over.id),
    costMicros: 0, clicks: 140, impressions: 9_000, conversions: 13,
    impressionShare: 0.6, budgetLostShare: 0.02, rankLostShare: 0.05,
    ...over,
  } as CampaignRow;
}
const cost = (conversions: number, cpaCents: number) => Math.round(conversions * cpaCents * 10_000);
const termRow = (campaignId: string, campaignName: string, term: string, clicks: number, costMicros: number, conversions = 0): SearchTermRow => ({
  term, campaignId, campaignName, adGroupName: "Core", costMicros, clicks, conversions, allConversions: conversions,
});
const adRow = (campaignId: string, campaignName: string, adGroupId: string, adGroupName: string, n: number, finalUrl = "https://example-och.test/"): AdGroupAdRow[] =>
  Array.from({ length: n }, (_, i) => ({
    adGroupId, adGroupName, campaignName, campaignId, adId: `${adGroupId}-${i}`,
    adType: "RESPONSIVE_SEARCH_AD", adStrength: "GOOD", finalUrl,
  }));
const kwRow = (campaignId: string, text: string, finalUrls: string[] | null, over: Partial<ExistingKeyword> = {}): ExistingKeyword => ({
  text, matchType: "PHRASE", adGroupName: "Brand — Core", campaignName: "Branded", campaignId,
  criterionStatus: "ENABLED", adGroupStatus: "ENABLED", campaignStatus: "ENABLED", qualityScore: 7,
  criterionResourceName: `customers/1234567890/adGroupCriteria/55~${text.replace(/\s+/g, "_")}`, finalUrls, ...over,
});

/** The campaigns, in the shapes the owner described. Invented figures. */
const TCS = campaign({
  id: "900", name: "Treatment Center Search", bidStrategyType: "TARGET_CPA", hasBidTarget: true,   // Target CPA $75, set Sep 23
  dailyBudgetMicros: 60_000_000, costMicros: cost(22, 8_442), conversions: 22, clicks: 520, impressions: 21_000,
  budgetLostShare: 0.03,
});
const BRANDED = campaign({
  id: "901", name: "Branded", bidStrategyType: "MANUAL_CPC", hasBidTarget: false,
  dailyBudgetMicros: 33_000_000, costMicros: cost(13, 5_794), conversions: 13, clicks: 200, impressions: 3_000, // $33/day set Sep 30
  budgetLostShare: 0.04,
});
const BRAND_AWARENESS = campaign({
  id: "902", name: "Brand Awareness", bidStrategyType: "MANUAL_CPC", hasBidTarget: false,           // target removed Sep 23
  dailyBudgetMicros: 20_000_000, costMicros: cost(14, 4_400), conversions: 14, clicks: 170, impressions: 12_000,
  budgetLostShare: 0.18,
});

function negatives(extra: { shared?: Map<string, NegativeRule[]> | null; account?: NegativeRule[] | null } = {}): NegativeRuleFacts {
  const campaign = new Map<string, NegativeRule[]>([
    ["900", [
      { text: "cat house", matchType: "PHRASE", source: "campaign" },   // added Oct 5
      { text: "ccat", matchType: "PHRASE", source: "campaign" },        // added Oct 5
    ]],
    ["901", [{ text: "cbh", matchType: "PHRASE", source: "campaign" }]], // added Oct 1
  ]);
  return combineNegativeRules(campaign, extra.shared === undefined ? new Map() : extra.shared, extra.account === undefined ? [] : extra.account);
}
function flat(f: NegativeRuleFacts): ReadonlyMap<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [id, rules] of f.byCampaign ?? []) m.set(id, new Set(rules.map((r) => r.text)));
  return m;
}

const BRAND_KEYWORDS = ["ohio community health", "och", "ohiocommunityhealth"];
function ochKeywords(over: { ownUrls?: boolean } = {}): ExistingKeyword[] {
  const own = over.ownUrls !== false;
  return [
    // The three the brief names, each with a Final URL of its own.
    kwRow("901", "ohio recovery center cincinnati", own ? ["https://example-och.test/locations/cincinnati-ohio/"] : []),
    kwRow("901", "ohio community health cincinnati", own ? ["https://example-och.test/locations/cincinnati-ohio/"] : []),
    kwRow("901", "ohio recovery centers", own ? ["https://example-och.test/addiction-treatment-cincinnati/"] : []),
    // "The rest are the brand name."
    ...BRAND_KEYWORDS.map((t) => kwRow("901", t, [])),
    // A keyword somewhere else carrying a low quality score (a row that must remain).
    kwRow("900", "residential treatment ohio", [], { qualityScore: 3, campaignName: "Treatment Center Search", adGroupName: "Core" }),
    kwRow("900", "alcohol detox cincinnati", [], { qualityScore: 4, campaignName: "Treatment Center Search", adGroupName: "Core" }),
    // Keywords on another provider's name: a score of 1 to 3 is what they earn.
    kwRow("900", "ccat house", [], { qualityScore: 1, matchType: "EXACT", campaignName: "Treatment Center Search", adGroupName: "Core" }),
    kwRow("900", "cat house cincinnati ohio", [], { qualityScore: 3, matchType: "EXACT", campaignName: "Treatment Center Search", adGroupName: "Core" }),
  ];
}

/** The two keywords whose totals sat unchanged on every run since 30 Sep. */
const stoppedKeyword = (text: string, costMicros: number, lastSpendOn: string | null): KeywordRow => ({
  criterionResourceName: `customers/1234567890/adGroupCriteria/55~${text.replace(/\s+/g, "_")}`,
  text, matchType: "PHRASE", qualityScore: 7, campaignId: "901", campaignName: "Branded", adGroupName: "Brand — Core",
  costMicros, clicks: 60, conversions: 0, finalUrls: [], lastSpendOn,
});
const OCH_STOPPED = (last: string | null = "2026-09-12"): KeywordRow[] => [
  stoppedKeyword("ohio recovery center cincinnati", 76_940_000, last),
  stoppedKeyword("ohio recovery centers", 68_060_000, last),
];

function och(over: Partial<AuditInput> = {}, opts: { ownUrls?: boolean } = {}): AuditInput {
  const negs = negatives();
  return {
    platform: "google_ads", accountId: "1234567890",
    windowStart: "2026-07-09", windowEnd: "2026-10-06",
    campaigns: [TCS, BRANDED, BRAND_AWARENESS],
    searchTerms: [
      // item 1: three converting queries that a negative already blocks
      termRow("900", "Treatment Center Search", "cat house cincinnati", 14, 60_000_000, 3),
      termRow("900", "Treatment Center Search", "ccat house", 9, 41_000_000, 2),
      termRow("901", "Branded", "cbh hamilton ohio", 8, 33_000_000, 2),
      // item 3: core searches the waste rule used to propose as negatives, and
      // one ordinary waste term so the row exists to list them under
      termRow("900", "Treatment Center Search", "recovery centers", 3, 40_000_000),
      termRow("900", "Treatment Center Search", "medicaid alcohol rehab", 2, 36_000_000),
      termRow("900", "Treatment Center Search", "free rehab cincinnati", 6, 60_000_000),
    ],
    keywords: OCH_STOPPED(),
    competitorNames: ["ccat house", "cat house"],
    ads: [
      // Every ad in Branded points at the front page (item 2). Brand Awareness
      // and Treatment Center Search send to real pages.
      ...adRow("901", "Branded", "55", "Brand — Core", 2),
      ...adRow("900", "Treatment Center Search", "60", "Core", 2, "https://example-och.test/addiction-treatment/"),
      ...adRow("900", "Treatment Center Search", "61", "Detox", 1, "https://example-och.test/detox/"),     // thin
      ...adRow("902", "Brand Awareness", "70", "Awareness", 2, "https://example-och.test/about/"),
    ],
    existingNegatives: new Set(Array.from(flat(negs).values()).flatMap((s) => Array.from(s))),
    negativesByCampaign: flat(negs),
    negativeRules: negs,
    brandPatterns: derivedBrandPatterns({ name: "Ohio Community Health", aliases: "OCH", seo_domain: "www.ohiocommunityhealth.com" }),
    protectedPatterns: ["ohio community health", "och", "ohiocommunityhealth"],
    tracking: TRACKING,
    economics: ECON,
    services: SERVICES,
    conversionLag: [], dailyConversions: [],
    searchTermSpendByCampaign: { "900": cost(22, 8_442) * 0.9, "901": 160_000_000, "902": 500_000_000 },
    existingKeywords: ochKeywords(opts),
    ...over,
  } as AuditInput;
}

const types = (fs: { findingType: string }[]) => fs.map((f) => f.findingType);
const find = (fs: ReturnType<typeof evaluate>, t: string, name?: string) =>
  fs.filter((f) => f.findingType === t && (name == null || f.entityName === name));

// ── 3. Item 1: converting_search_term ───────────────────────────────────────
section("3. converting_search_term: a query a negative already blocks is not recommended as a keyword");
const book = evaluateAudit(och());
{
  const promo = find(book.findings, "converting_search_term");
  ok("the three queries the brief names produce no converting_search_term row", promo.length === 0, `${promo.length} rows`);
  const blocked = book.accounting.promotionsBlocked;
  const by = (term: string) => blocked.find((b) => b.term === term);
  ok("each is ACCOUNTED FOR, not silently gone",
    blocked.length === 3 && ["cat house cincinnati", "ccat house", "cbh hamilton ohio"].every((t) => by(t)));
  ok("…and names the negative that blocks it, on the right campaign",
    by("cat house cincinnati")?.by.text === "cat house" && by("ccat house")?.by.text === "ccat"
    && by("cbh hamilton ohio")?.by.text === "cbh" && by("cbh hamilton ohio")?.campaignName === "Branded");
  const lines = accountingLines(book.accounting).join("\n");
  ok("the run's output counts them by campaign and names each blocking negative",
    /Treatment Center Search: 2 converting queries not recommended as a keyword because a negative already blocks them: "cat house" \(phrase, 1\), "ccat" \(phrase, 1\)/.test(lines)
    && /Branded: 1 converting query not recommended as a keyword because a negative already blocks it: "cbh" \(phrase, 1\)/.test(lines), lines.split("\n")[0] ?? "");
  ok("the one source never read is said on every run", /Negatives set on an individual ad group are not read/.test(lines));

  // The positive control: without the negatives the same queries ARE recommended.
  const noNegs = evaluateAudit(och({ negativeRules: combineNegativeRules(new Map(), new Map(), []) }));
  const row = find(noNegs.findings, "converting_search_term");
  ok("control: with no negatives in place the same queries are recommended",
    row.length === 2 && /cat house cincinnati/.test(row.map((r) => r.evidence.lines.join(" ")).join(" "))
    && /cbh hamilton ohio/.test(row.map((r) => r.evidence.lines.join(" ")).join(" ")),
    `${row.length} rows`);
  ok("control: nothing was dropped when nothing blocks", noNegs.accounting.promotionsBlocked.length === 0);

  // Match types: an EXACT negative on "cat house" does not block "cat house cincinnati".
  const exact = evaluateAudit(och({
    negativeRules: combineNegativeRules(new Map([["900", [{ text: "cat house", matchType: "EXACT", source: "campaign" }]]]), new Map(), []),
  }));
  ok("an exact negative does not block a longer query, so it is still recommended",
    find(exact.findings, "converting_search_term", "Treatment Center Search").length === 1
    && exact.accounting.promotionsBlocked.every((b) => b.term !== "cat house cincinnati"));

  // A shared list and an account-level negative block too.
  const viaShared = evaluateAudit(och({
    negativeRules: combineNegativeRules(new Map(), new Map([["900", [{ text: "cat house", matchType: "PHRASE", source: "shared_list", listName: "Brand safety" }]]]), [
      { text: "ccat", matchType: "PHRASE", source: "account" }, { text: "cbh", matchType: "PHRASE", source: "account" },
    ]),
  }));
  ok("a negative in a shared list, and one on the account, block a query exactly as a campaign's own does",
    viaShared.accounting.promotionsBlocked.length === 3
    && viaShared.accounting.promotionsBlocked.some((b) => b.by.source === "shared_list")
    && viaShared.accounting.promotionsBlocked.some((b) => b.by.source === "account"));

  // Unread negatives drop NOTHING and say so.
  const unread = evaluateAudit(och({ negativeRules: { byCampaign: null, account: [], unread: [] } }));
  const urow = find(unread.findings, "converting_search_term");
  ok("with the negatives UNREAD nothing is dropped, and the row says it could not check",
    urow.length === 2 && unread.accounting.negativesRead === false
    && urow.every((r) => /negative keywords could not be read/.test(r.evidence.lines.join(" "))));
  const partial = evaluateAudit(och({ negativeRules: { ...negatives(), unread: ["shared negative keyword lists"] } }));
  ok("with only a shared-list read failed, the blocked queries still drop and the run names the gap",
    partial.accounting.promotionsBlocked.length === 3
    && partial.accounting.negativeSourcesUnread.join() === "shared negative keyword lists"
    && /could not read shared negative keyword lists/.test(accountingLines(partial.accounting).join("\n")));
}

// ── 4. Item 2: generic_landing_page ─────────────────────────────────────────
section("4. generic_landing_page: a keyword's own Final URL counts, and the brand may land on the front page");
{
  ok("the brief's fixture clears the row: three keywords with their own page, the rest are the brand name",
    find(book.findings, "generic_landing_page").length === 0);
  const landing = book.accounting.landing.find((l) => l.campaignName === "Branded");
  ok("…and it is accounted for, with how the keywords landed",
    landing?.cleared === true && landing.counts.ownPage === 3 && landing.counts.brand === 3 && landing.counts.onFront === 0,
    JSON.stringify(landing?.counts ?? null));
  ok("the run says so in words", /Branded: landing-page row cleared\. 6 keywords serve in this campaign: 3 have a page of their own, 3 are the client's own name/.test(accountingLines(book.accounting).join("\n")));

  const noOwn = evaluateAudit(och({}, { ownUrls: false }));
  const row = find(noOwn.findings, "generic_landing_page", "Branded");
  ok("control: with no keyword carrying its own page the row is raised",
    row.length === 1, `${row.length} rows`);
  ok("…and says that two keywords land on the front page without being the brand (the third is the brand plus a city)",
    /2 land on the front page/.test(row[0]?.evidence.lines.join(" ") ?? "") && /4 are the client's own name/.test(row[0]?.evidence.lines.join(" ") ?? ""),
    row[0]?.evidence.lines.slice(-3).join(" | ") ?? "none");
  ok("…and that the spend is an upper bound", /upper bound/.test(row[0]?.evidence.lines.join(" ") ?? ""));
  ok("…with the keyword counts as metrics", row[0]?.evidence.metrics.keywordsOnFront === 2 && row[0]?.evidence.metrics.keywordsBrand === 4);

  const brandOnly = evaluateAudit(och({ brandPatterns: null }));
  const bo = find(brandOnly.findings, "generic_landing_page", "Branded");
  ok("with the client's name unavailable no keyword is accepted as a brand, and the row says so",
    bo.length === 1 && /own name was not available/.test(bo[0]?.evidence.lines.join(" ") ?? ""));

  const unreadKw = evaluateAudit(och({ existingKeywords: null }));
  const uk = find(unreadKw.findings, "generic_landing_page", "Branded");
  ok("with the keyword list unread the row is judged on the ads alone, and says so",
    uk.length === 1 && /could not be read this run, so this is judged on the ads alone/.test(uk[0]?.evidence.lines.join(" ") ?? ""));

  const oneMore = och();
  oneMore.existingKeywords = [...(oneMore.existingKeywords ?? []), kwRow("901", "ohio rehab directory", [])];
  const om = find(evaluateAudit(oneMore).findings, "generic_landing_page", "Branded");
  ok("one keyword that is neither a page of its own nor the brand keeps the row open",
    om.length === 1 && /1 lands on the front page/.test(om[0]?.evidence.lines.join(" ") ?? ""));

  const pausedOnly = och();
  pausedOnly.existingKeywords = (pausedOnly.existingKeywords ?? []).map((k) =>
    k.text === "ohio community health" ? { ...k, text: "ohio rehab directory", criterionStatus: "PAUSED" } : k);
  ok("a paused keyword is not a landing at all",
    find(evaluateAudit(pausedOnly).findings, "generic_landing_page", "Branded").length === 0);

  const unknownState = och();
  unknownState.existingKeywords = (unknownState.existingKeywords ?? []).map((k) =>
    k.text === "och" ? { ...k, criterionStatus: null } : k);
  ok("a keyword whose serving state could not be read is counted as landing there, never waved through",
    find(evaluateAudit(unknownState).findings, "generic_landing_page", "Branded").length === 1);

  ok("a keyword with its own URL that is itself the front page is still the front page",
    classifyKeywordLanding([{ campaignId: "1", text: "something else", finalUrls: ["https://example-och.test/"], canServe: "yes" }], BRAND_KEYWORDS).onFront === 1);
  ok("isBrandKeyword is whole-word and contiguous", isBrandKeyword("ohio community health cincinnati", ["ohio community health"])
    && !isBrandKeyword("ohio health community", ["ohio community health"]) && !isBrandKeyword("pooch", ["och"]));
  ok("isSiteRoot is unchanged", isSiteRoot("https://example-och.test/") && !isSiteRoot("https://example-och.test/locations/"));
  ok("the client's brand is the name, the aliases and the domain label, and nothing the client typed as a protected term",
    derivedBrandPatterns({ name: "Ohio Community Health", aliases: "OCH, ab", seo_domain: "www.ohiocommunityhealth.com" }).sort().join("|")
      === ["och", "ohio community health", "ohiocommunityhealth"].sort().join("|"));
}

// ── 5. Item 3: wasted_search_term ───────────────────────────────────────────
section("5. wasted_search_term: never propose a negative that blocks a service the client sells");
{
  const row = find(book.findings, "wasted_search_term", "Treatment Center Search")[0];
  const body = JSON.stringify(row?.changePayload ?? {});
  ok("the row still exists for the ordinary waste term", Boolean(row) && /free rehab cincinnati/.test(body));
  ok("'recovery centers' and 'medicaid alcohol rehab' are NOT in the proposed negatives",
    !/recovery centers/.test(body) && !/medicaid alcohol rehab/.test(body), body.slice(0, 200));
  const notes = row?.evidence.notes?.join("\n") ?? "";
  ok("each is listed once under the row as a core search, not blocked, with its spend",
    /core search, not blocked · \$40\.00 · 3 clicks · "recovery centers"/.test(notes)
    && /core search, not blocked · \$36\.00 · 2 clicks · "medicaid alcohol rehab"/.test(notes), notes);
  ok("…naming the service that would have been blocked",
    /would also block "Addiction recovery centers"/.test(notes) && /carries every word of "Alcohol rehab"/.test(notes));
  ok("…and they are NOT among the row's records (the dashboard counts those as what a decision is measured against)",
    !/recovery centers/.test(row?.evidence.lines.join("\n") ?? ""));
  ok("the figures on the row do not count what was held back",
    row?.evidence.metrics.termCount === 1);

  const acct = book.accounting.coreSearchesNotBlocked;
  ok("the run accounts for both, naming their services",
    acct.length === 2 && /Treatment Center Search: 2 core searches not proposed as negatives \("Addiction recovery centers", "Alcohol rehab"\)/.test(accountingLines(book.accounting).join("\n")));

  const noServices = evaluate(och({ services: { services: null, confirmedBy: null, confirmedAt: null, candidatesWaiting: 2 } }));
  const nsBody = JSON.stringify(find(noServices, "wasted_search_term", "Treatment Center Search")[0]?.changePayload ?? {});
  ok("control: with no confirmed services list the core searches ARE proposed, and the row says they were not checked",
    /recovery centers/.test(nsBody) && /services are not confirmed/.test(find(noServices, "wasted_search_term")[0]?.evidence.lines.join(" ") ?? ""));

  const allCore = evaluateAudit(och({
    searchTerms: [
      termRow("900", "Treatment Center Search", "recovery centers", 3, 40_000_000),
      termRow("900", "Treatment Center Search", "medicaid alcohol rehab", 2, 36_000_000),
    ],
  }));
  ok("a campaign whose every candidate was held back has no row, and that is counted and named",
    find(allCore.findings, "wasted_search_term").length === 0
    && allCore.accounting.wasteRowsNotRaised.length === 1
    && /Treatment Center Search: 2 searches \(\$76\.00 over 90 days\) converted nothing and were not proposed as negatives because they are core searches\. No row was raised\./.test(accountingLines(allCore.accounting).join("\n")));

  ok("serviceBlockVerdict: a term inside a service's own name is held; the same words in another order are not",
    serviceBlockVerdict("recovery centers", SERVICES.services!)?.relation === "part_of"
    && serviceBlockVerdict("centers recovery", SERVICES.services!) === null
    && serviceBlockVerdict("medicaid alcohol rehab", SERVICES.services!)?.relation === "covers"
    && serviceBlockVerdict("free rehab cincinnati", SERVICES.services!) === null);
  ok("a service the client does NOT sell can never hold a negative back (only confirmed 'offers' are passed in)",
    serviceBlockVerdict("recovery centers", [{ name: "Detox", note: null }]) === null);
}

// ── 6. Budget routing ───────────────────────────────────────────────────────
section("6. budget_limited on an account spending the budget the client approved");
{
  const row = find(book.findings, "budget_limited", "Brand Awareness")[0];
  ok("Brand Awareness at $20/day is capped, converts under target, and is marked for the client's budget decision",
    Boolean(row) && row?.evidence.metrics.atApprovedBudget === 1, row?.title ?? "no row");
  ok("…with no payload to apply and no separate Grow action", row?.changePayload === null && row?.applicability === "vendor" && row?.severity === "low");
  ok("…and the sentence names the figures and where the request goes",
    /More ad budget on the client's page, then Ask the client/.test(row?.summary ?? "")
    && /\$3430\.00 a month recorded as the client's ad budget \(for 2026-10\)/.test(row?.summary ?? ""), row?.summary.slice(0, 220) ?? "");
  ok("…and carries the budget's own id, so a change to that budget can be matched to the row",
    row?.evidence.metrics.budgetResourceId === 902, String(row?.evidence.metrics.budgetResourceId));
  ok("it is accounted for in the run", book.accounting.budgetRoutedToClient.length === 1
    && /Brand Awareness: budget row marked for the client's budget decision/.test(accountingLines(book.accounting).join("\n")));

  const unset = evaluateAudit(och({ economics: { ...ECON, adBudgetMonthlyCents: null, adBudgetMonth: null } }));
  const ur = find(unset.findings, "budget_limited", "Brand Awareness")[0];
  ok("control: with no approved budget recorded the row is the ordinary Grow row, with its payload",
    ur?.changePayload != null && ur.evidence.metrics.atApprovedBudget === undefined
    && /No ad budget is recorded for this client/.test(ur.evidence.lines.join(" ")));
  const roomLeft = evaluateAudit(och({ economics: { ...ECON, adBudgetMonthlyCents: 600_000 } }));
  ok("control: with room left under the approved budget raising it is not the client's decision",
    find(roomLeft.findings, "budget_limited", "Brand Awareness")[0]?.changePayload != null);
  ok("the approved budget is compared with the account's budgets, a shared budget counted once",
    accountMonthlyBudgetCents([
      { id: "1", dailyBudgetMicros: 50_000_000, budgetResourceName: "b1" },
      { id: "2", dailyBudgetMicros: 50_000_000, budgetResourceName: "b1" },
      { id: "3", dailyBudgetMicros: 10_000_000, budgetResourceName: null },
    ]) === Math.round(6_000 * 30.4 * 100 / 100 * 1));
  ok("atApprovedBudget is null where nothing is recorded, never false",
    atApprovedBudget(300_000, null) === null && atApprovedBudget(300_000, 0) === null
    && atApprovedBudget(95_000, 100_000) === true && atApprovedBudget(94_999, 100_000) === false
    && APPROVED_BUDGET_REACHED_SHARE === 0.95);

  const overTarget = evaluateAudit(och({ campaigns: [TCS, BRANDED, { ...BRAND_AWARENESS, costMicros: cost(14, 7_000) }] }));
  const ot = find(overTarget.findings, "budget_limited", "Brand Awareness")[0];
  ok("a campaign over its cost target is NOT routed: that row waits on the cost row, as it always did",
    ot?.evidence.metrics.atApprovedBudget === undefined && ot?.changePayload === null);
}

// ── 7. Stay manual ──────────────────────────────────────────────────────────
section("7. A campaign under the conversions a cost target needs is told to stay as it is");
{
  const branded = find(book.findings, "cpa_above_target", "Branded")[0];
  ok("Branded at 13 conversions a month still has its cost row (it is above $46)", Boolean(branded));
  ok("…raises no bid_target_absent row", find(book.findings, "bid_target_absent").length === 0);
  ok("…and says 'Stay manual' before the held-back sentence",
    /Stay manual until the campaign has the conversions for a target to steer on/.test(branded?.evidence.lines.join(" | ") ?? "")
    && /A cost target is held back/.test(branded?.evidence.lines.join(" | ") ?? ""), branded?.evidence.lines.slice(-4).join(" | ") ?? "none");
  ok("…and the run accounts for it", book.accounting.targetHeld.some((t) => t.campaignName === "Branded" && t.conversions === 13));
  const auto = evaluate(och({ campaigns: [TCS, { ...BRANDED, bidStrategyType: "MAXIMIZE_CONVERSIONS" }, BRAND_AWARENESS] }));
  const ar = find(auto, "cpa_above_target", "Branded")[0];
  ok("a campaign on an automated strategy is NOT told to stay manual — it is told to leave the target off",
    /Leave the bidding as it is, with no cost target set/.test(ar?.evidence.lines.join(" ") ?? "")
    && !/Stay manual/.test(ar?.evidence.lines.join(" ") ?? ""));
  const enough = evaluate(och({ campaigns: [TCS, { ...BRANDED, bidStrategyType: "MAXIMIZE_CONVERSIONS", conversions: 20, costMicros: cost(20, 7_000) }, BRAND_AWARENESS] }));
  ok("control: at 20 conversions the target IS recommended", find(enough, "bid_target_absent", "Branded").length === 1);
  ok("stayPutLine says nothing for a reading it cannot make", stayPutLine("cant_tell", "conversions") === null && stayPutLine("targeted", "conversions") === null);
}

// ── 8. The done-when: the OCH book, end to end ──────────────────────────────
section("8. Done when: only the rows that are still real work remain");
{
  const got = Array.from(new Set(types(book.findings))).sort();
  const gone = ["converting_search_term", "generic_landing_page", "bid_target_absent"];
  ok("none of the four rows the brief names is raised", gone.every((t) => !got.includes(t)), got.join(", "));
  const stays = {
    "cost per conversion above $46 (Treatment Center Search)": find(book.findings, "cpa_above_target", "Treatment Center Search").length === 1,
    "cost per conversion above $46 (Branded)": find(book.findings, "cpa_above_target", "Branded").length === 1,
    "low quality scores": find(book.findings, "low_quality_score").length === 1,
  };
  for (const [k, v] of Object.entries(stays)) ok(`still raised: ${k}`, v);
  // The low-score row counts the two keywords that score low on COPY and none
  // of the two on a competitor's name (item 5).
  const qs = find(book.findings, "low_quality_score")[0];
  ok("the low-quality-score row counts only the keywords that are not a competitor's name",
    qs?.evidence.metrics.keywordCount === 2
    && qs.evidence.lines.some((l) => /"residential treatment ohio"/.test(l))
    && !qs.evidence.lines.some((l) => /"ccat house"|"cat house cincinnati ohio"/.test(l)),
    qs?.title ?? "no row");
  const unexpected = book.findings.filter((f) => ![
    "cpa_above_target", "low_quality_score",
    // Rows the app labels or routes at read time, and rows about the account's own records.
    "wasted_search_term", "budget_limited", "thin_ad_group",
    "keyword_gap", "growth_unreadable", "outcome_feedback_gap", "proxy_conversion_value",
    "headroom", "unmet_demand", "rank_limited", "call_tracking_absent", "no_conversions",
    // A keyword that stopped spending: kept, low, claims no saving (item 6).
    "dead_keyword",
  ].includes(f.findingType));
  ok("nothing else appears", unexpected.length === 0, unexpected.map((f) => f.findingType).join(", "));
  const dead = find(book.findings, "dead_keyword");
  ok("the two keywords that stopped spending are not ranked as live waste",
    dead.length === 2 && dead.every((d) => d.severity === "low" && d.estImpactCents === 0 && (d.atStakeCents ?? 0) === 0
      && /no spend since 2026-09-12/.test(d.title)), dead.map((d) => d.title).join(" | "));
  console.log(`     raised: ${got.join(", ")}`);
  ok("every campaign-level row that dropped is in the accounting (blocked + landing + core held)",
    book.accounting.promotionsBlocked.length + book.accounting.coreSearchesNotBlocked.length + book.accounting.landing.filter((l) => l.cleared).length === 6);
}

section("9. Determinism and the version");
{
  const again = evaluateAudit(och());
  ok("two runs over the same book produce byte-identical findings and accounting",
    JSON.stringify(again) === JSON.stringify(book));
  ok("the ruleset version moved with the rules", ADS_RULESET_VERSION === 10);
}

// ── 10. A target that is set above the recorded ceiling ─────────────────────
section("10. A step-down has a state: target $75, ceiling $46");
{
  const withTarget = (micros: number | null) =>
    och({ campaigns: [{ ...TCS, bidTargetMicros: micros }, BRANDED, BRAND_AWARENESS] });
  const row = (micros: number | null) =>
    find(evaluateAudit(withTarget(micros)).findings, "cpa_above_target", "Treatment Center Search")[0];
  const above = row(75_000_000);
  ok("a $75 target against a $46 ceiling says so on the row",
    /Target \$75\.00 · ceiling \$46\.00 · stepping down/.test(above?.evidence.lines.join(" | ") ?? ""),
    above?.evidence.lines.join(" | ") ?? "no row");
  ok("…and carries both figures as metrics, with the flag",
    above?.evidence.metrics.bidTargetCents === 7_500 && above?.evidence.metrics.targetCents === 4_600 && above?.evidence.metrics.steppingDown === 1);
  const within = row(40_000_000);
  ok("a target at or under the ceiling is NOT a step-down, and says the result is missing the price",
    /at or under the ceiling/.test(within?.evidence.lines.join(" | ") ?? "") && within?.evidence.metrics.steppingDown === undefined);
  const unread = row(null);
  ok("a target figure that was not read adds no line at all (never 'within', never 'above')",
    !/Target \$/.test(unread?.evidence.lines.join(" | ") ?? "") && unread?.evidence.metrics.steppingDown === undefined);
  ok("the pure reading: a return-on-spend target carries no cents, so no comparison",
    targetStep(bidTargetReading({ strategyType: "TARGET_ROAS", hasTarget: true, targetCpaMicros: null, targetRead: true }), 4_600).state === "unknown");
  ok("…and an estimated ceiling is called an estimate",
    /estimated ceiling \$46\.00/.test(targetStep(bidTargetReading({ strategyType: "TARGET_CPA", hasTarget: true, targetCpaMicros: 75_000_000, targetRead: true }), 4_600, true).line));
  ok("a campaign with NO target still gets the no-target reading, unchanged",
    find(evaluate(och({ campaigns: [TCS, { ...BRANDED, bidStrategyType: "MAXIMIZE_CONVERSIONS", conversions: 20, costMicros: cost(20, 7_000) }, BRAND_AWARENESS] })), "bid_target_absent", "Branded").length === 1);
}

// ── 11. A keyword that stopped spending ─────────────────────────────────────
section("11. dead_keyword: 'no spend since', and not ranked as live waste");
{
  const deadOf = (last: string | null) =>
    find(evaluateAudit(och({ keywords: OCH_STOPPED(last) })).findings, "dead_keyword");
  const stopped = deadOf("2026-09-12");
  ok("a keyword idle for 24 days says 'no spend since' in its title and claims no saving",
    stopped.length === 2 && stopped.every((d) => /no spend since 2026-09-12/.test(d.title) && d.estImpactCents === 0 && d.severity === "low"),
    stopped[0]?.title ?? "none");
  ok("…the evidence line names the date and keeps the old total as history",
    /No spend since 2026-09-12 \(24 days/.test(stopped[0]?.evidence.lines[0] ?? "") && stopped[0]?.evidence.metrics.stoppedSpending === 1);
  ok("…and the run accounts for both", evaluateAudit(och({ keywords: OCH_STOPPED("2026-09-12") })).accounting.keywordsStopped.length === 2
    && /2 keywords with no spend for over two weeks/.test(accountingLines(evaluateAudit(och({ keywords: OCH_STOPPED("2026-09-12") })).accounting).join("\n")));
  const recent = deadOf("2026-09-30");
  ok("control: spend six days ago is still live waste, with its saving and its severity",
    recent.length === 2 && recent.every((d) => d.severity === "high" && d.estImpactCents > 0 && !/no spend since/.test(d.title)));
  const unknown = deadOf(null);
  ok("control: a last-spend date that was not read changes nothing (null is never 'stopped')",
    unknown.length === 2 && unknown.every((d) => d.severity === "high" && d.estImpactCents > 0));
  ok("the idle count is whole days, and null for a date that is missing or unreadable",
    daysIdle("2026-09-12", "2026-10-06") === 24 && daysIdle(null, "2026-10-06") === null && daysIdle("last tuesday", "2026-10-06") === null
    && STOPPED_SPENDING_DAYS === 14 && daysIdle("2026-09-22", "2026-10-06") === 14);
  ok("exactly two weeks idle is not yet stopped (the line is 'over' fourteen)",
    deadOf("2026-09-22").every((d) => d.severity === "high"));
}

// ── 12. A competitor's name is judged on cost ───────────────────────────────
section("12. low_quality_score: a keyword on a recorded competitor name is judged on cost per conversion");
{
  const withNames = evaluateAudit(och());
  const row = find(withNames.findings, "low_quality_score")[0];
  const notes = row?.evidence.notes?.join("\n") ?? "";
  ok("[ccat house] QS 1 and [cat house cincinnati ohio] QS 3 are set aside, not counted",
    row?.evidence.metrics.keywordCount === 2 && /2 keywords are on a competitor's name/.test(notes));
  ok("…each is listed under the row with what it cost, so it is judged on cost",
    /competitor name, judged on cost · QS 1 · no spend recorded in this window · "ccat house"/.test(notes)
    && /QS 3 · .* "cat house cincinnati ohio"/.test(notes), notes.split("\n").slice(0, 3).join(" / "));
  ok("…and the run accounts for them", withNames.accounting.competitorKeywords.some((c) => c.campaignName === "Treatment Center Search" && c.count === 2));
  ok("with a recorded list the 'not recorded' sentence is gone",
    !row?.evidence.lines.some((l) => l === COMPETITOR_NAMES_NOT_RECORDED));

  const none = evaluateAudit(och({ competitorNames: null }));
  const nr = find(none.findings, "low_quality_score")[0];
  ok("control: with NO list recorded all four low scores are counted, and the row says what to record and where",
    nr?.evidence.metrics.keywordCount === 4 && nr.evidence.lines.includes(COMPETITOR_NAMES_NOT_RECORDED)
    && /Ads tab/.test(COMPETITOR_NAMES_NOT_RECORDED) && none.accounting.competitorKeywords.length === 0);
  const emptyList = evaluateAudit(och({ competitorNames: [] }));
  ok("control: an EMPTY list behaves as none recorded (it is never read as 'this client has no rivals')",
    find(emptyList.findings, "low_quality_score")[0]?.evidence.metrics.keywordCount === 4);
  ok("matching is whole-word and in order: 'cat house' is not 'concatenate house' or 'house cat'",
    matchesRecordedName("cat house cincinnati ohio", ["cat house"])
    && !matchesRecordedName("concatenate house", ["cat house"]) && !matchesRecordedName("house cat", ["cat house"]));
  ok("the protected-term list is NOT the competitor list (a keyword that is only protected is still counted)",
    find(evaluateAudit(och({ competitorNames: null, protectedPatterns: ["ccat house"] })).findings, "low_quality_score")[0]?.evidence.metrics.keywordCount === 4);
  ok("parseCompetitorNames: lines, commas and repeats fold; blank is null, never an empty list",
    JSON.stringify(parseCompetitorNames("CCAT House\nccat  house, Cat House;\n")) === JSON.stringify(["CCAT House", "Cat House"])
    && parseCompetitorNames("  \n ") === null && parseCompetitorNames(null) === null);
  ok("the note says 'no conversions' plainly where a competitor keyword spent and converted nothing",
    /0 conversions/.test(competitorKeywordNote({ text: "x y", campaignName: "C", score: 2, costMicros: 12_000_000, conversions: 0 }))
    && /\$4\.00 a conversion/.test(competitorKeywordNote({ text: "x y", campaignName: "C", score: 2, costMicros: 12_000_000, conversions: 3 }))
    && /conversions not read/.test(competitorKeywordNote({ text: "x y", campaignName: "C", score: 2, costMicros: 12_000_000, conversions: null })));
  const allCompetitors = evaluateAudit(och({
    existingKeywords: [
      kwRow("900", "ccat house", [], { qualityScore: 1, campaignName: "Treatment Center Search", adGroupName: "Core" }),
      kwRow("900", "cat house cincinnati ohio", [], { qualityScore: 3, campaignName: "Treatment Center Search", adGroupName: "Core" }),
    ],
  }));
  ok("when every low score is a competitor's name there is NO row at all, and it is counted",
    find(allCompetitors.findings, "low_quality_score").length === 0 && allCompetitors.accounting.competitorKeywords[0]?.count === 2);
}

// ── 13. Every term, not the first twelve ────────────────────────────────────
section("13. The evidence stores every record");
{
  const many = (n: number) => Array.from({ length: n }, (_, i) =>
    termRow("900", "Treatment Center Search", `cheap thing ${String(i).padStart(3, "0")}`, 3, 30_000_000 + i));
  const wasted = (n: number) => find(evaluateAudit(och({ searchTerms: many(n) })).findings, "wasted_search_term")[0];
  const w22 = wasted(22);
  const quoted = (lines: string[]) => lines.filter((l) => /"cheap thing \d+"/.test(l)).length;
  ok("22 wasted terms are 22 lines, with no 'and 10 more' marker",
    quoted(w22?.evidence.lines ?? []) === 22 && !(w22?.evidence.lines ?? []).some((l) => /…and \d+ more/.test(l)));
  ok("…and the row's own count agrees with what is listed", w22?.evidence.metrics.termCount === 22);
  const w60 = wasted(60);
  ok("60 terms: all 60 are listed, and the note says the proposal applies the dearest 50",
    quoted(w60?.evidence.lines ?? []) === 60 && /applies the 50 dearest of these 60/.test(w60?.evidence.notes?.join(" ") ?? "")
    && (w60?.changePayload as { body: { keywords: string[] }[] } | null)?.body[0]?.keywords.length === 50);
  const wBig = wasted(EVIDENCE_LIST_CEILING + 40);
  ok("past the ceiling the list ends in the SAME tail marker the dashboard reads as 'cut short', so a cut list is still said to be cut",
    quoted(wBig?.evidence.lines ?? []) === EVIDENCE_LIST_CEILING && (wBig?.evidence.lines ?? []).includes("…and 40 more"));
  ok("recordLines: at the ceiling exactly there is no marker; one over has one",
    recordLines(Array.from({ length: EVIDENCE_LIST_CEILING }, (_, i) => i), String).length === EVIDENCE_LIST_CEILING
    && recordLines(Array.from({ length: EVIDENCE_LIST_CEILING + 1 }, (_, i) => i), String).slice(-1)[0] === "…and 1 more");
  const qsMany = evaluateAudit(och({
    existingKeywords: Array.from({ length: 23 }, (_, i) => kwRow("900", `thin keyword ${i}`, [], { qualityScore: 2, campaignName: "Treatment Center Search", adGroupName: "Core" })),
    competitorNames: null,
  }));
  const q = find(qsMany.findings, "low_quality_score")[0];
  ok("23 low-score keywords are 23 lines, not ten and a marker",
    (q?.evidence.lines ?? []).filter((l) => /^QS 2 ·/.test(l)).length === 23 && !(q?.evidence.lines ?? []).some((l) => /…and \d+ more/.test(l)));
  const thin = evaluateAudit(och({ ads: Array.from({ length: 12 }, (_, i) => adRow("900", "Treatment Center Search", `g${i}`, `Group ${i}`, 1)).flat() }));
  ok("12 thin ad groups are 12 lines",
    (find(thin.findings, "thin_ad_group")[0]?.evidence.lines ?? []).filter((l) => /— 1 ad/.test(l)).length === 12);
}

// ── 14. The lead count says what it counts ──────────────────────────────────
section("14. outcome_feedback_gap: forms, calls and unnamed leads are counted apart");
{
  const facts: OutcomeFeedFacts = {
    leadsInWindow: 1_616, gclidLeadsInWindow: 475, newestGclidLeadOn: "2026-10-04",
    split: { forms: 340, calls: 1_100, unclassified: 176, gclidForms: 62, gclidCalls: 400, gclidUnclassified: 13 },
    windowStart: "2026-07-09", windowEnd: "2026-10-06",
    crmRowsInWindow: 12, wonInWindow: 3, wonWindowMonths: 6, measuredWonValueCents: null, uploadsEver: 0, newestUploadOn: null,
  };
  const r = outcomeReadiness(facts, ECON);
  const text = r?.lines.join(" | ") ?? "";
  ok("the first line names the window it counts over", /475 of 1616 leads in the window \(2026-07-09 to 2026-10-06\)/.test(text), text.slice(0, 160));
  ok("…and the next splits it into site forms, tracked calls and unnamed rows, each with its click-id count",
    /340 site forms \(62 with a click id\), 1100 tracked calls \(400\) and 176 with no form name, so could be either \(13\)/.test(text));
  ok("…and says why a jump is not an enquiry jump", /raises the count without one new enquiry/.test(text));
  ok("the three parts add to the whole",
    facts.split!.forms + facts.split!.calls + facts.split!.unclassified === facts.leadsInWindow
    && facts.split!.gclidForms + facts.split!.gclidCalls + facts.split!.gclidUnclassified === facts.gclidLeadsInWindow);
  const noSplit = outcomeReadiness({ ...facts, split: undefined, windowStart: null, windowEnd: null }, ECON);
  ok("control: with no split gathered the line says nothing about one (it is never invented)",
    !/site form/.test(noSplit?.lines.join(" ") ?? "") && /in the window carry a Google click id/.test(noSplit?.lines[0] ?? ""));
  const s = splitOf({ leads: "1616", gclid_leads: "475", calls: "1100", blank: "176", gclid_calls: "400", gclid_blank: "13" });
  ok("splitOf takes forms as what is left after calls and unnamed, so the three always add",
    s.forms === 340 && s.gclidForms === 62);
}

// ── 15. A close rate that is missing says WHY ───────────────────────────────
section("15. proxy_conversion_value: the reason a close rate is missing is the record's, not a guess");
{
  const base = { customerValueCents: 600_000, customerValueFromClient: true, closeRatePct: null as number | null };
  const missingText = (why: Parameters<typeof proxyConversionValue>[0] extends infer E ? (E extends { closeRateWhy?: infer W } ? W : never) : never) =>
    proxyConversionValue({ ...base, closeRateWhy: why }, [{ name: "Contact form", category: "SUBMIT_LEAD_FORM", countsIntoConversionsColumn: true, defaultValue: null, alwaysUseDefaultValue: null }], "yes", null).lines.join(" | ");
  ok("a blank says what it always said", /Nobody has answered it on the account record/.test(missingText(null)));
  ok("a close rate a named person recorded as not known is NOT called unanswered",
    /Recorded on the account as not known by Sam on 2026-09-30/.test(missingText({ kind: "recorded_absent", by: "Sam", at: "2026-09-30" }))
    && !/Nobody has answered/.test(missingText({ kind: "recorded_absent", by: "Sam", at: "2026-09-30" })));
  ok("a saved nought is named as the shape of a blank", /A nought is saved on the account record/.test(missingText({ kind: "stored_as_nought" })));
  ok("a retainer account the launch never asks is said to be one", /retainer model, which the launch never asks/.test(missingText({ kind: "not_asked" })));
  ok("missingFigureWhy: a figure above nought has no reason; a recorded absence beats a stored nought; a blank retainer account is 'not asked'",
    missingFigureWhy({ stored: 35, unknownAt: null, unknownBy: null, notAsked: true }) === null
    && missingFigureWhy({ stored: 0, unknownAt: "2026-09-30T10:00:00Z", unknownBy: "Sam", notAsked: false })?.kind === "recorded_absent"
    && missingFigureWhy({ stored: 0, unknownAt: null, unknownBy: null, notAsked: false })?.kind === "stored_as_nought"
    && missingFigureWhy({ stored: null, unknownAt: null, unknownBy: null, notAsked: true })?.kind === "not_asked"
    && missingFigureWhy({ stored: null, unknownAt: null, unknownBy: null, notAsked: false }) === null);
}

console.log(`\n${"─".repeat(72)}`);
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
console.log(`${"─".repeat(72)}\n`);
if (failures) process.exit(1);

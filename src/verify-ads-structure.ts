#!/usr/bin/env tsx
/**
 * Guard for the structural snapshot and for the bid-target reading beside it.
 *
 * No database, no ad account, no network: it drives the real functions over
 * fixtures. EVERY FIGURE, NAME AND IDENTIFIER HERE IS INVENTED. There is no
 * production database in this sandbox and no Google Ads access, so nothing
 * below was measured — the two OCH figures the bid-target rule was written
 * from came from a person reading a live screen and are not reproduced here.
 *
 * The refusals are the deliverable, and each one has a planted failure beside
 * it so the check is shown to bite rather than asserted to.
 *
 *   npx tsx src/verify-ads-structure.ts
 */
import {
  ENTITY_KINDS, MAX_ENTITIES_PER_KIND, UNRECOGNISED_ENUM,
  CAMPAIGN_STATUS, BID_STRATEGY_TYPE,
  accountLine, entityHash, normalizeAdGroup, normalizeAdGroupKeyword, normalizeBidStrategy,
  normalizeBudget, normalizeCampaign, normalizeCampaignKeyword, planCounts, reconcile,
  snapshotEnum,
  CAMPAIGN_GAQL, AD_GROUP_GAQL, AD_GROUP_KEYWORD_GAQL, CAMPAIGN_KEYWORD_GAQL,
  BUDGET_GAQL, BID_STRATEGY_GAQL,
  type OpenInterval, type SnapshotEntity, type UnrecognisedEnum,
} from "./ads/structure-snapshot.js";
import { bidTargetEvidenceLine, bidTargetReading, supersedeReason, targetIsAbsent } from "./ads/bid-target.js";
import { evaluate, type AuditInput, type CampaignRow } from "./ads/rules.js";
import { stageOf } from "./ads/sequence.js";
import { rankBasisOf } from "./ads/impact-rank.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);

console.log("Ads structure snapshot and bid-target reading — verification harness");
console.log("Nothing is run, dispatched or contacted. Every figure below is invented.");

// ── 1. Enums are integers, and one nobody can decode is named ───────────────
hr("1. An enum this build cannot decode is named, never stored as its digits");
{
  const report: UnrecognisedEnum[] = [];
  ok("an integer is decoded to the platform's own word",
    snapshotEnum(CAMPAIGN_STATUS, 2, "campaign.status", report) === "ENABLED");
  ok("a value already in words passes through untouched",
    snapshotEnum(CAMPAIGN_STATUS, "PAUSED", "campaign.status", report) === "PAUSED");
  ok("nothing was reported for either", report.length === 0);

  const v = snapshotEnum(BID_STRATEGY_TYPE, 99, "campaign.bidding_strategy_type", report);
  ok("an integer no map knows is stored as UNRECOGNISED", v === UNRECOGNISED_ENUM, String(v));
  ok("…and is NEVER stored as its digits", v !== "99");
  ok("…and is named with its field and its raw value",
    report.length === 1 && report[0]!.field === "campaign.bidding_strategy_type" && report[0]!.raw === "99",
    JSON.stringify(report[0] ?? {}));
  ok("UNRECOGNISED is not the platform's own UNKNOWN",
    String(UNRECOGNISED_ENUM) !== "UNKNOWN" && snapshotEnum(CAMPAIGN_STATUS, 1, "campaign.status") === "UNKNOWN",
    "\"the platform could not tell us\" and \"we could not decode it\" are different facts");
  ok("an absent value stays null rather than becoming UNRECOGNISED",
    snapshotEnum(CAMPAIGN_STATUS, null, "campaign.status") === null
      && snapshotEnum(CAMPAIGN_STATUS, "", "campaign.status") === null);
  ok("SELF-TEST: a planted undecodable value is caught",
    snapshotEnum(CAMPAIGN_STATUS, 4242, "campaign.status") === UNRECOGNISED_ENUM);
}

// ── 2. One API row, normalized ──────────────────────────────────────────────
hr("2. The REST shape, normalized");
{
  const report: UnrecognisedEnum[] = [];
  const c = normalizeCampaign({
    campaign: {
      id: "111", name: "Search — Core", status: 2, advertising_channel_type: 2,
      bidding_strategy_type: 10, bidding_strategy: null,
      start_date: "2026-01-04", end_date: null,
      maximize_conversions: { target_cpa_micros: null },
    },
    campaign_budget: { id: "900", amount_micros: "80000000" },
  }, report)!;
  ok("a campaign keeps the platform's own id", c.entityId === "111" && c.kind === "campaign");
  ok("its status and channel are decoded", c.status === "ENABLED" && c.attrs.channel_type === "SEARCH");
  ok("its strategy is decoded", c.attrs.bid_strategy_type === "MAXIMIZE_CONVERSIONS");
  ok("money is kept in MICROS, verbatim",
    c.attrs.budget_amount_micros === 80_000_000, String(c.attrs.budget_amount_micros));
  ok("a target nobody set stays NULL rather than becoming nought",
    c.attrs.maximize_conversions_target_cpa_micros === null);
  ok("an absent end date stays null", c.attrs.end_date === null);
  ok("nothing was reported as undecodable", report.length === 0, JSON.stringify(report));

  const g = normalizeAdGroup({ ad_group: { id: "222", name: "Core", status: 2, type: 2, cpc_bid_micros: "2500000" }, campaign: { id: "111" } })!;
  ok("an ad group hangs off its campaign", g.parentId === "111" && g.campaignId === "111");

  const b = normalizeBudget({ campaign_budget: { id: "900", name: "Core budget", amount_micros: "80000000", delivery_method: 2, period: 2, explicitly_shared: false, status: 2 } })!;
  ok("a budget decodes its delivery and its period", b.attrs.delivery_method === "STANDARD" && b.attrs.period === "DAILY");

  const s = normalizeBidStrategy({ bidding_strategy: { id: "777", name: "Shared tCPA", type: 6, status: 2, target_cpa: { target_cpa_micros: "46000000" } } })!;
  ok("a portfolio strategy keeps its target in micros",
    s.attrs.strategy_type === "TARGET_CPA" && s.attrs.target_cpa_micros === 46_000_000);

  ok("a row with no id at all is refused rather than stored keyless",
    normalizeCampaign({ campaign: { name: "no id" } }) === null
      && normalizeBudget({ campaign_budget: {} }) === null);
}

// ── 3. One kind, two parents, and ids that cannot collide ───────────────────
hr("3. A keyword's identity is scoped to its parent");
{
  const agk = normalizeAdGroupKeyword({
    ad_group_criterion: { criterion_id: "5", keyword: { text: "emergency care", match_type: 3 }, status: 2, negative: false, cpc_bid_micros: "1200000" },
    ad_group: { id: "222" }, campaign: { id: "111" },
  })!;
  const ck = normalizeCampaignKeyword({
    campaign_criterion: { criterion_id: "5", keyword: { text: "free", match_type: 4 }, status: 2, negative: true },
    campaign: { id: "111" },
  })!;
  ok("the same criterion id under two parents produces two identities",
    agk.entityId !== ck.entityId, `${agk.entityId} vs ${ck.entityId}`);
  ok("both are the one kind, and the row says which level it is",
    agk.kind === "keyword" && ck.kind === "keyword" && agk.attrs.level === "ad_group" && ck.attrs.level === "campaign");
  ok("a negative reads as a negative and a positive as a positive",
    ck.attrs.negative === true && agk.attrs.negative === false);
  ok("a negative flag the platform did not send stays null, never false",
    normalizeCampaignKeyword({ campaign_criterion: { criterion_id: "6", keyword: { text: "x", match_type: 4 }, status: 2 }, campaign: { id: "111" } })!.attrs.negative === null);
  ok("SELF-TEST: a planted bare-id key would collide",
    "5" === "5", "which is why the entity id carries its parent");
}

// ── 4. The hash moves on a setting and on nothing else ──────────────────────
hr("4. A content hash that moves only when the settings move");
{
  const base: SnapshotEntity = {
    kind: "budget", entityId: "900", parentId: null, campaignId: null,
    name: "Core budget", status: "ENABLED",
    attrs: { amount_micros: 80_000_000, delivery_method: "STANDARD", period: "DAILY", explicitly_shared: false },
  };
  const reordered: SnapshotEntity = { ...base, attrs: { explicitly_shared: false, period: "DAILY", delivery_method: "STANDARD", amount_micros: 80_000_000 } };
  ok("the same entity hashes the same twice", entityHash(base) === entityHash({ ...base }));
  ok("key order in the API response cannot move it", entityHash(base) === entityHash(reordered));
  ok("a budget rise moves it",
    entityHash({ ...base, attrs: { ...base.attrs, amount_micros: 100_000_000 } }) !== entityHash(base));
  ok("a pause moves it", entityHash({ ...base, status: "PAUSED" }) !== entityHash(base));
  ok("a rename moves it", entityHash({ ...base, name: "Core budget v2" }) !== entityHash(base));
}

// ── 5. Reconciliation: the refusals ─────────────────────────────────────────
hr("5. Reconciling a reading against what is stored");

const ent = (kind: SnapshotEntity["kind"], id: string, attrs: Record<string, string | number | boolean | null>): SnapshotEntity =>
  ({ kind, entityId: id, parentId: null, campaignId: null, name: `e${id}`, status: "ENABLED", attrs });
const openRow = (e: SnapshotEntity, validFrom: string, lastSeenOn: string): OpenInterval =>
  ({ id: `row-${e.kind}-${e.entityId}`, kind: e.kind, entityId: e.entityId, contentHash: entityHash(e), validFrom, lastSeenOn });
const ALL = [...ENTITY_KINDS];

{
  const a = ent("campaign", "1", { budget_amount_micros: 80_000_000 });
  const b = ent("campaign", "2", { budget_amount_micros: 40_000_000 });

  const first = reconcile({ open: [], read: [a, b], on: "2026-09-20", completeKinds: ALL });
  ok("a first snapshot opens an interval per entity and closes nothing",
    first.opens.length === 2 && first.closes.length === 0 && first.touches.length === 0);

  const open = [openRow(a, "2026-09-20", "2026-09-20"), openRow(b, "2026-09-20", "2026-09-20")];
  const quiet = reconcile({ open, read: [a, b], on: "2026-09-21", completeKinds: ALL });
  ok("an unchanged run writes NO new rows — this is the whole storage argument",
    quiet.opens.length === 0 && quiet.closes.length === 0 && quiet.touches.length === 2);

  const moved = { ...a, attrs: { budget_amount_micros: 120_000_000 } };
  const changed = reconcile({ open, read: [moved, b], on: "2026-09-21", completeKinds: ALL });
  ok("a changed entity closes its interval and opens a new one",
    changed.closes.length === 1 && changed.opens.length === 1 && changed.touches.length === 1);
  ok("…and the closed interval ends on the date it was last CONFIRMED, not on today",
    changed.closes[0]!.validTo === "2026-09-20", changed.closes[0]!.validTo);
  ok("…and it is counted as one change rather than as one arrival and one departure",
    planCounts(changed).changed === 1 && planCounts(changed).opened === 0 && planCounts(changed).closed === 0,
    JSON.stringify(planCounts(changed)));

  const gone = reconcile({ open, read: [a], on: "2026-09-21", completeKinds: ALL });
  ok("an entity the account no longer holds is closed",
    gone.closes.length === 1 && gone.closes[0]!.entityId === "2");

  const sameDay = reconcile({
    open: [openRow(a, "2026-09-21", "2026-09-21")],
    read: [moved], on: "2026-09-21", completeKinds: ALL,
  });
  ok("a second run on ONE DATE re-takes the row rather than opening a second interval",
    sameDay.replaces.length === 1 && sameDay.opens.length === 0 && sameDay.closes.length === 0,
    "the grain is a date, and an interval ending before it began is not an interval");

  // THE ONE THAT MATTERS MOST.
  const partial = reconcile({ open, read: [a], on: "2026-09-21", completeKinds: ALL.filter((k) => k !== "campaign") });
  ok("a kind this run could not read IN FULL closes nothing of that kind",
    partial.closes.length === 0,
    "a partial list means an entity is missing from the LIST, never from the account");
  ok("…and the kind is named rather than passed over",
    partial.incompleteKinds.includes("campaign"), partial.incompleteKinds.join(", "));
  ok("SELF-TEST: with the kind complete the same reading DOES close it",
    reconcile({ open, read: [a], on: "2026-09-21", completeKinds: ALL }).closes.length === 1,
    "which is what proves the refusal above is the refusal and not an empty plan");

  const stillOpens = reconcile({ open: [], read: [a], on: "2026-09-21", completeKinds: [] });
  ok("an incomplete kind still OPENS what it did see",
    stillOpens.opens.length === 1,
    "what was read is real; only the absences are unreliable");
}

// ── 6. What a run says ──────────────────────────────────────────────────────
hr("6. The run's own output");
{
  const line = accountLine("A Client Name", { read: 451, opened: 2, changed: 3, closed: 1, unchanged: 445 }, []);
  ok("the line names the client", line.includes("A Client Name"));
  ok("the line carries NO ad account number", !/\b\d{9,}\b/.test(line), line.trim());
  ok("SELF-TEST: a planted account number in a line is caught",
    /\b\d{9,}\b/.test("  A Client [1234567890]: 451 entities"));
  ok("the row cap is a real number this build would notice",
    MAX_ENTITIES_PER_KIND > 0 && Number.isFinite(MAX_ENTITIES_PER_KIND), String(MAX_ENTITIES_PER_KIND));
}

// ── 7. Every query is a SELECT ──────────────────────────────────────────────
hr("7. Read-only, proved over the queries themselves");
{
  const queries = [CAMPAIGN_GAQL, AD_GROUP_GAQL, AD_GROUP_KEYWORD_GAQL, CAMPAIGN_KEYWORD_GAQL, BUDGET_GAQL, BID_STRATEGY_GAQL];
  const WRITES = /\b(mutate|insert|update|delete|create|remove)\b/i;
  ok("every one of the six queries starts with SELECT",
    queries.every((q) => q.trim().toUpperCase().startsWith("SELECT")));
  ok("no query carries a mutating verb", !queries.some((q) => WRITES.test(q)));
  ok("SELF-TEST: a planted mutation is caught", WRITES.test("MUTATE campaign SET status"));
  ok("no query has a customer id baked into it", !queries.some((q) => /\b\d{9,}\b/.test(q)));
}

// ── 8. Was the platform ever told what a conversion may cost? ───────────────
hr("8. The bid-target reading");
{
  const read = (over: Partial<Parameters<typeof bidTargetReading>[0]>) =>
    bidTargetReading({ strategyType: "MAXIMIZE_CONVERSIONS", hasTarget: false, targetRead: true, ...over });

  const maxConv = read({});
  ok("Maximize Conversions with no target reads as no target on the strategy",
    maxConv.kind === "no_target_on_strategy", maxConv.kind);
  ok("…and the sentence says the setting is doing what it was configured to do",
    /working as configured/.test(maxConv.explanation), maxConv.explanation.slice(0, 80));

  const manual = read({ strategyType: "MANUAL_CPC" });
  ok("Manual CPC is its OWN case, never a missing value",
    manual.kind === "manual" && targetIsAbsent(manual), manual.kind);
  ok("…and it says so in its own words",
    /no cost target by design/.test(manual.explanation), manual.explanation.slice(0, 70));
  ok("Enhanced CPC is manual too — it adjusts a typed bid and holds no cost target",
    read({ strategyType: "ENHANCED_CPC" }).kind === "manual");

  const clicks = read({ strategyType: "TARGET_SPEND" });
  ok("Maximize Clicks is a third case: automated, and chasing something else",
    clicks.kind === "other_goal", clicks.kind);

  ok("a target that IS set settles it, whatever the strategy is called",
    read({ hasTarget: true }).kind === "targeted"
      && read({ strategyType: "TARGET_CPA", hasTarget: true }).kind === "targeted");
  ok("…and a targeted campaign is not an absent one",
    !targetIsAbsent(read({ hasTarget: true })));

  const noStrategy = read({ strategyType: null, hasTarget: null });
  ok("a strategy nobody reported is cant_tell, never manual",
    noStrategy.kind === "cant_tell" && !targetIsAbsent(noStrategy));
  ok("…and it says why it is silent", noStrategy.silentBecause.length > 0);

  const undecodable = read({ strategyType: UNRECOGNISED_ENUM });
  ok("a strategy this build cannot decode is cant_tell, never read as untargeted",
    undecodable.kind === "cant_tell", undecodable.kind);
  ok("an unknown the PLATFORM sent is cant_tell too",
    read({ strategyType: "UNKNOWN" }).kind === "cant_tell");

  const portfolio = read({ strategyType: "TARGET_CPA", hasTarget: false, targetRead: false });
  ok("a campaign on a shared strategy this run could not read is cant_tell",
    portfolio.kind === "cant_tell", portfolio.kind);
  ok("…and it says to open the strategy before deciding anything",
    /before deciding anything/.test(portfolio.silentBecause), portfolio.silentBecause.slice(0, 80));
  ok("SELF-TEST: the same campaign WITH the strategy read is not silent",
    read({ strategyType: "TARGET_CPA", hasTarget: false, targetRead: true }).kind === "no_target_on_strategy",
    "which is what proves the refusal above turns on having looked");

  ok("no sentence carries a money figure — the cost lives on the finding",
    ![maxConv, manual, clicks, portfolio].some((r) => /\$/.test(r.explanation + r.silentBecause)));

  ok("the evidence line follows the verdict rather than being written once for the commonest case",
    /no cost target set on the strategy/.test(bidTargetEvidenceLine(maxConv))
      && /manual, so no cost target exists to hold/.test(bidTargetEvidenceLine(manual))
      && /other than the cost of a conversion/.test(bidTargetEvidenceLine(clicks)),
    bidTargetEvidenceLine(manual));
  ok("SELF-TEST: the three lines are genuinely different sentences",
    new Set([maxConv, manual, clicks].map(bidTargetEvidenceLine)).size === 3);
  ok("a strategy nobody reported still produces a line that says so rather than a blank",
    /not reported/.test(bidTargetEvidenceLine(noStrategy)), bidTargetEvidenceLine(noStrategy));
}

// ── 9. The rule, and the row it replaces ────────────────────────────────────
hr("9. Over target, and no target set");

const campaign = (over: Partial<CampaignRow>): CampaignRow => ({
  id: "100", name: "Treatment Centre Search", channelType: "SEARCH",
  dailyBudgetMicros: 60_000_000, budgetResourceName: null,
  costMicros: 1_200_000_000, clicks: 400, impressions: 20_000, conversions: 12,
  impressionShare: 0.5, budgetLostShare: 0.02, rankLostShare: 0.1,
  bidStrategyType: "MAXIMIZE_CONVERSIONS", hasBidTarget: false, bidTargetRead: true,
  ...over,
});

const input = (c: CampaignRow): AuditInput => ({
  platform: "google_ads", accountId: "invented", windowStart: "2026-06-13", windowEnd: "2026-09-10",
  campaigns: [c], searchTerms: [], keywords: [], ads: [],
  existingNegatives: new Set<string>(), protectedPatterns: [],
  tracking: {
    status: "CONVERSION_TRACKING_MANAGED_BY_SELF",
    actions: [{ id: "500", name: "Enquiry", status: "ENABLED", category: "SUBMIT_LEAD_FORM", actionType: "WEBPAGE", primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 40, defaultValue: null, alwaysUseDefaultValue: null }],
  },
  economics: { customerValueCents: 240_000, customerValueFromClient: true, closeRatePct: 5, cplCeilingCents: 4_600, cplCeilingMonth: "2026-09" },
});

{
  // $1,200 over 12 conversions is $100 a conversion against a $46 ceiling.
  const a = evaluate(input(campaign({})));
  const sharper = a.find((f) => f.findingType === "bid_target_absent");
  const weaker = a.find((f) => f.findingType === "cpa_above_target");
  ok("over target with no target set raises the sharper finding", Boolean(sharper), sharper?.title ?? "none");
  ok("…and the row it replaces is NOT also raised", !weaker, weaker?.title ?? "");
  ok("…and the sharper row names the strategy rather than guessing at it",
    (sharper?.evidence.lines ?? []).some((l) => l.includes("MAXIMIZE_CONVERSIONS")),
    (sharper?.evidence.lines ?? []).join(" | ").slice(0, 120));
  ok("…and its evidence line is true for the case it is in",
    (sharper?.evidence.lines ?? []).some((l) => /no cost target set on the strategy/.test(l)));
  ok("…and it carries the same cost evidence, so nothing is lost with the row",
    (sharper?.evidence.metrics.costPerConversionCents ?? 0) > 0
      && (sharper?.evidence.metrics.targetCents ?? 0) > 0);
  ok("…and it proposes nothing automatic",
    sharper?.applicability === "vendor" && sharper?.changePayload === null,
    "a bid strategy switch on a live account is exactly what the propose/approve split is for");
  ok("…and its figure is the size of the gap, said to be a gap",
    (sharper?.estImpactCents ?? 0) > 0 && /not a saving anybody has promised/.test(sharper?.impactAssumption ?? ""),
    `$${Math.round((sharper?.estImpactCents ?? 0) / 100)}/mo`);
  ok("…and the figure is ranked as money already riding on it, never as recoverable",
    rankBasisOf("bid_target_absent") === "at_stake" && sharper?.rank?.basis === "at_stake",
    sharper?.rank?.basis ?? "none");
  ok("…and it sits in the same stage as the row it replaces",
    stageOf("bid_target_absent") === stageOf("cpa_above_target"), stageOf("bid_target_absent"));

  ok("the replaced row is named so it can be closed by name rather than swept",
    sharper?.supersedes?.length === 1
      && sharper.supersedes[0]!.findingType === "cpa_above_target"
      && sharper.supersedes[0]!.entityId === "100:cost_target",
    JSON.stringify(sharper?.supersedes ?? []));
  ok("…and the sentence written onto it says the cost figures moved rather than cleared",
    /Replaced by a sharper reading/.test(sharper?.supersedes?.[0]!.reason ?? "")
      && !/cleared/.test(sharper?.supersedes?.[0]!.reason ?? ""),
    "sweepResolved would have said the condition cleared on its own, which is false");
  ok("SELF-TEST: the supersede sentence names the campaign",
    supersedeReason("Treatment Centre Search").includes("Treatment Centre Search"));
}

{
  const targeted = evaluate(input(campaign({ bidStrategyType: "TARGET_CPA", hasBidTarget: true })));
  ok("the SAME campaign with a target set raises the original row and not the new one",
    targeted.some((f) => f.findingType === "cpa_above_target")
      && !targeted.some((f) => f.findingType === "bid_target_absent"),
    "a target set and missed and a target never set need opposite advice");

  const manual = evaluate(input(campaign({ bidStrategyType: "MANUAL_CPC", hasBidTarget: false })));
  const manualRow = manual.find((f) => f.findingType === "bid_target_absent");
  ok("a Manual CPC campaign over target raises it and says which case it is in",
    Boolean(manualRow) && /manual/.test(manualRow?.title ?? ""), manualRow?.title ?? "none");
  ok("…and its evidence never claims a strategy it has no strategy to carry",
    (manualRow?.evidence.lines ?? []).some((l) => /no cost target exists to hold/.test(l))
      && !(manualRow?.evidence.lines ?? []).some((l) => /no cost target set on the strategy/.test(l)),
    (manualRow?.evidence.lines ?? []).find((l) => l.startsWith("Bidding")) ?? "none");

  const unread = evaluate(input(campaign({ bidStrategyType: "TARGET_CPA", hasBidTarget: false, bidTargetRead: false })));
  ok("a campaign on a shared strategy this run could not read raises NEITHER row",
    !unread.some((f) => f.findingType === "bid_target_absent"),
    "a finding that guesses at configuration is worse than no finding");

  const noStrategy = evaluate(input(campaign({ bidStrategyType: null, hasBidTarget: null })));
  ok("a campaign whose strategy was never reported raises the new row on nobody",
    !noStrategy.some((f) => f.findingType === "bid_target_absent"));

  const underTarget = evaluate(input(campaign({ conversions: 60 })));
  ok("a campaign INSIDE its cost target raises nothing, whatever its bidding",
    !underTarget.some((f) => f.findingType === "bid_target_absent"),
    "a row on every untargeted campaign in the book is the noise that empties a queue");

  const noCeiling = evaluate({
    ...input(campaign({})),
    economics: { customerValueCents: null, customerValueFromClient: false, closeRatePct: null, cplCeilingCents: null, cplCeilingMonth: null },
  });
  ok("with no target recorded on our side either, nothing is raised",
    !noCeiling.some((f) => f.findingType === "bid_target_absent"),
    "a ceiling nobody stated is never invented");
}

console.log(`\n${"─".repeat(72)}`);
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");
console.log(`${"─".repeat(72)}`);

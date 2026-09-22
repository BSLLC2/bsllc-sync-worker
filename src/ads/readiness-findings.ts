/**
 * The findings that come out of the readiness readings.
 *
 * A separate module rather than three more blocks inside `evaluate()`: that
 * function is already long, and the three things below share nothing with the
 * waste rules except the account they are about. `evaluate` calls this once and
 * concatenates.
 *
 * Pure, like everything beside it. The `DerivedFinding` type is imported for
 * types only, so there is no runtime import back into rules.ts and no cycle.
 */

import type { DerivedFinding, ClientEconomics, ConversionActionRow, TrackingReading } from "./rules.js";
import {
  whatItWouldNeed, TARGET_STRATEGY_MIN_CONVERSIONS_30D, TARGET_STRATEGY_STABLE_CONVERSIONS_30D,
  USEFUL_CONVERSION_LAG_DAYS, type BiddingReadiness,
} from "./bidding-readiness.js";
import {
  findTrackingOutage, dataExclusionProposal, manualExclusionInstruction,
  MAX_DATA_EXCLUSION_DAYS, type DailyConversionRow, type ExclusionCampaign,
} from "./tracking-outage.js";
import { proxyConversionValue, type ValuedAction } from "./proxy-value.js";
import { onTargetStrategy } from "./bidding-readiness.js";

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
const one = (v: number) => v.toFixed(1);

export interface ReadinessFindingInput {
  accountId: string;
  platformLabel: string;
  windowStart: string;
  windowEnd: string;
  /** Per campaign, keyed by campaign id. */
  readiness: Map<string, BiddingReadiness>;
  campaigns: {
    id: string; name: string; costMicros: number;
    resourceName?: string | null; bidStrategyType?: string | null; hasBidTarget?: boolean | null;
  }[];
  tracking: TrackingReading;
  conversionActions: ConversionActionRow[] | null;
  economics: ClientEconomics | null | undefined;
  dailyConversions: DailyConversionRow[] | null | undefined;
  /** Measured value per closed outcome from the CRM. Never blended with the
   *  modelled lead value; carried so the proxy row can state it beside it. */
  measuredWonValueCents: number | null;
  /** Spend floors, passed in rather than imported, so this module never has a
   *  runtime import back into rules.ts. */
  campaignMinSpendMicros: number;
  accountMinSpendMicros: number;
  accountCostMicros: number;
}

export function readinessFindings(i: ReadinessFindingInput): DerivedFinding[] {
  const out: DerivedFinding[] = [];
  const win = { windowStart: i.windowStart, windowEnd: i.windowEnd };
  const accountWorthARow = i.accountCostMicros >= i.accountMinSpendMicros;

  // ── 1. A campaign whose bidding cannot learn from what it gets ───────────
  /**
   * WHY THIS DOES NOT FIRE ON EVERY SMALL CAMPAIGN, WHICH IT EASILY COULD.
   *
   * Most campaigns on a book this size are under fifteen conversions a month.
   * That is not a defect — it is what a small account looks like, and a row on
   * every one of them would be a row telling every client they are small.
   *
   * So the row is raised only where the shortfall is ACTIVELY COSTING
   * something: the campaign is on a bidding strategy whose whole job is to hit
   * a target, and it does not have the volume that strategy needs. Everywhere
   * else the reading still exists and still gates — it just does not take up a
   * line in somebody's queue.
   */
  for (const c of i.campaigns) {
    if (c.costMicros < i.campaignMinSpendMicros) continue;
    const r = i.readiness.get(c.id);
    if (!r) continue;
    if (r.onTargetStrategy !== true) continue;
    const short = r.verdict === "below_minimum";
    const late = r.lagTooLong === true;
    const blind = r.verdict === "column_unreadable";
    if (!short && !late && !blind) continue;

    const needs = whatItWouldNeed(r);
    out.push({
      entityType: "campaign", entityId: `${c.id}:bidding_readiness`, entityName: c.name, campaignId: c.id,
      findingType: "bidding_not_ready",
      // The campaign is spending against a strategy that cannot work. That is
      // upstream of every other judgement this audit makes about it.
      severity: short || blind ? "high" : "medium",
      riskLevel: "medium",
      // Moving a campaign to a different bidding strategy, merging two
      // campaigns, or changing which action is primary are all decisions about
      // what the account optimises toward. None of them has a guarded path
      // here and none of them should.
      applicability: "vendor",
      title: blind
        ? `"${c.name}" runs a ${r.strategyType ?? "target-based"} strategy on a conversion column nobody can read`
        : short
          ? `"${c.name}" runs a ${r.strategyType ?? "target-based"} strategy on ${one(r.conversions30d ?? 0)} conversions a month`
          : `"${c.name}" runs a ${r.strategyType ?? "target-based"} strategy on a signal that arrives too late to bid on`,
      summary: blind
        ? `The strategy on this campaign optimises toward a target, and the account's conversion column is not recording. It is not learning from a thin signal; it is learning from noughts that are not true. Settle the conversion tracking before anything else on this campaign is touched.`
        : short
          ? `The published minimum for a strategy with a target to hit is ${TARGET_STRATEGY_MIN_CONVERSIONS_30D} conversions in the campaign — not in the account — over 30 days, and practitioners put the figure at which it stops lurching nearer ${TARGET_STRATEGY_STABLE_CONVERSIONS_30D}. This campaign is at ${one(r.conversions30d ?? 0)}. Below the minimum the model has no opinion worth having, and every target change restarts a learning period it cannot finish.`
          : `Half this campaign's conversions arrive more than ${USEFUL_CONVERSION_LAG_DAYS} days after the click. A bidding model shapes tomorrow's spend from what it learned yesterday, so a signal that lands a fortnight later is shaping budget that has already gone. More volume does not fix it; a conversion that happens sooner does.`,
      evidence: {
        metrics: r.metrics,
        ...win,
        lines: [...r.lines, ...r.blockers],
      },
      // No dollar figure. What a strategy learning from too little costs is the
      // difference between the bids it set and the bids it would have set with
      // enough to go on, and nothing here can see the second of those.
      estImpactCents: 0,
      impactUnit: "usd_month",
      impactAssumption: `No figure claimed. The cost of a bidding model working on too little is the gap between what it did and what it would have done, and nothing here can price the second one. `
        + `The ${TARGET_STRATEGY_MIN_CONVERSIONS_30D}-a-month figure is the minimum several independent sources each attribute to the platform's own pages; the ${TARGET_STRATEGY_STABLE_CONVERSIONS_30D} beside it is an industry convention with no published method behind it.`,
      changePayload: null,
      guardNote: "Nothing to apply. Changing a bidding strategy, merging campaigns or changing which conversion action is primary all change what the account optimises toward, which is deliberately outside the guarded path.",
    });
    // The list of what it would take goes in the evidence rather than the
    // summary: it is four options a person picks from, and a summary that
    // carries four options is a summary nobody finishes.
    const last = out[out.length - 1]!;
    last.evidence.lines = [...last.evidence.lines, ...needs.map((n) => `What it would take — ${n}`)];
  }

  // ── 2. The conversion column went quiet, and the platform can be told ────
  const outage = findTrackingOutage(i.dailyConversions);
  if (accountWorthARow && (outage.verdict === "found" || outage.verdict === "no_baseline")) {
    const scoped: ExclusionCampaign[] = i.campaigns.map((c) => ({
      id: c.id, name: c.name, resourceName: c.resourceName ?? null,
      // A data exclusion only ever affects a campaign whose bidding reads the
      // conversion column. On a manually bid campaign it changes nothing, so
      // scoping one there would be a change that does nothing.
      // A Maximize strategy with no target still bids on the conversion
      // column, so it is covered too — `onTargetStrategy` answers a narrower
      // question (does this strategy carry the volume floor) and is not the
      // right test here.
      smartBidding: onTargetStrategy({ strategyType: c.bidStrategyType ?? null, hasTarget: c.hasBidTarget ?? null }) === true
        || String(c.bidStrategyType ?? "").toUpperCase().startsWith("MAXIMIZE_"),
    }));
    const lagLine = null;
    const proposal = dataExclusionProposal(outage, scoped, { accountLabel: `this ${i.platformLabel} account`, lagLine });
    const smartBiddingCampaigns = scoped.filter((c) => c.smartBidding);
    const manual = manualExclusionInstruction(outage);

    const whyNoProposal = outage.verdict === "no_baseline"
      ? "Nothing here proposes a date range: the column is quiet across the whole window, so there is no working stretch behind it to say when it broke."
      : outage.refusal
        ? outage.refusal
        : smartBiddingCampaigns.length === 0
          ? "Nothing here proposes a date range: no campaign on this account bids on the conversion column, so telling the platform to ignore those days would change nothing."
          : null;

    out.push({
      entityType: "account",
      // Keyed on the outage's START, not its end. An outage that is still open
      // grows a day every run, and keying on the end would close one row and
      // open another every week — each closure reading as "the condition
      // cleared on its own", which would be false.
      entityId: `${i.accountId}:data_exclusion:${outage.startDate ?? "unbounded"}`,
      entityName: "Conversion tracking outage",
      findingType: "bidding_data_exclusion",
      severity: "high",
      riskLevel: "medium",
      applicability: proposal ? "api" : "vendor",
      title: outage.verdict === "no_baseline"
        ? "The conversion column has been quiet for the whole window, and bidding has been learning from that"
        : outage.ongoing
          ? `The conversion column has recorded nothing since ${outage.startDate}, and the bidding is still learning from it`
          : `The conversion column recorded nothing from ${outage.startDate} to ${outage.endDate}`,
      summary: (outage.verdict === "no_baseline"
        ? `A broken conversion tag does not make bidding stop. It makes bidding carry on, learning that every click on those days was worthless, which is worse than no optimisation at all — the model does not become neutral, it becomes confidently wrong.`
        : `A broken conversion tag does not make bidding stop. Over those ${outage.days} day(s) the account took ${outage.clicksInRun} clicks and recorded nothing, about ${one(outage.expectedConversions)} conversions short of its own rate beforehand, and the bidding model learned that every one of those clicks was worthless. The platform has a control for exactly this: a data exclusion tells it to ignore the affected dates.`)
        + (whyNoProposal ? ` ${whyNoProposal}` : ""),
      evidence: {
        metrics: {
          ...outage.metrics,
          smartBiddingCampaigns: smartBiddingCampaigns.length,
          costMicros: i.accountCostMicros,
        },
        ...win,
        lines: [
          ...outage.lines,
          smartBiddingCampaigns.length
            ? `${smartBiddingCampaigns.length} campaign(s) on this account bid on the conversion column and are what an exclusion would cover: ${smartBiddingCampaigns.map((c) => c.name).join(", ")}`
            : "No campaign on this account bids on the conversion column, so an exclusion would change nothing here.",
          ...(proposal ? [] : manual),
        ],
      },
      // No dollar figure, and the reason is the same one the tracking row
      // gives: what this costs is the bids the model set on a false reading
      // against the bids it would have set on a true one, and nothing here can
      // see the second. The spend inside the quiet run is named in the
      // evidence as the size of the question rather than as a saving.
      estImpactCents: 0,
      impactUnit: "usd_month",
      impactAssumption: `No figure claimed. ${usd(outage.costMicrosInRun)} was spent inside the quiet run, and that is what was bought on a false reading — not what is recoverable, because the clicks happened and some of them converted. `
        + `What this costs is every bid the model set while it believed those days produced nothing.`,
      changePayload: proposal
        ? { op: "dataExclusions", body: [proposal.body], plainEnglish: proposal.plainEnglish, guard: proposal.guard }
        : null,
      guardNote: proposal
        ? `Data exclusion guard: at most ${MAX_DATA_EXCLUSION_DAYS} days, the range must already be in the past, the account is re-read over those exact dates and the change is refused if a conversion has since landed in them, an overlapping exclusion is skipped rather than duplicated, and the created exclusion's resource name is recorded so it can be removed in one step.`
        : "No API change proposed here. Fixing the tag is the work; the exclusion is what stops the bidding learning from the days it was broken, and it is set by hand where this cannot express it.",
    });
  }

  // ── 3. What one lead is worth, as a figure that can go on the account ────
  if (accountWorthARow) {
    const actions: ValuedAction[] | null = i.conversionActions
      ? i.conversionActions
          .filter((a) => String(a.status ?? "ENABLED").toUpperCase() === "ENABLED")
          .map((a) => ({
            name: a.name,
            category: a.category,
            countsIntoConversionsColumn: a.countsIntoConversionsColumn != null ? a.countsIntoConversionsColumn : a.primaryForGoal,
            defaultValue: a.defaultValue ?? null,
            alwaysUseDefaultValue: a.alwaysUseDefaultValue ?? null,
          }))
      : null;
    const proxy = proxyConversionValue(i.economics, actions, i.tracking.countsOutcomes, i.measuredWonValueCents);

    // Silence where there is nothing to say. `already_valued` is a working
    // account, `transaction_valued` is an account that already hands the
    // platform a real amount, and `column_unreadable` is the tracking row's
    // job — three rows saying what one row already says is how a queue fills
    // with advice nobody reads.
    if (proxy.state === "ready" || proxy.state === "missing_inputs" || proxy.state === "disagrees") {
      out.push({
        entityType: "account", entityId: `${i.accountId}:proxy_conversion_value`, entityName: "What a lead is worth",
        findingType: "proxy_conversion_value",
        severity: proxy.state === "disagrees" ? "high" : "medium",
        riskLevel: "low",
        // Setting a value on a conversion action changes what the account
        // optimises toward. That is the one mutation class this system has
        // always kept out of the guarded path, and this does not change it.
        applicability: "vendor",
        title: proxy.state === "ready"
          ? `Every lead on this account is worth the same to the bidding, and this client's own record says they are not`
          : proxy.state === "disagrees"
            ? `The value this account bids against and the value this client's record implies are a long way apart`
            : `Nothing on this client's record says what a lead is worth, so the bidding treats every one of them alike`,
        summary: proxy.state === "ready"
          ? `The platform can be told what a conversion is worth, and then it prefers the ones worth more. This client's own customer value and close rate give a defensible figure for that, it is already on their record, and it is being sent nowhere. It is a figure a person types into the account — nothing here changes it.`
          : proxy.state === "disagrees"
            ? `A value is already set on this account's conversion action and it does not match what the client's own customer value and close rate imply. One of the two is out of date and the platform is spending against whichever is in the account.`
            : `Value-based bidding needs a number on the conversion, and the number is the client's own: what a customer is worth to them, times the share of leads that become one. One of those two is not on their record, and nothing here will pick one — a value that was guessed reads on a screen exactly like one they gave us.`,
        evidence: {
          metrics: proxy.metrics,
          ...win,
          lines: [
            ...proxy.lines,
            ...(proxy.actionNames.length ? [`The counting action(s) a value would go on: ${proxy.actionNames.join(", ")}`] : []),
            ...proxy.instruction.map((s2) => `To do — ${s2}`),
          ],
        },
        // Deliberately no dollar figure on the FINDING even though the reading
        // carries one. The modelled lead value is what a conversion is worth,
        // not what this change is worth — multiplying it by a conversion count
        // would claim the account gains the whole value of every lead, which
        // is not a claim anybody can make.
        estImpactCents: 0,
        impactUnit: "usd_month",
        impactAssumption: proxy.state === "missing_inputs"
          ? "No figure, and none can be worked out: one of the two numbers it is built from is not on the client's record. The row names which."
          : `No figure claimed for the change. The ${((proxy.valueCents ?? 0) / 100).toFixed(2)} in the evidence is what one lead is worth on this client's own two figures — modelled, not measured, and it moves the moment either figure is corrected. `
            + `It is not what setting it is worth: nothing here can say how much better the bidding gets from knowing it.`,
        changePayload: null,
        guardNote: "Nothing to apply. Putting a value on a conversion action changes what the account bids toward, which is outside the guarded path on purpose — a person makes this change in the account.",
      });
    }
  }

  return out;
}

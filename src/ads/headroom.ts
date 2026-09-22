/**
 * A campaign converting under what a lead is worth, with impressions still to
 * buy.
 *
 * Pure. Facts in, one reading out, in the style of `biddingReadiness` and
 * `spendVisibility` next door.
 *
 * ── THE GAP THIS FILLS ────────────────────────────────────────────────────
 *
 * `budget_limited` fires when a campaign gives up more than a tenth of its
 * impressions BECAUSE THE DAILY BUDGET RAN OUT, and it is the engine's only
 * rule that ever says spend more. `rank_limited` fires above 40% lost to Ad
 * Rank and says the opposite: more budget will not fix this, work the bid and
 * the quality.
 *
 * Between those two sits the case nothing looks at. A campaign at 55%
 * impression share, four points lost to budget and 35% lost to Ad Rank, buying
 * conversions at half what this client says one is worth, produces no row at
 * all — and it is the single best place on the account to put another dollar.
 * Every metric on it reads healthy, which is exactly why nothing speaks for it.
 *
 * ── WHICH LEVER, SAID OUT LOUD ────────────────────────────────────────────
 *
 * Impressions are lost to one of two things and they have opposite fixes, so
 * the reading names which one holds the larger share rather than saying "spend
 * more" and leaving somebody to work it out:
 *
 *  budget — the daily cap. Raising it is the cheap move, and where the cap is
 *           costing more than a tenth of the impressions `budget_limited`
 *           already owns that conversation, with the guarded change on it.
 *           This reading defers to it (see `budgetRuleFloor` below).
 *  rank   — being outbid, or held back on expected click-through and landing
 *           page. The money lever there is what we are willing to PAY for a
 *           conversion, which is the campaign's bid or its target, and the only
 *           thing that makes paying more sane is a margin against what a lead
 *           is worth. That margin is what this reading measures.
 *
 * ── WHAT IT CLAIMS ────────────────────────────────────────────────────────
 *
 * Leads, not dollars, and labelled as a projection from this campaign's own
 * current cost per conversion. There is no modelled revenue figure here: the
 * lead value is already the thing the margin is measured against, and running
 * it through the projected volume as well would turn one recorded number into
 * a dollar forecast of a change nobody has made yet.
 *
 * The projection is optimistic at both ends and the sentence says so. The
 * auctions a campaign is losing are the ones it is being outbid in, so they
 * cost more per click than the ones it wins; and there is no reason a query it
 * is currently too cheap to reach converts at the rate of one it already wins.
 *
 * ── NO API CHANGE ─────────────────────────────────────────────────────────
 *
 * The lever this names is a bid or a target, which has no guarded path here by
 * design, or a budget on a campaign the budget rule's own floor says is not
 * capped enough to be worth moving. `applicability: "vendor"`.
 */

import { whatItWouldNeed, type BiddingReadiness } from "./bidding-readiness.js";

/**
 * How far under the target a conversion has to cost before this is headroom
 * rather than a campaign sitting on its number.
 *
 * Four fifths, and it pairs with the conversion floor below rather than
 * standing on its own: with five conversions in the window, one more or one
 * fewer moves the cost per conversion by a fifth, so a campaign inside a fifth
 * of its target could be over it on the next reading. The two numbers are each
 * other's justification and neither is defensible alone. OURS, not published.
 */
export const HEADROOM_COMFORT_RATIO = 0.8;

/**
 * Conversions in the window before a cost per conversion is steady enough to
 * measure a margin against. See above: five is where a one-conversion swing is
 * a fifth, which is the margin the ratio demands.
 *
 * This is NOT the published 15-per-30-days bidding minimum and must not be
 * confused with it. That figure is about whether a bidding MODEL can learn;
 * this one is about whether an arithmetic mean is stable. A campaign can be
 * well under the bidding minimum and still have a cost per conversion worth
 * reading — and where the lever is a bid target, `biddingReadiness` is what
 * decides whether it may be touched, composed rather than re-decided here.
 */
export const HEADROOM_MIN_CONVERSIONS = 5;

/**
 * Lost impression share below which there is nothing to buy.
 *
 * A campaign at 93% share has no room worth a row, and a rule that fires on
 * every healthy campaign is one people learn to scroll past. A tenth is the
 * same floor `THRESHOLDS.budgetLostShare` uses for the other direction, so the
 * two rules draw the line in the same place. OURS.
 */
export const HEADROOM_MIN_LOST_SHARE = 0.10;

/**
 * Above this share lost to budget, `budget_limited` has already fired and owns
 * the campaign's spend-more conversation — including the guarded budget change
 * this reading deliberately does not carry. Two rows proposing the same rise is
 * how a queue fills with advice nobody reads, so this one stays quiet there.
 *
 * It is `THRESHOLDS.budgetLostShare`, passed in rather than imported so this
 * module has no runtime import back into rules.ts.
 */
export interface HeadroomInput {
  campaignId: string;
  campaignName: string;
  costMicros: number;
  conversions: number;
  impressionShare: number | null;
  budgetLostShare: number | null;
  rankLostShare: number | null;
  /** Cost per conversion in cents, or null where the caller refused to work
   *  one out — an unreadable conversion column, or a denominator under one.
   *  Never recomputed here. */
  costPerConversionCents: number | null;
  /** The governing cost target and how it was arrived at. Null = the client
   *  has recorded neither a ceiling nor the two figures a modelled one needs,
   *  and nothing here invents one. */
  targetCents: number | null;
  targetBasis: "stated" | "modelled" | null;
  /** The floor above which `budget_limited` already fired on this campaign. */
  budgetRuleFloor: number;
  /** The share of lost impressions we assume would actually be captured. The
   *  same figure the budget rule uses, passed in so the two cannot disagree. */
  captureRate: number;
  /** This campaign's bidding reading. Null where none was taken. */
  readiness: BiddingReadiness | null;
  /** True where `rank_limited` also fired on this campaign, so the row can
   *  defer to it rather than restating what it says. */
  rankRuleAlsoFired: boolean;
}

export type HeadroomVerdict =
  /** There is room, the economics allow paying for it, and the row is raised. */
  | "room"
  /** Nothing left to buy: the campaign already takes most of what is there. */
  | "no_room"
  /** Converting, but not far enough under the target to license paying more. */
  | "at_or_over_target"
  /** Too few conversions for the cost per conversion to be steady. */
  | "too_few_conversions"
  /** The budget rule already fired and owns this campaign's spend question. */
  | "budget_rule_owns_it"
  /** A figure this needs was not read, or the client has recorded no target. */
  | "cant_tell";

export interface HeadroomReading {
  campaignId: string;
  campaignName: string;
  verdict: HeadroomVerdict;
  /** Which of the two the larger share of the lost impressions sits behind.
   *  Null on every verdict but `room`. */
  lever: "budget" | "rank" | null;
  lostShare: number | null;
  /** Rough extra monthly spend if half of the lost share were captured. */
  extraSpendMicros: number | null;
  /** …and what that buys at today's cost per conversion. */
  extraConversions: number | null;
  /** How far under the target each conversion currently comes in, as a share
   *  of the target. Null where no margin was computed. */
  marginShare: number | null;
  lines: string[];
  /** What would have to be true before the lever may be pulled. Empty where
   *  nothing stands in the way. */
  blockers: string[];
  metrics: Record<string, number>;
  /** Why no row was raised, in one clause. Null on `room`. */
  silence: string | null;
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Pure. One campaign's answer.
 *
 * Every verdict but `room` is SILENT — no row, no queue line, nothing on a
 * screen. A campaign that cannot be read, or has nothing to buy, or is sitting
 * on its target is not a finding; it is an ordinary campaign, and a row saying
 * so on every one of them is the rule people learn to ignore.
 */
export function headroomReading(i: HeadroomInput): HeadroomReading {
  const base = {
    campaignId: i.campaignId, campaignName: i.campaignName,
    lever: null, lostShare: null, extraSpendMicros: null, extraConversions: null,
    marginShare: null, lines: [] as string[], blockers: [] as string[],
    metrics: {} as Record<string, number>,
  };

  const budgetLost = i.budgetLostShare;
  const rankLost = i.rankLostShare;
  // A null is not a nought. Where the platform reported neither, there is no
  // room figure to read and nothing here invents one from the impression share
  // alone — 1 minus share is lost to SOMETHING, and which of the two it is
  // decides the whole recommendation.
  if (budgetLost == null && rankLost == null) {
    return { ...base, verdict: "cant_tell",
      silence: "No reading: the platform reported neither the share lost to budget nor the share lost to Ad Rank for this campaign, and which of the two is holding it back is the whole answer." };
  }
  if (i.impressionShare == null || i.impressionShare <= 0) {
    return { ...base, verdict: "cant_tell",
      silence: "No reading: the platform reported no impression share for this campaign, so there is nothing to say how much of what is available it is already taking." };
  }
  if ((budgetLost ?? 0) > i.budgetRuleFloor) {
    return { ...base, verdict: "budget_rule_owns_it",
      silence: "No separate reading: this campaign is already losing more than the budget rule's own floor to its daily cap, and that row carries the spend question with the change on it." };
  }
  if (i.costPerConversionCents == null) {
    return { ...base, verdict: "cant_tell",
      silence: "No reading: no cost per conversion was worked out for this campaign, so there is nothing to measure against what a lead is worth." };
  }
  if (i.targetCents == null || i.targetBasis == null) {
    return { ...base, verdict: "cant_tell",
      silence: "No reading: nothing on this client's record says what a lead may cost or what a customer is worth, so nothing here can say a conversion is cheap enough to buy more of. Record a cost-per-lead ceiling, or a customer value and a close rate, and this becomes an answer." };
  }
  if (i.conversions < HEADROOM_MIN_CONVERSIONS) {
    return { ...base, verdict: "too_few_conversions",
      silence: `No reading: ${i.conversions.toFixed(1)} conversion(s) in the window is too few for a cost per conversion to hold still, and this reading is a margin measured against it.` };
  }

  const cpa = i.costPerConversionCents;
  const comfortable = cpa <= Math.round(i.targetCents * HEADROOM_COMFORT_RATIO);
  if (!comfortable) {
    return { ...base, verdict: "at_or_over_target",
      silence: `No reading: each conversion costs $${(cpa / 100).toFixed(2)} against a $${(i.targetCents / 100).toFixed(2)} target, which is not far enough under it to license paying more per click.` };
  }

  const lostShare = (budgetLost ?? 0) + (rankLost ?? 0);
  if (lostShare < HEADROOM_MIN_LOST_SHARE) {
    return { ...base, verdict: "no_room", lostShare,
      silence: `No reading: this campaign gives up ${pct(lostShare)} of its impressions, which is too little to absorb any meaningful extra spend. The room for this account is in new queries or new campaigns, not in this one.` };
  }

  const lever: "budget" | "rank" = (rankLost ?? 0) >= (budgetLost ?? 0) ? "rank" : "budget";
  // The SAME form `budget_limited` uses — spend x share lost x capture rate —
  // rather than a proportional extrapolation from the impression share. Two
  // rules producing two different extra-spend figures for one campaign is the
  // disagreement this codebase spends versions removing, and this is the
  // smaller of the two readings.
  const extraSpendMicros = Math.round(i.costMicros * lostShare * i.captureRate);
  const extraConversions = extraSpendMicros / 10_000 / cpa;
  const marginShare = (i.targetCents - cpa) / i.targetCents;

  const lines: string[] = [
    `${usd(i.costMicros)} · ${i.conversions.toFixed(1)} conversions · $${(cpa / 100).toFixed(2)} each (30 days)`,
    `Impression share ${pct(i.impressionShare)} — ${pct(rankLost ?? 0)} lost to Ad Rank, ${pct(budgetLost ?? 0)} lost to budget`,
    `Each conversion comes in ${pct(marginShare)} under the $${(i.targetCents / 100).toFixed(2)} ${i.targetBasis === "stated" ? "ceiling this client stated" : "figure modelled from this client's customer value and close rate"}`,
    lever === "rank"
      ? "Most of what it gives up goes to Ad Rank, so the lever is what we are willing to pay for a conversion — the bid, or the target on the strategy — not the daily budget."
      : "Most of what it gives up goes to the daily cap, under the floor at which the budget rule raises its own row. Raising the cap is the cheap first move here.",
  ];

  const blockers: string[] = [];
  if (lever === "rank" && i.readiness && !i.readiness.mayProposeBidTarget) {
    blockers.push("Nothing here proposes a target change on this campaign: its bidding does not have the conversions to survive one.");
    blockers.push(...whatItWouldNeed(i.readiness));
  }
  if (i.rankRuleAlsoFired) {
    blockers.push("A separate row on this campaign covers the Ad Rank share itself. Ad relevance and the landing page are the cheaper half of that and come first; this row is only about whether the economics allow paying more once they are done.");
  }

  return {
    campaignId: i.campaignId,
    campaignName: i.campaignName,
    verdict: "room",
    lever,
    lostShare,
    extraSpendMicros,
    extraConversions,
    marginShare,
    lines,
    blockers,
    metrics: {
      costMicros: i.costMicros,
      conversions: i.conversions,
      costPerConversionCents: cpa,
      targetCents: i.targetCents,
      impressionShare: i.impressionShare,
      lostImpressionShare: lostShare,
      rankLostShare: rankLost ?? 0,
      budgetLostShare: budgetLost ?? 0,
      headroomMarginShare: marginShare,
      projectedExtraSpendMicros: extraSpendMicros,
    },
    silence: null,
  };
}

/**
 * What the projection assumes, in one paragraph, including the two reasons it
 * is the optimistic end. Used as the `impactAssumption`.
 */
export function headroomClaim(r: HeadroomReading, captureRate: number): string {
  if (r.verdict !== "room" || r.extraSpendMicros == null || r.extraConversions == null) {
    return r.silence ?? "No figure claimed.";
  }
  return `A projection from this campaign's current performance, not a promise. It assumes ${pct(captureRate)} of the ${pct(r.lostShare ?? 0)} of impressions `
    + `it gives up could be bought, which at today's prices is about ${usd(r.extraSpendMicros)} a month of extra spend and ${r.extraConversions.toFixed(1)} more `
    + `conversions at the $${((r.metrics.costPerConversionCents ?? 0) / 100).toFixed(2)} each it records now. `
    + `Both ends of that are optimistic. Impression share lost is not demand handed over, and the auctions this campaign is missing are the ones it is `
    + `being outbid in — they cost more per click than the ones it wins, and nothing says they convert as well. Read the figure as the size of the room, `
    + `not as leads anybody has been promised.`;
}

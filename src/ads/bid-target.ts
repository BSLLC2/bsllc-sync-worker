/**
 * Has the platform been told what a conversion may cost?
 *
 * Pure. Facts in, one verdict out, in the style of `trackingReading` and
 * `biddingReadiness` next door. Nothing here reads a campaign name, a title or
 * a cost per conversion — it reads the bidding strategy the platform reports
 * and the target figure on it, and nothing else.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * A campaign was running Maximize Conversions with no target CPA on the
 * strategy, paying $84.42 a conversion against a $46 ceiling recorded on our
 * side. The rules engine raised `cpa_above_target`, which tells a vendor the
 * cost per conversion is too high — true, and a description of the symptom.
 * The cause is that GOOGLE WAS NEVER TOLD THE CEILING: Maximize Conversions
 * with no target buys as much volume as the budget allows, and it is doing
 * exactly what it was set up to do. A second campaign on the same account was
 * on Manual CPC, where nothing automated is steering toward a cost at all.
 *
 * Those two figures came from a person reading a live Google Ads screen on
 * 2026-09-21. Nothing in this sandbox measured them, every figure in the
 * fixtures is invented, and there is no production database here.
 *
 * ── THE STRATEGY IS READ FROM THE ACCOUNT, NEVER INFERRED ─────────────────
 *
 * A cost per conversion above a ceiling is consistent with a target being set
 * and missed, and with no target existing. Those need opposite advice, so this
 * turns only on what the platform reports. Where the platform reported nothing
 * this build can read, the verdict is `cant_tell` and the rule stays silent: a
 * finding that guesses at configuration is worse than no finding.
 *
 * ── A NULL TARGET IS "NOT SET", NEVER NOUGHT ──────────────────────────────
 *
 * Google returns a target field only where one is set. A campaign carrying no
 * target and a campaign carrying a target of nought are not the same thing and
 * neither is a campaign whose target we could not read — a portfolio bid
 * strategy holds its target on the strategy resource rather than on the
 * campaign, so `hasTarget: false` read off campaign fields alone would call
 * every portfolio Target CPA campaign untargeted. That is what `targetRead`
 * exists for.
 */

/** Strategies whose whole job is to hit a cost or return target. */
export const COST_TARGET_STRATEGIES = new Set(["TARGET_CPA", "TARGET_ROAS", "MANUAL_CPA"]);
/** Automated strategies that CAN carry a cost target and work without one. */
export const OPTIONAL_TARGET_STRATEGIES = new Set(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]);
/** Nothing automated is steering. Enhanced CPC adjusts a manual bid; it is
 *  still a manual bid and it carries no cost target. */
export const MANUAL_STRATEGIES = new Set([
  "MANUAL_CPC", "MANUAL_CPM", "MANUAL_CPV", "PERCENT_CPC", "ENHANCED_CPC",
]);
/** Automated, and optimising for something that is not the cost of a
 *  conversion: clicks, impressions, position. */
export const NON_COST_STRATEGIES = new Set([
  "TARGET_SPEND", "TARGET_IMPRESSION_SHARE", "TARGET_OUTRANK_SHARE", "TARGET_CPM",
  "TARGET_CPV", "TARGET_CPC", "FIXED_CPM", "FIXED_SHARE_OF_VOICE", "PAGE_ONE_PROMOTED",
  "COMMISSION",
]);
/** The platform's own "we cannot tell you", plus a build that could not decode
 *  what it sent. Never read as manual and never read as targeted. */
export const UNREADABLE_STRATEGIES = new Set(["UNSPECIFIED", "UNKNOWN", "INVALID", "UNRECOGNISED"]);

export type BidTargetKind =
  /** A cost target is set and the platform is bidding toward it. */
  | "targeted"
  /** An automated strategy that can carry a cost target, with none set. */
  | "no_target_on_strategy"
  /** Manual bidding. There is no automated strategy to carry a target. */
  | "manual"
  /** Automated, optimising for something other than the cost of a conversion. */
  | "other_goal"
  /** Nothing here can say. The rule stays silent. */
  | "cant_tell";

export interface BidTargetReading {
  kind: BidTargetKind;
  /** The strategy the platform reported, decoded. Null where none was read. */
  strategy: string | null;
  /** One clause naming what the platform is bidding toward, for the finding's
   *  title. Empty on `targeted` and on `cant_tell`. */
  headline: string;
  /** What the account is actually doing, in a vendor's words. Empty where this
   *  reading has nothing to say. */
  explanation: string;
  /** Why nothing is being said, on `cant_tell`. Empty otherwise. */
  silentBecause: string;
}

export interface BidTargetFacts {
  /** The decoded strategy name the platform reports. NULL MEANS NOT READ. */
  strategyType: string | null;
  /**
   * Whether a target figure was found on the strategy. NULL MEANS NOT READ —
   * which is what a campaign on a portfolio strategy we could not open looks
   * like, and it must never read as "no target".
   */
  hasTarget: boolean | null;
  /**
   * Did this run actually get to LOOK at where the target would be? False
   * where the campaign sits on a portfolio strategy whose own record was not
   * read. `hasTarget: false` with `targetRead: false` is unanswered.
   */
  targetRead: boolean;
}

const quote = (s: string) => s.replace(/_/g, " ").toLowerCase();

/**
 * Pure. One campaign's bidding, one verdict.
 *
 * The order of the tests is the order of confidence. A target that was
 * actually found settles it whatever the strategy is called, because a figure
 * the platform returned beats a name this build has a set for.
 */
export function bidTargetReading(f: BidTargetFacts): BidTargetReading {
  const strategy = (f.strategyType ?? "").trim().toUpperCase() || null;
  const base = { strategy, headline: "", explanation: "", silentBecause: "" };

  if (f.hasTarget === true) {
    return { ...base, kind: "targeted" };
  }
  if (!strategy) {
    return {
      ...base, kind: "cant_tell",
      silentBecause: "The platform reported no bidding strategy for this campaign, so nothing here can say whether it has been given a cost to bid toward.",
    };
  }
  if (UNREADABLE_STRATEGIES.has(strategy)) {
    return {
      ...base, kind: "cant_tell",
      silentBecause: `The platform reported a bidding strategy this build does not recognise, so nothing here can say what the campaign is bidding toward.`,
    };
  }
  if (f.hasTarget == null || !f.targetRead) {
    return {
      ...base, kind: "cant_tell",
      silentBecause: `This campaign runs ${quote(strategy)}, and the target that goes with it sits on a shared bid strategy this run did not read. Open the strategy in the account before deciding anything about its target.`,
    };
  }

  if (OPTIONAL_TARGET_STRATEGIES.has(strategy)) {
    return {
      ...base,
      kind: "no_target_on_strategy",
      headline: `no cost target is set on its bidding`,
      explanation:
        `This campaign runs ${quote(strategy)} with no target cost on the strategy. That setting buys as many conversions as the budget allows and is given no price it has to stay under, `
        + `so a conversion costing more than the client agreed is the strategy working as configured. Set the target on the strategy first, then judge the cost against it.`,
    };
  }
  if (MANUAL_STRATEGIES.has(strategy)) {
    return {
      ...base,
      kind: "manual",
      headline: `its bidding is manual, so nothing is steering toward a cost`,
      explanation:
        `This campaign runs ${quote(strategy)}. Manual bidding has no cost target by design: the bid is what somebody typed, and the platform is not being asked to hold a price per conversion. `
        + `Decide whether this campaign should move to a strategy that bids toward a cost, or stay manual and be judged on the bid instead.`,
    };
  }
  if (NON_COST_STRATEGIES.has(strategy)) {
    return {
      ...base,
      kind: "other_goal",
      headline: `its bidding is set to chase something other than the cost of a conversion`,
      explanation:
        `This campaign runs ${quote(strategy)}, which optimises for clicks, impressions or position rather than for what a conversion costs. `
        + `No target it carries is a price per conversion, so the cost this campaign pays for one is a side effect of the goal it was given.`,
    };
  }
  if (COST_TARGET_STRATEGIES.has(strategy)) {
    return {
      ...base,
      kind: "no_target_on_strategy",
      headline: `no cost target is set on its bidding`,
      explanation:
        `This campaign runs ${quote(strategy)}, which exists to hold a cost target, and the platform returned no target figure for it. `
        + `Check the strategy in the account: either the target is missing, or it lives on a shared strategy and nobody here can see it.`,
    };
  }
  return {
    ...base, kind: "cant_tell",
    silentBecause: `This campaign runs ${quote(strategy)}, which this build has no rule for, so nothing here can say what it is bidding toward.`,
  };
}

/**
 * The evidence line, which has to be true for all three absent cases.
 *
 * "No cost target on the strategy" is right for a Maximize Conversions
 * campaign and wrong for a manual one — manual bidding has no strategy to
 * carry a target — so the clause follows the verdict rather than being written
 * once for the commonest of the three.
 */
export function bidTargetEvidenceLine(r: BidTargetReading): string {
  const name = r.strategy ?? "not reported";
  if (r.kind === "manual") return `Bidding: ${name} · manual, so no cost target exists to hold`;
  if (r.kind === "other_goal") return `Bidding: ${name} · optimising for something other than the cost of a conversion`;
  return `Bidding: ${name} · no cost target set on the strategy`;
}

/** The verdicts that mean the platform was never given a cost to hold. */
export function targetIsAbsent(r: BidTargetReading): boolean {
  return r.kind === "no_target_on_strategy" || r.kind === "manual" || r.kind === "other_goal";
}

/**
 * The sentence written onto the `cpa_above_target` row this replaces.
 *
 * It is not a dismissal in the ordinary sense and it must never read as one.
 * The condition did not clear — it got a better explanation, and the row that
 * carries it is named so nobody has to go looking.
 */
export function supersedeReason(campaignName: string): string {
  return `Replaced by a sharper reading of the same campaign: "${campaignName}" is over its cost target AND its bidding carries no cost target, `
    + `so the cost is the consequence rather than the fault. The cost figures are on the new row.`;
}

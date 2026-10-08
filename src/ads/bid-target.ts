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
  /** On `targeted` only: the cost target in cents, where it was a cost target
   *  and its figure was read. Null everywhere else, and null is "not read". */
  targetCents?: number | null;
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
   * The COST target's figure in micros, where one was found. NULL MEANS NOT
   * READ, OR NOT A COST TARGET: a return-on-spend target is a ratio, never a
   * price per conversion, and is not compared with a ceiling in dollars. It
   * rides beside `hasTarget` so a target set ABOVE the recorded ceiling can be
   * told apart from no target at all, which used to read the same.
   */
  targetCpaMicros?: number | null;
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
    const micros = f.targetCpaMicros != null && Number.isFinite(f.targetCpaMicros) && f.targetCpaMicros > 0
      ? f.targetCpaMicros : null;
    return { ...base, kind: "targeted", targetCents: micros != null ? Math.round(micros / 10_000) : null };
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

// ── What to do instead, where a target is held back ─────────────────────────
/**
 * `targetReadiness` already refuses to recommend a cost target below about 15
 * conversions a month and says it is held back. That says what NOT to do and
 * leaves the reader to work out what to do instead. On a campaign that bids
 * manually the answer is "stay manual", and a person reading the row should not
 * have to infer it.
 *
 * It follows the reading's own kind, so a campaign on an automated strategy is
 * not told to "stay manual" when it is not manual. Nothing here changes whether
 * the target row is raised: that is `targetReadiness`, untouched.
 */
export function stayPutLine(kind: BidTargetKind, reason: "conversions" | "tracking"): string | null {
  const until = reason === "tracking"
    ? "until conversion tracking can be trusted"
    : "until the campaign has the conversions for a target to steer on";
  if (kind === "manual") return `Stay manual ${until}. Moving it to a strategy that bids toward a cost is not recommended yet.`;
  if (kind === "no_target_on_strategy") return `Leave the bidding as it is, with no cost target set, ${until}.`;
  if (kind === "other_goal") return `Leave the bidding goal as it is ${until}.`;
  return null;
}

// ── A target that is set, and where it sits against the ceiling ─────────────
/**
 * A TARGET ABOVE THE RECORDED CEILING IS A STATE, AND IT HAD NO NAME.
 *
 * A campaign whose cost target was set at $75 against a recorded ceiling of $46
 * read exactly like one with no target at all: both arrived as "over the
 * ceiling" with nothing to say that somebody had already told the platform a
 * price. The usual way to move a campaign toward a tight ceiling is to set the
 * target where the account is today and step it down, so "set, above the
 * ceiling" is the middle of a job and not its start.
 *
 * `above_ceiling` says the target is higher than the ceiling and nothing else.
 * It does not claim anybody IS stepping it down (nothing here can see a plan);
 * the sentence names the gap and the direction it points. A target at or under
 * the ceiling is `within`. Anything unread is `unknown`, never within and never
 * above. Cost targets only: a return-on-spend target carries no cents.
 */
export type TargetStepState = "above_ceiling" | "within" | "unknown";

export interface TargetStep {
  state: TargetStepState;
  targetCents: number | null;
  ceilingCents: number | null;
  /** One evidence line; empty on `unknown`. */
  line: string;
}

export function targetStep(r: BidTargetReading, ceilingCents: number | null, ceilingIsEstimate = false): TargetStep {
  const target = r.kind === "targeted" ? (r.targetCents ?? null) : null;
  if (target == null || ceilingCents == null || ceilingCents <= 0) {
    return { state: "unknown", targetCents: target, ceilingCents: ceilingCents ?? null, line: "" };
  }
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const ceil = ceilingIsEstimate ? "estimated ceiling" : "ceiling";
  if (target > ceilingCents) {
    return {
      state: "above_ceiling", targetCents: target, ceilingCents,
      line: `Target ${money(target)} · ${ceil} ${money(ceilingCents)} · stepping down. The platform has been given a price, and it sits above the ceiling.`,
    };
  }
  return {
    state: "within", targetCents: target, ceilingCents,
    line: `Target ${money(target)} · ${ceil} ${money(ceilingCents)} · the target is at or under the ceiling, so the cost above it is a result the platform is missing, not a price it was never given.`,
  };
}

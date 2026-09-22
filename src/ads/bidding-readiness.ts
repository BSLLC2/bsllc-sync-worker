/**
 * Can this campaign's bidding strategy learn anything?
 *
 * Pure. Facts in, one reading out, in the style of `trackingReading` next door.
 * Nothing here reads a campaign name, an action name or a title; it reads the
 * conversion count the platform reported, the strategy the platform says the
 * campaign is on, the lag buckets the platform segmented, and whether the
 * conversion column may be read at all.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS FIRST ──────────────────────────────────
 *
 * Every published threshold for a target-based bidding strategy is a count of
 * conversions PER CAMPAIGN PER 30 DAYS, and until this module nothing in this
 * system computed that number anywhere. `noConversionClicks` asks whether a
 * campaign converted AT ALL. That is a different question, and it cannot tell
 * a campaign a bidding model can learn from apart from one it cannot.
 *
 * The consequence is the OCH scar in miniature: a recommendation to tighten a
 * target, or to move a budget by more than the learning phase tolerates, on a
 * campaign whose signal is too thin for the model to have an opinion, is worse
 * than no recommendation. It re-enters learning on the way through and the
 * account pays for the reset with nothing to show for it.
 *
 * ── THE THRESHOLDS ARE CONVENTIONS AND ARE NAMED AS SUCH ──────────────────
 *
 * `shared/hiring-readiness.ts` in the dashboard states every threshold it uses
 * as a convention with its source, and refuses to dress an in-house line up as
 * a published one. The same discipline applies here, because the temptation is
 * identical: a number in a constant reads like a fact about the platform.
 *
 * Provenance, in the order the research found it, is on each constant below.
 * The 15-per-campaign-per-30-days minimum is the one figure that several
 * independent sources each attribute to Google's own Target CPA and Target
 * ROAS support pages, and it was re-confirmed for this change. THE SUPPORT
 * PAGES THEMSELVES COULD NOT BE OPENED FROM HERE — `support.google.com` is
 * blocked by this sandbox's egress policy — so it is triangulated rather than
 * read, and every sentence that leans on it says "published minimum" rather
 * than asserting it as a platform guarantee.
 */

/**
 * Google's published minimum for a target-based Smart Bidding strategy on
 * Search: 15 conversions in the last 30 days, IN THE CAMPAIGN rather than in
 * the account.
 *
 * Sources (triangulated; the support pages are blocked from this sandbox):
 *   Google — About Target CPA bidding  support.google.com/google-ads/answer/6268632
 *   Google — About Target ROAS bidding support.google.com/google-ads/answer/6268637
 *   Store Growers, White Shark Media and LGG Media each quote the same figure
 *   and each attribute it to those pages.
 *
 * This is the bar the GATE uses, because it is the published one. It is not
 * the bar at which the strategy works well — see the next constant.
 */
export const TARGET_STRATEGY_MIN_CONVERSIONS_30D = 15;

/**
 * What practitioners say is actually needed before a target-cost strategy
 * holds its target rather than lurching: about 30 conversions per campaign per
 * 30 days, and about 50 for a target-return one.
 *
 * INDUSTRY CONVENTION, NOT A PUBLISHED FIGURE. Several independent writers
 * agree on it and none of them shows a method, so it decides no verdict here —
 * it is the second number in the sentence, the one that says "clears the bar
 * and is still going to be volatile".
 */
export const TARGET_STRATEGY_STABLE_CONVERSIONS_30D = 30;
export const TARGET_ROAS_STABLE_CONVERSIONS_30D = 50;

/**
 * How long a conversion may take to arrive and still be usable as a bidding
 * signal: about seven days from the click.
 *
 * This one is arithmetic on top of documented constraints rather than a
 * threshold anybody published. Google's own guidance for importing outcomes
 * asks for a conversion delay under seven days, and the maximum conversion
 * window is 90 days, after which an outcome cannot be optimised toward at all.
 * A business whose outcome lands 30 or 60 days after the click cannot
 * structurally produce a timely signal however much volume it has — which is
 * the half of the OCH failure that a conversion count alone does not show.
 */
export const USEFUL_CONVERSION_LAG_DAYS = 7;

/**
 * Below this, a lag distribution is a handful of rows and a median off it is
 * noise. Thirty conversions is the same figure the stability convention uses,
 * which is not a coincidence: it is roughly where a bucketed median stops
 * moving when one more conversion lands in a different bucket.
 */
export const MIN_CONVERSIONS_FOR_LAG_READING = 30;

/**
 * The strategies whose whole job is to hit a CONVERSION target, and which
 * therefore carry the volume floor above.
 *
 * Deliberately two. Target Impression Share and Maximize Clicks (which the API
 * calls TARGET_SPEND) both have "target" in their names and neither optimises
 * toward a conversion at all, so the published conversion minimum has nothing
 * to say about either — putting them in would be keying a rule on a word.
 *
 * MAXIMIZE_CONVERSIONS and MAXIMIZE_CONVERSION_VALUE join this set ONLY when a
 * target is actually set on them (the caller passes `hasTarget`), because
 * without one they are the recommended low-volume strategy rather than a
 * strategy that needs volume — which is exactly the distinction the published
 * low-volume playbook turns on.
 */
export const TARGET_BID_STRATEGIES = new Set(["TARGET_CPA", "TARGET_ROAS"]);
const TARGET_WHEN_SET = new Set(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]);

/** Strategies that need no conversion volume at all — nothing is learning. */
export const MANUAL_BID_STRATEGIES = new Set(["MANUAL_CPC", "MANUAL_CPM", "MANUAL_CPV", "PERCENT_CPC"]);

/**
 * One lag bucket as the platform segments it, folded to the number of days at
 * its TOP end.
 *
 * The top end rather than the middle, deliberately: the reading is used to
 * decide whether a signal arrives soon enough, and rounding a lag DOWN is the
 * expensive direction to be wrong in. An unknown or unspecified bucket is not
 * mapped and is counted as unread rather than dropped.
 */
const LAG_BUCKET_DAYS: Record<string, number> = {
  LESS_THAN_ONE_DAY: 1, ONE_TO_TWO_DAYS: 2, TWO_TO_THREE_DAYS: 3, THREE_TO_FOUR_DAYS: 4,
  FOUR_TO_FIVE_DAYS: 5, FIVE_TO_SIX_DAYS: 6, SIX_TO_SEVEN_DAYS: 7, SEVEN_TO_EIGHT_DAYS: 8,
  EIGHT_TO_NINE_DAYS: 9, NINE_TO_TEN_DAYS: 10, TEN_TO_ELEVEN_DAYS: 11, ELEVEN_TO_TWELVE_DAYS: 12,
  TWELVE_TO_THIRTEEN_DAYS: 13, THIRTEEN_TO_FOURTEEN_DAYS: 14, FOURTEEN_TO_TWENTY_ONE_DAYS: 21,
  TWENTY_ONE_TO_THIRTY_DAYS: 30, THIRTY_TO_FORTY_FIVE_DAYS: 45, FORTY_FIVE_TO_SIXTY_DAYS: 60,
  SIXTY_TO_NINETY_DAYS: 90,
};

/** One row of the platform's own lag segmentation, per campaign. */
export interface ConversionLagRow {
  campaignId: string;
  /** The platform's own bucket name, already decoded by the adapter. */
  bucket: string;
  conversions: number;
}

export interface LagReading {
  /** Days at the top of the bucket the median conversion falls in. Null where
   *  there was not enough to read, which is never the same as "fast". */
  medianDays: number | null;
  /** Share of conversions arriving within the useful window. Null = unread. */
  shareWithinUsefulWindow: number | null;
  /** Conversions the reading is built on, excluding unmapped buckets. */
  counted: number;
  /** Conversions in a bucket this build does not recognise. */
  unmapped: number;
  /** Why no median was produced. Empty where one was. */
  unread: string[];
}

/**
 * Pure. A bucketed median, and the share landing inside the useful window.
 *
 * A BUCKETED MEDIAN IS NOT A MEDIAN and the sentences that print it say so: it
 * is the top of the bucket the middle conversion falls into, which is the most
 * the platform's own segmentation can support. Asking for a real median would
 * mean per-conversion timestamps, which this resource does not carry.
 */
export function lagReading(rows: ConversionLagRow[] | null | undefined): LagReading {
  if (rows == null) {
    return { medianDays: null, shareWithinUsefulWindow: null, counted: 0, unmapped: 0,
      unread: ["the conversion lag buckets could not be read, so nothing here can say how long after a click this campaign's conversions arrive"] };
  }
  let counted = 0, unmapped = 0, within = 0;
  const weight = new Map<number, number>();
  for (const r of rows) {
    const days = LAG_BUCKET_DAYS[String(r.bucket ?? "").toUpperCase()];
    const n = Number(r.conversions ?? 0);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (days == null) { unmapped += n; continue; }
    counted += n;
    if (days <= USEFUL_CONVERSION_LAG_DAYS) within += n;
    weight.set(days, (weight.get(days) ?? 0) + n);
  }
  if (counted < MIN_CONVERSIONS_FOR_LAG_READING) {
    return {
      medianDays: null, shareWithinUsefulWindow: null, counted, unmapped,
      unread: [`only ${counted.toFixed(0)} conversion(s) carry a lag bucket, too few to say how long this campaign's conversions take to arrive`],
    };
  }
  const ordered = Array.from(weight.entries()).sort((x, y) => x[0] - y[0]);
  const half = counted / 2;
  let running = 0;
  let medianDays: number | null = null;
  for (const [days, n] of ordered) {
    running += n;
    if (running >= half) { medianDays = days; break; }
  }
  return { medianDays, shareWithinUsefulWindow: within / counted, counted, unmapped, unread: [] };
}

/**
 * What a campaign's own bidding is doing, as the platform reports it. Every
 * field is what a recorded column said; nothing is inferred from a name.
 */
export interface BiddingFacts {
  campaignId: string;
  campaignName: string;
  /** TARGET_CPA / MAXIMIZE_CONVERSIONS / MANUAL_CPC… Null = not reported. */
  strategyType: string | null;
  /** Does the campaign carry an actual target figure? Null = not reported. */
  hasTarget: boolean | null;
  /** Conversions in the trailing 30 days, as the platform counted them.
   *  NULL MEANS NOT READ, never nought. */
  conversions30d: number | null;
  costMicros30d: number;
}

export type BiddingReadinessVerdict =
  /** The conversion column cannot be trusted, so the count is not a fact. */
  | "column_unreadable"
  /** The count was not read at all. Different from a nought. */
  | "unread"
  /** Under the published per-campaign minimum. */
  | "below_minimum"
  /** Over the minimum, under the figure practitioners call stable. */
  | "above_minimum"
  /** Over both. */
  | "stable";

export interface BiddingReadiness {
  campaignId: string;
  campaignName: string;
  verdict: BiddingReadinessVerdict;
  conversions30d: number | null;
  /** How many more a month would clear the published minimum. Null unless the
   *  verdict is below_minimum on a real count. */
  shortBy: number | null;
  strategyType: string | null;
  /** Is this campaign on a strategy whose job is to hit a target? Null where
   *  the platform did not report the strategy, which is never read as false. */
  onTargetStrategy: boolean | null;
  lag: LagReading;
  /** Does the lag reading say this campaign's signal arrives too late to bid
   *  on? Null where the lag could not be read. */
  lagTooLong: boolean | null;
  /** May the engine propose a change to a BID TARGET on this campaign? */
  mayProposeBidTarget: boolean;
  /** May the engine propose a budget step big enough to re-enter learning? */
  mayProposeBudgetStep: boolean;
  /** Each reason the two gates above said no, in the order they were checked. */
  blockers: string[];
  lines: string[];
  metrics: Record<string, number>;
}

/** True only where the platform said so. A null strategy is never read as
 *  manual, because "we did not read it" and "it needs no volume" are opposite
 *  answers and only one of them licenses a change. */
export function onTargetStrategy(f: Pick<BiddingFacts, "strategyType" | "hasTarget">): boolean | null {
  const s = String(f.strategyType ?? "").toUpperCase();
  if (!s) return null;
  if (TARGET_BID_STRATEGIES.has(s)) return true;
  // A null `hasTarget` is "the platform did not report whether a target is
  // set", which is not "there is none". It propagates as null so every gate
  // downstream treats it as unanswered rather than as a licence.
  if (TARGET_WHEN_SET.has(s)) return f.hasTarget == null ? null : f.hasTarget;
  return false;
}

const one = (v: number) => v.toFixed(1);

/**
 * Pure. One campaign's readiness, composed from the tracking reading rather
 * than re-deciding it.
 *
 * `columnCountsAnything` is `trackingReading().countsAnything === "yes"` and
 * nothing else. Deciding a second time here is how two readings of one account
 * start disagreeing, which is the drift the rules module already spends a
 * version removing.
 */
export function biddingReadiness(
  f: BiddingFacts,
  lagRows: ConversionLagRow[] | null | undefined,
  columnCountsAnything: "yes" | "no" | "unknown",
): BiddingReadiness {
  const lag = lagReading(lagRows == null ? null : lagRows.filter((r) => r.campaignId === f.campaignId));
  const onTarget = onTargetStrategy(f);
  const lagTooLong = lag.medianDays == null ? null : lag.medianDays > USEFUL_CONVERSION_LAG_DAYS;
  const blockers: string[] = [];
  const lines: string[] = [];

  lines.push(f.strategyType
    ? `Bidding strategy: ${f.strategyType}${onTarget ? " — a strategy whose job is to hit a target" : onTarget === false ? " — no target for it to hit" : ""}`
    : "The platform did not report which bidding strategy this campaign is on");

  let verdict: BiddingReadinessVerdict;
  let shortBy: number | null = null;
  if (columnCountsAnything === "no") {
    verdict = "column_unreadable";
    blockers.push("This account's conversion column is not recording, so the conversion count this decision turns on is not a fact about the campaign.");
    lines.push("No conversion count is read here: the account's conversion column is not recording.");
  } else if (columnCountsAnything === "unknown" || f.conversions30d == null) {
    verdict = "unread";
    blockers.push("The conversion count for this campaign could not be read, and an unread count is not a nought.");
    lines.push("The trailing 30-day conversion count could not be read for this campaign.");
  } else {
    const n = f.conversions30d;
    lines.push(`${one(n)} conversion(s) in the trailing 30 days, against the published minimum of ${TARGET_STRATEGY_MIN_CONVERSIONS_30D} per campaign per 30 days`);
    if (n < TARGET_STRATEGY_MIN_CONVERSIONS_30D) {
      verdict = "below_minimum";
      shortBy = Math.ceil(TARGET_STRATEGY_MIN_CONVERSIONS_30D - n);
      blockers.push(`${one(n)} conversions a month is under the ${TARGET_STRATEGY_MIN_CONVERSIONS_30D} a campaign needs before a target-based strategy has anything to learn from. It is ${shortBy} short.`);
    } else if (n < TARGET_STRATEGY_STABLE_CONVERSIONS_30D) {
      verdict = "above_minimum";
      lines.push(`Over the published minimum and under the ${TARGET_STRATEGY_STABLE_CONVERSIONS_30D} a month practitioners call stable, so expect it to lurch — that second figure is a widely repeated convention rather than anything the platform publishes`);
    } else {
      verdict = "stable";
      lines.push(`Over the ${TARGET_STRATEGY_STABLE_CONVERSIONS_30D} a month practitioners call stable for a target-cost strategy; a target-return one is usually put at ${TARGET_ROAS_STABLE_CONVERSIONS_30D} — both conventions rather than published figures`);
    }
  }

  if (lag.medianDays != null) {
    lines.push(`Half this campaign's conversions arrive within ${lag.medianDays} day(s) of the click, and ${Math.round((lag.shareWithinUsefulWindow ?? 0) * 100)}% within ${USEFUL_CONVERSION_LAG_DAYS} — a bucketed figure, so it is the top of the bucket the middle conversion falls in rather than a true median`);
  } else {
    lines.push(lag.unread[0] ? `${lag.unread[0]!.charAt(0).toUpperCase()}${lag.unread[0]!.slice(1)}` : "No lag reading was taken.");
  }
  if (lagTooLong) {
    blockers.push(`Half of them arrive more than ${USEFUL_CONVERSION_LAG_DAYS} days after the click. Volume alone does not fix that: a signal this late shapes budget that has already been spent.`);
  }

  const countIsReal = verdict === "below_minimum" || verdict === "above_minimum" || verdict === "stable";
  const clearsVolume = verdict === "above_minimum" || verdict === "stable";
  const mayProposeBidTarget = clearsVolume && lagTooLong !== true;
  // A budget step is only gated where it would DO something to learning: a
  // campaign on a target strategy re-enters learning on a move of roughly a
  // fifth or more, and re-entering learning on a campaign whose signal is
  // already short of the minimum is the reset that costs the account with
  // nothing to show. A campaign on no target strategy is not learning, and
  // budget is the ordinary lever that gets a small account to the minimum in
  // the first place — gating it there would be a rule that fires on every
  // small account and stops the work that would fix it.
  const mayProposeBudgetStep = !(onTarget === true && (verdict === "below_minimum" || verdict === "column_unreadable"));
  if (!mayProposeBudgetStep) {
    blockers.push("A budget move of a fifth or more re-enters the learning period on a target-based strategy, and this campaign does not have the conversions to come out of it.");
  }

  return {
    campaignId: f.campaignId,
    campaignName: f.campaignName,
    verdict,
    conversions30d: countIsReal ? f.conversions30d : null,
    shortBy,
    strategyType: f.strategyType,
    onTargetStrategy: onTarget,
    lag,
    lagTooLong,
    mayProposeBidTarget,
    mayProposeBudgetStep,
    blockers,
    lines,
    metrics: {
      conversions30d: countIsReal ? (f.conversions30d ?? 0) : 0,
      minimumConversions30d: TARGET_STRATEGY_MIN_CONVERSIONS_30D,
      costMicros: f.costMicros30d,
      ...(shortBy != null ? { shortByConversions: shortBy } : {}),
      ...(lag.medianDays != null ? { medianLagDays: lag.medianDays } : {}),
      ...(lag.shareWithinUsefulWindow != null ? { shareWithinUsefulLagWindow: lag.shareWithinUsefulWindow } : {}),
    },
  };
}

/**
 * What this campaign would need before a target-based strategy could work.
 *
 * Every line is something somebody can do, and none of them is "spend more" on
 * its own. They are the published low-volume playbook: fewer campaigns holding
 * more conversions each, a portfolio strategy so several campaigns learn from
 * one pooled signal, a shallower primary action that happens often enough and
 * soon enough, and — the one that is always available — a strategy that does
 * not need a target at all.
 */
export function whatItWouldNeed(r: BiddingReadiness): string[] {
  const out: string[] = [];
  if (r.shortBy != null) {
    out.push(`About ${r.shortBy} more conversion(s) a month in THIS campaign, not in the account. Merging it with a campaign covering the same ground is usually the fastest way there, because two campaigns at eight conversions each are one campaign at sixteen.`);
    out.push("A portfolio bid strategy pools several campaigns into one learning signal, so campaigns that each fall short can clear the bar together.");
  }
  if (r.lagTooLong) {
    out.push(`A primary conversion action that happens within about ${USEFUL_CONVERSION_LAG_DAYS} days of the click. An outcome that lands weeks later is shaping budget that has already gone, however many of them there are.`);
  }
  if (r.verdict === "column_unreadable" || r.verdict === "unread") {
    out.push("The conversion column settled first. Nothing about bidding can be decided from a count nobody can read.");
  }
  if (r.onTargetStrategy === true) {
    out.push("Until one of those is true, a strategy with no target to hit — the platform's own recommendation under this volume — costs nothing to move to and does not re-enter learning every time the target is touched.");
  }
  return out;
}

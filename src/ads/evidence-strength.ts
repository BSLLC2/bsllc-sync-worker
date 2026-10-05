/**
 * Is there enough behind a finding to act on it? (2026-10-05)
 *
 * Pure. Numbers in, a verdict and one sentence out, in the style of
 * `bid-target.ts` and `spend-visibility.ts` next door.
 *
 * WHERE THIS COMES FROM. A person who actually ran the OCH account worked down
 * the queue of 15 rows and declined most of them, each for a reason the engine
 * had enough numbers to see and did not use:
 *
 *   • "Hold the bid-target change. The campaign runs max clicks, and a $150 CPA
 *     target needs roughly 15 or more conversions a month to work."
 *   • "Leave 'reman diesel engines' alone. 30 clicks and no conversions is too
 *     thin to pause on."
 *   • "Not added as negatives: 'medicaid alcohol rehab', 'recovery centers'":
 *     one click each, and both core searches.
 *   • "Branded rose to $57.94 per conversion ... normal swing at 13
 *     conversions a month."
 *   • "The budget raise is only 5 days old, so it's too early to judge."
 *     (That one is already said, by `change-window.ts`.)
 *
 * So the engine now asks of its own evidence what that person asked by hand:
 * is this enough clicks to call a keyword dead, is this enough conversions for
 * a target to steer on, and is this gap bigger than the sampling noise on the
 * number it is measured from.
 *
 * EVERY LINE HERE IS OURS OR A PUBLISHED CONVENTION, AND SAYS WHICH.
 *   • TARGET_MIN_CONVERSIONS (15) is the figure Google's own guidance gives for
 *     an automated cost target to have something to learn from. A convention,
 *     not a law.
 *   • ZERO_CHANCE_MAX (5%) and NOISE_Z (the 80% band) are ours.
 *
 * WHAT THIS NEVER DOES. It never raises a row, never closes one and never
 * touches a threshold that decides whether a campaign is in scope. It only
 * (a) withholds a row whose evidence is below the line, naming the line in the
 * run's own output, (b) holds ONE recommendation back and says what would
 * release it, and (c) adds a sentence where a gap sits inside the noise. A row
 * held back for thin evidence comes back by itself the day the clicks pass the
 * line, so nothing is hidden for good.
 *
 * A null is unanswered. A campaign with no clicks has no conversion rate, so a
 * keyword under it is "cannot tell", which is held, never "dead".
 */

/** Conversions in 30 days an automated cost target needs before it can steer.
 *  Google's own published guidance. */
export const TARGET_MIN_CONVERSIONS = 15;
/** A keyword is called dead only when the chance of this many clicks producing
 *  nothing, at the campaign's own conversion rate, is at most this. Ours. */
export const ZERO_CHANCE_MAX = 0.05;
/** One click is one person. Two is the least that can be called a pattern. Ours. */
export const MIN_CLICKS_FOR_WASTED_TERM = 2;
/** z for an 80% band on a count. Ours. */
export const NOISE_Z = 1.28;

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ── A keyword that "converted nothing" ──────────────────────────────────────

export interface KeywordZeroFacts {
  clicks: number;
  campaignClicks: number;
  campaignConversions: number;
}
export interface KeywordZeroReading {
  /** Enough clicks, against this campaign's own rate, to call it dead. */
  enough: boolean;
  /** The campaign's conversion rate, or null with no clicks to measure it from. */
  campaignRate: number | null;
  /** Chance of this many clicks and no conversion, if the keyword were as good
   *  as the campaign's average. Null where the rate is unknown. */
  chanceOfNothing: number | null;
  /** Clicks at which the chance falls to ZERO_CHANCE_MAX. Null where unknown. */
  clicksNeeded: number | null;
  line: string;
}

export function keywordZeroReading(f: KeywordZeroFacts): KeywordZeroReading {
  if (!(f.campaignClicks > 0) || !(f.campaignConversions > 0)) {
    return {
      enough: false, campaignRate: null, chanceOfNothing: null, clicksNeeded: null,
      line: "The campaign has no conversion rate to hold this keyword against, so it cannot be called dead yet.",
    };
  }
  const rate = Math.min(1, f.campaignConversions / f.campaignClicks);
  if (rate >= 1) {
    return { enough: f.clicks >= 1, campaignRate: 1, chanceOfNothing: 0, clicksNeeded: 1, line: "Every click on this campaign converts, so none here is unusual." };
  }
  const chance = Math.pow(1 - rate, f.clicks);
  const needed = Math.ceil(Math.log(ZERO_CHANCE_MAX) / Math.log(1 - rate));
  const enough = chance <= ZERO_CHANCE_MAX;
  const line = enough
    ? `At this campaign's own conversion rate (${pct(rate)}), ${plural(f.clicks, "click")} with no conversion happens by chance about ${pct(chance)} of the time. The ${pct(ZERO_CHANCE_MAX)} line is ours.`
    : `At this campaign's own conversion rate (${pct(rate)}), ${plural(f.clicks, "click")} with no conversion happens by chance about ${pct(chance)} of the time, and it takes about ${needed} to be sure. The ${pct(ZERO_CHANCE_MAX)} line is ours.`;
  return { enough, campaignRate: rate, chanceOfNothing: chance, clicksNeeded: needed, line };
}

// ── Is a cost target worth setting yet ──────────────────────────────────────

export interface TargetReadyFacts {
  /** Conversions in the 30-day pull. */
  conversions: number;
  /** False where the conversion column cannot be trusted (tracking is broken or
   *  silent), so a target would be steering on a number that is not there. */
  trackingTrusted: boolean;
}
export interface TargetReadyReading {
  ready: boolean;
  line: string | null;
}

export function targetReadiness(f: TargetReadyFacts): TargetReadyReading {
  if (!f.trackingTrusted) {
    return {
      ready: false,
      line: "A cost target is held back: conversion tracking is not trusted on this account, and a target would steer on a number that is not there. Fix the tracking, then set it.",
    };
  }
  if (f.conversions < TARGET_MIN_CONVERSIONS) {
    return {
      ready: false,
      line: `A cost target is held back: it needs about ${TARGET_MIN_CONVERSIONS} conversions a month to have anything to learn from, and this campaign has ${f.conversions % 1 === 0 ? f.conversions : f.conversions.toFixed(1)}. That figure is Google's own guidance, and it is a convention, not a law.`,
    };
  }
  return { ready: true, line: null };
}

// ── Is a gap bigger than the noise on the figure it is measured from ────────

export interface GapNoiseFacts {
  costPerConversionCents: number;
  targetCents: number;
  conversions: number;
}
export interface GapNoiseReading {
  /** How far over target, as a share of the target. */
  gapShare: number;
  /** Half-width of an 80% band on a cost per conversion built from this many conversions. */
  bandShare: number;
  withinNoise: boolean;
  line: string | null;
}

/**
 * A cost per conversion is spend divided by a COUNT, and a count of n moves by
 * about 1/sqrt(n) of itself on chance alone. With 13 conversions that is about
 * 35% at the 80% level, so a campaign 26% over its target has not been shown to
 * be over it. Spend is treated as exact: it is a sum of charged clicks, and the
 * count is the part that swings.
 */
export function gapAgainstNoise(f: GapNoiseFacts): GapNoiseReading | null {
  if (!(f.conversions >= 1) || !(f.targetCents > 0) || !(f.costPerConversionCents > 0)) return null;
  const gapShare = (f.costPerConversionCents - f.targetCents) / f.targetCents;
  const bandShare = NOISE_Z / Math.sqrt(f.conversions);
  const withinNoise = gapShare > 0 && gapShare <= bandShare;
  const n = f.conversions % 1 === 0 ? String(f.conversions) : f.conversions.toFixed(1);
  const line = withinNoise
    ? `${n} conversions a month moves a cost per conversion by about ${pct(bandShare)} on chance alone, and this is ${pct(gapShare)} over, so it is inside the noise. Read the next month before acting on the gap.`
    : null;
  return { gapShare, bandShare, withinNoise, line };
}

// ── One click is not a pattern ──────────────────────────────────────────────

export function termHasEnoughClicks(clicks: number): boolean {
  return clicks >= MIN_CLICKS_FOR_WASTED_TERM;
}

/**
 * When did the conversion column go quiet, and may the platform be told to
 * ignore those days?
 *
 * Pure. Facts in, one reading out.
 *
 * ── WHY A DATE RANGE IS THE WHOLE POINT ───────────────────────────────────
 *
 * `trackingReading` in rules.ts answers whether the conversion column may be
 * read. It does not answer WHEN it stopped, and without that the platform
 * cannot be told anything. Google ships a control for exactly this case —
 * a data exclusion, which tells Smart Bidding to ignore conversion data over a
 * stated date range — and until this module nothing in this system knew it
 * existed. Meanwhile a broken tag does not make the bidding stop: it makes it
 * carry on learning from false noughts, which is worse than no optimisation.
 *
 * ── WHAT THE PLATFORM REQUIRES, AND WHAT IT REFUSES ───────────────────────
 *
 * Confirmed for this change from Google's own API guide and help pages
 * (`developers.google.com/google-ads/api/docs/campaigns/bidding/data-exclusions`,
 * `support.google.com/google-ads/answer/10370710` and `/10276486`). BOTH
 * DOMAINS ARE BLOCKED BY THIS SANDBOX'S EGRESS POLICY, so these were
 * triangulated through search rather than read, and the ones that bound this
 * module's behaviour are the ones stated as limits rather than advice:
 *
 *   - `name`, `start_date_time`, `end_date_time` and `scope` are required.
 *     `scope` is CAMPAIGN (with a list of campaign resource names) or CHANNEL
 *     (with a list of channel types). `devices` is optional.
 *   - A DATA EXCLUSION MAY COVER AT MOST 14 DAYS. This is the hard one, and it
 *     is why a long outage is refused here rather than truncated: an exclusion
 *     covering the last fortnight of a two-month outage leaves six weeks of
 *     false noughts in the model and reads on the screen as though the problem
 *     were handled.
 *   - It is for outages, not for ordinary weeks. Google's own wording is that
 *     frequent or prolonged use can harm Smart Bidding performance.
 *   - Google advises covering at least 90% of the clicks whose conversion data
 *     was affected, and — where conversions normally arrive days after the
 *     click — extending the range a little BEFORE the outage began.
 *   - Hotel and Travel campaigns do not support it, and an account may hold at
 *     most 500 active exclusions.
 *
 * ── WHY THIS DOES NOT PAD THE RANGE FOR CONVERSION DELAY ──────────────────
 *
 * The advice to extend backwards is real and this module deliberately does not
 * follow it automatically. Padding backwards excludes days on which the column
 * WAS working, and those days' conversions are true — throwing them away to
 * catch a few late arrivals spends real signal on an account that is usually
 * short of it. The lag figure from `bidding-readiness.ts` is put in the
 * proposal's own words instead, so the person approving it can widen the range
 * by hand in the account where their own lag says to.
 */

/** Google's documented ceiling on one data exclusion. */
export const MAX_DATA_EXCLUSION_DAYS = 14;

/**
 * Days of working tracking needed before a run of noughts is read as a break
 * rather than as how the account has always looked.
 *
 * A week, because the argument the exclusion rests on is "this account used to
 * record conversions and then stopped", and a two-day baseline cannot carry it.
 */
export const MIN_BASELINE_DAYS = 7;

/** …and conversions in that baseline, for the same reason. Five rather than
 *  one: a single conversion in a fortnight makes every quiet day look broken. */
export const MIN_BASELINE_CONVERSIONS = 5;

/**
 * How many conversions the quiet run must have SWALLOWED, at the account's own
 * pre-break rate, before it is a break at all.
 *
 * Three. A campaign converting at 3% that takes 30 clicks over a quiet weekend
 * expected about one conversion, and one missing conversion is a quiet weekend
 * rather than a broken tag. This is our line, not a published one, and it is
 * measured against the ACCOUNT'S OWN rate rather than against a fixed number —
 * which is what keeps it from firing on every small account.
 */
export const MIN_EXPECTED_MISSING = 3;

/**
 * How recently the quiet run must have ended for an exclusion to be worth
 * proposing.
 *
 * Thirty days. Smart Bidding's own learning is measured in weeks, so a
 * fortnight of bad data from three months ago has already been ground through
 * and excluding it now buys little while still spending one of the account's
 * 500 exclusion slots. Ours, and said to be ours.
 */
export const EXCLUSION_WORTH_IT_WITHIN_DAYS = 30;

export interface DailyConversionRow {
  /** YYYY-MM-DD. */
  date: string;
  clicks: number;
  conversions: number;
  costMicros: number;
}

export type OutageVerdict =
  /** A break with a start, an end and a baseline behind it. */
  | "found"
  /** Nothing looks like a break. */
  | "none"
  /** The column is quiet across the whole window, so there is no before. */
  | "no_baseline"
  /** The daily series was not read. */
  | "unread";

export interface TrackingOutage {
  verdict: OutageVerdict;
  /** Inclusive YYYY-MM-DD bounds of the quiet run. Null unless found. */
  startDate: string | null;
  endDate: string | null;
  days: number;
  clicksInRun: number;
  costMicrosInRun: number;
  /** Conversions the run would have recorded at the pre-break rate. */
  expectedConversions: number;
  baselineConvPerClick: number;
  baselineDays: number;
  /** Is the run still open at the end of the series? */
  ongoing: boolean;
  /** Can this be expressed as one data exclusion the platform would accept? */
  exclusionExpressible: boolean;
  /** Why not, where it cannot. Null where it can. */
  refusal: string | null;
  lines: string[];
  metrics: Record<string, number>;
}

const EMPTY = {
  startDate: null, endDate: null, days: 0, clicksInRun: 0, costMicrosInRun: 0,
  expectedConversions: 0, baselineConvPerClick: 0, baselineDays: 0, ongoing: false,
  exclusionExpressible: false,
};

const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Pure. Find the most recent stretch on which the conversion column went quiet
 * while the account carried on buying clicks.
 *
 * Deliberately ONE run — the most recent one — rather than every run it can
 * find. A list of six historic quiet weekends is not something anybody acts
 * on, and each exclusion proposed is a slot spent and a range of real data
 * discarded if it is wrong.
 */
export function findTrackingOutage(series: DailyConversionRow[] | null | undefined): TrackingOutage {
  if (series == null) {
    return {
      ...EMPTY, verdict: "unread", refusal: null,
      lines: ["The day-by-day conversion series was not read, so nothing here can say when this account's column went quiet."],
      metrics: {},
    };
  }
  const rows = [...series].filter((r) => r && typeof r.date === "string" && r.date.length === 10)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length === 0) {
    return { ...EMPTY, verdict: "unread", refusal: null, lines: ["The day-by-day conversion series came back empty."], metrics: {} };
  }

  // Walk back from the newest day over the run of noughts, then keep walking
  // back over the healthy days behind it to build the baseline.
  let end = rows.length - 1;
  while (end >= 0 && rows[end]!.clicks === 0 && rows[end]!.conversions === 0) end--; // ignore trailing dead days
  if (end < 0) {
    return { ...EMPTY, verdict: "no_baseline", refusal: null, lines: ["No day in the window took a click, so there is nothing to compare."], metrics: {} };
  }
  if (rows[end]!.conversions > 0) {
    return {
      ...EMPTY, verdict: "none", refusal: null,
      lines: [`The conversion column recorded something on ${rows[end]!.date}, the most recent day with traffic.`],
      metrics: {},
    };
  }
  let start = end;
  while (start - 1 >= 0 && rows[start - 1]!.conversions === 0) start--;

  const run = rows.slice(start, end + 1);
  const before = rows.slice(0, start);
  const baselineClicks = before.reduce((s, r) => s + r.clicks, 0);
  const baselineConversions = before.reduce((s, r) => s + r.conversions, 0);
  const baselineDays = before.length;

  const clicksInRun = run.reduce((s, r) => s + r.clicks, 0);
  const costMicrosInRun = run.reduce((s, r) => s + r.costMicros, 0);
  const startDate = run[0]!.date;
  const endDate = run[run.length - 1]!.date;
  const days = run.length;
  const ongoing = end === rows.length - 1;

  if (baselineDays < MIN_BASELINE_DAYS || baselineConversions < MIN_BASELINE_CONVERSIONS) {
    return {
      ...EMPTY, verdict: "no_baseline", refusal: null,
      startDate, endDate, days, clicksInRun, costMicrosInRun, ongoing,
      baselineDays, baselineConvPerClick: 0, expectedConversions: 0,
      lines: [
        `The column has recorded nothing since ${startDate}, and the ${baselineDays} day(s) before that hold ${baselineConversions.toFixed(0)} conversion(s) between them.`,
        "There is no stretch of working tracking in this window to compare against, so nothing here can say when it broke — only that it is not recording now.",
      ],
      metrics: { quietDays: days, clicksInRun, costMicrosInRun, baselineDays, baselineConversions },
    };
  }

  const baselineConvPerClick = baselineClicks > 0 ? baselineConversions / baselineClicks : 0;
  const expectedConversions = baselineConvPerClick * clicksInRun;
  const lines = [
    `Quiet from ${startDate} to ${endDate} (${days} day${days === 1 ? "" : "s"}${ongoing ? ", still quiet" : ""}): ${clicksInRun} clicks, no conversion recorded on any of them.`,
    `The ${baselineDays} days before it recorded ${baselineConversions.toFixed(0)} conversion(s) on ${baselineClicks} clicks, so those ${clicksInRun} clicks should have produced about ${expectedConversions.toFixed(1)}.`,
  ];
  const metrics = {
    quietDays: days, clicksInRun, costMicrosInRun,
    expectedMissingConversions: expectedConversions,
    baselineDays, baselineConversions, baselineConvPerClick,
  };

  if (expectedConversions < MIN_EXPECTED_MISSING) {
    return {
      ...EMPTY, verdict: "none", refusal: null,
      startDate, endDate, days, clicksInRun, costMicrosInRun, ongoing,
      baselineConvPerClick, baselineDays, expectedConversions,
      lines: [...lines, `That is under the ${MIN_EXPECTED_MISSING} missing conversions this reading needs before calling a quiet stretch a break rather than a quiet stretch.`],
      metrics,
    };
  }

  const endedDaysAgo = dayDiff(endDate, rows[rows.length - 1]!.date);
  let refusal: string | null = null;
  if (days > MAX_DATA_EXCLUSION_DAYS) {
    refusal = `This has been quiet for ${days} days and one data exclusion may cover at most ${MAX_DATA_EXCLUSION_DAYS}. Excluding the last fortnight of it would leave the rest of the false noughts in the model while the screen read as though it had been handled, so nothing is proposed here — fix the tag, and the days after the fix are the ones worth excluding.`;
  } else if (endedDaysAgo > EXCLUSION_WORTH_IT_WITHIN_DAYS) {
    refusal = `This break ended ${endedDaysAgo} days ago. Bidding has already learned its way through it, so an exclusion now spends one of the account's slots and discards a fortnight of real history for very little.`;
  }

  return {
    verdict: "found",
    startDate, endDate, days, clicksInRun, costMicrosInRun,
    expectedConversions, baselineConvPerClick, baselineDays, ongoing,
    exclusionExpressible: refusal == null,
    refusal,
    lines: refusal ? [...lines, refusal] : lines,
    metrics,
  };
}

/** One campaign the exclusion would be scoped to. */
export interface ExclusionCampaign {
  id: string;
  name: string;
  /** The platform's own resource name. Null = not read, which refuses it. */
  resourceName: string | null;
  /** Is this campaign on a strategy a data exclusion affects at all? */
  smartBidding: boolean;
}

export interface DataExclusionProposal {
  /** The exact body the guarded apply path takes. */
  body: {
    name: string;
    startDateTime: string;
    endDateTime: string;
    campaigns: string[];
    campaignNames: string[];
    /** What the daily series said was in this range when this was worked out.
     *  The apply path re-reads it and refuses if it has moved. */
    observedConversionsInRange: number;
    reason: string;
  };
  plainEnglish: string;
  guard: string;
}

/** `start_date_time` / `end_date_time` are "yyyy-MM-dd HH:mm:ss" local to the
 *  account. Midnight to the last second, so the range covers whole days. */
const startOfDay = (d: string) => `${d} 00:00:00`;
const endOfDay = (d: string) => `${d} 23:59:59`;

/**
 * Turn a found outage into the proposal, or say why there is none.
 *
 * Returns null wherever the change must not be offered — a refused outage, or
 * an account where no campaign is on a strategy an exclusion would affect. A
 * data exclusion on an account bidding manually changes nothing at all, and
 * offering one would be a button that does nothing.
 */
export function dataExclusionProposal(
  outage: TrackingOutage,
  campaigns: ExclusionCampaign[],
  opts: { accountLabel: string; lagLine: string | null },
): DataExclusionProposal | null {
  if (outage.verdict !== "found" || !outage.exclusionExpressible) return null;
  if (!outage.startDate || !outage.endDate) return null;

  const scoped = campaigns.filter((c) => c.smartBidding && c.resourceName);
  if (scoped.length === 0) return null;

  const names = scoped.map((c) => c.name);
  const reason = `Conversion tracking recorded nothing from ${outage.startDate} to ${outage.endDate} while the account took ${outage.clicksInRun} clicks, about ${outage.expectedConversions.toFixed(1)} conversions short of its own pre-break rate.`;

  return {
    body: {
      // The date range is in the name on purpose: an account may hold several
      // of these and a list of exclusions all called the same thing is a list
      // nobody can read.
      name: `BS LLC — conversion tracking outage ${outage.startDate} to ${outage.endDate}`,
      startDateTime: startOfDay(outage.startDate),
      endDateTime: endOfDay(outage.endDate),
      campaigns: scoped.map((c) => c.resourceName as string),
      campaignNames: names,
      observedConversionsInRange: 0,
      reason,
    },
    plainEnglish:
      `Tell ${opts.accountLabel} to ignore conversion data from ${outage.startDate} to ${outage.endDate} when bidding, on ${scoped.length} campaign(s): ${names.join(", ")}. `
      + `Nothing about the account's spend, targeting or ads changes — only which days the bidding model is allowed to learn from. `
      + `The tag itself is still broken and fixing it is a separate job.`
      + (opts.lagLine ? ` ${opts.lagLine}` : ""),
    guard:
      `Data exclusion guard: the range must already be in the past and must be ${MAX_DATA_EXCLUSION_DAYS} days or fewer, which is the platform's own ceiling. `
      + `Before it is written the account is re-read over those exact dates, and if any conversion has since landed in them the change is refused — conversions arrive days after the click, and excluding a range that has filled in throws real signal away. `
      + `An overlapping exclusion already on the account is skipped rather than duplicated, every campaign is re-resolved by resource name and skipped if it is no longer live, and the created exclusion's own resource name is recorded so removing it is one step.`,
  };
}

/**
 * What a person should set by hand where the write is refused or unavailable.
 *
 * Written for whoever holds the account rather than for this system: it names
 * the control, the dates and the one thing about it that is easy to get wrong.
 */
export function manualExclusionInstruction(outage: TrackingOutage): string[] {
  if (outage.verdict !== "found" || !outage.startDate || !outage.endDate) return [];
  const out = [
    `In the account, under Bidding, add a data exclusion covering ${outage.startDate} to ${outage.endDate} so the bidding model stops learning from those days.`,
    `Scope it to the campaigns that bid on conversions. A campaign bidding manually is unaffected either way, and an exclusion left on the whole account outlives the outage it was for.`,
  ];
  if (outage.days > MAX_DATA_EXCLUSION_DAYS) {
    out.push(`This break runs to ${outage.days} days and one exclusion may cover at most ${MAX_DATA_EXCLUSION_DAYS}. Fix the tag first: excluding a fortnight of a ${outage.days}-day outage leaves the rest of it in the model and looks from the outside like the problem was dealt with.`);
  }
  return out;
}

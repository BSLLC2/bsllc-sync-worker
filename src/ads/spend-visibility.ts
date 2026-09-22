/**
 * How much of a campaign's money the search-terms report actually shows.
 *
 * Pure. Facts in, one reading out.
 *
 * ── THE PROBLEM THIS NAMES ────────────────────────────────────────────────
 *
 * Google withholds search terms that too few people searched, for privacy. The
 * queries are still matched and the clicks are still charged; they just never
 * appear in the report. So `wasted_search_term` — this engine's highest-count
 * rule — selects over an unknown fraction of the spend and then states a dollar
 * saving as though it had seen all of it.
 *
 * Published estimates of the hidden share are wide and each one is single-
 * sourced: roughly 11% of clicks at the benign end, 20–29% of cost in one
 * longitudinal account study, and as much as 85% of spend on individual
 * keywords. Those are not three measurements of one quantity and they must not
 * be averaged into one. NONE OF THEM IS USED AS A NUMBER HERE. What is used is
 * the account's own arithmetic: the spend the report shows, against the spend
 * the campaign actually took. That is a measurement rather than a citation, and
 * it is different on every campaign.
 *
 * ── WHAT A LOW COVERAGE DOES AND DOES NOT MEAN ────────────────────────────
 *
 * The privacy threshold is one cause and it is not the only one. Search
 * partners, display expansion on a search campaign, and the parts of a
 * Performance Max or Shopping campaign that never had a query all put spend
 * outside the report. So the reading says the share and names the possible
 * causes rather than asserting the privacy threshold — asserting a cause we
 * cannot see would be the same failure one level along.
 *
 * Campaigns with no search-terms report at all (Display, Video, Demand Gen)
 * are NOT low-coverage. They are a different kind of campaign and the reading
 * says `not_applicable` rather than producing a nought that reads as a defect.
 */

/** Channel types that have a search-terms report worth measuring against. */
const SEARCHING_CHANNELS = new Set(["SEARCH", "SHOPPING", "PERFORMANCE_MAX", "MULTI_CHANNEL"]);
/** Not a kind of campaign — the platform declining to say which kind it is. */
const UNREAD_CHANNELS = new Set(["UNSPECIFIED", "UNKNOWN"]);

/**
 * Below this share of a campaign's spend showing up in the report, a finding
 * built on that report is reasoning over a minority of the money and has to
 * say so in its own words.
 *
 * Two thirds, and the reason is arithmetic rather than a citation: at 67% the
 * unseen third is already large enough that the biggest unseen query could
 * outspend the biggest seen one, so a ranked list of waste stops being a
 * ranking. It is OUR line and every sentence that leans on it says so.
 */
export const LOW_COVERAGE_SHARE = 0.67;

/**
 * Below this, the report is showing so little that a dollar figure off it is
 * not a claim worth printing. Also ours.
 */
export const BARELY_COVERED_SHARE = 0.35;

/** Campaign spend must reach this before a coverage share means anything —
 *  a campaign that took four dollars can read at 0% coverage on one rounding. */
export const COVERAGE_MIN_SPEND_MICROS = 10_000_000; // $10 over the window

export interface CampaignSpendVisibility {
  campaignId: string;
  campaignName: string;
  /** Spend the search-terms report accounts for, over the SAME window as the
   *  campaign figure beside it. Null = the report was not read. */
  reportedTermCostMicros: number | null;
  campaignCostMicros: number;
  channelType: string | null;
}

export type CoverageVerdict = "covered" | "partial" | "barely" | "not_applicable" | "unread" | "too_small";

export interface SpendVisibility {
  campaignId: string;
  verdict: CoverageVerdict;
  /** 0–1. Null on every verdict but covered / partial / barely. */
  share: number | null;
  unseenMicros: number | null;
  /** One clause for the evidence list. Always present. */
  line: string;
  /** One clause for an impact assumption, naming what the figure did not see.
   *  Null where the reading has nothing to qualify. */
  caveat: string | null;
  metrics: Record<string, number>;
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Pure. One campaign's answer.
 *
 * The two spend figures MUST come from the same window or the share is
 * meaningless — the caller is responsible for that and the adapter reads them
 * together for exactly this reason.
 */
export function spendVisibility(v: CampaignSpendVisibility): SpendVisibility {
  const channel = String(v.channelType ?? "").toUpperCase();
  const base = { campaignId: v.campaignId, share: null, unseenMicros: null };

  // The platform's own words for "I did not say". They are NOT a channel that
  // happens to have no search-terms report — they are an unread field, and
  // reading them as not-applicable switches this check off in silence, which
  // is exactly what an undecoded enum did before the adapter decoded one.
  if (channel && !UNREAD_CHANNELS.has(channel) && !SEARCHING_CHANNELS.has(channel)) {
    return {
      ...base, verdict: "not_applicable",
      line: `No search-terms report exists for a ${channel.toLowerCase().replace(/_/g, " ")} campaign, so there is no coverage to measure here.`,
      caveat: null,
      metrics: {},
    };
  }
  if (v.reportedTermCostMicros == null) {
    return {
      ...base, verdict: "unread",
      line: "The search-terms report was not read for this campaign, so nothing here can say what share of its spend a query-based finding looked at.",
      caveat: "No share is stated: the search-terms report could not be read for this campaign, so what fraction of the spend this looked at is unknown.",
      metrics: {},
    };
  }
  if (v.campaignCostMicros < COVERAGE_MIN_SPEND_MICROS) {
    return {
      ...base, verdict: "too_small",
      line: `${usd(v.campaignCostMicros)} over the window is too little for a coverage share to mean anything.`,
      caveat: null,
      metrics: { campaignCostMicros: v.campaignCostMicros },
    };
  }

  // Clamped at 1. The two figures come from two resources and Google's own
  // rounding can put the terms a shade over the campaign; reporting 103%
  // coverage would be a number nobody can act on.
  const share = Math.min(1, v.reportedTermCostMicros / v.campaignCostMicros);
  const unseen = Math.max(0, v.campaignCostMicros - v.reportedTermCostMicros);
  const metrics = {
    searchTermCostMicros: v.reportedTermCostMicros,
    campaignCostMicros: v.campaignCostMicros,
    searchTermCoverageShare: share,
    unseenSpendMicros: unseen,
  };

  if (share >= LOW_COVERAGE_SHARE) {
    return {
      ...base, verdict: "covered", share, unseenMicros: unseen,
      line: `The search-terms report accounts for ${pct(share)} of this campaign's ${usd(v.campaignCostMicros)}; ${usd(unseen)} of it never appears as a query.`,
      caveat: `${pct(share)} of the campaign's spend appears in the search-terms report. The remaining ${usd(unseen)} is spend on queries this figure never saw.`,
      metrics,
    };
  }
  const causes = "Queries too few people searched are withheld for privacy, search partners and display expansion are charged outside the report, and on a Performance Max campaign much of the spend never had a query at all.";
  if (share >= BARELY_COVERED_SHARE) {
    return {
      ...base, verdict: "partial", share, unseenMicros: unseen,
      line: `Only ${pct(share)} of this campaign's ${usd(v.campaignCostMicros)} shows up as a search term. ${causes}`,
      caveat: `Worked out over ${pct(share)} of the campaign's spend. ${usd(unseen)} went on queries the report does not show, so this is a floor on what is there rather than the whole of it.`,
      metrics,
    };
  }
  return {
    ...base, verdict: "barely", share, unseenMicros: unseen,
    line: `${pct(share)} of this campaign's ${usd(v.campaignCostMicros)} shows up as a search term — ${usd(unseen)} of it is spent on queries nothing here can name. ${causes}`,
    caveat: `Most of this campaign's money is invisible to the report this was worked out from: ${pct(share)} of ${usd(v.campaignCostMicros)}. Read the figure as the small visible corner of the spend, not as what the campaign is wasting.`,
    metrics,
  };
}

/** True where a query-based dollar figure has to be qualified on the row that
 *  carries it. `covered` still carries its caveat — a fifth of the spend
 *  unseen is worth one clause — but only these two change the sentence. */
export function coverageChangesTheClaim(s: SpendVisibility): boolean {
  return s.verdict === "partial" || s.verdict === "barely" || s.verdict === "unread";
}

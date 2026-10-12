/**
 * Quality score, split by what Google says is wrong.
 *
 * ── THE DEFECT (2026-10-12) ────────────────────────────────────────────────
 *
 * `low_quality_score` was one row for the whole account: "81 keyword(s) carry a
 * quality score below 5", with a paragraph saying it was copy or a page. On a
 * Diesel Power Group account the three parts of that score told three
 * different stories, and the row hid them: landing page experience was below
 * average on 85 of 88 scored keywords, expected click-through on 73, and ad
 * relevance on almost none. Those are two different jobs for two different
 * people. A page rewrite is one, a headline rewrite is the other, and a single
 * row sent both to whoever picked it up.
 *
 * Google reports the three components on every scored keyword
 * (`quality_info.post_click_quality_score`, `search_predicted_ctr`,
 * `creative_quality_score`), each as BELOW_AVERAGE, AVERAGE or ABOVE_AVERAGE,
 * so nothing here is inferred. The split is read from what the platform said.
 *
 * ── RULES ──────────────────────────────────────────────────────────────────
 *
 *  - A NULL IS UNANSWERED. A component Google did not report is `null`, never
 *    "average" and never "below". UNKNOWN and UNSPECIFIED decode to null.
 *  - A COMPONENT ROW NEEDS `QS_COMPONENT_MIN_KEYWORDS` keywords, because one
 *    keyword with a below-average page is a keyword and not a pattern. Ours.
 *  - A KEYWORD CAN BE BELOW AVERAGE ON MORE THAN ONE COMPONENT and is listed
 *    under each. The rows are not a partition, and the sentences never add them.
 *  - THE OLD ACCOUNT ROW SURVIVES FOR WHAT IT STILL COVERS: a keyword under
 *    the floor that is in no raised component group (every component average
 *    or better, or not reported). With nothing read at all the old row is raised
 *    exactly as before.
 *  - COMPETITOR NAMES ARE SET ASIDE BEFORE THIS, as they were before it. The
 *    caller passes only the keywords the old row would have counted.
 *
 * Pure. Facts in, groups out.
 */

export type QsBucket = "below" | "average" | "above";
export type QsComponent = "landing_page" | "expected_ctr" | "ad_relevance";
export const QS_COMPONENTS: readonly QsComponent[] = ["landing_page", "expected_ctr", "ad_relevance"];

/** The number a finding's metrics carry, so the dashboard reads a recorded
 *  value and never a title. Numbers only, because metrics are numbers. */
export const QS_COMPONENT_CODE: Record<QsComponent, number> = { landing_page: 1, expected_ctr: 2, ad_relevance: 3 };
export const QS_COMPONENT_METRIC = "qsComponent";

export const QS_COMPONENT_LABEL: Record<QsComponent, string> = {
  landing_page: "Landing page experience",
  expected_ctr: "Expected click-through rate",
  ad_relevance: "Ad relevance",
};

/** Raise a component row at this many keywords. Ours. */
export const QS_COMPONENT_MIN_KEYWORDS = 3;

/** Google's QualityScoreBucket, as it arrives over REST (integers) or in the
 *  library's own words. UNSPECIFIED and UNKNOWN are not an answer. */
export function decodeQsBucket(v: unknown): QsBucket | null {
  if (v == null) return null;
  const raw = String(v).trim().toUpperCase();
  switch (raw) {
    case "2": case "BELOW_AVERAGE": return "below";
    case "3": case "AVERAGE": return "average";
    case "4": case "ABOVE_AVERAGE": return "above";
    default: return null;
  }
}

export interface QsKeywordFact {
  text: string;
  campaignName: string;
  /** 1 to 10, always present: only scored keywords come in. */
  score: number;
  costMicros: number | null;
  conversions: number | null;
  landingPage: QsBucket | null;
  expectedCtr: QsBucket | null;
  adRelevance: QsBucket | null;
}

export const qsBucketOf = (k: QsKeywordFact, c: QsComponent): QsBucket | null =>
  c === "landing_page" ? k.landingPage : c === "expected_ctr" ? k.expectedCtr : k.adRelevance;

export interface QsGroup { component: QsComponent; keywords: QsKeywordFact[] }

export interface QsSplit {
  /** False where no keyword reported any component: nothing can be split. */
  readable: boolean;
  /** Scored keywords the split was taken over. */
  scored: number;
  groups: QsGroup[];
  /** Keywords under the floor that are in no raised group. */
  remainder: QsKeywordFact[];
}

export function splitByComponent(scored: readonly QsKeywordFact[], floor: number): QsSplit {
  const readable = scored.some((k) => k.landingPage != null || k.expectedCtr != null || k.adRelevance != null);
  if (!readable) {
    return { readable: false, scored: scored.length, groups: [], remainder: scored.filter((k) => k.score < floor) };
  }
  const groups: QsGroup[] = [];
  for (const component of QS_COMPONENTS) {
    const keywords = scored.filter((k) => qsBucketOf(k, component) === "below");
    if (keywords.length >= QS_COMPONENT_MIN_KEYWORDS) groups.push({ component, keywords });
  }
  const covered = new Set<QsKeywordFact>();
  for (const g of groups) for (const k of g.keywords) covered.add(k);
  return {
    readable, scored: scored.length, groups,
    remainder: scored.filter((k) => k.score < floor && !covered.has(k)),
  };
}

/** What each component means and what the fix is, in the words of the work. */
export const QS_COMPONENT_SUMMARY: Record<QsComponent, string> = {
  landing_page:
    "Google rates the page these keywords send people to as below average for what was searched. That is a page problem: the words searched have to be on the page, near the top, "
    + "with one clear next step. It is not fixed in the ad account.",
  expected_ctr:
    "Google expects fewer clicks than average on the ad these keywords show. The fix is the ad wording, and how the keywords are grouped with the ads that run for them. A bid does not change it.",
  ad_relevance:
    "The ad does not match these keywords as closely as Google expects. The fix is ad wording that carries the words people search, in an ad group built around them.",
};

export const QS_COMPONENT_GUARD: Record<QsComponent, string> = {
  landing_page: "Nothing here is applied. A page is changed on the client's site, by a person; it is not a change to the ad account.",
  expected_ctr: "Ad copy is out of scope by policy — see the LegitScript note in the vendor brief.",
  ad_relevance: "Ad copy is out of scope by policy — see the LegitScript note in the vendor brief.",
};

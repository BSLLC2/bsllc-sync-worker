/**
 * The order to do a campaign's findings in.
 *
 * Pure. Findings in, the same findings out, reordered, each one carrying one
 * clause where it is waiting on another.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Every rule in `rules.ts` decides on its own and the module ends with
 * `sort((a, b) => b.estImpactCents - a.estImpactCents)`. Nothing has ever read
 * one campaign's findings together. The direct contradiction is already
 * prevented — a budget rise needs `converting && !overTarget &&
 * biddingAllowsBudget && zeroMeansZero` — but ORDER is not a contradiction and
 * was not checked at all, so a campaign can carry "raise the budget by 25%" and
 * "20 search terms burned $761 converting nothing" at once, ranked by size, and
 * doing them in that order funds the waste before stopping it.
 *
 * ── THE ORDER, AND WHY EACH STAGE IS WHERE IT IS ──────────────────────────
 *
 *  1. stop     — money going out for nothing. Cheap, reversible, immediate, and
 *                it changes the numbers every later stage is measured against.
 *  2. measure  — the conversion column, the bidding signal, what a lead is
 *                worth. Not cheap and not immediate, but everything after it is
 *                decided from figures it produces.
 *  3. improve  — relevance, quality, ad coverage, landing pages. The half of
 *                Ad Rank that costs nothing to test.
 *  4. grow     — more money, or a bid we are willing to pay more with. Last,
 *                because the first three change how much a pound buys.
 *
 * The fourth stage is not in the three the order is usually described with, and
 * it is there because the alternative is worse: a finding that is neither waste
 * nor measurement nor money — a low quality score, an ad group with one ad —
 * would otherwise land after "raise the budget", which is the same mistake this
 * pass exists to fix. `improve` sits where the work actually sits.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * NOTHING IS SUPPRESSED, RE-SEVERITIED OR RE-PRICED. A hidden row is worse than
 * a badly ordered one; a severity is the rules module's judgement about size and
 * this pass knows nothing about size; and `estImpactCents` carries a basis, so
 * nudging it to move a row up the queue would make a figure mean two things.
 *
 * NO SECOND STATUS VOCABULARY. `shared/task-live-state.ts`'s lesson: a badge on
 * every row flattens the only distinction that matters. A stage is not written
 * onto a finding, is not a field anything renders, and is not a word beside
 * "open" or "proposed". What a person reads is one ordinary English clause on
 * the rows that have something to wait for, and nothing at all on the rest.
 */

import type { DerivedFinding } from "./rules.js";

export const FINDING_STAGES = ["stop", "measure", "improve", "grow"] as const;
export type FindingStage = (typeof FINDING_STAGES)[number];

/**
 * Which stage each finding type belongs to.
 *
 * Declared per type rather than derived from anything on the row: a stage is a
 * statement about what the work IS, and inferring it from severity, risk or
 * whether a change payload exists would be three different answers that
 * disagree the first time a rule changes.
 */
export const FINDING_STAGE: Record<string, FindingStage> = {
  // Money leaving for nothing.
  wasted_search_term: "stop",
  dead_keyword: "stop",
  no_conversions: "stop",
  broken_final_url: "stop",
  cpa_above_target: "stop",

  // Figures everything else is decided from.
  conversion_tracking_gap: "measure",
  bidding_not_ready: "measure",
  bidding_data_exclusion: "measure",
  proxy_conversion_value: "measure",
  call_tracking_absent: "measure",
  outcome_feedback_gap: "measure",

  // Relevance and coverage.
  generic_landing_page: "improve",
  low_quality_score: "improve",
  thin_ad_group: "improve",
  weak_ad_strength: "improve",
  unused_asset: "improve",
  rank_limited: "improve",
  learning_limited: "improve",

  // More money, or a higher price per conversion.
  budget_limited: "grow",
  headroom: "grow",
  converting_search_term: "grow",
  keyword_gap: "grow",
};

/**
 * A type nobody has placed. `improve` rather than `grow`, because an
 * unclassified finding must not queue-jump waste-stopping and must not be
 * pushed past a budget rise either — the middle is the only position that is
 * wrong in neither direction.
 */
export const DEFAULT_STAGE: FindingStage = "improve";

export function stageOf(findingType: string): FindingStage {
  return FINDING_STAGE[findingType] ?? DEFAULT_STAGE;
}

const STAGE_INDEX: Record<FindingStage, number> =
  { stop: 0, measure: 1, improve: 2, grow: 3 };

/**
 * The clause a `grow` row carries when the same campaign is also waiting to
 * have money stopped or a figure fixed.
 *
 * ONE CLAUSE, and it names the thing rather than counting it — "after the 20
 * search terms burning $761" is actionable and "after 3 earlier items" is not.
 * It is appended to the finding's evidence lines, which are persisted on the
 * row and rendered verbatim, and NOT to the metrics, which are what
 * `evidenceHash` buckets: a sentence must never be able to resurrect a finding
 * a person dismissed.
 */
export const WAITING_LEAD = "Do this after ";

export function waitingClause(blocker: DerivedFinding): string {
  const stage = stageOf(blocker.findingType);
  const lead = stage === "stop"
    ? "Do this after the money going out for nothing is stopped"
    : "Do this after the figures this is judged on are right";
  return `${lead}: "${blocker.title}" is on this campaign and comes first.`;
}

/** Which campaign a finding is about, or null for an account-level row. */
function groupKey(f: DerivedFinding): string {
  return f.campaignId ?? "";
}

/**
 * Pure. The same findings, sequenced.
 *
 * Group order keeps what the old sort gave in shape and fixes what it gave in
 * substance: the group holding the biggest single figure comes first, but the
 * figure is now `rank.cents` (cents a month, the same unit on every row) rather
 * than `estImpactCents`, which since version 5 carried dollars on one row,
 * leads on another and nought on a third. A row this engine could not price
 * contributes nothing to its group's position and is neither sunk nor floated —
 * it keeps its group and its stage, so it is read with that campaign's work.
 *
 * Inside a group the stages decide, exactly as before. `rank.cents` breaks
 * ties within a stage, with `estImpactCents` behind it so two rows this
 * ranking cannot separate still order as they used to, and the original index
 * last — so the pass is stable and two runs over one account produce a
 * byte-identical order, which the determinism check depends on.
 */
export function sequenceFindings(findings: DerivedFinding[]): DerivedFinding[] {
  const groups = new Map<string, { index: number; rows: { f: DerivedFinding; i: number }[] }>();
  findings.forEach((f, i) => {
    const key = groupKey(f);
    const g = groups.get(key) ?? { index: groups.size, rows: [] };
    g.rows.push({ f, i });
    groups.set(key, g);
  });

  const out: DerivedFinding[] = [];
  /** The best comparable figure in a group. A row with no rank contributes
   *  nothing, which is what keeps an unpriced row from moving its group. */
  const best = (rows: { f: DerivedFinding }[]) =>
    Math.max(0, ...rows.map((r) => r.f.rank?.cents ?? 0));

  const ordered = Array.from(groups.entries()).sort((a, b) =>
    best(b[1].rows) - best(a[1].rows) || a[1].index - b[1].index);

  for (const [key, g] of ordered) {
    const rows = [...g.rows].sort((a, b) =>
      STAGE_INDEX[stageOf(a.f.findingType)] - STAGE_INDEX[stageOf(b.f.findingType)]
      || (b.f.rank?.cents ?? 0) - (a.f.rank?.cents ?? 0)
      || b.f.estImpactCents - a.f.estImpactCents
      || a.i - b.i);

    // An account-level row is not waiting on a campaign's work and has no
    // campaign whose work it could be waiting on, so the group is ordered and
    // left alone.
    const earlier = key
      ? rows.find(({ f }) => {
          const s = stageOf(f.findingType);
          return s === "stop" || s === "measure";
        })?.f ?? null
      : null;

    for (const { f } of rows) {
      // Idempotent on purpose. `evaluate` calls this once, but a pure function
      // that grows a line every time it is called is one somebody will call
      // twice and not find out for a month.
      const alreadySaid = f.evidence.lines.some((l) => l.startsWith(WAITING_LEAD));
      if (earlier && !alreadySaid && stageOf(f.findingType) === "grow") {
        out.push({ ...f, evidence: { ...f.evidence, lines: [...f.evidence.lines, waitingClause(earlier)] } });
      } else {
        out.push(f);
      }
    }
  }
  return out;
}

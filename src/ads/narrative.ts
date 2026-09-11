/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LLM SEAM. This is the ONLY place a model may touch an ads finding.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What a model is allowed to do here:
 *   - RANK a list of findings for a human's attention
 *   - GROUP findings that are really one story
 *   - REWRITE `title` and `summary` into better English
 *
 * What a model must NEVER do here, and what this module's shape prevents:
 *   - produce or alter a NUMBER. `estImpactCents`, every metric in `evidence`,
 *     every threshold — all decided in src/ads/rules.ts before this runs, and
 *     `refineNarrative` structurally cannot return them: it returns only the two
 *     text fields, which are then copied onto the rules' own object.
 *   - decide whether something IS a finding. It receives findings; it cannot
 *     add one.
 *   - reach an ad platform or the database. It is a pure post-processor on data
 *     already in memory.
 *
 * It is IDENTITY today — no model is called, `engine` is "rules", and every
 * word a person reads was written by the rules engine. That is deliberate: the
 * problem being solved is an analysis that changes its mind, and the smallest
 * honest version of the fix ships the deterministic half first. Wiring a model
 * in later means implementing `refineNarrative` and nothing else; the finding's
 * `narrative_engine` column then records which engine wrote the words, so a
 * sentence can always be traced to its author.
 *
 * Precedent: server/intake-suggest.ts's `refineSuggestion` in the dashboard,
 * same rule, same shape.
 */

import type { DerivedFinding } from "./rules.js";

export interface NarrativeResult {
  findings: DerivedFinding[];
  /** "rules" today. A model name if one ever writes the words. */
  engine: string;
}

/**
 * LLM HOOK — identity today. See the module comment.
 *
 * The signature takes and returns the rules' own findings, and any future
 * implementation must copy ONLY `title` and `summary` from a model's output
 * onto them. Anything else is a bug, not a feature.
 */
export function refineNarrative(findings: DerivedFinding[]): NarrativeResult {
  return { findings, engine: "rules" };
}

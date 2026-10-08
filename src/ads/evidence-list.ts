/**
 * The records behind a finding are stored whole.
 *
 * Pure. A list in, lines out.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * A finding's `evidence.lines` is what the dashboard shows, what its export
 * writes and what a vendor's brief is built from. For months the engine cut a
 * search-term list at twelve and wrote "…and 10 more" into the stored column,
 * so a row that said it covered 22 terms could only ever name 12 of them, and
 * every document made from it was short by construction. Nothing downstream can
 * recover a record the engine did not store, so the cap was never fixable in the
 * export: it was here.
 *
 * A SCREEN earns a cap (a reader scrolls, a phone has a width) and the
 * dashboard folds a long list itself. A STORED RECORD does not: it is the
 * evidence, and a document handed to a vendor cannot be asked what was cut.
 *
 * ── THE CEILING THAT REMAINS, AND WHY IT IS HONEST ─────────────────────────
 *
 * `EVIDENCE_LIST_CEILING` exists only so a pathological account cannot write a
 * megabyte into one row. Past it the list ends with the same tail marker the
 * dashboard already reads as "the engine stored a short list" (`…and N more`),
 * so a list that is cut is still SAID to be cut, and every count taken over it
 * stays a floor. The ceiling is ours; at five hundred records a person cannot
 * read the list in one sitting whatever is stored.
 */
export const EVIDENCE_LIST_CEILING = 500;

/** Every record as a line, up to the ceiling, ending with a tail marker only
 *  when the ceiling truncated something. */
export function recordLines<T>(items: readonly T[], line: (t: T) => string, ceiling: number = EVIDENCE_LIST_CEILING): string[] {
  const shown = items.slice(0, ceiling).map(line);
  return items.length > ceiling ? [...shown, `…and ${items.length - ceiling} more`] : shown;
}

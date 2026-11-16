/**
 * Which clients a per-client reader may read.
 *
 * A churned client has nothing left to measure: its property access is often
 * revoked, its sheet is no longer shared, and every run that tried it ended in
 * a 403 or "sheet_not_shared" that looked like a fault. Every per-client
 * reader decides through this one file, so the rule is stated once.
 *
 *   - churned: never read. Its stored history stays; nothing here deletes it.
 *   - paused: still read (a paused client's last months of figures matter).
 *   - the internal client: skipped only by readers that ask for it
 *     (`skipInternal`), because a few readers legitimately read our own site.
 *   - a client we cannot find, or one with no status: read. A null is
 *     unanswered and is never read as "churned".
 *
 * Pure: no database, no clock.
 */

export interface ClientScopeFacts {
  status?: string | null;
  isInternal?: boolean | null;
}

export interface ScopeOptions {
  /** Also leave out the internal client. Default false. */
  skipInternal?: boolean;
}

export interface ScopeSplit<T> {
  live: T[];
  churned: T[];
  internal: T[];
}

export const isChurned = (status: string | null | undefined): boolean =>
  typeof status === "string" && status.trim().toLowerCase() === "churned";

/** SQL for a reader that filters in the database. NULL status is not churned. */
export const notChurnedSql = (alias = "c"): string => `COALESCE(${alias}.status, '') <> 'churned'`;

/** Split rows into those a reader may read and those it leaves out, with the reason. */
export function splitClients<T>(rows: readonly T[], facts: (row: T) => ClientScopeFacts, opts: ScopeOptions = {}): ScopeSplit<T> {
  const out: ScopeSplit<T> = { live: [], churned: [], internal: [] };
  for (const r of rows) {
    const f = facts(r);
    if (isChurned(f.status)) out.churned.push(r);
    else if (opts.skipInternal && f.isInternal === true) out.internal.push(r);
    else out.live.push(r);
  }
  return out;
}

/** The line every reader prints, so a skipped client is never silent. */
export function skippedLine(split: { churned: readonly unknown[]; internal?: readonly unknown[] }): string {
  const n = split.churned.length;
  const i = split.internal?.length ?? 0;
  return `${n} churned skipped${i > 0 ? `, ${i} internal skipped` : ""}`;
}

/** Names for the output, capped so a long list cannot flood a log. Counts are always exact. */
export function skippedNames(names: readonly string[], cap = 5): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, cap).join(", ");
  return names.length > cap ? `${shown} and ${names.length - cap} more` : shown;
}

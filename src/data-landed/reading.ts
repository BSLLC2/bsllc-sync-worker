/**
 * The reading: one client, one source, what the table says.
 *
 * Four states and no more.
 *   ok              the newest landed row is inside the expected window
 *   stale           a landed row exists and is older than the window, or the latest read
 *                   answered but brought nothing
 *   never           the source is switched on and no landed row exists at all
 *   not_applicable  the source is not switched on for this client: nothing is expected
 *
 * A landed row is a row a run actually brought: a live metric, a scan that read, a rank
 * check that did not fail, a signal run that wrote rows. An error row, a no-data row and a
 * failed check are NOT landed, so a run that "finished" and brought nothing cannot read as ok.
 * A null or unreadable time is unanswered and is never read as fresh.
 *
 * Pure: no database, no clock.
 */
import { LANDED_STATES, SOURCE_SPECS, type LandedSource, type LandedState, type SourceSpec } from "./catalog.js";

export interface ClientFacts {
  clientId: string;
  name: string;
  status: string | null;
  isInternal: boolean;
  seoDomain: string | null;
  /** Enabled connector sources that carry an account number. */
  connectors: ReadonlySet<string>;
  /** Active tracked searches. */
  activeRankTargets: number;
}

export interface Landed {
  /** When the newest LANDED row arrived; null when none ever did. */
  lastRowAt: Date | null;
  /** One short phrase naming why nothing landed, when something else exists. Dates and counts only. */
  note: string | null;
}

export interface LandedRow {
  clientId: string;
  source: LandedSource;
  lastRowAt: Date | null;
  expectedHours: number | null;
  state: LandedState;
  detail: string | null;
}

const HOUR = 3_600_000;

/** Is this source switched on for this client? */
export function switchedOn(spec: SourceSpec, c: ClientFacts): boolean {
  // The job that fills this source only reads some statuses (a paused client's ad account is not read daily).
  if (spec.readsStatuses && !spec.readsStatuses.includes((c.status ?? "").trim().toLowerCase())) return false;
  if ("connector" in spec.switchedOn) return c.connectors.has(spec.switchedOn.connector);
  return c.activeRankTargets > 0 && Boolean(c.seoDomain && c.seoDomain.trim());
}

export function judge(spec: SourceSpec, c: ClientFacts, landed: Landed | null, now: Date): LandedRow {
  const base = { clientId: c.clientId, source: spec.source };
  if (!switchedOn(spec, c)) {
    return { ...base, lastRowAt: landed?.lastRowAt ?? null, expectedHours: null, state: "not_applicable", detail: spec.readsStatuses && !spec.readsStatuses.includes((c.status ?? "").trim().toLowerCase()) ? `not read while the client is ${c.status ?? "inactive"}` : "not switched on for this client" };
  }
  const at = landed?.lastRowAt ?? null;
  if (!at || Number.isNaN(at.getTime())) {
    return { ...base, lastRowAt: null, expectedHours: spec.expectedHours, state: "never", detail: landed?.note ?? "nothing has landed" };
  }
  const ageHours = (now.getTime() - at.getTime()) / HOUR;
  // A row dated well after now is a clock fault, not freshness: it is said, and read as ok only inside an hour.
  if (ageHours < -1) return { ...base, lastRowAt: at, expectedHours: spec.expectedHours, state: "stale", detail: "the newest row is dated in the future" };
  if (ageHours > spec.expectedHours) {
    return { ...base, lastRowAt: at, expectedHours: spec.expectedHours, state: "stale", detail: landed?.note ?? `nothing for ${Math.floor(ageHours / 24)} days` };
  }
  return { ...base, lastRowAt: at, expectedHours: spec.expectedHours, state: "ok", detail: null };
}

/** Rows for every live client and every source. Churned and internal clients are not judged. */
export function buildRows(clients: readonly ClientFacts[], landedOf: (clientId: string, source: LandedSource) => Landed | null, now: Date): LandedRow[] {
  const out: LandedRow[] = [];
  for (const c of clients) {
    if (c.isInternal || (c.status ?? "").trim().toLowerCase() === "churned") continue;
    for (const spec of SOURCE_SPECS) out.push(judge(spec, c, landedOf(c.clientId, spec.source), now));
  }
  return out;
}

export function countStates(rows: readonly LandedRow[]): Record<LandedState, number> {
  const n = Object.fromEntries(LANDED_STATES.map((s) => [s, 0])) as Record<LandedState, number>;
  for (const r of rows) n[r.state]++;
  return n;
}

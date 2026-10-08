/**
 * What the audit closes, and why it says so.
 *
 * Pure. Facts in, a plan out; `store.ts` does the writes and holds no rule of
 * its own. Everything a person reads in a closing reason is in this file.
 *
 * WHY IT EXISTS. The owner has been reporting for days that the queue shows
 * work that is done. Reading the sweep found four ways an old row could stay,
 * and one way a live row could be closed wrongly:
 *
 *  1. THE SWEEP COMPARED ENTITY IDS AND NEVER FINDING TYPES. Three rules key a
 *     finding on the bare campaign id (`budget_limited`, `rank_limited`,
 *     `no_conversions`). A campaign that went on producing one of them kept
 *     every OTHER row on that campaign open for ever, because "the entity is
 *     still present" was read as "the finding is still present". The key a
 *     finding lives under is the PAIR, so the pair is what is compared.
 *  2. A RULE CHANGE WAS REPORTED AS THE ACCOUNT CHANGING. A row the new ruleset
 *     no longer raises was closed with "the condition cleared on its own",
 *     which a person reads as "somebody fixed it". Where the row was last
 *     raised under an older ruleset, the reason says the rules moved and the
 *     account may also have.
 *  3. AN ACCOUNT THE AUDIT STOPPED READING WAS NEVER SWEPT. The sweep runs per
 *     account the run reads. A mapping switched off, a client who is paused or
 *     an account number that changed leaves the old account's rows open with
 *     nothing ever looking at them again.
 *  4. A RULE THAT COULD NOT RUN WAS READ AS A RULE THAT FOUND NOTHING. With the
 *     negative-keyword list unread, no waste row is produced, so every waste row
 *     already open was closed as cleared. The same for a keyword pull or a
 *     search-terms pull that came back full: what a cut drops is not absent
 *     from the account. Those rows are left, and the run says it did not
 *     re-check them.
 *
 * NOTHING IS DELETED. A closure is a status change with a reason and an event,
 * exactly as before. A row a person or the apply path has touched is never
 * closed here: only `open` and `proposed` are in play.
 *
 * A CLOSURE THE MACHINE MADE FOR A REASON THAT HAS GONE IS UNDONE BY THE
 * MACHINE. A row closed because its account was not being audited, or because
 * the rules moved, was never decided by anybody, so `isMachineClosure` lets the
 * next detection re-open it whatever the evidence hash says. A person's
 * dismissal is untouched by this and stays sticky.
 */

/** The sentence the sweep has always written, kept word for word. */
export const CLEARED_REASON = "No longer present in the account — the condition cleared on its own.";
export const CLEARED_EVENT = "Condition cleared — not seen in the latest audit.";

/** Prefixes are how a closure is recognised later, so they are constants. */
export const RULE_UPDATE_PREFIX = "Closed after a rule update";
export const NOT_AUDITED_PREFIX = "Closed because this ad account is no longer audited";

export type ClosureKind = "cleared" | "rule_update" | "not_audited";

export function pairKey(entityId: string, findingType: string): string {
  return `${findingType}\u0000${entityId}`;
}

export interface OpenFindingRow {
  id: string;
  entityId: string;
  findingType: string;
  title: string;
  /** The ruleset that LAST wrote this row (the column is rewritten on refresh). */
  rulesetVersion: number;
  entityName?: string | null;
}

export function ruleUpdateReason(lastRaisedUnder: number, now: number): string {
  return `${RULE_UPDATE_PREFIX} (ruleset ${now}): this audit no longer raises it. `
    + `It was last raised under ruleset ${lastRaisedUnder}, so the account may also have changed.`;
}

export interface PlannedClosure {
  row: OpenFindingRow;
  kind: ClosureKind;
  reason: string;
  /** The event note, which is the short form of the reason. */
  eventNote: string;
}

export interface NotRechecked {
  findingType: string;
  count: number;
  why: string;
}

export interface SweepPlan {
  close: PlannedClosure[];
  /** Still open, not produced this run, and left on purpose. */
  leftBecauseUnreadable: NotRechecked[];
}

/**
 * The finding types a run could not honestly re-check, and why.
 *
 * ONLY WHAT THE INPUT ITSELF SAYS. A null negatives read, a keyword pull that
 * came back full and a search-terms pull that came back full are each flags the
 * adapter set; nothing here guesses at a failure.
 */
export interface RecheckInputs {
  negativesRead: boolean;
  keywordsTruncated?: boolean;
  searchTermsTruncated?: boolean;
}

export function unrecheckableTypes(i: RecheckInputs): Map<string, string> {
  const out = new Map<string, string>();
  const add = (types: string[], why: string) => {
    for (const t of types) if (!out.has(t)) out.set(t, why);
  };
  if (!i.negativesRead) add(["wasted_search_term", "converting_search_term"], "the account's negative keywords could not be read");
  if (i.keywordsTruncated) add(["dead_keyword"], "the keyword report came back full, so keywords behind the cut were not read");
  if (i.searchTermsTruncated) add(["wasted_search_term", "converting_search_term"], "the search-terms report came back full, so terms behind the cut were not read");
  return out;
}

/**
 * Which open rows this run closes.
 *
 * `present` holds the PAIRS the run produced. A row is closed only when its own
 * pair is absent — never because some other finding on the same entity is
 * there.
 */
export function planSweep(
  open: readonly OpenFindingRow[],
  present: ReadonlySet<string>,
  currentRuleset: number,
  unrecheckable: ReadonlyMap<string, string> = new Map(),
): SweepPlan {
  const close: PlannedClosure[] = [];
  const left = new Map<string, NotRechecked>();
  for (const row of open) {
    if (present.has(pairKey(row.entityId, row.findingType))) continue;
    const why = unrecheckable.get(row.findingType);
    if (why) {
      const e = left.get(row.findingType) ?? { findingType: row.findingType, count: 0, why };
      e.count += 1;
      left.set(row.findingType, e);
      continue;
    }
    if (row.rulesetVersion < currentRuleset) {
      close.push({
        row, kind: "rule_update",
        reason: ruleUpdateReason(row.rulesetVersion, currentRuleset),
        eventNote: `Closed after a rule update (ruleset ${currentRuleset}) — not raised by the latest audit.`,
      });
    } else {
      close.push({ row, kind: "cleared", reason: CLEARED_REASON, eventNote: CLEARED_EVENT });
    }
  }
  return { close, leftBecauseUnreadable: Array.from(left.values()) };
}

// ── Accounts the audit no longer reads ───────────────────────────────────────

/** What the connector mapping and the client record say about an account. */
export interface MappingState {
  clientStatus: string | null;
  /** null = no mapping row for this platform at all. */
  mappingExists: boolean;
  mappingEnabled: boolean;
  /** The account number the mapping holds NOW, digits or act_ id, or null. */
  mappingAccountId: string | null;
}

export type NotAuditedWhy =
  | "client_inactive" | "mapping_off" | "mapping_blank" | "account_changed" | "no_mapping"
  /** Mapped, switched on, the same number, an active client: it IS audited, so
   *  nothing about it can be explained and nothing is closed on it. */
  | "still_mapped";

export function notAuditedWhy(s: MappingState, accountId: string, normalise: (v: string) => string): NotAuditedWhy {
  if (s.clientStatus !== "launch" && s.clientStatus !== "active") return "client_inactive";
  if (!s.mappingExists) return "no_mapping";
  if (!s.mappingAccountId || !s.mappingAccountId.trim()) return "mapping_blank";
  if (normalise(s.mappingAccountId) !== normalise(accountId)) return "account_changed";
  if (!s.mappingEnabled) return "mapping_off";
  return "still_mapped";
}

export function notAuditedWhyLine(why: NotAuditedWhy, status: string | null): string {
  switch (why) {
    case "client_inactive": return `the client is ${status ? `marked ${status}` : "not active"}`;
    case "mapping_off": return "the ad account's connector is switched off";
    case "mapping_blank": return "the ad account's connector has no account number";
    case "account_changed": return "the client's ad account number has changed";
    case "no_mapping": return "the client has no connector for this platform";
    case "still_mapped": return "the account is mapped";
  }
}

export function notAuditedReason(why: NotAuditedWhy, status: string | null, lastCheckedOn: string | null): string {
  return `${NOT_AUDITED_PREFIX}: ${notAuditedWhyLine(why, status)}. `
    + `${lastCheckedOn ? `It was last checked ${lastCheckedOn}. ` : ""}`
    + "It is raised again if the account is audited again and the condition is still there.";
}

export interface OrphanGroup {
  clientId: string;
  platform: string;
  accountId: string;
  openRows: number;
  lastCheckedOn: string | null;
  state: MappingState;
}

export interface OrphanPlan {
  close: { group: OrphanGroup; why: NotAuditedWhy; reason: string }[];
  /** True when the breaker held the closures back. */
  refused: boolean;
  refusal: string | null;
  rowsToClose: number;
}

/** More than this share of every open row at once is a broken read, not a tidy-up. */
export const ORPHAN_SWEEP_MAX_SHARE = 0.5;
/** …and the share only means anything over a book this big. */
export const ORPHAN_SWEEP_MIN_BOOK = 10;

/**
 * Which accounts' open rows to close because the audit does not read them.
 *
 * `audited` is every (platform, account) this run read; a group in it is never
 * an orphan. The breaker is the guard against the one way this goes badly: a
 * mapping table that comes back empty for a reason that is not "everyone left".
 */
export function planOrphanClosures(
  groups: readonly OrphanGroup[],
  audited: ReadonlySet<string>,
  totalOpenRows: number,
  normalise: (v: string) => string,
): OrphanPlan {
  const orphans = groups
    .filter((g) => !audited.has(`${g.platform}\u0000${g.clientId}\u0000${normalise(g.accountId)}`))
    // A group whose mapping still says "audit me" is a race or a read error, never an orphan.
    .filter((g) => notAuditedWhy(g.state, g.accountId, normalise) !== "still_mapped");
  const rowsToClose = orphans.reduce((n, g) => n + g.openRows, 0);
  if (!orphans.length) return { close: [], refused: false, refusal: null, rowsToClose: 0 };
  if (totalOpenRows >= ORPHAN_SWEEP_MIN_BOOK && rowsToClose / totalOpenRows > ORPHAN_SWEEP_MAX_SHARE) {
    return {
      close: [], refused: true, rowsToClose,
      refusal: `${rowsToClose} of ${totalOpenRows} open rows sit on accounts this run did not read, which is more than ${Math.round(ORPHAN_SWEEP_MAX_SHARE * 100)}%. `
        + "That looks like a broken read of the mappings, so nothing was closed.",
    };
  }
  return {
    close: orphans.map((g) => {
      const why = notAuditedWhy(g.state, g.accountId, normalise);
      return { group: g, why, reason: notAuditedReason(why, g.state.clientStatus, g.lastCheckedOn) };
    }),
    refused: false, refusal: null, rowsToClose,
  };
}

// ── Re-opening what the machine closed ───────────────────────────────────────

/**
 * Was this dismissal the audit's own, for a reason that is not a decision?
 *
 * `actor` is the audit's actor string. A person's dismissal never has it, and
 * the superseded rows (closed by name for a sharper reading) never carry these
 * two prefixes, so neither can be re-opened by this.
 */
export function isMachineClosure(dismissedBy: string | null, reason: string | null, actor: string): boolean {
  if (dismissedBy !== actor || !reason) return false;
  return reason.startsWith(RULE_UPDATE_PREFIX) || reason.startsWith(NOT_AUDITED_PREFIX);
}

/**
 * Closing the half of the invoice sync that was never written.
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 *
 * `import-qbo-invoices-sync` reads `SELECT * FROM Invoice` — every invoice in
 * the company file, paged — and upserts each one. That is the shape the
 * dashboard's own note prescribes, and on its own it very nearly works: an
 * invoice that gets paid comes back with Balance 0 and the row follows it
 * down. What it cannot do is notice an invoice QuickBooks has stopped
 * returning at all. A DELETED transaction does not appear in that query, and a
 * row nothing writes keeps whatever balance the last sync that saw it wrote —
 * for as long as the row exists. Every reader of `balance_cents > 0` inherits
 * it: the overdue card, the aging buckets, each client's AR figure, the exec
 * callout and the cash-gap forecast.
 *
 * On 2026-09-21 the company owner put his own QuickBooks export beside the
 * dashboard and they disagreed by three rows and $11,737.06. Two of them were
 * frozen exactly this way. He asked for one thing: "they need to be one to one
 * all the time."
 *
 * The same file already solves this for recurring templates — it collects the
 * ids it saw and deactivates the rest. This is that sweep, for invoices, with
 * the guard made much stronger, because the consequence is not the same.
 * Deactivating a recurring template that is really still live is a figure that
 * comes back tomorrow. Zeroing a balance that is really still owed deletes a
 * receivable from every reading in the business.
 *
 * ── THE SAFETY ARGUMENT, WHICH IS THE WHOLE MODULE ──────────────────────────
 *
 * An invoice is absent from a read for two reasons that look identical from
 * here: QuickBooks no longer has it, or this run never got to it. The first
 * should zero the row. The second must change nothing. Nothing in the response
 * distinguishes them, so the run has to prove its own completeness FIRST and
 * act only then.
 *
 * Three proofs, and all three are required:
 *
 *  1. EVERY PAGE CAME BACK. `QboClient.call` throws on a non-2xx, so a page
 *     that fails aborts the whole job — but "it would have thrown" is a
 *     property of code somewhere else, and this decision must not rest on it.
 *     The fetch states it.
 *  2. THE ANSWER WAS NOT EMPTY. Zero invoices is an API hiccup or a wrong
 *     realm far more often than a company that has never billed anybody, and
 *     an empty answer must never be allowed to zero the whole list. This is
 *     the guard the recurring sweep already makes, kept.
 *  3. QUICKBOOKS' OWN COUNT AGREES. `SELECT COUNT(*) FROM Invoice` is one
 *     extra call and it is the only one of the three that can catch a read
 *     that succeeded and was still short — a page that returns fewer rows than
 *     it should ends the pagination loop with no error anywhere. Counting
 *     AFTER the fetch makes the asymmetry the safe way round: an invoice
 *     created mid-run leaves the fetch one short of the count and the run
 *     refuses, which costs a day; an invoice deleted mid-run leaves the fetch
 *     one over, which is fine and is caught tomorrow.
 *
 * Fail any of them and the plan changes nothing and says which one failed. The
 * asymmetry is deliberate: refusing costs a day, and acting on a partial read
 * silently wipes real money off the books.
 *
 * ── WHAT IT DOES AND DOES NOT DO ────────────────────────────────────────────
 *
 *  • It NEVER deletes a row. The invoice history is the point — the total, the
 *    dates, the doc number and the payments against it all stay exactly where
 *    they are, and `sync_closed_balance_cents` keeps the balance that was
 *    last synced so the money is still traceable after it stops being counted.
 *  • It NEVER touches `synced_at`. QuickBooks did not confirm a zero balance;
 *    this run inferred one from absence. Stamping the row as freshly confirmed
 *    would be the app asserting something QuickBooks never said, and
 *    `shared/invoice-confirmation.ts` reads that column to decide exactly that.
 *  • It only ever touches rows with a balance above zero. A row already at
 *    zero costs nothing, and a smaller statement is a smaller blast radius.
 *  • It ends itself. The upsert clears all three columns on every row it
 *    writes, so an invoice QuickBooks starts returning again comes back with
 *    no trace of having been closed.
 *
 * Pure: facts in, one plan out. No database, no network, no clock of its own.
 * `src/verify-qbo-reconcile.ts` drives every branch with no credential.
 */

/** One stored invoice row that still carries a balance. */
export interface OpenInvoiceRow {
  id: string;
  docNumber: string | null;
  customerName: string | null;
  balanceCents: number;
}

/** Everything the plan is decided from. */
export interface ReconcileFacts {
  /** Every invoice id this run read back from QuickBooks. */
  fetchedIds: string[];
  /** True only when every page of the read returned without error. */
  fetchCompleted: boolean;
  /**
   * What QuickBooks itself says it holds, or null when the count could not be
   * read. Null is unanswered — never treated as agreement.
   */
  quickBooksCount: number | null;
  /** The stored rows with a balance above zero. */
  openRows: OpenInvoiceRow[];
  /** Today, as YYYY-MM-DD. Written into the reason on each closed row. */
  today: string;
}

/** One row the plan would close, with the sentence that goes on it. */
export interface ClosePlanRow {
  id: string;
  docNumber: string | null;
  customerName: string | null;
  /** The balance about to stop being counted. Kept on the row. */
  balanceCents: number;
  /** Why it was closed. Stored verbatim in `sync_closed_reason`. */
  reason: string;
}

export interface ReconcilePlan {
  /** True only when all three proofs held. */
  act: boolean;
  /** Which proof failed, in one sentence, or null when none did. */
  refusal: string | null;
  /** The rows to close. Always empty when `act` is false. */
  close: ClosePlanRow[];
  /** Cents about to stop being counted as owed. */
  closingCents: number;
  /** What this run read, stated rather than assumed. */
  window: string;
  /** One line for the run log and the job heartbeat. */
  summary: string;
}

/**
 * The window every proof is about. The query carries no WHERE clause, so the
 * read is the whole company file and the plan can say so. Narrow the query and
 * this sentence stops being true, which is why it lives next to the rule
 * rather than in a comment on the caller.
 */
export const RECONCILE_WINDOW = "every invoice in the QuickBooks company file";

const usd = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const count = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The refusals, each naming the proof that failed and what it costs. */
export const REFUSAL_INCOMPLETE_READ =
  "The invoice read did not finish, so an invoice missing from it may only be one this run never reached. Nothing was closed; the next complete run will do it.";
export const REFUSAL_EMPTY_READ =
  "QuickBooks returned no invoices at all. That is an API problem or the wrong company far more often than a company file with nothing in it, and an empty answer must never zero the whole list. Nothing was closed.";
export const REFUSAL_NO_COUNT =
  "QuickBooks did not answer how many invoices it holds, so this run cannot prove it read all of them. Nothing was closed.";

/** The count came back and the read was short of it. */
export function shortReadRefusal(fetched: number, held: number): string {
  return `This run read ${count(fetched, "invoice")} and QuickBooks says it holds ${held.toLocaleString("en-US")}, `
    + `so the read was short and an invoice missing from it may only be one that was not returned. Nothing was closed; `
    + `an invoice created while the run was in flight produces exactly this and clears by itself on the next run.`;
}

/** The sentence stored on a row this run closes. */
export function closeReason(today: string, fetched: number): string {
  return `A complete read of ${RECONCILE_WINDOW} on ${today} returned ${count(fetched, "invoice")} and this was not among them. `
    + `QuickBooks no longer has it — deleted there, or no longer returned by the query it is read with. `
    + `The balance it last carried is kept beside this, and nothing else on the row was changed.`;
}

/**
 * Whether this run has earned the right to close anything.
 *
 * Separate from the plan so the refusal can be read on its own, and so the
 * verifier can assert each proof without building a row set.
 */
export function reconcileRefusal(f: ReconcileFacts): string | null {
  if (!f.fetchCompleted) return REFUSAL_INCOMPLETE_READ;
  if (f.fetchedIds.length === 0) return REFUSAL_EMPTY_READ;
  if (f.quickBooksCount == null) return REFUSAL_NO_COUNT;
  const seen = new Set(f.fetchedIds).size;
  if (seen < f.quickBooksCount) return shortReadRefusal(seen, f.quickBooksCount);
  return null;
}

/** The whole decision. */
export function planInvoiceReconcile(f: ReconcileFacts): ReconcilePlan {
  const refusal = reconcileRefusal(f);
  if (refusal) {
    return {
      act: false, refusal, close: [], closingCents: 0,
      window: RECONCILE_WINDOW,
      summary: `Reconcile refused: ${refusal}`,
    };
  }
  const seen = new Set(f.fetchedIds);
  const reason = closeReason(f.today, seen.size);
  const close: ClosePlanRow[] = [];
  for (const row of f.openRows) {
    if (row.balanceCents <= 0) continue; // already counted as nothing; leave it alone
    if (seen.has(row.id)) continue;
    close.push({
      id: row.id, docNumber: row.docNumber, customerName: row.customerName,
      balanceCents: row.balanceCents, reason,
    });
  }
  const closingCents = close.reduce((s, r) => s + r.balanceCents, 0);
  const summary = close.length === 0
    ? `Reconciled against ${seen.size.toLocaleString("en-US")} invoices — every open row is still in QuickBooks.`
    : `Reconciled against ${seen.size.toLocaleString("en-US")} invoices — closed ${count(close.length, "row")} worth ${usd(closingCents)} QuickBooks no longer returns.`;
  return { act: true, refusal: null, close, closingCents, window: RECONCILE_WINDOW, summary };
}

/** What the run prints, one line per closed row. Never a contact detail. */
export function closeLines(plan: ReconcilePlan): string[] {
  return plan.close.map((r) =>
    `    closed ${r.customerName ?? "(no customer)"} ${r.docNumber ?? r.id} — ${usd(r.balanceCents)} no longer in QuickBooks`);
}

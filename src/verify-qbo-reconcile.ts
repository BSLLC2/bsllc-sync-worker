#!/usr/bin/env tsx
/**
 * Proves the rules that let the invoice sync close a row — and, far more
 * importantly, the rules that stop it.
 *
 * The defect being fixed is a row nobody writes keeping a balance for ever.
 * The defect this guard exists to stop is the OPPOSITE one: a run that zeroes
 * a real receivable because a read came back short. So the refusals lead, and
 * every one of them is driven through the same function the sync calls.
 *
 * No database, no network, no QuickBooks credential, no client account. Every
 * customer, invoice number and amount below is invented.
 *
 *   npm run verify-qbo-reconcile
 */
import {
  planInvoiceReconcile, reconcileRefusal, closeReason, closeLines,
  RECONCILE_WINDOW, REFUSAL_EMPTY_READ, REFUSAL_INCOMPLETE_READ, REFUSAL_NO_COUNT,
  type ReconcileFacts, type OpenInvoiceRow,
} from "./qbo/invoice-reconcile.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const TODAY = "2026-09-28";

/** Three open rows. Two are still in QuickBooks; the third is the frozen one. */
const openRows: OpenInvoiceRow[] = [
  { id: "1101", docNumber: "INV-4001", customerName: "Harbour Mill Co", balanceCents: 655_000 },
  { id: "1102", docNumber: "INV-4002", customerName: "Plainview Group", balanceCents: 500_000 },
  { id: "1103", docNumber: "INV-4003", customerName: "Rowan & Fell", balanceCents: 18_706 },
];

/** A complete read: both live rows came back, the frozen one did not, and
 *  QuickBooks' own count agrees with what was read. */
const facts = (over: Partial<ReconcileFacts> = {}): ReconcileFacts => ({
  fetchedIds: ["1101", "1102", "2001", "2002"],
  fetchCompleted: true,
  quickBooksCount: 4,
  openRows,
  today: TODAY,
  ...over,
});

console.log("QuickBooks invoice reconciliation — what lets a row be closed, and what refuses");
console.log("Pure. No network, no database, no QuickBooks credential.\n");

// ── 1. The refusals, which are the reason this module exists ────────────────
console.log("1. A run that cannot prove it read everything changes nothing");
{
  const incomplete = planInvoiceReconcile(facts({ fetchCompleted: false }));
  ok("an unfinished read closes nothing", incomplete.act === false && incomplete.close.length === 0);
  ok("  …and says which proof failed", incomplete.refusal === REFUSAL_INCOMPLETE_READ);
  ok("  …and says the next complete run will do it", (incomplete.refusal ?? "").includes("next complete run"));

  const empty = planInvoiceReconcile(facts({ fetchedIds: [] }));
  ok("an empty answer never zeroes the whole list", empty.act === false && empty.close.length === 0);
  ok("  …and names it as an API problem before a company with no invoices", empty.refusal === REFUSAL_EMPTY_READ);
  // The case that earns the empty guard its own place: an API problem that
  // answers nothing to BOTH calls. Counting alone would let that through --
  // nought read is not short of nought held -- and the whole open list would
  // be zeroed in one pass.
  const emptyBoth = planInvoiceReconcile(facts({ fetchedIds: [], quickBooksCount: 0 }));
  ok("a read and a count that both come back empty still closes nothing", emptyBoth.act === false && emptyBoth.close.length === 0);

  const noCount = planInvoiceReconcile(facts({ quickBooksCount: null }));
  ok("a count that could not be read is unanswered, never agreement", noCount.act === false && noCount.close.length === 0);
  ok("  …and says the run cannot prove it read all of them", noCount.refusal === REFUSAL_NO_COUNT);

  // The one failure no error can announce: pagination stops early on a short
  // page and every call returned 200.
  const short = planInvoiceReconcile(facts({ quickBooksCount: 9 }));
  ok("a read short of QuickBooks' own count closes nothing", short.act === false && short.close.length === 0);
  ok("  …and prints both numbers", (short.refusal ?? "").includes("4 invoices") && (short.refusal ?? "").includes("9"));
  ok("  …and names the in-flight invoice that produces it", (short.refusal ?? "").includes("in flight"));

  ok("every refusal reports zero cents closing", [incomplete, empty, noCount, short].every((p) => p.closingCents === 0));
  ok("every refusal still states the window it was about", [incomplete, empty, noCount, short].every((p) => p.window === RECONCILE_WINDOW));
  ok("a refusal reaches the heartbeat as a refusal", incomplete.summary.startsWith("Reconcile refused:"));
}

// ── 2. A complete run closes exactly what QuickBooks stopped returning ──────
console.log("\n2. A complete read closes the rows QuickBooks no longer has, and only those");
{
  const p = planInvoiceReconcile(facts());
  ok("it acts", p.act === true && p.refusal === null);
  ok("it closes the one row that did not come back", p.close.length === 1 && p.close[0]!.id === "1103");
  ok("  …and leaves every row that did", !p.close.some((r) => r.id === "1101" || r.id === "1102"));
  ok("it keeps the balance that stops being counted", p.close[0]!.balanceCents === 18_706);
  ok("it reports what is leaving the total", p.closingCents === 18_706);
  ok("the reason names the date and what was read", p.close[0]!.reason.includes(TODAY) && p.close[0]!.reason.includes(RECONCILE_WINDOW));
  ok("the reason gives both readings of an absence", /deleted there/.test(p.close[0]!.reason) && /no longer returned by the query/.test(p.close[0]!.reason));
  ok("the reason says the rest of the row was left alone", p.close[0]!.reason.includes("nothing else on the row was changed"));
  ok("the summary carries the count and the money", p.summary.includes("1 row") && p.summary.includes("$187.06"));

  // A count ABOVE what came back is the safe direction: an invoice deleted
  // while the run was in flight. It must still act.
  const deletedMidRun = planInvoiceReconcile(facts({ quickBooksCount: 3 }));
  ok("a read longer than the count still acts (something was deleted mid-run)", deletedMidRun.act === true);

  // A run where QuickBooks still has everything must write nothing at all.
  const allPresent = planInvoiceReconcile(facts({ fetchedIds: ["1101", "1102", "1103"], quickBooksCount: 3 }));
  ok("a board QuickBooks still holds in full closes nothing", allPresent.act === true && allPresent.close.length === 0);
  ok("  …and says so rather than saying nothing", allPresent.summary.includes("every open row is still in QuickBooks"));

  // Duplicate ids in the read must not inflate the count past the guard.
  const dupes = planInvoiceReconcile(facts({ fetchedIds: ["1101", "1101", "1102", "1102"], quickBooksCount: 4 }));
  ok("a duplicated id cannot buy its way past QuickBooks' count", dupes.act === false);
}

// ── 3. What it never does ───────────────────────────────────────────────────
console.log("\n3. Nothing is deleted, nothing already at nought is touched");
{
  const withSettled = planInvoiceReconcile(facts({
    openRows: [...openRows, { id: "1104", docNumber: "INV-4004", customerName: "Hallow Lane", balanceCents: 0 }],
  }));
  ok("a row already at nought is never in the plan", !withSettled.close.some((r) => r.id === "1104"));

  const p = planInvoiceReconcile(facts());
  // Structural, not a word search: the plan says what to keep and what the
  // row was, and carries no instruction that could remove a row or restamp
  // it as freshly confirmed. A field added here that did either would have to
  // come through this check first.
  ok("a close instruction carries only the row, the balance kept and the reason",
    JSON.stringify(Object.keys(p.close[0]!).sort()) === JSON.stringify(["balanceCents", "customerName", "docNumber", "id", "reason"]));
  ok("the plan itself offers nothing but an act, a refusal, the rows and the wording",
    JSON.stringify(Object.keys(p).sort()) === JSON.stringify(["act", "close", "closingCents", "refusal", "summary", "window"]));

  // The printed lines are for a shared run log.
  const lines = closeLines(p);
  ok("the log prints one line per closed row", lines.length === 1);
  ok("  …with the customer, the document and the money", lines[0]!.includes("Rowan & Fell") && lines[0]!.includes("INV-4003") && lines[0]!.includes("$187.06"));
  ok("  …and nothing that is a contact detail", !/@|\+\d|\bphone\b/i.test(lines[0]!));

  ok("an empty board is answered without inventing a plan", planInvoiceReconcile(facts({ openRows: [] })).close.length === 0);
  ok("the refusal helper agrees with the plan on every branch",
    reconcileRefusal(facts()) === null && reconcileRefusal(facts({ fetchCompleted: false })) === REFUSAL_INCOMPLETE_READ);
  ok("the reason is built from the read, never from a stored string", closeReason("2030-01-02", 7).includes("2030-01-02") && closeReason("2030-01-02", 7).includes("7 invoices"));
}

console.log(`\n${"─".repeat(72)}`);
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
console.log("─".repeat(72));
process.exit(failures === 0 ? 0 : 1);

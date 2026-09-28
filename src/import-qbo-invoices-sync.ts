#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { QboClient } from "./qbo.js";
import { planInvoiceReconcile, closeLines, type OpenInvoiceRow } from "./qbo/invoice-reconcile.js";
import { appendFileSync } from "node:fs";

/**
 * Pull-side QBO billing sync — distinct from import-qbo-invoices.ts, which
 * only PUSHES an estimate/invoice to QBO when a Quote Designer quote is
 * signed. Most of BS LLC's actual billing happens directly in QuickBooks
 * (manually created invoices, and recurring-invoice templates for retainer
 * clients) with no Quote Designer quote involved at all — so the app's
 * "Closed won — not yet billed" worklist, which only checks the Quote
 * Designer marker (pricing_quotes.qbo_invoice_id), was flagging deals that
 * were already fully billed in QBO as false positives.
 *
 * This job reads QBO's real Customer/Invoice/RecurringTransaction/Payment
 * lists (read-only, same OAuth scope already used) into four local tables so
 * the dashboard can check "has this company actually been invoiced or put
 * on a recurring invoice in QBO," and predict WHEN an outstanding invoice
 * will actually be collected using that customer's real historical
 * days-to-pay, without the app ever calling QBO directly.
 *
 *   npm run import-qbo-invoices-sync
 *   npm run import-qbo-invoices-sync -- --dry-run
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

// QBO's RecurringTransaction query response nests the actual template under
// a key named after its txn type ("Invoice") -- RecurringInfo (name, active
// flag, and the ScheduleInfo interval/next-date block Gap Analysis needs)
// is a field ON that Invoice object, NOT a sibling of it as first assumed.
// Confirmed live 2026-08-27 against a real response:
//   Invoice.RecurringInfo = {
//     Name, RecurType, Active,
//     ScheduleInfo: { IntervalType, NumInterval, DayOfMonth, DaysBefore,
//                     StartDate, NextDate, PreviousDate }
//   }
interface RecurringScheduleInfo { IntervalType?: string; NumInterval?: number; StartDate?: string; NextDate?: string; PreviousDate?: string; EndDate?: string }
interface RecurringInfo { Name?: string; Active?: boolean; ScheduleInfo?: RecurringScheduleInfo }
interface RecurringInvoiceTemplate { Id?: string; CustomerRef?: { value?: string; name?: string }; Line?: { Amount?: number }[]; TotalAmt?: number; RecurringInfo?: RecurringInfo }
interface RecurringTransactionRow { Invoice?: RecurringInvoiceTemplate }

function toCents(n: number): number { return Math.round(n * 100); }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  // What the reconciliation did, in one line, handed to the job heartbeat by
  // the workflow. A heartbeat that only says the job ran cannot tell "it
  // reconciled and every open row is still in QuickBooks" from "it refused
  // because the read was short" -- and a run that silently stops reconciling
  // looks exactly like a quiet week from Admin -> Data health.
  let reconcileSummary = "Reconcile did not run.";
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    // Safety net — normally the dashboard's ensureSchema already made these.
    await c.query(`
      CREATE TABLE IF NOT EXISTS qbo_customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    // fully_qualified_name/parent_id -- QBO's real sub-customer hierarchy
    // ("Parent:Child", e.g. a company with several billed projects
    // underneath it). DisplayName/CustomerRef.name on an invoice is just the
    // sub-customer's own short name with no parent qualifier, so matching a
    // linked CRM company (companies.qbo_customer_id, set to the TOP-LEVEL
    // parent) against a project's billing requires walking parent_id up the
    // chain -- string-matching DisplayName alone can't see this at all.
    await c.query(`ALTER TABLE qbo_customers ADD COLUMN IF NOT EXISTS fully_qualified_name TEXT`);
    await c.query(`ALTER TABLE qbo_customers ADD COLUMN IF NOT EXISTS parent_id TEXT`);
    await c.query(`
      CREATE TABLE IF NOT EXISTS qbo_invoices (
        id TEXT PRIMARY KEY,
        customer_id TEXT,
        customer_name TEXT,
        doc_number TEXT,
        txn_date TEXT,
        due_date TEXT,
        total_cents INTEGER NOT NULL DEFAULT 0,
        balance_cents INTEGER NOT NULL DEFAULT 0,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await c.query(`ALTER TABLE qbo_invoices ADD COLUMN IF NOT EXISTS due_date TEXT`);
    await c.query(`ALTER TABLE qbo_invoices ADD COLUMN IF NOT EXISTS balance_cents INTEGER NOT NULL DEFAULT 0`);
    // The reconciliation's own record — see src/qbo/invoice-reconcile.ts. A
    // row this sync zeroes because QuickBooks stopped returning it has to be
    // distinguishable from one QuickBooks itself reported at zero, or the fix
    // reproduces the defect it was written for: a balance nobody can account
    // for. sync_closed_balance_cents keeps the money traceable after it stops
    // being counted. Mirrored in the dashboard's own ensureSchema (v202); both
    // sides declare this table and both create it idempotently.
    await c.query(`ALTER TABLE qbo_invoices ADD COLUMN IF NOT EXISTS sync_closed_at TIMESTAMPTZ`);
    await c.query(`ALTER TABLE qbo_invoices ADD COLUMN IF NOT EXISTS sync_closed_reason TEXT`);
    await c.query(`ALTER TABLE qbo_invoices ADD COLUMN IF NOT EXISTS sync_closed_balance_cents INTEGER`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_qbo_invoices_customer ON qbo_invoices (customer_id)`);
    await c.query(`
      CREATE TABLE IF NOT EXISTS qbo_recurring_invoices (
        id TEXT PRIMARY KEY,
        customer_id TEXT,
        customer_name TEXT,
        template_name TEXT,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    // interval_type/num_interval/next_date/previous_date -- the real QBO
    // billing schedule (e.g. "Monthly" x1 = every month, "Monthly" x3 =
    // every 3 months, "Yearly" x1 = annual), added so Gap Analysis's
    // Scheduled revenue can be projected from this business's real recurring
    // invoice templates instead of manually-entered client retainer figures.
    await c.query(`ALTER TABLE qbo_recurring_invoices ADD COLUMN IF NOT EXISTS interval_type TEXT`);
    await c.query(`ALTER TABLE qbo_recurring_invoices ADD COLUMN IF NOT EXISTS num_interval INTEGER NOT NULL DEFAULT 1`);
    // The only anchor available for a template QBO hasn't fired the first
    // invoice from yet (no next_date/previous_date) -- without it, Gap
    // Analysis silently dropped a brand-new recurring template from every
    // month entirely (see the Integrus incident: it got marked superseded by
    // this very template, which itself never showed up anywhere in its place).
    await c.query(`ALTER TABLE qbo_recurring_invoices ADD COLUMN IF NOT EXISTS start_date TEXT`);
    await c.query(`ALTER TABLE qbo_recurring_invoices ADD COLUMN IF NOT EXISTS next_date TEXT`);
    await c.query(`ALTER TABLE qbo_recurring_invoices ADD COLUMN IF NOT EXISTS previous_date TEXT`);
    // A template QBO itself has set to stop on a specific date (a retainer
    // sold for a fixed term, not evergreen) — without this, Gap Analysis
    // projected every active template all the way to December regardless of
    // whether QBO says it actually stops billing sooner.
    await c.query(`ALTER TABLE qbo_recurring_invoices ADD COLUMN IF NOT EXISTS end_date TEXT`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_qbo_recurring_invoices_customer ON qbo_recurring_invoices (customer_id)`);
    // Payments exploded to one row per invoice they were applied to — lets
    // us measure each customer's REAL historical days-to-pay (payment date
    // minus invoice date) so AR collection timing is based on how that
    // customer actually pays, not just their stated terms.
    await c.query(`
      CREATE TABLE IF NOT EXISTS qbo_payments (
        payment_id TEXT NOT NULL,
        invoice_id TEXT NOT NULL,
        customer_id TEXT,
        txn_date TEXT,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (payment_id, invoice_id)
      )`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_qbo_payments_customer ON qbo_payments (customer_id)`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_qbo_payments_invoice ON qbo_payments (invoice_id)`);

    console.log(`import-qbo-invoices-sync${dryRun ? " (dry-run)" : ""}`);
    const qbo = new QboClient(c);
    if (!dryRun) await qbo.connect();

    if (dryRun) {
      console.log("  would sync QBO customers, invoices, recurring invoice templates, and payments");
      // A dry run holds no QuickBooks connection, so it cannot read the
      // invoices or their count and therefore cannot say which rows the
      // reconciliation would close. Saying so beats printing a plan built on
      // nothing -- a dry-run preview that guesses is worse than one that
      // declines.
      console.log("  would then reconcile: any open invoice a complete read no longer returns is zeroed, with the reason and the balance kept on the row. A dry run reads nothing from QuickBooks, so it cannot say which rows those are.");
      reconcileSummary = "Dry run \u2014 nothing read, nothing reconciled.";
      return;
    }

    const customers = await qbo.getCustomers();
    for (const cust of customers) {
      await c.query(
        `INSERT INTO qbo_customers (id, name, fully_qualified_name, parent_id, synced_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, fully_qualified_name = EXCLUDED.fully_qualified_name,
           parent_id = EXCLUDED.parent_id, synced_at = now()`,
        [cust.id, cust.name, cust.fullyQualifiedName, cust.parentId],
      );
    }
    console.log(`  ✓ ${customers.length} customer(s)`);

    const invoices = await qbo.getInvoices();
    // True exactly when the call returned. getInvoices() pages through the
    // whole company file and QboClient.call throws on any non-2xx, so a page
    // that fails never gets here -- but the reconciliation below must not rest
    // on a property of code in another file, so the fact is stated where it is
    // known. The read that succeeds and is still SHORT is a different failure
    // and is caught by QuickBooks' own count, not by this flag.
    const invoiceFetchCompleted = true;
    for (const inv of invoices) {
      await c.query(
        `INSERT INTO qbo_invoices (id, customer_id, customer_name, doc_number, txn_date, due_date, total_cents, balance_cents, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (id) DO UPDATE SET customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
           doc_number = EXCLUDED.doc_number, txn_date = EXCLUDED.txn_date, due_date = EXCLUDED.due_date,
           total_cents = EXCLUDED.total_cents, balance_cents = EXCLUDED.balance_cents, synced_at = now(),
           -- An invoice QuickBooks is returning again is not a closed one. The
           -- mark ends itself here rather than needing anybody to clear it,
           -- the same way the app's own staging flags do.
           sync_closed_at = NULL, sync_closed_reason = NULL, sync_closed_balance_cents = NULL`,
        [inv.id, inv.customerId, inv.customerName, inv.docNumber, inv.txnDate, inv.dueDate, toCents(inv.totalAmt), toCents(inv.balance)],
      );
    }
    console.log(`  ✓ ${invoices.length} invoice(s)`);

    // ── Reconciliation: the closing half the upsert above has never had ──
    //
    // Reading every invoice and upserting it takes a PAID invoice to zero by
    // itself (QuickBooks returns it with Balance 0). What it cannot see is an
    // invoice QuickBooks has stopped returning entirely -- a deleted one is
    // simply absent from the query -- and a row nothing writes keeps the
    // balance the last sync that saw it wrote, for ever. That is the whole
    // reason the dashboard's overdue card disagreed with the owner's own
    // QuickBooks export by three rows and $11,737.06 on 2026-09-21.
    //
    // Every rule is in src/qbo/invoice-reconcile.ts, pure, including the three
    // proofs a run has to pass before it may zero anything. Nothing here
    // decides; it gathers, prints the plan, and writes exactly what the plan
    // says. Never a DELETE, and never a touch of synced_at: QuickBooks did not
    // confirm a zero balance, this run inferred one from absence, and
    // shared/invoice-confirmation.ts reads that column to tell those apart.
    //
    // The count is asked for AFTER the fetch on purpose (see the module), and
    // its own failure must not take the sync down with it -- it is an extra
    // guard, so a count that cannot be read refuses the reconciliation and
    // leaves everything else exactly as it was.
    let quickBooksCount: number | null = null;
    try {
      quickBooksCount = await qbo.countInvoices();
    } catch (e) {
      console.log(`  … couldn't ask QuickBooks how many invoices it holds: ${e instanceof Error ? e.message : e}`);
    }
    const { rows: openRows } = await c.query<{ id: string; doc_number: string | null; customer_name: string | null; balance_cents: number }>(
      `SELECT id, doc_number, customer_name, balance_cents FROM qbo_invoices WHERE balance_cents > 0`,
    );
    const plan = planInvoiceReconcile({
      fetchedIds: invoices.map((i) => i.id),
      fetchCompleted: invoiceFetchCompleted,
      quickBooksCount,
      openRows: openRows.map((r): OpenInvoiceRow => ({
        id: r.id, docNumber: r.doc_number, customerName: r.customer_name, balanceCents: Number(r.balance_cents),
      })),
      today: new Date().toISOString().slice(0, 10),
    });
    console.log(`  reconcile — read ${plan.window}`);
    if (!plan.act) {
      console.log(`  ⚠ ${plan.refusal}`);
    } else {
      for (const line of closeLines(plan)) console.log(line);
      for (const row of plan.close) {
        await c.query(
          `UPDATE qbo_invoices
              SET balance_cents = 0,
                  sync_closed_at = now(),
                  sync_closed_reason = $2,
                  sync_closed_balance_cents = $3
            WHERE id = $1 AND balance_cents = $3`,
          [row.id, row.reason, row.balanceCents],
        );
      }
      console.log(`  ✓ ${plan.summary}`);
    }
    reconcileSummary = plan.summary;

    const payments = await qbo.getPayments();
    for (const p of payments) {
      await c.query(
        `INSERT INTO qbo_payments (payment_id, invoice_id, customer_id, txn_date, amount_cents, synced_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (payment_id, invoice_id) DO UPDATE SET customer_id = EXCLUDED.customer_id, txn_date = EXCLUDED.txn_date,
           amount_cents = EXCLUDED.amount_cents, synced_at = now()`,
        [p.paymentId, p.invoiceId, p.customerId, p.txnDate, toCents(p.amount)],
      );
    }
    console.log(`  ✓ ${payments.length} payment-to-invoice application(s)`);

    const recurring = (await qbo.getRecurringInvoiceTemplates()) as RecurringTransactionRow[];
    let recurringSynced = 0;
    const seenIds: string[] = [];
    for (const row of recurring) {
      const tmpl = row.Invoice;
      if (!tmpl) continue; // not an invoice-type recurring transaction (could be Bill, SalesReceipt, etc.)
      const amountCents = tmpl.TotalAmt != null ? toCents(tmpl.TotalAmt) : toCents((tmpl.Line ?? []).reduce((s, l) => s + (l.Amount ?? 0), 0));
      const info = tmpl.RecurringInfo;
      const schedule = info?.ScheduleInfo;
      const id = tmpl.Id ?? randomUUID();
      seenIds.push(id);
      await c.query(
        `INSERT INTO qbo_recurring_invoices (id, customer_id, customer_name, template_name, amount_cents, active, interval_type, num_interval, start_date, next_date, previous_date, end_date, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
         ON CONFLICT (id) DO UPDATE SET customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
           template_name = EXCLUDED.template_name, amount_cents = EXCLUDED.amount_cents, active = EXCLUDED.active,
           interval_type = EXCLUDED.interval_type, num_interval = EXCLUDED.num_interval, start_date = EXCLUDED.start_date,
           next_date = EXCLUDED.next_date, previous_date = EXCLUDED.previous_date, end_date = EXCLUDED.end_date, synced_at = now()`,
        [
          id, tmpl.CustomerRef?.value ?? null, tmpl.CustomerRef?.name ?? null, info?.Name ?? null,
          amountCents, info?.Active !== false, schedule?.IntervalType ?? null, schedule?.NumInterval ?? 1,
          schedule?.StartDate ?? null, schedule?.NextDate ?? null, schedule?.PreviousDate ?? null, schedule?.EndDate ?? null,
        ],
      );
      recurringSynced++;
    }
    console.log(`  ✓ ${recurringSynced} recurring invoice template(s) (of ${recurring.length} recurring transaction(s) total)`);
    // QBO's unfiltered `SELECT * FROM RecurringTransaction` silently drops a
    // template the moment it's deleted/deactivated in QBO — it just stops
    // appearing in the response, so the upsert above never touches that row
    // again and it sits `active = true` with stale dates forever. Sweep: any
    // row this sync didn't just see is no longer in QBO, so mark it inactive.
    // Skipped if QBO returned nothing at all — far more likely an API hiccup
    // than every single template having vanished, and an empty result here
    // must never wipe out the whole table.
    if (recurringSynced > 0) {
      const { rowCount } = await c.query(
        `UPDATE qbo_recurring_invoices SET active = false WHERE active = true AND NOT (id = ANY($1::text[]))`,
        [seenIds],
      );
      if (rowCount) console.log(`  ✓ deactivated ${rowCount} recurring template(s) no longer in QBO`);
    } else {
      console.log("  ⚠ QBO returned zero recurring templates — skipping the deactivation sweep");
    }
    console.log("Done.");
  } finally {
    await c.end();
    // The workflow reads this back as --note= on the heartbeat step, which
    // runs with if: always(), so a refusal is recorded just as loudly as a
    // clean pass.
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `summary=${reconcileSummary.replace(/[\r\n]+/g, " ")}\n`);
    }
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

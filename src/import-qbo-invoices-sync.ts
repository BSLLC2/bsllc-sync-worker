#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { QboClient } from "./qbo.js";

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
interface RecurringScheduleInfo { IntervalType?: string; NumInterval?: number; NextDate?: string; PreviousDate?: string; EndDate?: string }
interface RecurringInfo { Name?: string; Active?: boolean; ScheduleInfo?: RecurringScheduleInfo }
interface RecurringInvoiceTemplate { Id?: string; CustomerRef?: { value?: string; name?: string }; Line?: { Amount?: number }[]; TotalAmt?: number; RecurringInfo?: RecurringInfo }
interface RecurringTransactionRow { Invoice?: RecurringInvoiceTemplate }

function toCents(n: number): number { return Math.round(n * 100); }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
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
    for (const inv of invoices) {
      await c.query(
        `INSERT INTO qbo_invoices (id, customer_id, customer_name, doc_number, txn_date, due_date, total_cents, balance_cents, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (id) DO UPDATE SET customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
           doc_number = EXCLUDED.doc_number, txn_date = EXCLUDED.txn_date, due_date = EXCLUDED.due_date,
           total_cents = EXCLUDED.total_cents, balance_cents = EXCLUDED.balance_cents, synced_at = now()`,
        [inv.id, inv.customerId, inv.customerName, inv.docNumber, inv.txnDate, inv.dueDate, toCents(inv.totalAmt), toCents(inv.balance)],
      );
    }
    console.log(`  ✓ ${invoices.length} invoice(s)`);

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
        `INSERT INTO qbo_recurring_invoices (id, customer_id, customer_name, template_name, amount_cents, active, interval_type, num_interval, next_date, previous_date, end_date, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
         ON CONFLICT (id) DO UPDATE SET customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
           template_name = EXCLUDED.template_name, amount_cents = EXCLUDED.amount_cents, active = EXCLUDED.active,
           interval_type = EXCLUDED.interval_type, num_interval = EXCLUDED.num_interval,
           next_date = EXCLUDED.next_date, previous_date = EXCLUDED.previous_date, end_date = EXCLUDED.end_date, synced_at = now()`,
        [
          id, tmpl.CustomerRef?.value ?? null, tmpl.CustomerRef?.name ?? null, info?.Name ?? null,
          amountCents, info?.Active !== false, schedule?.IntervalType ?? null, schedule?.NumInterval ?? 1,
          schedule?.NextDate ?? null, schedule?.PreviousDate ?? null, schedule?.EndDate ?? null,
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
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

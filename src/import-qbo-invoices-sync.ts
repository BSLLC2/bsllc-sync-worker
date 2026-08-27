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
 * This job reads QBO's real Customer/Invoice/RecurringTransaction lists
 * (read-only, same OAuth scope already used) into three local tables so the
 * dashboard can check "has this company actually been invoiced or put on a
 * recurring invoice in QBO" without the app ever calling QBO directly.
 *
 *   npm run import-qbo-invoices-sync
 *   npm run import-qbo-invoices-sync -- --dry-run
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

// QBO's RecurringTransaction query response nests the actual template under
// a key named after its txn type ("Invoice"), alongside a shared RecurringInfo
// block. Loose/defensive parsing since Intuit's own docs for this entity are
// thin — logs the raw shape of the first row so a live run can confirm it.
interface RecurringInfo { Name?: string; Active?: boolean; Type?: string }
interface RecurringInvoiceTemplate { Id?: string; CustomerRef?: { value?: string; name?: string }; Line?: { Amount?: number }[]; TotalAmt?: number }
interface RecurringTransactionRow { RecurringInfo?: RecurringInfo; Invoice?: RecurringInvoiceTemplate }

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
        `INSERT INTO qbo_customers (id, name, synced_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, synced_at = now()`,
        [cust.id, cust.name],
      );
    }
    console.log(`  ✓ ${customers.length} customer(s)`);

    const invoices = await qbo.getInvoices();
    for (const inv of invoices) {
      await c.query(
        `INSERT INTO qbo_invoices (id, customer_id, customer_name, doc_number, txn_date, total_cents, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (id) DO UPDATE SET customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
           doc_number = EXCLUDED.doc_number, txn_date = EXCLUDED.txn_date, total_cents = EXCLUDED.total_cents, synced_at = now()`,
        [inv.id, inv.customerId, inv.customerName, inv.docNumber, inv.txnDate, toCents(inv.totalAmt)],
      );
    }
    console.log(`  ✓ ${invoices.length} invoice(s)`);

    const recurring = (await qbo.getRecurringInvoiceTemplates()) as RecurringTransactionRow[];
    if (recurring.length > 0) {
      console.log(`  (debug) first recurring-transaction row shape: ${JSON.stringify(recurring[0]).slice(0, 800)}`);
    }
    let recurringSynced = 0;
    for (const row of recurring) {
      const tmpl = row.Invoice;
      if (!tmpl) continue; // not an invoice-type recurring transaction (could be Bill, SalesReceipt, etc.)
      const amountCents = tmpl.TotalAmt != null ? toCents(tmpl.TotalAmt) : toCents((tmpl.Line ?? []).reduce((s, l) => s + (l.Amount ?? 0), 0));
      await c.query(
        `INSERT INTO qbo_recurring_invoices (id, customer_id, customer_name, template_name, amount_cents, active, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (id) DO UPDATE SET customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
           template_name = EXCLUDED.template_name, amount_cents = EXCLUDED.amount_cents, active = EXCLUDED.active, synced_at = now()`,
        [tmpl.Id ?? randomUUID(), tmpl.CustomerRef?.value ?? null, tmpl.CustomerRef?.name ?? null, row.RecurringInfo?.Name ?? null, amountCents, row.RecurringInfo?.Active !== false],
      );
      recurringSynced++;
    }
    console.log(`  ✓ ${recurringSynced} recurring invoice template(s) (of ${recurring.length} recurring transaction(s) total)`);
    console.log("Done.");
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

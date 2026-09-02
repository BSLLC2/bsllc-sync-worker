#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: LBL Law is linked (company_qbo_customers + its recurring
 * template is projectable per debug-scheduled-revenue-gaps.ts) but the user
 * says it's not showing in the September Scheduled breakdown. The template's
 * next_date is 2026-10-01, meaning the projector correctly does NOT count it
 * toward September -- but that's only correct if LBL's September invoice
 * already exists as real, counted revenue (Actual). If it doesn't, LBL's
 * September dollars are falling into a real gap between "already billed" and
 * "still scheduled". Checking both directly instead of guessing again.
 *
 *   npm run debug-lbl-scheduled-gap
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: templates } = await c.query(
      `SELECT id, customer_id, customer_name, template_name, amount_cents, interval_type, num_interval,
              start_date, next_date, previous_date, end_date, synced_at
         FROM qbo_recurring_invoices WHERE customer_name ILIKE '%LBL%'`,
    );
    console.log(`${templates.length} qbo_recurring_invoices row(s) matching LBL:`);
    for (const t of templates) console.log(JSON.stringify(t, null, 2));

    const customerIds = templates.map((t) => t.customer_id).filter(Boolean);
    if (customerIds.length) {
      const { rows: invoices } = await c.query(
        `SELECT id, customer_id, customer_name, doc_number, txn_date, due_date, total_cents, balance_cents, synced_at
           FROM qbo_invoices WHERE customer_id = ANY($1::text[]) ORDER BY txn_date DESC LIMIT 10`,
        [customerIds],
      );
      console.log(`\n${invoices.length} most recent qbo_invoices row(s) for LBL's customer id(s):`);
      for (const inv of invoices) console.log(JSON.stringify(inv, null, 2));
    }

    const { rows: companyLinks } = await c.query(
      `SELECT co.name AS company_name, co.id AS company_id, co.client_id, cqc.qbo_customer_id
         FROM company_qbo_customers cqc JOIN companies co ON co.id = cqc.company_id
        WHERE co.name ILIKE '%LBL%'`,
    );
    console.log(`\n${companyLinks.length} company_qbo_customers row(s) for LBL company:`);
    for (const l of companyLinks) console.log(JSON.stringify(l));

    const { rows: recurringLinks } = await c.query(
      `SELECT co.name AS company_name, cqr.qbo_recurring_invoice_id
         FROM company_qbo_recurring_invoices cqr JOIN companies co ON co.id = cqr.company_id
        WHERE co.name ILIKE '%LBL%'`,
    );
    console.log(`\n${recurringLinks.length} company_qbo_recurring_invoices row(s) for LBL company:`);
    for (const l of recurringLinks) console.log(JSON.stringify(l));

    // Latest P&L snapshot for the current month -- does the aggregate
    // "Actual" figure the Gap Analysis uses even cover September yet?
    const { rows: pnl } = await c.query(
      `SELECT report_type, period_type, period_start, period_end, synced_at
         FROM financial_snapshots WHERE report_type = 'profit_and_loss' ORDER BY synced_at DESC LIMIT 5`,
    );
    console.log(`\n5 most recent profit_and_loss financial_snapshots rows (any period_type):`);
    for (const p of pnl) console.log(JSON.stringify(p));
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

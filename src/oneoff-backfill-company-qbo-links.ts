#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * One-off backfill: import-qbo-invoices.ts now auto-links a quote's company
 * to the QBO customer/recurring template it creates, but that only fires on
 * a future run of that script -- every quote already synced before this fix
 * (Integrus included, confirmed missing its link live this session) never
 * got the link written. Walks every already-synced quote and creates
 * whatever's missing.
 *
 *   npm run oneoff-backfill-company-qbo-links -- --dry-run   (read-only)
 *   npm run oneoff-backfill-company-qbo-links                (applies)
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query<{
      id: string; client_name: string; company_id: string | null;
      qbo_invoice_id: string | null; qbo_recurring_template_id: string | null;
    }>(
      `SELECT id, client_name, company_id, qbo_invoice_id, qbo_recurring_template_id
         FROM pricing_quotes
        WHERE company_id IS NOT NULL AND (qbo_invoice_id IS NOT NULL OR qbo_recurring_template_id IS NOT NULL)`,
    );
    console.log(`${rows.length} already-synced quote(s) with a company to check.`);

    let customerLinksAdded = 0, recurringLinksAdded = 0;
    for (const r of rows) {
      if (!r.company_id) continue;

      // The QBO customer id isn't stored on the quote directly -- recover it
      // from whichever real QBO object we already created for this quote.
      let customerId: string | null = null;
      if (r.qbo_invoice_id) {
        const { rows: inv } = await c.query<{ customer_id: string | null }>(
          `SELECT customer_id FROM qbo_invoices WHERE id = $1`, [r.qbo_invoice_id],
        );
        customerId = inv[0]?.customer_id ?? null;
      }
      if (!customerId && r.qbo_recurring_template_id) {
        const { rows: rec } = await c.query<{ customer_id: string | null }>(
          `SELECT customer_id FROM qbo_recurring_invoices WHERE id = $1`, [r.qbo_recurring_template_id],
        );
        customerId = rec[0]?.customer_id ?? null;
      }

      if (customerId) {
        const { rows: existing } = await c.query(
          `SELECT id FROM company_qbo_customers WHERE company_id = $1 AND qbo_customer_id = $2`, [r.company_id, customerId],
        );
        if (!existing.length) {
          console.log(`  ${r.client_name}: link company ${r.company_id} → QBO customer ${customerId}`);
          if (!dryRun) {
            await c.query(`INSERT INTO company_qbo_customers (id, company_id, qbo_customer_id) VALUES ($1, $2, $3)`, [randomUUID(), r.company_id, customerId]);
          }
          customerLinksAdded++;
        }
      } else if (r.qbo_invoice_id || r.qbo_recurring_template_id) {
        console.log(`  ${r.client_name}: has a QBO invoice/template id but the customer isn't in qbo_invoices/qbo_recurring_invoices yet -- run import-qbo-invoices-sync first, then re-run this.`);
      }

      if (r.qbo_recurring_template_id) {
        const { rows: existing } = await c.query(
          `SELECT id FROM company_qbo_recurring_invoices WHERE company_id = $1 AND qbo_recurring_invoice_id = $2`,
          [r.company_id, r.qbo_recurring_template_id],
        );
        if (!existing.length) {
          console.log(`  ${r.client_name}: link company ${r.company_id} → QBO recurring template ${r.qbo_recurring_template_id}`);
          if (!dryRun) {
            await c.query(
              `INSERT INTO company_qbo_recurring_invoices (id, company_id, qbo_recurring_invoice_id) VALUES ($1, $2, $3)`,
              [randomUUID(), r.company_id, r.qbo_recurring_template_id],
            );
          }
          recurringLinksAdded++;
        }
      }
    }
    console.log(`\n${dryRun ? "Would add" : "Added"} ${customerLinksAdded} customer link(s), ${recurringLinksAdded} recurring-template link(s).`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

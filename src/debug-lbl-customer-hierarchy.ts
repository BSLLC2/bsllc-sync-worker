#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * LBL's linked QBO customer (7102, "LBL The Medical Injury Law Firm |
 * Northern Kentucky & Ohio") has only 4 real qbo_invoices on file, all
 * ~$250 and dated 2025, despite a $12,500/month recurring template with a
 * near-future next_date. Same class of bug documented in this repo's own
 * history (commit "Capture QBO's real customer hierarchy"): a sub-customer
 * can bill under its OWN numeric CustomerRef, distinct from its parent's, so
 * the real retainer invoices may be sitting under a child customer id we
 * never linked. Checking directly instead of guessing further.
 *
 *   npm run debug-lbl-customer-hierarchy
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: root } = await c.query(
      `SELECT id, name, fully_qualified_name, parent_id FROM qbo_customers WHERE id = '7102'`,
    );
    console.log(`LBL's linked customer (7102):`, JSON.stringify(root[0] ?? null));

    const { rows: children } = await c.query(
      `SELECT id, name, fully_qualified_name, parent_id FROM qbo_customers WHERE parent_id = '7102'`,
    );
    console.log(`\n${children.length} QBO sub-customer(s) with parent_id = 7102:`);
    for (const ch of children) console.log(JSON.stringify(ch));

    const { rows: byName } = await c.query(
      `SELECT id, name, fully_qualified_name, parent_id FROM qbo_customers WHERE name ILIKE '%LBL%' OR fully_qualified_name ILIKE '%LBL%'`,
    );
    console.log(`\n${byName.length} qbo_customers row(s) matching "LBL" by name or fully_qualified_name:`);
    for (const b of byName) console.log(JSON.stringify(b));

    const candidateIds = Array.from(new Set([...children.map((c2) => c2.id), ...byName.map((b) => b.id)]));
    if (candidateIds.length) {
      const { rows: invoices } = await c.query(
        `SELECT customer_id, customer_name, COUNT(*) AS n, SUM(total_cents) AS total_cents, MAX(txn_date) AS latest
           FROM qbo_invoices WHERE customer_id = ANY($1::text[]) GROUP BY customer_id, customer_name`,
        [candidateIds],
      );
      console.log(`\nInvoice totals for every candidate customer id:`);
      for (const inv of invoices) console.log(JSON.stringify(inv));
    }

    // Also check the recurring template itself points at 7102, not a child.
    const { rows: tmpl } = await c.query(
      `SELECT id, customer_id, customer_name, template_name, amount_cents FROM qbo_recurring_invoices WHERE customer_name ILIKE '%LBL%'`,
    );
    console.log(`\nRecurring template CustomerRef:`, JSON.stringify(tmpl));
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

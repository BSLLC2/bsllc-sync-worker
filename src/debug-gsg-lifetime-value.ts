#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * User reports Government Strategies Group's Lifetime Value shows $4k in
 * the app, but the real QuickBooks customer record has far more billing
 * history (visible directly in the QBO mobile app). They tried linking it
 * via "Related companies" (CRM parent/child) to a company matching search
 * "CSG Government Solutions" -- but that's the wrong picker for a QBO
 * customer link (parent/child only shares clientId, it doesn't touch
 * company_qbo_customers). Checking the real state directly: is GSG linked
 * to any QBO customer at all, is the linked one wrong/thin, and does a QBO
 * customer actually named something like "CSG Government Solutions" exist
 * with GSG's real invoice history under it -- same class of bug as
 * LBL/Exeter.
 *
 *   npm run debug-gsg-lifetime-value
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: companyRows } = await c.query(
      `SELECT id, name, client_id, parent_company_id, qbo_customer_id FROM companies WHERE name ILIKE '%government strateg%'`,
    );
    console.log(`companies matching "Government Strateg%":`, JSON.stringify(companyRows, null, 2));

    for (const co of companyRows) {
      const { rows: links } = await c.query(
        `SELECT cqc.qbo_customer_id, qc.name, qc.fully_qualified_name, qc.parent_id
           FROM company_qbo_customers cqc LEFT JOIN qbo_customers qc ON qc.id = cqc.qbo_customer_id
          WHERE cqc.company_id = $1`,
        [co.id],
      );
      console.log(`\ncompany_qbo_customers for "${co.name}" (${co.id}):`, JSON.stringify(links, null, 2));
      const custIds = links.map((l) => l.qbo_customer_id);
      if (custIds.length) {
        const { rows: invTotals } = await c.query(
          `SELECT customer_id, customer_name, COUNT(*) AS n, SUM(total_cents) AS total_cents, MIN(txn_date) AS earliest, MAX(txn_date) AS latest
             FROM qbo_invoices WHERE customer_id = ANY($1::text[]) GROUP BY customer_id, customer_name`,
          [custIds],
        );
        console.log(`Invoice totals for linked customer id(s):`, JSON.stringify(invTotals, null, 2));
      }
      const { rows: deals } = await c.query(
        `SELECT id, name, status, amount_cents, closed_at FROM deals WHERE company_id = $1 AND status = 'won'`,
        [co.id],
      );
      console.log(`Closed Won deals for "${co.name}":`, JSON.stringify(deals, null, 2));
    }

    // Look for any QBO customer that could plausibly be GSG's real record --
    // by name (GSG / Government Strategies) AND by name (CSG Government
    // Solutions, the suggested match from the parent-company search).
    const { rows: byName } = await c.query(
      `SELECT id, name, fully_qualified_name, parent_id FROM qbo_customers
        WHERE name ILIKE '%government strateg%' OR name ILIKE '%GSG%' OR name ILIKE '%CSG Government%' OR fully_qualified_name ILIKE '%government strateg%' OR fully_qualified_name ILIKE '%CSG Government%'`,
    );
    console.log(`\nqbo_customers matching GSG/CSG Government by name:`, JSON.stringify(byName, null, 2));
    if (byName.length) {
      const ids = byName.map((b) => b.id);
      const { rows: invTotals2 } = await c.query(
        `SELECT customer_id, customer_name, COUNT(*) AS n, SUM(total_cents) AS total_cents, MIN(txn_date) AS earliest, MAX(txn_date) AS latest
           FROM qbo_invoices WHERE customer_id = ANY($1::text[]) GROUP BY customer_id, customer_name`,
        [ids],
      );
      console.log(`Invoice totals for those candidate customer ids:`, JSON.stringify(invTotals2, null, 2));
    }

    // Any CRM company literally named "CSG Government Solutions"?
    const { rows: csgCompany } = await c.query(
      `SELECT id, name, client_id, parent_company_id, qbo_customer_id FROM companies WHERE name ILIKE '%CSG Government%'`,
    );
    console.log(`\nCRM companies matching "CSG Government%":`, JSON.stringify(csgCompany, null, 2));
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * debug-lbl-customer-hierarchy.ts confirmed LBL's real QBO billing spans 5
 * customer records (7102 the parent, plus sub-customers 7663/7106/7797/7902),
 * but company_qbo_customers only linked the LBL Law CRM company to 7102.
 * Customer 7106 alone ("The Lawrence Firm Marketing Strategy") carries
 * $137,800 of real, currently-unlinked invoices. Linking the remaining four
 * so Lifetime Value / Scheduled / Billing all resolve LBL's full family.
 *
 *   npm run oneoff-link-lbl-qbo-customers -- --dry-run
 *   npm run oneoff-link-lbl-qbo-customers
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

const SUB_CUSTOMER_IDS = ["7663", "7106", "7797", "7902"];

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: companies } = await c.query(
      `SELECT co.id, co.name
         FROM companies co
         JOIN company_qbo_customers cqc ON cqc.company_id = co.id
        WHERE cqc.qbo_customer_id = '7102'`,
    );
    if (companies.length === 0) throw new Error("No company is linked to QBO customer 7102 -- nothing to backfill onto.");
    console.log(`Company linked to QBO customer 7102: ${JSON.stringify(companies)}`);

    const { rows: existing } = await c.query(
      `SELECT company_id, qbo_customer_id FROM company_qbo_customers WHERE qbo_customer_id = ANY($1::text[])`,
      [SUB_CUSTOMER_IDS],
    );
    console.log(`\nAlready-linked rows among the 4 sub-customers: ${JSON.stringify(existing)}`);

    for (const company of companies) {
      for (const custId of SUB_CUSTOMER_IDS) {
        const already = existing.some((r) => r.company_id === company.id && r.qbo_customer_id === custId);
        if (already) {
          console.log(`  [skip] ${company.name} already linked to ${custId}`);
          continue;
        }
        console.log(`  [${dryRun ? "DRY-RUN" : "APPLY"}] link company "${company.name}" (${company.id}) -> QBO customer ${custId}`);
        if (!dryRun) {
          await c.query(
            `INSERT INTO company_qbo_customers (id, company_id, qbo_customer_id, created_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (company_id, qbo_customer_id) DO NOTHING`,
            [randomUUID(), company.id, custId],
          );
        }
      }
    }

    const { rows: subTemplates } = await c.query(
      `SELECT id, customer_id, customer_name, template_name, amount_cents, active, start_date, next_date, previous_date
         FROM qbo_recurring_invoices WHERE customer_id = ANY($1::text[])`,
      [SUB_CUSTOMER_IDS],
    );
    console.log(`\n${subTemplates.length} recurring template(s) on the 4 sub-customer ids (any not yet linked at the template level will still be missing from the Scheduled breakdown even after this company-level link):`);
    for (const t of subTemplates) console.log(JSON.stringify(t));

    if (!dryRun) {
      const { rows: after } = await c.query(
        `SELECT cqc.qbo_customer_id, qc.name
           FROM company_qbo_customers cqc
           JOIN qbo_customers qc ON qc.id = cqc.qbo_customer_id
          WHERE cqc.company_id = ANY($1::text[])
          ORDER BY cqc.qbo_customer_id`,
        [companies.map((c2) => c2.id)],
      );
      console.log(`\nFinal company_qbo_customers rows for LBL:`, JSON.stringify(after, null, 2));
    } else {
      console.log(`\nDry run only -- no writes made. Re-run without --dry-run to apply.`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

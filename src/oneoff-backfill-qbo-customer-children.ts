#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * The app's addCompanyQboLink now auto-sweeps in a QBO customer's known
 * sub-customers (by parentId) whenever a NEW link is made -- but any link
 * created BEFORE that fix (e.g. Government Strategies Group -> QBO customer
 * 901, made months ago) never got its children backfilled. GSG's real
 * billing sits split across 901 (parent, linked) + 1069/902/7007 (children,
 * unlinked) -- same class of gap as LBL. Sweeping every EXISTING
 * company_qbo_customers link's children in one pass instead of waiting to
 * discover each one by hand.
 *
 *   npm run oneoff-backfill-qbo-customer-children -- --dry-run
 *   npm run oneoff-backfill-qbo-customer-children
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: links } = await c.query(
      `SELECT cqc.company_id, cqc.qbo_customer_id, co.name AS company_name
         FROM company_qbo_customers cqc JOIN companies co ON co.id = cqc.company_id`,
    );
    console.log(`${links.length} existing company_qbo_customers link(s) to check for unlinked children.`);

    let totalNewLinks = 0;
    const affectedCompanies = new Set<string>();
    for (const link of links) {
      const { rows: children } = await c.query(
        `SELECT id, name FROM qbo_customers WHERE parent_id = $1`,
        [link.qbo_customer_id],
      );
      if (children.length === 0) continue;
      const { rows: alreadyLinked } = await c.query(
        `SELECT qbo_customer_id FROM company_qbo_customers WHERE company_id = $1 AND qbo_customer_id = ANY($2::text[])`,
        [link.company_id, children.map((ch) => ch.id)],
      );
      const alreadyLinkedIds = new Set(alreadyLinked.map((r) => r.qbo_customer_id));
      const missing = children.filter((ch) => !alreadyLinkedIds.has(ch.id));
      if (missing.length === 0) continue;
      affectedCompanies.add(link.company_name);
      for (const ch of missing) {
        console.log(`  [${dryRun ? "DRY-RUN" : "APPLY"}] link "${link.company_name}" -> QBO customer ${ch.id} ("${ch.name}") -- child of already-linked ${link.qbo_customer_id}`);
        totalNewLinks++;
        if (!dryRun) {
          await c.query(
            `INSERT INTO company_qbo_customers (id, company_id, qbo_customer_id, created_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (company_id, qbo_customer_id) DO NOTHING`,
            [randomUUID(), link.company_id, ch.id],
          );
        }
      }
    }
    console.log(`\n${totalNewLinks} new link(s) across ${affectedCompanies.size} compan${affectedCompanies.size === 1 ? "y" : "ies"}: ${Array.from(affectedCompanies).join(", ") || "none"}.`);
    if (dryRun) console.log(`Dry run only -- no writes made. Re-run without --dry-run to apply.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

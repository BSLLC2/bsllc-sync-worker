#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: the Gap Analysis Scheduled breakdown shows a Closed Won line
 * labeled "Colorado School of Clinical Herbalism — Newsletter Copywriting
 * (SOW 02)" that the user says doesn't match the deal's actual name in the
 * system. getScheduledBreakdown's label comes from
 * dealNameById.get(schedule.dealId) -- i.e. whatever the deals row CURRENTLY
 * says, live, not a cached/stale value. So either the deal really is named
 * that (and the user just doesn't recognize a legacy/system-generated name),
 * or the revenue_schedules row's deal_id points at the WRONG deal (e.g. a
 * duplicate/leftover row from a data import). Dumping both to see which.
 *
 *   npm run debug-colorado-herbalism-schedule
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: deals } = await c.query(
      `SELECT id, name, status, stage, amount_cents, billing_structure, one_time_amount_cents,
              monthly_retainer_cents, close_date, company_id, created_at
         FROM deals WHERE name ILIKE '%herbalism%' OR name ILIKE '%colorado school%' OR name ILIKE '%SOW 02%'
         ORDER BY created_at`,
    );
    console.log(`${deals.length} matching deal(s) by name:`);
    for (const d of deals) console.log(JSON.stringify(d, null, 2));

    const dealIds = deals.map((d) => d.id);
    if (dealIds.length) {
      const { rows: schedules } = await c.query(
        `SELECT * FROM revenue_schedules WHERE deal_id = ANY($1::text[]) ORDER BY created_at`, [dealIds],
      );
      console.log(`\n${schedules.length} revenue_schedules row(s) tied to those deal ids:`);
      for (const s of schedules) console.log(JSON.stringify(s, null, 2));
    }

    // Also check by company, in case the deal was renamed and no longer
    // matches the name search above, but the company still does.
    const { rows: companies } = await c.query(
      `SELECT id, name FROM companies WHERE name ILIKE '%herbalism%' OR name ILIKE '%colorado school%'`,
    );
    console.log(`\n${companies.length} matching compan(ies):`);
    for (const co of companies) {
      console.log(JSON.stringify(co));
      const { rows: dealsForCo } = await c.query(
        `SELECT id, name, status, amount_cents, monthly_retainer_cents, created_at FROM deals WHERE company_id = $1 ORDER BY created_at`, [co.id],
      );
      console.log(`  ${dealsForCo.length} deal(s) for this company:`);
      for (const d of dealsForCo) console.log(`    ${JSON.stringify(d)}`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

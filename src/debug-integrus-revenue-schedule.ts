#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: dumps Integrus's deal billing fields + revenue_schedules rows,
 * to see why the Gap Analysis is counting their $5,000/month retainer as a
 * single $60,000 lump in September instead of $5,000/month.
 *
 * createRevenueScheduleForDeal (server/storage.ts) prefers the deal's
 * explicit oneTimeAmountCents/monthlyRetainerCents split; only when BOTH are
 * null does it fall back to a billingStructure heuristic on amountCents
 * (recurring if "Monthly retainer"/"Subscription", else one_time for the
 * FULL amount) -- that fallback landing on one_time is the likely cause.
 *
 *   npm run debug-integrus-revenue-schedule
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: deals } = await c.query(
      `SELECT id, name, status, stage, amount_cents, billing_structure, one_time_amount_cents,
              monthly_retainer_cents, retainer_term_months, close_date, company_id
         FROM deals WHERE name ILIKE '%integrus%' OR id IN (
           SELECT deal_id FROM revenue_schedules WHERE client_id IN (
             SELECT id FROM clients WHERE name ILIKE '%integrus%'
           )
         )`,
    );
    console.log(`${deals.length} matching deal(s):`);
    for (const d of deals) console.log(JSON.stringify(d, null, 2));

    const dealIds = deals.map((d) => d.id);
    if (dealIds.length) {
      const { rows: schedules } = await c.query(
        `SELECT * FROM revenue_schedules WHERE deal_id = ANY($1::text[]) ORDER BY created_at`, [dealIds],
      );
      console.log(`\n${schedules.length} revenue_schedules row(s):`);
      for (const s of schedules) console.log(JSON.stringify(s, null, 2));
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Revenue schedules only ever get created inside the app's updateDeal(),
 * on the actual open->won transition (server/storage.ts). Any deal that
 * arrived already Closed Won -- e.g. imported straight from HubSpot's own
 * closed history -- never passed through that transition, so it never got
 * a revenue_schedules row at all. A first pass of this found 372 such
 * deals totaling $4.89M -- but most of that is old one-time engagements
 * that are done and fully collected, not missing FUTURE cash. What
 * actually matters for the Scheduled breakdown is the RECURRING subset
 * still inside (or past, with no end date) its retainer term -- that's
 * real ongoing revenue invisible to Gap Analysis/Scheduled right now.
 *
 *   npm run debug-hubspot-won-deals-missing-schedule
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: all } = await c.query(
      `SELECT d.id FROM deals d LEFT JOIN revenue_schedules rs ON rs.deal_id = d.id
        WHERE d.status = 'won' AND d.amount_cents > 0 AND rs.id IS NULL`,
    );
    console.log(`${all.length} total Closed Won deals with amount_cents > 0 and no revenue_schedules row (any type, any age).`);

    const { rows: recurring } = await c.query(
      `SELECT d.id, d.name, co.name AS company_name, d.amount_cents, d.monthly_retainer_cents,
              d.one_time_amount_cents, d.billing_structure, d.retainer_term_months, d.close_date, d.closed_at
         FROM deals d
         LEFT JOIN companies co ON co.id = d.company_id
         LEFT JOIN revenue_schedules rs ON rs.deal_id = d.id
        WHERE d.status = 'won' AND d.amount_cents > 0 AND rs.id IS NULL
          AND (d.billing_structure IN ('Monthly retainer', 'Subscription') OR d.monthly_retainer_cents IS NOT NULL)
        ORDER BY d.amount_cents DESC`,
    );
    console.log(`\n${recurring.length} of those are RECURRING-type (billing_structure Monthly retainer/Subscription, or monthly_retainer_cents set) -- these are the ones that would represent ongoing revenue missing from Scheduled:`);
    let cents = 0;
    for (const r of recurring) { cents += r.amount_cents; console.log(JSON.stringify(r)); }
    console.log(`\nRecurring-subset total deal value (not monthly -- see individual monthly_retainer_cents above): $${(cents / 100).toLocaleString("en-US")}`);

    // Closed within the last 24 months -- old one-time engagements from
    // years back are very unlikely to still be "expected cash" today.
    const { rows: recentOneTime } = await c.query(
      `SELECT count(*) AS n, coalesce(sum(d.amount_cents),0) AS cents
         FROM deals d LEFT JOIN revenue_schedules rs ON rs.deal_id = d.id
        WHERE d.status = 'won' AND d.amount_cents > 0 AND rs.id IS NULL
          AND NOT (d.billing_structure IN ('Monthly retainer', 'Subscription') OR d.monthly_retainer_cents IS NOT NULL)
          AND COALESCE(d.close_date::date, d.closed_at::date) >= (now() - interval '24 months')`,
    );
    console.log(`\nOne-time-type missing-schedule deals closed in the last 24 months: ${JSON.stringify(recentOneTime[0])}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

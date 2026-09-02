#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Revenue schedules only ever get created inside the app's updateDeal(),
 * on the actual open->won transition (server/storage.ts). Any deal that
 * arrived already Closed Won -- e.g. imported straight from HubSpot's own
 * closed history, or inserted directly by a one-off script -- never passed
 * through that transition, so it never got a revenue_schedules row at all.
 * This is very likely the "few things in HubSpot we haven't accounted for
 * yet" the user is pointing at. Quantifying before fixing.
 *
 *   npm run debug-hubspot-won-deals-missing-schedule
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query(
      `SELECT d.id, d.name, d.company_id, co.name AS company_name, d.source, d.amount_cents,
              d.one_time_amount_cents, d.monthly_retainer_cents, d.billing_structure, d.closed_at, d.close_date
         FROM deals d
         LEFT JOIN companies co ON co.id = d.company_id
         LEFT JOIN revenue_schedules rs ON rs.deal_id = d.id
        WHERE d.status = 'won' AND d.amount_cents > 0 AND rs.id IS NULL
        ORDER BY d.amount_cents DESC`,
    );
    console.log(`${rows.length} Closed Won deal(s) with amount_cents > 0 and NO revenue_schedules row at all:`);
    let totalCents = 0;
    const bySource = new Map<string, { n: number; cents: number }>();
    for (const r of rows) {
      totalCents += r.amount_cents;
      const src = r.source ?? "(null)";
      const s = bySource.get(src) ?? { n: 0, cents: 0 };
      s.n++; s.cents += r.amount_cents;
      bySource.set(src, s);
      console.log(JSON.stringify(r));
    }
    console.log(`\nTotal missing-schedule Closed Won value: $${(totalCents / 100).toLocaleString("en-US")}`);
    console.log(`By source:`, JSON.stringify(Object.fromEntries(bySource)));
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

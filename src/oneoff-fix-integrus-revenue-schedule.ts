#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * One-off fix: Integrus's deal (8f5d1140-162d-4554-9a58-0f57e1e793a4) has
 * amount_cents=$60,000 (the total 12-month contract value) and
 * billing_structure='Monthly retainer', but monthly_retainer_cents was
 * never set. createRevenueScheduleForDeal (server/storage.ts) only falls
 * back to a billingStructure heuristic when BOTH one_time_amount_cents and
 * monthly_retainer_cents are null -- and that heuristic uses the FULL
 * amount_cents as the monthly figure, which produced an open-ended
 * recurring schedule of $60,000/month instead of $5,000/month.
 *
 * This sets the deal's real monthly retainer ($5,000) and regenerates its
 * revenue_schedules row to match -- exactly what updateDeal() would do if
 * you edited the field in the Deal Detail UI, just applied directly since
 * this sandbox can't reach the live app.
 *
 *   npm run oneoff-fix-integrus-revenue-schedule -- --dry-run   (read-only)
 *   npm run oneoff-fix-integrus-revenue-schedule                (applies)
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

const DEAL_ID = "8f5d1140-162d-4554-9a58-0f57e1e793a4";
const CORRECT_MONTHLY_CENTS = 500000; // $5,000/month

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: deals } = await c.query(
      `SELECT id, name, monthly_retainer_cents, one_time_amount_cents, close_date FROM deals WHERE id = $1`, [DEAL_ID],
    );
    const deal = deals[0];
    if (!deal) throw new Error(`Deal ${DEAL_ID} not found -- has it changed since the debug dump?`);
    if (deal.monthly_retainer_cents === CORRECT_MONTHLY_CENTS) {
      console.log(`${deal.name} already has monthly_retainer_cents=${CORRECT_MONTHLY_CENTS} -- nothing to do.`);
      return;
    }
    console.log(`Deal "${deal.name}": monthly_retainer_cents ${deal.monthly_retainer_cents} → ${CORRECT_MONTHLY_CENTS}`);

    const { rows: active } = await c.query(
      `SELECT id, client_id, kind, monthly_amount_cents FROM revenue_schedules WHERE deal_id = $1 AND active = true`, [DEAL_ID],
    );
    console.log(`Active revenue_schedules row(s) to replace: ${JSON.stringify(active)}`);
    const clientId = active[0]?.client_id ?? null;

    if (dryRun) { console.log("(dry-run — no changes written)"); return; }

    await c.query(`UPDATE deals SET monthly_retainer_cents = $1 WHERE id = $2`, [CORRECT_MONTHLY_CENTS, DEAL_ID]);
    await c.query(`UPDATE revenue_schedules SET active = false WHERE deal_id = $1 AND active = true`, [DEAL_ID]);
    await c.query(
      `INSERT INTO revenue_schedules (id, deal_id, client_id, kind, start_date, end_date, one_time_amount_cents, monthly_amount_cents, active)
       VALUES ($1, $2, $3, 'recurring', $4, NULL, NULL, $5, true)`,
      [randomUUID(), DEAL_ID, clientId, deal.close_date, CORRECT_MONTHLY_CENTS],
    );
    console.log(`Done. New recurring schedule: $${CORRECT_MONTHLY_CENTS / 100}/month starting ${deal.close_date}, open-ended.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

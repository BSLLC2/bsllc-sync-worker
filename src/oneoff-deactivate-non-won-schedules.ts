#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off cleanup: deactivate any active revenue_schedules row whose deal is
 * NOT currently status='won' -- found via Colorado School of Clinical
 * Herbalism's "Newsletter Copywriting (SOW 02)" deal, which sits at
 * status='open' with an active $8,750/month schedule from an earlier close
 * that was reopened/walked back. updateDeal (server/storage.ts) had no
 * branch to deactivate a schedule on the won -> open/lost transition until
 * this same fix added one -- but that only covers FUTURE transitions, not
 * whatever's already sitting wrong today. This sweeps every client, not
 * just Colorado, since the same gap could have hit any deal.
 *
 *   npm run oneoff-deactivate-non-won-schedules -- --dry-run   (read-only)
 *   npm run oneoff-deactivate-non-won-schedules                (applies)
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query(
      `SELECT rs.id, rs.deal_id, rs.client_id, rs.kind, rs.monthly_amount_cents, rs.one_time_amount_cents,
              d.name AS deal_name, d.status AS deal_status, cl.name AS client_name
         FROM revenue_schedules rs
         JOIN deals d ON d.id = rs.deal_id
         LEFT JOIN clients cl ON cl.id = rs.client_id
        WHERE rs.active = true AND rs.deal_id IS NOT NULL AND d.status <> 'won'`,
    );
    if (rows.length === 0) {
      console.log("No active schedule rows found tied to a non-won deal. Nothing to fix.");
      return;
    }
    console.log(`${rows.length} active schedule row(s) tied to a deal that is NOT status='won':`);
    for (const r of rows) {
      const amt = r.kind === "recurring" ? `$${(r.monthly_amount_cents ?? 0) / 100}/mo` : `$${(r.one_time_amount_cents ?? 0) / 100} one-time`;
      console.log(`  ${r.client_name ?? "(no client)"} — "${r.deal_name}" [${r.deal_status}] — ${amt} — schedule ${r.id}`);
    }
    if (dryRun) { console.log("\n(dry-run — no changes written)"); return; }

    const ids = rows.map((r) => r.id);
    await c.query(`UPDATE revenue_schedules SET active = false WHERE id = ANY($1::text[])`, [ids]);
    console.log(`\nDeactivated ${ids.length} schedule row(s).`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

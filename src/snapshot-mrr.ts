#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * Records each client's current monthly recurring revenue into `mrr_history`
 * (one row per client per month) so the dashboard can show REAL year-to-date
 * MRR growth instead of just the goal. MRR already lives in the app's own
 * `clients.monthly_retainer_cents` — this is a pure Postgres copy, so it runs
 * in the worker (the deployed app can't run cron) but touches no third party.
 *
 * Idempotent: re-running in the same month overwrites that month's value with
 * the latest retainer, so a mid-month change is captured. The `mrr_history`
 * table is created by the dashboard's ensureSchema (v25); we create it here too
 * so the job never depends on boot order.
 *
 *   npm run snapshot-mrr            (writes)
 *   npm run snapshot-mrr -- --dry-run
 */
function env(n: string): string {
  const v = process.env[n];
  if (!v?.trim()) throw new Error(`Missing ${n}`);
  return v.trim();
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    // Safety net — normally the dashboard's ensureSchema already made this.
    await c.query(`
      CREATE TABLE IF NOT EXISTS mrr_history (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        month TEXT NOT NULL,
        mrr_cents INTEGER NOT NULL DEFAULT 0,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (client_id, month)
      )`);

    const { rows } = await c.query<{ id: string; name: string; mrr: number }>(
      `SELECT id, name, COALESCE(monthly_retainer_cents, 0) AS mrr FROM clients`,
    );
    console.log(`snapshot-mrr — ${rows.length} clients · month ${month}${dryRun ? " (dry-run)" : ""}`);
    if (dryRun) {
      for (const r of rows) console.log(`  ${r.name}: $${Math.round(r.mrr / 100).toLocaleString("en-US")}/mo`);
      console.log("Dry run — nothing written.");
      return;
    }

    let written = 0;
    for (const r of rows) {
      await c.query(
        `INSERT INTO mrr_history (id, client_id, month, mrr_cents, captured_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (client_id, month)
         DO UPDATE SET mrr_cents = EXCLUDED.mrr_cents, captured_at = now()`,
        [randomUUID(), r.id, month, r.mrr],
      );
      written++;
    }
    console.log(`Done: ${written} MRR snapshot(s) upserted for ${month}.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

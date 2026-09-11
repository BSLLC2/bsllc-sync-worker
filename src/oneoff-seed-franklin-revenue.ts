#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * One-off: seed Franklin Brazing's revenue attribution from the RFQ & quote
 * log export (Smartsheet copy "Franklin Brazing | Case Study Numbers",
 * 694 rows, RFQ Source = "BS LLC AD CAMPAIGN", as-of 2025-12-30).
 *
 *   Won from our RFQs, Jan 2024 – Dec 2025:  $1,818,994 (15 deals, 10 customers)
 *     Amerex Fire, Apr 2025:                  $1,800,000  → named-wins ledger
 *     everything else (13 deals):             $18,994     → manual.revenue_system_cents
 *
 * Also sets the lead → won-customer close rate: 10 won customers over the
 * 560 website leads captured Mar 2024 – Dec 2025 = 1.8%. Same denominator
 * the case study uses (website leads), so modeled and actual reconcile.
 *
 * Also records the EVIDENCE (clients.revenue_basis_note): the RFQ log ties
 * every counted row to our campaign via its own "RFQ Source" column, which is
 * what lets the dashboard treat the $18,994 + Amerex as client-tabulated
 * against our leads (basis c) instead of context. Without that note the
 * figure is shown as "context: total company revenue" and excluded from ROI.
 *
 * Idempotent: the named win is keyed on name, the snapshot on external_id,
 * the note is a plain overwrite with the same text.
 *
 *   npm run oneoff-seed-franklin-revenue -- --dry-run=true
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? process.env[k.toUpperCase().replace(/-/g, "_")] ?? d).trim();

const AS_OF = "2025-12-30";
const WINDOW_START = "2024-01-01";
const SOURCE = `Franklin Brazing RFQ & quote log export, as of ${AS_OF}`;
const NAMED_WIN = { name: "Amerex Fire", valueCents: 1_800_000_00, wonOn: "2025-04-01", notes: "RFQ Source: BS LLC AD CAMPAIGN. Awarded April 2025 per the RFQ log; day of month not recorded in the export." };
const OTHER_WINS_CENTS = 18_994_00;
const CLOSE_RATE_PCT = 1.8;
const BASIS_NOTE = `Franklin Brazing RFQ & quote log (Smartsheet "Case Study Numbers", 694 rows), RFQ Source = "BS LLC AD CAMPAIGN", Jan 2024 – Dec 2025, as of ${AS_OF}`;

async function main() {
  const dryRun = arg("dry-run", "true") !== "false";
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    // Same idempotent DDL as the dashboard's ensureSchema v136, so this can run
    // before the deployed app has cold-started and applied it itself.
    await c.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS close_rate_pct DOUBLE PRECISION`);
    await c.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS revenue_basis_note TEXT`); // dashboard ensureSchema v141
    await c.query(`CREATE TABLE IF NOT EXISTS client_named_wins (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), name TEXT NOT NULL, value_cents INTEGER NOT NULL,
      won_on TEXT, tier TEXT NOT NULL DEFAULT 'system', source TEXT, notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_client_named_wins_client ON client_named_wins (client_id)`);
    const { rows: [client] } = await c.query<{ id: string; name: string; customer_value_cents: number | null; close_rate_pct: number | null }>(
      `SELECT id, name, customer_value_cents, close_rate_pct FROM clients WHERE name ILIKE 'Franklin Brazing%' LIMIT 1`);
    if (!client) throw new Error("Franklin Brazing not found");
    console.log(`${client.name} (${client.id}) — customer value ${client.customer_value_cents != null ? `$${(client.customer_value_cents / 100).toLocaleString()}` : "unset"}, close rate ${client.close_rate_pct ?? "unset"}%`);

    const { rows: [win] } = await c.query<{ id: string }>(`SELECT id FROM client_named_wins WHERE client_id = $1 AND name = $2`, [client.id, NAMED_WIN.name]);
    const { rows: [snap] } = await c.query<{ id: string }>(`SELECT id FROM metric_snapshots WHERE client_id = $1 AND external_id = $2`, [client.id, "franklin-rfq-log-2024-2025-other-wins"]);
    console.log(`named win "${NAMED_WIN.name}": ${win ? "already present" : "will insert"}; other-wins snapshot: ${snap ? "already present" : "will insert"}`);
    console.log(`close rate → ${CLOSE_RATE_PCT}% (10 won customers / 560 website leads, Mar 2024 – Dec 2025)`);
    console.log(`evidence note → ${BASIS_NOTE}`);
    if (dryRun) { console.log("DRY RUN — nothing written."); return; }

    if (!win) {
      await c.query(
        `INSERT INTO client_named_wins (id, client_id, name, value_cents, won_on, tier, source, notes) VALUES ($1, $2, $3, $4, $5, 'system', $6, $7)`,
        [randomUUID(), client.id, NAMED_WIN.name, NAMED_WIN.valueCents, NAMED_WIN.wonOn, SOURCE, NAMED_WIN.notes]);
    }
    if (!snap) {
      await c.query(
        `INSERT INTO metric_snapshots (client_id, source, metric_key, value_numeric, value_text, period_start, period_end, data_state, error_message, synced_at, external_id)
         VALUES ($1, 'manual', 'manual.revenue_system_cents', $2, NULL, $3::date, $4::date, 'live', NULL, $4::timestamptz, $5)`,
        [client.id, OTHER_WINS_CENTS, WINDOW_START, AS_OF, "franklin-rfq-log-2024-2025-other-wins"]);
    }
    await c.query(`UPDATE clients SET close_rate_pct = $2, revenue_basis_note = $3 WHERE id = $1`, [client.id, CLOSE_RATE_PCT, BASIS_NOTE]);
    console.log("done.");
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

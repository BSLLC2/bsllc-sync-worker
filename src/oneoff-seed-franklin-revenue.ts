#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { FRANKLIN_SEED_AS_OF, FRANKLIN_SEED_EXTERNAL_ID, FRANKLIN_SEED_FROM, FRANKLIN_SEED_NAMED_CENTS, FRANKLIN_SEED_OTHER_CENTS } from "./tracker/config.js";

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
 * THE FEED NOW COVERS THIS WINDOW (2026-10-21). The live feed (src/import-tracker.ts) counts every closed sale on the
 * sheets from the CONTRACT START (2023-12-15), which is before this seed's first day. Once it has read, the dashboard
 * counts the sheet in place of the figures below (it never deletes or rewrites them) and shows the two side by side as
 * a reconciliation. Nothing here needs to be re-run; running it again is harmless.
 *
 * Idempotent: the named win is keyed on name, the snapshot on external_id.
 * The evidence note and the close rate are written ONLY IF ABSENT: a note or a
 * rate somebody typed since is never overwritten.
 *
 *   npm run oneoff-seed-franklin-revenue -- --dry-run=true
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? process.env[k.toUpperCase().replace(/-/g, "_")] ?? d).trim();

// The seed's as-of day and its two figures live in the tracker config, so the seed and the live feed
// (which now starts at the contract start) cannot disagree about what the seed holds.
const AS_OF = FRANKLIN_SEED_AS_OF;
const WINDOW_START = FRANKLIN_SEED_FROM;
const SOURCE = `Franklin Brazing RFQ & quote log export, as of ${AS_OF}`;
const NAMED_WIN = { name: "Amerex Fire", valueCents: FRANKLIN_SEED_NAMED_CENTS, wonOn: "2025-04-01", notes: "RFQ Source: BS LLC AD CAMPAIGN. Awarded April 2025 per the RFQ log; day of month not recorded in the export." };
const OTHER_WINS_CENTS = FRANKLIN_SEED_OTHER_CENTS;
const CLOSE_RATE_PCT = 1.8;
const BASIS_NOTE = `Franklin Brazing's own sales sheets (the RFQ & quote log and the Google Ads form sheet), RFQ Source = "BS LLC AD CAMPAIGN". The log was first entered once, Jan 2024 - Dec 2025, as of ${AS_OF}; the live sheet read replaces that entry`;

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
    const { rows: [client] } = await c.query<{ id: string; name: string; customer_value_cents: number | null; close_rate_pct: number | null; revenue_basis_note: string | null }>(
      `SELECT id, name, customer_value_cents, close_rate_pct, revenue_basis_note FROM clients WHERE name ILIKE 'Franklin Brazing%' LIMIT 1`);
    if (!client) throw new Error("Franklin Brazing not found");
    console.log(`${client.name} (${client.id}) — customer value ${client.customer_value_cents != null ? `$${(client.customer_value_cents / 100).toLocaleString()}` : "unset"}, close rate ${client.close_rate_pct ?? "unset"}%`);

    const { rows: [win] } = await c.query<{ id: string }>(`SELECT id FROM client_named_wins WHERE client_id = $1 AND name = $2`, [client.id, NAMED_WIN.name]);
    const { rows: [snap] } = await c.query<{ id: string }>(`SELECT id FROM metric_snapshots WHERE client_id = $1 AND external_id = $2`, [client.id, FRANKLIN_SEED_EXTERNAL_ID]);
    console.log(`named win "${NAMED_WIN.name}": ${win ? "already present" : "will insert"}; other-wins snapshot: ${snap ? "already present" : "will insert"}`);
    const noteAbsent = !client.revenue_basis_note?.trim();
    const rateAbsent = client.close_rate_pct == null;
    console.log(`close rate: ${rateAbsent ? `will set ${CLOSE_RATE_PCT}% (10 won customers / 560 website leads, Mar 2024 – Dec 2025)` : "already recorded, left as it is"}`);
    console.log(`evidence note: ${noteAbsent ? `will set (${BASIS_NOTE})` : "already recorded, left as it is"}`);
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
        [client.id, OTHER_WINS_CENTS, WINDOW_START, AS_OF, FRANKLIN_SEED_EXTERNAL_ID]);
    }
    // Only if absent: a figure or a note somebody typed since is never overwritten.
    await c.query(`UPDATE clients SET close_rate_pct = COALESCE(close_rate_pct, $2), revenue_basis_note = COALESCE(NULLIF(btrim(revenue_basis_note), ''), $3) WHERE id = $1`, [client.id, CLOSE_RATE_PCT, BASIS_NOTE]);
    console.log("done.");
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

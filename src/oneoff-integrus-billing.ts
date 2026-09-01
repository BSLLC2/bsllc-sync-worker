#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import crypto from "node:crypto";

/**
 * One-off, run-once script: Integrus Partners' real billing contact
 * (michael@integruspartners.com) was confirmed directly in QuickBooks, but
 * our own accounting_setup_requests table -- the gate import-qbo-invoices.ts
 * checks before sending anything -- was left on a "skipped" request with no
 * contact, so QBO invoice #31803 sat unsent forever even though QuickBooks
 * itself was ready to bill.
 *
 * Also ensures qbo_catalog_items exists ahead of the app's own migration
 * picking it up on its next real request (Vercel's serverless function
 * hadn't cold-started with the new schema by the time this ran), so
 * import-qbo-items.ts can sync into it right away instead of waiting.
 *
 *   npm run oneoff-integrus-billing
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS qbo_catalog_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT,
        unit_price_cents INTEGER,
        active BOOLEAN NOT NULL DEFAULT true,
        income_account_name TEXT,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    console.log("qbo_catalog_items: ensured.");

    const { rows: clientRows } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE name ILIKE '%integrus%'`,
    );
    if (clientRows.length !== 1) {
      console.error(`Expected exactly 1 client matching "integrus", found ${clientRows.length}: ${clientRows.map((r) => r.name).join(", ")}`);
      process.exit(1);
    }
    const client = clientRows[0]!;
    console.log(`Client: ${client.name} (${client.id})`);

    const { rows: priorRows } = await c.query<{ id: string; completed_at: string | null }>(
      `SELECT id, completed_at FROM accounting_setup_requests WHERE client_id = $1 ORDER BY requested_at DESC LIMIT 1`,
      [client.id],
    );
    const prior = priorRows[0];
    console.log(`Latest accounting_setup_requests row: ${prior ? `${prior.id} (completed_at=${prior.completed_at})` : "none"}`);

    const id = crypto.randomUUID();
    await c.query(
      `INSERT INTO accounting_setup_requests
         (id, client_id, status, contact_name, billing_email, requested_by, completed_at)
       VALUES ($1, $2, 'completed', $3, $4, $5, now())`,
      [id, client.id, "Michael", "michael@integruspartners.com", "Sebastien Hue (confirmed via QuickBooks)"],
    );
    console.log(`Inserted new completed accounting_setup_requests row ${id} with billing_email=michael@integruspartners.com`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

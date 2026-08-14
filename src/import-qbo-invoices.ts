#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { QboClient } from "./qbo.js";

/**
 * On quote signature → QuickBooks. Finds signed quotes that haven't been synced
 * to QBO yet and creates an ESTIMATE (customer + line items) in the sandbox/prod
 * company, then records the estimate id back on the quote. Estimate first (safe,
 * non-binding); true invoicing is a follow-up gated behind QBO_AUTO_INVOICE.
 *
 * The deployed app writes zero to QBO — it just marks quotes signed; this worker
 * job is the only thing that touches QuickBooks.
 *
 *   npm run import-qbo-invoices
 *   npm run import-qbo-invoices -- --dry-run
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

interface Line { id: string; name: string; description?: string; qty: number; unitPriceCents: number; recurring: string; qboItemId?: string | null }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query<{ id: string; quote_number: string | null; client_name: string; line_items_json: string | null; signed_email: string | null }>(
      `SELECT id, quote_number, client_name, line_items_json, signed_email
         FROM pricing_quotes
        WHERE status = 'signed' AND kind = 'designer'
          AND qbo_estimate_id IS NULL
        ORDER BY signed_at ASC NULLS LAST
        LIMIT 50`,
    );
    console.log(`import-qbo-invoices — ${rows.length} signed quote(s) to sync${dryRun ? " (dry-run)" : ""}`);
    if (rows.length === 0) return;

    const qbo = new QboClient(c);
    if (!dryRun) await qbo.connect();

    let done = 0, failed = 0;
    for (const r of rows) {
      let items: Line[] = [];
      try { items = r.line_items_json ? JSON.parse(r.line_items_json) : []; } catch { items = []; }
      const lines = items.map((i) => ({
        name: i.name || "Service",
        amount: ((i.unitPriceCents || 0) * (i.qty || 1)) / 100,
        itemId: i.qboItemId ?? null,
        monthly: i.recurring === "monthly",
      }));
      if (lines.length === 0) {
        console.log(`  skip ${r.quote_number}: no line items`);
        continue;
      }
      if (dryRun) {
        console.log(`  would create estimate for ${r.client_name} (${r.quote_number}) — ${lines.length} line(s), $${lines.reduce((s, l) => s + l.amount, 0).toFixed(2)}`);
        done++; continue;
      }
      try {
        const customerId = await qbo.findOrCreateCustomer(r.client_name || "Client", r.signed_email);
        const estimateId = await qbo.createEstimate(customerId, lines);
        await c.query(`UPDATE pricing_quotes SET qbo_estimate_id=$2, qbo_synced_at=now(), qbo_sync_error=NULL WHERE id=$1`, [r.id, estimateId]);
        console.log(`  ✓ ${r.client_name} (${r.quote_number}) → QBO estimate ${estimateId}`);
        done++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await c.query(`UPDATE pricing_quotes SET qbo_sync_error=$2 WHERE id=$1`, [r.id, msg.slice(0, 500)]);
        console.log(`  ✗ ${r.client_name} (${r.quote_number}): ${msg}`);
        failed++;
      }
    }
    console.log(`Done: ${done} ${dryRun ? "to sync" : "synced"}, ${failed} failed.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

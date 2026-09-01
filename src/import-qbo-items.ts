#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { QboClient } from "./qbo.js";

/**
 * Syncs QuickBooks' real Products/Services catalog into Postgres
 * (qbo_catalog_items) so Quote Designer can offer a live picker of real QBO
 * items on every quote line, instead of every line silently billing against
 * the one hardcoded default item.
 *
 * Also auto-matches service_library rows that don't yet have a qboItemId to
 * a same-named QBO item — exact, case-insensitive match only, and only when
 * there's a single candidate. A fuzzy or ambiguous match is left for a human
 * to confirm in the Service Library admin instead of guessing.
 *
 *   npm run import-qbo-items
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const qbo = new QboClient(c);
    await qbo.connect();
    const items = await qbo.getItems();
    console.log(`import-qbo-items — ${items.length} item(s) from QuickBooks`);

    for (const i of items) {
      await c.query(
        `INSERT INTO qbo_catalog_items (id, name, description, type, unit_price_cents, active, income_account_name, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, type = EXCLUDED.type,
           unit_price_cents = EXCLUDED.unit_price_cents, active = EXCLUDED.active,
           income_account_name = EXCLUDED.income_account_name, synced_at = now()`,
        [i.id, i.name, i.description, i.type, i.unitPrice != null ? Math.round(i.unitPrice * 100) : null, i.active, i.incomeAccountName],
      );
    }
    // Anything QBO no longer returned (merged/deleted item) gets marked
    // inactive rather than deleted, so a past quote that still references it
    // doesn't lose the ability to show what it was.
    const ids = items.map((i) => i.id);
    if (ids.length > 0) {
      await c.query(`UPDATE qbo_catalog_items SET active = false WHERE id <> ALL($1) AND active = true`, [ids]);
    }

    const { rows: unmatched } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM service_library WHERE qbo_item_id IS NULL AND active = true`,
    );
    let matched = 0;
    for (const s of unmatched) {
      const candidates = items.filter((i) => i.active && i.name.trim().toLowerCase() === s.name.trim().toLowerCase());
      if (candidates.length === 1) {
        await c.query(`UPDATE service_library SET qbo_item_id = $2 WHERE id = $1`, [s.id, candidates[0]!.id]);
        console.log(`  matched "${s.name}" → QBO item ${candidates[0]!.id} (${candidates[0]!.name})`);
        matched++;
      }
    }
    console.log(`Done: ${items.length} synced, ${matched} service(s) auto-matched by exact name.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

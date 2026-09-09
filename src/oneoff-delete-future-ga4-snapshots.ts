#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off cleanup: delete metric_snapshots rows whose synced_at is in the
 * future -- the bug fixed in commit 476f23a (monthBounds() stamping the
 * CURRENT in-progress month with its calendar-month-end date, e.g.
 * 2026-09-30 on 2026-09-09) planted rows with a synced_at that's now
 * artificially "newer" than anything a correct sync can write today. Since
 * the dashboard's "latest metric" reads pick the highest synced_at, these
 * stale rows keep winning until removed. Scoped to source='ga4' since
 * that's the one confirmed to have actually misfired; the GSC/D365 code
 * paths had the same latent bug but no evidence either one produced a row
 * yet, so left alone here.
 *
 *   npm run oneoff-delete-future-ga4-snapshots -- --dry-run   (read-only)
 *   npm run oneoff-delete-future-ga4-snapshots                (applies)
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query(
      `SELECT ms.id, ms.client_id, cl.name AS client_name, ms.metric_key, ms.value_numeric, ms.value_text,
              ms.period_start, ms.period_end, ms.synced_at
         FROM metric_snapshots ms
         LEFT JOIN clients cl ON cl.id = ms.client_id
        WHERE ms.source = 'ga4' AND ms.synced_at > now()
        ORDER BY ms.synced_at DESC`,
    );
    if (rows.length === 0) {
      console.log("No future-dated GA4 metric_snapshots rows found. Nothing to fix.");
      return;
    }
    console.log(`${rows.length} future-dated GA4 row(s):`);
    for (const r of rows) {
      console.log(`  ${r.client_name ?? "(no client)"} — ${r.metric_key} = ${r.value_numeric ?? r.value_text} — period ${String(r.period_start).slice(0, 10)}..${String(r.period_end).slice(0, 10)} — synced_at ${r.synced_at} — row ${r.id}`);
    }
    if (dryRun) { console.log("\n(dry-run — no changes written)"); return; }

    const ids = rows.map((r) => r.id);
    await c.query(`DELETE FROM metric_snapshots WHERE id = ANY($1::int[])`, [ids]);
    console.log(`\nDeleted ${ids.length} row(s). The next GA4 sync (already fixed, commit 476f23a) will replant correct data.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

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
 * 2026-09-10: generalized with --source=<name> (default ga4). HubSpot had
 * the same bug — import-hubspot-metrics stamped the in-progress month with
 * the calendar month's last day, "last sync 20d in the future" on the Data
 * health page; the importer is fixed (monthSnapshot in dates.ts) and this
 * removes the rows it already planted. Also matches period_end in the future,
 * which the synced_at-only check missed.
 *
 *   npm run oneoff-delete-future-ga4-snapshots -- --source=hubspot --dry-run   (read-only)
 *   npm run oneoff-delete-future-ga4-snapshots -- --source=hubspot            (applies)
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const source = (process.argv.slice(2).find((a) => a.startsWith("--source="))?.slice(9) || "ga4").trim();
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query(
      `SELECT ms.id, ms.client_id, cl.name AS client_name, ms.metric_key, ms.value_numeric, ms.value_text,
              ms.period_start, ms.period_end, ms.synced_at
         FROM metric_snapshots ms
         LEFT JOIN clients cl ON cl.id = ms.client_id
        WHERE ms.source = $1 AND (ms.synced_at > now() + interval '1 hour' OR ms.period_end > now() + interval '1 day')
        ORDER BY ms.synced_at DESC`,
      [source],
    );
    if (rows.length === 0) {
      console.log(`No future-dated ${source} metric_snapshots rows found. Nothing to fix.`);
      return;
    }
    console.log(`${rows.length} future-dated ${source} row(s):`);
    for (const r of rows) {
      console.log(`  ${r.client_name ?? "(no client)"} — ${r.metric_key} = ${r.value_numeric ?? r.value_text} — period ${String(r.period_start).slice(0, 10)}..${String(r.period_end).slice(0, 10)} — synced_at ${r.synced_at} — row ${r.id}`);
    }
    if (dryRun) { console.log("\n(dry-run — no changes written)"); return; }

    const ids = rows.map((r) => r.id);
    await c.query(`DELETE FROM metric_snapshots WHERE id = ANY($1::int[])`, [ids]);
    console.log(`\nDeleted ${ids.length} row(s). The next ${source} sync (importer fixed to cap the in-progress month at today) will replant correct data.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

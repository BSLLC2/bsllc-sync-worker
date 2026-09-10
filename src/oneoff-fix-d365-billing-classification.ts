#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Every Closed Won deal imported for DPG before today was classified off
 * Contact.new_firsttouchsource while that field was blocked by Dataverse
 * field-level security -- every read came back null, so classify() (see
 * d365.ts) could only ever land on "manual" or "unknown", never "bsllc" or
 * "other". Security is now off and real values are readable, but
 * insertMetricSnapshots dedupes on (client, source, external_id) with
 * onConflictDoNothing -- already-recorded deals will NOT be corrected by
 * simply re-running import-d365. This deletes DPG's existing d365
 * metric_snapshots rows (both per-deal and the monthly aggregates derived
 * from them) so the next import-d365 run reinserts everything fresh with
 * the now-correct classification. Nothing in D365 itself is touched.
 *
 *   npm run oneoff-fix-d365-billing-classification -- --dry-run=true   (default)
 *   npm run oneoff-fix-d365-billing-classification -- --dry-run=false
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const dryRun = process.argv.includes("--dry-run=false") ? false : true;
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: client } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE lower(name) LIKE '%diesel%' OR lower(name) LIKE '%dpg%'`,
    );
    if (client.length === 0) { console.log("No DPG client found."); return; }
    const clientId = client[0]!.id;
    console.log(`Client: ${client[0]!.name} (${clientId})\n`);

    const { rows: existing } = await c.query<{
      id: string; item_id: string | null; metrics: any; period_start: string | null; period_end: string | null;
    }>(
      `SELECT id, item_id, metrics, period_start, period_end FROM metric_snapshots
        WHERE client_id = $1 AND source = 'd365' ORDER BY period_start`,
      [clientId],
    );
    console.log(`${existing.length} existing d365 metric_snapshots row(s) for DPG.\n`);

    const perDeal = existing.filter((r) => r.item_id !== null);
    const aggregate = existing.filter((r) => r.item_id === null);
    console.log(`  ${perDeal.length} per-deal row(s), ${aggregate.length} monthly aggregate row(s).\n`);

    const bucketCounts: Record<string, number> = {};
    for (const r of perDeal) {
      const b = r.metrics?.["d365.deal_won_bucket"] ?? "(none)";
      bucketCounts[b] = (bucketCounts[b] ?? 0) + 1;
    }
    console.log("Current per-deal bucket distribution (from the possibly-stale import):");
    for (const [b, n] of Object.entries(bucketCounts)) console.log(`  ${b}: ${n}`);
    console.log("");

    if (existing.length === 0) {
      console.log("Nothing to clear.");
      return;
    }

    if (dryRun) {
      console.log("DRY RUN -- would delete all rows above. Re-run with --dry-run=false to actually delete them.");
      return;
    }

    const { rowCount } = await c.query(`DELETE FROM metric_snapshots WHERE client_id = $1 AND source = 'd365'`, [clientId]);
    console.log(`Deleted ${rowCount} row(s). Now run import-d365 (real, not dry-run) to reinsert with correct classification.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

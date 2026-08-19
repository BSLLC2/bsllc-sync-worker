#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off cleanup: Semrush was fully retired in favor of DataForSEO — the
 * "semrush" source is no longer a valid value anywhere in the schema
 * (METRIC_SOURCES/CONNECTOR_SOURCES/MAPPABLE_SOURCES). This deletes the
 * stale rows so nothing lingers in the "Connected data" tab or freshness
 * monitor.
 *
 *   npm run purge-semrush-data -- --dry-run
 *   npm run purge-semrush-data
 */
async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: (process.env.DATABASE_URL || "").trim() });
  await c.connect();
  try {
    const { rows: snapshots } = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM metric_snapshots WHERE source = 'semrush'`,
    );
    const { rows: mappings } = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM connector_mappings WHERE source = 'semrush'`,
    );
    console.log(`metric_snapshots: ${snapshots[0].n} semrush rows`);
    console.log(`connector_mappings: ${mappings[0].n} semrush rows`);

    if (dryRun) { console.log("Dry run — nothing deleted."); return; }

    const del1 = await c.query(`DELETE FROM metric_snapshots WHERE source = 'semrush'`);
    const del2 = await c.query(`DELETE FROM connector_mappings WHERE source = 'semrush'`);
    console.log(`Deleted ${del1.rowCount} metric_snapshots, ${del2.rowCount} connector_mappings.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

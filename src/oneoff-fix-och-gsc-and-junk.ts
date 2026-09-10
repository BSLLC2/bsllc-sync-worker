#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Two OCH data fixes found by the September coverage audit:
 *   1. The gsc connector row errors with "GSC 403 for ohiorecoverycenters.com"
 *      while the Franklin row errors with "sc-domain:…" — OCH's external_id is
 *      stored as a bare domain and queried as a URL-prefix property the
 *      service account was never granted. Normalize it to the sc-domain form
 *      that the historical rows came from.
 *   2. metric_snapshots rows for OCH dated July 2027 (period a year out,
 *      synced_at in the future). Views exclude them, but they are junk.
 *
 *   npm run oneoff-fix-och-gsc-and-junk -- --dry-run=true   (default)
 *   npm run oneoff-fix-och-gsc-and-junk -- --dry-run=false
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const WANT = "sc-domain:ohiorecoverycenters.com";

async function main() {
  const dryRun = !process.argv.includes("--dry-run=false");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: [och] } = await c.query<{ id: string; name: string }>(`SELECT id, name FROM clients WHERE name ILIKE '%ohio community health%' LIMIT 1`);
    if (!och) throw new Error("OCH client not found");
    console.log(`OCH client ${och.id}\n`);

    const { rows: gsc } = await c.query<{ id: string; external_id: string | null; enabled: boolean }>(
      `SELECT id, external_id, enabled FROM connector_mappings WHERE client_id = $1 AND source = 'gsc'`, [och.id]);
    for (const r of gsc) {
      console.log(`gsc connector ${r.id}: external_id=${JSON.stringify(r.external_id)} enabled=${r.enabled}`);
      if (r.external_id !== WANT) {
        console.log(`  -> set external_id to ${WANT}`);
        if (!dryRun) await c.query(`UPDATE connector_mappings SET external_id = $2, updated_at = now() WHERE id = $1`, [r.id, WANT]);
      } else console.log("  already correct");
    }
    if (!gsc.length) console.log("no gsc connector row for OCH");

    const { rows: junk } = await c.query<{ source: string; metric_key: string; period_start: string | null; period_end: string | null; synced_at: string; n: string }>(
      `SELECT source, metric_key, period_start::text, period_end::text, synced_at::text, count(*)::text AS n
         FROM metric_snapshots
        WHERE client_id = $1 AND (period_start > now() + interval '1 day' OR synced_at > now() + interval '1 day')
        GROUP BY 1,2,3,4,5 ORDER BY period_start`, [och.id]);
    console.log(`\nfuture-dated metric_snapshots rows for OCH: ${junk.reduce((a, r) => a + Number(r.n), 0)}`);
    for (const r of junk) console.log(`  ${r.source} ${r.metric_key} ${r.period_start}..${r.period_end} synced ${r.synced_at} ×${r.n}`);
    if (junk.length && !dryRun) {
      const del = await c.query(`DELETE FROM metric_snapshots WHERE client_id = $1 AND (period_start > now() + interval '1 day' OR synced_at > now() + interval '1 day')`, [och.id]);
      console.log(`deleted ${del.rowCount}`);
    }
    if (dryRun) console.log("\nDRY RUN — nothing written. Re-run with --dry-run=false.");
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

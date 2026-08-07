#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/** One-off diagnostic: dump the OCH manual metric rows from BOTH tables so we
 *  can see what the dashboard tile actually resolves as "current". Read-only. */
async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Missing DATABASE_URL.");
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const slug = "ohio-community-health-och";
    for (const table of ["metric_snapshots", "manual_metrics"]) {
      const { rows } = await c.query(
        `SELECT metric_key, value_numeric, period_start, period_end, synced_at, data_state
           FROM ${table}
          WHERE client_id = $1 AND metric_key LIKE 'manual.%'
          ORDER BY metric_key, synced_at DESC
          LIMIT 60`,
        [slug],
      );
      console.log(`\n=== ${table} (${rows.length} rows) ===`);
      for (const r of rows) {
        console.log(
          `${r.metric_key} | val=${r.value_numeric} | period=${r.period_start?.toISOString?.().slice(0,10) ?? r.period_start}..${r.period_end?.toISOString?.().slice(0,10) ?? r.period_end} | synced=${r.synced_at?.toISOString?.() ?? r.synced_at} | ${r.data_state}`,
        );
      }
      // What DISTINCT ON would pick per key (mirrors getLatestMetrics)
      const { rows: latest } = await c.query(
        `SELECT DISTINCT ON (metric_key) metric_key, value_numeric, period_end, synced_at
           FROM ${table}
          WHERE client_id = $1 AND metric_key LIKE 'manual.%'
          ORDER BY metric_key, synced_at DESC`,
        [slug],
      );
      console.log(`--- ${table}: what "latest" (synced_at DESC) resolves to ---`);
      for (const r of latest) console.log(`  ${r.metric_key} => ${r.value_numeric} (period_end ${r.period_end?.toISOString?.().slice(0,10) ?? r.period_end}, synced ${r.synced_at?.toISOString?.() ?? r.synced_at})`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

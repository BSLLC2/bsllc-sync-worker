#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/** Verify the client-detail metric-trend query: the OLD form (ORDER BY on a
 *  UNION) should error; the NEW form (union wrapped in a subquery) should work. */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const OCH = "1bc64fac-f1ef-45ed-9815-f11cbe65cdae";

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  const params = [OCH, "manual", "manual.admissions_marketing"];
  const cols = `client_id, source, metric_key, value_numeric, value_text, period_start, period_end, data_state, error_message, synced_at`;
  const broken = `
    SELECT ${cols} FROM metric_snapshots
    WHERE client_id=$1 AND source=$2 AND metric_key=$3 AND data_state='live' AND value_numeric IS NOT NULL AND (period_end IS NULL OR period_end<=now())
    UNION ALL
    SELECT ${cols} FROM manual_metrics
    WHERE client_id=$1 AND source=$2 AND metric_key=$3 AND data_state='live' AND value_numeric IS NOT NULL AND (period_end IS NULL OR period_end<=now())
    ORDER BY COALESCE(period_end, synced_at) DESC LIMIT 500`;
  const fixed = `
    SELECT ${cols} FROM (
      SELECT ${cols} FROM metric_snapshots
      WHERE client_id=$1 AND source=$2 AND metric_key=$3 AND data_state='live' AND value_numeric IS NOT NULL AND (period_end IS NULL OR period_end<=now())
      UNION ALL
      SELECT ${cols} FROM manual_metrics
      WHERE client_id=$1 AND source=$2 AND metric_key=$3 AND data_state='live' AND value_numeric IS NOT NULL AND (period_end IS NULL OR period_end<=now())
    ) t
    ORDER BY COALESCE(period_end, synced_at) DESC LIMIT 500`;
  try {
    try { const r = await c.query(broken, params); console.log(`OLD form: unexpectedly OK (${r.rowCount} rows)`); }
    catch (e) { console.log(`OLD form: ERROR (expected) — ${e instanceof Error ? e.message : e}`); }
    try { const r = await c.query(fixed, params); console.log(`NEW form: OK — ${r.rowCount} rows returned`); }
    catch (e) { console.log(`NEW form: ERROR (bad!) — ${e instanceof Error ? e.message : e}`); }
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

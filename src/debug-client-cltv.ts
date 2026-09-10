#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: what single customer value (CLTV) each active client has on
 * file, and what modeled revenue it would imply against this month's
 * conversions. The revenue-attribution brief (2026-09-10) says a single
 * mean-based value is wrong by ~100x for quote-based B2B clients like
 * Franklin Brazing — this shows whether such a value is currently driving
 * an "EST." figure anywhere.
 *
 *   npm run debug-client-cltv
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query<{ id: string; name: string; status: string; customer_value_cents: number | null; conv: string | null; est_source: string | null }>(
      `SELECT c.id, c.name, c.status, c.customer_value_cents,
              (SELECT value_numeric::text FROM metric_snapshots m
                WHERE m.client_id = c.id AND m.data_state = 'live'
                  AND m.metric_key IN ('ads.conversions','ga4.conversions','hubspot.leads','manual.leads')
                  AND COALESCE(m.period_start, m.synced_at) >= date_trunc('month', now())
                ORDER BY CASE m.metric_key WHEN 'manual.leads' THEN 0 WHEN 'ads.conversions' THEN 1 WHEN 'hubspot.leads' THEN 2 ELSE 3 END, m.synced_at DESC LIMIT 1) AS conv,
              (SELECT source || ':' || metric_key FROM metric_snapshots m
                WHERE m.client_id = c.id AND m.data_state = 'live' AND m.metric_key LIKE '%revenue%'
                ORDER BY m.synced_at DESC LIMIT 1) AS est_source
         FROM clients c
        WHERE c.status IN ('launch','active') AND NOT c.is_internal
        ORDER BY c.name`,
    );
    for (const r of rows) {
      const cltv = r.customer_value_cents == null ? "none" : `$${(r.customer_value_cents / 100).toLocaleString("en-US")}`;
      const conv = r.conv == null ? "—" : Number(r.conv);
      const modeled = r.customer_value_cents != null && r.conv != null ? ` → modeled this month ≈ $${Math.round((r.customer_value_cents / 100) * Number(r.conv)).toLocaleString("en-US")}` : "";
      console.log(`${r.name.padEnd(42)} CLTV ${cltv.padEnd(12)} conversions this month ${String(conv).padEnd(5)}${modeled}  latest revenue row: ${r.est_source ?? "none"}`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

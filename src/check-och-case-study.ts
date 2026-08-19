#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off diagnostic: dumps the exact inputs the /api/case-studies revenue
 * waterfall uses for OCH (contract_start, avg_deal_value_cents, and every
 * relevant metric_snapshots series) so we can see why OCH's contribution to
 * the portfolio revenue total looks wrong. Read-only.
 *
 *   npm run check-och-case-study
 */
async function main() {
  const c = new pg.Client({ connectionString: (process.env.DATABASE_URL || "").trim() });
  await c.connect();
  try {
    const { rows: cl } = await c.query(
      `SELECT id, name, contract_start, avg_deal_value_cents FROM clients WHERE name ILIKE '%Ohio Community Health%' OR name ILIKE '%OCH%'`,
    );
    console.log("Client rows:", JSON.stringify(cl, null, 2));
    const client = cl[0];
    if (!client) { console.log("No OCH client found."); return; }

    const keys = [
      "manual.admissions_marketing", "manual.revenue_cents", "d365.revenue_cents", "hubspot.revenue_cents",
      "ads.conversions", "ads.verified_conversions", "ads.conversion_value", "ads.verified_conversion_value",
      "ga4.conversions",
    ];
    const { rows: metrics } = await c.query(
      `SELECT source, metric_key, data_state, synced_at, period_start, period_end, value_numeric
         FROM metric_snapshots
        WHERE client_id = $1 AND metric_key = ANY($2::text[])
        ORDER BY metric_key, synced_at ASC`,
      [client.id, keys],
    );
    console.log(`\n${metrics.length} matching metric_snapshots rows for OCH:`);
    const bySeries = new Map<string, typeof metrics>();
    for (const m of metrics) {
      const k = `${m.source}.${m.metric_key}`;
      const arr = bySeries.get(k) ?? [];
      arr.push(m);
      bySeries.set(k, arr);
    }
    for (const [k, rows] of bySeries) {
      const first = rows[0], last = rows[rows.length - 1];
      console.log(`  ${k}: ${rows.length} rows, first=${first.value_numeric}@${first.synced_at.toISOString().slice(0,10)} latest=${last.value_numeric}@${last.synced_at.toISOString().slice(0,10)} state=${last.data_state}`);
    }
    // For the two manual series specifically, print EVERY row's synced_at vs
    // period_start/period_end — this is the actual bug check: if period_start
    // spans many distinct months but synced_at clusters on 1-2 days, the
    // case-study query's date_trunc('month', synced_at) grouping is silently
    // collapsing a real multi-month backfill into a single month.
    for (const k of ["manual.admissions_marketing", "manual.revenue_cents"]) {
      const rows = bySeries.get(k) ?? [];
      if (!rows.length) continue;
      console.log(`\n${k} — every row (synced_at vs period_start/period_end):`);
      for (const r of rows) {
        console.log(`  synced_at=${r.synced_at.toISOString()} period_start=${r.period_start ? new Date(r.period_start).toISOString().slice(0,10) : "null"} period_end=${r.period_end ? new Date(r.period_end).toISOString().slice(0,10) : "null"} value=${r.value_numeric}`);
      }
    }

    // Also: what does the overall portfolio revenue total look like today,
    // per client, using the same CRM-revenue-key waterfall (rough check).
    const { rows: allClients } = await c.query(`SELECT id, name, avg_deal_value_cents FROM clients WHERE status <> 'inactive'`);
    console.log(`\nAll non-inactive clients (${allClients.length}):`);
    for (const cl2 of allClients) {
      console.log(`  ${cl2.name}: avg_deal_value_cents=${cl2.avg_deal_value_cents}`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

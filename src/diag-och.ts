#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/** One-off diagnostic: resolve the OCH client id, then dump its manual.* rows
 *  from BOTH tables so we can see what the dashboard tile resolves as
 *  "current". Read-only. */
async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Missing DATABASE_URL.");
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const { rows: clients } = await c.query<{ id: string; name: string; slug: string | null; customer_value_cents: number | null }>(
      "SELECT id, name, slug, customer_value_cents FROM clients",
    );
    const och = clients.find((r) => (r.slug && r.slug === "ohio-community-health-och") || slugify(r.name) === "ohio-community-health-och" || /ohio community/i.test(r.name));
    if (!och) { console.log("No OCH client found. Clients:", clients.map((r) => `${r.name} [${r.slug ?? slugify(r.name)}]`).join(", ")); return; }
    console.log(`OCH client: id=${och.id} name="${och.name}" slug=${och.slug} customer_value_cents=${och.customer_value_cents}`);

    for (const table of ["metric_snapshots", "manual_metrics"]) {
      const { rows } = await c.query(
        `SELECT metric_key, value_numeric, period_start, period_end, synced_at, data_state
           FROM ${table}
          WHERE client_id = $1 AND metric_key LIKE 'manual.%'
          ORDER BY metric_key, synced_at DESC
          LIMIT 80`,
        [och.id],
      );
      console.log(`\n=== ${table} (${rows.length} rows) ===`);
      for (const r of rows) {
        const d = (v: any) => v?.toISOString?.() ?? v;
        console.log(`${r.metric_key} | val=${r.value_numeric} | period=${d(r.period_start)?.slice?.(0,10)}..${d(r.period_end)?.slice?.(0,10)} | synced=${d(r.synced_at)} | ${r.data_state}`);
      }
      const { rows: latest } = await c.query(
        `SELECT DISTINCT ON (metric_key) metric_key, value_numeric, period_end, synced_at
           FROM ${table}
          WHERE client_id = $1 AND metric_key LIKE 'manual.%'
          ORDER BY metric_key, synced_at DESC`,
        [och.id],
      );
      console.log(`--- ${table}: what "latest" (synced_at DESC) resolves to ---`);
      for (const r of latest) { const d = (v: any) => v?.toISOString?.() ?? v; console.log(`  ${r.metric_key} => ${r.value_numeric} (period_end ${d(r.period_end)?.slice?.(0,10)}, synced ${d(r.synced_at)})`); }
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

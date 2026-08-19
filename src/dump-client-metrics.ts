#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only diagnostic: dump everything we know about a client's data so we can
 * sanity-check the client report before a meeting — which connectors are mapped,
 * the client config, and the latest metric snapshot per (source, metric_key)
 * plus how far back history goes. Writes nothing.
 *
 *   npm run dump-client-metrics -- --client="LBL Law"
 */
function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const clientName = arg("client") || "LBL Law";
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: cl } = await c.query<Record<string, unknown>>(
      `SELECT * FROM clients WHERE lower(trim(name)) = lower(trim($1)) LIMIT 1`, [clientName],
    );
    if (!cl[0]) { console.log(`No client named "${clientName}".`); return; }
    const client = cl[0] as Record<string, unknown>;
    const id = client.id as string;
    console.log(`\n=== ${clientName} (${id}) ===`);
    for (const k of ["account_type", "contract_start", "seo_domain", "brand_name", "customer_value_cents", "am_owner"]) {
      if (k in client) console.log(`  ${k}: ${client[k]}`);
    }

    const { rows: maps } = await c.query<{ source: string; external_id: string | null; enabled: boolean }>(
      `SELECT source, external_id, enabled FROM connector_mappings WHERE client_id = $1 ORDER BY source`, [id],
    );
    console.log(`\n--- connector mappings (${maps.length}) ---`);
    for (const m of maps) console.log(`  ${m.source}: ${m.external_id ?? "(none)"}${m.enabled ? "" : " [disabled]"}`);

    const { rows: coverage } = await c.query<{ source: string; metric_key: string; n: string; earliest: string; latest: string }>(
      `SELECT source, metric_key, count(*) AS n, min(period_start) AS earliest, max(period_end) AS latest
         FROM metric_snapshots WHERE client_id = $1
        GROUP BY source, metric_key ORDER BY source, metric_key`, [id],
    );
    console.log(`\n--- metric_snapshots coverage (${coverage.length} series) ---`);
    for (const r of coverage) console.log(`  ${r.source} · ${r.metric_key}: ${r.n} rows, ${String(r.earliest).slice(0,10)} → ${String(r.latest).slice(0,10)}`);

    const { rows: latest } = await c.query<{ source: string; metric_key: string; value_numeric: string | null; value_text: string | null; period_start: string; period_end: string; data_state: string; synced_at: string }>(
      `SELECT DISTINCT ON (source, metric_key) source, metric_key, value_numeric, value_text, period_start, period_end, data_state, synced_at
         FROM metric_snapshots WHERE client_id = $1
        ORDER BY source, metric_key, synced_at DESC`, [id],
    );
    console.log(`\n--- latest value per series ---`);
    for (const r of latest) {
      console.log(`  ${r.source} · ${r.metric_key} = ${r.value_numeric ?? r.value_text} [${r.data_state}] period ${String(r.period_start).slice(0,10)}→${String(r.period_end).slice(0,10)} synced ${String(r.synced_at).slice(0,10)}`);
    }

    const { rows: targets } = await c.query<{ report_status: string; n: string }>(
      `SELECT report_status, count(*) AS n FROM seo_targets WHERE client_id = $1 AND active = true GROUP BY report_status`,
      [id],
    );
    console.log(`\n--- seo_targets (active) ---`);
    for (const t of targets) console.log(`  ${t.report_status}: ${t.n}`);

    const { rows: rankHistory } = await c.query<{ n: string; keywords: string; earliest: string; latest: string }>(
      `SELECT count(*) AS n, count(DISTINCT keyword) AS keywords, min(captured_at) AS earliest, max(captured_at) AS latest
         FROM seo_rank_history WHERE client_id = $1`,
      [id],
    );
    const rh = rankHistory[0];
    console.log(`\n--- seo_rank_history ---`);
    console.log(`  ${rh?.n ?? 0} rows across ${rh?.keywords ?? 0} keyword(s), ${rh?.earliest ? String(rh.earliest).slice(0,10) : "—"} → ${rh?.latest ? String(rh.latest).slice(0,10) : "—"}`);
    console.log("");
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("dump-client-metrics failed:", e instanceof Error ? e.message : e); process.exit(1); });

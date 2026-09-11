#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: everything the Admin → Data health page is built from, in one
 * dump — per-source latest sync + recent errors (the same query the dashboard
 * runs), every job heartbeat with its note, every future-dated
 * metric_snapshots row grouped by source, the latest error message per
 * (source, client), and one client's monthly rows for one source. Writes
 * nothing.
 *
 *   npm run debug-data-health
 *   npm run debug-data-health -- --client=<uuid> --source=gsc
 */
function arg(name: string): string { return (process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "").trim(); }
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const clientId = arg("client");
  const source = arg("source") || "gsc";
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    console.log(`now (db): ${(await c.query<{ now: Date }>("SELECT now()")).rows[0]!.now.toISOString()}`);

    console.log("\n--- per-source latest sync (dashboard getDataHealth query) ---");
    const src = await c.query<{ source: string; last_sync: Date | null; recent_errors: string; recent_total: string; n_future: string }>(
      `WITH latest AS (
         SELECT DISTINCT ON (client_id, metric_key) source, data_state, synced_at
           FROM metric_snapshots ORDER BY client_id, metric_key, synced_at DESC)
       SELECT source, MAX(synced_at) AS last_sync,
              COUNT(*) FILTER (WHERE data_state = 'error' AND synced_at > now() - interval '8 days') AS recent_errors,
              COUNT(*) FILTER (WHERE synced_at > now() - interval '8 days') AS recent_total,
              COUNT(*) FILTER (WHERE synced_at > now() + interval '1 hour') AS n_future
         FROM latest GROUP BY source ORDER BY source`,
    );
    for (const r of src.rows) {
      const ageH = r.last_sync ? (Date.now() - r.last_sync.getTime()) / 3_600_000 : null;
      console.log(`  ${r.source.padEnd(12)} last_sync=${r.last_sync?.toISOString() ?? "never"} age=${ageH == null ? "—" : `${ageH.toFixed(1)}h`} errors=${r.recent_errors}/${r.recent_total} future_latest=${r.n_future}`);
    }

    console.log("\n--- job_heartbeats ---");
    const beats = await c.query<{ job: string; ran_at: Date; ok: boolean; note: string | null }>(`SELECT job, ran_at, ok, note FROM job_heartbeats ORDER BY job`);
    for (const b of beats.rows) {
      const ageH = (Date.now() - b.ran_at.getTime()) / 3_600_000;
      console.log(`  ${b.job.padEnd(26)} ${b.ok ? "ok  " : "FAIL"} ${b.ran_at.toISOString()} (${ageH.toFixed(1)}h) ${b.note ? `note=${b.note.slice(0, 160)}` : ""}`);
    }

    console.log("\n--- future-dated metric_snapshots rows (synced_at or period_end > now + 1h), by source ---");
    const fut = await c.query<{ source: string; n: string; max_synced: Date | null; max_period_end: Date | null; clients: string }>(
      `SELECT source, COUNT(*) AS n, MAX(synced_at) AS max_synced, MAX(period_end) AS max_period_end,
              string_agg(DISTINCT coalesce(cl.name, ms.client_id::text), ', ') AS clients
         FROM metric_snapshots ms LEFT JOIN clients cl ON cl.id = ms.client_id
        WHERE ms.synced_at > now() + interval '1 hour' OR ms.period_end > now() + interval '1 hour'
        GROUP BY source ORDER BY source`,
    );
    if (!fut.rows.length) console.log("  none");
    for (const r of fut.rows) console.log(`  ${r.source.padEnd(12)} ${r.n} row(s) · max synced_at ${r.max_synced?.toISOString() ?? "—"} · max period_end ${r.max_period_end?.toISOString().slice(0, 10) ?? "—"} · ${r.clients}`);

    console.log("\n--- latest erroring reading per (source, client), last 8 days ---");
    const errs = await c.query<{ source: string; name: string | null; metric_key: string; synced_at: Date; error_message: string | null }>(
      `SELECT t.source, cl.name, t.metric_key, t.synced_at, t.error_message FROM (
         SELECT DISTINCT ON (client_id, metric_key) client_id, source, metric_key, data_state, error_message, synced_at
           FROM metric_snapshots ORDER BY client_id, metric_key, synced_at DESC) t
        LEFT JOIN clients cl ON cl.id = t.client_id
        WHERE t.data_state = 'error' AND t.synced_at > now() - interval '8 days' ORDER BY t.source, cl.name, t.metric_key`,
    );
    if (!errs.rows.length) console.log("  none");
    for (const e of errs.rows) console.log(`  ${e.source} · ${e.name ?? "—"} · ${e.metric_key} · ${e.synced_at.toISOString()} · ${(e.error_message ?? "").slice(0, 200)}`);

    if (clientId) {
      console.log(`\n--- ${source} rows for client ${clientId}: one line per (period, metric) newest first, max 80 ---`);
      const rows = await c.query<{ metric_key: string; value_numeric: string | null; period_start: Date | null; period_end: Date | null; synced_at: Date; data_state: string; error_message: string | null }>(
        `SELECT metric_key, value_numeric, period_start, period_end, synced_at, data_state, error_message
           FROM metric_snapshots WHERE client_id = $1 AND source = $2
          ORDER BY period_start DESC NULLS LAST, synced_at DESC, metric_key LIMIT 80`,
        [clientId, source],
      );
      for (const r of rows.rows) console.log(`  ${r.period_start?.toISOString().slice(0, 10) ?? "—"}..${r.period_end?.toISOString().slice(0, 10) ?? "—"} ${r.metric_key.padEnd(18)} ${r.data_state.padEnd(7)} ${r.value_numeric ?? "—"} synced ${r.synced_at.toISOString()} ${r.error_message ? `· ${r.error_message.slice(0, 120)}` : ""}`);
      const months = await c.query<{ ym: string; n_live: string; n_err: string }>(
        `SELECT to_char(period_start, 'YYYY-MM') AS ym, COUNT(*) FILTER (WHERE data_state='live') AS n_live, COUNT(*) FILTER (WHERE data_state='error') AS n_err
           FROM metric_snapshots WHERE client_id = $1 AND source = $2 GROUP BY 1 ORDER BY 1`,
        [clientId, source],
      );
      console.log(`  months with rows: ${months.rows.map((m) => `${m.ym}(${m.n_live}L/${m.n_err}E)`).join(" ")}`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

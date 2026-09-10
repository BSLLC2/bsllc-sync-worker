#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: for every launch/active client and every connector it has
 * enabled, is there data for the current month, and when was that source
 * last synced? One matrix so "is September in for everyone" is a single
 * look instead of nineteen client pages.
 *
 *   npm run debug-september-coverage
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: clients } = await c.query<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM clients WHERE status IN ('launch','active') AND NOT is_internal ORDER BY name`,
    );
    const { rows: conns } = await c.query<{ client_id: string; source: string; enabled: boolean; external_id: string | null }>(
      `SELECT client_id, source, enabled, external_id FROM connector_mappings`,
    );
    const { rows: metrics } = await c.query<{ client_id: string; source: string; months: string; last_period: string | null; last_sync: string; this_month: string; errors: string }>(
      `SELECT client_id, source,
              COUNT(DISTINCT date_trunc('month', COALESCE(period_start, synced_at)))::text AS months,
              MAX(period_end)::text AS last_period,
              MAX(synced_at)::text AS last_sync,
              COUNT(*) FILTER (WHERE data_state = 'live' AND COALESCE(period_start, synced_at) >= date_trunc('month', now()))::text AS this_month,
              COUNT(*) FILTER (WHERE data_state = 'error' AND synced_at > now() - interval '7 days')::text AS errors
         FROM metric_snapshots GROUP BY client_id, source`,
    );
    const { rows: leads } = await c.query<{ client_slug: string; this_month: string; total: string }>(
      `SELECT client_slug, COUNT(*) FILTER (WHERE submitted_at >= date_trunc('month', now()))::text AS this_month, COUNT(*)::text AS total
         FROM web_inquiries
        WHERE email IS NULL OR (email NOT ILIKE '%@bsllc.biz' AND email NOT IN ('sebastienhue@gmail.com','test-inquiry@bsllc.biz'))
        GROUP BY client_slug`,
    );
    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const m = new Map(metrics.map((r) => [`${r.client_id}|${r.source}`, r]));
    const l = new Map(leads.map((r) => [r.client_slug, r]));
    const ago = (iso: string | null) => (iso ? `${Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000)}d ago` : "never");

    console.log(`Month: ${new Date().toISOString().slice(0, 7)} — ${clients.length} active/launch client(s)\n`);
    for (const cl of clients) {
      const mine = conns.filter((x) => x.client_id === cl.id && x.enabled);
      const lead = l.get(slugify(cl.name));
      console.log(`${cl.name} (${cl.status})`);
      console.log(`  website leads: ${lead ? `${lead.this_month} this month, ${lead.total} total` : "none ever"}`);
      if (!mine.length) { console.log("  connectors: none enabled"); continue; }
      for (const cn of mine) {
        const r = m.get(`${cl.id}|${cn.source}`);
        const flag = !r ? "NO DATA EVER" : Number(r.this_month) === 0 ? "NO SEPTEMBER ROWS" : "ok";
        const detail = r ? `${r.this_month} rows this month · ${r.months} months on file · last period ${r.last_period?.slice(0, 10) ?? "—"} · synced ${ago(r.last_sync)}${Number(r.errors) ? ` · ${r.errors} errors/7d` : ""}` : "";
        console.log(`  ${cn.source.padEnd(11)} ${flag.padEnd(18)} ${detail}`);
      }
      // Sources with data but no enabled connector row (e.g. d365, gbp, callrail written by the worker directly).
      for (const r of metrics.filter((x) => x.client_id === cl.id && !mine.some((cn) => cn.source === x.source))) {
        console.log(`  ${r.source.padEnd(11)} ${(Number(r.this_month) ? "ok" : "NO SEPTEMBER ROWS").padEnd(18)} ${r.this_month} rows this month · last period ${r.last_period?.slice(0, 10) ?? "—"} · synced ${ago(r.last_sync)} (no connector row)`);
      }
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

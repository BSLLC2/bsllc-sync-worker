#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: what the dashboard's month-by-month table is showing for OCH,
 * straight from the database, so it can be set beside the intake sheet
 * (`npm run import-och -- --dry-run` prints the sheet side).
 *
 * Per month since the contract start (2024-08):
 *   admissions   — manual.admissions (every admission that month, from the sheet)
 *   ours         — manual.admissions_marketing (the Conversions row)
 *   forms        — web_inquiries rows that are not phone calls
 *   calls        — web_inquiries rows labelled "Phone: …"
 *
 *   npm run debug-och-monthly-check
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const SLUG = process.env.CLIENT_SLUG?.trim() || "ohio-community-health-och";
const SINCE = process.env.SINCE?.trim() || "2024-08-01";

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: cl } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE id::text = $1 LIMIT 1`,
      [process.env.CLIENT_ID?.trim() || "1bc64fac-f1ef-45ed-9815-f11cbe65cdae"],
    );
    const client = cl[0];
    if (!client) throw new Error(`client not found (set CLIENT_ID)`);
    console.log(`${client.name} (${client.id}) — months since ${SINCE}\n`);

    // Latest live value per (metric, month). Calendar-month rows only.
    const { rows: adm } = await c.query<{ month: string; metric_key: string; v: string; synced: string }>(
      `SELECT DISTINCT ON (metric_key, date_trunc('month', period_start))
              to_char(date_trunc('month', period_start), 'YYYY-MM') AS month, metric_key,
              value_numeric::text AS v, synced_at::text AS synced
         FROM metric_snapshots
        WHERE client_id = $1 AND source = 'manual' AND data_state = 'live'
          AND metric_key IN ('manual.admissions','manual.admissions_marketing','manual.admissions_current','manual.admissions_marketing_current')
          AND period_start >= $2::date
        ORDER BY metric_key, date_trunc('month', period_start), synced_at DESC`,
      [client.id, SINCE],
    );
    const { rows: web } = await c.query<{ month: string; forms: string; calls: string }>(
      `SELECT to_char(date_trunc('month', submitted_at), 'YYYY-MM') AS month,
              count(*) FILTER (WHERE coalesce(form_name,'') NOT LIKE 'Phone:%')::text AS forms,
              count(*) FILTER (WHERE coalesce(form_name,'') LIKE 'Phone:%')::text AS calls
         FROM web_inquiries
        WHERE client_slug = $1 AND submitted_at >= $2::date
          AND coalesce(email,'') NOT ILIKE '%@bsllc.biz'
        GROUP BY 1`,
      [SLUG, SINCE],
    );
    const months = new Set<string>();
    const a = new Map<string, Record<string, string>>();
    for (const r of adm) { months.add(r.month); const o = a.get(r.month) ?? {}; o[r.metric_key] = r.v; o[`${r.metric_key}@`] = r.synced.slice(0, 10); a.set(r.month, o); }
    const w = new Map<string, { forms: string; calls: string }>();
    for (const r of web) { months.add(r.month); w.set(r.month, r); }
    console.log(`  month    admissions  ours  forms  calls   (admissions/ours synced)`);
    for (const m of [...months].sort()) {
      const o = a.get(m) ?? {};
      const admissions = o["manual.admissions"] ?? o["manual.admissions_current"] ?? "—";
      const ours = o["manual.admissions_marketing"] ?? o["manual.admissions_marketing_current"] ?? "—";
      const cur = o["manual.admissions"] == null && o["manual.admissions_current"] != null ? " (in progress)" : "";
      const synced = o["manual.admissions@"] ?? o["manual.admissions_current@"] ?? "";
      const ww = w.get(m);
      console.log(`  ${m}  ${String(admissions).padStart(10)}  ${String(ours).padStart(4)}  ${String(ww?.forms ?? "0").padStart(5)}  ${String(ww?.calls ?? "0").padStart(5)}   ${synced}${cur}`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

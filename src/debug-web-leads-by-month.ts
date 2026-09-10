#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: one client's Website Leads by month, with the forms seen, so a
 * replayed history can be checked against what the site reported.
 *
 *   npm run debug-web-leads-by-month -- --client=franklin-brazing
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const slug = (process.argv.find((a) => a.startsWith("--client="))?.slice(9) || process.env.CLIENT_SLUG || "").trim();
  if (!slug) throw new Error("--client=<slug> required");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: tot } = await c.query<{ n: string; oldest: string | null; newest: string | null; replayed: string }>(
      `SELECT count(*)::text AS n, min(submitted_at)::text AS oldest, max(submitted_at)::text AS newest,
              count(*) FILTER (WHERE external_id IS NOT NULL)::text AS replayed
         FROM web_inquiries WHERE client_slug = $1`, [slug]);
    console.log(`${slug}: ${tot[0]?.n} rows (${tot[0]?.replayed} replayed history), ${tot[0]?.oldest?.slice(0, 10)} → ${tot[0]?.newest?.slice(0, 10)}\n`);
    const { rows } = await c.query<{ month: string; n: string; forms: string }>(
      `SELECT to_char(date_trunc('month', submitted_at), 'YYYY-MM') AS month, count(*)::text AS n,
              string_agg(DISTINCT coalesce(nullif(form_name, ''), '(unnamed)'), ', ') AS forms
         FROM web_inquiries WHERE client_slug = $1
        GROUP BY 1 ORDER BY 1`, [slug]);
    for (const r of rows) console.log(`  ${r.month}  ${r.n.padStart(4)}  ${r.forms}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

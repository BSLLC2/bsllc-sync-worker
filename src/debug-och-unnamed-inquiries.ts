#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: OCH web_inquiries rows with no form_name — where they came from
 * (raw_json source), how their submitted_at is distributed by day, and a
 * sample, so an import that stamped "now" instead of the real date is visible.
 *
 *   npm run debug-och-unnamed-inquiries
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const slug = "ohio-community-health-och";
    const { rows: bySource } = await c.query<{ src: string; n: string; days: string; first: string; last: string }>(
      `SELECT coalesce(raw_json::jsonb->>'source', '(webhook)') AS src, count(*)::text AS n,
              count(DISTINCT submitted_at::date)::text AS days, min(submitted_at)::text AS first, max(submitted_at)::text AS last
         FROM web_inquiries WHERE client_slug = $1 AND (form_name IS NULL OR form_name = '')
        GROUP BY 1 ORDER BY 2 DESC`, [slug]);
    console.log("Unnamed rows by source:");
    for (const r of bySource) console.log(`  ${r.src.padEnd(24)} ${r.n.padStart(4)} rows over ${r.days} day(s): ${r.first.slice(0, 16)} → ${r.last.slice(0, 16)}`);

    const { rows: byDay } = await c.query<{ d: string; n: string }>(
      `SELECT submitted_at::date::text AS d, count(*)::text AS n FROM web_inquiries
        WHERE client_slug = $1 AND (form_name IS NULL OR form_name = '') GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`, [slug]);
    console.log("\nTop days for unnamed rows:");
    for (const r of byDay) console.log(`  ${r.d}  ${r.n}`);

    const { rows: sample } = await c.query<{ submitted_at: string; email: string | null; phone: string | null; gclid: string | null; utm_source: string | null; raw: string | null }>(
      `SELECT submitted_at::text, email, phone, gclid, utm_source, left(raw_json, 300) AS raw FROM web_inquiries
        WHERE client_slug = $1 AND (form_name IS NULL OR form_name = '') ORDER BY submitted_at DESC LIMIT 5`, [slug]);
    console.log("\nMost recent 5 unnamed rows:");
    for (const r of sample) console.log(`  ${r.submitted_at.slice(0, 19)} · ${r.email ?? "-"} · ${r.phone ? "***" + r.phone.replace(/[^0-9]/g, "").slice(-4) : "-"} · gclid=${r.gclid ? "yes" : "no"} · ${r.utm_source ?? "-"}\n    raw: ${r.raw}`);

    const { rows: months } = await c.query<{ m: string; named: string; unnamed: string }>(
      `SELECT to_char(date_trunc('month', submitted_at), 'YYYY-MM') AS m,
              count(*) FILTER (WHERE form_name IS NOT NULL AND form_name <> '')::text AS named,
              count(*) FILTER (WHERE form_name IS NULL OR form_name = '')::text AS unnamed
         FROM web_inquiries WHERE client_slug = $1 GROUP BY 1 ORDER BY 1`, [slug]);
    console.log("\nBy month (named webhook rows vs unnamed):");
    for (const r of months) console.log(`  ${r.m}  named ${r.named.padStart(3)}  unnamed ${r.unnamed.padStart(3)}`);
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

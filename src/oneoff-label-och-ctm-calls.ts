#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off: label OCH's CallTrackingMetrics call rows in web_inquiries. CTM's
 * webhook template posts the same six flat keys as a site form, so those
 * calls landed with no form_name and were counted alongside form fills.
 * Same shape test the app now applies live (server/webform.ts).
 *
 *   npm run oneoff-label-och-ctm-calls -- --dry-run=true   (default)
 *   npm run oneoff-label-och-ctm-calls -- --dry-run=false
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const dryRun = !process.argv.includes("--dry-run=false");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const where = `client_slug = 'ohio-community-health-och'
        AND (form_name IS NULL OR form_name = '')
        AND raw_json IS NOT NULL AND raw_json::jsonb ? 'first_name' AND raw_json::jsonb ? 'phone'
        AND NOT (raw_json::jsonb ? 'form_name') AND NOT (raw_json::jsonb ? 'source')
        AND coalesce(raw_json::jsonb->>'email', '') = ''
        AND length(regexp_replace(coalesce(raw_json::jsonb->>'phone', ''), '[^0-9]', '', 'g')) >= 10
        AND upper(raw_json::jsonb->>'first_name') = raw_json::jsonb->>'first_name'`;
    const { rows } = await c.query<{ n: string; first: string; last: string }>(
      `SELECT count(*)::text AS n, min(submitted_at)::text AS first, max(submitted_at)::text AS last FROM web_inquiries WHERE ${where}`);
    console.log(`OCH unlabeled CTM-shaped rows: ${rows[0]?.n} (${rows[0]?.first?.slice(0, 10)} → ${rows[0]?.last?.slice(0, 10)})`);
    if (!dryRun) {
      const r = await c.query(`UPDATE web_inquiries SET form_name = 'Phone: CallTrackingMetrics' WHERE ${where}`);
      console.log(`labeled ${r.rowCount}`);
    } else console.log("DRY RUN — nothing written.");
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off repair: OCH's 21 local-scope keyword targets were imported with
 * location_name = "Cincinnati, OH" — human-readable shorthand, not a real
 * DataForSEO location spec. DataForSEO only accepts locations exactly as
 * they appear in its own locations database, which for a US city is
 * "City,State,United States" with the full state name and no spaces (see
 * shared/schema.ts's own comment: "Chicago,Illinois,United States"). Every
 * local-scope SERP call was therefore rejected per-task, which is why every
 * local row showed "Checking..." (a real pull error) instead of a rank.
 *
 *   npm run fix-och-local-location -- --dry-run
 *   npm run fix-och-local-location
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

const CORRECT = "Cincinnati,Ohio,United States";

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: cl } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE lower(trim(name)) = lower(trim($1))`, ["Ohio Community Health (OCH)"],
    );
    const client = cl[0];
    if (!client) { console.log(`No client "Ohio Community Health (OCH)" found.`); return; }

    const { rows: targets } = await c.query<{ id: string; keyword: string; location_name: string | null }>(
      `SELECT id, keyword, location_name FROM seo_targets WHERE client_id = $1 AND active = true AND scope = 'local'`,
      [client.id],
    );
    console.log(`${client.name}: ${targets.length} active local-scope targets.`);
    const byLoc = new Map<string, number>();
    for (const t of targets) byLoc.set(t.location_name ?? "(null)", (byLoc.get(t.location_name ?? "(null)") ?? 0) + 1);
    for (const [loc, n] of byLoc) console.log(`  "${loc}": ${n}`);

    const toFix = targets.filter((t) => t.location_name !== CORRECT);
    console.log(`\n${toFix.length} need location_name -> "${CORRECT}".`);
    if (!toFix.length) { console.log("Nothing to fix."); return; }
    if (dryRun) { console.log("(dry-run — nothing written)"); return; }

    const res = await c.query(
      `UPDATE seo_targets SET location_name = $2 WHERE id = ANY($1::text[])`,
      [toFix.map((t) => t.id), CORRECT],
    );
    console.log(`✓ Updated ${res.rowCount} keyword target(s).`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ fix-och-local-location failed:", e instanceof Error ? e.message : e); process.exit(1); });

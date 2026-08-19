#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off repair: client-detail.tsx's CSV importer had a report_status bug
 * (exact match against "baseline" instead of a prefix match) that silently
 * reclassified every one of OCH's 18 pre-launch/detox keywords as "core" on
 * re-upload — which means they were being counted in the client-facing
 * aggregate, in direct contradiction of the client's "do NOT make service
 * claims before licensure" instruction. The bug itself is fixed in
 * client-detail.tsx; this repairs the data already corrupted by it, matching
 * against the exact keyword list from the canonical CSV (import-och-seo-set.ts)
 * that these 18 keywords came from. Only ever touches OCH, only ever flips
 * core -> baseline for keywords on this exact list, never creates/deletes rows.
 *
 *   npm run fix-och-baseline-status -- --dry-run
 *   npm run fix-och-baseline-status
 */
const BASELINE_KEYWORDS = [
  "detox near me",
  "alcohol detox near me",
  "detox center near me",
  "drug detox near me",
  "medical detox near me",
  "alcohol detox cincinnati",
  "detox cincinnati",
  "drug detox cincinnati",
  "how to detox from alcohol",
  "opioid withdrawal timeline",
  "what is medical detox",
  "drug rehab ohio",
  "drug rehab columbus ohio",
  "addiction treatment columbus ohio",
  "suboxone clinic ohio",
  "drug rehab dayton",
  "addiction treatment dayton",
  "rehab mason ohio",
];

function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

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

    const { rows: targets } = await c.query<{ id: string; keyword: string; report_status: string }>(
      `SELECT id, keyword, report_status FROM seo_targets WHERE client_id = $1 AND active = true`, [client.id],
    );
    const toFix = targets.filter(
      (t) => BASELINE_KEYWORDS.includes(t.keyword.trim().toLowerCase()) && t.report_status !== "baseline",
    );
    const alreadyOk = targets.filter(
      (t) => BASELINE_KEYWORDS.includes(t.keyword.trim().toLowerCase()) && t.report_status === "baseline",
    ).length;
    const notFound = BASELINE_KEYWORDS.filter(
      (kw) => !targets.some((t) => t.keyword.trim().toLowerCase() === kw),
    );

    console.log(`${client.name}: ${targets.length} active targets.`);
    console.log(`  ${toFix.length} need core -> baseline, ${alreadyOk} already correct.`);
    if (notFound.length) console.log(`  Not found in current targets (skipped, no-op): ${notFound.join(", ")}`);
    for (const t of toFix) console.log(`  · ${t.keyword} (${t.report_status} -> baseline)`);

    if (!toFix.length) { console.log("Nothing to fix."); return; }
    if (dryRun) { console.log("(dry-run — nothing written)"); return; }

    const res = await c.query(
      `UPDATE seo_targets SET report_status = 'baseline' WHERE id = ANY($1::text[])`,
      [toFix.map((t) => t.id)],
    );
    console.log(`✓ Updated ${res.rowCount} keyword(s) to baseline.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ fix-och-baseline-status failed:", e instanceof Error ? e.message : e); process.exit(1); });

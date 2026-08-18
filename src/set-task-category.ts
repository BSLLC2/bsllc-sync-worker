#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Bulk-set the category (setup | ongoing) of a client's open tasks. 'setup'
 * gates the launch-readiness score, so retainer/ongoing work must not sit in
 * setup. Retainer plans imported before the fix defaulted to 'setup' — this
 * corrects them. Optionally scope to titles matching --match.
 *
 *   npm run set-task-category -- --client="LBL Law" --category=ongoing
 *   npm run set-task-category -- --client="LBL Law" --category=setup --match="tracking"
 *   npm run set-task-category -- --client="CSCH" --category=ongoing --dry-run
 */
function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const clientName = arg("client");
  const category = (arg("category") || "").toLowerCase();
  const match = arg("match");
  const dryRun = process.argv.slice(2).includes("--dry-run");
  if (!clientName) throw new Error('Pass --client="<name>"');
  if (category !== "setup" && category !== "ongoing") throw new Error('Pass --category=setup or --category=ongoing');

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: cl } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE lower(trim(name)) = lower(trim($1)) LIMIT 1`, [clientName],
    );
    if (!cl[0]) { console.log(`No client named "${clientName}".`); return; }
    const clientId = cl[0].id;

    const params: (string)[] = [clientId];
    let where = `client_id = $1 AND status <> 'complete'`;
    if (match) { params.push(`%${match}%`); where += ` AND lower(title) LIKE lower($${params.length})`; }

    const { rows: hits } = await c.query<{ id: string; title: string; category: string }>(
      `SELECT id, title, category FROM commitments WHERE ${where} ORDER BY title`, params,
    );
    const toChange = hits.filter((h) => h.category !== category);
    console.log(`${clientName}: ${hits.length} open task(s)${match ? ` matching "${match}"` : ""}, ${toChange.length} to set → ${category}${dryRun ? " (dry-run)" : ""}`);
    for (const h of toChange.slice(0, 20)) console.log(`  • ${h.title}  [${h.category} → ${category}]`);
    if (toChange.length > 20) console.log(`  … and ${toChange.length - 20} more`);
    if (dryRun || toChange.length === 0) return;

    const res = await c.query(
      `UPDATE commitments SET category = $${params.length + 1}, last_updated_at = now() WHERE ${where} AND category <> $${params.length + 1}`,
      [...params, category],
    );
    console.log(`✓ Set ${res.rowCount} task(s) to '${category}' for ${clientName}.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ set-task-category failed:", e instanceof Error ? e.message : e); process.exit(1); });

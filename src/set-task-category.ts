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
    // Match exact name first; else fall back to a case-insensitive substring so
    // short names / partials work ("Herbalism"). Refuse if >1 client matches so
    // we never reclassify the wrong account.
    let { rows: cl } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE lower(trim(name)) = lower(trim($1))`, [clientName],
    );
    if (cl.length === 0) {
      ({ rows: cl } = await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM clients WHERE name ILIKE '%' || $1 || '%' ORDER BY name`, [clientName],
      ));
    }
    if (cl.length > 1) { console.log(`Ambiguous "${clientName}" — matches ${cl.length}: ${cl.map((x) => x.name).join(", ")}. Be more specific.`); return; }
    const client = cl[0];
    if (!client) {
      const { rows: all } = await c.query<{ name: string; n: number }>(
        `SELECT c.name, COUNT(m.id)::int AS n FROM clients c
           LEFT JOIN commitments m ON m.client_id = c.id AND m.status <> 'complete'
          GROUP BY c.name ORDER BY c.name`,
      );
      console.log(`No client matching "${clientName}". Known clients (open tasks):`);
      for (const r of all) console.log(`  • ${r.name} (${r.n})`);
      return;
    }
    const clientId = client.id;
    console.log(`Matched client: ${client.name}`);

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

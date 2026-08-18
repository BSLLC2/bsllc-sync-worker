#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Seed client-facing task visibility for a client. The client report is opt-in
 * (only client_visible tasks show), so this flips ON the tasks a client
 * obviously should see: the ones they OWN (owner_type='client' — "needs input
 * from you") and anything already marked a milestone. Internal execution tasks
 * stay hidden. AMs can still toggle any individual task afterward.
 *
 *   npm run seed-client-visibility -- --client="LBL Law"
 *   npm run seed-client-visibility -- --client="LBL Law" --dry-run
 */
function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const clientName = arg("client") || "LBL Law";
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: cl } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE lower(trim(name)) = lower(trim($1)) LIMIT 1`, [clientName],
    );
    if (!cl[0]) { console.log(`No client named "${clientName}" — nothing to do.`); return; }
    const clientId = cl[0].id;
    // Client-facing = tasks the client owns (their action) or milestones.
    const where = `client_id = $1 AND status <> 'complete' AND (owner_type = 'client' OR is_milestone = true)`;
    const { rows: preview } = await c.query<{ title: string; owner_type: string; status: string }>(
      `SELECT title, owner_type, status FROM commitments WHERE ${where} ORDER BY due_date NULLS LAST`, [clientId],
    );
    console.log(`${clientName}: ${preview.length} client-facing task(s) to make visible${dryRun ? " (dry-run)" : ""}`);
    for (const r of preview) console.log(`  • [${r.owner_type}/${r.status}] ${r.title}`);
    if (dryRun) return;
    const res = await c.query(`UPDATE commitments SET client_visible = true, last_updated_at = now() WHERE ${where}`, [clientId]);
    console.log(`✓ Marked ${res.rowCount} task(s) client-visible for ${clientName}.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ seed-client-visibility failed:", e instanceof Error ? e.message : e); process.exit(1); });

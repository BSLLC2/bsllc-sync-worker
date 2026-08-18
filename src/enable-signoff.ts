#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Turn a specific task into a client e-signature sign-off. The client report
 * renders the "Sign & approve" card only for a task that is a milestone AND in
 * the "awaiting" review state, so this flips all three switches at once:
 * is_milestone = true, review_state = 'awaiting', client_visible = true. A
 * deliverable link is optional (an authorization sign-off has nothing to open).
 *
 *   npm run enable-signoff -- --client="LBL Law" --match="Digital Logic transition"
 *   npm run enable-signoff -- --client="LBL Law" --match="Digital Logic" --link="https://docs.google.com/..."
 *   npm run enable-signoff -- --client="LBL Law" --match="Digital Logic" --dry-run
 */
function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const clientName = arg("client") || "LBL Law";
  const match = arg("match");
  const link = arg("link");
  const dryRun = process.argv.slice(2).includes("--dry-run");
  if (!match) throw new Error('Pass --match="<part of the task title>"');

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: cl } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE lower(trim(name)) = lower(trim($1)) LIMIT 1`, [clientName],
    );
    if (!cl[0]) { console.log(`No client named "${clientName}" — nothing to do.`); return; }
    const clientId = cl[0].id;

    const { rows: hits } = await c.query<{ id: string; title: string; is_milestone: boolean; review_state: string; link: string | null }>(
      `SELECT id, title, is_milestone, review_state, link
         FROM commitments
        WHERE client_id = $1 AND status <> 'complete' AND lower(title) LIKE lower($2)
        ORDER BY due_date NULLS LAST`,
      [clientId, `%${match}%`],
    );
    if (!hits.length) { console.log(`No open task on ${clientName} matching "${match}".`); return; }
    console.log(`${clientName}: ${hits.length} match(es) for "${match}"${dryRun ? " (dry-run)" : ""}`);
    for (const r of hits) console.log(`  • ${r.title}  [milestone=${r.is_milestone} review=${r.review_state}]`);
    if (dryRun) return;

    for (const r of hits) {
      await c.query(
        `UPDATE commitments
            SET is_milestone = true,
                review_state = 'awaiting',
                review_requested_at = COALESCE(review_requested_at, now()),
                client_visible = true,
                link = COALESCE($2, link),
                last_updated_at = now()
          WHERE id = $1`,
        [r.id, link ?? null],
      );
      console.log(`  ✓ "${r.title}" is now awaiting client sign-off.`);
    }
    console.log(`Done. It shows on ${clientName}'s dashboard as "Sign & approve".`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ enable-signoff failed:", e instanceof Error ? e.message : e); process.exit(1); });

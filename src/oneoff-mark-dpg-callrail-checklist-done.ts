#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * DPG's setup checklist still shows "CallRail account + install" as
 * not_started, but the account is live and has been receiving real calls
 * for weeks (confirmed via CallRail weekly reports + the call log
 * Sebastien pasted). Correcting the stale status.
 *
 *   npm run oneoff-mark-dpg-callrail-checklist-done -- --dry-run=true  (default)
 *   npm run oneoff-mark-dpg-callrail-checklist-done -- --dry-run=false
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const dryRun = process.argv.includes("--dry-run=false") ? false : true;
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: client } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE lower(name) LIKE '%diesel%' OR lower(name) LIKE '%dpg%'`,
    );
    if (client.length === 0) { console.log("No DPG client found."); return; }
    const clientId = client[0]!.id;

    const { rows: commitments } = await c.query<{ id: string; title: string; status: string }>(
      `SELECT id, title, status FROM commitments WHERE client_id = $1 AND title ILIKE '%callrail%'`,
      [clientId],
    );
    console.log(`Matching commitment(s):`, commitments);
    if (commitments.length === 0) { console.log("Nothing to fix."); return; }

    if (dryRun) {
      console.log("DRY RUN -- would set status='complete' on the row(s) above. Re-run with --dry-run=false to apply.");
      return;
    }

    for (const row of commitments) {
      await c.query(`UPDATE commitments SET status = 'complete', completed_at = now() WHERE id = $1`, [row.id]);
      console.log(`Marked complete: ${row.title} (${row.id})`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

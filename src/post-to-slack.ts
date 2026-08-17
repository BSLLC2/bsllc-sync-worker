#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Posts CRM→Slack updates the app enqueues in client_slack_posts to each
 * client's Slack channel (clients.slack_channel_id), keeping Slack consistent
 * with the CRM. The deployed app makes no third-party calls; this worker holds
 * the Slack bot token and does the posting.
 *
 * Env: SLACK_BOT_TOKEN (the bot must be a member of each client channel).
 *
 *   npm run post-to-slack
 *   npm run post-to-slack -- --dry-run
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) { console.log("SLACK_BOT_TOKEN not set — nothing to do."); return; }

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query<{ id: string; text: string; channel: string | null; client_name: string }>(
      `SELECT p.id, p.text, cl.slack_channel_id AS channel, cl.name AS client_name
         FROM client_slack_posts p JOIN clients cl ON cl.id = p.client_id
        WHERE p.status = 'pending'
        ORDER BY p.created_at ASC LIMIT 100`,
    );
    if (rows.length === 0) { console.log("post-to-slack — nothing pending."); return; }
    console.log(`post-to-slack — ${rows.length} pending${dryRun ? " (dry-run)" : ""}`);

    let sent = 0, skipped = 0;
    for (const r of rows) {
      if (!r.channel?.trim()) {
        // No channel wired for this client yet — mark skipped so it doesn't pile up.
        if (!dryRun) await c.query(`UPDATE client_slack_posts SET status='skipped', sent_at=now() WHERE id=$1`, [r.id]);
        console.log(`  skip ${r.client_name}: no slack_channel_id set`); skipped++; continue;
      }
      if (dryRun) { console.log(`  would post to ${r.client_name} (${r.channel}): ${r.text.slice(0, 60)}…`); continue; }
      try {
        const res = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ channel: r.channel.trim(), text: r.text, unfurl_links: false }),
        });
        const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!j.ok) throw new Error(j.error || `HTTP ${res.status}`);
        await c.query(`UPDATE client_slack_posts SET status='sent', sent_at=now() WHERE id=$1`, [r.id]);
        console.log(`  ✓ ${r.client_name} → posted`); sent++;
      } catch (e) {
        console.log(`  ✗ ${r.client_name}: ${e instanceof Error ? e.message : e} — stays pending, retries next run`);
      }
    }
    console.log(`Done: ${sent} posted, ${skipped} skipped.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

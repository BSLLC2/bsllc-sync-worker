#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Notify the team when a client leaves a comment on their report. Runs in the
 * worker (the dashboard makes zero third-party calls by design). Posts to Slack;
 * dedupes with a `notified_at` stamp the worker owns (the dashboard's Drizzle
 * schema doesn't need to know about it). First run baselines existing comments
 * so we never spam a backlog — only comments from the last few days notify.
 */
const DASH = "https://bsllc-account-health.vercel.app";
const RECENT_DAYS = 3;
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!webhook) { console.log("SLACK_WEBHOOK_URL not set — nothing to do."); return; }

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    // Worker-owned dedupe column (idempotent; not part of the app's schema).
    await c.query(`ALTER TABLE client_feedback ADD COLUMN IF NOT EXISTS notified_at timestamptz`);

    const { rows } = await c.query<{
      id: string; client_id: string; client_name: string; am_owner: string | null;
      task_title: string | null; author_name: string | null; body: string; created_at: string;
      recent: boolean;
    }>(
      `SELECT f.id, f.client_id,
              cl.name AS client_name, cl.am_owner,
              cm.title AS task_title,
              f.author_name, f.body, f.created_at,
              (f.created_at > now() - ($1 || ' days')::interval) AS recent
         FROM client_feedback f
         JOIN clients cl ON cl.id = f.client_id
         LEFT JOIN commitments cm ON cm.id = f.commitment_id
        WHERE f.author_side = 'client' AND f.notified_at IS NULL
        ORDER BY f.created_at ASC`,
      [String(RECENT_DAYS)],
    );

    let sent = 0, baselined = 0;
    for (const r of rows) {
      if (r.recent) {
        const lines = [
          `:speech_balloon: *New client comment — ${r.client_name}*${r.task_title ? ` · on _${r.task_title}_` : ""}`,
          `>>> ${r.body}`,
          `— ${r.author_name || "Client"}${r.am_owner ? ` · AM: ${r.am_owner}` : ""}   <${DASH}/#/client/${r.client_id}|Open in dashboard →>`,
        ];
        const res = await fetch(webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: lines.join("\n") }),
        });
        if (!res.ok) { console.log(`Slack post failed (${res.status}) for ${r.id} — will retry next run`); continue; }
        sent++;
      } else {
        baselined++;
      }
      await c.query(`UPDATE client_feedback SET notified_at = now() WHERE id = $1`, [r.id]);
    }
    console.log(`Done: ${sent} notified, ${baselined} baselined (old), ${rows.length} total unnotified.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

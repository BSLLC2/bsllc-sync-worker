#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import webpush from "web-push";

/**
 * Sends browser push notifications for new client comments. The deployed app
 * stores push subscriptions + the comments; this worker (which holds the VAPID
 * private key) does the actual sending. Dedupes with a worker-owned `pushed_at`
 * stamp on client_feedback, independent of the Slack notifier's `notified_at`.
 * First run baselines the backlog so nobody gets spammed.
 *
 * Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:… or a URL).
 * Generate a keypair once with:  npx web-push generate-vapid-keys
 *
 *   npm run send-push
 *   npm run send-push -- --dry-run
 */
const DASH = (process.env.DASHBOARD_URL || "https://bsllc-account-health.vercel.app").replace(/\/+$/, "");
const RECENT_DAYS = 3;
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!pub || !priv) { console.log("VAPID keys not set — nothing to do. Run `npx web-push generate-vapid-keys`."); return; }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || "mailto:digital@bsllc.biz", pub, priv);

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    // Worker-owned dedupe column (idempotent; not part of the app's schema).
    await c.query(`ALTER TABLE client_feedback ADD COLUMN IF NOT EXISTS pushed_at timestamptz`);

    const { rows: comments } = await c.query<{
      id: string; client_id: string; client_name: string; task_title: string | null;
      author_name: string | null; body: string; recent: boolean;
    }>(
      `SELECT f.id, f.client_id, cl.name AS client_name, cm.title AS task_title,
              f.author_name, f.body,
              (f.created_at > now() - ($1 || ' days')::interval) AS recent
         FROM client_feedback f
         JOIN clients cl ON cl.id = f.client_id
         LEFT JOIN commitments cm ON cm.id = f.commitment_id
        WHERE f.author_side = 'client' AND f.pushed_at IS NULL
        ORDER BY f.created_at ASC`,
      [String(RECENT_DAYS)],
    );
    if (comments.length === 0) { console.log("send-push — nothing new."); return; }

    const { rows: subs } = await c.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions`,
    );
    console.log(`send-push — ${comments.length} comment(s), ${subs.length} subscription(s)${dryRun ? " (dry-run)" : ""}`);

    let pushed = 0, baselined = 0, pruned = 0;
    for (const cm of comments) {
      if (cm.recent && subs.length > 0) {
        const payload = JSON.stringify({
          title: `New comment — ${cm.client_name}`,
          body: `${cm.task_title ? `${cm.task_title}: ` : ""}${cm.body}`.slice(0, 180),
          url: `/#/client/${cm.client_id}`,
          tag: `comment-${cm.id}`,
        });
        for (const s of subs) {
          if (dryRun) { console.log(`  would push "${cm.client_name}" → ${s.endpoint.slice(0, 40)}…`); continue; }
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          } catch (e) {
            const code = (e as { statusCode?: number }).statusCode;
            if (code === 404 || code === 410) { await c.query(`DELETE FROM push_subscriptions WHERE id=$1`, [s.id]); pruned++; }
            else console.log(`  push failed (${code ?? "?"}) for ${s.endpoint.slice(0, 30)}…`);
          }
        }
        pushed++;
      } else {
        baselined++;
      }
      if (!dryRun) await c.query(`UPDATE client_feedback SET pushed_at = now() WHERE id = $1`, [cm.id]);
    }
    console.log(`Done: ${pushed} comment(s) pushed, ${baselined} baselined, ${pruned} dead subscription(s) pruned.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

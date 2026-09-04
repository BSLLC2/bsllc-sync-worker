#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import webpush from "web-push";

/**
 * Delivers internal team notifications (task @mentions, AM review pings) the app
 * enqueues in team_notifications. Routes each to the recipient's chosen channels
 * from their user prefs: web push (VAPID), Slack DM (bot token), SMS (Twilio —
 * dark until configured). Marks each row sent; safe to re-run.
 *
 * Env: VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT (push, shared with send-push),
 *      SLACK_BOT_TOKEN (optional, per-person Slack DMs),
 *      TWILIO_* (optional; SMS stays off until present).
 *
 *   npm run send-team-notifications
 *   npm run send-team-notifications -- --dry-run
 */
const DASH = (process.env.DASHBOARD_URL || "https://bsllc-account-health.vercel.app").replace(/\/+$/, "");
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function slackDm(token: string, slackUserId: string, text: string): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: slackUserId, text }),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!j.ok) throw new Error(`Slack DM failed: ${j.error || res.status}`);
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const vapidPub = process.env.VAPID_PUBLIC_KEY?.trim();
  const vapidPriv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (vapidPub && vapidPriv) webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || "mailto:digital@bsllc.biz", vapidPub, vapidPriv);
  const slackToken = process.env.SLACK_BOT_TOKEN?.trim();
  const twilioReady = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query<{ id: string; user_email: string; kind: string; title: string; body: string | null; url: string | null }>(
      `SELECT id, user_email, kind, title, body, url FROM team_notifications WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100`,
    );
    if (rows.length === 0) { console.log("send-team-notifications — nothing pending."); return; }
    console.log(`send-team-notifications — ${rows.length} pending${dryRun ? " (dry-run)" : ""}`);

    let delivered = 0;
    for (const n of rows) {
      const { rows: urows } = await c.query<{ notify_push: boolean; notify_slack: boolean; notify_text: boolean; phone: string | null; slack_user_id: string | null }>(
        `SELECT notify_push, notify_slack, notify_text, phone, slack_user_id FROM users WHERE email = $1`,
        [n.user_email],
      );
      const u = urows[0];
      if (!u) {
        await c.query(`UPDATE team_notifications SET status='failed', sent_at=now() WHERE id=$1`, [n.id]);
        console.log(`  ✗ ${n.user_email} · ${n.kind} → no such user`);
        continue;
      }
      const link = n.url ? (n.url.startsWith("http") ? n.url : `${DASH}${n.url}`) : DASH;
      const channels: string[] = [];

      if (dryRun) {
        if (u.notify_push) channels.push("push");
        if (u.notify_slack && u.slack_user_id) channels.push("slack");
        if (u.notify_text && u.phone) channels.push(twilioReady ? "sms" : "sms(dark)");
        console.log(`  ${n.user_email} · ${n.kind} → ${channels.join(", ") || "no channels"}`);
        continue;
      }

      // Push
      if (u.notify_push && vapidPub && vapidPriv) {
        const { rows: subs } = await c.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
          `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_email = $1`, [n.user_email],
        );
        const payload = JSON.stringify({ title: n.title, body: n.body || "", url: n.url || "/", tag: n.id });
        for (const s of subs) {
          try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); }
          catch (e) { const code = (e as { statusCode?: number }).statusCode; if (code === 404 || code === 410) await c.query(`DELETE FROM push_subscriptions WHERE id=$1`, [s.id]); }
        }
        if (subs.length) channels.push("push");
      }
      // Slack DM
      if (u.notify_slack && u.slack_user_id && slackToken) {
        try { await slackDm(slackToken, u.slack_user_id, `*${n.title}*\n${n.body || ""}\n${link}`); channels.push("slack"); }
        catch (e) { console.log(`  slack failed for ${n.user_email}: ${e instanceof Error ? e.message : e}`); }
      }
      // SMS (dark until Twilio configured)
      if (u.notify_text && u.phone && twilioReady) {
        try {
          const sid = env("TWILIO_ACCOUNT_SID");
          const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
            method: "POST",
            headers: { Authorization: "Basic " + Buffer.from(`${sid}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ To: u.phone, From: env("TWILIO_FROM"), Body: `${n.title}\n${link}` }),
          });
          if (res.ok) channels.push("sms"); else console.log(`  sms failed for ${n.user_email}: ${res.status}`);
        } catch (e) { console.log(`  sms error for ${n.user_email}: ${e instanceof Error ? e.message : e}`); }
      }

      // Only mark 'sent' if something was actually delivered — previously this
      // always marked 'sent' even when every enabled channel failed (or the
      // user had none configured), silently losing the notification instead
      // of surfacing it as a delivery failure worth investigating.
      const delivered_ = channels.length > 0;
      await c.query(`UPDATE team_notifications SET status=$2, sent_at=now() WHERE id=$1`, [n.id, delivered_ ? "sent" : "failed"]);
      console.log(`  ${delivered_ ? "✓" : "✗"} ${n.user_email} · ${n.kind} → ${channels.join(", ") || "no active channel"}`);
      if (delivered_) delivered++;
    }
    console.log(`Done: ${delivered} delivered.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

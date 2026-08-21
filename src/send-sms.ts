#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Drains the dashboard's `sms_messages` outbound queue via Dialpad. The
 * deployed app makes ZERO third-party calls — it enqueues rows status='queued';
 * this worker holds the Dialpad API key and does the sending. Each teammate
 * texts clients from THEIR OWN assigned Dialpad user (users.dialpad_user_id,
 * set alongside users.dialpad_number in Settings) — looked up here by joining
 * on the row's user_email, so the queue row itself never needs to carry it.
 *
 * Dialpad: POST https://dialpad.com/api/v2/sms
 *   Header:  Authorization: Bearer <DIALPAD_API_KEY>
 *   Body:    { to_numbers: [toNumber], text, user_id }
 * On 2xx → status='sent', provider_message_id=<id>, sent_at=now().
 * On error → status='failed', error_text=<msg>.
 *
 * NOTE: field names above are the best-confidence read from Dialpad's public
 * docs/search results (developers.dialpad.com was unreachable while writing
 * this) — treat the exact response shape as unverified until the first real
 * send confirms it, and adjust `sendViaDialpad` if the live response differs.
 *
 * Dormant-ready: if DIALPAD_API_KEY is unset, logs and exits 0 (nothing sent,
 * no failures) so the workflow is safe to schedule before secrets exist.
 *
 *   npm run send-sms
 *   npm run send-sms -- --dry-run
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

interface QueuedSms {
  id: string;
  body: string;
  from_number: string | null;
  to_number: string | null;
  user_email: string | null;
  dialpad_user_id: string | null;
  created_at: string;
}

// A transient Dialpad/network error (5xx, timeout, rate limit) used to mark
// the row 'failed' on the very first attempt — one blip and the text was
// gone for good, since nothing re-selects a 'failed' row. Now it's left as
// 'queued' (this cron runs every few minutes, see send-sms.yml) so the next
// run retries automatically, and only gives up for real once a row has been
// sitting in the queue this long — several runs' worth of chances.
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;

interface DialpadResp {
  id?: string;
  message_id?: string;
}

async function sendViaDialpad(apiKey: string, userId: string, to: string, text: string): Promise<string> {
  const res = await fetch("https://dialpad.com/api/v2/sms", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to_numbers: [to], text, user_id: userId }),
  });
  const responseText = await res.text();
  if (!res.ok) throw new Error(`Dialpad → ${res.status} ${responseText.slice(0, 300)}`);
  let json: DialpadResp = {};
  try { json = responseText ? (JSON.parse(responseText) as DialpadResp) : {}; } catch { /* non-JSON 2xx */ }
  return json.id ?? json.message_id ?? "";
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const apiKey = process.env.DIALPAD_API_KEY?.trim();
  if (!apiKey && !dryRun) {
    console.log("DIALPAD_API_KEY not set — nothing sent.");
    return;
  }

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query<QueuedSms>(
      `SELECT m.id, m.body, m.from_number, m.to_number, m.user_email, m.created_at, u.dialpad_user_id
         FROM sms_messages m
         LEFT JOIN users u ON u.email = m.user_email
        WHERE m.status = 'queued' AND m.direction = 'outbound'
        ORDER BY m.created_at ASC
        LIMIT 50`,
    );
    if (rows.length === 0) { console.log(`send-sms — nothing queued${dryRun ? " (dry-run)" : ""}.`); return; }
    console.log(`send-sms — ${rows.length} queued${dryRun ? " (dry-run)" : ""}`);

    let sent = 0, failed = 0, retrying = 0;
    for (const r of rows) {
      const to = r.to_number?.trim();
      const userId = r.dialpad_user_id?.trim();
      if (!to || !userId) {
        const reason = !to ? "missing to number" : "sender has no Dialpad user id set (Settings)";
        if (!dryRun) await c.query(`UPDATE sms_messages SET status='failed', error_text=$2 WHERE id=$1`, [r.id, reason]);
        console.log(`  ✗ ${r.id}: ${reason}`); failed++; continue;
      }
      if (dryRun) { console.log(`  would send ${r.from_number ?? userId} → ${to}: ${r.body.slice(0, 60)}…`); sent++; continue; }
      try {
        const providerMessageId = await sendViaDialpad(apiKey!, userId, to, r.body);
        await c.query(
          `UPDATE sms_messages SET status='sent', provider_message_id=$2, sent_at=now(), error_text=NULL WHERE id=$1`,
          [r.id, providerMessageId || null],
        );
        console.log(`  ✓ ${r.from_number ?? userId} → ${to} (${r.user_email ?? "?"})`); sent++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const ageMs = Date.now() - new Date(r.created_at).getTime();
        if (ageMs > GIVE_UP_AFTER_MS) {
          await c.query(`UPDATE sms_messages SET status='failed', error_text=$2 WHERE id=$1`, [r.id, `Gave up after retrying for 24h: ${msg}`.slice(0, 500)]);
          console.log(`  ✗ ${r.id} (${to}): giving up after 24h of retries — ${msg}`); failed++;
        } else {
          // Leave status='queued' — record the error for visibility, next run retries it.
          await c.query(`UPDATE sms_messages SET error_text=$2 WHERE id=$1`, [r.id, msg.slice(0, 500)]);
          console.log(`  ⟳ ${r.id} (${to}): will retry — ${msg}`); retrying++;
        }
      }
    }
    console.log(`Done: ${sent} ${dryRun ? "to send" : "sent"}, ${failed} failed, ${retrying} will retry.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

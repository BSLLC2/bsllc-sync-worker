#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Drains the dashboard's `sms_messages` outbound queue via OpenPhone. The
 * deployed app makes ZERO third-party calls — it enqueues rows status='queued';
 * this worker holds the OpenPhone API key and does the sending. Each teammate
 * texts clients from THEIR OWN assigned OpenPhone number (stored on the row's
 * from_number, seeded from users.openphone_number).
 *
 * OpenPhone: POST https://api.openphone.com/v1/messages
 *   Header:  Authorization: <OPENPHONE_API_KEY>   (raw key, NOT "Bearer")
 *   Body:    { content, from, to: [toNumber] }
 * On 2xx → status='sent', openphone_id=<id>, sent_at=now().
 * On error → status='failed', error_text=<msg>.
 *
 * Dormant-ready: if OPENPHONE_API_KEY is unset, logs and exits 0 (nothing sent,
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
}

interface OpenPhoneResp {
  data?: { id?: string };
  id?: string;
}

async function sendViaOpenPhone(apiKey: string, from: string, to: string, content: string): Promise<string> {
  const res = await fetch("https://api.openphone.com/v1/messages", {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ content, from, to: [to] }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenPhone → ${res.status} ${text.slice(0, 300)}`);
  let json: OpenPhoneResp = {};
  try { json = text ? (JSON.parse(text) as OpenPhoneResp) : {}; } catch { /* non-JSON 2xx */ }
  return json.data?.id ?? json.id ?? "";
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const apiKey = process.env.OPENPHONE_API_KEY?.trim();
  if (!apiKey && !dryRun) {
    console.log("OPENPHONE_API_KEY not set — nothing sent.");
    return;
  }

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query<QueuedSms>(
      `SELECT id, body, from_number, to_number, user_email
         FROM sms_messages
        WHERE status = 'queued' AND direction = 'outbound'
        ORDER BY created_at ASC
        LIMIT 50`,
    );
    if (rows.length === 0) { console.log(`send-sms — nothing queued${dryRun ? " (dry-run)" : ""}.`); return; }
    console.log(`send-sms — ${rows.length} queued${dryRun ? " (dry-run)" : ""}`);

    let sent = 0, failed = 0;
    for (const r of rows) {
      const from = r.from_number?.trim();
      const to = r.to_number?.trim();
      if (!from || !to) {
        if (!dryRun) await c.query(`UPDATE sms_messages SET status='failed', error_text=$2 WHERE id=$1`, [r.id, "missing from/to number"]);
        console.log(`  ✗ ${r.id}: missing from/to number`); failed++; continue;
      }
      if (dryRun) { console.log(`  would send ${from} → ${to}: ${r.body.slice(0, 60)}…`); sent++; continue; }
      try {
        const openphoneId = await sendViaOpenPhone(apiKey!, from, to, r.body);
        await c.query(
          `UPDATE sms_messages SET status='sent', openphone_id=$2, sent_at=now(), error_text=NULL WHERE id=$1`,
          [r.id, openphoneId || null],
        );
        console.log(`  ✓ ${from} → ${to} (${r.user_email ?? "?"})`); sent++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await c.query(`UPDATE sms_messages SET status='failed', error_text=$2 WHERE id=$1`, [r.id, msg.slice(0, 500)]);
        console.log(`  ✗ ${r.id} (${to}): ${msg}`); failed++;
      }
    }
    console.log(`Done: ${sent} ${dryRun ? "to send" : "sent"}, ${failed} failed.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

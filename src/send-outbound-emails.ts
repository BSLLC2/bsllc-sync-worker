#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { JWT } from "google-auth-library";

/**
 * Drains the dashboard's `outbound_emails` queue (the deployed app makes zero
 * third-party calls — it enqueues, we send). v1 handles the subcontractor
 * onboarding invite: "Send onboarding" in the vendor bench drops a row here and
 * this delivers it from digital@ via the Gmail domain-wide delegation.
 *
 * Auth reuses the same service account + gmail.send scope as send-notifications,
 * impersonating digital@. Rows are marked sent/failed so it's safe to re-run and
 * failures retry on the next pass.
 *
 *   npm run send-outbound-emails
 *   npm run send-outbound-emails -- --dry-run
 */
const FROM = process.env.NOTIFY_FROM || "digital@bsllc.biz";
const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
function serviceAccount(): { client_email: string; private_key: string } {
  const j = JSON.parse(env("GOOGLE_SERVICE_ACCOUNT_JSON"));
  if (!j.client_email || !j.private_key) throw new Error("Service-account JSON missing client_email / private_key.");
  return j;
}
async function sendAsDigital(rfc822: string): Promise<void> {
  const sa = serviceAccount();
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SEND_SCOPE], subject: FROM });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error(`Failed to mint a Gmail send token for ${FROM}.`);
  const raw = Buffer.from(rfc822).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send → ${res.status} ${await res.text()}`);
}

// Header fields are ASCII-only per RFC 2822 -- any non-ASCII (e.g. the em
// dash in "Welcome — set up your BS LLC dashboard") has to be wrapped as an
// RFC 2047 encoded-word or it gets left as raw UTF-8 bytes sitting in a
// header, which some renderers along the way then mis-decode as Latin-1,
// producing exactly the "Ã¢Â€Â"" garbage that showed up in a client's inbox.
// The body parts already declare charset=UTF-8 and are unaffected -- this is
// header-only.
function encodeHeaderWord(s: string): string {
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/** RFC822 with an HTML part (links clickable) + a plain-text fallback. */
function buildEmail(to: string, toName: string | null, subject: string, body: string, ccEmail: string | null): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Turn bare URLs into links and newlines into <br> for the HTML part.
  const htmlBody = esc(body)
    .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, "<br>");
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111;font-size:15px;line-height:1.5">${htmlBody}</div>`;
  const boundary = "bsllc_" + Math.abs(hash(subject + to)).toString(36);
  const toHeader = toName ? `${encodeHeaderWord(toName)} <${to}>` : to;
  return [
    `From: BS LLC <${FROM}>`,
    `To: ${toHeader}`,
    ...(ccEmail?.trim() ? [`Cc: ${ccEmail.trim()}`] : []),
    `Subject: ${encodeHeaderWord(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "",
    html,
    "",
    `--${boundary}--`,
  ].join("\r\n");
}
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query<{ id: string; kind: string; to_email: string; to_name: string | null; subject: string; body: string; cc_email: string | null }>(
      `SELECT id, kind, to_email, to_name, subject, body, cc_email
         FROM outbound_emails
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 100`,
    );
    console.log(`send-outbound-emails — ${rows.length} pending${dryRun ? " (dry-run)" : ""}`);
    let sent = 0, failed = 0;
    for (const r of rows) {
      if (!r.to_email?.trim()) {
        await c.query(`UPDATE outbound_emails SET status='failed', error=$2 WHERE id=$1`, [r.id, "no recipient email"]);
        console.log(`  skip ${r.id}: no recipient`); failed++; continue;
      }
      if (dryRun) { console.log(`  would send → ${r.to_email} · "${r.subject}"`); sent++; continue; }
      try {
        await sendAsDigital(buildEmail(r.to_email, r.to_name, r.subject, r.body, r.cc_email));
        await c.query(`UPDATE outbound_emails SET status='sent', sent_at=now(), error=NULL WHERE id=$1`, [r.id]);
        console.log(`  sent → ${r.to_email} (${r.kind})`); sent++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await c.query(`UPDATE outbound_emails SET error=$2 WHERE id=$1`, [r.id, msg.slice(0, 500)]);
        console.log(`  FAILED ${r.id} (${r.to_email}): ${msg} — stays pending, retries next run`); failed++;
      }
    }
    console.log(`Done: ${sent} ${dryRun ? "to send" : "sent"}, ${failed} failed.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

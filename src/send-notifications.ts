#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { JWT } from "google-auth-library";

/**
 * Sends the client-facing emails the dashboard enqueues in `notifications_outbox`
 * (the deployed app makes zero third-party calls). Handles two kinds:
 *   - milestone_review_request: a deliverable needs the client's e-signature —
 *     gated on the client's notify_approvals onboarding preference.
 *   - task_visible_update: a task was put on the client's dashboard without
 *     requiring a signature — gated on notify_updates.
 * Both preferences come from the client's latest onboarding submission
 * (email / text / both / none) — the app already skips enqueueing when the
 * relevant preference is "none", so nothing here needs to re-check that.
 *
 * SMS is not wired here yet (Dialpad go-live is still pending — see the
 * platform-wide task ledger) — "text" and "both" preferences still get the
 * email today; once Dialpad is live, add an SMS branch reusing send-sms.ts's
 * per-teammate Dialpad send, sourced from the client's mobile_number and the
 * account's AM.
 *
 * Auth reuses the Gmail domain-wide delegation (same service account as the
 * email importer), impersonating digital@ with the gmail.send scope. That scope
 * must be added to the delegation in Google Admin (Security → API controls →
 * Domain-wide delegation) alongside the existing gmail.readonly.
 *
 *   npm run send-notifications            (sends)
 *   npm run send-notifications -- --dry-run
 */
const DASH = (process.env.DASHBOARD_URL || "https://bsllc-account-health.vercel.app").replace(/\/+$/, "");
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
function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function buildEmail(kind: string, to: string, clientName: string, title: string, shareUrl: string, deliverable: string | null): string {
  const isSignoff = kind === "milestone_review_request";
  const subject = isSignoff ? `Ready for your review: ${title}` : `Update: ${title}`;
  const btn = `<a href="${esc(shareUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${isSignoff ? "Review in your dashboard →" : "See it in your dashboard →"}</a>`;
  const alt = deliverable ? `<p style="font-size:13px;color:#666">Or open it directly: <a href="${esc(deliverable)}">${esc(deliverable)}</a></p>` : "";
  const body = isSignoff
    ? `<p><strong>${esc(title)}</strong> is ready for your review. Take a look, then approve it or request changes — right from your dashboard.</p>`
    : `<p>There's a new update on your account: <strong>${esc(title)}</strong>. No action needed — just letting you know it landed.</p>`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">` +
    `<p>Hi ${esc(clientName)},</p>` +
    body +
    `<p style="margin:20px 0">${btn}</p>${alt}` +
    `<p style="font-size:12px;color:#999;margin-top:24px">— BS LLC</p></div>`;
  return [
    `From: BS LLC <${FROM}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    html,
  ].join("\r\n");
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query<{
      id: string; kind: string; commitment_id: string | null; payload_json: string | null;
      client_name: string; email: string | null; contact: string | null; token: string | null;
    }>(
      `SELECT n.id, n.kind, n.commitment_id, n.payload_json,
              cl.name AS client_name, cl.primary_contact_email AS email, cl.primary_contact AS contact,
              (SELECT token FROM client_share_tokens t WHERE t.client_id = n.client_id AND t.enabled = true
                 ORDER BY t.created_at DESC NULLS LAST LIMIT 1) AS token
         FROM notifications_outbox n
         JOIN clients cl ON cl.id = n.client_id
        WHERE n.sent_at IS NULL AND n.kind IN ('milestone_review_request', 'task_visible_update')
        ORDER BY n.created_at ASC`,
    );
    console.log(`send-notifications — ${rows.length} pending${dryRun ? " (dry-run)" : ""}`);

    let sent = 0, skipped = 0;
    for (const r of rows) {
      const payload = r.payload_json ? (JSON.parse(r.payload_json) as { title?: string; link?: string }) : {};
      const title = payload.title || (r.kind === "milestone_review_request" ? "A deliverable" : "An update");
      if (!r.email) { console.log(`  skip ${r.id}: ${r.client_name} has no lead email — add one on the client page.`); skipped++; continue; }
      if (!r.token) { console.log(`  skip ${r.id}: ${r.client_name} has no active share link — enable one first.`); skipped++; continue; }
      const shareUrl = `${DASH}/#/share/${r.token}`;
      const greetName = (r.contact && r.contact.trim()) || r.client_name;
      if (dryRun) { console.log(`  would email ${r.email} (${r.client_name}) — [${r.kind}] "${title}" → ${shareUrl}`); sent++; continue; }
      try {
        await sendAsDigital(buildEmail(r.kind, r.email, greetName, title, shareUrl, payload.link ?? null));
        await c.query(`UPDATE notifications_outbox SET sent_at = now() WHERE id = $1`, [r.id]);
        console.log(`  sent → ${r.email} (${r.client_name})`);
        sent++;
      } catch (e) {
        console.log(`  FAILED ${r.id} (${r.client_name}): ${e instanceof Error ? e.message : e} — will retry next run`);
        skipped++;
      }
    }
    console.log(`Done: ${sent} ${dryRun ? "to send" : "sent"}, ${skipped} skipped.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

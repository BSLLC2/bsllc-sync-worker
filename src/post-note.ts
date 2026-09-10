#!/usr/bin/env tsx
import "dotenv/config";

/** Post one plain-text note to the team Slack channel via SLACK_WEBHOOK_URL.
 *  Used by the morning agent session to report what it fixed, since the
 *  session itself holds no Slack credential.
 *
 *    NOTE="..." npm run post-note
 */
async function main() {
  const text = (process.env.NOTE || "").trim();
  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!text) throw new Error("NOTE is empty");
  if (!webhook) { console.log(`SLACK_WEBHOOK_URL not set — would post:\n${text}`); return; }
  const res = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 3900) }) });
  console.log(res.ok ? "Posted." : `Slack post failed (${res.status}).`);
  if (!res.ok) process.exit(1);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

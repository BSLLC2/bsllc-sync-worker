#!/usr/bin/env tsx
import "dotenv/config";

/**
 * Read-only Slack connectivity check. Calls auth.test with SLACK_BOT_TOKEN —
 * posts NO message — and prints the workspace + bot identity the token resolves
 * to. Use it to confirm the bot token is valid before trusting CRM→Slack posts.
 *
 *   npm run verify-slack
 */
async function main() {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) throw new Error("Missing SLACK_BOT_TOKEN");
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; team?: string; user?: string; url?: string };
  if (!j.ok) throw new Error(`Slack auth.test failed: ${j.error || `HTTP ${res.status}`}`);
  console.log(`✓ Slack auth OK — workspace "${j.team}" as bot "${j.user}" (${j.url})`);
  console.log("  (read-only check — no message was posted)");
}

main().catch((e) => { console.error("✗ Slack verify FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Keeps slack_user_cache warm so the client-detail Slack tab can show real
 * names instead of raw "U0123ABC" ids. The app never calls the Slack API
 * itself (zero third-party calls); this worker calls users.list on a
 * schedule and upserts id -> display name pairs the app just reads.
 *
 * Env: SLACK_BOT_TOKEN (needs the users:read scope).
 *
 *   npm run sync-slack-users
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

interface SlackUser {
  id: string;
  deleted?: boolean;
  is_bot?: boolean;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}

async function main() {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) { console.log("SLACK_BOT_TOKEN not set — nothing to do."); return; }

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    let cursor = "";
    let upserted = 0;
    do {
      const url = new URL("https://slack.com/api/users.list");
      url.searchParams.set("limit", "200");
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; members?: SlackUser[];
        response_metadata?: { next_cursor?: string };
      };
      if (!j.ok) throw new Error(j.error || `HTTP ${res.status}`);

      for (const u of j.members ?? []) {
        if (u.deleted || u.is_bot) continue;
        const name = u.profile?.display_name?.trim() || u.profile?.real_name?.trim() || u.real_name?.trim();
        if (!name) continue;
        await c.query(
          `INSERT INTO slack_user_cache (slack_user_id, display_name, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (slack_user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
          [u.id, name],
        );
        upserted++;
      }
      cursor = j.response_metadata?.next_cursor || "";
    } while (cursor);

    console.log(`sync-slack-users — ✓ ${upserted} users cached.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

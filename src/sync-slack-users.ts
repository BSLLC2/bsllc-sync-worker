#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Keeps slack_user_cache warm so the client-detail Slack tab can show real
 * names instead of raw "U0123ABC" ids. The app never calls the Slack API
 * itself (zero third-party calls); this worker calls users.list on a
 * schedule and upserts id -> display name pairs the app just reads.
 *
 * AND, since 2026-10-01, it fills in `users.slack_user_id` -- which is what
 * per-person Slack DMs have always been missing. Measured that morning: all
 * six people had a null there, so notify_slack could not deliver for anyone
 * however it was toggled, and 449 notifications had queued for one person in
 * 30 days with 6 delivered. Nobody is going to go and find their own member
 * ID, and they should not have to: users.list already returns the email beside
 * the id, and this job was already running and already throwing that half of
 * the payload away.
 *
 * It belongs here rather than in the app for the ordinary reason -- reading a
 * third party is the worker's job and the credential lives here. Nothing new
 * is needed on Vercel: send-team-notifications.ts already sends the DM with
 * this same token, so an id written here is a DM delivered within minutes.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO.
 *
 * It never OVERWRITES an id somebody already has. A person's own answer beats
 * a derived one, and a mis-set id is a DM going to a stranger.
 *
 * It never switches `notify_slack` on. Writing an id reveals nothing and sends
 * nothing; turning a delivery channel on is a choice each person makes about
 * their own attention, and flipping it for six people because a script could
 * is exactly the kind of thing that gets every notification muted. The run
 * says how many are one toggle away.
 *
 * Env: SLACK_BOT_TOKEN. users:read for the names; users:read.email for the
 * match. WITHOUT the email scope Slack simply omits profile.email, which is
 * indistinguishable from a person having no email on their Slack account --
 * so a run that sees NO emails at all reports that it could not look, rather
 * than reporting that nobody matched. Those are opposite findings.
 *
 *   npm run sync-slack-users
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

interface SlackUser {
  id: string;
  deleted?: boolean;
  is_bot?: boolean;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string; email?: string };
}

async function main() {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) { console.log("SLACK_BOT_TOKEN not set — nothing to do."); return; }

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    let cursor = "";
    let upserted = 0;
    /** lowercased email -> Slack member ID, collected across every page. */
    const slackIdByEmail = new Map<string, string>();
    do {
      const url = new URL("https://slack.com/api/users.list");
      url.searchParams.set("limit", "200");
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; members?: SlackUser[];
        response_metadata?: { next_cursor?: string };
      };
      if (!j.ok) {
        const err = j.error || `HTTP ${res.status}`;
        // This job has failed on every run since it was added (2026-08-20)
        // while the same token posts to Slack fine — i.e. the token works but
        // the app was never granted users:read. Say exactly that; the fix is
        // in the Slack app config, not in this code.
        const hint = err === "missing_scope"
          ? " — the bot token lacks the users:read scope. In api.slack.com → the BS LLC app → OAuth & Permissions, add users:read under Bot Token Scopes, reinstall the app to the workspace, then update the SLACK_BOT_TOKEN secret if the token changed."
          : /invalid_auth|token_revoked|account_inactive|not_authed/.test(err)
            ? " — SLACK_BOT_TOKEN is invalid or revoked; reinstall the Slack app and update the secret."
            : "";
        throw new Error(`Slack users.list failed: ${err}${hint}`);
      }

      for (const u of j.members ?? []) {
        if (u.deleted || u.is_bot) continue;

        // Collected across every page, then matched in one pass below. A
        // lowercase key because Slack and our own roster disagree about case
        // often enough to matter, and an address is not case-sensitive.
        const email = u.profile?.email?.trim().toLowerCase();
        if (email) slackIdByEmail.set(email, u.id);

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

    // ── The match, and what each outcome means ────────────────────────────
    //
    // NO emails at all across the whole workspace is the scope being absent,
    // not a workspace where nobody has an email. Saying "0 matched" there
    // would send somebody looking at the roster when the fix is one tick in
    // the Slack app config, so the two are reported as different things.
    if (slackIdByEmail.size === 0) {
      console.log(
        "  No Slack account returned an email address, so no member ID could be matched.\n" +
        "  That is the users:read.email scope missing rather than nobody matching: in\n" +
        "  api.slack.com → the BS LLC app → OAuth & Permissions, add users:read.email under\n" +
        "  Bot Token Scopes, reinstall to the workspace, and update SLACK_BOT_TOKEN if it changed.",
      );
    } else {
      const { rows: people } = await c.query<{ email: string; name: string | null; slack_user_id: string | null; notify_slack: boolean }>(
        `SELECT email, name, slack_user_id, notify_slack FROM users ORDER BY email`,
      );

      let linked = 0;
      const alreadySet: string[] = [];
      const noSlackAccount: string[] = [];
      const oneToggleAway: string[] = [];

      for (const p of people) {
        // Never overwrite. A person's own answer beats a derived one, and a
        // wrong id here is a direct message to a stranger.
        if (p.slack_user_id?.trim()) { alreadySet.push(p.email); continue; }

        const id = slackIdByEmail.get(p.email.trim().toLowerCase());
        if (!id) { noSlackAccount.push(p.email); continue; }

        await c.query(`UPDATE users SET slack_user_id = $2 WHERE email = $1`, [p.email, id]);
        linked++;
        // Writing the id sends nothing. The toggle is theirs to turn on, so
        // the run counts who is now one tick from a working DM rather than
        // turning it on for them.
        if (!p.notify_slack) oneToggleAway.push(p.name?.trim() || p.email);
      }

      console.log(`  ${linked} member ID(s) matched by email and written; ${alreadySet.length} already had one.`);
      if (noSlackAccount.length) {
        console.log(`  ${noSlackAccount.length} with no Slack account at that address: ${noSlackAccount.join(", ")}`);
      }
      if (oneToggleAway.length) {
        console.log(
          `  ${oneToggleAway.length} now one toggle from working Slack DMs — they switch "Slack DM" on\n` +
          `  themselves in Settings → Notifications: ${oneToggleAway.join(", ")}`,
        );
      }
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

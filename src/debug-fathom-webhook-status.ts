#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only diagnostic: is the Fathom meeting-notes webhook actually being
 * hit, and if so, is it matching clients? fathom_webhook_log captures EVERY
 * inbound call (raw body included) -- but only once the request clears the
 * FATHOM_SECRET check in server/routes.ts's /api/fathom-webhook handler.
 * Zero rows ever, with no recent activity, points at the secret/URL being
 * wrong on Fathom's/Zapier's side (rejected before ever reaching the log
 * call) rather than a matching bug -- those two failure modes look
 * identical from the Fathom side (nothing shows up) but need different
 * fixes, so this pulls both counts and the most recent rows to tell them
 * apart.
 *
 *   npm run debug-fathom-webhook-status
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: totalRow } = await c.query<{ n: string }>(`SELECT COUNT(*) AS n FROM fathom_webhook_log`);
    console.log(`Total fathom_webhook_log rows (ever): ${totalRow[0]!.n}`);

    const { rows: last30 } = await c.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM fathom_webhook_log WHERE received_at > now() - interval '30 days'`,
    );
    console.log(`Rows in the last 30 days: ${last30[0]!.n}`);

    const { rows: matchedCounts } = await c.query<{ matched: boolean; n: string }>(
      `SELECT matched, COUNT(*) AS n FROM fathom_webhook_log GROUP BY matched`,
    );
    for (const r of matchedCounts) console.log(`  matched=${r.matched}: ${r.n}`);

    const { rows: recent } = await c.query<{ received_at: string; matched: boolean; client_name: string | null; action_items_found: number; raw_body: string }>(
      `SELECT received_at, matched, client_name, action_items_found, raw_body FROM fathom_webhook_log ORDER BY received_at DESC LIMIT 10`,
    );
    console.log(`\nMost recent 10 calls:`);
    for (const r of recent) {
      console.log(`  ${r.received_at}  matched=${r.matched}  client=${r.client_name ?? "(none)"}  action_items=${r.action_items_found}`);
    }
    if (recent[0]) {
      console.log(`\nMost recent raw body (truncated 1000 chars):`);
      console.log(recent[0].raw_body.slice(0, 1000));
    }

    // Cross-check: how many real client_meetings rows carry a Fathom-style
    // note (createdBy set from a host match, notes non-empty) in the last
    // 30 days, vs how many intake_items are source='fathom'.
    const { rows: recentMeetings } = await c.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM client_meetings WHERE created_at > now() - interval '30 days'`,
    );
    console.log(`\nclient_meetings created in the last 30 days (any source): ${recentMeetings[0]!.n}`);
    const { rows: fathomIntake } = await c.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM intake_items WHERE source = 'fathom' AND created_at > now() - interval '30 days'`,
    );
    console.log(`intake_items with source='fathom' in the last 30 days: ${fathomIntake[0]!.n}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

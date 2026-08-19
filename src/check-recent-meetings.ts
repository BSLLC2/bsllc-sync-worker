#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off diagnostic: prints the most recent client_meetings rows so we can
 * confirm a Fathom webhook test actually landed (or didn't) without digging
 * through the UI. Read-only.
 *
 *   npm run check-recent-meetings
 */
async function main() {
  const c = new pg.Client({ connectionString: (process.env.DATABASE_URL || "").trim() });
  await c.connect();
  try {
    const { rows } = await c.query(
      `SELECT m.id, c.name AS client_name, m.meeting_date, m.created_by, m.shared_with_client, m.created_at,
              LEFT(m.notes, 120) AS notes_preview
         FROM client_meetings m
         JOIN clients c ON c.id = m.client_id
        ORDER BY m.created_at DESC
        LIMIT 5`,
    );
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

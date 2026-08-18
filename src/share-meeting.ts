#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Attach a meeting-notes doc to a client's public dashboard. Upserts a
 * client_meetings row (matched by client + date) with the Drive/Docs URL and
 * flips shared_with_client = true so it shows on the client report as a
 * "View notes" link. Safe to re-run — it updates the same day's row.
 *
 *   npm run share-meeting -- --client="LBL Law" --url="https://docs.google.com/..." --title="Weekly sync"
 *   npm run share-meeting -- --client="LBL Law" --url="https://docs.google.com/..." --date=2026-08-18
 */
function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
function genId(): string { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; }

async function main() {
  const clientName = arg("client") || "LBL Law";
  const url = arg("url");
  const notes = arg("notes") ?? null;
  const type = arg("type") || "check_in";
  const date = arg("date") || new Date().toISOString().slice(0, 10); // YYYY-MM-DD, today by default
  if (!url) throw new Error('Pass --url="<Google Doc / Drive URL>"');

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: cl } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE lower(trim(name)) = lower(trim($1)) LIMIT 1`, [clientName],
    );
    if (!cl[0]) { console.log(`No client named "${clientName}" — nothing to do.`); return; }
    const clientId = cl[0].id;

    // Same-day row? Update it. Else insert a fresh shared meeting.
    const { rows: existing } = await c.query<{ id: string }>(
      `SELECT id FROM client_meetings
        WHERE client_id = $1 AND meeting_date::date = $2::date
        ORDER BY created_at DESC LIMIT 1`,
      [clientId, date],
    );
    if (existing[0]) {
      await c.query(
        `UPDATE client_meetings
            SET agenda_doc_url = $2, shared_with_client = true,
                notes = COALESCE($3, notes)
          WHERE id = $1`,
        [existing[0].id, url, notes],
      );
      console.log(`✓ Updated ${clientName}'s ${date} meeting with the notes doc (shared).`);
    } else {
      await c.query(
        `INSERT INTO client_meetings
            (id, client_id, meeting_date, meeting_type, notes, agenda_doc_url, shared_with_client, created_by)
         VALUES ($1, $2, $3::date, $4, $5, $6, true, 'sync-worker')`,
        [genId(), clientId, date, type, notes, url],
      );
      console.log(`✓ Added a shared meeting for ${clientName} on ${date} with the notes doc.`);
    }
    console.log(`It now shows on ${clientName}'s dashboard under "Meeting notes" as "View notes ↗".`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ share-meeting failed:", e instanceof Error ? e.message : e); process.exit(1); });

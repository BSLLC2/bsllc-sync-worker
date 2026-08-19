#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: print a client's logged meetings (most recent first), so you can
 * sanity-check what was discussed before drafting a follow-up. Matches the
 * client by exact name first, then a safe case-insensitive substring.
 *
 *   npm run dump-client-meetings -- --client="LBL Law" [--limit=5]
 */
function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const clientName = arg("client");
  const limit = Number(arg("limit") || "5");
  if (!clientName) throw new Error('Pass --client="<name>"');

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    let { rows: cl } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE lower(trim(name)) = lower(trim($1))`, [clientName],
    );
    if (cl.length === 0) {
      ({ rows: cl } = await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM clients WHERE name ILIKE '%' || $1 || '%' ORDER BY name`, [clientName],
      ));
    }
    if (cl.length > 1) {
      console.log(`Ambiguous "${clientName}" — matches ${cl.length}: ${cl.map((x) => x.name).join(", ")}. Be more specific.`);
      return;
    }
    const client = cl[0];
    if (!client) { console.log(`No client matching "${clientName}".`); return; }

    const { rows } = await c.query<{
      id: string; meeting_date: Date; meeting_type: string; attendees: string | null;
      notes: string | null; agenda_doc_url: string | null; strategy_doc_url: string | null;
      next_meeting_date: Date | null; shared_with_client: boolean; created_by: string | null; created_at: Date;
    }>(
      `SELECT id, meeting_date, meeting_type, attendees, notes, agenda_doc_url, strategy_doc_url,
              next_meeting_date, shared_with_client, created_by, created_at
       FROM client_meetings WHERE client_id = $1 ORDER BY meeting_date DESC LIMIT $2`,
      [client.id, limit],
    );

    console.log(`\n=== ${client.name} — ${rows.length} most recent meeting(s) ===\n`);
    if (!rows.length) { console.log("No meetings logged for this client."); return; }
    for (const m of rows) {
      console.log(`--- ${m.meeting_date.toISOString().slice(0, 10)} · ${m.meeting_type} ${m.shared_with_client ? "· shared w/ client" : ""} ---`);
      if (m.attendees) console.log(`Attendees: ${m.attendees}`);
      if (m.next_meeting_date) console.log(`Next meeting: ${m.next_meeting_date.toISOString().slice(0, 10)}`);
      if (m.agenda_doc_url) console.log(`Agenda: ${m.agenda_doc_url}`);
      if (m.strategy_doc_url) console.log(`Strategy doc: ${m.strategy_doc_url}`);
      console.log(`Notes:\n${m.notes || "(none)"}`);
      console.log(`Logged by ${m.created_by || "?"} at ${m.created_at.toISOString()}\n`);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ dump-client-meetings failed:", e instanceof Error ? e.message : e); process.exit(1); });

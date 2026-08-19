#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: list a client's current commitments (tasks), most recently
 * updated first, so you can sanity-check a board state — e.g. confirm a
 * closed item stayed closed and sign-off state wasn't disturbed by a bulk
 * update. Matches the client by exact name first, then a safe
 * case-insensitive substring.
 *
 *   npm run dump-client-tasks -- --client="LBL Law" [--limit=200]
 */
function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const clientName = arg("client");
  const limit = Number(arg("limit") || "200");
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
      id: string; title: string; status: string; priority: string; workstream: string | null;
      category: string; am_review_state: string; is_milestone: boolean; due_date: string | null;
      assignee_name: string | null; updated_at: Date;
    }>(
      `SELECT id, title, status, priority, workstream, category, am_review_state, is_milestone, due_date, assignee_name, updated_at
       FROM commitments WHERE client_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [client.id, limit],
    );

    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

    console.log(`\n=== ${client.name} — ${rows.length} task(s) ===`);
    console.log(`By status: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(", ")}\n`);
    for (const r of rows) {
      const flags = [
        r.is_milestone ? "milestone" : null,
        r.am_review_state !== "none" ? `review:${r.am_review_state}` : null,
        r.workstream ? `ws:${r.workstream}` : null,
      ].filter(Boolean).join(" · ");
      console.log(`[${r.status}] ${r.title} (${r.priority}${r.due_date ? ` · due ${r.due_date}` : ""}${r.assignee_name ? ` · ${r.assignee_name}` : ""})${flags ? `  [${flags}]` : ""}`);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ dump-client-tasks failed:", e instanceof Error ? e.message : e); process.exit(1); });

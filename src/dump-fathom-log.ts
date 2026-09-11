#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: print the most recent fathom_webhook_log rows with their FULL
 * stored bodies (the debug-fathom-webhook-status report truncates to 1000
 * chars). Use it to see exactly what Fathom sent — key order, invitee
 * shape, assignee shape — before touching the dashboard's matcher.
 *
 *   npm run dump-fathom-log -- [--limit=8] [--unmatched-only]
 */
function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const limit = Math.max(1, Math.min(50, Number(arg("limit") || "8")));
  const unmatchedOnly = process.argv.includes("--unmatched-only");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query<{
      id: string; received_at: Date; matched: boolean; client_name: string | null; action_items_found: number;
      matched_by: string | null; items_queued: number | null; meeting_id: string | null; replayed_at: Date | null; raw_body: string;
    }>(
      `SELECT id, received_at, matched, client_name, action_items_found,
              matched_by, items_queued, meeting_id, replayed_at, raw_body
         FROM fathom_webhook_log
        ${unmatchedOnly ? "WHERE matched = false" : ""}
        ORDER BY received_at DESC LIMIT $1`,
      [limit],
    );
    console.log(`fathom_webhook_log — ${rows.length} most recent row(s)${unmatchedOnly ? " (unmatched only)" : ""}\n`);
    for (const r of rows) {
      let title = "?";
      let recorder = "?";
      let invitees = "?";
      try {
        const b = JSON.parse(r.raw_body) as Record<string, unknown>;
        title = String(b.title ?? b.meeting_title ?? "?");
        const rb = b.recorded_by as { name?: string; email?: string } | undefined;
        recorder = rb ? `${rb.name ?? ""} <${rb.email ?? ""}>` : "?";
        const inv = b.calendar_invitees as Array<{ name?: string; email?: string }> | undefined;
        invitees = Array.isArray(inv) ? inv.map((i) => i.email ?? i.name ?? "?").join(", ") : "?";
      } catch { /* not JSON — printed raw below */ }
      console.log(`=== ${r.id} · ${r.received_at.toISOString()} · matched=${r.matched} client=${r.client_name ?? "(none)"} by=${r.matched_by ?? "-"} items=${r.action_items_found} queued=${r.items_queued ?? "-"} meeting=${r.meeting_id ?? "-"} replayed=${r.replayed_at?.toISOString() ?? "-"}`);
      console.log(`    title: ${title}\n    recorded by: ${recorder}\n    invitees: ${invitees}`);
      console.log(`--- body (${r.raw_body.length} chars) ---`);
      console.log(r.raw_body);
      console.log();
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

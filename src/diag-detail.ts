#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/** Diagnostic: confirm the columns the dashboard's /api/clients/:id path depends
 *  on actually exist in production, and run the exact selects Drizzle issues. */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    for (const t of ["client_meetings", "client_feedback"]) {
      const r = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY 1`, [t]);
      console.log(`${t}: ${r.rows.map((x) => x.column_name).join(", ")}`);
    }
    const tries: Array<[string, string]> = [
      ["SELECT * FROM client_meetings", "SELECT * FROM client_meetings LIMIT 1"],
      ["client_feedback new cols", "SELECT id, commitment_id, author_side FROM client_feedback LIMIT 1"],
      ["client_meetings shared_with_client", "SELECT shared_with_client FROM client_meetings LIMIT 1"],
    ];
    for (const [label, q] of tries) {
      try { await c.query(q); console.log(`  ${label}: OK`); }
      catch (e) { console.log(`  ${label}: ERROR — ${e instanceof Error ? e.message : e}`); }
    }
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

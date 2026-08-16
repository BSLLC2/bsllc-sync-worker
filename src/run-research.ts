#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { credsFromEnv, keywordResearch } from "./dataforseo.js";

/**
 * Runs queued research requests against DataForSEO. The deployed app enqueues a
 * row in research_requests (it makes no third-party calls); this worker picks up
 * pending rows, runs the lookup, and writes the result JSON back. The UI polls.
 *
 *   npm run run-research
 *   npm run run-research -- --dry-run
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query<{ id: string; kind: string; query: string; location_name: string; language_name: string }>(
      `SELECT id, kind, query, location_name, language_name
         FROM research_requests
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 20`,
    );
    console.log(`run-research — ${rows.length} pending${dryRun ? " (dry-run)" : ""}`);
    if (rows.length === 0) return;

    const creds = credsFromEnv();
    let done = 0, failed = 0;
    for (const r of rows) {
      if (dryRun) { console.log(`  would run ${r.kind} "${r.query}" (${r.location_name})`); continue; }
      try {
        let result: unknown;
        if (r.kind === "keywords") {
          result = await keywordResearch(creds, r.query, r.location_name, r.language_name);
        } else {
          throw new Error(`Unknown research kind: ${r.kind}`);
        }
        await c.query(`UPDATE research_requests SET status='done', result_json=$2, error=NULL, completed_at=now() WHERE id=$1`, [r.id, JSON.stringify(result)]);
        console.log(`  ✓ ${r.kind} "${r.query}" → done`);
        done++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await c.query(`UPDATE research_requests SET status='error', error=$2, completed_at=now() WHERE id=$1`, [r.id, msg.slice(0, 500)]);
        console.log(`  ✗ ${r.kind} "${r.query}": ${msg}`);
        failed++;
      }
    }
    console.log(`Done: ${done} completed, ${failed} failed.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

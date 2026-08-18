#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { credsFromEnv, keywordResearch, rankedKeywords } from "./dataforseo.js";

/**
 * Runs queued research requests against DataForSEO. The deployed app enqueues a
 * row in research_requests (it makes no third-party calls); this worker picks up
 * pending rows, runs the lookup, and writes the result JSON back. The UI polls.
 *
 * Branches on research_requests.kind:
 *   • "ideas" (default / null / legacy "keywords") — keyword ideas for a seed
 *     term via keywordResearch(query).
 *   • "rankings" — what the target domain already ranks for, via
 *     rankedKeywords(target). `target` is a nullable column; if it's null the
 *     request is marked error "no domain".
 *
 *   npm run run-research
 *   npm run run-research -- --dry-run
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

/** Does a column exist? Lets us SELECT `target` defensively before the app migration lands. */
async function columnExists(c: pg.Client, table: string, column: string): Promise<boolean> {
  const { rows } = await c.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

interface RequestRow {
  id: string;
  kind: string | null;
  query: string;
  location_name: string;
  language_name: string;
  target: string | null;
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const hasTarget = await columnExists(c, "research_requests", "target");
    const targetSel = hasTarget ? "target" : "NULL::text AS target";
    const { rows } = await c.query<RequestRow>(
      `SELECT id, kind, query, location_name, language_name, ${targetSel}
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
      const kind = (r.kind || "ideas").trim().toLowerCase();
      if (dryRun) {
        const subject = kind === "rankings" ? `target "${r.target ?? "—"}"` : `"${r.query}"`;
        console.log(`  would run ${kind} ${subject} (${r.location_name})`);
        continue;
      }
      try {
        let result: unknown;
        if (kind === "rankings") {
          const target = (r.target || "").trim();
          if (!target) throw new Error("no domain");
          result = await rankedKeywords(creds, target, r.location_name, r.language_name);
        } else {
          // "ideas" (default / null) and legacy "keywords".
          result = await keywordResearch(creds, r.query, r.location_name, r.language_name);
        }
        await c.query(`UPDATE research_requests SET status='done', result_json=$2, error=NULL, completed_at=now() WHERE id=$1`, [r.id, JSON.stringify(result)]);
        console.log(`  ✓ ${kind} "${kind === "rankings" ? r.target : r.query}" → done`);
        done++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await c.query(`UPDATE research_requests SET status='error', error=$2, completed_at=now() WHERE id=$1`, [r.id, msg.slice(0, 500)]);
        console.log(`  ✗ ${kind} "${kind === "rankings" ? r.target : r.query}": ${msg}`);
        failed++;
      }
    }
    console.log(`Done: ${done} completed, ${failed} failed.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

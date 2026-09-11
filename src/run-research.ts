#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { credsFromEnv, keywordResearch, rankedKeywords, keywordGap, keywordDiscovery, type DiscoveryParams } from "./dataforseo.js";

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
 *   • "gap" — competitor gap: target = client domain, query = competitor.
 *   • "discovery" — the in-client SEO-tab run: params_json holds the seeds,
 *     optional competitor and result limit; target is the client's domain.
 *     Writes the actual DataForSEO charge to cost_usd alongside the result.
 *
 *   npm run run-research
 *   npm run run-research -- --dry-run
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

/** Does a column exist? Lets us SELECT/UPDATE newer columns defensively before the app migration lands. */
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
  params_json: string | null;
}

function parseParams(raw: string | null): DiscoveryParams {
  if (!raw) throw new Error("no research parameters");
  let p: any;
  try { p = JSON.parse(raw); } catch { throw new Error("unreadable research parameters"); }
  const seeds = Array.isArray(p?.seeds) ? p.seeds.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0) : [];
  if (!seeds.length) throw new Error("no seed keywords");
  return {
    seeds,
    competitor: typeof p?.competitor === "string" && p.competitor.trim() ? p.competitor.trim() : null,
    limit: typeof p?.limit === "number" && p.limit > 0 ? p.limit : 200,
  };
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const hasTarget = await columnExists(c, "research_requests", "target");
    const hasParams = await columnExists(c, "research_requests", "params_json");
    const hasCost = await columnExists(c, "research_requests", "cost_usd");
    const targetSel = hasTarget ? "target" : "NULL::text AS target";
    const paramsSel = hasParams ? "params_json" : "NULL::text AS params_json";
    const { rows } = await c.query<RequestRow>(
      `SELECT id, kind, query, location_name, language_name, ${targetSel}, ${paramsSel}
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
        let costUsd: number | null = null;
        if (kind === "rankings") {
          const target = (r.target || "").trim();
          if (!target) throw new Error("no domain");
          result = await rankedKeywords(creds, target, r.location_name, r.language_name);
        } else if (kind === "gap") {
          // Competitor gap: target = client domain, query = competitor domain.
          const client = (r.target || "").trim();
          const competitor = (r.query || "").trim();
          if (!client) throw new Error("no client domain");
          if (!competitor) throw new Error("no competitor domain");
          result = await keywordGap(creds, client, competitor, r.location_name, r.language_name);
        } else if (kind === "discovery") {
          const params = parseParams(r.params_json);
          const client = (r.target || "").trim() || null;
          const out = await keywordDiscovery(creds, params, client, r.location_name, r.language_name);
          for (const w of out.warnings) console.log(`    ⚠ ${w}`);
          result = out.rows;
          costUsd = out.costUsd;
        } else {
          // "ideas" (default / null) and legacy "keywords".
          result = await keywordResearch(creds, r.query, r.location_name, r.language_name);
        }
        if (hasCost) {
          await c.query(
            `UPDATE research_requests SET status='done', result_json=$2, cost_usd=$3, error=NULL, completed_at=now() WHERE id=$1`,
            [r.id, JSON.stringify(result), costUsd],
          );
        } else {
          await c.query(`UPDATE research_requests SET status='done', result_json=$2, error=NULL, completed_at=now() WHERE id=$1`, [r.id, JSON.stringify(result)]);
        }
        const count = Array.isArray(result) ? result.length : 0;
        console.log(`  ✓ ${kind} "${kind === "rankings" ? r.target : r.query}" → done (${count} rows${costUsd != null ? `, $${costUsd.toFixed(4)}` : ""})`);
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

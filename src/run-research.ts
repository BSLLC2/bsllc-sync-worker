#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { credsFromEnv, keywordResearch, rankedKeywords, keywordGap, keywordDiscovery, googleAdsLocationNames, type DiscoveryParams, type DiscoveryGate } from "./dataforseo.js";
import { resolveProviderPlace } from "./research-provider-location.js";
import { isNational, placeLabel, providerLocationName } from "./research-location.js";
import { clientServicesFor, seoTargetsFor } from "./ads/store.js";

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
 *     THE PLACE IS RESOLVED FIRST (src/research-provider-location.ts): a run
 *     with no readable place, or a place the provider's list does not hold, is
 *     stopped with a sentence and costs nothing. Every idea is then judged
 *     against the run's seeds, the client's signed-off services and its tracked
 *     searches (src/ads/idea-relevance.ts), stored with the verdict, and the
 *     counts are printed. Nothing is deleted.
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
  client_id: string | null;
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
  const competitors = Array.isArray(p?.competitors)
    ? p.competitors.filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0).map((x: string) => x.trim())
    : undefined;
  return {
    seeds,
    competitor: typeof p?.competitor === "string" && p.competitor.trim() ? p.competitor.trim() : null,
    ...(competitors && competitors.length > 1 ? { competitors } : {}),
    limit: typeof p?.limit === "number" && p.limit > 0 ? p.limit : 200,
  };
}

/** The provider's list of places, read once per run of this job. */
let catalogueCache: { names: string[] | null } | null = null;

/**
 * What a run's ideas are judged against besides its own seeds: the client's
 * SIGNED-OFF services (null where nobody has signed a list off, which is not
 * the same as none) and its tracked searches (null where the read failed).
 */
/**
 * The words a person said to count this client's ideas by, from the dashboard's
 * own setting (`idea_words:<clientId>`, written by the app and never here). It
 * only widens what the stored flag says; the app judges again on every read.
 * Null where it could not be read, which is not the same as none.
 */
async function declaredWordsFor(c: pg.Client, clientId: string): Promise<string[] | null> {
  try {
    const { rows } = await c.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = $1`, [`idea_words:${clientId}`]);
    if (!rows[0]) return [];
    const parsed: unknown = JSON.parse(rows[0].value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e: { word?: unknown }) => (typeof e?.word === "string" ? e.word : "")).filter((w) => w.length > 0);
  } catch {
    return null;
  }
}

async function gateFor(c: pg.Client, clientId: string | null): Promise<DiscoveryGate> {
  if (!clientId) return { services: null, tracked: null, declaredWords: null };
  const services = await clientServicesFor(c, clientId);
  const tracked = await seoTargetsFor(c, clientId);
  return {
    services: services.services ? services.services.map((x) => x.name) : null,
    tracked: tracked ? tracked.map((t) => t.keyword) : null,
    declaredWords: await declaredWordsFor(c, clientId),
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
    const hasClient = await columnExists(c, "research_requests", "client_id");
    const clientSel = hasClient ? "client_id" : "NULL::text AS client_id";
    const targetSel = hasTarget ? "target" : "NULL::text AS target";
    const paramsSel = hasParams ? "params_json" : "NULL::text AS params_json";
    const { rows } = await c.query<RequestRow>(
      `SELECT id, kind, query, location_name, language_name, ${targetSel}, ${paramsSel}, ${clientSel}
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
        const where = kind === "discovery" ? (providerLocationName(r.location_name) ?? `${r.location_name} (cannot be looked up: this run would stop)`) : r.location_name;
        console.log(`  would run ${kind} ${subject} (${where})`);
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
          // THE PLACE FIRST. A blank is never the whole country, a one-word city
          // is not guessed, and a place the provider's list does not hold stops
          // the run here, before any task is paid for.
          let catalogue: string[] | null = null;
          if (providerLocationName(r.location_name) && !isNational(r.location_name)) {
            catalogueCache ??= { names: await googleAdsLocationNames(creds) };
            catalogue = catalogueCache.names;
          }
          const place = resolveProviderPlace(r.location_name, catalogue);
          if (!place.ok) throw new Error(place.message);
          if (place.note) console.log(`    ⚠ ${place.note}`);
          const gate = await gateFor(c, r.client_id);
          const out = await keywordDiscovery(creds, params, client, place.name, r.language_name, gate);
          console.log(`    searched in ${placeLabel(out.place)} (${out.source === "google_ads_local" ? "Keywords Data, local volumes" : "Labs keyword suggestions, national volumes"})`);
          console.log(`    asked for searches that contain: ${out.asked.join(" | ")}`);
          console.log(`    ${out.judgement.line}`);
          console.log(`    ${out.judgement.basisLine}`);
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

#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { makeReader } from "./serp-pages/read.js";
import {
  chooseSearches, resultsToRead, reusable, SERP_PAGES_PER_SEARCH, SERP_REREAD_DAYS, SERP_SEARCHES_PER_CLIENT,
  type SearchFact,
} from "./serp-pages/select.js";

/**
 * Read the pages that rank above a client for the searches where it matters, and
 * keep facts about them (word count, headings, structured-data types, where the
 * search words appear). Writes the read_* columns of seo_serp_results (schema v256),
 * which the weekly rank pull (src/import-seo.ts) filled with the top results.
 *
 *   npm run read-serp-pages                          (every client)
 *   npm run read-serp-pages -- --client=<id-or-slug>
 *   npm run read-serp-pages -- --dry-run             (choose and print, fetch and write nothing)
 *
 * ONLY OTHER PEOPLE'S PUBLIC PAGES, ONLY A FEW. Per client a week: at most
 * SERP_SEARCHES_PER_CLIENT searches (the ones just off page one and the ones that
 * fell), the first SERP_PAGES_PER_SEARCH results of each that are not the client's
 * own. robots.txt first, one request a second per host, same-site redirects only,
 * a size and time limit, no JavaScript, no cookie. A page read within
 * SERP_REREAD_DAYS is copied, not fetched again. The caps are ours.
 *
 * NEEDS: DATABASE_URL and the dashboard on schema v256 or later.
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

export const UPDATE_SERP_READ = `UPDATE seo_serp_results
   SET read_state = $1, read_at = $2, word_count = $3, h1 = $4, headings_json = $5, schema_types_json = $6, phrase_bits = $7
 WHERE client_id = $8 AND keyword = $9 AND device = $10 AND captured_at = $11 AND position = $12`;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = (arg("client") || "").trim();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var DATABASE_URL.");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const lines: string[] = [];
  let fetched = 0, reused = 0, blocked = 0, failed = 0, searchesRead = 0;
  try {
    const has = (await c.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'seo_serp_results'`)).rowCount === 1;
    if (!has) throw new Error("The table seo_serp_results does not exist yet. Deploy the dashboard app (schema v256), let a weekly rank pull run, then run this again.");
    const clients = (await c.query<{ id: string; name: string; seo_domain: string }>(
      `SELECT id, name, seo_domain FROM clients WHERE seo_domain IS NOT NULL AND btrim(seo_domain) <> '' AND status <> 'churned' ORDER BY name`)).rows;
    const chosenClients = clients.filter((x) => !only || slugify(x.name) === only.toLowerCase() || x.id === only);
    if (only && !chosenClients.length) throw new Error(`No client matches "${only}".`);
    const read = makeReader();

    for (const client of chosenClients) {
      const own = client.seo_domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const history = (await c.query<{ keyword: string; device: string | null; rank: number | null; error: string | null; captured_at: Date }>(
        `SELECT keyword, device, rank, error, captured_at FROM (
           SELECT keyword, device, rank, error, captured_at,
                  row_number() OVER (PARTITION BY lower(trim(keyword)), device ORDER BY captured_at DESC) AS rn
             FROM seo_rank_history WHERE client_id = $1) h
          WHERE rn <= 8 ORDER BY keyword, captured_at ASC`, [client.id])).rows;
      const by = new Map<string, SearchFact>();
      for (const r of history) {
        const dev = r.device ?? "desktop";
        const k = `${r.keyword.trim().toLowerCase()}\u0000${dev}`;
        const f = by.get(k) ?? { keyword: r.keyword, device: dev, points: [] };
        (f.points as Array<{ at: Date; rank: number | null; failed: boolean }>).push({ at: r.captured_at, rank: r.rank, failed: Boolean(r.error) });
        by.set(k, f);
      }
      const { chosen, left } = chooseSearches(Array.from(by.values()));
      let did = 0;
      for (const ch of chosen) {
        const cap = (await c.query<{ captured_at: Date }>(
          `SELECT max(captured_at) AS captured_at FROM seo_serp_results WHERE client_id = $1 AND keyword = $2 AND device = $3`, [client.id, ch.keyword, ch.device])).rows[0]?.captured_at;
        if (!cap) continue;
        const results = (await c.query<{ position: number; url: string; domain: string; read_at: Date | null }>(
          `SELECT position, url, domain, read_at FROM seo_serp_results WHERE client_id = $1 AND keyword = $2 AND device = $3 AND captured_at = $4 ORDER BY position`,
          [client.id, ch.keyword, ch.device, cap])).rows;
        const targets = resultsToRead(results, own);
        searchesRead += 1;
        for (const t of targets) {
          if (results.find((x) => x.position === t.position)?.read_at) continue;
          // A page read lately on another capture is copied, not fetched again.
          const prior = (await c.query<{ read_state: string; read_at: Date; word_count: number | null; h1: string | null; headings_json: string | null; schema_types_json: string | null; phrase_bits: number | null }>(
            `SELECT read_state, read_at, word_count, h1, headings_json, schema_types_json, phrase_bits FROM seo_serp_results
              WHERE client_id = $1 AND url = $2 AND read_at IS NOT NULL ORDER BY read_at DESC LIMIT 1`, [client.id, t.url])).rows[0];
          if (prior && reusable(prior.read_at, new Date(), SERP_REREAD_DAYS)) {
            reused += 1;
            if (!dryRun) await c.query(UPDATE_SERP_READ, [prior.read_state, prior.read_at, prior.word_count, prior.h1, prior.headings_json, prior.schema_types_json, prior.phrase_bits, client.id, ch.keyword, ch.device, cap, t.position]);
            continue;
          }
          if (dryRun) { did += 1; continue; }
          const got = await read(t.url, ch.keyword);
          if (got.state === "read") fetched += 1; else if (got.state === "blocked_robots") blocked += 1; else failed += 1;
          did += 1;
          await c.query(UPDATE_SERP_READ, [
            got.state, got.readAt, got.wordCount, got.h1, got.headings ? JSON.stringify(got.headings) : null,
            got.schemaTypes ? JSON.stringify(got.schemaTypes) : null, got.phraseBits, client.id, ch.keyword, ch.device, cap, t.position,
          ]);
        }
      }
      const line = `${dryRun ? "(dry run) " : ""}${client.name}: ${chosen.length} searches chosen (${chosen.filter((x) => x.reason === "lost").length} lost, ${chosen.filter((x) => x.reason === "push").length} just off page one)${left ? `, ${left} left over the cap of ${SERP_SEARCHES_PER_CLIENT}` : ""}; ${did} pages ${dryRun ? "to read" : "read"}`;
      console.log(line); lines.push(line);
    }
  } finally {
    await c.end();
  }
  const line = `${searchesRead} searches: ${fetched} pages read, ${reused} reused, ${blocked} blocked by robots.txt, ${failed} could not be read (up to ${SERP_PAGES_PER_SEARCH} pages a search)`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

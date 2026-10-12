#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { readSite, summaryLine, type ReadSummary } from "./page-reader/run.js";
import { writePageRow } from "./page-reader/store.js";

/**
 * Read a client's own public pages and keep facts about them.
 *
 *   npm run read-pages                    (every client with a domain)
 *   npm run read-pages -- --client=<slug-or-id>
 *   npm run read-pages -- --dry-run       (fetch and print, write nothing)
 *   npm run read-pages -- --max-pages=40 --delay-ms=1500
 *
 * READ-ONLY toward the client's site and WRITE-ONLY toward one table in our own
 * database (seo_page_facts). It calls no ad platform, no search provider and no
 * third party except the client's own web server, one polite request at a time.
 * Everything it will not do is in src/page-reader/fetcher.ts and robots.ts.
 *
 * The dashboard app never fetches a page. This is the only place in either repo
 * that does, because the worker is the only thing that reads third-party content.
 *
 * WHAT IT NEEDS FROM THE APP'S SCHEMA. The table seo_page_facts (schema v240).
 * Without it this stops with a message that says so: a green run that wrote
 * nothing would read as "the pages were read". The ranking_url column on
 * seo_rank_history is optional here: without it the ranking pages are simply not
 * among the first addresses read.
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

interface ClientRow { id: string; name: string; seo_domain: string }

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return r.rowCount === 1;
}
async function columnExists(c: pg.Client, table: string, column: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column]);
  return r.rowCount === 1;
}

/** Searches the pages are checked against, strongest reason first. */
async function phrasesFor(c: pg.Client, clientId: string): Promise<string[]> {
  const tracked = (await c.query<{ keyword: string }>(
    `SELECT keyword FROM seo_targets WHERE client_id = $1 AND active = true ORDER BY keyword`, [clientId])).rows.map((r) => r.keyword);
  const prompts = (await c.query<{ prompt: string }>(
    `SELECT prompt FROM aeo_prompts WHERE client_id = $1 AND active = true ORDER BY prompt`, [clientId])).rows.map((r) => r.prompt);
  let ideas: string[] = [];
  try {
    const run = (await c.query<{ result_json: string | null }>(
      `SELECT result_json FROM research_requests WHERE client_id = $1 AND kind = 'discovery' AND status = 'done' AND result_json IS NOT NULL
        ORDER BY completed_at DESC NULLS LAST LIMIT 1`, [clientId])).rows[0];
    if (run?.result_json) {
      const parsed: unknown = JSON.parse(run.result_json);
      const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { keywords?: unknown })?.keywords) ? (parsed as { keywords: unknown[] }).keywords : [];
      ideas = (list as Array<{ keyword?: unknown; volume?: unknown }>)
        .filter((k) => typeof k?.keyword === "string")
        .sort((a, b) => (typeof b.volume === "number" ? b.volume : -1) - (typeof a.volume === "number" ? a.volume : -1))
        .slice(0, 100)
        .map((k) => String(k.keyword));
    }
  } catch { /* a run that will not parse costs the ideas and nothing else */ }
  return [...tracked, ...prompts, ...ideas];
}

async function rankingUrlsFor(c: pg.Client, clientId: string, hasColumn: boolean): Promise<string[]> {
  if (!hasColumn) return [];
  const r = await c.query<{ ranking_url: string }>(
    `SELECT ranking_url FROM (
       SELECT DISTINCT ON (lower(trim(keyword))) ranking_url, captured_at
         FROM seo_rank_history
        WHERE client_id = $1 AND ranking_url IS NOT NULL AND error IS NULL
        ORDER BY lower(trim(keyword)), captured_at DESC
     ) latest ORDER BY captured_at DESC LIMIT 200`, [clientId]);
  return Array.from(new Set(r.rows.map((x) => x.ranking_url)));
}

async function enquiryPagesFor(c: pg.Client, clientName: string): Promise<string[]> {
  const r = await c.query<{ page_url: string }>(
    `SELECT page_url FROM web_inquiries
      WHERE client_slug = $1 AND page_url IS NOT NULL AND btrim(page_url) <> '' AND submitted_at > now() - interval '120 days'
      GROUP BY page_url ORDER BY count(*) DESC LIMIT 30`, [slugify(clientName)]);
  return r.rows.map((x) => x.page_url);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = (arg("client") || "").trim();
  const maxPages = Number(arg("max-pages")) > 0 ? Math.min(150, Math.round(Number(arg("max-pages")))) : undefined;
  const delayMs = Number(arg("delay-ms")) >= 0 && arg("delay-ms") !== undefined ? Number(arg("delay-ms")) : undefined;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var DATABASE_URL.");

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const summaries: ReadSummary[] = [];
  try {
    if (!(await tableExists(c, "seo_page_facts"))) {
      throw new Error("The table seo_page_facts does not exist yet. Deploy the dashboard app (schema v240) first, then run this again.");
    }
    const hasRankingUrl = await columnExists(c, "seo_rank_history", "ranking_url");
    const clients = (await c.query<ClientRow>(
      `SELECT id, name, seo_domain FROM clients
        WHERE seo_domain IS NOT NULL AND btrim(seo_domain) <> '' AND status <> 'churned' AND is_internal = false
        ORDER BY name`)).rows;
    const chosen = clients.filter((x) => !only || slugify(x.name) === only || x.id === only);
    if (only && !chosen.length) throw new Error(`No client with a domain matches "${only}".`);

    for (const client of chosen) {
      const [phrases, rankingUrls, enquiryPages] = await Promise.all([
        phrasesFor(c, client.id),
        rankingUrlsFor(c, client.id, hasRankingUrl),
        enquiryPagesFor(c, client.name),
      ]);
      const { rows, summary } = await readSite(
        { site: client.seo_domain, rankingUrls, enquiryPages, phrases, cap: maxPages },
        { delayMs },
      );
      summaries.push(summary);
      console.log(`${dryRun ? "(dry run) " : ""}${summaryLine(summary)}`);
      if (summary.robots === "unreadable") console.log(`  ${client.name}: robots.txt could not be read, so no page was fetched`);
      if (dryRun) {
        for (const r of rows.slice(0, 5)) console.log(`  ${r.state}  ${r.url}${r.error ? `  (${r.error})` : ""}`);
        continue;
      }
      const at = new Date();
      for (const r of rows) await writePageRow(c, client.id, r, at);
      // Rows for addresses that are no longer on the list age out after ninety
      // days rather than being deleted the moment one is missed once.
      await c.query(`DELETE FROM seo_page_facts WHERE client_id = $1 AND fetched_at < now() - interval '90 days'`, [client.id]);
    }
  } finally {
    await c.end();
  }

  const read = summaries.reduce((s, x) => s + x.read, 0);
  const blocked = summaries.reduce((s, x) => s + x.blocked, 0);
  const failed = summaries.reduce((s, x) => s + x.failed, 0);
  const line = `${summaries.length} site${summaries.length === 1 ? "" : "s"}: ${read} pages read, ${blocked} blocked by robots.txt, ${failed} could not be read`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
  // A run that read nothing anywhere is a failure: a green job over an empty table
  // reads as "the pages were read".
  if (summaries.length > 0 && read === 0) {
    console.error("No page could be read on any site.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

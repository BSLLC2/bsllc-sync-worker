#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { realFetch, safeMessage } from "./page-behaviour/http.js";
import { signalRun, slugify, writeSignalRun, ymd } from "./signals/common.js";
import { SECRET_NAMES, bingApiKey, secretValues } from "./signals/secrets.js";
import { readBingClient } from "./bing/run.js";
import { PRUNE_PAGE_DAYS, PRUNE_QUERY_DAYS, PRUNE_SITE_DAYS, writeIssues, writePageDays, writeQueryDays, writeSite, writeSiteDays } from "./bing/store.js";
import { BING_KEEP_DAYS, BING_PAUSE_MS } from "./bing/types.js";

/**
 * Read Bing Webmaster Tools for each client that has a Bing site recorded in Admin,
 * Connectors (source Bing): searches and pages that sent visits from Bing (about six
 * months), crawl counts, index and inbound-link counts and the crawl issues, by exact
 * address. Writes `bing_query_days`, `bing_page_days`, `bing_site_days`,
 * `bing_crawl_issues`, `bing_sites` (schema v257) and a status in `signal_runs`.
 *
 *   npm run read-bing
 *   npm run read-bing -- --client=<id-or-slug>
 *   npm run read-bing -- --dry-run     (proves the key works and lists the site; reads no count)
 *
 * The one secret is BING_WEBMASTER_API_KEY, a key from Bing Webmaster Tools that can
 * read every site in that Bing account. With it missing, a client that has a site
 * recorded is marked "no key" and this EXITS 1, naming the secret. A client with no
 * site recorded is "off" and costs nothing.
 */

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return r.rowCount === 1;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = (arg("client") || "").trim().toLowerCase();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var DATABASE_URL.");
  const now = new Date();
  const secrets = secretValues();
  const apiKey = bingApiKey();

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const lines: string[] = [];
  let attempted = 0, ok = 0, bad = 0, missing = 0, searches = 0;
  try {
    for (const t of ["bing_query_days", "bing_page_days", "bing_site_days", "bing_crawl_issues", "bing_sites", "signal_runs"]) {
      if (!(await tableExists(c, t))) throw new Error(`The table ${t} does not exist yet. Deploy the dashboard app (schema v257) first, then run this again.`);
    }
    const mapped = (await c.query<{ id: string; name: string; external_id: string | null }>(
      `SELECT c.id, c.name, cm.external_id FROM clients c
         LEFT JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source = 'bing' AND cm.enabled = true
        WHERE c.status <> 'churned' AND c.is_internal = false ORDER BY c.name`)).rows;
    const chosen = mapped.filter((m) => !only || slugify(m.name) === only || m.id.toLowerCase() === only);
    if (only && !chosen.length) throw new Error(`No client matches "${only}".`);

    for (const m of chosen) {
      const slug = slugify(m.name);
      const res = await readBingClient({ name: m.name, slug, site: m.external_id }, { fetch: realFetch, apiKey, now, pauseMs: BING_PAUSE_MS, dryRun, secrets });
      if (res.run.status === "off") {
        if (!dryRun) await writeSignalRun(c, m.id, res.run, now);
        continue;
      }
      attempted += 1;
      if (res.run.status === "no_key" || res.run.status === "no_token") missing += 1;
      else if (res.run.status === "error") bad += 1;
      else ok += 1;
      searches += res.queries.length;
      const line = `${dryRun ? "(dry run) " : ""}${m.name}: bing=${res.run.status}; ${res.queries.length} search rows, ${res.pages.length} page rows, ${res.issues.length} crawl issues, ai=${res.ai}`;
      console.log(line); lines.push(line);
      if (res.run.detail) console.log(`  ${res.run.status} - ${res.run.detail}`);
      if (dryRun) continue;
      if (res.siteUrl && res.run.status !== "no_key" && res.run.status !== "error") {
        // Each part is written only when it was read: a part that failed keeps its earlier rows.
        if (!res.failed.includes("Searches")) await writeQueryDays(c, m.id, res.siteUrl, res.queries, now);
        if (!res.failed.includes("Pages")) await writePageDays(c, m.id, res.siteUrl, res.pages, now);
        await writeSiteDays(c, m.id, res.siteUrl, res.siteDays, now);
        if (!res.failed.includes("Crawl issues")) await writeIssues(c, m.id, res.siteUrl, res.issues, now);
        await writeSite(c, m.id, res.siteUrl, res.verified, res.ai, now);
        const cutoff = ymd(new Date(now.getTime() - BING_KEEP_DAYS * 86_400_000));
        for (const sql of [PRUNE_QUERY_DAYS, PRUNE_PAGE_DAYS, PRUNE_SITE_DAYS]) await c.query(sql, [m.id, cutoff]);
      }
      await writeSignalRun(c, m.id, res.run, now);
    }
  } finally {
    await c.end();
  }
  const line = `${attempted} account${attempted === 1 ? "" : "s"} with a Bing site: ${ok} read, ${bad} failed${missing ? `, ${missing} lacking a usable key` : ""}; ${searches} search rows`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
  if (missing > 0) {
    console.error(`${SECRET_NAMES.bing} is missing or not accepted: Bing was not read for ${missing} account${missing === 1 ? "" : "s"}. Add the key, then run it again.`);
    process.exit(1);
  }
  if (attempted > 0 && ok === 0) {
    console.error("No account could be read.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(safeMessage(e, secretValues())); process.exit(1); });

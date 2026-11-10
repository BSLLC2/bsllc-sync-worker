#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { readWpSite, summaryLine, type WpSiteResult } from "./wp-changes/wp.js";
import { ensureSiteChangeTables, storeWpResult } from "./wp-changes/store.js";

/**
 * Read what each client's WordPress site says it published or edited, from the
 * site's PUBLIC REST API. READ-ONLY toward the site (GET only, no login,
 * robots.txt first, one request a second) and WRITE-ONLY toward two tables in
 * our own database (site_change_events, site_change_scans). It stores a path and
 * two dates per change: no title and no content. The reasoning is in
 * src/wp-changes/wp.ts.
 *
 *   npm run read-wp-changes                          (every client with a site address)
 *   npm run read-wp-changes -- --client=<slug-or-id>
 *   npm run read-wp-changes -- --dry-run             (fetch and print, write nothing)
 *
 * A site with no readable WordPress API is recorded as exactly that. It is never
 * recorded as "no edits".
 */
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = (arg("client") || "").trim();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var DATABASE_URL.");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const results: WpSiteResult[] = [];
  try {
    if (!dryRun) await ensureSiteChangeTables(c);
    const clients = (await c.query<{ id: string; name: string; seo_domain: string }>(
      `SELECT id, name, seo_domain FROM clients
        WHERE seo_domain IS NOT NULL AND btrim(seo_domain) <> '' AND status <> 'churned' AND is_internal = false ORDER BY name`)).rows;
    const chosen = clients.filter((x) => !only || slugify(x.name) === only || x.id === only);
    if (only && !chosen.length) throw new Error(`No client with a site address matches "${only}".`);
    for (const client of chosen) {
      const r = await readWpSite(client.seo_domain);
      results.push(r);
      console.log(`${dryRun ? "(dry run) " : ""}${client.name}: ${r.state}, ${r.changes.length} change(s) listed${r.note ? ` (${r.note})` : ""}`);
      if (dryRun) continue;
      await storeWpResult(c, client.id, r);
    }
  } finally {
    await c.end();
  }
  const line = summaryLine(results);
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
  // A site with no API is a real answer. Failing is for the run that reached NO site at all.
  if (results.length > 0 && results.every((r) => r.state === "unreachable" || r.state === "robots_unreadable")) {
    console.error("No site could be reached.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

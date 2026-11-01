#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { safeMessage } from "./page-behaviour/http.js";
import { slugify } from "./signals/common.js";
import { bareSiteHost } from "./page-reader/targets.js";
import { checkSite } from "./webops/site-check.js";
import { checkDomain } from "./webops/rdap.js";
import { readUmbrella, realUmbrellaApi } from "./webops/umbrella.js";
import { missingUmbrellaMessage, umbrellaBase, umbrellaKey, webopsSecretValues } from "./webops/secrets.js";
import { writeReading } from "./webops/store.js";
import { READ_KINDS, type ReadKind, type ReadingOut } from "./webops/types.js";

/**
 * Site care for WebOps clients: a public check of the client's own site (status,
 * speed, certificate expiry, redirects, canonical, four security headers), the
 * domain's expiry through RDAP (public, no key) and, where the site is managed in
 * WP Umbrella, its update, backup and uptime counts. Writes one row per client, kind
 * and subject to `site_care_readings` (the dashboard's site-care table).
 *
 *   npm run read-webops
 *   npm run read-webops -- --client=<id-or-slug> --kind=site|domain|wp|all --dry-run
 *
 * Who is read: clients with the WebOps add-on, plus any client with a typed connector
 * row (source `site_check` = the site address, `domain_watch` = the domain,
 * `wp_umbrella` = the WP Umbrella project id). Churned and internal accounts are not.
 * A dry run prints what it found and writes nothing.
 *
 * SiteGround exposes no API and is NOT read or scraped. Its facts are typed in the app.
 * The one secret is WP_UMBRELLA_API_KEY; without it a client that has a project id is
 * "no key" and this EXITS 1 naming the secret. The site and domain checks need none.
 */
function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Row { id: string; name: string; seo_domain: string | null; web_ops_add_on: boolean; web_ops_site_id: string | null; site_check: string | null; domain_watch: string | null; wp_umbrella: string | null }

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = (arg("client") || "").trim().toLowerCase();
  const kindArg = (arg("kind") || "all").trim().toLowerCase();
  if (kindArg !== "all" && !(READ_KINDS as readonly string[]).includes(kindArg)) throw new Error(`--kind must be site, domain, wp or all (got "${kindArg}").`);
  const kinds: ReadKind[] = kindArg === "all" ? [...READ_KINDS] : [kindArg as ReadKind];
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var DATABASE_URL.");
  const now = new Date();
  const key = umbrellaKey();
  const secrets = webopsSecretValues();
  const api = key ? realUmbrellaApi(umbrellaBase(), key) : null;

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const lines: string[] = [];
  const tally = { read: 0, couldNot: 0, blocked: 0, noKey: 0 };
  try {
    const t = await c.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'site_care_readings'`);
    if (t.rowCount !== 1) throw new Error("The table site_care_readings does not exist yet. Deploy the dashboard app with the site-care table first, then run this again.");
    const rows = (await c.query<Row>(
      `SELECT c.id, c.name, c.seo_domain, c.web_ops_add_on, c.web_ops_site_id,
              max(CASE WHEN cm.source = 'site_check' THEN cm.external_id END) AS site_check,
              max(CASE WHEN cm.source = 'domain_watch' THEN cm.external_id END) AS domain_watch,
              max(CASE WHEN cm.source = 'wp_umbrella' THEN cm.external_id END) AS wp_umbrella
         FROM clients c
         LEFT JOIN connector_mappings cm ON cm.client_id = c.id AND cm.enabled = true AND cm.source IN ('site_check','domain_watch','wp_umbrella')
        WHERE c.status <> 'churned' AND c.is_internal = false
        GROUP BY c.id, c.name, c.seo_domain, c.web_ops_add_on, c.web_ops_site_id
        ORDER BY c.name`)).rows;
    const chosen = rows.filter((r) => (!only || slugify(r.name) === only || r.id.toLowerCase() === only) && (r.web_ops_add_on || r.site_check || r.domain_watch || r.wp_umbrella));
    if (only && !chosen.length) throw new Error(`No WebOps client matches "${only}".`);

    const record = async (clientId: string, name: string, r: ReadingOut, extra = "") => {
      if (r.state === "read") tally.read += 1; else if (r.state === "could_not_check") tally.couldNot += 1; else if (r.state === "blocked_by_robots") tally.blocked += 1; else if (r.state === "no_key") tally.noKey += 1;
      const line = `${dryRun ? "(dry run) " : ""}${name}: ${r.kind} ${r.subject} = ${r.state}${r.detail ? ` (${r.detail})` : ""}${extra}`;
      console.log(line); lines.push(line);
      if (!dryRun && r.state !== "off") await writeReading(c, clientId, r, now);
    };

    for (const m of chosen) {
      const siteInput = m.site_check || (m.web_ops_add_on ? m.seo_domain : null);
      if (kinds.includes("site") && siteInput) { await record(m.id, m.name, await checkSite(siteInput)); await sleep(1000); }
      const domainInput = m.domain_watch || (siteInput ? bareSiteHost(siteInput) : null);
      if (kinds.includes("domain") && domainInput) { await record(m.id, m.name, await checkDomain(domainInput)); await sleep(1000); }
      const projectId = m.wp_umbrella || (m.web_ops_add_on ? m.web_ops_site_id : null);
      if (kinds.includes("wp") && projectId?.trim()) {
        const { reading, found } = await readUmbrella(projectId.trim(), api, secrets);
        await record(m.id, m.name, reading, dryRun ? `; fields found: ${found.join(", ") || "none"}` : "");
      }
    }
  } finally {
    await c.end();
  }
  const line = `site care: ${tally.read} read, ${tally.couldNot} could not be checked, ${tally.blocked} blocked by robots.txt${tally.noKey ? `, ${tally.noKey} lacking a key` : ""}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
  if (tally.noKey > 0) { console.error(missingUmbrellaMessage()); process.exit(1); }
  if (tally.read === 0 && tally.couldNot + tally.blocked > 0) { console.error("Nothing could be read."); process.exit(1); }
}

main().catch((e) => { console.error(safeMessage(e, webopsSecretValues())); process.exit(1); });

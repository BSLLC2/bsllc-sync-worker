#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { runDashboardSync, type SyncEntry } from "./emit.js";
import { credsFromEnv, domainAuthority, type DomainAuthority } from "./dataforseo.js";

/**
 * Weekly domain-authority snapshot via DataForSEO. For each active client with a
 * trackable domain (clients.seo_domain — resolved exactly like import-seo.ts),
 * pulls authority/rank, backlinks and referring domains from the Backlinks API,
 * plus an organic-traffic + keyword-count estimate from Labs, and writes them
 * through the dashboard sync contract under source 'authority'. This replaces the
 * dead SEMrush overview card.
 *
 * Metric keys (exact): authority_score, backlinks, referring_domains,
 * organic_traffic, keyword_count.
 *
 * Dormant-safe: if DataForSEO credentials are absent it logs and exits 0 without
 * writing, so an unconfigured deployment never fails the schedule.
 *
 *   npm run import-domain-authority
 *   npm run import-domain-authority -- --dry-run
 *   npm run import-domain-authority -- --client=some-slug
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

interface ClientRow { id: string; name: string; seo_domain: string | null; seo_location: string | null; }

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var ${name}.`);
  return v.trim();
}

/** Does a column exist? Lets us filter on `active` only when the app schema has it. */
async function columnExists(c: pg.Client, table: string, column: string): Promise<boolean> {
  const { rows } = await c.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const onlyClient = (argv.find((a) => a.startsWith("--client="))?.slice(9) || "").trim();

  // Dormant-safe: no DataForSEO creds → do nothing, succeed.
  if (!process.env.DATAFORSEO_LOGIN?.trim() || !process.env.DATAFORSEO_PASSWORD?.trim()) {
    console.log("DataForSEO credentials not set — skipping domain-authority import (exit 0).");
    return;
  }

  const dashboardDir = req("DASHBOARD_DIR");
  const databaseUrl = req("DATABASE_URL");
  const creds = credsFromEnv();

  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  const syncs: SyncEntry[] = [];
  try {
    // Trackable domain resolved the same way import-seo.ts does. Filter to active
    // clients when the schema carries an `active` flag; otherwise take all with a domain.
    const activeFilter = (await columnExists(c, "clients", "active")) ? "AND active = true" : "";
    const clients = (await c.query<ClientRow>(
      `SELECT id, name, seo_domain, seo_location FROM clients
        WHERE seo_domain IS NOT NULL AND btrim(seo_domain) <> '' ${activeFilter}`,
    )).rows;

    for (const client of clients) {
      const slug = slugify(client.name);
      if (onlyClient && slug !== onlyClient && client.id !== onlyClient) continue;
      const domain = (client.seo_domain || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!domain) continue;
      const location = (client.seo_location || "").trim() || "United States";

      const now = new Date();
      const periodStart = new Date(now.getTime() - 7 * 86_400_000);
      const base = {
        client_id: slug,
        source: "authority" as const,
        period_start: periodStart.toISOString(),
        period_end: now.toISOString(),
      };

      if (dryRun) { console.log(`  would pull authority for ${slug} (${domain}, ${location})`); continue; }

      let auth: DomainAuthority;
      try {
        auth = await domainAuthority(creds, domain, location);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        syncs.push({ ...base, data_state: "error", error_message: msg.slice(0, 300), metrics: {} });
        console.log(`✗ ${slug}: DataForSEO authority pull failed — ${msg.slice(0, 120)}`);
        continue;
      }

      const metrics = {
        authority_score: auth.authorityScore,
        backlinks: auth.backlinks,
        referring_domains: auth.referringDomains,
        organic_traffic: auth.organicTraffic,
        keyword_count: auth.keywordCount,
      };
      const anyValue = Object.values(metrics).some((v) => v != null);
      syncs.push({ ...base, data_state: anyValue ? "live" : "no_data", error_message: null, metrics });
      console.log(
        `✓ ${slug} (${domain}): DA ${auth.authorityScore ?? "—"} · ${auth.backlinks ?? "—"} backlinks · ` +
        `${auth.referringDomains ?? "—"} ref domains · traffic ${auth.organicTraffic ?? "—"} · ${auth.keywordCount ?? "—"} keywords`,
      );
    }
  } finally {
    await c.end();
  }

  if (!syncs.length) { console.log("No active clients with a trackable domain — nothing to sync."); return; }
  const code = runDashboardSync({ dashboardDir, databaseUrl }, syncs, { dryRun });
  process.exit(code);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

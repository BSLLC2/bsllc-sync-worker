#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runDashboardSync, type SyncEntry } from "./emit.js";
import { credsFromEnv, serpRanks, type SerpTask, type SerpResult } from "./dataforseo.js";

/**
 * Weekly SEO rank tracking via DataForSEO's SERP API. Reads each client's
 * keyword list (seo_targets) + tracked domain (clients.seo_domain) straight from
 * Postgres, looks up the domain's organic position for every keyword, and writes
 * aggregate metrics back through the dashboard sync contract (source 'seo').
 *
 * Replaces routine SEMrush position-tracking (which was burning metered API
 * units). National vs local is just the location on each keyword.
 *
 *   npm run import-seo            (live)
 *   npm run import-seo -- --dry-run
 *   npm run import-seo -- --client=some-slug   (limit to one client)
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

interface ClientRow { id: string; name: string; seo_domain: string | null; seo_location: string | null; }
interface TargetRow { id: string; keyword: string; scope: string; location_name: string | null; device: string | null; report_status: string; }

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var ${name}.`);
  return v.trim();
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const onlyClient = (argv.find((a) => a.startsWith("--client="))?.slice(9) || "").trim();
  const dashboardDir = req("DASHBOARD_DIR");
  const databaseUrl = req("DATABASE_URL");
  const creds = credsFromEnv();

  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  const syncs: SyncEntry[] = [];
  try {
    const clients = (await c.query<ClientRow>(
      `SELECT id, name, seo_domain, seo_location FROM clients WHERE seo_domain IS NOT NULL AND btrim(seo_domain) <> ''`,
    )).rows;

    for (const client of clients) {
      const slug = slugify(client.name);
      if (onlyClient && slug !== onlyClient && client.id !== onlyClient) continue;
      const domain = (client.seo_domain || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      // Pull EVERY active target (core + baseline) — baseline keywords (e.g.
      // pre-launch service terms) still get tracked weekly to build history,
      // they just don't count toward the aggregate metrics below until
      // promoted to 'core'.
      const targets = (await c.query<TargetRow>(
        `SELECT id, keyword, scope, location_name, device, report_status FROM seo_targets WHERE client_id = $1 AND active = true`,
        [client.id],
      )).rows;
      if (!targets.length) { console.log(`· ${slug}: no active keywords, skipping`); continue; }

      const defaultLoc = (client.seo_location || "").trim() || "United States";
      const tasks: SerpTask[] = targets.map((t) => ({
        keyword: t.keyword,
        locationName: t.scope === "local" && t.location_name?.trim() ? t.location_name.trim() : defaultLoc,
        device: (t.device === "mobile" ? "mobile" : "desktop"),
      }));

      const results: SerpResult[] = [];
      let hardError: string | null = null;
      for (const batch of chunk(tasks, 100)) {
        try {
          results.push(...(await serpRanks(creds, domain, batch)));
        } catch (e) {
          hardError = e instanceof Error ? e.message : String(e);
          break;
        }
      }

      const now = new Date();
      const periodStart = new Date(now.getTime() - 7 * 86_400_000);
      const base = {
        client_id: slug,
        source: "seo" as const,
        period_start: periodStart.toISOString(),
        period_end: now.toISOString(),
      };

      // Persist the raw per-keyword ranks (append-only) — additive to the
      // aggregate metric_snapshot writes below, never a replacement. serpRanks
      // returns one result per task in order, so results[i] aligns by index with
      // the source target (tasks were built as targets.map, same order).
      if (!dryRun && results.length) {
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (!r) continue;
          const tgt = targets[i];
          await c.query(
            `INSERT INTO seo_rank_history
               (id, seo_target_id, client_id, keyword, rank, ai_overview, device, scope, captured_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [randomUUID(), tgt?.id ?? null, client.id, r.keyword, r.rank, r.aiOverview, tgt?.device ?? null, tgt?.scope ?? null, now],
          );
        }
        console.log(`  persisted ${results.length} keyword ranks for ${slug}`);
      }

      if (hardError && results.length === 0) {
        syncs.push({ ...base, data_state: "error", error_message: hardError.slice(0, 300), metrics: {} });
        console.log(`✗ ${slug}: SERP call failed — ${hardError.slice(0, 120)}`);
        continue;
      }

      // Aggregate metrics (health score / client report headline) only count
      // 'core' targets. 'baseline' keywords (e.g. terms for a service that
      // hasn't launched yet) still got a rank pulled and persisted above —
      // they just don't move the reported numbers until promoted to 'core'.
      // results[i] aligns with targets[i] (same order the tasks were built).
      const coreResults = results.filter((_, i) => targets[i]?.report_status !== "baseline");
      const skippedBaseline = results.length - coreResults.length;

      const tracked = coreResults.length;
      const ranked = coreResults.filter((r) => r.rank != null);
      const okErrors = coreResults.filter((r) => r.error).length;
      if (tracked === 0) { syncs.push({ ...base, data_state: "no_data", error_message: null, metrics: {} }); continue; }

      const avgPos = ranked.length ? ranked.reduce((s, r) => s + (r.rank as number), 0) / ranked.length : null;
      const top3 = ranked.filter((r) => (r.rank as number) <= 3).length;
      const top10 = ranked.filter((r) => (r.rank as number) <= 10).length;
      // Visibility: mean over ALL tracked of max(0,(101-rank))/100 (unranked = 0). 0..1.
      const visibility = coreResults.reduce((s, r) => s + (r.rank != null ? Math.max(0, 101 - (r.rank as number)) / 100 : 0), 0) / tracked;
      const aiOverview = coreResults.filter((r) => r.aiOverview).length;

      syncs.push({
        ...base,
        data_state: "live",
        error_message: okErrors ? `${okErrors}/${tracked} keyword(s) errored` : null,
        metrics: {
          "seo.keywords_tracked": tracked,
          "seo.keywords_ranked": ranked.length,
          "seo.avg_position": avgPos,
          "seo.top3_share": top3 / tracked,
          "seo.top10_share": top10 / tracked,
          "seo.visibility": visibility,
          "seo.ai_overview_share": aiOverview / tracked,
        },
      });
      console.log(
        `✓ ${slug}: ${ranked.length}/${tracked} ranked · avg pos ${avgPos ? avgPos.toFixed(1) : "—"} · top10 ${top10}/${tracked}` +
          (skippedBaseline ? ` (+${skippedBaseline} baseline, tracked but not reported)` : ""),
      );
    }
  } finally {
    await c.end();
  }

  if (!syncs.length) { console.log("No clients with SEO targets — nothing to sync."); return; }
  const code = runDashboardSync({ dashboardDir, databaseUrl }, syncs, { dryRun });
  process.exit(code);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

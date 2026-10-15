#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { realFetch, safeMessage } from "./page-behaviour/http.js";
import { normPath } from "./page-behaviour/paths.js";

import { signalRun, slugify, writeSignalRun, ymd } from "./signals/common.js";
import { googleToken, serviceAccount } from "./signals/google.js";
import { SECRET_NAMES, secretValues } from "./signals/secrets.js";
import { inspectClient, type InspectCtx } from "./url-inspection/run.js";
import type { PageStat } from "./url-inspection/pick.js";
import { COUNT_TODAY, LAST_OK, writeInspection } from "./url-inspection/store.js";
import { INSPECT_DAILY_CAP, INSPECT_PAUSE_MS, INSPECT_SCOPE } from "./url-inspection/types.js";

/**
 * Ask Google, page by page, what it says about a client's pages: indexed or not, the
 * address it chose as the original, when it last visited, whether anything stopped
 * it, usable on a phone. Writes `seo_url_inspection` (schema v257) and a status in
 * `signal_runs`.
 *
 *   npm run read-url-inspection                          (every client)
 *   npm run read-url-inspection -- --client=<id-or-slug>
 *   npm run read-url-inspection -- --dry-run             (prints the plan; makes no inspection)
 *
 * READ-ONLY toward Google, WRITE-ONLY toward those two tables. The dashboard app
 * calls none of this. SECRETS: GOOGLE_SERVICE_ACCOUNT_JSON (existing; the service
 * account must be a full user on each Search Console property) and DATABASE_URL.
 * Without the service account this EXITS 1 and says which secret.
 *
 * THE DAILY SPEND IS OURS TO LIMIT. Google publishes 2,000 inspections a property a
 * day; we stop at INSPECT_DAILY_CAP per property, counting what this job already
 * wrote today, so a second run the same day cannot double the spend.
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

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const lines: string[] = [];
  let noKey = 0, clientsRun = 0, ok = 0, bad = 0, inspected = 0;
  try {
    for (const t of ["seo_url_inspection", "signal_runs"]) {
      if (!(await tableExists(c, t))) throw new Error(`The table ${t} does not exist yet. Deploy the dashboard app (schema v257) first, then run this again.`);
    }
    const clients = (await c.query<{ id: string; name: string; seo_domain: string | null }>(
      `SELECT id, name, seo_domain FROM clients WHERE status <> 'churned' AND is_internal = false ORDER BY name`)).rows;
    const maps = (await c.query<{ client_id: string; external_id: string }>(
      `SELECT client_id, external_id FROM connector_mappings
        WHERE source = 'gsc' AND enabled = true AND external_id IS NOT NULL AND btrim(external_id) <> ''`)).rows;
    const chosen = clients.filter((x) => !only || slugify(x.name) === only || x.id.toLowerCase() === only);
    if (only && !chosen.length) throw new Error(`No client matches "${only}".`);

    let sa: ReturnType<typeof serviceAccount> | null = null;
    let saError: string | null = null;
    try { sa = serviceAccount(); } catch (e) { saError = safeMessage(e, secrets); }

    for (const client of chosen) {
      const property = maps.find((m) => m.client_id === client.id)?.external_id?.trim() ?? null;
      if (!property) {
        if (!dryRun) await writeSignalRun(c, client.id, signalRun("gsc_inspect", "off", "No Search Console property is connected for this account."), now);
        continue;
      }
      if (!sa) {
        noKey += 1;
        lines.push(`${client.name}: ${saError}`);
        if (!dryRun) await writeSignalRun(c, client.id, signalRun("gsc_inspect", "no_key", saError), now);
        continue;
      }
      const rows = (await c.query<{ page_path: string; period: string; clicks: number | null; impressions: number | null }>(
        `SELECT page_path, period, clicks, impressions FROM seo_page_behaviour WHERE client_id = $1 AND source = 'gsc' AND device = 'all'`, [client.id])).rows;
      const by = new Map<string, PageStat>();
      for (const r of rows) {
        const path = normPath(r.page_path);
        const s = by.get(path) ?? { path, clicksNow: null, clicksPrior: null, impressionsNow: null, impressionsPrior: null };
        if (r.period === "current") { s.clicksNow = r.clicks; s.impressionsNow = r.impressions; }
        else if (r.period === "prior") { s.clicksPrior = r.clicks; s.impressionsPrior = r.impressions; }
        by.set(path, s);
      }
      const facts = (await c.query<{ url: string; final_url: string | null }>(
        `SELECT url, final_url FROM seo_page_facts WHERE client_id = $1 AND state = 'ok' ORDER BY fetched_at DESC`, [client.id]).catch(() => ({ rows: [] as Array<{ url: string; final_url: string | null }> }))).rows;
      const known = new Map<string, string>();
      for (const f of facts) { const real = f.final_url || f.url; const p = normPath(real); if (!known.has(p)) known.set(p, real); }
      const lastOk = new Map<string, Date>();
      for (const r of (await c.query<{ page_path: string; at: Date }>(LAST_OK, [client.id])).rows) lastOk.set(r.page_path, new Date(r.at));
      const dayStart = new Date(`${ymd(now)}T00:00:00.000Z`);
      const usedToday = (await c.query<{ n: number }>(COUNT_TODAY, [client.id, property, dayStart])).rows[0]?.n ?? 0;
      const ctx: InspectCtx = { id: client.id, name: client.name, property, domain: (client.seo_domain ?? "").trim() || null, observedUrls: facts.map((f) => f.final_url || f.url), knownUrls: known, stats: Array.from(by.values()), lastOk, usedToday };
      const res = await inspectClient(ctx, { fetch: realFetch, token: () => googleToken(INSPECT_SCOPE, sa!), now, pauseMs: INSPECT_PAUSE_MS, dryRun, secrets });
      clientsRun += 1;
      inspected += res.rows.filter((r) => r.state === "ok").length;
      if (res.run.status === "error") bad += 1; else ok += 1;
      const line = `${dryRun ? "(dry run) " : ""}${client.name}: gsc_inspect=${res.run.status}; ${dryRun ? `${res.plan.length} planned` : `${res.rows.length} rows`}; ${ctx.usedToday} used today of our ${INSPECT_DAILY_CAP}`;
      console.log(line); lines.push(line);
      if (res.run.detail) console.log(`  ${res.run.status} - ${res.run.detail}`);
      if (dryRun) for (const p of res.plan) console.log(`  would inspect ${p.url} (${p.pickedFor})`);
      if (dryRun) continue;
      for (const r of res.rows) await writeInspection(c, client.id, r);
      await writeSignalRun(c, client.id, res.run, now);
    }
  } finally {
    await c.end();
  }
  const line = `${clientsRun} account${clientsRun === 1 ? "" : "s"}: ${inspected} pages inspected, ${bad} failed${noKey ? `, ${noKey} skipped for want of ${SECRET_NAMES.serviceAccount}` : ""}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
  if (noKey > 0) {
    console.error(`${SECRET_NAMES.serviceAccount} is not usable: URL inspection did not run for ${noKey} account${noKey === 1 ? "" : "s"}. Check the repository secret, then run it again.`);
    process.exit(1);
  }
  if (clientsRun > 0 && ok === 0) {
    console.error("No account could be inspected.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(safeMessage(e, secretValues())); process.exit(1); });

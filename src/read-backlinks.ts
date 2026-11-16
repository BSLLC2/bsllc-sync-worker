#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { safeMessage } from "./page-behaviour/http.js";
import { slugify, ymd } from "./signals/common.js";
import { budgetUsd } from "./backlinks/cost.js";
import { competitorsKey, normaliseDomain, parseCompetitors } from "./backlinks/competitors.js";
import { realCall } from "./backlinks/real.js";
import { planClient, processBacklinks, type ClientInput } from "./backlinks/run.js";
import { writeRun } from "./backlinks/store.js";

/**
 * Read the backlinks of each client's site and of up to three competitors a person named, from DataForSEO. Writes
 * `seo_backlink_summaries`, `seo_backlink_domains` and `seo_backlink_runs` (schema v304, provisional). Counts and the
 * names of other websites only.
 *
 *   npm run read-backlinks -- --dry-run          (prices the plan, reads and writes nothing)
 *   npm run read-backlinks -- --client=<id-or-slug>
 *
 * THE BUDGET. BACKLINKS_RUN_BUDGET_CENTS (default 150) is the most one run may spend. The plan is priced first; a plan
 * over the budget is refused and nothing is read. DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are the keys the research
 * runner already uses. With them missing, a client that has a plan is marked "no key" and this EXITS 1 naming them.
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
  const login = (process.env.DATAFORSEO_LOGIN || "").trim();
  const password = (process.env.DATAFORSEO_PASSWORD || "").trim();
  const hasKey = Boolean(login && password);
  const budget = budgetUsd(process.env.BACKLINKS_RUN_BUDGET_CENTS);
  const now = new Date();
  const today = ymd(now);

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  let code = 0;
  try {
    for (const t of ["seo_backlink_summaries", "seo_backlink_domains", "seo_backlink_runs"]) {
      if (!(await tableExists(c, t))) throw new Error(`The table ${t} does not exist yet. Deploy the dashboard app (schema v304) first, then run this again.`);
    }
    const rows = (await c.query<{ id: string; name: string; seo_domain: string | null; module_seo: boolean }>(
      `SELECT id, name, seo_domain, module_seo FROM clients WHERE status <> 'churned' AND is_internal = false ORDER BY name`)).rows;
    const chosen = rows.filter((r) => !only || slugify(r.name) === only || r.id.toLowerCase() === only);
    if (only && !chosen.length) throw new Error(`No client matches "${only}".`);
    const settings = new Map<string, string>();
    for (const r of (await c.query<{ key: string; value: string }>(`SELECT key, value FROM app_settings WHERE key LIKE 'backlink_competitors:%'`)).rows) settings.set(r.key, r.value);
    const clients: ClientInput[] = chosen.map((r) => ({
      id: r.id, name: r.name, site: r.seo_domain, moduleSeo: r.module_seo,
      competitors: parseCompetitors(settings.get(competitorsKey(r.id)), normaliseDomain(r.seo_domain ?? "")),
    }));
    const secrets = [password, login].filter((s) => s.length > 4);
    const res = await processBacklinks({
      clients, today, budgetUsd: budget.usd, dryRun, db: dryRun ? null : c,
      call: !dryRun && hasKey ? realCall({ login, password }) : null, secrets,
    });
    for (const l of res.lines) console.log(l);
    console.log(`Budget ${budget.fromEnv ? "from BACKLINKS_RUN_BUDGET_CENTS" : "default (set BACKLINKS_RUN_BUDGET_CENTS to change it)"}.`);
    if (res.summary && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${res.summary}\n`);
    if (res.refused) code = 3;
    else if (!dryRun && !hasKey && clients.some((x) => planClient(x).domains.length > 0)) {
      for (const x of clients) if (planClient(x).domains.length > 0) await writeRun(c, x.id, { status: "no_key", detail: "DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are not set on the worker, so nothing was read.", reads: [], estimatedUsd: 0, spentUsd: 0 }, now);
      console.error("DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are missing: backlinks were not read. Add them, then run this again.");
      code = 1;
    } else if (!dryRun && res.attempted > 0 && res.answered === 0) {
      console.error("No account could be read.");
      code = 1;
    }
    if (res.casualties.length) for (const m of res.casualties) console.error(`  ${m}`);
  } finally {
    await c.end();
  }
  if (code) process.exit(code);
}

main().catch((e) => { console.error(safeMessage(e, [process.env.DATAFORSEO_PASSWORD])); process.exit(1); });

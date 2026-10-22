#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import type { Deps } from "./ga4-report/run.js";
import { processClients, type PipelineResult } from "./ga4-report/pipeline.js";
import { DEFAULT_MONTHS, MAX_MONTHS } from "./ga4-report/types.js";
import { realFetch, safeMessage } from "./page-behaviour/http.js";
import { ymd } from "./page-behaviour/paths.js";
import { googleToken } from "./signals/google.js";
import { withVerifyFull } from "./db-url.js";

/**
 * Read each client's Website performance report from Google Analytics 4: daily
 * totals, visitors by region, traffic sources, landing pages, form submissions and
 * named page groups. Writes counts to three tables the dashboard declares
 * (ga4_site_days, ga4_report_rows, ga4_report_runs) and a status for every client.
 *
 *   npm run read-ga4-report                          (every client)
 *   npm run read-ga4-report -- --client=<id-or-slug>
 *   npm run read-ga4-report -- --months=12           (default 24, at most 36)
 *   npm run read-ga4-report -- --dry-run             (read and print counts, write nothing)
 *
 * READ-ONLY toward Google. WRITE-ONLY toward those three tables (plus the heartbeat
 * row the workflow stamps). The dashboard app calls no Google API.
 *
 * SECRETS: DATABASE_URL and GOOGLE_SERVICE_ACCOUNT_JSON, both existing. The service
 * account must already be a user on each property.
 *
 * SETTINGS: each client's `web_report_config:<clientId>` row in app_settings (countries
 * to leave out, page groups, the form event) is read, sanitised and applied to EVERY
 * request; what was applied is stored on the run row.
 *
 * ONE CLIENT'S FAILURE NEVER STOPS THE OTHERS. Casualties are listed last, and the
 * script exits 1 only when no client with a property could be read at all.
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return r.rowCount === 1;
}

function serviceAccount(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON.");
  let json: { client_email?: string; private_key?: string };
  try { json = JSON.parse(raw); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON."); }
  if (!json.client_email || !json.private_key) throw new Error("Service-account JSON missing client_email / private_key.");
  return json as { client_email: string; private_key: string };
}

const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const propertyId = (raw: string) => raw.trim().replace(/^properties\//i, "").trim();
interface ClientRow { id: string; name: string }

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = (arg("client") || "").trim();
  const months = Math.max(1, Math.min(MAX_MONTHS, Number(arg("months")) || DEFAULT_MONTHS));
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var DATABASE_URL.");
  const today = ymd(new Date());

  const c = new pg.Client({ connectionString: withVerifyFull(url) });
  await c.connect();
  let pipe!: PipelineResult;
  try {
    if (!dryRun) {
      for (const t of ["ga4_site_days", "ga4_report_rows", "ga4_report_runs"]) {
        if (!(await tableExists(c, t))) throw new Error(`The table ${t} does not exist yet. Deploy the dashboard app first, then run this again.`);
      }
    }
    const clients = (await c.query<ClientRow>(`SELECT id, name FROM clients WHERE status <> 'churned' AND is_internal = false ORDER BY name`)).rows;
    const maps = (await c.query<{ client_id: string; external_id: string }>(
      `SELECT client_id, external_id FROM connector_mappings
        WHERE source = 'ga4' AND enabled = true AND external_id IS NOT NULL AND btrim(external_id) <> ''`)).rows;
    const settings = (await c.query<{ key: string; value: string }>(`SELECT key, value FROM app_settings WHERE key LIKE 'web_report_config:%'`)).rows;
    const settingBy = new Map(settings.map((s) => [s.key, s.value]));
    const chosen = clients.filter((x) => !only || slugify(x.name) === only.toLowerCase() || x.id === only);
    if (only && !chosen.length) throw new Error(`No client matches "${only}".`);

    const deps: Deps = {
      fetch: realFetch,
      token: async () => googleToken(ANALYTICS_SCOPE, serviceAccount()),
      today, months,
    };
    const inputs = chosen.map((client) => {
      const prop = maps.find((m) => m.client_id === client.id)?.external_id ?? null;
      return { id: client.id, name: client.name, property: prop ? propertyId(prop) : null };
    });
    pipe = await processClients({ clients: inputs, settings: settingBy, deps, db: c, dryRun });
    for (const l of pipe.lines) console.log(l);
  } finally {
    await c.end();
  }

  console.log(pipe.summary);
  if (pipe.casualties.length) { console.log("Casualties:"); for (const x of pipe.casualties) console.log(`  ${x}`); }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${pipe.summary}\n`);
  if (pipe.allFailed) {
    console.error("No client could be read.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(safeMessage(e)); process.exit(1); });

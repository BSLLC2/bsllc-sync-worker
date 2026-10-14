#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import { JWT } from "google-auth-library";
import pg from "pg";
import { readClientBehaviour, type ClientCtx, type ClientResult } from "./page-behaviour/run.js";
import { realFetch, safeMessage } from "./page-behaviour/http.js";
import { writeBehaviour, writeEvents, writeRun, writeVitals } from "./page-behaviour/store.js";
import { ymd } from "./page-behaviour/paths.js";

/**
 * Read how visitors use each client's pages: analytics by page and device, Search
 * Console by page, Chrome's field data, an optional lab test and the site's own
 * events. Writes counts to five tables the dashboard declares (schema v252) and a
 * status for every source.
 *
 *   npm run read-page-behaviour                          (every client)
 *   npm run read-page-behaviour -- --client=<id-or-slug>
 *   npm run read-page-behaviour -- --dry-run             (read and print, write nothing)
 *
 * READ-ONLY toward every source. WRITE-ONLY toward those tables. The dashboard app
 * calls none of these APIs.
 *
 * SECRETS. GOOGLE_SERVICE_ACCOUNT_JSON (the same service account the analytics and
 * Search Console importers use; it must already be a user on each property) and
 * DATABASE_URL, both existing. CRUX_API_KEY is the one new secret: a Google Cloud API
 * key with the Chrome UX Report API and the PageSpeed Insights API enabled. Without
 * it field data and the lab test are written as `no_key` for every client that has a
 * website and this script EXITS 1, so the morning is red and says why, not green over
 * a reading that never ran.
 *
 * WHAT IT NEEDS FROM THE APP'S SCHEMA: the five tables of schema v252. Without them
 * it stops with a message that says so.
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

const SCOPES = { analytics: "https://www.googleapis.com/auth/analytics.readonly", webmasters: "https://www.googleapis.com/auth/webmasters.readonly" } as const;
const tokenCache = new Map<string, string>();
async function mintToken(scope: keyof typeof SCOPES): Promise<string> {
  const hit = tokenCache.get(scope);
  if (hit) return hit;
  const sa = serviceAccount();
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SCOPES[scope]] });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error(`Could not mint a ${scope} access token from the service account.`);
  tokenCache.set(scope, token);
  return token;
}

const propertyId = (raw: string) => raw.trim().replace(/^properties\//i, "").trim();

interface ClientRow { id: string; name: string; seo_domain: string | null }

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = (arg("client") || "").trim();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var DATABASE_URL.");
  const googleKey = process.env.CRUX_API_KEY?.trim() || undefined;
  const today = ymd(new Date());

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const lines: string[] = [];
  let needsKey = 0, clientsRun = 0, sourcesOk = 0, sourcesError = 0;
  try {
    for (const t of ["seo_page_behaviour", "seo_page_events", "seo_page_vitals", "seo_ux_runs"]) {
      if (!(await tableExists(c, t))) throw new Error(`The table ${t} does not exist yet. Deploy the dashboard app (schema v252) first, then run this again.`);
    }
    const clients = (await c.query<ClientRow>(
      `SELECT id, name, seo_domain FROM clients WHERE status <> 'churned' AND is_internal = false ORDER BY name`)).rows;
    const maps = (await c.query<{ client_id: string; source: string; external_id: string }>(
      `SELECT client_id, source, external_id FROM connector_mappings
        WHERE source IN ('ga4', 'gsc') AND enabled = true AND external_id IS NOT NULL AND btrim(external_id) <> ''`)).rows;
    const chosen = clients.filter((x) => !only || slugify(x.name) === only.toLowerCase() || x.id === only);
    if (only && !chosen.length) throw new Error(`No client matches "${only}".`);

    for (const client of chosen) {
      const ga4 = maps.find((m) => m.client_id === client.id && m.source === "ga4")?.external_id ?? null;
      const gsc = maps.find((m) => m.client_id === client.id && m.source === "gsc")?.external_id ?? null;
      const domain = (client.seo_domain ?? "").trim() || null;
      if (!ga4 && !gsc && !domain) continue;
      const observed = (await c.query<{ final_url: string | null; url: string }>(
        `SELECT final_url, url FROM seo_page_facts WHERE client_id = $1 AND state = 'ok' ORDER BY fetched_at DESC LIMIT 3`, [client.id]).catch(() => ({ rows: [] }))).rows
        .map((r) => r.final_url || r.url).filter(Boolean);
      const ctx: ClientCtx = { id: client.id, name: client.name, domain, ga4Property: ga4 ? propertyId(ga4) : null, gscProperty: gsc ? gsc.trim() : null, observedUrls: observed };
      let result: ClientResult;
      try {
        result = await readClientBehaviour(ctx, { fetch: realFetch, token: mintToken, googleKey, today, pauseMs: 450 });
      } catch (e) {
        lines.push(`${client.name}: could not be read (${safeMessage(e, [googleKey])})`);
        sourcesError += 1;
        continue;
      }
      clientsRun += 1;
      if (result.needsKey) needsKey += 1;
      const summary = result.runs.map((r) => `${r.source}=${r.status}`).join(" ");
      sourcesOk += result.runs.filter((r) => r.status === "ok" || r.status === "capped" || r.status === "no_data").length;
      sourcesError += result.runs.filter((r) => r.status === "error").length;
      const line = `${dryRun ? "(dry run) " : ""}${client.name}: ${summary}; ${result.behaviour.length} page rows, ${result.events.length} event rows, ${result.vitals.length} timing rows`;
      console.log(line); lines.push(line);
      for (const r of result.runs) if (r.detail && r.status !== "ok") console.log(`  ${r.source}: ${r.status} - ${r.detail}`);
      if (dryRun) continue;
      const at = new Date();
      // A source that failed keeps its last good rows; only a source that answered is rewritten.
      const answered = new Set(result.runs.filter((r) => r.status === "ok" || r.status === "capped" || r.status === "no_data").map((r) => r.source));
      if (answered.has("ga4_pages") || answered.has("gsc_pages")) await writeBehaviour(c, client.id, result.behaviour, at);
      if (answered.has("events")) await writeEvents(c, client.id, result.events, at);
      if (answered.has("crux") || answered.has("psi")) await writeVitals(c, client.id, result.vitals, at);
      for (const r of result.runs) await writeRun(c, client.id, r, at);
    }
  } finally {
    await c.end();
  }

  const line = `${clientsRun} account${clientsRun === 1 ? "" : "s"}: ${sourcesOk} sources answered, ${sourcesError} failed${needsKey ? `, ${needsKey} skipped for want of the Google key` : ""}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
  // LOUD, per the brief: a missing key is a red run that says which secret.
  if (needsKey > 0) {
    console.error(`CRUX_API_KEY is not set: Chrome field data and the lab test were not read for ${needsKey} account${needsKey === 1 ? "" : "s"}. Add the secret to this repository, then run it again.`);
    process.exit(1);
  }
  if (clientsRun > 0 && sourcesOk === 0) {
    console.error("No source could be read for any account.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(safeMessage(e)); process.exit(1); });

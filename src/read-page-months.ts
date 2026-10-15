#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { JWT } from "google-auth-library";
import pg from "pg";
import { realFetch, safeMessage } from "./page-behaviour/http.js";
import { ymd } from "./page-behaviour/paths.js";
import {
  completeMonths, DEFAULT_MONTHS, DELETE_PAGE_MONTH, INSERT_PAGE_MONTH, MAX_MONTHS, readGa4Month, readGscMonth,
  type MonthRead,
} from "./page-behaviour/months.js";

/**
 * Each page's Search Console clicks, impressions and average position, and its
 * unpaid-search sessions from analytics, for every COMPLETE calendar month. Writes
 * seo_page_months (schema v256) so the dashboard can say which pages lost visits
 * between two whole months, which the overwritten 28-day windows cannot.
 *
 *   npm run read-page-months                          (every client, last 3 months)
 *   npm run read-page-months -- --client=<id-or-slug>
 *   npm run read-page-months -- --months=14           (a backfill: Search Console keeps about 16)
 *   npm run read-page-months -- --dry-run             (read and print, write nothing)
 *
 * READ-ONLY toward both sources, WRITE-ONLY toward seo_page_months. Re-running is
 * free: a month is replaced as a whole inside one transaction, and only after the
 * source answered. A source that fails keeps the rows it already had.
 *
 * SECRETS: GOOGLE_SERVICE_ACCOUNT_JSON and DATABASE_URL, both already in use by the
 * other Google jobs. No new secret.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function writeMonth(c: pg.Client, clientId: string, read: MonthRead, at: Date): Promise<void> {
  await c.query("BEGIN");
  try {
    await c.query(DELETE_PAGE_MONTH, [clientId, read.source, read.month]);
    for (const r of read.rows) {
      await c.query(INSERT_PAGE_MONTH, [randomUUID(), clientId, read.source, r.path, read.month, r.coveredTo, r.clicks, r.impressions, r.position, r.sessions, at]);
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = (arg("client") || "").trim();
  const months = Math.max(1, Math.min(MAX_MONTHS, Number(arg("months") || DEFAULT_MONTHS) || DEFAULT_MONTHS));
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var DATABASE_URL.");
  const today = ymd(new Date());
  const spans = completeMonths(today, months);

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const lines: string[] = [];
  let sourcesOk = 0, sourcesFailed = 0, monthsWritten = 0, clientsRun = 0, cutMonths = 0;
  try {
    if (!(await tableExists(c, "seo_page_months"))) {
      throw new Error("The table seo_page_months does not exist yet. Deploy the dashboard app (schema v256) first, then run this again.");
    }
    const clients = (await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE status <> 'churned' AND is_internal = false ORDER BY name`)).rows;
    const maps = (await c.query<{ client_id: string; source: string; external_id: string }>(
      `SELECT client_id, source, external_id FROM connector_mappings
        WHERE source IN ('ga4', 'gsc') AND enabled = true AND external_id IS NOT NULL AND btrim(external_id) <> ''`)).rows;
    const chosen = clients.filter((x) => !only || slugify(x.name) === only.toLowerCase() || x.id === only);
    if (only && !chosen.length) throw new Error(`No client matches "${only}".`);

    for (const client of chosen) {
      const ga4 = maps.find((m) => m.client_id === client.id && m.source === "ga4")?.external_id ?? null;
      const gsc = maps.find((m) => m.client_id === client.id && m.source === "gsc")?.external_id ?? null;
      if (!ga4 && !gsc) continue;
      clientsRun += 1;
      const done: string[] = [];
      for (const span of spans) {
        for (const src of ["gsc", "ga4"] as const) {
          const prop = src === "gsc" ? gsc : ga4;
          if (!prop) continue;
          try {
            const token = await mintToken(src === "gsc" ? "webmasters" : "analytics");
            const read = src === "gsc"
              ? await readGscMonth(realFetch, token, prop.trim(), span)
              : await readGa4Month(realFetch, token, propertyId(prop), span);
            if (read.cut > 0 || read.apiFull) cutMonths += 1;
            if (!dryRun) await writeMonth(c, client.id, read, new Date());
            sourcesOk += 1; monthsWritten += 1;
            done.push(`${src} ${span.month}: ${read.rows.length} pages${read.cut ? ` (${read.cut} more cut at the cap)` : ""}${read.apiFull ? " (the source's row limit was reached)" : ""}`);
          } catch (e) {
            sourcesFailed += 1;
            done.push(`${src} ${span.month}: could not be read (${safeMessage(e)})`);
          }
          await sleep(300);
        }
      }
      const line = `${dryRun ? "(dry run) " : ""}${client.name}: ${done.join("; ")}`;
      console.log(line); lines.push(line);
    }
  } finally {
    await c.end();
  }

  const line = `${clientsRun} account${clientsRun === 1 ? "" : "s"}: ${sourcesOk} month${sourcesOk === 1 ? "" : "s"} read, ${sourcesFailed} failed${cutMonths ? `, ${cutMonths} cut at a row limit` : ""}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
  if (clientsRun > 0 && sourcesOk === 0) {
    console.error("No month could be read for any account.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(safeMessage(e)); process.exit(1); });

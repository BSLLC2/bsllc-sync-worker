#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { realFetch } from "./page-behaviour/http.js";
import { ymd } from "./page-behaviour/paths.js";
import { derivedBrandPatterns } from "./ads/store.js";
import { slugify } from "./signals/common.js";
import { googleToken, serviceAccount } from "./signals/google.js";
import { derivedTermList, parseTypedTerms, prepareTerms, type PreparedTerms } from "./query-months/brand.js";
import { completeMonths, ensureQueryMonthsTable, MAX_MONTHS, QUERY_MONTHS_DEFAULT, writeClientMonths, type MonthRowOut, type TermsSource } from "./query-months/months.js";
import { describeFailure, isAccessFailure, readQueryMonth } from "./query-months/read.js";

/**
 * How much of each client's Search Console traffic is branded, month by month.
 * Writes seo_query_months: counts only, one row per client per COMPLETE month.
 *
 *   npm run read-query-months                          (every client with Search Console, last 16 months)
 *   npm run read-query-months -- --client=<id-or-slug>
 *   npm run read-query-months -- --months=3            (1 to 16)
 *   npm run read-query-months -- --dry-run             (read and print counts, write nothing)
 *
 * READ-ONLY toward Search Console, WRITE-ONLY toward seo_query_months. NO SEARCH IS
 * STORED, LOGGED OR PRINTED: a search is read to be tagged and then dropped, and every
 * line below is a count. Re-running is free (a month is replaced as a whole).
 *
 * BRAND TERMS: a person's list (app_settings `brand_terms:<clientId>`) if one is typed
 * with a name and a date, otherwise the client's name, aliases and domain label.
 *
 * SECRETS: GOOGLE_SERVICE_ACCOUNT_JSON and DATABASE_URL, both already in use. No new secret.
 */

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAUSE_MS = Number.isFinite(Number(process.env.QUERY_MONTHS_PAUSE_MS)) && process.env.QUERY_MONTHS_PAUSE_MS !== undefined ? Number(process.env.QUERY_MONTHS_PAUSE_MS) : 300;

interface Resolved { prepared: PreparedTerms; source: TermsSource }

async function resolveTerms(c: pg.Client, client: { id: string; name: string; aliases: string | null; seo_domain: string | null }): Promise<Resolved> {
  const typed = (await c.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = $1`, [`brand_terms:${client.id}`])).rows[0];
  const t = parseTypedTerms(typed?.value ?? null);
  if (t) return { prepared: prepareTerms(t.terms), source: "typed" };
  return { prepared: prepareTerms(derivedTermList(derivedBrandPatterns({ name: client.name, aliases: client.aliases, seo_domain: client.seo_domain }))), source: "derived" };
}

const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = (arg("client") || "").trim();
  const months = Math.max(1, Math.min(MAX_MONTHS, Number(arg("months") || QUERY_MONTHS_DEFAULT) || QUERY_MONTHS_DEFAULT));
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var DATABASE_URL.");
  const today = ymd(new Date());
  const spans = completeMonths(today, months);

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  let clientsRun = 0, monthsOk = 0, monthsFailed = 0, monthsEmpty = 0, cappedMonths = 0, written = 0, clientsFailed = 0;
  try {
    if (!dryRun) await ensureQueryMonthsTable(c);
    const clients = (await c.query<{ id: string; name: string; aliases: string | null; seo_domain: string | null }>(
      `SELECT id, name, aliases, seo_domain FROM clients WHERE status <> 'churned' AND is_internal = false ORDER BY name`)).rows;
    const maps = (await c.query<{ client_id: string; external_id: string }>(
      `SELECT client_id, external_id FROM connector_mappings
        WHERE source = 'gsc' AND enabled = true AND external_id IS NOT NULL AND btrim(external_id) <> ''`)).rows;
    const chosen = clients.filter((x) => !only || slugify(x.name) === only.toLowerCase() || x.id === only);
    if (only && !chosen.length) throw new Error(`No client matches "${only}".`);

    let token: string | null = null;
    for (const client of chosen) {
      const property = maps.find((m) => m.client_id === client.id)?.external_id?.trim();
      if (!property) continue;
      clientsRun += 1;
      const label = `${dryRun ? "(dry run) " : ""}${client.name}`;
      let terms: Resolved;
      try {
        terms = await resolveTerms(c, client);
      } catch (e) {
        clientsFailed += 1; monthsFailed += spans.length;
        console.log(`${label}: brand terms could not be read (${describeFailure(e)})`);
        continue;
      }
      const p = terms.prepared;
      const head = `${terms.source} terms: ${p.terms.length} used${p.refused ? `, ${p.refused} refused as too short` : ""}${p.skipped ? `, ${p.skipped} skipped as everyday ${p.skipped === 1 ? "word" : "words"}` : ""}`;
      if (!token) {
        if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON.");
        token = await googleToken(SCOPE, serviceAccount());
      }
      const rows: MonthRowOut[] = [];
      const notes: string[] = [];
      for (const span of spans) {
        try {
          const res = await readQueryMonth({ f: realFetch, token, property, terms: p.terms, fingerprint: p.fingerprint, source: terms.source }, span);
          if (res.kind === "no_data") { monthsEmpty += 1; notes.push(`${span.month}: no data`); }
          else {
            const r = res.row;
            rows.push(r); monthsOk += 1;
            if (r.rowsCapped) cappedMonths += 1;
            const split = r.brandedClicks === null ? "no brand terms" : `branded ${r.brandedClicks}, other ${r.otherClicks}`;
            notes.push(`${span.month}: ${r.totalClicks} clicks (${split}${r.hiddenClicks === null ? "" : `, hidden ${r.hiddenClicks}`}), ${r.rowsRead} searches read${r.rowsCapped ? " (cut at the row ceiling, so the split is a floor)" : ""}`);
          }
        } catch (e) {
          monthsFailed += 1;
          notes.push(`${span.month}: could not be read (${describeFailure(e)})`);
          if (isAccessFailure(e)) { notes.push("stopped for this property"); break; }
        }
        await sleep(PAUSE_MS);
      }
      if (rows.length && !dryRun) {
        try { await writeClientMonths(c, client.id, rows, new Date()); written += rows.length; }
        catch (e) { clientsFailed += 1; notes.push(`not written (${describeFailure(e)})`); }
      }
      console.log(`${label}: ${head}; ${notes.join("; ")}`);
    }
  } finally {
    await c.end();
  }

  const line = `${plural(clientsRun, "account")}: ${plural(monthsOk, "month")} read, ${monthsFailed} failed${monthsEmpty ? `, ${monthsEmpty} with no data` : ""}${cappedMonths ? `, ${cappedMonths} cut at the row ceiling` : ""}${dryRun ? ", nothing written" : `, ${plural(written, "month")} written`}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
  if (clientsRun > 0 && monthsOk === 0 && monthsEmpty === 0) {
    console.error("No month could be read for any account.");
    process.exit(1);
  }
  if (clientsFailed > 0 && monthsOk === 0) process.exit(1);
}

main().catch((e) => { console.error(describeFailure(e)); process.exit(1); });

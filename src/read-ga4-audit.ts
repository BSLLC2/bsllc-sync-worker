#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { withVerifyFull } from "./db-url.js";
import { realFetch, safeMessage } from "./page-behaviour/http.js";
import { addDays, ymd } from "./page-behaviour/paths.js";
import { googleToken } from "./signals/google.js";
import { sanitiseConfig, configKey } from "./ga4-report/config.js";
import { ga4Reader } from "./ga4-audit/ga4.js";
import { BROWNELL_DEFAULTS, type AuditConfig } from "./ga4-audit/classify.js";
import { BROWNELL_BASELINE } from "./ga4-audit/baseline.js";
import { defaultWindow, isYmd, type Window } from "./ga4-audit/periods.js";
import { gscReader, listSites, pickProperty } from "./ga4-audit/gsc.js";
import { runAudit, type Audit } from "./ga4-audit/run.js";
import { clientSummaryMd, reportMd } from "./ga4-audit/render.js";
import { DEFAULT_FLOOD_PATHS } from "./ga4-audit/reconcile.js";

/**
 * The standing GA4 + Search Console audit for one client. Reads Google Analytics
 * and Search Console, prints and writes a report and a one-page client summary.
 *
 *   npm run read-ga4-audit -- --client=<id-or-slug> [--start=YYYY-MM-DD --end=YYYY-MM-DD]
 *                             [--out=audit-out] [--cache=.ga4-audit-cache] [--json]
 *
 * READ-ONLY. Google: the analytics and Search Console read scopes only. Database: three
 * SELECTs (the client, its analytics property, its typed report settings). It writes no
 * database row, and nothing here is printed that is a secret.
 *
 * SECRETS: GOOGLE_SERVICE_ACCOUNT_JSON (existing). DATABASE_URL (existing) for the
 * client's settings; without it, pass --property and --site and the defaults apply.
 *
 * The default window is 1 January of this year to three days ago. Quota: one request
 * answers the window, the period before and the year before together, and a window
 * that has settled is cached on disk, so a re-run asks Google for almost nothing.
 */

const GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const LAG_DAYS = 3;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const propertyId = (raw: string) => raw.trim().replace(/^properties\//i, "").trim();

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

function serviceAccount(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON.");
  let json: { client_email?: string; private_key?: string };
  try { json = JSON.parse(raw); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON."); }
  if (!json.client_email || !json.private_key) throw new Error("Service-account JSON missing client_email / private_key.");
  return json as { client_email: string; private_key: string };
}

interface ClientFacts { name: string; slug: string; property: string | null; site: string | null; settings: unknown }

async function readClient(want: string): Promise<ClientFacts> {
  const url = process.env.DATABASE_URL?.trim();
  const prop = arg("property"), site = arg("site");
  if (!url) {
    if (!prop) throw new Error("No DATABASE_URL, so pass --property=<GA4 property id> (and --site=<domain>) to run without the dashboard.");
    return { name: want, slug: slugify(want), property: propertyId(prop), site: site ?? null, settings: null };
  }
  const c = new pg.Client({ connectionString: withVerifyFull(url) });
  await c.connect();
  try {
    const rows = (await c.query<{ id: string; name: string; seo_domain: string | null }>(`SELECT id, name, seo_domain FROM clients WHERE is_internal = false`)).rows;
    const hit = rows.filter((x) => x.id === want || slugify(x.name) === want.toLowerCase());
    if (hit.length !== 1) throw new Error(hit.length ? `More than one client matches "${want}".` : `No client matches "${want}".`);
    const cl = hit[0]!;
    const map = (await c.query<{ external_id: string }>(`SELECT external_id FROM connector_mappings WHERE client_id = $1 AND source = 'ga4' AND enabled = true AND external_id IS NOT NULL AND btrim(external_id) <> '' LIMIT 1`, [cl.id])).rows[0];
    const set = (await c.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = $1`, [configKey(cl.id)])).rows[0];
    return { name: cl.name, slug: slugify(cl.name), property: prop ? propertyId(prop) : map ? propertyId(map.external_id) : null, site: site ?? cl.seo_domain ?? null, settings: set?.value ?? null };
  } finally { await c.end(); }
}

/** The typed report settings become the audit's rules. A group whose address is the advisor path is the advisor section itself, not an extra group. */
function auditConfig(settings: unknown): { cfg: AuditConfig; excludeCountries: string[]; excludeChannels: string[]; formEvent: string } {
  const s = sanitiseConfig(settings);
  const groups = s.groups.filter((g) => !BROWNELL_DEFAULTS.advisorPrefix.startsWith(g.prefix) && !g.prefix.startsWith(BROWNELL_DEFAULTS.advisorPrefix)).map((g) => ({ name: g.name, prefix: g.prefix }));
  return { cfg: { ...BROWNELL_DEFAULTS, groups: groups.length ? groups : BROWNELL_DEFAULTS.groups }, excludeCountries: s.excludeCountries, excludeChannels: s.excludeChannels, formEvent: s.formEvent };
}

async function main() {
  const want = (arg("client") || "").trim();
  if (!want) throw new Error("Pass --client=<id or slug>.");
  const today = ymd(new Date());
  const win: Window = { start: arg("start") ?? defaultWindow(today, LAG_DAYS).start, end: arg("end") ?? defaultWindow(today, LAG_DAYS).end };
  if (!isYmd(win.start) || !isYmd(win.end) || win.start > win.end) throw new Error("--start and --end must be dates (YYYY-MM-DD), start not after end.");
  if (win.end > addDays(today, -LAG_DAYS)) console.log(`Note: the window ends after ${addDays(today, -LAG_DAYS)}; the newest days may still change.`);

  const facts = await readClient(want);
  if (!facts.property) throw new Error(`${facts.name} has no Google Analytics property connected.`);
  const conf = auditConfig(facts.settings);
  const stats = { sent: 0, cached: 0 };
  const token = await googleToken(GA_SCOPE, serviceAccount());
  const io = { fetch: realFetch, token, property: facts.property, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), pauseMs: 300, calls: 0 };
  const read = ga4Reader({ io, today, cacheDir: arg("cache") ?? ".ga4-audit-cache", stats });

  let gsc: { read: ReturnType<typeof gscReader>; property: string; permission: string } | null = null;
  if (facts.site) {
    try {
      const gtoken = await googleToken(GSC_SCOPE, serviceAccount());
      const sites = await listSites(realFetch, gtoken);
      const pick = pickProperty(sites, facts.site);
      if (pick) gsc = { read: gscReader(realFetch, gtoken, pick.siteUrl), property: pick.siteUrl, permission: pick.permissionLevel };
      else console.log(`Search Console: the service account sees no property for ${facts.site}, so the Search Console sections are left out.`);
    } catch (e) { console.log(`Search Console could not be read (${safeMessage(e)}), so those sections are left out.`); }
  }

  const isBrownell = facts.slug === "brownell-travel";
  const audit: Audit = await runAudit(read, {
    client: facts.name, today, window: win, cfg: conf.cfg,
    bots: { excludeCountries: conf.excludeCountries, excludeChannels: conf.excludeChannels, floodPaths: DEFAULT_FLOOD_PATHS, floodCountries: ["Singapore"] },
    formEvent: conf.formEvent, startEvent: "form_start",
    baseline: isBrownell ? BROWNELL_BASELINE : null, gsc,
  });

  const report = reportMd(audit), summary = clientSummaryMd(audit);
  const out = arg("out") ?? "audit-out";
  mkdirSync(out, { recursive: true });
  const stem = `${facts.slug}-${win.start}-to-${win.end}`;
  writeFileSync(join(out, `${stem}.report.md`), report);
  writeFileSync(join(out, `${stem}.client-summary.md`), summary);
  if (process.argv.includes("--json")) writeFileSync(join(out, `${stem}.audit.json`), JSON.stringify(audit, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v), 2));
  console.log(summary);
  console.log(`\nWrote ${join(out, stem)}.report.md and .client-summary.md. Requests sent: ${stats.sent}, answered from cache: ${stats.cached}.`);
  const changed = audit.checks.filter((c) => c.status === "changed").length;
  const line = `audit ${facts.name} ${win.start}..${win.end}: ${changed} stored fact(s) changed, ${stats.sent} request(s)`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
}

main().catch((e) => { console.error(safeMessage(e)); process.exit(1); });

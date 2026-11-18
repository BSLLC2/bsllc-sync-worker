#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { credsFromEnv } from "./dataforseo.js";
import { makeDfs, type Fetcher } from "./backlinks/api.js";
import { planLine, readAudit } from "./backlinks/run.js";
import { writeAudit, writeRunOnly } from "./backlinks/store.js";
import { DOMAIN_ROW_CAP } from "./backlinks/read.js";

/**
 * The link audit read: the client's own site in depth, from DataForSEO's backlink index, into the dashboard's `link_audit_*` tables
 * (schema v308 or later) and the older weekly counts. The app only reads what this writes.
 *
 *   npm run read-backlinks -- --dry-run                 (prints the estimate for every client; makes NO request, writes nothing)
 *   npm run read-backlinks -- --client=<id-or-slug>     (one client)
 *   npm run read-backlinks -- --max-usd=3               (a hard cap per client per run; the default is 3)
 *
 * COST CONTROL. An estimate is printed before any money is spent. The cap is per client per run: a part that would pass it is not
 * asked for, the part is marked capped and what was read is kept. Each call's real cost is read from the answer.
 *
 * WHAT IS READ: counts and the NAMES of other websites, the provider's rank and spam score for each, the pages of the client's own
 * site that links land on (paths only), and the client's OWN site's anchor text, cleaned and cut to 120 characters. A competitor's
 * anchor text is never asked for. Nothing about a person is stored.
 *
 * SECRETS: DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD. Without them a client with the search module and a site on record is marked
 * "no_key" and this EXITS 1, naming the secret.
 */

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const host = (raw: string | null | undefined): string | null => {
  const d = String(raw ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0]!.replace(/:\d+$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) ? d : null;
};
const competitorsOf = (value: string | null | undefined): string[] => {
  try {
    const o = JSON.parse(value ?? "") as { domains?: unknown[]; by?: unknown; at?: unknown };
    if (!o || !Array.isArray(o.domains) || typeof o.by !== "string" || !o.by.trim() || typeof o.at !== "string" || Number.isNaN(Date.parse(o.at))) return [];
    const out: string[] = [];
    for (const d of o.domains) { const h = host(typeof d === "string" ? d : ""); if (h && !out.includes(h)) out.push(h); }
    return out.slice(0, 3);
  } catch { return []; }
};

const realFetch: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(100000) }) as any;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = (arg("client") || "").trim().toLowerCase();
  const capArg = Number(arg("max-usd"));
  const capUsd = Number.isFinite(capArg) && capArg > 0 ? Math.min(capArg, 25) : 3;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var DATABASE_URL.");
  const now = new Date();
  const readOn = ymd(now);

  let creds: { login: string; password: string } | null = null;
  let keyError: string | null = null;
  try { creds = credsFromEnv(); } catch (e) { keyError = e instanceof Error ? e.message : String(e); }

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  let ok = 0, bad = 0, missing = 0, spent = 0;
  const lines: string[] = [];
  try {
    for (const t of ["link_audit_runs", "link_audit_domains", "seo_backlink_runs"]) {
      const r = await c.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [t]);
      if (r.rowCount !== 1) throw new Error(`The table ${t} does not exist yet. Deploy the dashboard app (schema v308 or later) first, then run this again.`);
    }
    const rows = (await c.query<{ id: string; name: string; seo_domain: string | null }>(
      `SELECT id, name, seo_domain FROM clients WHERE module_seo = true AND status <> 'churned' AND is_internal = false AND COALESCE(seo_domain, '') <> '' ORDER BY name`)).rows;
    const chosen = rows.filter((r) => !only || slugify(r.name) === only || r.id.toLowerCase() === only);
    if (only && !chosen.length) throw new Error(`No client with the search module and a site on record matches "${only}".`);

    for (const r of chosen) {
      const own = host(r.seo_domain);
      if (!own) { lines.push(`${r.name}: the site on record is not a website name`); continue; }
      const stored = (await c.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = $1`, [`backlink_competitors:${r.id}`])).rows[0]?.value;
      const competitors = competitorsOf(stored).filter((d) => d !== own);
      const plan = planLine({ own, competitors, capUsd });
      if (dryRun) { console.log(`(dry run) ${r.name}: ${plan.line}`); lines.push(`${r.name}: estimate only`); continue; }
      if (!creds) {
        missing += 1;
        console.log(`${r.name}: no key. ${keyError}`);
        await writeRunOnly(c, r.id, "no_key", keyError ?? "DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are not set on the worker.", now);
        continue;
      }
      console.log(`${r.name}: ${plan.line}`);
      try {
        const dfs = makeDfs(creds, { fetch: realFetch, capUsd });
        const read = await readAudit(dfs, { own, competitors, domainCap: DOMAIN_ROW_CAP, capUsd });
        spent += read.spentUsd;
        await writeAudit(c, r.id, own, read, readOn, now);
        if (read.status === "error") bad += 1; else ok += 1;
        console.log(`  ${read.status}: ${read.domains?.length ?? 0} sites, ${read.anchors?.length ?? 0} anchors, ${read.targets?.length ?? 0} pages, ${read.gap?.length ?? 0} gap sites, $${read.spentUsd.toFixed(2)}${read.detail ? `. ${read.detail}` : ""}`);
      } catch (e) {
        bad += 1;
        const msg = (e instanceof Error ? e.message : String(e)).replace(/Basic [A-Za-z0-9+/=]+/g, "[secret]").slice(0, 200);
        console.log(`  error: ${msg}`);
        await writeRunOnly(c, r.id, "error", msg, now).catch(() => undefined);
      }
    }
  } finally {
    await c.end();
  }
  const summary = dryRun
    ? `BACKLINKS dry run: ${lines.length} clients estimated`
    : `BACKLINKS ${ok} read, ${bad} failed, ${missing} without a key; $${spent.toFixed(2)} spent`;
  console.log(summary);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${summary}\n`);
  if (missing > 0 || (bad > 0 && ok === 0)) process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

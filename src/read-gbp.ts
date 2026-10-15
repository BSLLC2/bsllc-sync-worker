#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { realFetch, safeMessage } from "./page-behaviour/http.js";
import { signalRun, slugify, writeSignalRun, ymd } from "./signals/common.js";
import { SECRET_NAMES, gbpOAuthClient, gbpRefreshTokens, secretValues, type GbpClient } from "./signals/secrets.js";
import { readGbpClient } from "./gbp/run.js";
import { PRUNE_DAILY, PRUNE_KEYWORDS, STORED_KEYWORD_MONTHS, writeDaily, writeKeywords } from "./gbp/store.js";
import { GBP_KEEP_DAYS, GBP_KEEP_KEYWORD_MONTHS, GBP_PAUSE_MS } from "./gbp/types.js";

/**
 * Read Google Business Profile's performance counts for each client that has a
 * location recorded in Admin, Connectors (source Business Profile): calls, direction
 * requests, website clicks, messages, bookings, views, and the search terms people
 * used to find the profile. Writes `gbp_daily` and `gbp_keywords` (schema v257) and
 * a status in `signal_runs`.
 *
 *   npm run read-gbp
 *   npm run read-gbp -- --client=<id-or-slug>
 *   npm run read-gbp -- --dry-run     (proves the authorisation works; reads no count)
 *
 * COUNTS ONLY. No review, no reviewer, no photo. The places and reviews counts are
 * a different API and are not read here.
 *
 * THIS DOES NOTHING UNTIL GOOGLE APPROVES BUSINESS PROFILE API ACCESS and the two
 * secrets exist: GBP_OAUTH_CLIENT_JSON and GBP_TOKENS_JSON. With neither set, a client
 * that has a location recorded is marked "no key" and this EXITS 1, naming the secret.
 * A client with no location recorded is "off" and costs nothing.
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

  let oauthClient: GbpClient | null = null;
  let tokens = new Map<string, string>();
  let secretError: string | null = null;
  try { oauthClient = gbpOAuthClient(); tokens = gbpRefreshTokens(); } catch (e) { secretError = safeMessage(e, secrets); }

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const lines: string[] = [];
  let attempted = 0, ok = 0, bad = 0, missing = 0, terms = 0;
  try {
    for (const t of ["gbp_daily", "gbp_keywords", "signal_runs"]) {
      if (!(await tableExists(c, t))) throw new Error(`The table ${t} does not exist yet. Deploy the dashboard app (schema v257) first, then run this again.`);
    }
    const mapped = (await c.query<{ id: string; name: string; external_id: string | null }>(
      `SELECT c.id, c.name, cm.external_id FROM clients c
         LEFT JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source = 'gbp' AND cm.enabled = true
        WHERE c.status <> 'churned' AND c.is_internal = false ORDER BY c.name`)).rows;
    const chosen = mapped.filter((m) => !only || slugify(m.name) === only || m.id.toLowerCase() === only);
    if (only && !chosen.length) throw new Error(`No client matches "${only}".`);

    for (const m of chosen) {
      const slug = slugify(m.name);
      const hasLocation = Boolean(m.external_id && m.external_id.trim());
      if (hasLocation && secretError) {
        missing += 1;
        lines.push(`${m.name}: ${secretError}`);
        if (!dryRun) await writeSignalRun(c, m.id, signalRun("gbp", "no_key", secretError), now);
        continue;
      }
      const stored = hasLocation
        ? new Set((await c.query<{ month: string }>(STORED_KEYWORD_MONTHS, [m.id, (m.external_id ?? "").trim().replace(/^locations\//i, "")])).rows.map((r) => r.month))
        : new Set<string>();
      const res = await readGbpClient(
        { name: m.name, slug, location: m.external_id, storedMonths: stored },
        { fetch: realFetch, oauthClient, refreshTokens: tokens, now, pauseMs: GBP_PAUSE_MS, dryRun, secrets },
      );
      if (res.run.status === "off") {
        if (!dryRun) await writeSignalRun(c, m.id, res.run, now);
        continue;
      }
      attempted += 1;
      if (res.run.status === "no_key" || res.run.status === "no_token") missing += 1;
      else if (res.run.status === "error") bad += 1;
      else ok += 1;
      terms += res.keywords.length;
      const line = `${dryRun ? "(dry run) " : ""}${m.name}: gbp=${res.run.status}; ${res.daily.length} counts, ${res.keywords.length} terms`;
      console.log(line); lines.push(line);
      if (res.run.detail) console.log(`  ${res.run.status} - ${res.run.detail}`);
      if (dryRun) continue;
      if (res.locationId) {
        await writeDaily(c, m.id, res.locationId, res.daily, now);
        await writeKeywords(c, m.id, res.locationId, res.keywords, now);
        const cutoffDay = ymd(new Date(now.getTime() - GBP_KEEP_DAYS * 86_400_000));
        const k = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - GBP_KEEP_KEYWORD_MONTHS, 1));
        await c.query(PRUNE_DAILY, [m.id, cutoffDay]);
        await c.query(PRUNE_KEYWORDS, [m.id, `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, "0")}`]);
      }
      await writeSignalRun(c, m.id, res.run, now);
    }
  } finally {
    await c.end();
  }
  const line = `${attempted} account${attempted === 1 ? "" : "s"} with a location: ${ok} read, ${bad} failed${missing ? `, ${missing} lacking a key or token` : ""}; ${terms} search terms`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
  if (missing > 0) {
    console.error(`${SECRET_NAMES.gbpClient} or ${SECRET_NAMES.gbpTokens} is missing or unusable: Business Profile was not read for ${missing} account${missing === 1 ? "" : "s"}. Add the secret, then run it again.`);
    process.exit(1);
  }
  if (attempted > 0 && ok === 0) {
    console.error("No account could be read.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(safeMessage(e, secretValues())); process.exit(1); });

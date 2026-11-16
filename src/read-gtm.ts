#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { realFetch, safeMessage } from "./page-behaviour/http.js";
import { slugify, writeSignalRun } from "./signals/common.js";
import { SECRET_NAMES, secretValues } from "./signals/secrets.js";
import { googleToken, serviceAccount } from "./signals/google.js";
import { loadDirectory, readGtmClient, type Directory } from "./gtm/run.js";
import { writeFacts, writeFailed } from "./gtm/store.js";
import { GTM_PAUSE_MS, GTM_SCOPE } from "./gtm/types.js";

/**
 * Read each client's LIVE Google Tag Manager container, read-only, and keep declared
 * facts: which tag types are there, their event names, whether each is paused and
 * whether it has a firing trigger. Writes `gtm_container_facts` and a status in
 * `signal_runs` (source gtm). Churned and internal clients are never read.
 *
 *   npm run read-gtm
 *   npm run read-gtm -- --client=<id-or-slug>
 *   npm run read-gtm -- --dry-run     (reads and prints the counts; writes nothing)
 *
 * No new secret: it uses the Google service account the other readers use
 * (GOOGLE_SERVICE_ACCOUNT_JSON), asked for the tagmanager.readonly scope and nothing
 * else. Each client has to give that service account Read access to their container in
 * Tag Manager; without it the run says so for that client. With the secret missing, a
 * client that HAS a container recorded is marked "no token" and this EXITS 1.
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

  // The token door: a missing or refused service account is a status, not a crash.
  let token: string | null = null;
  let tokenProblem: string | null = null;
  try { token = await googleToken(GTM_SCOPE, serviceAccount(process.env, "no Tag Manager container can be read")); }
  catch (e) { tokenProblem = safeMessage(e, secrets); }

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const lines: string[] = [];
  let attempted = 0, ok = 0, bad = 0, missing = 0, tags = 0;
  let directory: Promise<Directory> | null = null;
  try {
    for (const t of ["gtm_container_facts", "signal_runs"]) {
      if (!(await tableExists(c, t))) throw new Error(`The table ${t} does not exist yet. Deploy the dashboard app (the Tag Manager schema block) first, then run this again.`);
    }
    // Churned and internal accounts are never read.
    const mapped = (await c.query<{ id: string; name: string; external_id: string | null }>(
      `SELECT c.id, c.name, cm.external_id FROM clients c
         LEFT JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source = 'gtm' AND cm.enabled = true
        WHERE c.status <> 'churned' AND c.is_internal = false ORDER BY c.name`)).rows;
    const chosen = mapped.filter((m) => !only || slugify(m.name) === only || m.id.toLowerCase() === only);
    if (only && !chosen.length) throw new Error(`No client matches "${only}".`);

    for (const m of chosen) {
      const slug = slugify(m.name);
      const res = await readGtmClient({ name: m.name, slug, containerId: m.external_id }, {
        fetch: realFetch, token, tokenProblem, pauseMs: GTM_PAUSE_MS, secrets,
        // The listing is asked for once per run, and only if some client has a container recorded.
        directory: () => (directory ??= loadDirectory(realFetch, token!, GTM_PAUSE_MS, secrets)),
      });
      if (res.run.status === "off") {
        if (!dryRun) await writeSignalRun(c, m.id, res.run, now);
        continue;
      }
      attempted += 1;
      if (res.run.status === "no_token" || res.run.status === "no_key") missing += 1;
      else if (res.run.status === "error") bad += 1;
      else ok += 1;
      tags += res.facts?.counts.tags ?? 0;
      const f = res.facts;
      const line = `${dryRun ? "(dry run) " : ""}${m.name}: gtm=${res.run.status}; ${f ? `${f.counts.tags} tags (${f.counts.paused} paused), ${f.ga4Configs.length} GA4 config, ${f.ga4Events.length} GA4 event, ${f.adsConversions.length} Ads conversion` : "no facts"}`;
      console.log(line); lines.push(line);
      if (res.run.detail) console.log(`  ${res.run.status} - ${res.run.detail}`);
      if (dryRun) continue;
      const id = res.containerId ?? "";
      if (res.failed) await writeFailed(c, m.id, id, res.state ?? "error", now);
      else await writeFacts(c, m.id, id, res.containerPath, res.version, res.facts, res.state, now);
      await writeSignalRun(c, m.id, res.run, now);
    }
  } finally {
    await c.end();
  }
  const line = `${attempted} account${attempted === 1 ? "" : "s"} with a Tag Manager container: ${ok} read, ${bad} failed${missing ? `, ${missing} lacking a usable service account` : ""}; ${tags} tags`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
  if (missing > 0) {
    console.error(`${SECRET_NAMES.serviceAccount} is missing or not accepted: Tag Manager was not read for ${missing} account${missing === 1 ? "" : "s"}. ${tokenProblem ?? ""}`.trim());
    process.exit(1);
  }
  if (attempted > 0 && ok === 0) {
    console.error("No container could be read.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(safeMessage(e, secretValues())); process.exit(1); });

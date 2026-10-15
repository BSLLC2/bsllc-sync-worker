#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { realFetch, safeMessage } from "./page-behaviour/http.js";
import { slugify, writeSignalRun, ymd } from "./signals/common.js";
import { SECRET_NAMES, ctmAccountKeys, ctmHashKey, secretValues, type CtmKeys } from "./signals/secrets.js";
import { readCtmClient } from "./ctm/run.js";
import { PRUNE_CTM_CALLS, writeCalls } from "./ctm/store.js";
import { CTM_KEEP_DAYS, CTM_MAX_DAYS, CTM_PAUSE_MS } from "./ctm/types.js";

/**
 * Read each client's CallTrackingMetrics call log into `ctm_calls` (schema v257): when a
 * call came, which tracker source and label it came through, how it ended, how long it
 * rang and talked, where the caller was (city and state), the click id and campaign, two
 * tags as yes or no, and the caller as a salted hash. Writes a status in `signal_runs`.
 *
 *   npm run read-ctm
 *   npm run read-ctm -- --client=<id-or-slug>
 *   npm run read-ctm -- --days=120    (a longer window; at most 400)
 *   npm run read-ctm -- --dry-run     (proves the keys work and says how many calls; reads none)
 *
 * NEVER STORED: the caller's number, the caller-ID text or name, the recording or any audio
 * link, the transcript, the summary, notes, the message body, or the visitor's IP.
 *
 * TWO SECRETS ARE NEEDED besides the database: CTM_ACCOUNT_KEYS_JSON (each client's access
 * key, secret key and account id by client slug) and CTM_CALLER_HASH_KEY (any long random
 * string, kept for good). With either missing, a client that has a CallTrackingMetrics row
 * switched on is marked "no key" and this EXITS 1, naming the secret. A client with no row
 * switched on is "off" and costs nothing.
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
  const daysArg = Number(arg("days"));
  const days = Number.isFinite(daysArg) && daysArg > 0 ? Math.min(Math.floor(daysArg), CTM_MAX_DAYS) : undefined;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var DATABASE_URL.");
  const now = new Date();
  const secrets = secretValues();

  let keys = new Map<string, CtmKeys>();
  let secretError: string | null = null;
  try { keys = ctmAccountKeys(); } catch (e) { secretError = safeMessage(e, secrets); }
  const hashKey = ctmHashKey();

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  let attempted = 0, ok = 0, bad = 0, missing = 0, total = 0, skipped = 0;
  try {
    for (const t of ["ctm_calls", "signal_runs"]) {
      if (!(await tableExists(c, t))) throw new Error(`The table ${t} does not exist yet. Deploy the dashboard app (schema v257) first, then run this again.`);
    }
    const mapped = (await c.query<{ id: string; name: string; external_id: string | null; has_mapping: boolean }>(
      `SELECT c.id, c.name, cm.external_id, (cm.client_id IS NOT NULL) AS has_mapping FROM clients c
         LEFT JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source = 'ctm' AND cm.enabled = true
        WHERE c.status <> 'churned' AND c.is_internal = false ORDER BY c.name`)).rows;
    const chosen = mapped.filter((m) => !only || slugify(m.name) === only || m.id.toLowerCase() === only);
    if (only && !chosen.length) throw new Error(`No client matches "${only}".`);

    for (const m of chosen) {
      const slug = slugify(m.name);
      const recorded = m.has_mapping ? (m.external_id ?? "").trim() : null;
      const res = secretError && recorded !== null
        ? { calls: [], skipped: { noId: 0, noTime: 0 }, window: null, run: { source: "ctm" as const, status: "no_key" as const, detail: secretError, rows: 0, capped: false, totalFound: null, windowEnd: null } }
        : await readCtmClient({ name: m.name, slug, recorded }, { fetch: realFetch, keys, hashKey, now, days, pauseMs: CTM_PAUSE_MS, dryRun, secrets });
      if (res.run.status === "off") {
        if (!dryRun) await writeSignalRun(c, m.id, res.run, now);
        continue;
      }
      attempted += 1;
      if (res.run.status === "no_key" || res.run.status === "no_token") missing += 1;
      else if (res.run.status === "error") bad += 1;
      else ok += 1;
      total += res.calls.length;
      skipped += res.skipped.noId + res.skipped.noTime;
      const line = `${dryRun ? "(dry run) " : ""}${m.name}: ctm=${res.run.status}; ${res.calls.length} calls${res.skipped.noId + res.skipped.noTime ? `, ${res.skipped.noId + res.skipped.noTime} skipped` : ""}`;
      console.log(line);
      if (res.run.detail) console.log(`  ${res.run.status} - ${res.run.detail}`);
      if (dryRun) continue;
      if (res.calls.length) {
        await writeCalls(c, m.id, res.calls, now);
        await c.query(PRUNE_CTM_CALLS, [m.id, new Date(now.getTime() - CTM_KEEP_DAYS * 86_400_000).toISOString()]);
      }
      await writeSignalRun(c, m.id, res.run, now);
    }
  } finally {
    await c.end();
  }
  const line = `${attempted} account${attempted === 1 ? "" : "s"} with a call tracker: ${ok} read, ${bad} failed${missing ? `, ${missing} lacking a key` : ""}; ${total} calls${skipped ? `, ${skipped} skipped` : ""} (${ymd(now)})`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
  if (missing > 0) {
    console.error(`${SECRET_NAMES.ctmKeys} or ${SECRET_NAMES.ctmHash} is missing or not accepted: calls were not read for ${missing} account${missing === 1 ? "" : "s"}. Add the secret, then run it again.`);
    process.exit(1);
  }
  if (attempted > 0 && ok === 0) {
    console.error("No account could be read.");
    process.exit(1);
  }
}

main().catch((e) => { console.error(safeMessage(e, secretValues())); process.exit(1); });

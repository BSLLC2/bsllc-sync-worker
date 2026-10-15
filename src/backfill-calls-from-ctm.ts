#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { safeMessage } from "./page-behaviour/http.js";
import { slugify } from "./signals/common.js";
import { SECRET_NAMES, ctmHashKey, secretValues } from "./signals/secrets.js";
import { runBackfill } from "./ctm/call-backfill.js";

/**
 * One-time correction of the calls already stored as forms, from the call log the daily reader keeps in the
 * database (`ctm_calls`). It is the dashboard's CSV correction (`npm run calls:backfill`) with the CSV replaced
 * by that table, so nobody downloads a file of phone numbers and the owner never needs a database address.
 *
 *   npm run backfill-calls-from-ctm -- --client=<slug>             a dry run: counts only, writes nothing
 *   npm run backfill-calls-from-ctm -- --client=<slug> --apply     writes (needs the database and the hash key)
 *
 * READ THE CALL LOG FIRST. This matches what `ctm_calls` already holds, so run the call-log reader first, with
 * the `days` input as far back as the calls you want corrected (at most 400).
 *
 * Needs DATABASE_URL and CTM_CALLER_HASH_KEY (the same key the reader hashes callers with: a stored phone is
 * hashed with it here and compared, never printed). It calls no third party.
 *
 * The output is counts only: matched, would relabel as a call, would fill details, ambiguous, unmatched. It
 * never prints a phone number, a name or caller-ID text.
 */
function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const only = (arg("client") || "").trim().toLowerCase();
  if (!only) throw new Error("Say which client: --client=<its address, such as diesel-power-group>. This is a per-client correction.");
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var DATABASE_URL.");
  const hashKey = ctmHashKey();
  if (!hashKey) throw new Error(`${SECRET_NAMES.ctmHash} is not set (or is under 24 characters). It is the key the call log's callers are hashed with; without it a stored phone cannot be compared. Nothing was read.`);
  const by = (process.env.RUN_BY || process.env.GITHUB_ACTOR || "").trim();
  if (apply && !by) throw new Error("Applying needs a name for the account's history: set RUN_BY (the workflow passes the person who pressed it).");

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    for (const t of ["ctm_calls", "web_inquiries", "client_activity_log"]) {
      const r = await c.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [t]);
      if (r.rowCount !== 1) throw new Error(`The table ${t} does not exist yet. Deploy the dashboard app first.`);
    }
    const cols = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'web_inquiries' AND column_name = 'call_status'`);
    if (cols.rowCount !== 1) throw new Error("web_inquiries has no call_status column yet. Deploy the dashboard app that records calls (schema 255 or later) first.");
    const clients = (await c.query(`SELECT id, name FROM clients`)).rows as Array<{ id: string; name: string }>;
    const client = clients.find((x) => slugify(x.name) === only || x.id.toLowerCase() === only);
    if (!client) throw new Error(`No client has the address "${only}".`);
    const slug = slugify(client.name);
    const res = await runBackfill(c, { clientId: client.id, slug, hashKey, apply, by: by || "dry run", now: new Date(), newId: randomUUID });
    console.log(`${apply ? "" : "(dry run, nothing written) "}${client.name}`);
    for (const l of res.lines) console.log(`  ${l.replace(/^export:/, "call log:")}`);
    if (apply) console.log(`  rows written: ${res.written}.${res.written > 0 ? " One internal line was added to the account's history." : " Nothing needed changing, so no line was added."}`);
    else console.log("  Nothing was written. Run it again with dry_run off to apply exactly this.");
    const summary = `${res.counts ? `${res.counts.matched} matched, ${res.counts.wouldRelabel} ${apply ? "relabelled" : "would relabel"}, ${res.counts.ambiguous} ambiguous, ${res.counts.unmatched} unmatched` : "nothing to match"}${apply ? `; ${res.written} rows written` : ""}`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${summary}\n`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(safeMessage(e, secretValues())); process.exit(1); });

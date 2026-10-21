#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { FRANKLIN_CONTRACT_START } from "./tracker/config.js";

/**
 * One-off: record Franklin Brazing's contract start (the day the contract was signed, 2023-12-15: DocuSign
 * "FranklinBrazing_BSLLC_Contract_121423" completed that day; the kickoff call was offered for the week of
 * 18 December 2023). The dashboard bounds every revenue and lead reading by `clients.contract_start`, and the sales-sheet
 * feed counts from the same day, so a later date here would hide the earliest sales from the case study.
 *
 * Dry run by default. It finds the client by exact name "Franklin Brazing" (and stops if that is not exactly one
 * account), changes only `contract_start`, and only when it differs. It adds one INTERNAL line to the account's
 * history (not shown to the client). The same change can be made by hand: the client page, Account details, Contract start.
 *
 *   npm run oneoff-set-franklin-contract-start -- --dry-run=true
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? process.env[k.toUpperCase().replace(/-/g, "_")] ?? d).trim();

async function main() {
  const dryRun = arg("dry-run", "true") !== "false";
  const by = arg("by", "owner one-off");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query<{ id: string; name: string; contract_start: string | null }>(`SELECT id, name, contract_start FROM clients WHERE lower(btrim(name)) = 'franklin brazing'`);
    if (rows.length !== 1) throw new Error(`Expected exactly one account named "Franklin Brazing", found ${rows.length}. Nothing changed.`);
    const client = rows[0]!;
    console.log(`${client.name}: contract start is ${client.contract_start ?? "not set"}; the target is ${FRANKLIN_CONTRACT_START}.`);
    if (client.contract_start === FRANKLIN_CONTRACT_START) { console.log("Already correct. Nothing to do."); return; }
    if (dryRun) { console.log(`DRY RUN: would change it from ${client.contract_start ?? "not set"} to ${FRANKLIN_CONTRACT_START} and add one internal history line. Nothing written.`); return; }
    await c.query("BEGIN");
    const upd = await c.query(`UPDATE clients SET contract_start = $2 WHERE id = $1 AND contract_start IS NOT DISTINCT FROM $3`, [client.id, FRANKLIN_CONTRACT_START, client.contract_start]);
    if (upd.rowCount !== 1) { await c.query("ROLLBACK"); throw new Error("The contract start changed while this ran. Nothing written; run it again."); }
    await c.query(
      `INSERT INTO client_activity_log (id, client_id, category, title, client_summary, internal_detail, visible_to_client, occurred_at, created_by)
       VALUES ($1, $2, 'other', $3, NULL, $4, false, $5, $6)`,
      [randomUUID(), client.id, "Contract start set", `Contract start changed from ${client.contract_start ?? "not set"} to ${FRANKLIN_CONTRACT_START} (the day the contract was signed), so the closed-deal sheets count from the start of the engagement.`, new Date().toISOString().slice(0, 10), by]);
    await c.query("COMMIT");
    console.log(`done: contract start is now ${FRANKLIN_CONTRACT_START}.`);
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

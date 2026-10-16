#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { slugify } from "./signals/common.js";

/**
 * One-off: switch on a client's CallTrackingMetrics connector row, the same row Admin,
 * Connectors writes (connector_mappings: client, source 'ctm', the account number, enabled).
 * It exists because the daily call-log reader only reads a client whose row is on, and the
 * row was not reachable from the screen.
 *
 *   npm run oneoff-enable-ctm-connector -- --client=ohio-community-health-och --account=424996 [--apply]
 *
 * Dry run unless --apply. It writes one row (insert, or update of that same row) and nothing
 * else. It never prints a key. The account number is digits only.
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
function arg(n: string): string { const p = `--${n}=`; const a = process.argv.find((x) => x.startsWith(p)); return a ? a.slice(p.length).trim() : ""; }

async function main() {
  const client = arg("client").toLowerCase();
  const account = arg("account");
  const apply = process.argv.includes("--apply");
  if (!client) throw new Error("Give --client=<the client's address, such as ohio-community-health-och>.");
  if (!/^[0-9]{3,12}$/.test(account)) throw new Error("--account must be the account number, digits only.");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const all = await c.query<{ id: string; name: string }>("SELECT id, name FROM clients");
    const hit = all.rows.filter((r) => slugify(r.name) === client || r.id.toLowerCase() === client);
    if (hit.length !== 1) throw new Error(hit.length ? `More than one client matches "${client}".` : `No client matches "${client}".`);
    const m = hit[0]!;
    const cur = await c.query<{ id: string; external_id: string | null; enabled: boolean }>(
      "SELECT id, external_id, enabled FROM connector_mappings WHERE client_id = $1 AND source = 'ctm'", [m.id]);
    const row = cur.rows[0];
    console.log(`Client: ${m.name}. CallTrackingMetrics row: ${row ? `exists, ${row.enabled ? "on" : "off"}, account ${row.external_id ? "recorded" : "blank"}` : "none yet"}.`);
    if (row && row.enabled && row.external_id === account) { console.log("Already on with this account number. Nothing to change."); return; }
    if (!apply) { console.log(`DRY RUN: would ${row ? "update the row to" : "create the row,"} on, account ${account}. Nothing written.`); return; }
    if (row) await c.query("UPDATE connector_mappings SET external_id = $2, enabled = true, updated_at = now() WHERE id = $1", [row.id, account]);
    else await c.query("INSERT INTO connector_mappings (id, client_id, source, external_id, enabled) VALUES ($1, $2, 'ctm', $3, true)", [randomUUID(), m.id, account]);
    console.log(`Done: CallTrackingMetrics is on for ${m.name}, account ${account}.`);
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

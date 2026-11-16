#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { LANDED_SOURCES } from "./data-landed/catalog.js";
import { buildRows, countStates, type LandedRow } from "./data-landed/reading.js";
import { gatherClients, gatherLanded, keyOf, tableReady, writeRows } from "./data-landed/store.js";
import { splitClients, skippedLine } from "./client-scope.js";
import { describeError } from "./describe-error.js";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";

/**
 * Did the data land? For every live client and every source it is expected to
 * have, is the newest row of that source's table newer than its cadence?
 *
 * A scheduled run can finish GREEN while nothing arrived (a property nobody
 * shared, an account that answered with no rows, a sheet that was never opened).
 * This job ignores what the runs said and asks the tables. It READS every source
 * table and writes one derived table, `source_landed`, which the dashboard draws.
 * Nothing about a client's accounts, sites or sources is touched.
 *
 *   npm run data-landed
 *   npm run data-landed -- --client=<id-or-slug>
 *   npm run data-landed -- --dry-run     (read and print; write nothing)
 *
 * Counts and dates only. A churned client is not judged ("N churned skipped"),
 * and neither is the internal one. A failed or missing read is never "ok": a
 * source whose table is missing is named and left out, a run that cannot connect
 * exits 1.
 */
const arg = (name: string) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3).trim() || "";
const slugOf = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = arg("client");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Missing DATABASE_URL.");
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const now = new Date();
    const all = await gatherClients(c);
    const split = splitClients(all, (r) => ({ status: r.status, isInternal: r.isInternal }), { skipInternal: true });
    console.log(`Did the data land: ${skippedLine(split)}`);
    const pick = only ? split.live.filter((r) => r.clientId === only || slugOf(r.name) === only || slugOf(r.name).startsWith(slugOf(only))) : split.live;
    const { landed, unreadable } = await gatherLanded(c);
    for (const u of unreadable) console.log(`! ${u}: its table is not there yet, so it is left out and not read as "nothing landed".`);
    const readable = new Set(LANDED_SOURCES.filter((s) => !unreadable.includes(s)));
    const rows: LandedRow[] = buildRows(pick, (id, s) => landed.get(keyOf(id, s)) ?? null, now).filter((r) => readable.has(r.source));
    const n = countStates(rows);
    const nameOf = new Map(all.map((x) => [x.clientId, x.name]));
    for (const r of rows.filter((x) => x.state === "stale" || x.state === "never")) {
      console.log(`  ${r.state === "never" ? "NEVER" : "STALE"} ${nameOf.get(r.clientId) ?? r.clientId} · ${r.source}${r.lastRowAt ? ` · last ${r.lastRowAt.toISOString().slice(0, 10)}` : ""}${r.detail ? ` · ${r.detail}` : ""}`);
    }
    console.log(`${pick.length} client(s) · ${n.ok} ok · ${n.stale} stale · ${n.never} never · ${n.not_applicable} not switched on${dryRun ? " (dry run: nothing written)" : ""}`);
    if (!dryRun) {
      if (!(await tableReady(c))) throw new Error("source_landed does not exist: the dashboard is not on schema v300 yet.");
      await writeRows(c, rows, split.live.map((r) => r.clientId), LANDED_SOURCES, now);
    }
    emitJobSummary(formatJobSummary(
      { clients: pick.length, ok: n.ok, stale: n.stale, never: n.never, not_on: n.not_applicable, churned_skipped: split.churned.length },
      n.stale + n.never ? `${n.stale + n.never} source(s) expected data and none landed` : "every switched-on source landed",
    ));
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(describeError(e)); process.exit(1); });

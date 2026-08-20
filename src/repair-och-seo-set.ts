#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * One-off repair of OHC's tracked keyword set. Two defects, both found by
 * reading the client report rather than the database:
 *
 *   1. The set was imported as 79 rows and the report renders 74. Five rows —
 *      the three Cincinnati detox terms and two withdrawal-education terms —
 *      never landed.
 *   2. Local-scope rows were imported with location_name 'Cincinnati, OH',
 *      human shorthand DataForSEO's API rejects. An earlier repair fixed the
 *      set but any row added since, or missed by it, is still wrong; this
 *      normalises every local row to the spec form.
 *
 * Idempotent on (keyword, scope, device) and safe to re-run.
 *
 *   npm run repair-och-seo-set -- --dry-run
 *   npm run repair-och-seo-set
 */

const CLIENT_NAME = "Ohio Community Health (OCH)";
/** DataForSEO only accepts location names from its own database: full state
 *  name, no spaces around the commas. */
const LOCATION = "Cincinnati,Ohio,United States";

interface Target {
  keyword: string;
  scope: "national" | "local";
  device: "desktop" | "mobile";
  tag: string;
  reportStatus: string;
  notes: string;
}

const MISSING: Target[] = [
  {
    keyword: "opioid withdrawal timeline", scope: "national", device: "desktop",
    tag: "7 · Withdrawal education", reportStatus: "core - report weekly",
    notes: "Education about what withdrawal is like. Legitimate to publish today — it is not a detox service claim.",
  },
  {
    keyword: "how to detox from alcohol", scope: "national", device: "desktop",
    tag: "7 · Withdrawal education", reportStatus: "core - report weekly",
    notes: "Education about what withdrawal is like. Legitimate to publish today — it is not a detox service claim.",
  },
  {
    keyword: "alcohol detox cincinnati", scope: "local", device: "desktop",
    tag: "8 · Detox baseline (2027)", reportStatus: "baseline - track, do not report yet",
    notes: "Detox licensure Q1 2027. Baseline only — publish no detox service claim before licensure.",
  },
  {
    keyword: "detox cincinnati", scope: "local", device: "desktop",
    tag: "8 · Detox baseline (2027)", reportStatus: "baseline - track, do not report yet",
    notes: "Detox licensure Q1 2027. Baseline only — publish no detox service claim before licensure.",
  },
  {
    keyword: "drug detox cincinnati", scope: "local", device: "desktop",
    tag: "8 · Detox baseline (2027)", reportStatus: "baseline - track, do not report yet",
    notes: "Detox licensure Q1 2027. Baseline only — publish no detox service claim before licensure.",
  },
];

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const databaseUrl = (process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("Missing DATABASE_URL.");

  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const { rows: clients } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE name = $1`, [CLIENT_NAME]);
    if (clients.length !== 1) throw new Error(`Expected exactly one client named "${CLIENT_NAME}", found ${clients.length}.`);
    const client = clients[0]!;

    const { rows: existing } = await c.query<{ id: string; keyword: string; scope: string; device: string; location_name: string | null; active: boolean }>(
      `SELECT id, keyword, scope, device, location_name, active FROM seo_targets WHERE client_id = $1 ORDER BY keyword`,
      [client.id]);
    console.log(`${client.name}: ${existing.length} keyword targets (${existing.filter((r) => r.active).length} active)\n`);

    const key = (k: string, s: string, d: string) => `${k.toLowerCase().trim()}·${s}·${d}`;
    const have = new Set(existing.map((r) => key(r.keyword, r.scope, r.device)));

    // ── 1. Add the five that never landed ────────────────────────────────
    let inserted = 0;
    for (const t of MISSING) {
      if (have.has(key(t.keyword, t.scope, t.device))) {
        console.log(`  ·  present: "${t.keyword}" [${t.scope}/${t.device}]`);
        continue;
      }
      console.log(`  ✅ ${dryRun ? "would add" : "adding"}: "${t.keyword}" [${t.scope}/${t.device}] — ${t.tag}`);
      if (!dryRun) {
        await c.query(
          `INSERT INTO seo_targets (id, client_id, keyword, scope, location_name, device, tag, report_status, notes, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
          [randomUUID(), client.id, t.keyword, t.scope, t.scope === "local" ? LOCATION : null, t.device, t.tag, t.reportStatus, t.notes],
        );
      }
      inserted++;
    }

    // ── 2. Normalise every local row's location to the DataForSEO spec ────
    const wrong = existing.filter((r) => r.scope === "local" && (r.location_name ?? "") !== LOCATION);
    if (!wrong.length) {
      console.log(`\n  ·  all local rows already use "${LOCATION}"`);
    } else {
      console.log(`\n  ${wrong.length} local row(s) with a location DataForSEO will reject:`);
      for (const r of wrong) console.log(`     "${r.keyword}" → ${JSON.stringify(r.location_name)}`);
      if (!dryRun) {
        const res = await c.query(
          `UPDATE seo_targets SET location_name = $1
            WHERE client_id = $2 AND scope = 'local' AND (location_name IS DISTINCT FROM $1)`,
          [LOCATION, client.id]);
        console.log(`  ✅ normalised ${res.rowCount} row(s) to "${LOCATION}"`);
      }
    }

    const total = existing.length + (dryRun ? 0 : inserted);
    console.log(`\n${dryRun ? "Dry run — nothing written." : "Done."} Targets now: ${total}${dryRun ? ` (would be ${existing.length + inserted})` : ""}`);
    if (!dryRun && inserted) console.log(`Ranks for the new rows appear after the next import-seo run.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

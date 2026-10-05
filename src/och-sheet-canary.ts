#!/usr/bin/env tsx
import "dotenv/config";
import { createPrivateKey } from "node:crypto";
import pg from "pg";
import { accessToken, sheetsFetch } from "./och-google.js";
import { ochSheetId } from "./och-sheet-target.js";
import { checkOchSheet, summaryLine, hasStop, type CheckFacts } from "./och-sheet-check.js";
import { gatherFacts, type Doors } from "./och-sheet-gather.js";

/**
 * Daily check on OCH's Admission Board connection. Read-only: it opens the
 * sheet, looks, and says which of the known ways the connection stops (if any)
 * has happened. Runs before the admissions import and the web-leads publish so
 * a dead connection is named at 07:10 UTC with its cause, instead of showing up
 * as flat numbers weeks later.
 *
 * Reads counts, tab names and dates only. It never prints a name, a phone number
 * or a date of birth, and it writes nothing to the sheet or the database. The
 * workflow records the outcome as the `och_sheet_check` heartbeat, whose note is
 * the last line this prints (shape: `OCH-SHEET ok|warn|stop <cause>: sentence`).
 * What it reads and decides is in och-sheet-gather.ts and och-sheet-check.ts,
 * which the guard drives against a fake Google.
 *
 *   npm run och-sheet-check
 *   OCH_SHEET_ID=<id or sheet URL>  OCH_ADMISSIONS_TAB="<exact tab name>"   (both optional)
 */

const businessDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

type KeyFile = { client_email?: string; private_key?: string };
function readKey(): { state: CheckFacts["key"]["state"]; json: KeyFile | null } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) return { state: "missing", json: null };
  let json: KeyFile;
  try { json = JSON.parse(raw); } catch { return { state: "unparseable", json: null }; }
  if (!json || typeof json !== "object" || !json.client_email || !json.private_key) return { state: "incomplete", json };
  // A key file that parses but whose private key is not a key would fail inside
  // the token call with an error that looks like a network fault, and read as a
  // Google outage nobody is told about. Say it is the file.
  try { createPrivateKey(json.private_key); } catch { return { state: "unparseable", json }; }
  return { state: "ok", json };
}

/** GET with three tries on a 429, a 5xx or a dropped connection. 4xx answers are answers. */
async function getJson(url: string, token: string): Promise<{ status: number | null; body: any }> {
  try {
    const res = await sheetsFetch(url, { headers: { Authorization: `Bearer ${token}` } }, 3);
    let body: any = null;
    try { body = await res.json(); } catch { /* an empty body is fine */ }
    return { status: res.status, body };
  } catch {
    return { status: null, body: null };
  }
}

const OCH_SLUG = "ohio-community-health-och";

/**
 * Admissions per month as the import last stored them, newest write per month.
 * Read-only. Null when the client is not found or nothing was ever stored: a
 * null is unanswered, never "no change".
 */
async function storedAdmissions(databaseUrl: string, slug: string): Promise<Record<string, number> | null> {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const clients = await c.query<{ id: string; name: string }>("SELECT id, name FROM clients");
    const match = clients.rows.find((r) => slugify(r.name) === slug);
    if (!match) return null;
    const { rows } = await c.query<{ ym: string; v: number }>(
      `SELECT DISTINCT ON (to_char(period_start AT TIME ZONE 'UTC', 'YYYY-MM'))
              to_char(period_start AT TIME ZONE 'UTC', 'YYYY-MM') AS ym, value_numeric AS v
         FROM metric_snapshots
        WHERE client_id = $1 AND source = 'manual' AND metric_key = 'manual.admissions'
          AND data_state = 'live' AND value_numeric IS NOT NULL AND period_start IS NOT NULL
        ORDER BY to_char(period_start AT TIME ZONE 'UTC', 'YYYY-MM'), synced_at DESC`,
      [match.id],
    );
    if (!rows.length) return null;
    return Object.fromEntries(rows.map((r) => [r.ym, Number(r.v)]));
  } finally {
    await c.end();
  }
}

async function main() {
  const { state, json } = readKey();
  let facts: CheckFacts;
  let skipped: string[] = [];
  let tab: string | null = null;
  const today = businessDay();

  if (state !== "ok" || !json) {
    facts = {
      today, key: { state, serviceEmail: json?.client_email ?? null }, sheet: null,
      drive: { checked: false, trashed: null, canEdit: null, modifiedYmd: null },
      tabs: [], pick: null, columns: null, rowsRead: null, rowsCapped: false, newestAdmissionYmd: null, board: null,
    };
  } else {
    const doors: Doors = {
      token: (scope) => accessToken(json, scope),
      stored: process.env.DATABASE_URL?.trim() ? () => storedAdmissions(process.env.DATABASE_URL!.trim(), OCH_SLUG) : undefined,
      get: getJson,
    };
    const g = await gatherFacts(doors, { sheetId: ochSheetId(), preferredTab: process.env.OCH_ADMISSIONS_TAB?.trim() || null, today, serviceEmail: json.client_email ?? null });
    facts = g.facts; skipped = g.skipped; tab = g.tab;
  }

  const findings = checkOchSheet(facts);
  for (const f of findings) {
    console.log(`\n[${f.level}] ${f.code} (${f.who === "us" ? "ours to fix" : f.who === "client" ? "OCH's to fix" : "find out first"}): ${f.line}`);
    f.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  }
  if (skipped.length) console.log(`\nSkipped: ${skipped.join("; ")}.`);
  if (facts.pick?.how === "first_tab") console.log(`\nNote: no tab name contains "admission", so the first tab ("${tab}") was read.`);
  // The heartbeat reads the LAST line. Keep it last.
  console.log(`\n${summaryLine(findings, { tab, rows: facts.rowsRead, newest: facts.newestAdmissionYmd })}`);
  process.exit(hasStop(findings) ? 1 : 0);
}

main().catch((e) => {
  console.error(`OCH-SHEET stop check_crashed: the check itself failed (${(e instanceof Error ? e.message : String(e)).slice(0, 150)}).`);
  process.exit(1);
});

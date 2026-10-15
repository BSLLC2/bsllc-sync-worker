#!/usr/bin/env tsx
/**
 * Guard for matching the call log to the stored calls: the one-time correction
 * (`backfill-calls-from-ctm`) and the daily fill the reader runs.
 *
 * The first half is pure: the same planner the dashboard's CSV correction uses, driven through the
 * adapters from `ctm_calls` and `web_inquiries` rows. The second half runs the real SQL against a
 * throwaway Postgres schema when ADS_VERIFY_DATABASE_URL is set (CI sets it in the `ads-store` job;
 * locally `node scripts/test-db.mjs start` in the dashboard repo prints a URL).
 *
 * EVERY CLIENT, CALLER AND NUMBER BELOW IS INVENTED (the reserved fictional 555-01xx range).
 *
 *   npx tsx src/verify-call-backfill.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { callerHashOf } from "./ctm/map.js";
import {
  planBackfill, backfillReportLines, clusterCalls, rowKind, isCallerIdText,
  MATCH_AFTER_END_SECONDS, MATCH_BEFORE_START_SECONDS, FOLD_WINDOW_SECONDS,
  type StoredRow,
} from "./ctm/call-backfill-rules.js";
import {
  DAILY_HISTORY_TITLE, BACKFILL_HISTORY_TITLE, SELECT_CTM_CALLS, SELECT_INQUIRIES, UPDATE_INQUIRY, INSERT_HISTORY,
  applyPlans, easternDay, exportCallOf, readOf, runBackfill, runDailyFill, storedRowOf, type Pg,
} from "./ctm/call-backfill.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);
function selfTest(label: string, test: (text: string) => boolean, good: string, bad: string) {
  ok(`${label} (self-test: passes a good sample)`, test(good) === true);
  ok(`${label} (self-test: fails a planted bad sample)`, test(bad) === false);
}

const KEY = "a-long-random-hash-key-value-0123456789";
const T0 = new Date("2026-10-14T16:30:00Z");
const at = (secs: number) => new Date(T0.getTime() + secs * 1000);

/** A call-log row as `ctm_calls` holds it. */
function ctm(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ctm_call_id: "c1", called_at: T0, tracking_source: "Google Ads", tracking_label: "Main line", status: "answered", talk_seconds: 140,
    ring_seconds: 7, duration_seconds: 150, direction: "inbound", tags_repeat: false, tags_google_ads_conversion: true,
    caller_hash: callerHashOf("+1 (513) 555-0188", KEY), ...over,
  };
}
/** A stored web_inquiries row. */
function inq(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "w1", phone: "5135550188", submitted_at: at(155), form_name: null, email: null, first_name: "CINCINNATI OH", last_name: null,
    call_status: null, call_talk_seconds: null, call_ring_seconds: null, call_duration_seconds: null, call_direction: null,
    call_tracking_label: null, call_repeat_count: null, call_tag_repeat: null, call_tag_ads_conversion: null, ...over,
  };
}
const plan = (calls: Array<Record<string, unknown>>, rows: Array<Record<string, unknown>>) => planBackfill(readOf(calls), rows.map((r) => storedRowOf(r, KEY)));

// ── 1. The phone key ─────────────────────────────────────────────────────────
hr("1. a stored phone and a logged caller hash to the same value");
ok("the same number written four ways is one key", new Set(["+1 (513) 555-0188", "5135550188", "1-513-555-0188", "513.555.0188"].map((p) => callerHashOf(p, KEY))).size === 1);
ok("a different number is a different key", callerHashOf("5135550189", KEY) !== callerHashOf("5135550188", KEY));
ok("a stored phone with fewer than ten digits has no key, so it can match nothing", storedRowOf(inq({ phone: "555-0188" }), KEY).phoneKey === null && storedRowOf(inq({ phone: null }), KEY).phoneKey === null);
ok("the stored row carries the hash and not the number", !JSON.stringify(storedRowOf(inq(), KEY)).includes("5135550188"));

// ── 2. The window ────────────────────────────────────────────────────────────
hr("2. the window: a minute before the call starts to five minutes after it ends (our own line)");
ok("the constants are the dashboard's: 60 seconds before, 300 after, ten minutes to fold", MATCH_BEFORE_START_SECONDS === 60 && MATCH_AFTER_END_SECONDS === 300 && FOLD_WINDOW_SECONDS === 600);
const edge = (secs: number) => plan([ctm()], [inq({ submitted_at: at(secs) })]).counts;
ok("a row filed 60 seconds before the call started matches", edge(-60).matched === 1);
ok("a row filed 61 seconds before does not", edge(-61).matched === 0 && edge(-61).unmatched === 1);
ok("a row filed 300 seconds after the call ended (150s call) matches", edge(150 + 300).matched === 1);
ok("a row filed 301 seconds after does not", edge(150 + 301).matched === 0);
ok("a row of another number never matches, however close", plan([ctm()], [inq({ phone: "5135550142" })]).counts.matched === 0);

// ── 3. Eastern time ──────────────────────────────────────────────────────────
hr("3. times are instants, and the history's date is the Eastern day");
const fall = plan([ctm({ called_at: new Date("2026-11-01T05:58:00Z"), duration_seconds: 60 })], [inq({ submitted_at: new Date("2026-11-01T06:00:30Z") })]);
ok("a call across the clock change (01:58 EDT to 01:00 EST in the same hour) matches on instants, not wall time", fall.counts.matched === 1);
ok("the history date is the Eastern day: 02:30 UTC on 1 November is still 31 October in New York", easternDay(new Date("2026-11-01T02:30:00Z")) === "2026-10-31");
ok("and 05:30 UTC the same day is 1 November", easternDay(new Date("2026-11-01T05:30:00Z")) === "2026-11-01");
ok("spring: 06:30 UTC on 8 March is 1:30 AM EST, still 8 March", easternDay(new Date("2026-03-08T06:30:00Z")) === "2026-03-08");

// ── 4. What it fills, and what it leaves ─────────────────────────────────────
hr("4. fills what is blank, relabels only an unnamed row, leaves a form alone");
{
  const p = plan([ctm()], [inq()]);
  ok("a blank row is matched, relabelled `Phone: <source>` and filled", p.plans.length === 1 && p.plans[0]!.relabel === "Phone: Google Ads" && p.plans[0]!.fill.callStatus === "answered" && p.plans[0]!.fill.callTalkSeconds === 140);
  ok("the repeat count is the cluster size less one (a single call is 0, which is an answer)", p.plans[0]!.fill.callRepeatCount === 0);
  ok("the two tags are filled as answers, including `false`", p.plans[0]!.fill.callTagRepeat === false && p.plans[0]!.fill.callTagAdsConversion === true);
  const form = plan([ctm()], [inq({ form_name: "Contact us" })]);
  ok("a named form is matched and left alone (counted, no plan)", form.counts.leftAlone === 1 && form.plans.length === 0);
  const withEmail = plan([ctm()], [inq({ email: "present" })]);
  ok("a row with an email is a form: left alone", withEmail.counts.leftAlone === 1 && withEmail.plans.length === 0);
  const already = plan([ctm()], [inq({ form_name: "Phone: Google Ads", call_status: "hangup", call_talk_seconds: 3, call_ring_seconds: 1, call_duration_seconds: 9, call_direction: "inbound", call_tracking_label: "x", call_repeat_count: 2, call_tag_repeat: true, call_tag_ads_conversion: false })]);
  ok("a value already on a row is never replaced: nothing to do", already.plans.length === 0 && already.counts.alreadyDescribed === 1);
  const partial = plan([ctm()], [inq({ form_name: "Phone: Google Ads", call_status: "hangup" })]);
  ok("a half-described call keeps what it has and gains only what it lacks", partial.plans[0]!.fill.callStatus === undefined && partial.plans[0]!.fill.callTalkSeconds === 140);
  ok("a row with no form name is named only if the caller-ID text test says so about its name", isCallerIdText("CINCINNATI OH") && !isCallerIdText("Laura Duncan"));
  ok("rowKind: a `Phone:` name is a call, an empty one with no email is unnamed, anything else is left alone", rowKind(storedRowOf(inq({ form_name: "Phone: x" }), KEY)) === "call" && rowKind(storedRowOf(inq(), KEY)) === "unnamed" && rowKind(storedRowOf(inq({ form_name: "Quote" }), KEY)) === "left_alone");
}

// ── 5. Folding and ambiguity ─────────────────────────────────────────────────
hr("5. calls fold the way the webhook folds them; ambiguity is left alone");
{
  const two = [ctm({ ctm_call_id: "a", status: "no_answer", talk_seconds: null, duration_seconds: 30 }), ctm({ ctm_call_id: "b", called_at: at(120), status: "answered", talk_seconds: 200, duration_seconds: 220 })];
  const p = plan(two, [inq({ submitted_at: at(40) })]);
  ok("two calls from one number inside ten minutes are one cluster and one row", clusterCalls(readOf(two).calls).length === 1 && p.counts.matched === 1 && p.counts.foldedCalls === 1);
  ok("the answered attempt describes the row, and the repeat count is one", p.plans[0]!.fill.callStatus === "answered" && p.plans[0]!.fill.callTalkSeconds === 200 && p.plans[0]!.fill.callRepeatCount === 1);
  ok("two calls more than ten minutes apart are two clusters", clusterCalls(readOf([ctm(), ctm({ ctm_call_id: "z", called_at: at(2000) })]).calls).length === 2);
  const amb = plan([ctm()], [inq(), inq({ id: "w2", submitted_at: at(160) })]);
  ok("two rows for one call: ambiguous, nothing planned", amb.counts.ambiguous === 1 && amb.plans.length === 0);
  const wanted = plan([ctm({ duration_seconds: 1000 }), ctm({ ctm_call_id: "z", called_at: at(1230), duration_seconds: 400 })], [inq({ submitted_at: at(1250) })]);
  ok("one row wanted by two clusters is ambiguous for both and nothing is planned", wanted.counts.clusters === 2 && wanted.counts.ambiguous === 2 && wanted.counts.matched === 0 && wanted.plans.length === 0, JSON.stringify(wanted.counts));
  const none = plan([ctm({ caller_hash: null })], [inq()]);
  ok("a call with no caller is counted as having no usable number and matches nothing", none.counts.noNumber === 1 && none.counts.matched === 0);
}

// ── 6. The report prints counts only ────────────────────────────────────────
hr("6. the report is counts only");
{
  const p = plan([ctm()], [inq({ first_name: "LAURA DUNCAN" })]);
  const text = backfillReportLines(p.counts, false).join("\n");
  ok("it names matched, relabel, fill, ambiguous and unmatched", /matched to a stored row: 1/.test(text) && /relabel as a call: 1/.test(text) && /ambiguous/.test(text) && /unmatched/.test(text));
  ok("it prints no phone number, no name, no caller-ID text, no hash", !/\d{7,}/.test(text) && !/LAURA|DUNCAN|CINCINNATI/.test(text) && !text.includes(callerHashOf("5135550188", KEY)!));
  selfTest("the report holds no run of seven digits", (t) => !/\d{7,}/.test(t), "matched to a stored row: 12", "call 5135550188");
}

// ── 7. The statements ────────────────────────────────────────────────────────
hr("7. the statements: what they select, what they write");
{
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "ctm", "call-backfill.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok("the stored-row select names its columns and never raw_json, a message or a note", !/raw_json|message|notes|transcript|recording/i.test(SELECT_INQUIRIES) && /SELECT id, phone/.test(SELECT_INQUIRIES) && !/SELECT \*/i.test(SELECT_INQUIRIES + SELECT_CTM_CALLS));
  ok("the email is reduced to present-or-not in SQL, never selected as an address", /CASE WHEN btrim\(coalesce\(email, ''\)\) = '' THEN NULL ELSE 'present' END AS email/.test(SELECT_INQUIRIES));
  ok("the call-log select leaves out the city, the click id and the campaign: nothing here needs them", !/city|state,|gclid|utm_/.test(SELECT_CTM_CALLS));
  ok("the update sets only the form name and the nine call columns, and fills with COALESCE", /SET\s+form_name = CASE/.test(UPDATE_INQUIRY) && (UPDATE_INQUIRY.match(/COALESCE\(/g) ?? []).length === 9 && !/\b(first_name|last_name|email|phone|raw_json|submitted_at|dob|gclid)\s*=/.test(UPDATE_INQUIRY.replace(/coalesce\(email[^)]*\)/g, "")));
  ok("the relabel is guarded inside the statement: the name blank AND no email", /coalesce\(form_name, ''\) = '' AND coalesce\(email, ''\) = ''/.test(UPDATE_INQUIRY));
  ok("the update is scoped to the client's slug", /WHERE id = \$1 AND client_slug = \$2/.test(UPDATE_INQUIRY));
  ok("the history line is internal, with no client summary", /'reporting'/.test(INSERT_HISTORY) && /NULL, \$4, false/.test(INSERT_HISTORY));
  ok("nothing in the module deletes or inserts into web_inquiries", !/DELETE\s+FROM|INSERT\s+INTO\s+web_inquiries/i.test(src));
  ok("the module imports no HTTP client and calls no third party", !/node:https?|\bfetch\(|from "\.\.\/page-behaviour\/http/.test(src));
  selfTest("the update touches no identifying column", (t) => !/\b(first_name|last_name|phone|raw_json)\s*=/.test(t), "SET call_status = COALESCE(call_status, $1)", "SET first_name = $1");
  ok("the history titles say what was done", /corrected/i.test(BACKFILL_HISTORY_TITLE) && /details/i.test(DAILY_HISTORY_TITLE));
  ok("exportCallOf drops a call with no hash", exportCallOf(ctm({ caller_hash: null })) === null);
}

// ── 7b. The workflow and the daily hook ──────────────────────────────────────
hr("7b. the workflow is dry by default, per client, and holds only the secrets it needs");
{
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const wf = fs.readFileSync(path.join(root, ".github/workflows/backfill-calls-from-ctm.yml"), "utf8");
  const code = wf.replace(/^\s*#.*$/gm, "");
  const secrets = Array.from(code.matchAll(/secrets\.([A-Z0-9_]+)/g)).map((m) => m[1]!).sort().join(",");
  ok("it passes exactly the database and the hash key, and no CallTrackingMetrics access key", secrets === "CTM_CALLER_HASH_KEY,DATABASE_URL", secrets);
  ok("it is dispatch-only (no schedule) and takes a required client", /workflow_dispatch:/.test(code) && !/schedule:/.test(code) && /client:\s*\n\s*description:[^\n]*\n\s*required: true/.test(code));
  ok("dry_run defaults to true", /dry_run:\s*\n\s*description:[^\n]*\n\s*required: false\s*\n\s*default: "true"/.test(code));
  ok("only a dry_run that is not exactly true applies", /\[ "\$DRY_RUN" != "true" \] && ARGS="\$ARGS --apply"/.test(code));
  ok("inputs reach the shell through environment variables, never interpolated into the command", !code.slice(code.lastIndexOf("run: |")).includes("${{") && /CLIENT: \$\{\{ inputs\.client \}\}/.test(code));
  ok("it has no heartbeat step (it is an act somebody performs)", !/heartbeat/i.test(code));
  ok("it sets no pretend-server seam", !/SIGNALS_FAKE_BASE/.test(code));
  ok("the person who pressed it is the name on the history line", /RUN_BY: \$\{\{ github\.actor \}\}/.test(code));
  const reader = fs.readFileSync(path.join(root, "src/read-ctm.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok("the daily reader runs the fill (never the relabelling correction) after it writes the log", /runDailyFill\(/.test(reader) && !/runBackfill\(/.test(reader) && /await fillRecentCalls\(c, m, slug, hashKey, res\.run\.status, now, dryRun\)/.test(reader));
  ok("a fill failure cannot fail the read: it is caught and printed", /catch \(e\) \{\s*console\.log\(`  calls: stored calls were not filled/.test(reader));
  selfTest("the secrets check refuses a workflow that adds the access keys", (t) => Array.from(t.matchAll(/secrets\.([A-Z0-9_]+)/g)).map((m) => m[1]!).sort().join(",") === "CTM_CALLER_HASH_KEY,DATABASE_URL", "${{ secrets.DATABASE_URL }} ${{ secrets.CTM_CALLER_HASH_KEY }}", "${{ secrets.DATABASE_URL }} ${{ secrets.CTM_CALLER_HASH_KEY }} ${{ secrets.CTM_ACCOUNT_KEYS_JSON }}");
}

// ── 8. The real SQL, on a throwaway schema ───────────────────────────────────
const dbUrl = process.env.ADS_VERIFY_DATABASE_URL;
if (!dbUrl) {
  hr("8. the real statements");
  console.log("  ⏭  skipped: ADS_VERIFY_DATABASE_URL is not set. Locally: `node scripts/test-db.mjs start` in the dashboard repo prints a URL.");
  console.log("     CI runs this section in the `ads-store` job against a Postgres service container.");
} else {
  await dbSection(dbUrl);
}

async function dbSection(url: string) {
  hr("8. the real statements, on a throwaway schema");
  const schema = `call_backfill_${Math.random().toString(36).slice(2, 10)}`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const db = c as unknown as Pg;
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await c.query(`
      CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE ctm_calls (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, ctm_call_id TEXT NOT NULL, called_at TIMESTAMPTZ NOT NULL, tracking_source TEXT, tracking_label TEXT,
        status TEXT, talk_seconds INT, ring_seconds INT, duration_seconds INT, direction TEXT, city TEXT, state TEXT, gclid TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
        device TEXT, tags_google_ads_conversion BOOLEAN, tags_repeat BOOLEAN, caller_hash TEXT, read_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE web_inquiries (id TEXT PRIMARY KEY, client_slug TEXT NOT NULL, first_name TEXT, last_name TEXT, email TEXT, phone TEXT, form_name TEXT, raw_json TEXT,
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(), call_status TEXT, call_direction TEXT, call_talk_seconds INT, call_ring_seconds INT, call_duration_seconds INT,
        call_tracking_label TEXT, call_repeat_count INT, call_folded_ids TEXT, call_tag_repeat BOOLEAN, call_tag_ads_conversion BOOLEAN);
      CREATE TABLE client_activity_log (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other', title TEXT NOT NULL, client_summary TEXT,
        internal_detail TEXT, visible_to_client BOOLEAN NOT NULL DEFAULT true, occurred_at TEXT NOT NULL, occurred_end_at TEXT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    `);
    await c.query(`INSERT INTO clients VALUES ('A', 'Hillside Roofing'), ('B', 'Other Client')`);
    let n = 0;
    const addCall = async (client: string, over: Record<string, unknown> = {}) => {
      const r = ctm(over);
      await c.query(`INSERT INTO ctm_calls (id, client_id, ctm_call_id, called_at, tracking_source, tracking_label, status, talk_seconds, ring_seconds, duration_seconds, direction, tags_repeat, tags_google_ads_conversion, caller_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [`x${++n}`, client, String(r.ctm_call_id), r.called_at, r.tracking_source, r.tracking_label, r.status, r.talk_seconds, r.ring_seconds, r.duration_seconds, r.direction, r.tags_repeat, r.tags_google_ads_conversion, r.caller_hash]);
    };
    const addRow = async (slug: string, over: Record<string, unknown> = {}) => {
      const r = inq(over);
      await c.query(`INSERT INTO web_inquiries (id, client_slug, first_name, last_name, email, phone, form_name, submitted_at, call_status, call_talk_seconds, call_repeat_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [r.id, slug, r.first_name, r.last_name, r.email === "present" ? "a@example.test" : null, r.phone, r.form_name, r.submitted_at, r.call_status, r.call_talk_seconds, r.call_repeat_count]);
    };
    const snap = async () => JSON.stringify((await c.query(`SELECT * FROM web_inquiries ORDER BY id`)).rows) + JSON.stringify((await c.query(`SELECT id FROM client_activity_log`)).rows);

    // client A: an unnamed row (to relabel), a form with an email (left alone), an already-labelled call missing its status,
    // an ambiguous pair, and an unmatched call. Client B has an identical-looking call and row that must never be touched.
    await addCall("A", { ctm_call_id: "u1" });
    await addRow("hillside-roofing", { id: "unnamed" });
    await addCall("A", { ctm_call_id: "f1", caller_hash: callerHashOf("5135550142", KEY), called_at: at(3600) });
    await addRow("hillside-roofing", { id: "form", phone: "(513) 555-0142", email: "present", form_name: "Contact", submitted_at: at(3600 + 155) });
    await addCall("A", { ctm_call_id: "l1", caller_hash: callerHashOf("5135550143", KEY), called_at: at(7200) });
    await addRow("hillside-roofing", { id: "labelled", phone: "5135550143", form_name: "Phone: Google Ads", submitted_at: at(7200 + 155), call_status: "hangup" });
    await addCall("A", { ctm_call_id: "m1", caller_hash: callerHashOf("5135550144", KEY), called_at: at(10800) });
    await addRow("hillside-roofing", { id: "amb1", phone: "5135550144", submitted_at: at(10800 + 100) });
    await addRow("hillside-roofing", { id: "amb2", phone: "5135550144", submitted_at: at(10800 + 110) });
    await addCall("A", { ctm_call_id: "n1", caller_hash: callerHashOf("5135550145", KEY), called_at: at(14400) });
    await addCall("B", { ctm_call_id: "b1" });
    await addRow("other-client", { id: "b-unnamed" });

    const before = await snap();
    const dry = await runBackfill(db, { clientId: "A", slug: "hillside-roofing", hashKey: KEY, apply: false, by: "t", now: T0, newId: randomUUID });
    ok("a dry run writes nothing at all", (await snap()) === before);
    ok("the dry run counts: 3 matched of 5 calls, 1 would relabel, 1 unmatched, 1 ambiguous, 1 form left alone", !!dry.counts && dry.counts.clusters === 5 && dry.counts.matched === 3 && dry.counts.wouldRelabel === 1 && dry.counts.unmatched === 1 && dry.counts.ambiguous === 1 && dry.counts.leftAlone === 1, JSON.stringify({ c: dry.counts?.clusters, m: dry.counts?.matched, r: dry.counts?.wouldRelabel, u: dry.counts?.unmatched, a: dry.counts?.ambiguous, l: dry.counts?.leftAlone }));
    ok("the dry run's lines hold no digits run and no name", !/\d{7,}|LAURA|CINCINNATI/.test(dry.lines.join("\n")));

    const applied = await runBackfill(db, { clientId: "A", slug: "hillside-roofing", hashKey: KEY, apply: true, by: "Pat Example", now: new Date("2026-11-01T02:30:00Z"), newId: randomUUID });
    const rows = Object.fromEntries((await c.query(`SELECT * FROM web_inquiries`)).rows.map((r) => [r.id, r]));
    ok("the unnamed row is now `Phone: Google Ads` with its details", rows.unnamed.form_name === "Phone: Google Ads" && rows.unnamed.call_status === "answered" && rows.unnamed.call_talk_seconds === 140 && rows.unnamed.call_repeat_count === 0 && rows.unnamed.call_tag_ads_conversion === true && rows.unnamed.call_direction === "inbound");
    ok("the form with an email is untouched", rows.form.form_name === "Contact" && rows.form.call_status === null);
    ok("the labelled call keeps its own status and gains the rest", rows.labelled.call_status === "hangup" && rows.labelled.call_talk_seconds === 140 && rows.labelled.form_name === "Phone: Google Ads");
    ok("an ambiguous pair is left alone", rows.amb1.form_name === null && rows.amb2.form_name === null && rows.amb1.call_status === null);
    ok("another client's identical-looking row is never touched", rows["b-unnamed"].form_name === null && rows["b-unnamed"].call_status === null);
    ok("rows written equals the plan", applied.written === 2, String(applied.written));
    const hist = (await c.query(`SELECT * FROM client_activity_log`)).rows;
    ok("exactly one internal history line, counts only, dated the Eastern day", hist.length === 1 && hist[0]!.visible_to_client === false && hist[0]!.client_summary === null && hist[0]!.category === "reporting" && hist[0]!.occurred_at === "2026-10-31" && hist[0]!.created_by === "Pat Example");
    ok("the line holds no phone, name or hash", !/\d{7,}/.test(String(hist[0]!.internal_detail)) && !String(hist[0]!.internal_detail).includes(callerHashOf("5135550188", KEY)!));
    const after = await snap();
    const again = await runBackfill(db, { clientId: "A", slug: "hillside-roofing", hashKey: KEY, apply: true, by: "Pat Example", now: T0, newId: randomUUID });
    ok("a second run changes nothing and adds no line", again.written === 0 && (await snap()) === after);

    // the guard inside the statement: a row that gained an email between the read and the write is not relabelled
    await addCall("A", { ctm_call_id: "g1", caller_hash: callerHashOf("5135550150", KEY), called_at: at(20000) });
    await addRow("hillside-roofing", { id: "late", phone: "5135550150", submitted_at: at(20000 + 155) });
    const p = await (await import("./ctm/call-backfill.js")).planFromDb(db, { clientId: "A", slug: "hillside-roofing" }, KEY, null);
    ok("the new row is planned for a relabel", p.plans.some((x) => x.rowId === "late" && x.relabel != null));
    await c.query(`UPDATE web_inquiries SET email = 'x@example.test' WHERE id = 'late'`);
    await applyPlans(db, "hillside-roofing", p.plans.filter((x) => x.rowId === "late"));
    const late = (await c.query(`SELECT form_name, call_status FROM web_inquiries WHERE id = 'late'`)).rows[0]!;
    ok("a row that became a form between the read and the write is not relabelled (it may still be filled)", late.form_name === null);

    // the daily fill: fills blanks on rows that are already calls, never relabels
    await c.query(`DELETE FROM web_inquiries WHERE id IN ('late')`);
    const now = new Date("2026-10-20T12:00:00Z");
    await addCall("A", { ctm_call_id: "d1", caller_hash: callerHashOf("5135550160", KEY), called_at: new Date("2026-10-19T15:00:00Z") });
    await addRow("hillside-roofing", { id: "daily-call", phone: "5135550160", form_name: "Phone: CallTrackingMetrics", submitted_at: new Date("2026-10-19T15:02:40Z") });
    await addCall("A", { ctm_call_id: "d2", caller_hash: callerHashOf("5135550161", KEY), called_at: new Date("2026-10-19T16:00:00Z") });
    await addRow("hillside-roofing", { id: "daily-unnamed", phone: "5135550161", submitted_at: new Date("2026-10-19T16:02:40Z") });
    const dayBefore = await snap();
    const dryDaily = await runDailyFill(db, { clientId: "A", slug: "hillside-roofing", hashKey: KEY, apply: false, now, newId: randomUUID });
    ok("a dry daily fill writes nothing and says what it would do", (await snap()) === dayBefore && dryDaily.rows === 1 && dryDaily.leftForBackfill === 1, JSON.stringify(dryDaily));
    const daily = await runDailyFill(db, { clientId: "A", slug: "hillside-roofing", hashKey: KEY, apply: true, now, newId: randomUUID });
    const d = Object.fromEntries((await c.query(`SELECT * FROM web_inquiries WHERE id IN ('daily-call','daily-unnamed')`)).rows.map((r) => [r.id, r]));
    ok("the daily fill describes a call that was missing its details", d["daily-call"].call_status === "answered" && d["daily-call"].call_talk_seconds === 140 && daily.written === 1);
    ok("the daily fill never relabels: an unnamed row waits for the correction", d["daily-unnamed"].form_name === null && d["daily-unnamed"].call_status === null);
    const hist2 = (await c.query(`SELECT * FROM client_activity_log WHERE title = $1`, [DAILY_HISTORY_TITLE])).rows;
    ok("it adds one internal line, and only because it wrote something", hist2.length === 1 && hist2[0]!.visible_to_client === false);
    const dailyAgain = await runDailyFill(db, { clientId: "A", slug: "hillside-roofing", hashKey: KEY, apply: true, now, newId: randomUUID });
    ok("a second daily fill writes nothing and adds no line", dailyAgain.written === 0 && (await c.query(`SELECT 1 FROM client_activity_log WHERE title = $1`, [DAILY_HISTORY_TITLE])).rowCount === 1);
    ok("a client with no logged calls has nothing to match and says to read the log first", (await runBackfill(db, { clientId: "Z", slug: "nobody", hashKey: KEY, apply: false, by: "t", now, newId: randomUUID })).lines[0]!.includes("Read it first"));
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
}

console.log("\n" + "─".repeat(72));
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");

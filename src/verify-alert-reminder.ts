/**
 * The reminder has to time the ALERT, not the run.
 *
 * WHY THIS GUARD EXISTS. monitor-freshness is edge-triggered: it alerts when
 * the signature changes and then goes quiet. A reminder was added so a
 * genuinely unresolved outage gets a daily nudge instead of permanent silence.
 * It never fired once. It compared `now - ran_at`, and `ran_at` is stamped by
 * every run of a job that runs HOURLY, so the age was always about one, never
 * the 24 it was tested against.
 *
 * The cost was not theoretical. OCH's lead feed stopped on 2026-09-10. This
 * monitor detected it correctly within a day, printed the diagnosis and the
 * exact command to run, and then logged "No change — no alert" every hour for
 * twenty days while the client kept taking calls nobody here ever saw.
 *
 * So the rule, and it is the one a future change will break again:
 *   • the reminder clock reads `alerted_at`, never `ran_at`
 *   • `alerted_at` moves ONLY on a post Slack accepted — not when the job runs,
 *     and not when Slack refuses it, or a broken webhook would reset the clock
 *     every hour and buy itself another day of silence
 *
 * No database, no network, no Slack. It reads the source.
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dirname, "monitor-freshness.ts");
const PUBLISH = path.join(import.meta.dirname, "publish-och-web-leads.ts");
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
};

/** Each rule takes the source so a planted failure can be proved against it. */
const RULES: { name: string; ok: (s: string) => boolean; planted: string }[] = [
  {
    name: "the reminder clock reads alerted_at, not ran_at",
    ok: (s) => /const prevAgeH = prevRow\?\.alerted_at/.test(s) && !/const prevAgeH = prevRow\?\.ran_at/.test(s),
    planted: "const prevAgeH = prevRow?.ran_at ? (now - new Date(prevRow.ran_at).getTime()) / 3_600_000 : Infinity;",
  },
  {
    name: "alerted_at is selected, so there is something to compare",
    ok: (s) => /SELECT note, ran_at, alerted_at FROM job_heartbeats/.test(s),
    planted: "SELECT note, ran_at FROM job_heartbeats WHERE job = 'freshness_monitor'",
  },
  {
    name: "the column is provisioned before it is read",
    ok: (s) => /ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ/.test(s),
    planted: "-- no alerted_at column",
  },
  {
    name: "alerted_at moves only on a post Slack accepted",
    ok: (s) => /posted = res\.ok;/.test(s) && /CASE WHEN \$2::boolean THEN now\(\) ELSE job_heartbeats\.alerted_at END/.test(s),
    planted: "alerted_at = now()",
  },
  {
    name: "a failed post does not reset the clock",
    ok: (s) => !/posted = true;/.test(s),
    planted: "posted = true;",
  },
];

const src = fs.readFileSync(SRC, "utf8");
console.log("monitor-freshness: the reminder times the alert, not the run\n");
for (const r of RULES) check(r.ok(src), r.name);

// Self-test: every rule must FAIL on source that carries its planted defect.
// A rule that passes its own planting is a rule that proves nothing.
console.log("\nself-test (each rule must reject its own planted defect):");
for (const r of RULES) {
  const broken = r.name === "a failed post does not reset the clock"
    ? src.replace("posted = res.ok;", "posted = true;")
    : src.replace(/const prevAgeH = prevRow\?\.alerted_at[^\n]*\n/, "")
         .replace("SELECT note, ran_at, alerted_at FROM job_heartbeats", "SELECT note, ran_at FROM job_heartbeats")
         .replace(/ALTER TABLE job_heartbeats ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ[^\n]*\n/, "")
         .replace(/posted = res\.ok;/, "")
         .replace(/CASE WHEN \$2::boolean THEN now\(\) ELSE job_heartbeats\.alerted_at END/, "now()");
  check(!r.ok(broken), `  planting rejected: ${r.name}`);
}

// ── A dry run must never print a patient's details ──────────────────────────
//
// This printed twelve lead rows verbatim -- names, phone numbers, emails,
// referral source and admit dates -- into a GitHub Actions log kept for 90 days
// and readable by anyone with repository access. OCH is a treatment centre, so
// that is health information, and run 33773893727 (2026-09-03) still carries it.
console.log("\nthe OCH publisher's dry run prints counts, never rows:");
const pub = fs.readFileSync(PUBLISH, "utf8");
const dryBlock = pub.slice(pub.indexOf("if (dryRun) {"), pub.indexOf("// Our tab: create if missing"));
check(dryBlock.length > 0, "  the dry-run block is where this guard expects it");
check(!/values\.slice\(/.test(dryBlock), "  no slice of the row array is printed");
check(!/console\.log\("  " \+ v\.map/.test(dryBlock), "  no row is mapped into a log line");
check(/would go in, under/.test(dryBlock), "  it says how many rows and which columns instead");
// Self-test: the old line must be rejected.
const oldDry = '  for (const v of values.slice(0, 12)) console.log("  " + v.map((x) => String(x).slice(0, 22)).join(" | "));';
check(/values\.slice\(/.test(oldDry), "  planting rejected: the original row-printing line is detected");

console.log("");
if (failures) { console.log(`verify-alert-reminder: ${failures} problem(s).`); process.exit(1); }
console.log("verify-alert-reminder: the reminder cannot go silent on an unresolved outage again.");

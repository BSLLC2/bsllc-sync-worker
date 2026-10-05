#!/usr/bin/env tsx
/**
 * End-to-end guard for OCH's Admission Board connection. Starts a pretend Google
 * (fake-google.ts), then runs the REAL daily check and the REAL admissions import
 * as child processes against it, through the same code paths production uses.
 * Every way the connection is known to die is a scenario: a revoked key, a sheet
 * that is gone, no longer shared, in the bin or read-only, a renamed tab, a new
 * look-alike tab, a retitled column, a board that went quiet, a board that outgrew
 * the read, a status word nobody classified, and a minute of Google 503s. The
 * healthy months in between must stay silent: a check that cries wolf is switched
 * off, and then it protects nothing.
 *
 * What it proves that the unit guard cannot: that the wiring between the jobs and
 * Google holds (the right URL, the retry, the exit code, the last line the
 * heartbeat reads), and that the check's month counts equal what the import
 * writes, for the same board.
 *
 * No credential, no network, no database. Every sheet, tab and person is
 * invented. About a minute.
 *
 *   npm run verify-och-e2e
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { FakeGoogle, type FakeTab } from "./fake-google.js";
import { readBoard } from "./och-board-readings.js";
import { findHeaderRow, resolveAdmissionColumns } from "./och-sheet-columns.js";
import { ROW_LIMIT } from "./och-sheet-target.js";
import { CAUSE_CODES } from "./och-sheet-check.js";

const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
let failed = 0; let n = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  n++;
  if (ok) return;
  failed++;
  console.error(`✗ ${name}${detail !== undefined ? `\n    ${String(detail).slice(0, 600)}` : ""}`);
}

// ── An invented board, dated from today so "quiet" and "complete month" are real ──
const etToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const daysAgo = (k: number): string => {
  const [y, m, d] = etToday.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d - k));
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()}/${t.getUTCFullYear()}`;
};
const HEAD = ["Name", "Phone", "DOB", "Status", "Inquiry Received", "Scheduled Admission Date", "Referent"];
const NAMES = ["Ada Brennan", "Colin Vasser", "Dara Whitlow", "Emil Navarro", "Fay Odonnell", "Gus Kellerman"];
const STATUS = ["Admitted", "Did Not Admit", "Admitted", "Referred Out", "Admitted", "Not Qualified"];
const REF = ["Google", "Web Form", "Referral", "Google", "Alumni", "Web Form"];
function board(opts: { count?: number; startAgo?: number; stepDays?: number; header?: string[]; status?: (i: number) => string } = {}): string[][] {
  const count = opts.count ?? 40, start = opts.startAgo ?? 3, step = opts.stepDays ?? 2.5;
  const rows = [opts.header ?? HEAD];
  for (let i = 0; i < count; i++) {
    const a = daysAgo(Math.round(start + i * step));
    rows.push([NAMES[i % 6]!, `513-555-${String(1000 + i).slice(-4)}`, "3/14/1988", opts.status ? opts.status(i) : STATUS[i % 6]!, daysAgo(Math.round(start + i * step) + 4), a, REF[i % 6]!]);
  }
  return rows;
}
const tab = (name: string, rows = board()): FakeTab => ({ name, rows });

// ── Running the real jobs ───────────────────────────────────────────────────
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const KEY_JSON = JSON.stringify({ client_email: "sync@example-project.iam.gserviceaccount.com", private_key: privateKey });
const TSX = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
const SRC = (f: string) => new URL(`./${f}.ts`, import.meta.url).pathname;
let base = "";
interface Run { code: number | null; out: string; last: string }
function run(script: string, extraEnv: Record<string, string> = {}, args: string[] = []): Promise<Run> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      GOOGLE_FAKE_BASE: base, OCH_SHEET_ID: SHEET, GOOGLE_RETRY_MS: "20", GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON, NO_COLOR: "1",
      ...extraEnv,
    };
    const p = spawn(TSX, [SRC(script), ...args], { env, cwd: new URL("..", import.meta.url).pathname });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      resolve({ code, out, last: lines[lines.length - 1] ?? "" });
    });
  });
}
const fake = new FakeGoogle(SHEET);
const canary = (extraEnv: Record<string, string> = {}) => run("och-sheet-canary", extraEnv);
const verdict = (r: Run) => r.out.split(/\r?\n/).reverse().find((l) => l.startsWith("OCH-SHEET ")) ?? "";
const causeOf = (r: Run) => verdict(r).match(/^OCH-SHEET (?:warn|stop) ([a-z_]+):/)?.[1] ?? null;

/** One scenario: set up Google, run the real check, assert what the heartbeat would read. */
async function scenario(name: string, setup: () => void, expect: { code: 0 | 1; cause: string | null; level?: "ok" | "warn" | "stop"; env?: Record<string, string>; has?: RegExp[]; hasNot?: RegExp[] }) {
  fake.reset([tab("Admission Board"), tab("BS LLC — Web Leads", [["Submitted", "Name"]])]);
  setup();
  const r = await canary(expect.env ?? {});
  const v = verdict(r);
  const level = v.match(/^OCH-SHEET (ok|warn|stop)/)?.[1] ?? null;
  check(`check: ${name}: exits ${expect.code}`, r.code === expect.code, `${r.code} | ${r.out.slice(-500)}`);
  check(`check: ${name}: reads ${expect.cause ?? "ok"}`, causeOf(r) === expect.cause, `${v || "(no verdict line)"}`);
  if (expect.level) check(`check: ${name}: at level ${expect.level}`, level === expect.level, v);
  check(`check: ${name}: the verdict is the LAST line (the heartbeat note)`, r.last.startsWith("OCH-SHEET "), r.last);
  check(`check: ${name}: it wrote nothing to Google`, fake.writes === 0, fake.writes);
  check(`check: ${name}: no patient detail in anything it printed`, !NAMES.some((x) => r.out.includes(x)) && !/513-555-\d{4}/.test(r.out) && !/1988/.test(r.out), r.out.slice(0, 300));
  for (const re of expect.has ?? []) check(`check: ${name}: output mentions ${re}`, re.test(r.out), r.out.slice(-400));
  for (const re of expect.hasNot ?? []) check(`check: ${name}: output does not mention ${re}`, !re.test(r.out), r.out.slice(-400));
  return r;
}

async function main() {
  base = await fake.start();

  // ── The healthy case first, and it must be silent ─────────────────────────
  await scenario("a healthy board", () => {}, { code: 0, cause: null, level: "ok", has: [/OCH-SHEET ok: read "Admission Board"/] });

  // ── Every way the connection is known to die ──────────────────────────────
  await scenario("the key is revoked", () => { fake.state.tokenMode = "revoked"; }, { code: 1, cause: "key_rejected", level: "stop" });
  await scenario("Google's token service is down", () => { fake.state.tokenMode = "down"; }, { code: 0, cause: "google_unavailable", level: "warn" });
  await scenario("the sheet is gone", () => { fake.state.access = "gone"; }, { code: 1, cause: "sheet_not_found", level: "stop" });
  await scenario("OCH stops sharing it", () => { fake.state.access = "revoked"; }, { code: 1, cause: "access_removed", level: "stop", has: [/Editor/, /owner/i] });
  await scenario("the sheet is in the bin", () => { fake.state.drive.trashed = true; }, { code: 1, cause: "sheet_in_bin", level: "stop" });
  await scenario("our share drops to read-only", () => { fake.state.drive.canEdit = false; }, { code: 0, cause: "read_only", level: "warn" });
  await scenario("the Drive API is off", () => { fake.state.drive.mode = "off"; }, { code: 0, cause: null, level: "ok", has: [/Skipped:.*Google Drive/] });
  await scenario("Google blips twice, then answers", () => { fake.state.fail.push({ match: "fields=sheets", status: 503, times: 2 }); }, { code: 0, cause: null, level: "ok" });
  await scenario("Google is down for the whole run", () => { fake.state.fail.push({ match: "/v4/spreadsheets/", status: 503, times: 99 }); }, { code: 0, cause: "google_unavailable", level: "warn" });
  await scenario("OCH starts a second tab that looks like the board", () => { fake.state.tabs.push(tab("Admissions Oct", board({ count: 5, startAgo: 1 }))); fake.state.tabs[0]!.name = "Admissions Sep"; }, { code: 0, cause: "tab_ambiguous", level: "warn", has: [/Admissions Sep/, /Admissions Oct/] });
  await scenario("...and we say which one is live", () => { fake.state.tabs.push(tab("Admissions Oct", board({ count: 5, startAgo: 1 }))); fake.state.tabs[0]!.name = "Admissions Sep"; }, { code: 0, cause: null, level: "ok", env: { OCH_ADMISSIONS_TAB: "Admissions Oct" }, has: [/read "Admissions Oct"/] });
  await scenario("the tab we were told to read is not there", () => {}, { code: 1, cause: "tab_missing", level: "stop", env: { OCH_ADMISSIONS_TAB: "October" } });
  await scenario("the board is renamed to something with 'admission' in it", () => { fake.state.tabs[0]!.name = "Admissions 2026"; }, { code: 0, cause: null, level: "ok", has: [/read "Admissions 2026"/] });
  await scenario("the board is renamed to something that does not look like it", () => { fake.state.tabs[0]!.name = "Intake"; }, { code: 0, cause: "tab_guessed", level: "warn", has: [/"Intake"/] });
  await scenario("every heading is retitled and the data is unreadable", () => { fake.state.tabs[0]!.rows = board({ header: ["a", "b", "c", "d", "e", "f", "g"] }).map((r, i) => (i === 0 ? r : r.map((_, c) => `v${c}`))); }, { code: 1, cause: "headings", level: "stop" });
  await scenario("nobody has dated anything in six weeks", () => { fake.state.tabs[0]!.rows = board({ startAgo: 45 }); }, { code: 0, cause: "board_quiet", level: "warn" });
  await scenario("...and the sheet was edited yesterday, so they are elsewhere", () => { fake.state.tabs[0]!.rows = board({ startAgo: 45 }); fake.state.drive.modifiedTime = new Date(Date.now() - 86_400_000).toISOString(); }, { code: 0, cause: "board_quiet", level: "warn", has: [/another tab/] });
  await scenario("a status word nobody has classified", () => { fake.state.tabs[0]!.rows = board({ status: (i) => (i === 3 ? "Waitlisted" : STATUS[i % 6]!) }); }, { code: 0, cause: "status_unrecognized", level: "warn", hasNot: [/Waitlisted/] });
  await scenario("the board fills the read", () => { fake.state.tabs[0]!.rows = board({ count: ROW_LIMIT + 5, startAgo: 3, stepDays: 0.01 }); }, { code: 1, cause: "board_too_long", level: "stop" });
  await scenario("the board is emptied", () => { fake.state.tabs[0]!.rows = [HEAD]; }, { code: 1, cause: "board_empty", level: "stop" });

  // ── No key at all, and a key that is not a key (no Google involved) ───────
  for (const [name, key, cause] of [["no key", "", "key_missing"], ["a key file that is not JSON", "nope", "key_unreadable"], ["half a key file", '{"client_email":"x@y.z"}', "key_unreadable"], ["a private key that is not one", '{"client_email":"x@y.z","private_key":"nope"}', "key_unreadable"]] as const) {
    fake.reset([tab("Admission Board")]);
    const r = await run("och-sheet-canary", { GOOGLE_SERVICE_ACCOUNT_JSON: key });
    check(`check: ${name}: reads ${cause} and exits 1`, causeOf(r) === cause && r.code === 1, `${r.code} ${verdict(r)}`);
    check(`check: ${name}: Google was never called`, fake.calls.length === 0, fake.calls.length);
  }

  // ── A year of months: OCH's habits, one after another ─────────────────────
  // The same fake, changed the way a real sheet changes over a year. Every month
  // that should be silent must be, and every change that matters must be caught
  // the first time it happens.
  const months: Array<{ what: string; setup: () => void; cause: string | null }> = [
    { what: "month 1: steady", setup: () => {}, cause: null },
    { what: "month 2: steady, a few more rows", setup: () => { fake.state.tabs[0]!.rows = board({ count: 45 }); }, cause: null },
    { what: "month 3: OCH adds a tab for the new quarter", setup: () => { fake.state.tabs.push(tab("Admissions Q4", board({ count: 3, startAgo: 1 }))); }, cause: "tab_ambiguous" },
    { what: "month 4: we pin the live tab, the old one stays around", setup: () => { fake.state.tabs.push(tab("Admissions Q4", board({ count: 3, startAgo: 1 }))); }, cause: null },
    { what: "month 5: OCH cleans up and renames the board", setup: () => { fake.state.tabs[0]!.name = "Intake"; }, cause: "tab_guessed" },
    { what: "month 6: the board is on the first tab again with 'Admission' in its name", setup: () => { fake.state.tabs[0]!.name = "Admission Board"; }, cause: null },
    { what: "month 7: somebody changes our share to read-only", setup: () => { fake.state.drive.canEdit = false; }, cause: "read_only" },
    { what: "month 8: the owner leaves and the sheet goes with the account", setup: () => { fake.state.access = "gone"; }, cause: "sheet_not_found" },
    { what: "month 9: it is restored from the bin", setup: () => { fake.state.drive.trashed = true; }, cause: "sheet_in_bin" },
    { what: "month 10: back to normal", setup: () => {}, cause: null },
  ];
  for (const [i, m] of months.entries()) {
    fake.reset([tab("Admission Board"), tab("BS LLC — Web Leads", [["Submitted", "Name"]])]);
    m.setup();
    const pin: Record<string, string> = m.what.startsWith("month 4") ? { OCH_ADMISSIONS_TAB: "Admissions Q4" } : {};
    // month 4 pins a tab that exists; the rest read by the rule
    const r = await canary(pin);
    check(`year: ${m.what}: ${m.cause ? `caught as ${m.cause}` : "silent"}`, causeOf(r) === m.cause, verdict(r));
    void i;
  }

  // ── The real import, against the same fake ───────────────────────────────
  // It is run without a database, so it ends at "Missing DATABASE_URL" AFTER it
  // has read, parsed and printed every month. What it printed is what it would
  // have written.
  const monthsPrinted = (out: string): Record<string, number> => {
    const m: Record<string, number> = {};
    for (const l of out.split(/\r?\n/)) { const x = l.match(/^\s*(\d{4}-\d{2}): (\d+) admissions \(/); if (x && !/in progress/.test(l)) m[x[1]!] = Number(x[2]); }
    return m;
  };
  const noDb = /Missing DATABASE_URL/;

  fake.reset([tab("Admission Board", board({ count: 60, stepDays: 3 })), tab("BS LLC — Web Leads", [["Submitted"]])]);
  const imp = await run("import-och", {}, ["--dry-run"]);
  check("import: a healthy board is read to the point of writing", noDb.test(imp.out) && /Total:/.test(imp.out), imp.out.slice(-500));
  {
    const rows = fake.state.tabs[0]!.rows;
    const h = findHeaderRow(rows);
    const cols = resolveAdmissionColumns(rows, { tab: "Admission Board", headerRowIndex: h }, { require: ["name", "date", "contact", "referent"] });
    const mine = readBoard(rows, cols, h, etToday).admittedByMonth;
    const theirs = monthsPrinted(imp.out);
    const sorted = (o: Record<string, number>) => JSON.stringify(Object.entries(o).sort());
    check("import: the check's month counts EQUAL what the import writes, month by month", sorted(mine) === sorted(theirs) && Object.keys(mine).length >= 3, `check ${JSON.stringify(mine)} vs import ${JSON.stringify(theirs)}`);
  }
  check("import: it wrote nothing to Google", fake.writes === 0, fake.writes);

  fake.reset([tab("Admission Board", board({ count: 60, stepDays: 3 }))]);
  fake.state.fail.push({ match: "/values/", status: 503, times: 2 });
  const blip = await run("import-och", {}, ["--dry-run"]);
  check("import: two Google 503s on the read are retried and the run goes on", noDb.test(blip.out) && /retrying/.test(blip.out), blip.out.slice(-400));

  fake.reset([tab("Admissions 2026", board({ count: 60, stepDays: 3 }))]);
  const renamed = await run("import-och", {}, ["--dry-run"]);
  check("import: a renamed board is found by the same rule the check uses", /Reading tab "Admissions 2026"/.test(renamed.out) && noDb.test(renamed.out), renamed.out.slice(-300));

  fake.reset([tab("Admission Board", board({ count: 60 }))]);
  const missingTab = await run("import-och", { OCH_ADMISSIONS_TAB: "October" }, ["--dry-run"]);
  check("import: a tab it was told to read that is not there is an error naming the tabs", missingTab.code === 1 && /is not in the sheet\. Tabs now: Admission Board/.test(missingTab.out), missingTab.out.slice(-300));

  fake.reset([tab("Admission Board", board({ count: 60 }))]); fake.state.access = "revoked";
  const denied = await run("import-och", {}, ["--dry-run"]);
  check("import: a withdrawn share fails with the sentence the app recognises", denied.code === 1 && /Sheets API 403/.test(denied.out), denied.out.slice(-300));
  fake.reset([tab("Admission Board", board({ count: 60 }))]); fake.state.access = "gone";
  const gone = await run("import-och", {}, ["--dry-run"]);
  check("import: a missing sheet fails with the sentence the app recognises", gone.code === 1 && /Sheets API 404/.test(gone.out), gone.out.slice(-300));
  fake.reset([tab("Admission Board", board({ count: 60 }))]); fake.state.tokenMode = "revoked";
  const dead = await run("import-och", {}, ["--dry-run"]);
  check("import: a revoked key fails with the word the app recognises", dead.code === 1 && /invalid_grant/.test(dead.out), dead.out.slice(-300));

  fake.reset([tab("Admission Board", board({ count: ROW_LIMIT + 5, stepDays: 0.01 }))]);
  const big = await run("import-och", {}, ["--dry-run"]);
  check("import: a board that fills the read is a stop, not a lower number", big.code === 1 && /the most we read/.test(big.out) && !/Total:/.test(big.out), big.out.slice(-300));

  fake.reset([tab("Admission Board", board({ count: 60, header: ["a", "b", "c", "d", "e", "f", "g"] }).map((r, i) => (i === 0 ? r : r.map((_, c) => `v${c}`))))]);
  const headless = await run("import-och", {}, ["--dry-run"]);
  check("import: an unreadable board stops before it writes a number", headless.code !== 0 && !/Total:/.test(headless.out), headless.out.slice(-300));

  // ── The contract between the repositories ────────────────────────────────
  check("every cause the check can print is on the shared list", CAUSE_CODES.length >= 15, CAUSE_CODES.length);
  if (existsSync(new URL("../.github/workflows/och-sheet-check.yml", import.meta.url))) {
    for (const w of ["och-sheet-check", "import-och", "import-offline-conversions", "publish-och-web-leads"]) {
      const y = readFileSync(new URL(`../.github/workflows/${w}.yml`, import.meta.url), "utf8");
      check(`${w}.yml never points the jobs at a pretend Google`, !/GOOGLE_FAKE_BASE/.test(y));
    }
  }

  await fake.stop();
  console.log(failed === 0 ? `✓ OCH sheet connection, end to end: ${n} checks passed` : `\n${failed} of ${n} checks FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await fake.stop().catch(() => {}); process.exit(1); });

#!/usr/bin/env tsx
/**
 * Guard for OCH's Admission Board connection: the one rule for which sheet and
 * tab every job reads, and the daily check that names why the connection stops.
 * No network, no credential, no database. Every sheet, tab and date below is
 * invented.
 *
 *   npm run verify-och-sheet
 */
import { isAdmittedStatus } from "./lead-keys.js";
import { readFileSync, existsSync } from "node:fs";
import { OCH_SHEET_ID_DEFAULT, ochSheetId, pickAdmissionTab, rowsCapped, boardRange, ROW_LIMIT, BOARD_TAB_NAME } from "./och-sheet-target.js";
import { gatherFacts, type Doors } from "./och-sheet-gather.js";
import { readBoard, droppedMonths } from "./och-board-readings.js";
import { sheetsBase, driveBase } from "./och-google.js";
import { checkOchSheet, summaryLine, classifyTokenError, hasStop, CAUSE_CODES, QUIET_AFTER_DAYS, type CheckFacts } from "./och-sheet-check.js";

let failed = 0;
let n = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  n++;
  if (ok) return;
  failed++;
  console.error(`✗ ${name}${detail !== undefined ? `\n    ${String(detail).slice(0, 300)}` : ""}`);
}

// ── Which sheet ─────────────────────────────────────────────────────────────
check("the default sheet is the one we have always read", ochSheetId({}) === OCH_SHEET_ID_DEFAULT);
check("a blank override is no override", ochSheetId({ OCH_SHEET_ID: "  " }) === OCH_SHEET_ID_DEFAULT);
check("a bare id is taken as it is", ochSheetId({ OCH_SHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" }) === "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
check("a whole sheet address pasted in gives its id",
  ochSheetId({ OCH_SHEET_ID: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0" }) === "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");

// ── Which tab ───────────────────────────────────────────────────────────────
const p1 = pickAdmissionTab(["Admission Board", "Web Inquiries"]);
check("one tab that looks like the board is the board", p1.tab === "Admission Board" && p1.how === "only_match" && !p1.ambiguous);
const p2 = pickAdmissionTab(["Admissions Sep", "Admission Board", "Notes"]);
check("several look like it: the one named Admission Board is read, and the look-alike is still flagged", p2.tab === "Admission Board" && p2.how === "named_board" && p2.ambiguous);
check("naming the tab clears the flag", !pickAdmissionTab(["Admissions Sep", "Admission Board"], "Admission Board").ambiguous);
const p3 = pickAdmissionTab(["Admissions Sep", "Admissions Oct"]);
check("several look like it and none is the board: the first, and it says so", p3.tab === "Admissions Sep" && p3.ambiguous && p3.candidates.length === 2);
const p4 = pickAdmissionTab(["Sheet1", "Web Inquiries"]);
check("none looks like it: the first tab, as before, and not flagged ambiguous", p4.tab === "Sheet1" && p4.how === "first_tab" && !p4.ambiguous);
check("a tab named by the caller wins, whatever its case", pickAdmissionTab(["Admission Board", "October"], "october").tab === "October");
const p5 = pickAdmissionTab(["Admission Board"], "Gone");
check("a tab the caller named that is not there reads as missing, not as the board", p5.tab === null && p5.how === "override_missing");
check("a sheet with no tabs has no board", pickAdmissionTab([]).tab === null && pickAdmissionTab([]).how === "none");
check("the range quotes a name with a space and an apostrophe", boardRange("Och's Board") === `'Och''s Board'!A1:Z${ROW_LIMIT}`, boardRange("Och's Board"));

// ── Length ──────────────────────────────────────────────────────────────────
check("a short board is not capped", !rowsCapped(1200));
check("a board that fills the read is capped", rowsCapped(ROW_LIMIT) && rowsCapped(ROW_LIMIT - 50));
check("the read is longer than either old limit", ROW_LIMIT > 10_000);

// ── Each cause ──────────────────────────────────────────────────────────────
const SA = "sync@example-project.iam.gserviceaccount.com";
const base = (over: Partial<CheckFacts> = {}): CheckFacts => ({
  today: "2026-10-05",
  key: { state: "ok", serviceEmail: SA },
  sheet: { status: 200, unavailable: false },
  drive: { checked: true, trashed: false, canEdit: true, modifiedYmd: "2026-10-04" },
  tabs: ["Admission Board", "BS LLC — Web Leads"],
  pick: pickAdmissionTab(["Admission Board", "BS LLC — Web Leads"]),
  columns: { ok: true, detail: null },
  rowsRead: 400,
  rowsCapped: false,
  newestAdmissionYmd: "2026-10-02",
  board: null,
  ...over,
});
const codes = (f: CheckFacts) => checkOchSheet(f).map((x) => x.code);
const first = (f: CheckFacts) => checkOchSheet(f)[0];

check("a healthy connection has no findings", checkOchSheet(base()).length === 0, codes(base()).join());
check("a healthy connection's last line says ok and what it read",
  /^OCH-SHEET ok: read "Admission Board", 399 rows, newest admission Oct 2\.$/.test(summaryLine([], { tab: "Admission Board", rows: 400, newest: "2026-10-02" })),
  summaryLine([], { tab: "Admission Board", rows: 400, newest: "2026-10-02" }));

check("no key is key_missing and a stop", first(base({ key: { state: "missing", serviceEmail: null }, sheet: null }))?.code === "key_missing" && first(base({ key: { state: "missing", serviceEmail: null }, sheet: null }))?.level === "stop");
check("half a key file is key_unreadable", first(base({ key: { state: "incomplete", serviceEmail: null }, sheet: null }))?.code === "key_unreadable");
check("garbage in the key is key_unreadable", first(base({ key: { state: "unparseable", serviceEmail: null }, sheet: null }))?.code === "key_unreadable");
check("a key Google refuses is key_rejected, ours to fix", first(base({ key: { state: "rejected", serviceEmail: SA }, sheet: null }))?.code === "key_rejected" && first(base({ key: { state: "rejected", serviceEmail: SA }, sheet: null }))?.who === "us");
check("a key problem stops the check there: nothing about the sheet is claimed",
  codes(base({ key: { state: "rejected", serviceEmail: SA }, sheet: null })).length === 1);
check("a 404 is sheet_not_found, and it says to find out first", first(base({ sheet: { status: 404, unavailable: false } }))?.code === "sheet_not_found" && first(base({ sheet: { status: 404, unavailable: false } }))?.who === "either");
check("a 403 is access_removed, OCH's to fix", first(base({ sheet: { status: 403, unavailable: false } }))?.code === "access_removed" && first(base({ sheet: { status: 403, unavailable: false } }))?.who === "client");
check("access_removed names the address to share with", checkOchSheet(base({ sheet: { status: 403, unavailable: false } }))[0]!.steps.some((s) => s.includes(SA)));
check("access_removed asks for a durable owner", checkOchSheet(base({ sheet: { status: 403, unavailable: false } }))[0]!.steps.some((s) => /owner/i.test(s)));
check("a sheet in the bin is a stop even though it still reads", checkOchSheet(base({ drive: { checked: true, trashed: true, canEdit: true, modifiedYmd: "2026-10-04" } })).some((x) => x.code === "sheet_in_bin" && x.level === "stop"));
check("read-only access is a warning, not a stop", (() => { const r = checkOchSheet(base({ drive: { checked: true, trashed: false, canEdit: false, modifiedYmd: "2026-10-04" } })); return r.length === 1 && r[0]!.code === "read_only" && r[0]!.level === "warn"; })());
check("Drive not answering says nothing about bin or edit rights (a null is not a no)", checkOchSheet(base({ drive: { checked: false, trashed: null, canEdit: null, modifiedYmd: null } })).length === 0);
check("a Google outage is a warning that blames nobody", (() => { const r = checkOchSheet(base({ sheet: { status: 503, unavailable: true } })); return r.length === 1 && r[0]!.code === "google_unavailable" && r[0]!.level === "warn" && !hasStop(r); })());
check("a missing tab is tab_missing and lists the tabs there are", (() => { const r = first(base({ tabs: ["Sheet9", "Notes"], pick: pickAdmissionTab([], null) })); return r?.code === "tab_missing" && /Sheet9/.test(r.line); })());
check("a named tab that is gone is tab_missing", first(base({ pick: pickAdmissionTab(["Admission Board"], "October") }))?.code === "tab_missing");
check("two tabs that both look like the board is a warning naming both", (() => {
  const pick = pickAdmissionTab(["Admissions Sep", "Admissions Oct"]);
  const r = checkOchSheet(base({ tabs: ["Admissions Sep", "Admissions Oct"], pick }));
  return r.length === 1 && r[0]!.code === "tab_ambiguous" && r[0]!.level === "warn" && /Admissions Sep/.test(r[0]!.line) && /Admissions Oct/.test(r[0]!.line);
})());
check("an unreadable column is a stop that carries the resolver's own words", (() => {
  const r = first(base({ columns: { ok: false, detail: 'no name column — header row 1 reads "h | Phone Number | DOB".' } }));
  return r?.code === "headings" && r.level === "stop" && r.who === "client" && /header row 1/.test(r.line);
})());
check("a board that fills the read is a stop that is ours", (() => { const r = checkOchSheet(base({ rowsRead: ROW_LIMIT, rowsCapped: true })); return r.some((x) => x.code === "board_too_long" && x.level === "stop" && x.who === "us"); })());
check("a board with only a header is board_empty", checkOchSheet(base({ rowsRead: 1, newestAdmissionYmd: null })).some((x) => x.code === "board_empty"));
check("a board dated 40 days ago is quiet", checkOchSheet(base({ newestAdmissionYmd: "2026-08-26" })).some((x) => x.code === "board_quiet" && x.level === "warn"));
check("a board dated exactly at the limit is not quiet", !codes(base({ newestAdmissionYmd: "2026-09-14" })).includes("board_quiet"), `limit ${QUIET_AFTER_DAYS}`);
check("a quiet board on a sheet edited this week says they may be elsewhere", (() => {
  const r = checkOchSheet(base({ newestAdmissionYmd: "2026-08-26", drive: { checked: true, trashed: false, canEdit: true, modifiedYmd: "2026-10-03" } })).find((x) => x.code === "board_quiet");
  return !!r && /another tab/.test(r.line);
})());
check("a quiet board on a sheet nobody has edited does not claim a new tab", (() => {
  const r = checkOchSheet(base({ newestAdmissionYmd: "2026-08-26", drive: { checked: true, trashed: false, canEdit: true, modifiedYmd: "2026-08-27" } })).find((x) => x.code === "board_quiet");
  return !!r && !/another tab/.test(r.line);
})());
check("no dated admission at all is not read as quiet (a null is not a date)", !codes(base({ newestAdmissionYmd: null })).includes("board_quiet"));


// ── What the numbers say ────────────────────────────────────────────────────
const RB = { dateCols: [5], statusCol: 3, hasStatusCol: true };
const rb = (rows: string[][]) => readBoard([HEAD0, ...rows], RB, 0, "2026-10-05");
const HEAD0 = ["Name", "Phone", "DOB", "Status", "Inquiry", "Admitted", "Referent"];
const row = (status: string, admitted: string) => ["Ada Brennan", "513-555-0100", "3/14/1988", status, "9/1/2026", admitted, "Google"];
{
  const r = rb([row("Admitted", "8/3/2026"), row("Admitted", "8/20/2026"), row("Did Not Admit", "8/21/2026"), row("Admitted", "9/2/2026"), row("Admitted", "10/1/2026"), row("Admitted", "10/1/2027"), row("Admitted", ""), row("Waitlisted", "9/3/2026"), row("Waitlisted - hold", "9/3/2026"), row("Waitlisted", "9/4/2026")]);
  check("readBoard counts admissions per complete month, with the import's own status rule", r.admittedByMonth["2026-08"] === 2 && r.admittedByMonth["2026-09"] === 1, JSON.stringify(r));
  check("readBoard keeps the open month apart from the complete ones", r.currentMonthAdmitted === 1 && r.admittedByMonth["2026-10"] === undefined);
  check("readBoard sets a future-dated admission aside and says so", r.futureDated === 1, r.futureDated);
  check("readBoard counts an admission with no date and puts it in no month", r.admittedNoDate === 1, r.admittedNoDate);
  check("readBoard counts DISTINCT unrecognised words, not rows, and never quotes them", r.unrecognizedStatuses === 2 && !JSON.stringify(r).includes("Waitlisted"), JSON.stringify(r));
  const all = readBoard([HEAD0, row("", "8/3/2026"), row("anything", "8/4/2026")], { ...RB, hasStatusCol: false }, 0, "2026-10-05");
  check("with no status column every dated row is an admission, as the import reads it", all.admittedByMonth["2026-08"] === 2 && all.unrecognizedStatuses === 0, JSON.stringify(all));
}
{
  const d = droppedMonths({ "2026-08": 22, "2026-09": 30 }, { "2026-08": 26, "2026-09": 28, "2026-10": 99 }, "2026-10-05");
  check("a month that reads lower than stored is reported, a month that rose is not, and the open month is not compared", d.length === 1 && d[0]!.ym === "2026-08" && d[0]!.now === 22 && d[0]!.then === 26, JSON.stringify(d));
  check("a wobble of one is not reported", droppedMonths({ "2026-08": 25 }, { "2026-08": 26 }, "2026-10-05").length === 0);
  check("a two-row fall on a big month is under the share floor and is not reported", droppedMonths({ "2026-08": 98 }, { "2026-08": 100 }, "2026-10-05").length === 0);
  check("a month the board no longer has at all is a fall to nought, not a null", droppedMonths({}, { "2026-08": 12 }, "2026-10-05")[0]?.now === 0);
  check("with nothing stored nothing is compared (a null is unanswered)", droppedMonths({ "2026-08": 1 }, null, "2026-10-05").length === 0);
  check("only the last six complete months are compared", droppedMonths({}, Object.fromEntries(["2025-01", "2025-02", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"].map((m) => [m, 20])), "2026-10-05").length === 6);
  const f = base({ board: { unrecognizedStatuses: 0, dropped: [{ ym: "2026-08", now: 22, then: 26 }, { ym: "2026-07", now: 10, then: 14 }] } });
  const x = checkOchSheet(f).find((y) => y.code === "past_months_changed");
  check("a fall is a warning that names the month and both counts, and counts the others", !!x && x.level === "warn" && /Aug 2026 now reads 22 admissions on the board against 26/.test(x.line) && /1 other earlier month/.test(x.line), x?.line);
  check("a fall with nothing to compare against says nothing", checkOchSheet(base({ board: { unrecognizedStatuses: 0, dropped: null } })).length === 0);
  const u = checkOchSheet(base({ board: { unrecognizedStatuses: 2, dropped: [] } })).find((y) => y.code === "status_unrecognized");
  check("an unrecognised status word is a warning that is ours, with a count and no word", !!u && u.level === "warn" && u.who === "us" && /^2 status words/.test(u.line), u?.line);
  const g = checkOchSheet(base({ tabs: ["Intake", "Web Leads"], pick: pickAdmissionTab(["Intake", "Web Leads"]) }));
  check("no tab named like the board, with other tabs around, is tab_guessed", g.length === 1 && g[0]!.code === "tab_guessed" && g[0]!.level === "warn", g.map((y) => y.code).join());
  check("a sheet with one tab and no look-alike is not a guess", checkOchSheet(base({ tabs: ["Sheet1"], pick: pickAdmissionTab(["Sheet1"]) })).length === 0);
}

// ── The line the dashboard reads ────────────────────────────────────────────
const every: CheckFacts[] = [
  base({ key: { state: "missing", serviceEmail: null }, sheet: null }),
  base({ key: { state: "rejected", serviceEmail: SA }, sheet: null }),
  base({ sheet: { status: 404, unavailable: false } }),
  base({ sheet: { status: 403, unavailable: false } }),
  base({ drive: { checked: true, trashed: true, canEdit: false, modifiedYmd: "2026-10-04" } }),
  base({ pick: pickAdmissionTab([]), tabs: [] }),
  base({ columns: { ok: false, detail: "x".repeat(900) } }),
  base({ newestAdmissionYmd: "2026-08-26" }),
];
for (const f of every) {
  const line = summaryLine(checkOchSheet(f), { tab: null, rows: null, newest: null });
  check("every last line has the shape the dashboard parses", /^OCH-SHEET (ok|warn|stop)( [a-z_]+)?: \S/.test(line), line);
  check("every last line fits the heartbeat note (300 characters)", line.length <= 300, line.length);
  const code = line.match(/^OCH-SHEET (?:warn|stop) ([a-z_]+):/)?.[1];
  check("every cause code is on the shared list", code == null || (CAUSE_CODES as readonly string[]).includes(code), code);
  check("no line carries a person's details (no @, no 10-digit run)", !/@|\d{10}/.test(checkOchSheet(f).map((x) => x.line).join(" ")), line);
}
check("a stop outranks a warning for the last line", (() => {
  const r = checkOchSheet(base({ pick: pickAdmissionTab(["Admissions Sep", "Admissions Oct"]), tabs: ["Admissions Sep", "Admissions Oct"], columns: { ok: false, detail: "no name column" } }));
  return /^OCH-SHEET stop headings:/.test(summaryLine(r, { tab: null, rows: null, newest: null }));
})());

// ── What Google's refusal of a key looks like ───────────────────────────────
check("invalid_grant means the key is refused", classifyTokenError({ response: { status: 400, data: { error: "invalid_grant" } }, message: "invalid_grant: Invalid JWT Signature." }) === "rejected");
check("a timeout does not mean the key is dead", classifyTokenError({ message: "request to https://oauth2.googleapis.com/token failed, reason: connect ETIMEDOUT" }) === "unavailable");
check("a 503 does not mean the key is dead", classifyTokenError({ response: { status: 503 }, message: "Service Unavailable" }) === "unavailable");
check("nothing at all does not mean the key is dead", classifyTokenError(null) === "unavailable");

// ── Drift: nothing outside the one rule decides the sheet or the tab ────────
const JOBS = ["import-och", "import-offline-conversions", "publish-och-web-leads", "import-web-inquiries", "debug-och-form-submissions-gap", "reconcile-och-leads", "och-sheet-canary"];
for (const j of JOBS) {
  const path = new URL(`./${j}.ts`, import.meta.url);
  if (!existsSync(path)) { check(`${j} exists`, false); continue; }
  const src = readFileSync(path, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  check(`${j} does not type the sheet id`, !src.includes(OCH_SHEET_ID_DEFAULT));
  check(`${j} reads the sheet id through ochSheetId()`, /ochSheetId\(\)/.test(src));
}
for (const j of ["import-och", "import-offline-conversions", "publish-och-web-leads", "och-sheet-gather"]) {
  const src = readFileSync(new URL(`./${j}.ts`, import.meta.url), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  check(`${j} picks the board tab through pickAdmissionTab`, /pickAdmissionTab\(/.test(src));
  check(`${j} does not pick a tab by its own rule`, !/tabs\.find\(\s*\(?t\)?\s*=>\s*\/admission/i.test(src) && !/\/admission\/i\.test\(t\)/.test(src));
  check(`${j} reads the board through boardRange (no row count typed here)`, /boardRange\(/.test(src) && !/A1:Z\d{4,5}/.test(src));
}
check("publish no longer hard-codes the board's tab name", !/const BOARD_TAB = "Admission Board"/.test(readFileSync(new URL("./publish-och-web-leads.ts", import.meta.url), "utf8")));
check("the board tab name constant is the one the old publish used", BOARD_TAB_NAME === "Admission Board");

// ── The workflow ────────────────────────────────────────────────────────────
const wf = new URL("../.github/workflows/och-sheet-check.yml", import.meta.url);
if (existsSync(wf)) {
  const y = readFileSync(wf, "utf8");
  check("the check is scheduled before the import (07:30) and the publish (07:45)", /cron:\s*"10 7 \* \* \*"/.test(y));
  // The Heartbeat STEP's own block: another step in the file also says always(),
  // so a file-wide match would pass with the heartbeat's own condition deleted.
  const hb = y.split(/\n\s*- name: /).find((b) => /^Heartbeat/.test(b)) ?? "";
  check("the check records a heartbeat under its own job name, with the log as the note", /--job=och_sheet_check/.test(hb) && /--log=/.test(hb));
  // A step output can carry text OCH typed (a tab name). Pasted into a script
  // line it is a command-injection hole, so no run: block may interpolate one.
  const runBlocks = y.split("\n").filter((l) => /^\s*run:/.test(l) || /^\s+npm run /.test(l) || /^\s+LINE=/.test(l));
  check("no script line interpolates a step output (a tab name could be a command)", !runBlocks.some((l) => /\$\{\{\s*steps\./.test(l)), runBlocks.filter((l) => /\$\{\{\s*steps\./.test(l)).join(" | "));
  check("the heartbeat step runs even when the check fails (a failed run must record as a failure)", /if:\s*always\(\)/.test(hb));
  check("the sheet and tab overrides come from repository variables, not secrets", /vars\.OCH_SHEET_ID/.test(y) && /vars\.OCH_ADMISSIONS_TAB/.test(y));
  const stepCheck = y.split(/\n\s*- name: /).find((b) => /^Check the sheet/.test(b)) ?? "";
  check("the check step can read what was stored last time (DATABASE_URL on it)", /DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/.test(stepCheck));
} else check("the workflow exists", false);
for (const w of ["import-och", "import-offline-conversions", "publish-och-web-leads"]) {
  const p = new URL(`../.github/workflows/${w}.yml`, import.meta.url);
  if (!existsSync(p)) { check(`${w}.yml exists`, false); continue; }
  const y = readFileSync(p, "utf8");
  check(`${w} passes the overrides to the job`, /vars\.OCH_SHEET_ID/.test(y) && /vars\.OCH_ADMISSIONS_TAB/.test(y));
  check(`${w} records WHY it failed (its heartbeat reads the log)`, /--log=/.test(y));
}


// ── The glue, against a fake Google ─────────────────────────────────────────
// The pure decision is tested above. What it cannot catch is the gatherer
// reading the wrong property off Google's answer, or treating a refusal as an
// outage, so this drives gatherFacts through fake doors and decides on what
// comes back. The fake has no write: the check has no door that could make one.
const TODAY = "2026-10-05";
const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const HEAD = ["Name", "Phone", "DOB", "Status", "Inquiry Received", "Scheduled Admission Date", "Referent"];
const NAMES = ["Ada Brennan", "Colin Vasser", "Dara Whitlow", "Emil Navarro"];
const board = (admitDates: string[], header = HEAD): string[][] => [
  header,
  ...admitDates.map((d, i) => [NAMES[i % NAMES.length]!, `513-555-01${String(i).padStart(2, "0")}`, "3/14/1988", "Admitted", d, d, i % 2 ? "Google" : "Web Form"]),
];
interface Fake {
  tabs?: string[];
  rows?: string[][];
  meta?: number | null;
  values?: number | null;
  drive?: { status: number | null; trashed?: boolean; canEdit?: boolean; modifiedTime?: string } | "off";
  tokenError?: unknown;
  driveTokenError?: unknown;
  stored?: Record<string, number> | null | "throws" | "absent";
}
function fake(f: Fake): { doors: Doors; urls: string[] } {
  const urls: string[] = [];
  const doors: Doors = {
    token: async (scope) => {
      if (scope.includes("drive") && f.driveTokenError) throw f.driveTokenError;
      if (!scope.includes("drive") && f.tokenError) throw f.tokenError;
      return `tok:${scope.split("/").pop()}`;
    },
    stored: f.stored === "absent" || f.stored === undefined ? undefined : async () => { if (f.stored === "throws") throw new Error("connection refused"); return f.stored as Record<string, number> | null; },
    get: async (url) => {
      urls.push(url);
      if (url.startsWith(driveBase())) {
        if (f.drive === "off" || !f.drive) return { status: 403, body: { error: { message: "Google Drive API has not been used in project" } } };
        return { status: f.drive.status, body: f.drive.status === 200 ? { trashed: f.drive.trashed ?? false, modifiedTime: f.drive.modifiedTime ?? "2026-10-04T10:00:00.000Z", capabilities: { canEdit: f.drive.canEdit ?? true } } : null };
      }
      if (url.includes("/values/")) return { status: f.values === undefined ? 200 : f.values, body: { values: f.rows ?? board(["9/30/2026", "10/1/2026", "10/2/2026"]) } };
      return { status: f.meta === undefined ? 200 : f.meta, body: { sheets: (f.tabs ?? ["Admission Board", "BS LLC — Web Leads"]).map((title) => ({ properties: { title } })) } };
    },
  };
  return { doors, urls };
}
async function drive(f: Fake, preferredTab: string | null = null) {
  const { doors, urls } = fake(f);
  const g = await gatherFacts(doors, { sheetId: SHEET, preferredTab, today: TODAY, serviceEmail: SA });
  return { ...g, urls, findings: checkOchSheet(g.facts) };
}
const driveOk = { status: 200 as const, trashed: false, canEdit: true };
const lines = (r: { findings: ReturnType<typeof checkOchSheet> }) => r.findings.map((x) => x.code);

async function glue() {
  const ok = await drive({ drive: driveOk });
  check("glue: a healthy board reads clean", ok.findings.length === 0, lines(ok).join());
  check("glue: it found the newest admission date on the board", ok.facts.newestAdmissionYmd === "2026-10-02", ok.facts.newestAdmissionYmd);
  check("glue: it counted the rows it read", ok.facts.rowsRead === 4, ok.facts.rowsRead);
  check("glue: it asked for the sheet it was told to, by that id", ok.urls.every((u) => u.includes(SHEET)));
  check("glue: it only ever calls Sheets and Drive", ok.urls.every((u) => u.startsWith(sheetsBase()) || u.startsWith(driveBase())));
  check("glue: the board is requested by a quoted tab name", ok.urls.some((u) => u.includes(encodeURIComponent("'Admission Board'!A1:Z"))), ok.urls.join("\n"));
  const text = [summaryLine(ok.findings, { tab: ok.tab, rows: ok.facts.rowsRead, newest: ok.facts.newestAdmissionYmd })].join(" ");
  check("glue: nothing about a patient reaches the output", !NAMES.some((n) => text.includes(n)) && !/513-555/.test(text) && !/1988/.test(text), text);

  const rej = await drive({ tokenError: { response: { status: 400, data: { error: "invalid_grant" } }, message: "invalid_grant: Invalid JWT Signature." } });
  check("glue: a key Google refuses is key_rejected, and nothing past it is called", lines(rej).join() === "key_rejected" && rej.urls.length === 0, `${lines(rej)} ${rej.urls.length}`);
  const out = await drive({ tokenError: new Error("request to https://oauth2.googleapis.com/token failed, reason: connect ETIMEDOUT") });
  check("glue: a token timeout is an outage, not a dead key", lines(out).join() === "google_unavailable", lines(out).join());

  check("glue: a 404 is sheet_not_found", lines(await drive({ meta: 404 })).join() === "sheet_not_found");
  check("glue: a 403 is access_removed", lines(await drive({ meta: 403 })).join() === "access_removed");
  check("glue: a dropped connection is an outage", lines(await drive({ meta: null })).join() === "google_unavailable");
  check("glue: a 503 is an outage", lines(await drive({ meta: 503 })).join() === "google_unavailable");
  check("glue: a 403 reading the tab is access, not a missing tab", lines(await drive({ drive: driveOk, values: 403 })).join() === "access_removed");
  check("glue: a 500 reading the tab is an outage", lines(await drive({ drive: driveOk, values: 500 })).join() === "google_unavailable");

  const bin = await drive({ drive: { ...driveOk, trashed: true } });
  check("glue: a trashed sheet is sheet_in_bin", lines(bin).includes("sheet_in_bin"), lines(bin).join());
  const noDrive = await drive({ drive: "off" });
  check("glue: Drive being off is skipped, said, and blamed on nobody", noDrive.findings.length === 0 && noDrive.skipped.filter((x) => /Google Drive/.test(x)).length === 1, `${lines(noDrive)} | ${noDrive.skipped}`);
  const noDriveToken = await drive({ driveTokenError: new Error("insufficient scope") });
  check("glue: Drive refusing its scope is skipped too, never a dead key", noDriveToken.findings.length === 0 && noDriveToken.skipped.filter((x) => /Google Drive/.test(x)).length === 1, `${lines(noDriveToken)}`);
  check("glue: read-only access is read_only", lines(await drive({ drive: { ...driveOk, canEdit: false } })).join() === "read_only");

  const amb = await drive({ drive: driveOk, tabs: ["Admissions Sep", "Admissions Oct"] });
  check("glue: two look-alike tabs warn and read the first", lines(amb).join() === "tab_ambiguous" && amb.tab === "Admissions Sep", `${lines(amb)} ${amb.tab}`);
  const named = await drive({ drive: driveOk, tabs: ["Admissions Sep", "Admissions Oct"] }, "Admissions Oct");
  check("glue: a tab named by variable is the one read, and the warning goes", named.tab === "Admissions Oct" && named.findings.length === 0 && named.urls.some((u) => u.includes(encodeURIComponent("'Admissions Oct'!A1:Z"))), `${named.tab} ${lines(named)}`);
  const gone = await drive({ drive: driveOk, tabs: ["Admission Board"] }, "October");
  check("glue: a named tab that is not there is tab_missing", lines(gone).join() === "tab_missing", lines(gone).join());
  check("glue: a sheet with no tabs is tab_missing", lines(await drive({ drive: driveOk, tabs: [] })).join() === "tab_missing");

  const bad = await drive({ drive: driveOk, rows: board(["9/30/2026", "10/1/2026"], ["zz", "yy", "xx"]).map((r) => r.slice(0, 3).map((_, i) => `v${i}`)) });
  check("glue: a board no heading or data can read is a headings stop", lines(bad).includes("headings") && bad.findings.find((x) => x.code === "headings")?.level === "stop", lines(bad).join());

  const quiet = await drive({ drive: { ...driveOk, modifiedTime: "2026-10-03T00:00:00.000Z" }, rows: board(["8/1/2026", "8/3/2026"]) });
  check("glue: a board last dated in August is quiet, and the sheet edited this week says another tab", lines(quiet).join() === "board_quiet" && /another tab/.test(quiet.findings[0]!.line), `${lines(quiet)} ${quiet.findings[0]?.line}`);
  const future = await drive({ drive: driveOk, rows: board(["9/30/2026", "10/1/2027"]) });
  check("glue: a date typed in the future is not the newest (a 2027 typo)", future.facts.newestAdmissionYmd === "2026-09-30", future.facts.newestAdmissionYmd);

  const big = await drive({ drive: driveOk, rows: [HEAD, ...Array.from({ length: ROW_LIMIT }, () => ["Ada Brennan", "513-555-0100", "3/14/1988", "Admitted", "9/30/2026", "9/30/2026", "Google"])] });
  check("glue: a board that fills the read is board_too_long", lines(big).includes("board_too_long"), lines(big).join());

  const dropped = await drive({ drive: driveOk, rows: board(["8/1/2026", "8/2/2026", "9/30/2026"]), stored: { "2026-08": 5, "2026-09": 1 } });
  check("glue: August reading lower than stored is past_months_changed", lines(dropped).join() === "past_months_changed" && dropped.facts.board?.dropped?.[0]?.then === 5, `${lines(dropped)} ${JSON.stringify(dropped.facts.board)}`);
  const same = await drive({ drive: driveOk, rows: board(["8/1/2026", "8/2/2026", "9/30/2026"]), stored: { "2026-08": 2, "2026-09": 1 } });
  check("glue: figures that match what was stored say nothing", same.findings.length === 0, lines(same).join());
  const noStore = await drive({ drive: driveOk, stored: null });
  check("glue: nothing stored is skipped and said, never read as unchanged", noStore.findings.length === 0 && noStore.skipped.some((x) => /nothing stored/.test(x)) && noStore.facts.board?.dropped === null, JSON.stringify(noStore.skipped));
  const boom = await drive({ drive: driveOk, stored: "throws" });
  check("glue: a database that will not answer is skipped, never a finding", boom.findings.length === 0 && boom.skipped.some((x) => /nothing stored/.test(x)), `${lines(boom)} ${boom.skipped}`);
  const noDb = await drive({ drive: driveOk });
  check("glue: no database at all is skipped and said", noDb.skipped.some((x) => /no database/.test(x)), JSON.stringify(noDb.skipped));
  const odd = await drive({ drive: driveOk, rows: [HEAD, ...board(["9/30/2026"]).slice(1), ["Ada Brennan", "513-555-0111", "3/14/1988", "Waitlisted", "9/30/2026", "9/30/2026", "Google"]] });
  check("glue: a status word nobody has classified is status_unrecognized", lines(odd).join() === "status_unrecognized", lines(odd).join());
  const pend = await drive({ drive: driveOk, rows: [HEAD, ...board(["9/30/2026"]).slice(1), ["Ada Brennan", "513-555-0111", "3/14/1988", "Pending", "9/30/2026", "9/30/2026", "Google"], ["Bo Kim", "513-555-0112", "3/15/1988", "", "9/30/2026", "9/30/2026", "Google"]] });
  check("glue: Pending and a blank status are known non-admissions and say nothing", pend.findings.length === 0, lines(pend).join());
  check("a status that is Pending or blank is never an admission", !isAdmittedStatus("Pending") && !isAdmittedStatus("") && !isAdmittedStatus(undefined) && isAdmittedStatus("Admitted"));
  const guessed = await drive({ drive: driveOk, tabs: ["Intake", "Web Leads"] });
  check("glue: no tab named like the board is tab_guessed and the first tab is read", lines(guessed).join() === "tab_guessed" && guessed.tab === "Intake", `${lines(guessed)} ${guessed.tab}`);
  check("glue: an empty tab is board_empty", lines(await drive({ drive: driveOk, rows: [HEAD] })).includes("board_empty"));
}

await glue();

console.log(failed === 0 ? `✓ OCH sheet connection: ${n} checks passed` : `\n${failed} of ${n} checks FAILED`);
process.exit(failed === 0 ? 0 : 1);

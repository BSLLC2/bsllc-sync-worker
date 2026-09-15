#!/usr/bin/env tsx
/**
 * The rules that keep OCH's admissions import from being confidently wrong,
 * proved without a sheet, a network call, a credential or a database.
 *
 * All three of these shipped, ran green for days and corrupted data quietly:
 *
 *   1. A header the client edited must STOP the run. "Name" became "h" on
 *      their own board; findCol returned -1; every admission was written with
 *      an empty name; the unique index (client_slug, admitted_on, phone, name)
 *      saw a new row rather than a conflict, so a nameless twin of every
 *      admission was inserted beside the real one — and the job exited 0.
 *   2. An admission is dated by an ADMISSION date. Falling back to "Inquiry
 *      Received" buckets a row into the month the patient first rang: revenue
 *      moves between months and no total ever changes, so nothing looks wrong.
 *   3. A hand-typed backfill row is a lead, never a channel. 37 rows of OCH's
 *      own form-log export carried utm_source='website' / utm_medium='form',
 *      which are both in ATTRIBUTABLE_UTM_WORDS — an attribution claim nobody
 *      observed, written two lines under a comment saying it was left blank.
 *
 * Pure: the header fixtures below are invented column names, not a client's
 * sheet, and no real person, phone, date or figure appears anywhere.
 *
 *   npm run verify-och-import
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveAdmissionColumns, findHeaderRow } from "./och-sheet-columns.js";
import { provenanceOf } from "./lead-provenance.js";

const SRC = path.resolve(import.meta.dirname);
const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const ctx = { tab: "Admission Board", headerRowIndex: 1 };
const resolves = (header: string[]) => resolveAdmissionColumns(header, ctx);
const throwsWith = (header: string[]): string | null => {
  try { resolves(header); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
};

console.log("OCH admissions import — the three rules that failed silently");
console.log("Pure. No sheet, no network, no database, no client account is contacted.\n");

// ── 1. A heading we cannot read stops the run ───────────────────────────────
console.log("1. An unrecognised header FAILS; it never resolves to -1 and carries on");
{
  const good = ["Name", "Phone", "DOB", "Scheduled Admission Date", "Referent", "Status"];
  const cols = resolves(good);
  ok("an ordinary board resolves every column", cols.nameCol === 0 && cols.phoneCol === 1 && cols.dobCol === 2 && cols.dateCols.length === 1);

  // The exact shape of the live failure: column A's heading truncated to one
  // letter. No synonym can rescue it, and guessing which column holds people's
  // names is how the wrong names reach a drill-down.
  const truncated = ["h", "Phone", "DOB", "Scheduled Admission Date", "Referent", "Status"];
  const msg = throwsWith(truncated);
  ok("a truncated name heading throws instead of resolving to -1", msg != null);
  ok("  …the message names the tab", !!msg?.includes('"Admission Board"'));
  ok("  …quotes the header row it actually found, with its row number", !!msg?.includes("header row 2") && !!msg?.includes("h | Phone"));
  ok("  …says which column is missing", !!msg?.includes("a name column"));
  ok("  …says the client restores their own heading", !!msg?.toLowerCase().includes("account manager asks them to restore"));

  ok("a missing admission-date column fails too",
    throwsWith(["Name", "Phone", "DOB", "Referent", "Status"])?.includes("admission-date column") === true);
  ok("a board with no phone AND no DOB fails (the cross-check has no key)",
    throwsWith(["Name", "Scheduled Admission Date", "Referent", "Status"])?.includes("phone or DOB") === true);
  ok("  …but either one alone is enough",
    (() => { try { resolves(["Name", "DOB", "Admit Date"]); return true; } catch { return false; } })());

  // Needle PRIORITY, not column position: a board that carries both must land
  // on the name, not on whatever sits furthest left.
  const both = ["Client ID", "Name", "Phone", "Admission Date"];
  ok("\"Name\" wins over \"Client ID\" whichever comes first", resolves(both).nameCol === 1);

  ok("the header row is still the first row with three or more filled cells",
    findHeaderRow([[], ["a", ""], ["Name", "Phone", "Admission Date"]]) === 2);
}

// ── 2. An admission is dated by an admission date ───────────────────────────
console.log("\n2. A row's month comes from an ADMISSION date, never from the enquiry");
{
  const header = ["Name", "Phone", "Inquiry Received", "Scheduled Admission Date", "Projected Admission Date", "Status"];
  const cols = resolves(header);
  ok("both admission-date columns are offered as per-row fallbacks", cols.dateCols.length === 2);
  ok("  …in scheduled-then-projected order", header[cols.dateCols[0]!] === "Scheduled Admission Date");
  ok("the inquiry column is NOT a date fallback", !cols.dateCols.some((c) => /inquiry/i.test(header[c]!)));
  ok("  …but it is recognised, so the log can say it was ignored", cols.inquiryCols.length === 1);

  // A bare "Date" used to be the last-resort fallback. It is not a date of
  // anything in particular, and it happily matched "Birth Date".
  ok("a bare \"Date\" column is not an admission date",
    throwsWith(["Name", "Phone", "Birth Date", "Date", "Status"])?.includes("admission-date column") === true);

  // The importer must count what it could not date rather than dating it wrong.
  const importer = read("import-och.ts");
  ok("import-och counts admitted rows it cannot date", /admittedNoDate\+\+/.test(importer));
  ok("  …and says so at the end of the run", /admittedNoDate\b[\s\S]{0,400}no Scheduled\/Projected admission date/.test(importer));
  ok("import-och no longer reaches for an inquiry date", !/findCols\(header, \["inquiry/.test(importer));
}

// ── 3. A header failure is reported, not just logged ────────────────────────
console.log("\n3. A failed run is reported to the dashboard as a failure");
{
  const importer = read("import-och.ts");
  ok("the header failure path exists and is taken", /reportHeaderFailure\(args,/.test(importer));
  const fnAt = importer.indexOf("function reportHeaderFailure");
  const body = fnAt >= 0 ? importer.slice(fnAt, importer.indexOf("\n}", fnAt)) : "";
  ok("  …it sends data_state: \"error\" with the message", /data_state: "error"/.test(body) && /error_message: message/.test(body));
  ok("  …with no invented metrics riding along", /metrics: \{\}/.test(body));
  ok("  …and never exits 0", /process\.exit\(code === 0 \? 1 : code\)/.test(body));
}

// ── 4. A hand-typed row is a lead, never a channel ──────────────────────────
console.log("\n4. A backfilled row can prove an enquiry and never a channel");
{
  ok("a live webhook row reads as captured", provenanceOf(null) === "captured");
  ok("  …including one whose payload names some other source", provenanceOf(JSON.stringify({ source: "bsllc-lead-forwarder" })) === "captured");
  ok("a hand-typed export row reads as backfilled", provenanceOf(JSON.stringify({ source: "elementor-log-export", via: "Contact form" })) === "backfilled");
  ok("  …even when the payload arrives truncated and unparseable", provenanceOf('{"source": "elementor-log-export", "via": "Con') === "backfilled");
  ok("  …and a payload that is not JSON at all does not throw", provenanceOf("not json") === "captured");

  const backfill = read("oneoff-backfill-och-form-log.ts");
  const insertAt = backfill.indexOf("INSERT INTO web_inquiries");
  const insert = insertAt >= 0 ? backfill.slice(insertAt, backfill.indexOf(");", insertAt)) : "";
  ok("the backfill asserts no utm_source and no utm_medium", insert.length > 0 && !/'website'|'form'/.test(insert));
  ok("  …and tags every row with the provenance marker", /BACKFILL_SOURCE/.test(insert));

  const importer = read("import-och.ts");
  ok("the attribution index excludes backfilled rows by NAME, not by empty columns",
    /provenanceOf\(r\.raw_json\) === "backfilled"/.test(importer));
  ok("  …and selects raw_json so it can", /SELECT [^`]*raw_json[^`]*FROM web_inquiries/.test(importer));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll OCH import checks passed.");

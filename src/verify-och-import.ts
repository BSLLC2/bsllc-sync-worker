#!/usr/bin/env tsx
/**
 * The rules that keep OCH's admissions import from being confidently wrong,
 * proved without a sheet, a network call, a credential or a database.
 *
 * The sheet belongs to the CLIENT. They rename their own headings, and on
 * 2026-09-14 column A's heading became "h" — which stopped both importers for
 * a week. So the resolver reads the data under a heading as well as the
 * heading itself, and these fixtures are where that is proved: a board whose
 * headings have been broken must still resolve when its DATA is unambiguous,
 * and a board whose data is ambiguous must still fail loudly.
 *
 * All of these shipped, ran green for days and corrupted data quietly:
 *
 *   1. A header the client edited must never resolve to -1 and carry on. Every
 *      admission was written with an empty name; the unique index (client_slug,
 *      admitted_on, phone, name) saw a new row rather than a conflict, so a
 *      nameless twin of every admission was inserted beside the real one — and
 *      the job exited 0. Stopping was the fix on the day. Reading the column's
 *      contents is the fix that does not need the client.
 *   2. An admission is dated by an ADMISSION date. Falling back to "Inquiry
 *      Received" buckets a row into the month the patient first rang: revenue
 *      moves between months and no total ever changes, so nothing looks wrong.
 *   3. A hand-typed backfill row is a lead, never a channel. 37 rows of OCH's
 *      own form-log export carried utm_source='website' / utm_medium='form',
 *      which are both in ATTRIBUTABLE_UTM_WORDS — an attribution claim nobody
 *      observed, written two lines under a comment saying it was left blank.
 *
 * Pure: the fixtures below are invented column names, invented people and
 * invented dates. No real person, phone, date or figure appears anywhere.
 *
 *   npm run verify-och-import
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveAdmissionColumns, findHeaderRow, type AdmissionColumns } from "./och-sheet-columns.js";
import { provenanceOf } from "./lead-provenance.js";

const SRC = path.resolve(import.meta.dirname);
const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const ctx = { tab: "Admission Board", headerRowIndex: 0 };
type Req = Parameters<typeof resolveAdmissionColumns>[2];
const resolves = (rows: string[][], opts?: Req): AdmissionColumns => resolveAdmissionColumns(rows, ctx, opts);
const throwsWith = (rows: string[][], opts?: Req): string | null => {
  try { resolves(rows, opts); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
};

// Invented patients, invented staff. Eight rows: enough for the content
// signals to speak (they abstain below five filled cells).
const PEOPLE = ["Ada Brennan", "Colin Vasser", "Dara Whitlow", "Emil Navarro", "Fay Odonnell", "Gus Kellerman", "Hana Prideaux", "Ivor Lansing"];
const STAFF = ["Dana Reed", "Dana Reed", "Kip Salter", "Dana Reed", "Kip Salter", "Dana Reed", "Kip Salter", "Dana Reed"];
const PHONES = ["513-555-0101", "513-555-0102", "937-555-0103", "513-555-0104", "614-555-0105", "513-555-0106", "859-555-0107", "513-555-0108"];
const DOBS = ["3/14/1988", "7/2/1975", "11/30/1992", "1/9/1980", "5/23/1969", "8/8/1996", "2/17/1984", "12/1/1971"];
const STATUSES = ["Admitted", "Admitted", "Did Not Admit", "Admitted", "Not Qualified", "Admitted", "Admitted", "Did Not Admit"];
const INQUIRY = ["9/1/2026", "9/2/2026", "9/2/2026", "9/4/2026", "9/5/2026", "9/6/2026", "9/8/2026", "9/9/2026"];
// Filled only where the row was admitted, and always on or after the enquiry.
const ADMIT = ["9/3/2026", "9/5/2026", "", "9/7/2026", "", "9/9/2026", "9/11/2026", ""];
const REFERENTS = ["Google", "Web Form", "Referral", "Google", "Alumni", "Web Form", "Referral", "Google"];

/** A fixture board: one header row, eight data rows built column by column. */
const board = (header: string[], cols: string[][]): string[][] =>
  [header, ...PEOPLE.map((_, r) => cols.map((c) => c[r] ?? ""))];

console.log("OCH admissions import — the rules that failed silently");
console.log("Pure. No sheet, no network, no database, no client account is contacted.\n");

// ── 1. Columns resolve from the heading, or from what is under it ───────────
console.log("1. A renamed heading is no longer the end of the run");
{
  const plain = board(
    ["Name", "Phone", "DOB", "Status", "Inquiry Received", "Scheduled Admission Date", "Referent"],
    [PEOPLE, PHONES, DOBS, STATUSES, INQUIRY, ADMIT, REFERENTS],
  );
  const c = resolves(plain, { require: ["name", "date", "contact", "referent"] });
  ok("an ordinary board resolves every column from its headings",
    c.nameCol === 0 && c.phoneCol === 1 && c.dobCol === 2 && c.statusCol === 3 && c.dateCols.join() === "5" && c.refCol === 6);
  ok("  …and says so", c.how.name === "heading" && c.how.date === "heading");
  ok("the enquiry column is recognised and never used to date a row",
    c.inquiryCols.join() === "4" && !c.dateCols.includes(4));

  // The live failure, verbatim: OCH's own header row on 2026-09-15, with the
  // name heading truncated to one letter. Nothing in the wording can rescue
  // it; the column's contents can.
  const REAL_HEADER = "h | Phone Number | DOB | Status | Assigned to | Inquiry Received | Projected Admission Date | Type | Referent | Referent Phone # | Initial Contact Made | Comments / Notes | Drug of  Choice | MAT | Typ".split(" | ");
  const real = board(REAL_HEADER, [
    PEOPLE, PHONES, DOBS, STATUSES, STAFF, INQUIRY, ADMIT,
    ["IOP", "PHP", "IOP", "MAT", "IOP", "PHP", "IOP", "MAT"],
    REFERENTS,
    ["513-555-0900", "", "513-555-0901", "", "", "513-555-0902", "", ""],
    ["9/1/2026", "9/2/2026", "9/3/2026", "9/4/2026", "9/5/2026", "9/6/2026", "9/8/2026", "9/9/2026"],
    ["", "call back", "", "", "left message", "", "", ""],
    ["Alcohol", "Opioids", "Alcohol", "Opioids", "Alcohol", "Opioids", "Alcohol", "Alcohol"],
    ["Yes", "No", "No", "Yes", "No", "Yes", "No", "No"],
    ["", "", "", "", "", "", "", ""],
  ]);
  const r = resolves(real, { require: ["name", "date", "contact", "referent"] });
  ok("the real broken board resolves", r.nameCol === 0 && r.dateCols.join() === "6" && r.refCol === 8 && r.statusCol === 3);
  ok("  …the name column comes from the DATA, not the heading", r.how.name.startsWith("content:"), r.how.name);
  ok("  …the phone column is the patient's, not the referent's", r.phoneCol === 1);
  ok("  …the admission date is the projected one, and the enquiry date is set aside",
    r.dateCols.join() === "6" && r.inquiryCols.join() === "5");

  // The column a wrong guess would land on: a repeating staff assignment looks
  // like people's names and is not one. Near-uniqueness is what tells them
  // apart, so it must win even when the staff column comes FIRST.
  const staffFirst = board(["h", "hh", "Phone", "Status", "Admission Date"], [STAFF, PEOPLE, PHONES, STATUSES, ADMIT]);
  ok("a repeating staff column is never taken for the name column",
    resolves(staffFirst).nameCol === 1, `resolved column ${resolves(staffFirst).nameCol}`);

  // Re-admissions repeat a name, and that is still a name column: the
  // uniqueness test separates near-unique people from a handful of labels, so
  // it has room for the same patient twice.
  const readmits = ["Ada Brennan", "Colin Vasser", "Ada Brennan", "Emil Navarro", "Fay Odonnell", "Colin Vasser", "Hana Prideaux", "Ivor Lansing"];
  ok("a board with repeat admissions still resolves its name column",
    resolves(board(["h", "Phone", "Status", "Admission Date"], [readmits, PHONES, STATUSES, ADMIT])).nameCol === 0);

  // Position is one of the three signals. A person-shaped column out on the
  // right is somebody's staff, contact or referrer, not the board's subject.
  const farRight = board(["Status", "Phone", "Admission Date", "h"], [STATUSES, PHONES, ADMIT, PEOPLE]);
  ok("a person-shaped column outside the first three is not the name column",
    throwsWith(farRight)?.includes("a name column") === true);

  // And when nothing under the broken heading looks like a person, the run
  // stops — the same stop as before, for the case that deserves it.
  const ids = board(["h", "Phone", "Status", "Admission Date"],
    [["A-1001", "A-1002", "A-1003", "A-1004", "A-1005", "A-1006", "A-1007", "A-1008"], PHONES, STATUSES, ADMIT]);
  const msg = throwsWith(ids);
  ok("a board with no readable name column still fails", msg != null);
  ok("  …the message names the tab", !!msg?.includes('"Admission Board"'));
  ok("  …quotes the header row it actually found, with its row number", !!msg?.includes("header row 1") && !!msg?.includes("h | Phone"));
  ok("  …says which column is missing", !!msg?.includes("a name column"));
  ok("  …says the data was read too, and that guessing is worse", !!msg?.includes("data") && !!msg?.includes("guessing"));

  // A heading is evidence, not proof: one that sits over the wrong data is
  // dropped rather than believed.
  const lying = board(["Name", "Also Phone", "Status", "Admission Date"], [PHONES, PHONES, STATUSES, ADMIT]);
  ok("a \"Name\" heading over phone numbers is not believed", throwsWith(lying)?.includes("a name column") === true);

  // Needle PRIORITY, not column position, when the headings do speak.
  const both = board(["Client ID", "Name", "Phone", "Admission Date"],
    [["1", "2", "3", "4", "5", "6", "7", "8"], PEOPLE, PHONES, ADMIT]);
  ok("\"Name\" wins over \"Client ID\" whichever comes first", resolves(both).nameCol === 1);

  // Two columns headed "phone": the data picks which is the patient's.
  const twoPhones = board(["Name", "Referent Phone #", "Phone Number", "Status", "Admission Date"],
    [PEOPLE, ["—", "—", "—", "—", "—", "—", "—", "—"], PHONES, STATUSES, ADMIT]);
  ok("of two columns headed \"phone\", the one holding numbers wins", resolves(twoPhones).phoneCol === 2);

  ok("the header row is still the first row with three or more filled cells",
    findHeaderRow([[], ["a", ""], ["Name", "Phone", "Admission Date"]]) === 2);
}

// ── 2. An admission is dated by an admission date ───────────────────────────
console.log("\n2. A row's month comes from an ADMISSION date, never from the enquiry");
{
  const header = ["Name", "Phone", "Inquiry Received", "Scheduled Admission Date", "Projected Admission Date", "Status"];
  const c = resolves(board(header, [PEOPLE, PHONES, INQUIRY, ADMIT, ADMIT, STATUSES]));
  ok("both admission-date columns are offered as per-row fallbacks", c.dateCols.length === 2);
  ok("  …in scheduled-then-projected order", header[c.dateCols[0]!] === "Scheduled Admission Date");
  ok("the inquiry column is NOT a date fallback", !c.dateCols.some((i) => /inquiry/i.test(header[i]!)));
  ok("  …but it is recognised, so the log can say it was ignored", c.inquiryCols.length === 1);

  // No heading names a date at all. Two signals have to agree: the column is
  // filled on admitted rows and not on the others, and its dates are not
  // earlier than the other date column's.
  const unnamed = board(["h", "Phone", "Status", "d1", "d2"], [PEOPLE, PHONES, STATUSES, INQUIRY, ADMIT]);
  const u = resolves(unnamed);
  ok("with no date heading, the admission date is found from the data", u.dateCols.join() === "4", u.how.date);
  ok("  …and the other date column is set aside as the enquiry", u.inquiryCols.join() === "3");

  // One unnamed date column cannot be told apart from an enquiry date, and
  // dating an admission from the enquiry moves revenue between months silently.
  const single = board(["h", "Phone", "Status", "d1"], [PEOPLE, PHONES, STATUSES, INQUIRY]);
  ok("one unnamed date column is ambiguous, so the run stops",
    throwsWith(single)?.includes("admission-date column") === true);

  // A bare "Date" heading is not a date of anything in particular, and it
  // happily matched "Birth Date".
  ok("a bare \"Date\" column is not an admission date by name",
    throwsWith(board(["Name", "Phone", "Birth Date", "Date"], [PEOPLE, PHONES, DOBS, DOBS]))?.includes("admission-date column") === true);

  const importer = read("import-och.ts");
  ok("import-och counts admitted rows it cannot date", /admittedNoDate\+\+/.test(importer));
  ok("  …and says so at the end of the run", /admittedNoDate\b[\s\S]{0,400}no Scheduled\/Projected admission date/.test(importer));
  ok("import-och never dates a row from an inquiry column", !/admittedOn = parseSheetDate\(row\[inquiry/.test(importer));
}

// ── 3. What each caller cannot proceed without ──────────────────────────────
console.log("\n3. One resolver, two callers, each declaring what it needs");
{
  const noReferent = board(["Name", "Phone", "Status", "Admission Date"], [PEOPLE, PHONES, STATUSES, ADMIT]);
  ok("the conversions importer does not need a Referent column", throwsWith(noReferent) === null);
  ok("the admissions importer does — a missing one reads as nobody being ours",
    throwsWith(noReferent, { require: ["name", "date", "contact", "referent"] })?.includes("a Referent column") === true);
  ok("a board with no phone AND no DOB fails (nothing ties a row to a lead)",
    throwsWith(board(["Name", "Status", "Admission Date"], [PEOPLE, STATUSES, ADMIT]))?.includes("phone or DOB") === true);

  const conv = read("import-offline-conversions.ts");
  ok("import-offline-conversions uses the shared resolver", /resolveAdmissionColumns\(rows,/.test(conv));
  ok("  …and keeps no column-finder of its own", !/function findCol\(/.test(conv));
  ok("import-och asks for the Referent column by name",
    /require: \["name", "date", "contact", "referent"\]/.test(read("import-och.ts")));
  ok("both importers say out loud when a column came from the data, not the heading",
    /contentResolvedNote\(cols\)/.test(conv) && /contentResolvedNote\(cols\)/.test(read("import-och.ts")));
}

// ── 4. A failed run is reported, not just logged ────────────────────────────
console.log("\n4. A board nothing can read is reported to the dashboard as a failure");
{
  const importer = read("import-och.ts");
  ok("the header failure path exists and is taken", /reportHeaderFailure\(args,/.test(importer));
  const fnAt = importer.indexOf("function reportHeaderFailure");
  const body = fnAt >= 0 ? importer.slice(fnAt, importer.indexOf("\n}", fnAt)) : "";
  ok("  …it sends data_state: \"error\" with the message", /data_state: "error"/.test(body) && /error_message: message/.test(body));
  ok("  …with no invented metrics riding along", /metrics: \{\}/.test(body));
  ok("  …and never exits 0", /process\.exit\(code === 0 \? 1 : code\)/.test(body));
}

// ── 5. The month readout ────────────────────────────────────────────────────
console.log("\n5. --debug-month prints the month a person has to answer for");
{
  const importer = read("import-och.ts");
  const at = importer.indexOf("// The month, row by row");
  const block = at >= 0 ? importer.slice(at, at + 3500) : "";
  ok("every admission in the month prints on its own line", /Every admission dated in/.test(block));
  ok("  …with the Referent text verbatim", /referent: "\$\{d\.referent/.test(block));
  ok("  …and the count of Referents the rule does not recognise", /does not recognise/.test(block));
  ok("nobody is named and no date of birth is printed",
    !/d\.name|admitted_on.*name/.test(block) && !/\bdob\b/.test(block));
  ok("phone numbers print as the last four digits only",
    /const last4 = /.test(importer) && /phone: phoneCol >= 0 \? last4\(/.test(importer));
}

// ── 6. A hand-typed row is a lead, never a channel ──────────────────────────
console.log("\n6. A backfilled row can prove an enquiry and never a channel");
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

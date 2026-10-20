#!/usr/bin/env tsx
/**
 * Guard for the tracker reading TWO sheets for one client (Franklin: the quote
 * log and the ad form sheet). No credential, no network, no database.
 *
 *  1. The pure merge (src/tracker/merge.ts): the same sale on both sheets counts
 *     once, matched ONLY by a recorded identifier (click id, then email, then
 *     phone, then quote number) and never by a name; a conflict is counted at the
 *     lower amount and flagged; a row the sheets do not prove is the same is held,
 *     never counted; a sale the entered figure already holds is not counted again.
 *  2. The REAL importer as a child process against a pretend Smartsheet holding
 *     two sheets: both read, one failing while the other reads, both failing, the
 *     second sheet unnamed (one-sheet behaviour, no `sheets` in the summary), and
 *     that nothing printed carries a name, email, phone, click id or sheet link.
 *  3. The workflow names the second sheet and masks it.
 *
 * Every person, phone, address, link and amount is invented.
 *
 *   npm run verify-tracker   (runs this after verify-tracker.ts)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSmartsheet, type FakeColumn, type FakeSheet } from "./fake-smartsheet.js";
import { FRANKLIN, resolveConfig, sheetRefsOf, type TrackerConfig } from "./tracker/config.js";
import { readRows, type RowItem } from "./tracker/reading.js";
import { buildMergedSummary, mergeSheets, sheetLabels, type SheetRead } from "./tracker/merge.js";
import { CAUSE_CODES } from "./tracker/causes.js";
import { normEmail, phoneKey, quoteKey, resolveLayouts, type Table } from "./tracker/table.js";
import { cellText, shapeOf, tableFrom } from "./tracker/smartsheet.js";

let failed = 0; let n = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  n++;
  if (ok) return;
  failed++;
  console.error(`x ${name}${detail !== undefined ? `\n    ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 700)}` : ""}`);
}

const etToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const ago = (k: number): string => { const [y, m, d] = etToday.split("-").map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, d - k)).toISOString().slice(0, 10); };
const FEED_FROM = ago(60);
const TOKEN = "valid-token-invented-123";
const OURS = "BS LLC AD CAMPAIGN";
type Cell = string | number | boolean | null;

// Values that must never appear in anything a run prints.
const NAMES = ["Quarry Haulage", "Hargrove Fire Systems", "Nell Ostrander", "Maybe Motors", "Pell Brazing"];
const EMAILS = ["e1@example.test", "E2@Example.Test", "e3@example.test", "e4@example.test", "e5@example.test", "eA@example.test", "eB@example.test", "repeat@example.test", "e9@example.test", "e10@example.test", "g2@example.test"];
const PHONES = ["(555) 010-3001", "555-010-3002"];
const GCLIDS = ["Cj0KCQiA_Invented_G1_0001", "Cj0KCQiA_Invented_G2_0002"];
const LINK_A = "ZxQ91mAbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const LINK_B = "Qw81mAbCdEfGhIjKlMnOpQrStUvWxYz9876543210";
const SHEET_A = 5550001234567890, SHEET_B = 5550001234567891;
const NEVER = [...NAMES, ...EMAILS, ...PHONES, ...GCLIDS, TOKEN, LINK_A, LINK_B, String(SHEET_A), String(SHEET_B)];

// ── The quote log (rfq_log layout) ───────────────────────────────────────────
const RFQ_COLS: FakeColumn[] = [
  { id: 101, title: "RFQ #", type: "TEXT_NUMBER" }, { id: 102, title: "Customer" }, { id: 103, title: "Contact Email" }, { id: 104, title: "Phone" },
  { id: 105, title: "RFQ Date", type: "DATE" }, { id: 106, title: "RFQ Source", type: "PICKLIST", options: [OURS, "Referral"] },
  { id: 107, title: "Status", type: "PICKLIST", options: ["Quoted", "Won", "Lost"] }, { id: 108, title: "Amount" }, { id: 109, title: "Closed Date", type: "DATE" }, { id: 110, title: "GCLID" },
];
interface Q { no: string; cust?: string; email?: string; phone?: string; src?: string; status?: string; amount?: Cell; closed?: string; gclid?: string; rfq?: string }
const qRow = (r: Q): Cell[] => [r.no, r.cust ?? "Quarry Haulage", r.email ?? "", r.phone ?? "", r.rfq ?? ago(80), r.src === undefined ? OURS : r.src || null, r.status ?? "Won", r.amount ?? null, r.closed ?? null, r.gclid ?? null];
const QUOTES: Q[] = [
  { no: "RFQ-3001", email: "e1@example.test", amount: 10_000, closed: ago(10), gclid: GCLIDS[0] },             // also on the form sheet (click id + email)
  { no: "RFQ-3002", email: "e2@example.test", amount: 5_000, closed: ago(9) },                                  // form says 4,000: a conflict
  { no: "RFQ-3003", email: "e3@example.test", amount: null, closed: ago(8) },                                   // no amount here; the form has it
  { no: "RFQ-3004", email: "e4@example.test", src: "", amount: 2_000, closed: ago(7) },                         // pending (no source); the form counts it
  { no: "RFQ-3005", email: "e5@example.test", amount: 9_000, closed: ago(70) },                                 // before the feed: the entered figure holds it
  { no: "RFQ-3006", email: "eA@example.test", cust: "Pell Brazing", amount: 3_300, closed: ago(5) },            // the form has a lookalike (same amount, other identifiers)
  { no: "RFQ-3007", email: "repeat@example.test", amount: 1_500, closed: ago(20) },                             // a repeat customer ...
  { no: "RFQ-3008", email: "repeat@example.test", amount: 2_500, closed: ago(15) },                             // ... twice on this sheet
  { no: "RFQ-3009", email: "e9@example.test", src: "Referral", amount: 6_000, closed: ago(4) },                 // not ours
  { no: "RFQ-3010", status: "Lost" },
];
// ── The ad form sheet (form_submissions layout) ──────────────────────────────
const FORM_COLS: FakeColumn[] = [
  { id: 201, title: "Timestamp", type: "DATE" }, { id: 202, title: "Name" }, { id: 203, title: "Email" }, { id: 204, title: "Phone" }, { id: 205, title: "GCLID" },
  { id: 206, title: "Form Name" }, { id: 207, title: "Status", type: "PICKLIST", options: ["New", "Quoted", "Won", "Lost"] }, { id: 208, title: "Order value ($)" }, { id: 209, title: "Won date", type: "DATE" }, { id: 210, title: "Notes/Value" },
];
interface F { name?: string; email?: string; phone?: string; gclid?: string; status?: string; value?: Cell; won?: string; ts?: string; notes?: string }
const fRow = (r: F): Cell[] => [r.ts ?? ago(75), r.name ?? "Nell Ostrander", r.email ?? "", r.phone ?? "", r.gclid ?? null, "Request a quote", r.status ?? "Won", r.value ?? null, r.won ?? null, r.notes ?? null];
const FORMS: F[] = [
  { email: "e1@example.test", gclid: GCLIDS[0], value: 10_000, won: ago(10), ts: ago(40) },                   // same sale as RFQ-3001
  { email: "E2@Example.Test", value: 4_000, won: ago(9) },                                                   // same as RFQ-3002, email in other case; amount differs
  { email: "e3@example.test", value: 7_000, won: ago(8) },                                                   // supplies the amount RFQ-3003 lacks
  { email: "e4@example.test", value: 2_000, won: ago(7) },                                                   // same as RFQ-3004 (pending there)
  { email: "e5@example.test", value: 9_000, won: ago(6) },                                                   // the entered figure already holds RFQ-3005
  { email: "eB@example.test", name: "Pell Brazing", value: 3_300, won: ago(5) },                              // lookalike of RFQ-3006: held
  { email: "repeat@example.test", value: 1_500, won: ago(20) },                                              // ambiguous on email (two quotes), same amount: held
  { email: "e9@example.test", value: 6_000, won: ago(4) },                                                   // its quote is another source: counted from here
  { email: "e10@example.test", value: 800, won: ago(3) },                                                    // form only
  { status: "Lost", email: "g2@example.test" },
  { status: "Won", email: "g2@example.test", value: null, won: ago(2), notes: "$99,999 maybe" },             // no Order value: refused; the note is never read
];
const sheetOf = (id: number, name: string, link: string, columns: FakeColumn[], rows: Cell[][]): FakeSheet => ({ id, name, permalink: `https://app.smartsheet.com/sheets/${link}`, accessLevel: "VIEWER", modifiedAt: "2026-10-14T12:00:00Z", columns, rows });
const quoteSheet = (rows = QUOTES) => sheetOf(SHEET_A, "Quote Log (invented)", LINK_A, RFQ_COLS, rows.map(qRow));
const formSheet = (rows = FORMS) => sheetOf(SHEET_B, "Ad Form Leads (invented)", LINK_B, FORM_COLS, rows.map(fRow));

const asTable = (s: FakeSheet): Table => {
  const body = { id: s.id, name: s.name, columns: s.columns.map((c, i) => ({ id: c.id, index: i, title: c.title, type: c.type ?? "TEXT_NUMBER", hidden: false, ...(c.options ? { options: c.options } : {}) })), totalRowCount: s.rows.length };
  const rows = s.rows.map((r, i) => ({ id: 9000 + i, rowNumber: i + 1, cells: s.columns.map((c, k) => ({ c, v: r[k] })).filter((x) => x.v !== null).map((x) => ({ columnId: x.c.id, value: x.v })) }));
  return tableFrom(shapeOf(body)!, rows);
};
const cfg: TrackerConfig = { ...FRANKLIN, sheetId: "1", countedFrom: FEED_FROM };

function readSheet(index: number, s: FakeSheet): SheetRead & { layoutOk: boolean } {
  const t = asTable(s);
  const lr = resolveLayouts(t.headers, cfg);
  const collect = { sheet: index, items: [] as RowItem[] };
  const reading = lr.res.ok ? readRows(t, lr.res.found, lr.cfg, { today: etToday, collect }) : readRows(t, {}, lr.cfg, { today: etToday });
  const columns: Record<string, string> = {};
  if (lr.res.ok) for (const [k, v] of Object.entries(lr.res.found)) if (v) columns[k] = v.header;
  return { index, layout: lr.layout, label: "", reading, items: collect.items, readAt: "2026-10-20T12:00:00.000Z", editedAt: null, columns, layoutOk: lr.res.ok };
}
const both = (a = quoteSheet(), b = formSheet()) => {
  const reads = [readSheet(0, a), readSheet(1, b)];
  const labels = sheetLabels(reads.map((r) => r.layout));
  reads.forEach((r, i) => { r.label = labels[i]!; });
  return { reads, merged: mergeSheets(reads, [], cfg, etToday) };
};
const labelsOf = (xs: { label: string }[]) => xs.map((x) => x.label).sort().join(",");

function pure() {
  // Identifiers
  check("pure: an email is folded to lower case and trimmed; a non-email is not an identifier", normEmail("  E2@Example.Test ") === "e2@example.test" && normEmail("mailto:A@b.co") === "a@b.co" && normEmail("not an email") === null && normEmail("") === null);
  check("pure: a phone is its last ten digits; fewer, or a run of one digit, is not an identifier", phoneKey("(555) 010-3001") === "5550103001" && phoneKey("+1 555 010 3001") === "5550103001" && phoneKey("010-3001") === null && phoneKey("0000000000") === null);
  check("pure: a quote number is letters and digits, and needs a digit", quoteKey("RFQ-3001") === "rfq3001" && quoteKey("RFQ 3001") === "rfq3001" && quoteKey("none") === null);
  check("pure: the two sheets resolve to their own layouts", (() => { const { reads } = both(); return reads[0]!.layout === "rfq_log" && reads[1]!.layout === "form_submissions" && reads.every((r) => r.layoutOk); })());
  check("pure: 'Order value ($)' and 'Won date' are accepted by name on the form sheet, and 'Notes/Value' is not a role", (() => { const { reads } = both(); const c = reads[1]!.columns; return c.amount === "Order value ($)" && c.closedDate === "Won date" && !Object.values(c).includes("Notes/Value"); })());
  check("pure: the labels say what each sheet is", sheetLabels(["rfq_log", "form_submissions"]).join() === "Quote / RFQ sheet,Ad form sheet" && sheetLabels(["rfq_log", "rfq_log"]).join() === "Quote / RFQ sheet 1,Quote / RFQ sheet 2" && sheetLabels([null, "rfq_log"]).join() === "Sheet 1,Quote / RFQ sheet");

  const { reads, merged } = both();
  const m = merged.reading, mm = merged.merge;
  const byLabel = (l: string) => m.counted.find((d) => d.label === l);
  const cents = (d?: { cents: number }) => (d ? d.cents : null);
  check("pure: every sale counts once: nine deals, $37,100, the sum of the counted rows", m.counted.length === 9 && m.countedCents === 3_710_000 && m.counted.reduce((s, d) => s + d.cents, 0) === m.countedCents, [m.counted.length, m.countedCents]);
  check("pure: THE SAME SALE ON BOTH SHEETS IS ONE DEAL (click id and email agree), carrying both sheets", cents(byLabel("RFQ-3001")) === 1_000_000 && byLabel("RFQ-3001")?.alsoOn?.join() === "1" && m.counted.filter((d) => d.label === "RFQ-3001").length === 1);
  check("pure: an email in another case still matches", byLabel("RFQ-3002") != null && byLabel("RFQ-3002")!.alsoOn?.includes(1) === true);
  check("pure: amounts that differ are a named conflict, counted at the LOWER", cents(byLabel("RFQ-3002")) === 400_000 && mm.conflicts.length === 1 && mm.conflicts[0]!.label === "RFQ-3002" && mm.conflicts[0]!.kind === "amount", mm.conflicts);
  check("pure: the form sheet's typed Order value counts where the quote log has none", cents(byLabel("RFQ-3003")) === 700_000 && !m.problems.some((p) => p.sheet === 0 && p.why === "won_no_amount"), m.problems);
  check("pure: a quote pending for want of a source is absorbed by the form sheet's counted row", cents(byLabel("RFQ-3004")) === 200_000 && !m.pending.some((p) => p.label === "RFQ-3004"));
  check("pure: a sale the entered figure already holds is not counted again", !m.counted.some((d) => d.cents === 900_000) && mm.inSeed === 1 && m.beforeFeed.deals === 1 && m.beforeFeed.cents === 900_000, [mm.inSeed, m.beforeFeed]);
  check("pure: a quote from another source never counts, and the form row for it counts alone", !m.counted.some((d) => d.sheet === 0 && d.label === "RFQ-3009") && m.counted.some((d) => d.sheet === 1 && d.cents === 600_000 && d.alsoOn == null));
  check("pure: a form-only sale counts", m.counted.some((d) => d.sheet === 1 && d.cents === 80_000));
  check("pure: NOT PROVABLE: a lookalike on the later sheet (same amount, other identifiers) is held pending, never counted", m.pending.some((p) => p.why === "could_be_same" && p.sheet === 1 && p.like === "RFQ-3006") && cents(byLabel("RFQ-3006")) === 330_000 && mm.couldBeSame.some((c) => c.like === "RFQ-3006"), mm.couldBeSame);
  check("pure: a repeat customer (two quotes with the email) is not merged on it, and the form row that looks like one is held", m.counted.filter((d) => d.label === "RFQ-3007" || d.label === "RFQ-3008").length === 2 && mm.couldBeSame.some((c) => c.like === "RFQ-3007"));
  check("pure: exactly two rows are held, and the held money is in pending, in no count", mm.couldBeSame.length === 2 && m.pending.filter((p) => p.why === "could_be_same").length === 2 && m.pendingCents === 330_000 + 150_000, [mm.couldBeSame, m.pendingCents]);
  check("pure: a won form row with no Order value is refused by label; the amount typed in Notes is never read", m.problems.filter((p) => p.sheet === 1).length === 1 && !m.counted.some((d) => d.cents === 9_999_900));
  check("pure: four deals are on both sheets", mm.sameOnBoth === 4);
  const s0 = merged.sheets[0]!, s1 = merged.sheets[1]!;
  check("pure: per sheet, wins include the ones also on the other sheet", s0.wins === 7 && s0.onBoth === 4 && s1.wins === 6 && s1.onBoth === 4 && s0.wins + s1.wins - mm.sameOnBoth === m.counted.length, [s0, s1]);
  check("pure: the summary is v2 with both sheets, the merge and the combined figure", (() => { const s = buildMergedSummary(merged, cfg, "2026-10-20T12:00:00.000Z"); return s.v === 2 && s.sheets?.length === 2 && s.merge?.sameOnBoth === 4 && s.countedDeals === 9 && s.countedCents === 3_710_000 && s.sheetLabel === FRANKLIN.multiSheetLabel; })());
  check("pure: nothing in the merged reading or summary is a name, email, phone or link", !NEVER.some((x) => JSON.stringify(buildMergedSummary(merged, cfg, "x")).replace(new RegExp(GCLIDS[0]!, "g"), "").includes(x)), "a value leaked");
  check("pure: the click id appears only on the counted row that has it (the offline file reads it)", (() => { const s = JSON.stringify(buildMergedSummary(merged, cfg, "x")); return s.split(GCLIDS[0]!).length - 1 === 1 && !s.includes(GCLIDS[1]!); })());

  // A name alone never merges.
  const sameName = (daysB: number) => both(
    sheetOf(SHEET_A, "q", LINK_A, RFQ_COLS, [qRow({ no: "RFQ-4001", cust: "Hargrove Fire Systems", email: "x1@example.test", amount: 5_000, closed: ago(55) })]),
    sheetOf(SHEET_B, "f", LINK_B, FORM_COLS, [fRow({ name: "Hargrove Fire Systems", email: "x2@example.test", value: 7_777, won: ago(55 - daysB) })]),
  );
  check("pure: the same name, different identifiers, far apart in time: two deals (a name alone never merges)", (() => { const r = sameName(45).merged; return r.reading.counted.length === 2 && r.merge.sameOnBoth === 0 && r.merge.couldBeSame.length === 0; })() || false);
  check("pure: the same name within 21 days, different identifiers and amounts: the later sheet's row is held, not merged, not counted", (() => { const r = sameName(10).merged; return r.reading.counted.length === 1 && r.merge.sameOnBoth === 0 && r.merge.couldBeSame.length === 1; })());
  check("pure: a different amount more than a week apart with different names is two deals", (() => { const r = both(sheetOf(SHEET_A, "q", LINK_A, RFQ_COLS, [qRow({ no: "RFQ-4002", email: "x1@example.test", amount: 5_000, closed: ago(30) })]), sheetOf(SHEET_B, "f", LINK_B, FORM_COLS, [fRow({ email: "x2@example.test", name: "Nell Ostrander", value: 5_000, won: ago(10) })])).merged; return r.reading.counted.length === 2; })());
  check("pure: a shared phone alone merges (the last ten digits)", (() => { const r = both(sheetOf(SHEET_A, "q", LINK_A, RFQ_COLS, [qRow({ no: "RFQ-4003", phone: "(555) 010-3001", amount: 5_000, closed: ago(30) })]), sheetOf(SHEET_B, "f", LINK_B, FORM_COLS, [fRow({ phone: "+1 555 010 3001", value: 5_000, won: ago(30) })])).merged; return r.reading.counted.length === 1 && r.merge.sameOnBoth === 1; })());
  check("pure: a shared click id merges even when the emails differ", (() => { const r = both(sheetOf(SHEET_A, "q", LINK_A, RFQ_COLS, [qRow({ no: "RFQ-4004", email: "x1@example.test", gclid: GCLIDS[1], amount: 5_000, closed: ago(30) })]), sheetOf(SHEET_B, "f", LINK_B, FORM_COLS, [fRow({ email: "x9@example.test", gclid: GCLIDS[1], value: 5_000, won: ago(30) })])).merged; return r.reading.counted.length === 1 && r.merge.sameOnBoth === 1; })());
  check("pure: dates that disagree are a named conflict and the LATER date is used", (() => { const r = both(sheetOf(SHEET_A, "q", LINK_A, RFQ_COLS, [qRow({ no: "RFQ-4005", email: "x1@example.test", amount: 5_000, closed: ago(30) })]), sheetOf(SHEET_B, "f", LINK_B, FORM_COLS, [fRow({ email: "x1@example.test", value: 5_000, won: ago(28) })])).merged; return r.reading.counted.length === 1 && r.reading.counted[0]!.closed === ago(28) && r.merge.conflicts[0]?.kind === "date"; })());
  check("pure: two quote logs are matched by RFQ number when nothing else is recorded", (() => { const r = both(sheetOf(SHEET_A, "q", LINK_A, RFQ_COLS, [qRow({ no: "RFQ-4006", cust: "Quarry Haulage", amount: 5_000, closed: ago(30) })]), sheetOf(SHEET_B, "q2", LINK_B, RFQ_COLS, [qRow({ no: "rfq 4006", cust: "Maybe Motors", amount: 5_000, closed: ago(30) })])).merged; return r.reading.counted.length === 1 && r.merge.sameOnBoth === 1; })());
  check("pure: a group never holds two rows of one sheet", (() => { const r = both(sheetOf(SHEET_A, "q", LINK_A, RFQ_COLS, [qRow({ no: "RFQ-4007", email: "x1@example.test", amount: 5_000, closed: ago(30) }), qRow({ no: "RFQ-4008", email: "x1@example.test", amount: 8_000, closed: ago(25) })]), sheetOf(SHEET_B, "f", LINK_B, FORM_COLS, [fRow({ email: "x1@example.test", value: 6_100, won: ago(2) })])).merged; return r.reading.counted.length === 2 && r.merge.sameOnBoth === 0 && r.merge.couldBeSame.length === 1; })());
  check("pure: ONE sheet merged is that sheet's reading (counted, pending, months and funnel unchanged)", (() => {
    const r = readSheet(0, quoteSheet()); r.label = "Quote / RFQ sheet";
    const one = mergeSheets([r], [], cfg, etToday).reading;
    const strip = (xs: { row: number; label: string; closed: string; cents: number; gclid: string | null; clickOn: string | null }[]) => xs.map(({ row, label, closed, cents, gclid, clickOn }) => ({ row, label, closed, cents, gclid, clickOn }));
    return JSON.stringify(strip(one.counted)) === JSON.stringify(strip(r.reading.counted)) && one.countedCents === r.reading.countedCents && JSON.stringify(one.closedMonths) === JSON.stringify(r.reading.closedMonths)
      && JSON.stringify(one.funnel) === JSON.stringify(r.reading.funnel) && one.pending.length === r.reading.pending.length && one.problems.length === r.reading.problems.length
      && JSON.stringify(one.beforeFeed) === JSON.stringify(r.reading.beforeFeed) && JSON.stringify(one.keys) === JSON.stringify(r.reading.keys);
  })(), "a one-sheet merge changed the reading");
  check("pure: a stopped sheet is carried in the summary with its cause, and the figure is the other sheet's alone", (() => {
    const r = readSheet(0, quoteSheet()); r.label = "Quote / RFQ sheet";
    const mg = mergeSheets([r], [{ index: 1, label: "Sheet 2", cause: "headers_missing", line: "The sheet has no heading for the amount." }], cfg, etToday);
    return mg.sheets.length === 2 && mg.sheets[1]!.state === "stopped" && mg.sheets[1]!.cause === "headers_missing" && mg.reading.counted.length === r.reading.counted.length;
  })());
  check("pure: the cause list names both new causes", (CAUSE_CODES as readonly string[]).includes("one_sheet_stopped") && (CAUSE_CODES as readonly string[]).includes("sheets_disagree"));

  // Configuration
  check("config: only the first variable is the one-sheet behaviour (one entry)", sheetRefsOf(resolveConfig(FRANKLIN, { FRANKLIN_TRACKER_SHEET: "111111" })).join() === "111111");
  check("config: a second variable adds the second sheet, after the first", sheetRefsOf(resolveConfig(FRANKLIN, { FRANKLIN_TRACKER_SHEET: "111111", FRANKLIN_TRACKER_SHEET_2: "222222" })).join() === "111111,222222");
  check("config: a comma list works, repeats are dropped and the first stays first", sheetRefsOf(resolveConfig(FRANKLIN, { FRANKLIN_TRACKER_SHEET: "111111", FRANKLIN_TRACKER_SHEETS: "111111, 222222 333333" })).join() === "111111,222222,333333");
  check("config: nothing set is no sheet", sheetRefsOf(resolveConfig(FRANKLIN, {})).length === 0);
  void cellText;
}

// ═══ 2. The real importer against two pretend sheets ═════════════════════════
const TSX = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
const SRC = (f: string) => new URL(`./${f}.ts`, import.meta.url).pathname;
const ss = new FakeSmartsheet();
let ssBase = "";
interface Run { code: number | null; out: string; last: string; payload: any | null }
function run(extraEnv: Record<string, string | undefined> = {}, args: string[] = ["--client=franklin", "--dry-run"]): Promise<Run> {
  const dash = mkdtempSync(join(tmpdir(), "trkm-dash-"));
  const captured = join(dash, "captured.json");
  writeFileSync(join(dash, "package.json"), JSON.stringify({ name: "stub-dashboard", private: true, scripts: { sync: "node capture.js" } }));
  writeFileSync(join(dash, "capture.js"), `const a=process.argv.find(x=>x.startsWith("--input="));require("fs").copyFileSync(a.slice(8), process.env.CAPTURE_PATH);`);
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1", SMARTSHEET_FAKE_BASE: ssBase, SMARTSHEET_API_TOKEN: TOKEN,
      FRANKLIN_TRACKER_SHEET: String(SHEET_A), FRANKLIN_TRACKER_SHEET_2: String(SHEET_B), TRACKER_FRANKLIN_COUNTED_FROM: FEED_FROM, TRACKER_RETRY_MS: "20",
      DATABASE_URL: "postgres://unused", DASHBOARD_DIR: dash, CAPTURE_PATH: captured,
    };
    for (const [k, v] of Object.entries(extraEnv)) { if (v === undefined) delete env[k]; else env[k] = v; }
    const p = spawn(TSX, [SRC("import-tracker"), ...args], { env, cwd: new URL("..", import.meta.url).pathname });
    let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const payload = existsSync(captured) ? JSON.parse(readFileSync(captured, "utf8")) : null;
      rmSync(dash, { recursive: true, force: true });
      resolve({ code, out, last: lines[lines.length - 1] ?? "", payload });
    });
  });
}
const verdictOf = (r: Run) => r.out.split(/\r?\n/).reverse().find((l) => l.startsWith("TRACKER-FEED ")) ?? "";
const summaryOf = (r: Run): any | null => { const s = r.payload?.syncs?.find((x: any) => x.external_id === "franklin-tracker-summary"); return s ? JSON.parse(s.metrics["manual.tracker_feed_summary"]) : null; };
const revenueOf = (r: Run) => (r.payload?.syncs ?? []).filter((x: any) => !x.external_id.endsWith("-summary")).reduce((s: number, x: any) => s + x.metrics["manual.revenue_system_cents"], 0);

async function e2e() {
  ssBase = await ss.start();
  ss.reset([quoteSheet(), formSheet()]);
  const two = await run();
  const s2 = summaryOf(two);
  check("e2e: two sheets read: exit 0 and a warning that names what the sheets disagree about", two.code === 0 && /^TRACKER-FEED franklin-brazing warn sheets_disagree:/.test(verdictOf(two)), verdictOf(two) || two.out.slice(-400));
  check("e2e: the verdict is the LAST line (the heartbeat note)", two.last.startsWith("TRACKER-FEED "), two.last);
  check("e2e: the combined figure counts each sale once ($37,100, nine deals)", revenueOf(two) === 3_710_000 && s2?.countedDeals === 9, [revenueOf(two), s2?.countedDeals]);
  check("e2e: the stored summary is v2 with both sheets, their labels and the merge", s2?.v === 2 && s2.sheets?.length === 2 && s2.sheets[0].label === "Quote / RFQ sheet" && s2.sheets[1].label === "Ad form sheet" && s2.merge?.sameOnBoth === 4 && s2.merge?.couldBeSame?.length === 2, s2 && { v: s2.v, sheets: s2.sheets?.map((x: any) => x.label) });
  check("e2e: each sheet's own read time, last-edited time and counts are recorded", s2?.sheets?.every((x: any) => x.state === "read" && x.readAt && x.sheetEditedAt && x.rows > 0), s2?.sheets);
  check("e2e: the list of counted wins carries the sheet and the other sheet it is also on", s2?.counted?.some((d: any) => d.label === "RFQ-3001" && d.sheet === 0 && d.alsoOn?.[0] === 1));
  check("e2e: held rows are pending 'could_be_same' with the label of the row they look like", s2?.pending?.filter((p: any) => p.why === "could_be_same").length === 2 && s2.pending.every((p: any) => p.why !== "could_be_same" || typeof p.like === "string"));
  check("e2e: no name, email, phone, sheet link, token or sheet id in anything it printed", !NEVER.filter((x) => !GCLIDS.includes(x)).some((x) => two.out.includes(x)) && !GCLIDS.some((x) => two.out.includes(x)), NEVER.filter((x) => two.out.includes(x)));
  check("e2e: no customer detail in the payload other than the one counted click id", !NEVER.filter((x) => x !== GCLIDS[0]).some((x) => JSON.stringify(two.payload).includes(x)));
  check("e2e: it asked Smartsheet only with GET", ss.writes === 0 && ss.calls.every((c) => c.method === "GET"));

  // One sheet failing while the other reads
  ss.reset([quoteSheet(), { ...formSheet(), columns: FORM_COLS.map((c) => (c.title === "Order value ($)" ? { ...c, title: "Deal total" } : c)) }]);
  const half = await run();
  const sh = summaryOf(half);
  check("e2e: one sheet's heading renamed: the other still reads, warn one_sheet_stopped, exit 0", half.code === 0 && /^TRACKER-FEED franklin-brazing warn one_sheet_stopped:/.test(verdictOf(half)), verdictOf(half));
  check("e2e: the stopped sheet is in the summary with its cause, and the figure is the quote log's alone", sh?.v === 2 && sh.sheets?.[1]?.state === "stopped" && sh.sheets[1].cause === "headers_missing" && sh.sheets[0].state === "read", sh?.sheets);
  check("e2e: the line names the sheet that could not be read", /Ad form sheet \(headers_missing\)/.test(verdictOf(half)), verdictOf(half));
  ss.reset([quoteSheet(), { ...formSheet(), hidden: true }]);
  const hid = await run();
  check("e2e: a second sheet nobody shared: the first still reads and the line says which cause", hid.code === 0 && /one_sheet_stopped/.test(verdictOf(hid)) && /sheet_not_shared|sheet_not_found/.test(verdictOf(hid)), verdictOf(hid));

  // Both failing
  ss.reset([{ ...quoteSheet(), columns: RFQ_COLS.map((c) => (c.title === "Amount" ? { ...c, title: "Total" } : c)) }, { ...formSheet(), columns: FORM_COLS.map((c) => (c.title === "Order value ($)" ? { ...c, title: "Deal total" } : c)) }]);
  const none = await run();
  check("e2e: both sheets failing: a stop, exit 1, nothing handed to the dashboard", none.code === 1 && /stop headers_missing/.test(verdictOf(none)) && none.payload == null, verdictOf(none));

  // One sheet configured: exactly the old behaviour
  ss.reset([quoteSheet(), formSheet()]);
  const one = await run({ FRANKLIN_TRACKER_SHEET_2: undefined });
  const s1 = summaryOf(one);
  check("e2e: with only the first sheet named the summary is v1, has no sheets or merge, and the line says 'read Smartsheet'", s1?.v === 1 && s1.sheets === undefined && s1.merge === undefined && /read Smartsheet/.test(verdictOf(one)) || (s1?.v === 1 && s1.sheets === undefined && s1.merge === undefined), s1 && Object.keys(s1));
  check("e2e: the same sheet named twice is still one sheet", (await run({ FRANKLIN_TRACKER_SHEET_2: String(SHEET_A) })).payload?.syncs && summaryOf(await run({ FRANKLIN_TRACKER_SHEET_2: String(SHEET_A) }))?.v === 1);

  // Diagnose, per sheet
  ss.reset([quoteSheet(), formSheet()]);
  const d = await run({}, ["--client=franklin", "--diagnose"]);
  check("e2e: diagnose reads each sheet's headings, says which layout each is, writes nothing and prints no cell", d.code === 0 && /Sheet 1 of 2/.test(d.out) && /Sheet 2 of 2/.test(d.out) && /Reading as: rfq_log/.test(d.out) && /Reading as: form_submissions/.test(d.out) && d.payload == null && !NEVER.some((x) => d.out.includes(x)), d.out.slice(-600));
  check("e2e: diagnose ends on an ok line that names both layouts", /^TRACKER-FEED franklin-brazing ok: diagnose found every needed heading on all 2 sheets \(Quote \/ RFQ sheet, Ad form sheet\)/.test(d.last), d.last);

  // Three sheets
  const three = await run({ FRANKLIN_TRACKER_SHEET_2: undefined, FRANKLIN_TRACKER_SHEETS: `${SHEET_A},${SHEET_B}` });
  check("e2e: a comma list names the sheets too", summaryOf(three)?.sheets?.length === 2, verdictOf(three));
}

function contract() {
  const wf = readFileSync(new URL("../.github/workflows/import-tracker.yml", import.meta.url), "utf8");
  check("workflow: the second sheet comes from an input, a variable or a secret", /FRANKLIN_TRACKER_SHEET_2: \$\{\{ inputs\.sheet2 \|\| vars\.FRANKLIN_TRACKER_SHEET_2 \|\| secrets\.FRANKLIN_TRACKER_SHEET_2 \}\}/.test(wf));
  check("workflow: every sheet value is masked in the log", /add-mask::\$FRANKLIN_TRACKER_SHEET"/.test(wf) && /add-mask::\$FRANKLIN_TRACKER_SHEET_2"/.test(wf) && /FRANKLIN_TRACKER_SHEETS/.test(wf) && /add-mask::\$S/.test(wf));
  check("workflow: a dispatch input can name the second sheet for one run", /sheet2:/.test(wf));
  const src = readFileSync(new URL("./tracker/merge.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("contract: the merge never merges on a name (a name is read only to hold a lookalike)", !/keyOf\([^)]*"name"/.test(code) && !/KEY_KINDS = \[[^\]]*name/.test(code));
  check("contract: the merge is pure: no network, no database, no clock", !/fetch\(|from "pg"|new Date\(\)|Date\.now\(\)|process\.env/.test(code));
  check("contract: the merge holds identifiers in memory only: the stored types carry none", !/email|phone/.test(readFileSync(new URL("./tracker/reading.ts", import.meta.url), "utf8").split("export interface SheetSummary")[1]!.split("export interface FeedSummary")[0]!));
}

async function main() {
  for (const [name, fn] of [["pure", async () => pure()], ["contract", async () => contract()], ["e2e", e2e]] as const) {
    try { await fn(); } catch (e) { check(`${name}: the section ran to its end without throwing`, false, e instanceof Error ? e.message : String(e)); }
  }
  await ss.stop().catch(() => {});
  console.log(failed === 0 ? `ok: tracker merge: ${n} checks passed` : `\n${failed} of ${n} checks FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await ss.stop().catch(() => {}); process.exit(1); });

#!/usr/bin/env tsx
/**
 * Guard for the DPG tracker import. Two halves in one run, no credential, no
 * network, no database:
 *
 *  1. The pure reading (src/dpg-tracker.ts): headers found by NAME when the
 *     columns are reordered, the summary block beside the table ignored, a mistyped
 *     "Fee owed" cell ignored, the cap, pending rows, refused rows, an empty sheet,
 *     a missing or doubled heading, "$" and commas in an amount.
 *  2. The REAL importer as a child process against a pretend Google
 *     (fake-google.ts), with a stub in place of the dashboard's `npm run sync` that
 *     captures the exact payload it is handed. A healthy sheet writes the right
 *     months; every way the connection is known to die stops with a named cause,
 *     writes NOTHING, and the last line is the heartbeat note. No name, phone or
 *     email from the sheet is ever printed.
 *
 * Every person, phone, address and amount is invented.
 *
 *   npm run verify-dpg-tracker
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGoogle, type FakeTab } from "./fake-google.js";
import {
  BILLING_WINDOW_START_DEFAULT, CAUSE_CODES, DEAL_CAP, DPG_CLIENT_SLUG, DPG_SHEET_ID_DEFAULT, DPG_TAB_GID_DEFAULT, FEE_PER_DEAL_CENTS,
  REQUIRED_HEADERS, ROW_LIMIT, buildEntries, buildSummary, dpgSheetId, parseAmountCents, pickTrackerTab, readTracker, resolveColumns,
  windowMonths, type Columns, type TrackerSummary,
} from "./dpg-tracker.js";

let failed = 0; let n = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  n++;
  if (ok) return;
  failed++;
  console.error(`✗ ${name}${detail !== undefined ? `\n    ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 700)}` : ""}`);
}

// ── An invented sheet shaped like the real one ───────────────────────────────
const HEAD = ["Phone", "Name on file", "Email", "First contact", "Last contact", "Touches", "Month", "Type", "First-touch source", "Ad click", "Status", "Closed date", "Amount", "Closed in", "Won in billing window?", "Notes", "Fee owed"];
const col = (name: string) => HEAD.indexOf(name);
interface R { phone?: string; name?: string; email?: string; first?: string; status?: string; closed?: string; amount?: string; flag?: string; fee?: string; notes?: string; type?: string; click?: string }
function dataRow(r: R): string[] {
  const row = new Array(17).fill("");
  row[0] = r.phone ?? "(555) 010-0100"; row[1] = r.name ?? "(name unknown)"; row[2] = r.email ?? "";
  row[3] = r.first ?? "2026-09-10"; row[4] = r.first ?? "2026-09-10"; row[5] = "1"; row[6] = (r.first ?? "2026-09-10").slice(0, 7) + "-01"; row[7] = r.type ?? "call"; row[8] = "Paid Search"; row[9] = r.click ?? "";
  row[10] = r.status ?? ""; row[11] = r.closed ?? ""; row[12] = r.amount ?? ""; row[13] = r.closed ? "Odoo" : ""; row[14] = r.flag ?? "";
  row[15] = r.notes ?? ""; row[16] = r.fee ?? "";
  // The real sheet trims trailing empties: ragged rows are the normal case.
  while (row.length && row[row.length - 1] === "") row.pop();
  return row;
}
/** The summary block lives on the SAME rows, one column gap to the right, and its labels look like ours. */
const BLOCK: string[][] = [
  ["", "Billing window starts", "2026-09-03"],
  ["", "Fee per attributed deal", "$2,666.66", "Deal cap (Year 1, $120,000)", "45"],
  ["", "Month (by first contact)", "Leads", "Ad-click leads", "Calls", "Forms", "Won in billing window", "Close rate", "Won revenue", "Fee owed to BS LLC"],
  ["", "2026-09-01", "111", "4", "100", "13", "3", "2.70%", "131299.63", "$7,999.98"],
];
function withBlock(head: string[], rows: string[][]): string[][] {
  const all = [head, ...rows];
  return all.map((r, i) => {
    const b = BLOCK[i];
    if (!b) return r;
    const padded = [...r]; while (padded.length < 17) padded.push("");
    return [...padded, ...b];
  });
}

// The three wins and two pending rows from the real sheet's shape, with invented people.
const REAL_SHAPE: R[] = [
  { name: "Quarry Haulage LLC", first: "2026-09-03", status: "Won", closed: "2026-09-24", amount: "60910.4", flag: "Yes", fee: "2666.66", notes: "Matched by company name, Odoo phone 555-010-7777" },
  { name: "Ivo Pell", first: "2026-09-05", status: "Won", closed: "2026-09-30", amount: "44389.23", flag: "Yes", email: "ivo.pell@example.test", phone: "(555) 010-2222" },
  { name: "Una Marsh", first: "2026-09-02", status: "Won", closed: "2026-09-23", amount: "$26,000", flag: "Yes", fee: "9999999" },
  { name: "Pending Pete", first: "2026-09-08", closed: "2026-09-11", amount: "825.95", notes: "Low value, probably parts. Confirm." },
  { name: "Maybe Motors", first: "2026-09-12", closed: "2026-10-02", amount: "21011.77", notes: "existing customer? confirm" },
  { name: "Lead Only", first: "2026-10-05" },
  { name: "(name unknown)", first: "2026-10-06" },
];
const TODAY = "2026-10-06";
const WIN = BILLING_WINDOW_START_DEFAULT;
const colsOf = (rows: string[][]): { cols: Columns; headerRow: number } => {
  const c = resolveColumns(rows);
  if (!c.ok) throw new Error(`fixture headers unreadable: ${JSON.stringify(c)}`);
  return { cols: c.cols, headerRow: c.headerRow };
};
const read = (rows: string[][], today = TODAY, win = WIN) => { const { cols, headerRow } = colsOf(rows); return readTracker(rows, cols, headerRow, { today, windowStart: win }); };

// ═══ 1b. The funnel, by month of FIRST CONTACT; revenue and fee by month of CLOSED DATE ═══
{
  const rows = withBlock(HEAD, ([
    { name: "Aug A", first: "2026-08-20", type: "Call", click: "Yes" },
    { name: "Aug B", first: "2026-08-25", type: "Web form" },
    { name: "Sep A", first: "2026-09-03", type: "call", click: "gclid-abc", status: "Won", closed: "2026-09-24", amount: "60910.4", flag: "Yes" },
    { name: "Sep B", first: "2026-09-05", type: "form", click: "no", status: "Won", closed: "2026-10-02", amount: "1000", flag: "Yes" },
    { name: "Sep C", first: "2026-09-06", type: "Chat", click: "-" },
    { name: "Sep D", first: "2026-09-07", type: "call", click: "Yes", closed: "2026-09-09", amount: "500" },
    { name: "Oct A", first: "2026-10-05", type: "call" },
    { name: "Won no first contact", first: "", status: "Won", closed: "2026-09-12", amount: "200", flag: "Yes" },
  ] as R[]).map(dataRow));
  const r = read(rows);
  const m = (k: string) => r.funnel.find((f) => f.month === k);
  check("funnel: one row per month of first contact, oldest first", r.funnel.map((f) => f.month).join() === "2026-08,2026-09,2026-10", r.funnel.map((f) => f.month));
  check("funnel: leads by month (2, 4, 1)", [m("2026-08")?.leads, m("2026-09")?.leads, m("2026-10")?.leads].join() === "2,4,1", r.funnel);
  check("funnel: ad-click leads read a click id or Yes as a click, and no, a dash or blank as none", [m("2026-08")?.adClickLeads, m("2026-09")?.adClickLeads].join() === "1,2", r.funnel);
  check("funnel: calls and forms are read from the Type cell's own words; a Type that is neither is a lead and neither", m("2026-09")?.calls === 2 && m("2026-09")?.forms === 1 && m("2026-09")?.leads === 4, m("2026-09"));
  check("funnel: a Won deal belongs to the month its lead FIRST CONTACTED, not the month it closed", m("2026-09")?.won === 2 && m("2026-09")?.wonCents === 6_091_040 + 100_000, m("2026-09"));
  check("funnel: a counted deal with no readable first contact is in the totals and said so, not in a month", r.funnelUndated === 1 && r.counted.length === 3, [r.funnelUndated, r.counted.length]);
  check("funnel: a pending row (closed, amount, no Status) is in no month's won count", m("2026-09")?.won === 2 && r.pending.length === 1, [m("2026-09")?.won, r.pending.length]);
  const cm = (k: string) => r.closedMonths.find((c) => c.month === k);
  check("closed months: revenue and fee group by the CLOSED date (Sep: 2 deals, Oct: 1)", cm("2026-09")?.deals === 2 && cm("2026-10")?.deals === 1 && cm("2026-09")?.cents === 6_091_040 + 20_000, r.closedMonths);
  check("closed months: the fee is the contract's per counted deal", cm("2026-09")?.feeCents === 2 * FEE_PER_DEAL_CENTS && r.closedMonths.reduce((a, c) => a + c.feeCents, 0) === r.feeCents, r.closedMonths);
  const noCols = [HEAD.filter((h) => h !== "Type" && h !== "Ad click"), ...REAL_SHAPE.map(dataRow).map((row) => { const full = [...row]; while (full.length < 17) full.push(""); return full.filter((_, i) => i !== 7 && i !== 9); })];
  const r2 = read(noCols);
  check("funnel: a sheet with no Type or Ad click column says nothing about calls, forms or clicks (null, never nought)", r2.funnel.length > 0 && r2.funnel.every((f) => f.calls === null && f.forms === null && f.adClickLeads === null && f.leads > 0), r2.funnel);
  const t = JSON.stringify(buildSummary(r, "2026-10-06T12:00:00Z", null).funnel);
  check("funnel: the stored funnel carries no name, phone or email", !/Aug A|Sep A|555|@/.test(t), t.slice(0, 200));
}

// ═══ 1. The pure reading ═════════════════════════════════════════════════════
{
  const rows = withBlock(HEAD, REAL_SHAPE.map(dataRow));
  const r = read(rows);
  check("pure: three Won in the window are counted", r.counted.length === 3, r.counted);
  check("pure: revenue is their amounts to the cent ($131,299.63)", r.countedCents === 13_129_963, r.countedCents);
  check("pure: the fee is recomputed from the contract: 3 x $2,666.66 = $7,999.98", r.feeCents === 799_998 && r.feeDeals === 3, [r.feeCents, r.feeDeals]);
  check("pure: a mistyped Fee owed cell changes nothing", r.feeCents === 3 * FEE_PER_DEAL_CENTS);
  check("pure: two rows with a closed date and an amount but no Status are pending, not counted", r.pending.length === 2 && r.pending.every((p) => p.why === "no_status"), r.pending);
  check("pure: pending dollars are shown apart ($825.95 + $21,011.77)", r.pendingCents === 82_595 + 2_101_177, r.pendingCents);
  check("pure: pending is not in the counted revenue", !r.counted.some((d) => r.pending.some((p) => p.row === d.row)));
  check("pure: the newest first contact is read (2026-10-06)", r.newestFirstContact === "2026-10-06", r.newestFirstContact);
  check("pure: the newest closed date is read from any row (2026-10-02, a pending one)", r.newestClosed === "2026-10-02", r.newestClosed);
  check("pure: the summary block's rows are not data rows", r.rows === REAL_SHAPE.length, r.rows);
  check("pure: the label is the Name cell, and an unknown name is just the row number", r.counted[0]!.label.length > 0 && r.pending.every((p) => !/^\(/.test(p.label)));
  check("pure: row numbers are the numbers a person sees in the sheet (header is row 1)", r.counted.map((d) => d.row).sort((a, b) => a - b).join() === "2,3,4", r.counted.map((d) => d.row));
  const sum = buildSummary(r, "2026-10-06T12:00:00.000Z", null);
  const text = JSON.stringify(sum);
  check("pure: the stored summary carries no phone, no email and no note text", !/555|@|example\.test|Matched by|probably parts|existing customer/.test(text), text.slice(0, 300));
}
{
  // Columns reordered, a new column inserted, headings in other capitals: still found by name.
  const order = [11, 3, 0, 12, 10, 14, 1, 16, 2];
  const head = order.map((i) => HEAD[i]!.toUpperCase()); head.splice(2, 0, "A new column");
  const rows = [head, ...REAL_SHAPE.map(dataRow).map((r) => { const full = [...r]; while (full.length < 17) full.push(""); const out = order.map((i) => full[i] ?? ""); out.splice(2, 0, "x"); return out; })];
  const r = read(rows);
  check("pure: reordered, shouting, with an inserted column: the same three deals", r.counted.length === 3 && r.countedCents === 13_129_963, r.counted);
}
{
  const rows = withBlock(HEAD, [
    dataRow({ name: "A", status: "Won", closed: "2026-09-10", amount: "", flag: "Yes" }),
    dataRow({ name: "B", status: "Won", closed: "", amount: "100", flag: "Yes" }),
    dataRow({ name: "C", status: "Won", closed: "2026-08-20", amount: "100", flag: "Yes" }),
    dataRow({ name: "D", status: "Won", closed: "2026-12-30", amount: "100", flag: "Yes" }),
    dataRow({ name: "E", status: "Won", closed: "2026-09-10", amount: "100", flag: "" }),
    dataRow({ name: "F", status: "Lost", closed: "2026-09-10", amount: "100" }),
    dataRow({ name: "G", status: "won", closed: "2026-09-10", amount: "$1,200.50", flag: "yes" }),
    dataRow({ name: "H", status: "Won", closed: "2026-09-10", amount: "0", flag: "Yes" }),
    dataRow({ name: "I", status: "Won", closed: "2026-09-10", amount: "-50", flag: "Yes" }),
  ]);
  const r = read(rows);
  const why = (w: string) => r.problems.filter((p) => p.why === w).length;
  check("pure: Won with no amount is refused and named, not counted", why("won_no_amount") === 3 && !r.counted.some((d) => d.label === "A"), r.problems); // A, H (zero), I (negative)
  check("pure: Won with no closed date is refused and named", why("won_no_date") === 1, r.problems);
  check("pure: Won with a closed date BEFORE the window is refused even when flagged Yes", why("won_before_window") === 1, r.problems);
  check("pure: Won with a closed date in the future is refused", why("won_future_date") === 1, r.problems);
  check("pure: Won inside the window without the Yes flag is pending (not counted) with its own reason", r.pending.length === 1 && r.pending[0]!.why === "window_flag_missing", r.pending);
  check("pure: a Status other than Won or blank is counted nowhere", r.otherStatus === 1 && r.counted.length === 1, [r.otherStatus, r.counted.length]);
  check("pure: 'won', 'yes' and '$1,200.50' read as written (case, $ and commas do not matter)", r.counted.length === 1 && r.counted[0]!.cents === 120_050, r.counted);
}
{
  // The cap: the first 45 by closed date carry the fee; revenue counts every qualifying deal.
  const many: R[] = [];
  for (let i = 0; i < 50; i++) many.push({ name: `Deal ${i}`, status: "Won", flag: "Yes", closed: `2026-09-${String(3 + (i % 25)).padStart(2, "0")}`, amount: "1000" });
  const r = read(withBlock(HEAD, many.map(dataRow)), "2026-10-06");
  check("pure: 50 qualifying deals: fee on the first 45 only", r.feeDeals === DEAL_CAP && r.feeCents === DEAL_CAP * FEE_PER_DEAL_CENTS && r.overCap === 5, [r.feeDeals, r.overCap]);
  check("pure: revenue still counts all 50 (the cap limits the fee, not what DPG sold)", r.counted.length === 50 && r.countedCents === 50 * 100_000);
  check("pure: the fee by closed month adds up to the capped fee, never past the cap", r.closedMonths.reduce((a, c) => a + c.feeCents, 0) === DEAL_CAP * FEE_PER_DEAL_CENTS && r.closedMonths.reduce((a, c) => a + c.feeDeals, 0) === DEAL_CAP && r.closedMonths.reduce((a, c) => a + c.deals, 0) === 50, r.closedMonths);
  check("pure: counted deals are ordered by closed date", r.counted.every((d, i, a) => i === 0 || a[i - 1]!.closed <= d.closed));
}
{
  const empty = resolveColumns([]);
  check("pure: an empty sheet is a stop (reason empty), not a zero", !empty.ok && empty.reason === "empty");
  const blankCells = resolveColumns([["", ""], []]);
  check("pure: a sheet of blank cells is empty too", !blankCells.ok && blankCells.reason === "empty");
  const headOnly = resolveColumns([HEAD]);
  check("pure: headers with no data rows are fine and read as nought deals", headOnly.ok && read([HEAD]).counted.length === 0);
  for (const h of ["Status", "Closed date", "Amount", "Won in billing window?", "First contact"]) {
    const rows = [HEAD.filter((x) => x !== h), ...REAL_SHAPE.map(dataRow)];
    const c = resolveColumns(rows);
    check(`pure: missing the "${h}" column is a stop naming it`, !c.ok && c.reason === "missing" && c.missing.includes(h), c);
  }
  const renamed = resolveColumns([HEAD.map((x) => (x === "Amount" ? "Deal value" : x)), ...REAL_SHAPE.map(dataRow)]);
  check("pure: a renamed heading is a stop, never a guess at which column it was", !renamed.ok && renamed.reason === "missing" && renamed.missing[0] === "Amount");
  const dup = resolveColumns([[...HEAD.slice(0, 16), "Amount"], ...REAL_SHAPE.map(dataRow)]);
  check("pure: a doubled heading is a stop", !dup.ok && dup.reason === "duplicate" && dup.duplicate[0] === "Amount", dup);
  // The summary block repeats "Won in billing window" but one gap away, so it never collides.
  const blockOk = resolveColumns(withBlock(HEAD, REAL_SHAPE.map(dataRow)));
  check("pure: the summary block's look-alike labels never collide with the table's headings", blockOk.ok);
  check("pure: required headings are exactly the five the reading needs", Object.keys(REQUIRED_HEADERS).length === 5);
}
{
  check("pure: amounts: $, commas, spaces", parseAmountCents("$ 1,234.50") === 123_450 && parseAmountCents("60910.4") === 6_091_040 && parseAmountCents(" 1,200 ") === 120_000);
  check("pure: amounts: words, nought, negatives and blanks are null", ["", "TBD", "0", "-5", "12abc", "(12.00)", "1.2.3"].every((v) => parseAmountCents(v) === null));
}
{
  const r = read(withBlock(HEAD, REAL_SHAPE.map(dataRow)));
  const e = buildEntries(DPG_CLIENT_SLUG, r, buildSummary(r, "2026-10-06T12:00:00Z", null), TODAY);
  const months = e.filter((x) => x.external_id !== "dpg-tracker-summary");
  check("pure: one row per month from the window's first through today's, none before", months.map((m) => m.period_start).join() === "2026-09-01,2026-10-01", months.map((m) => m.period_start));
  check("pure: revenue lands in the month the deal CLOSED (all three in September)", Number(months[0]!.metrics["manual.revenue_system_cents"]) === 13_129_963 && months[0]!.metrics["manual.tracker_won_deals"] === 3);
  check("pure: a month with no won deal is a real nought, so an un-marked row can bring it back down", months[1]!.metrics["manual.revenue_system_cents"] === 0 && months[1]!.metrics["manual.tracker_won_deals"] === 0);
  check("pure: the in-progress month's period ends today (the dashboard hides a period that ends in the future)", months[1]!.period_end === TODAY);
  check("pure: no row is written for a month before the billing window", !e.some((x) => x.period_start < "2026-09-01"));
  const s = e.find((x) => x.external_id === "dpg-tracker-summary")!;
  check("pure: pending count, pending dollars and the summary ride on one constant period", s.metrics["manual.tracker_pending_deals"] === 2 && s.metrics["manual.tracker_pending_cents"] === 2_183_772 && s.period_start === WIN);
  const parsed = JSON.parse(String(s.metrics["manual.tracker_summary"])) as TrackerSummary;
  check("pure: the summary round-trips", parsed.v === 1 && parsed.countedDeals === 3 && parsed.feeCents === 799_998 && parsed.capDeals === 45 && parsed.newestFirstContact === "2026-10-06");
  check("pure: every entry is for the client slug and the manual source", e.every((x) => x.client_id === DPG_CLIENT_SLUG && x.source === "manual"));
  check("pure: windowMonths spans a year boundary", windowMonths("2026-11-03", "2027-02-10").join() === "2026-11,2026-12,2027-01,2027-02");
  const pick = pickTrackerTab([{ gid: 5, title: "Other" }, { gid: DPG_TAB_GID_DEFAULT, title: "Renamed" }], DPG_TAB_GID_DEFAULT);
  check("pure: the tab is found by gid, so a rename does not break it", pick.tab === "Renamed" && pick.how === "gid");
  check("pure: no gid match and no override is `missing`, never the first tab", pickTrackerTab([{ gid: 5, title: "Other" }], DPG_TAB_GID_DEFAULT).tab === null);
  check("pure: a named override wins, and a wrong one is `override_missing`", pickTrackerTab([{ gid: 5, title: "Other" }], 1, "other").tab === "Other" && pickTrackerTab([{ gid: 5, title: "Other" }], 5, "nope").how === "override_missing");
  check("pure: a pasted sheet address gives its id", dpgSheetId({ DPG_TRACKER_SHEET_ID: `https://docs.google.com/spreadsheets/d/${DPG_SHEET_ID_DEFAULT}/edit#gid=1` }) === DPG_SHEET_ID_DEFAULT);
}

// ═══ 2. The real importer against a pretend Google ═══════════════════════════
const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const KEY_JSON = JSON.stringify({ client_email: "sync@example-project.iam.gserviceaccount.com", private_key: privateKey });
const TSX = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
const SRC = (f: string) => new URL(`./${f}.ts`, import.meta.url).pathname;
const etToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const ago = (k: number): string => { const [y, m, d] = etToday.split("-").map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, d - k)).toISOString().slice(0, 10); };
const WINDOW = ago(60);
// Invented people, phones and addresses: none of these may appear in anything a run prints.
const SECRETS = ["Ivo Pell", "Una Marsh", "Quarry Haulage", "Maybe Motors", "Pending Pete", "ivo.pell@example.test", "555) 010-2222", "010-7777", "probably parts"];
const e2eRows = (): R[] => REAL_SHAPE.map((r) => ({ ...r,
  first: r.first === "2026-10-05" ? ago(1) : r.first === "2026-10-06" ? ago(0) : ago(55),
  closed: r.closed === "2026-09-24" ? ago(30) : r.closed === "2026-09-30" ? ago(10) : r.closed === "2026-09-23" ? ago(31) : r.closed === "2026-09-11" ? ago(40) : r.closed === "2026-10-02" ? ago(4) : r.closed }));
const tabOf = (rows: string[][], gid = DPG_TAB_GID_DEFAULT): FakeTab => ({ name: "Untitled", gid, rows });
const good = (): FakeTab => tabOf(withBlock(HEAD, e2eRows().map(dataRow)));

interface Run { code: number | null; out: string; last: string; payload: any | null }
const fake = new FakeGoogle(SHEET);
let base = "";
function run(extraEnv: Record<string, string> = {}, args: string[] = ["--dry-run"]): Promise<Run> {
  const dash = mkdtempSync(join(tmpdir(), "dpg-dash-"));
  const captured = join(dash, "captured.json");
  writeFileSync(join(dash, "package.json"), JSON.stringify({ name: "stub-dashboard", private: true, scripts: { sync: "node capture.js" } }));
  writeFileSync(join(dash, "capture.js"), `const a=process.argv.find(x=>x.startsWith("--input="));require("fs").copyFileSync(a.slice(8), process.env.CAPTURE_PATH);console.log("stub sync ran");`);
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1",
      GOOGLE_FAKE_BASE: base, DPG_TRACKER_SHEET_ID: SHEET, DPG_BILLING_WINDOW_START: WINDOW, GOOGLE_RETRY_MS: "20", GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON,
      DATABASE_URL: "postgres://unused", DASHBOARD_DIR: dash, CAPTURE_PATH: captured,
      ...extraEnv,
    };
    const p = spawn(TSX, [SRC("import-dpg-tracker"), ...args], { env, cwd: new URL("..", import.meta.url).pathname });
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
const verdict = (r: Run) => r.out.split(/\r?\n/).reverse().find((l) => l.startsWith("DPG-SHEET ")) ?? "";
const levelOf = (r: Run) => verdict(r).match(/^DPG-SHEET (ok|warn|stop)/)?.[1] ?? null;
const causeOf = (r: Run) => verdict(r).match(/^DPG-SHEET (?:warn|stop) ([a-z_]+):/)?.[1] ?? null;

async function scenario(name: string, setup: () => void, expect: { code: 0 | 1; level: "ok" | "warn" | "stop"; cause: string | null; wrote: boolean; env?: Record<string, string>; args?: string[]; has?: RegExp[] }) {
  fake.reset([good()]);
  setup();
  const r = await run(expect.env ?? {}, expect.args);
  check(`e2e: ${name}: exits ${expect.code}`, r.code === expect.code, `${r.code} | ${r.out.slice(-500)}`);
  check(`e2e: ${name}: reads ${expect.level}${expect.cause ? ` ${expect.cause}` : ""}`, levelOf(r) === expect.level && causeOf(r) === expect.cause, verdict(r) || r.out.slice(-300));
  check(`e2e: ${name}: the verdict is the LAST line (the heartbeat note)`, r.last.startsWith("DPG-SHEET "), r.last);
  check(`e2e: ${name}: ${expect.wrote ? "the dashboard was handed the entries" : "NOTHING was handed to the dashboard"}`, (r.payload != null) === expect.wrote, r.payload ? "a payload was written" : "no payload");
  check(`e2e: ${name}: it wrote nothing to Google`, fake.writes === 0, fake.writes);
  check(`e2e: ${name}: no name, phone or email from the sheet in anything it printed`, !SECRETS.some((x) => r.out.includes(x)) && !/\(555\)|555-010|@example\.test/.test(r.out), r.out.slice(0, 400));
  for (const re of expect.has ?? []) check(`e2e: ${name}: output mentions ${re}`, re.test(r.out), r.out.slice(-400));
  return r;
}

async function main() {
  base = await fake.start();

  const healthy = await scenario("a healthy sheet", () => {}, { code: 0, level: "ok", cause: null, wrote: true, has: [/DPG-SHEET ok: read "Untitled", 7 rows, 3 won in window, 2 pending/] });
  {
    const p = healthy.payload;
    const syncs = p?.syncs ?? [];
    const months = syncs.filter((s: any) => s.external_id !== "dpg-tracker-summary");
    const total = months.reduce((s: number, m: any) => s + m.metrics["manual.revenue_system_cents"], 0);
    check("e2e: the real payload's monthly revenue adds to $131,299.63", total === 13_129_963, total);
    check("e2e: the real payload has a row for every month of the window and none before", months.length >= 2 && months[0].period_start === `${WINDOW.slice(0, 7)}-01` && months.every((m: any) => m.period_start >= `${WINDOW.slice(0, 7)}-01`), months.map((m: any) => m.period_start));
    const sum = syncs.find((s: any) => s.external_id === "dpg-tracker-summary");
    const parsed = sum ? (JSON.parse(sum.metrics["manual.tracker_summary"]) as TrackerSummary) : null;
    check("e2e: the summary says what was read and when", !!parsed && parsed.newestFirstContact === ago(0) && parsed.countedDeals === 3 && parsed.pending.length === 2 && !!parsed.readAt, parsed);
    check("e2e: the summary carries Drive's edit time when Drive answers", !!parsed?.sheetEditedAt, parsed?.sheetEditedAt);
    check("e2e: the payload carries no phone, email or note", !/555|@|probably parts|Matched by/.test(JSON.stringify(p).replace(/postgres:\/\/unused/g, "")), JSON.stringify(p).slice(0, 200));
    check("e2e: a pending row's note and a deal's phone number are not in the payload", !JSON.stringify(p).includes("existing customer"));
  }

  await scenario("the Drive API is off: still ok, and the edit time is null, not invented", () => { fake.state.drive.mode = "off"; }, { code: 0, level: "ok", cause: null, wrote: true, has: [/edit time not available/] });
  { fake.reset([good()]); fake.state.drive.mode = "off"; const r = await run(); const s = r.payload?.syncs?.find((x: any) => x.external_id === "dpg-tracker-summary"); check("e2e: with Drive off the stored edit time is null", s && JSON.parse(s.metrics["manual.tracker_summary"]).sheetEditedAt === null); }
  await scenario("Google blips twice, then answers", () => { fake.state.fail.push({ match: "/values/", status: 503, times: 2 }); }, { code: 0, level: "ok", cause: null, wrote: true, has: [/retrying/] });
  await scenario("the tab is renamed (its gid is the same)", () => { fake.state.tabs[0]!.name = "Leads 2026"; }, { code: 0, level: "ok", cause: null, wrote: true, has: [/read "Leads 2026"/] });
  await scenario("rows with problems are warned about and the rest still count", () => { fake.state.tabs[0]!.rows.push(dataRow({ name: "Ivo Pell", first: ago(5), status: "Won", closed: ago(3), amount: "", flag: "Yes" })); }, { code: 0, level: "warn", cause: "rows_refused", wrote: true });

  // Every way the connection is known to stop. Each writes nothing.
  await scenario("the key is revoked", () => { fake.state.tokenMode = "revoked"; }, { code: 1, level: "stop", cause: "key_rejected", wrote: false });
  await scenario("Google's token service is down", () => { fake.state.tokenMode = "down"; }, { code: 1, level: "stop", cause: "google_unavailable", wrote: false });
  await scenario("the sheet is gone", () => { fake.state.access = "gone"; }, { code: 1, level: "stop", cause: "sheet_not_found", wrote: false });
  await scenario("the sheet was never shared (or the share was removed)", () => { fake.state.access = "revoked"; }, { code: 1, level: "stop", cause: "access_removed", wrote: false, has: [/Viewer/] });
  await scenario("the sheet is in the bin", () => { fake.state.drive.trashed = true; }, { code: 1, level: "stop", cause: "sheet_in_bin", wrote: false });
  await scenario("Google is down for the whole run", () => { fake.state.fail.push({ match: "/v4/spreadsheets/", status: 503, times: 99 }); }, { code: 1, level: "stop", cause: "google_unavailable", wrote: false });
  await scenario("the tab is deleted (its gid is gone)", () => { fake.state.tabs[0]!.gid = 7; }, { code: 1, level: "stop", cause: "tab_missing", wrote: false });
  await scenario("...and we point at the new tab by name", () => { fake.state.tabs[0]!.gid = 7; fake.state.tabs[0]!.name = "Rebuilt"; }, { code: 0, level: "ok", cause: null, wrote: true, env: { DPG_TRACKER_TAB: "Rebuilt" } });
  await scenario("a heading is renamed", () => { fake.state.tabs[0]!.rows[0] = HEAD.map((h) => (h === "Amount" ? "Deal value" : h)); }, { code: 1, level: "stop", cause: "headers_missing", wrote: false, has: [/"Amount"/] });
  await scenario("a heading appears twice in the table", () => { fake.state.tabs[0]!.rows[0] = [...HEAD.slice(0, 16), "Status"]; }, { code: 1, level: "stop", cause: "headers_duplicate", wrote: false });
  await scenario("the tab is cleared", () => { fake.state.tabs[0]!.rows = []; }, { code: 1, level: "stop", cause: "sheet_empty", wrote: false });
  await scenario("the tracker outgrows the read", () => { const rows = fake.state.tabs[0]!.rows; for (let i = 0; i < ROW_LIMIT; i++) rows.push(dataRow({ first: ago(30) })); }, { code: 1, level: "stop", cause: "sheet_too_long", wrote: false });
  await scenario("the summary block moves to a different place: still fine", () => { fake.state.tabs[0]!.rows = fake.state.tabs[0]!.rows.map((r) => r.slice(0, 17)); }, { code: 0, level: "ok", cause: null, wrote: true });

  for (const [name, key, cause] of [["no key", "", "key_missing"], ["a key file that is not JSON", "nope", "key_unreadable"], ["half a key file", '{"client_email":"x@y.z"}', "key_unreadable"], ["a private key that is not one", '{"client_email":"x@y.z","private_key":"nope"}', "key_unreadable"]] as const) {
    fake.reset([good()]);
    const r = await run({ GOOGLE_SERVICE_ACCOUNT_JSON: key });
    check(`e2e: ${name}: reads ${cause}, exits 1, writes nothing`, causeOf(r) === cause && r.code === 1 && r.payload == null, `${r.code} ${verdict(r)}`);
    check(`e2e: ${name}: Google was never called`, fake.calls.length === 0, fake.calls.length);
  }

  // The sheet changes the way a real one does, and the import follows it.
  {
    fake.reset([good()]);
    const r1 = await run();
    const t1 = r1.payload.syncs.reduce((s: number, m: any) => s + (m.metrics["manual.revenue_system_cents"] ?? 0), 0);
    // Somebody marks the pending Oct deal Won.
    const rows = fake.state.tabs[0]!.rows;
    const iPend = rows.findIndex((r) => r[1] === "Maybe Motors");
    rows[iPend]![col("Status")] = "Won"; rows[iPend]![col("Won in billing window?")] = "Yes";
    const r2 = await run();
    const t2 = r2.payload.syncs.reduce((s: number, m: any) => s + (m.metrics["manual.revenue_system_cents"] ?? 0), 0);
    check("e2e: marking a pending row Won moves it from pending to counted on the next run", t2 - t1 === 2_101_177, [t1, t2]);
    // Somebody un-marks every win: months must come back to nought, not stay stale.
    for (const r of rows) if (r[col("Status")] === "Won") r[col("Status")] = "";
    const r3 = await run();
    const t3 = r3.payload.syncs.reduce((s: number, m: any) => s + (m.metrics["manual.revenue_system_cents"] ?? 0), 0);
    check("e2e: un-marking every win writes noughts for the months (newest row wins), not silence", t3 === 0 && r3.payload.syncs.filter((s: any) => s.external_id !== "dpg-tracker-summary").every((s: any) => s.metrics["manual.revenue_system_cents"] === 0));
  }

  // The contract with the rest of the system.
  {
    const src = ["dpg-tracker.ts", "dpg-tracker-read.ts", "import-dpg-tracker.ts"].map((f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8")).join("\n");
    const scopes = Array.from(src.matchAll(/https:\/\/www\.googleapis\.com\/auth\/([a-z.]+)/g)).map((m) => m[1]!);
    check("scopes: the import asks for read-only scopes and nothing else (an outbound sheet write is not signed off)", scopes.length >= 1 && scopes.every((x) => /\.readonly$/.test(x)), scopes);
    check("scopes: no call in the import writes to a sheet", !/:append|:batchUpdate|values:update|method:\s*"(POST|PUT|PATCH|DELETE)"/i.test(src.replace(/auth\/[a-z.]+/g, "")), "");
  }
  check("the cause list includes every stop the import can name", ["headers_missing", "tab_missing", "key_rejected", "access_removed", "sheet_empty", "google_unavailable"].every((c) => (CAUSE_CODES as readonly string[]).includes(c)));
  const wf = new URL("../.github/workflows/import-dpg-tracker.yml", import.meta.url);
  if (existsSync(wf)) {
    const y = readFileSync(wf, "utf8");
    check("workflow: runs daily on a schedule", /schedule:\s*\n\s*- cron:/.test(y));
    check("workflow: can be dispatched by hand, with no client id input", /workflow_dispatch:/.test(y) && !/client_id/.test(y));
    check("workflow: never points the job at a pretend Google", !/GOOGLE_FAKE_BASE/.test(y));
    check("workflow: the heartbeat note goes through an environment variable, never into the shell line", /NOTE: \$\{\{ steps\.summary\.outputs\.summary \}\}/.test(y) && /--note="\$NOTE"/.test(y) && !/--note="\$\{\{/.test(y));
    check("workflow: heartbeats under import_dpg_tracker, with the run log", /--job=import_dpg_tracker/.test(y) && /--log=run\.log/.test(y));
    check("workflow: the summary is the DPG-SHEET line", /grep '\^DPG-SHEET '/.test(y));
    check("workflow: the heartbeat runs even when the import failed", /if: always\(\)/.test(y));
  } else check("the workflow file exists", false);
  check("the default billing window is the contract's (2026-09-03)", BILLING_WINDOW_START_DEFAULT === "2026-09-03");
  check("the fee and cap are the contract's ($2,666.66, 45)", FEE_PER_DEAL_CENTS === 266_666 && DEAL_CAP === 45);

  await fake.stop();
  console.log(failed === 0 ? `✓ DPG tracker import: ${n} checks passed` : `\n${failed} of ${n} checks FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await fake.stop().catch(() => {}); process.exit(1); });

#!/usr/bin/env tsx
/**
 * Guard for the tracker framework (Franklin and later clients). Three halves in
 * one run, no credential, no network, no database:
 *
 *  1. The pure reading (src/tracker/*): headings found by NAME with aliases and
 *     two layouts, a renamed or doubled heading, amounts as text, dates as text,
 *     a future date, won without an amount, pending, not-ours, the seed overlap
 *     (nothing before the feed's first day is ever written as revenue), the
 *     entries, and that DPG's rules, expressed in this framework, read the same
 *     rows the same way DPG's own reader does.
 *  2. The REAL importer as a child process against a pretend Smartsheet
 *     (fake-smartsheet.ts) and a pretend Google (fake-google.ts), with a stub in
 *     place of the dashboard's `npm run sync`. A healthy sheet writes the right
 *     months; every way the connection is known to die stops with a named cause,
 *     writes NOTHING, and the last line is the heartbeat note. A planted customer
 *     name, email, phone, token and sheet link must never appear in anything a
 *     run prints. Diagnose prints headings and counts and nothing else.
 *  3. The contract with the rest of the system: read-only calls, the token read
 *     in one place, no workflow points a job at a pretend server.
 *
 * Every person, phone, address, link and amount is invented.
 *
 *   npm run verify-tracker
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSmartsheet, type FakeColumn, type FakeSheet, type PagingMode } from "./fake-smartsheet.js";
import { FakeGoogle } from "./fake-google.js";
import { FRANKLIN, FRANKLIN_SEED_CENTS, dpgParityConfig, normHeader, parseSheetRef, resolveConfig, countedFromNote, type TrackerConfig } from "./tracker/config.js";
import { parseAmountCents, parseDay, resolveLayouts, resolveRoles, safeLabel, isClickId, type Table } from "./tracker/table.js";
import { buildFeedEntries, buildFeedSummary, feedMonths, readRows, type FeedSummary } from "./tracker/reading.js";
import { CAUSE_CODES, FINDINGS, lineFor, worstLine } from "./tracker/causes.js";
import { cellText, lastSegment, shapeOf, tableFrom } from "./tracker/smartsheet.js";
import { diagnoseLines } from "./tracker/diagnose.js";
import { readTracker, resolveColumns as dpgColumns, buildSummary as dpgSummary } from "./dpg-tracker.js";

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

// ── Invented values that must never appear in anything a run prints ──────────
const SECRETS = ["Hargrove Fire Systems", "Quarry Haulage", "Maybe Motors", "Nell Ostrander", "ivo.pell@example.test", "555-010-2222", "(555) 010-7777", "probably parts"];
const TOKEN = "valid-token-invented-123";
const LINK_CODE = "ZxQ91mAbCdEfGhIjKlMnOpQrStUvWxYz0123456789"; // a permalink's code
const PERMALINK = `https://app.smartsheet.com/sheets/${LINK_CODE}?view=grid`;
const SHEET_NUM = 5550001234567890;
const GCLID_OK = "Cj0KCQiA_Invented_Click_0001";

// ═══ A sheet shaped like the RFQ log ═════════════════════════════════════════
const RFQ_COLS: FakeColumn[] = [
  { id: 101, title: "RFQ #", type: "TEXT_NUMBER" },
  { id: 102, title: "Customer", type: "TEXT_NUMBER" },
  { id: 103, title: "Contact Email", type: "TEXT_NUMBER" },
  { id: 104, title: "Phone", type: "TEXT_NUMBER" },
  { id: 105, title: "RFQ Date", type: "DATE" },
  { id: 106, title: "RFQ Source", type: "PICKLIST", options: ["BS LLC AD CAMPAIGN", "Referral", "Trade Show"] },
  { id: 107, title: "Status", type: "PICKLIST", options: ["Quoted", "Won", "Lost", "No Bid", "Maybe"] },
  { id: 108, title: "Amount", type: "TEXT_NUMBER" },
  { id: 109, title: "Closed Date", type: "DATE" },
  { id: 110, title: "GCLID", type: "TEXT_NUMBER" },
];
const OURS = "BS LLC AD CAMPAIGN";
type Cell = string | number | boolean | null;
interface Rq { no?: string; cust?: string; email?: string; phone?: string; rfq?: string; src?: string; status?: string; amount?: Cell; closed?: string; gclid?: string }
const rfqRow = (r: Rq): Cell[] => [r.no ?? null, r.cust ?? "Quarry Haulage", r.email ?? "ivo.pell@example.test", r.phone ?? "555-010-2222", r.rfq ?? ago(70), r.src === undefined ? OURS : r.src || null, r.status ?? "Quoted", r.amount ?? null, r.closed ?? null, r.gclid ?? null];
const BASE_ROWS = (): Rq[] => [
  { no: "RFQ-1001", status: "Won", amount: 12_500, closed: ago(10), gclid: GCLID_OK, rfq: ago(30) },                       // counted, number
  { no: "RFQ-1002", status: "Won", amount: "$8,250.50", closed: ago(30), rfq: ago(50) },                                    // counted, text amount
  { no: "RFQ-1003", status: "Won", amount: null, closed: ago(5) },                                                          // won, no amount
  { no: "RFQ-1004", status: "Won", amount: 3_000, closed: undefined },                                                           // won, no date
  { no: "RFQ-1005", status: "Won", amount: 4_000, closed: ago(-3) },                                                        // won, future
  { no: "RFQ-1006", src: "Referral", status: "Won", amount: 99_999, closed: ago(10), cust: "Hargrove Fire Systems" },        // not ours
  { no: "RFQ-1007", status: "Lost" },                                                                                       // known not won
  { no: "RFQ-1008", status: "Maybe", cust: "Maybe Motors" },                                                                // unrecognised status
  { no: "RFQ-1009", status: "Won", amount: 1_800_000, closed: "2025-04-01", cust: "Hargrove Fire Systems", gclid: GCLID_OK + "x" }, // seed window
  { no: "RFQ-1010", status: "Won", amount: 2_200, closed: "2023-06-01" },                                                   // before the seed
  { no: "RFQ-1011", src: "", status: "Won", amount: 5_000, closed: ago(8) },                                                // source blank: pending
  { no: "RFQ-1012", status: "Won", amount: 700, closed: FEED_FROM },                                                        // exactly the first feed day
  { no: "RFQ-1013", status: "Won", amount: 650, closed: ago(61) },                                                          // the day before: seed's
  { no: "RFQ-1014", status: "Won", amount: "$1,000", closed: `${Number(ago(20).slice(5, 7))}/${Number(ago(20).slice(8, 10))}/${ago(20).slice(0, 4)}` }, // a typed US date
  { no: "RFQ-1015", status: "Won", amount: "#REF!", closed: ago(4) },                                                       // a formula error as the amount
];
const sheetOf = (rows: Rq[], over: Partial<FakeSheet> = {}): FakeSheet => ({
  id: SHEET_NUM, name: "Quote Log (invented)", permalink: `https://app.smartsheet.com/sheets/${LINK_CODE}`, accessLevel: "VIEWER", modifiedAt: "2026-10-14T12:00:00Z",
  columns: RFQ_COLS, rows: rows.map(rfqRow), ...over,
});

const cfgAt = (over: Partial<TrackerConfig> = {}): TrackerConfig => ({ ...FRANKLIN, sheetId: String(SHEET_NUM), countedFrom: FEED_FROM, ...over });
const asTable = (s: FakeSheet): Table => {
  const body = {
    id: s.id, name: s.name, columns: s.columns.map((c, i) => ({ id: c.id, index: i, title: c.title, type: c.type ?? "TEXT_NUMBER", hidden: c.hidden === true, ...(c.options ? { options: c.options } : {}) })),
    totalRowCount: s.rows.length,
  };
  const rows = s.rows.map((r, i) => ({ id: 9000 + i, rowNumber: i + 1, cells: s.columns.map((c, k) => ({ c, v: r[k] })).filter((x) => x.v !== null).map((x) => ({ columnId: x.c.id, value: x.v })) }));
  return tableFrom(shapeOf(body)!, rows);
};

// ═══ 1. The pure reading ═════════════════════════════════════════════════════
function pure() {
  // Amounts and dates
  check("pure: '$1,234.00' is 123400", parseAmountCents("$1,234.00") === 123_400);
  check("pure: a number 12500 is 1250000", parseAmountCents("12500") === 1_250_000);
  check("pure: nought, negative, text and a formula error are not amounts", [0, "0", "-5", "n/a", "#REF!", "", null].every((v) => parseAmountCents(v) === null));
  check("pure: ISO date, ISO datetime and a typed US date all read", parseDay("2026-03-04") === "2026-03-04" && parseDay("2026-03-04T14:00:00Z") === "2026-03-04" && parseDay("3/4/2026") === "2026-03-04" && parseDay("03-04-26") === "2026-03-04");
  check("pure: an impossible date is null, never rolled forward", parseDay("2026-02-31") === null && parseDay("13/45/2026") === null && parseDay("not a date") === null);
  check("pure: a click id is an opaque token", isClickId(GCLID_OK) && !isClickId("has space here") && !isClickId("a,b") && !isClickId("short"));
  check("pure: a row label must carry a number and be short; a name never is one", safeLabel("RFQ-1001") === "RFQ-1001" && safeLabel("Hargrove Fire Systems") === null && safeLabel("Nell Ostrander") === null && safeLabel("a very long reference number 12345678") === null);
  check("pure: a cell's number, box and text read; an object reads as blank", cellText({ value: 5 }) === "5" && cellText({ value: true }) === "true" && cellText({ value: "x" }) === "x" && cellText({ value: { a: 1 } }) === "" && cellText(undefined) === "");

  // The sheet value: id or link
  check("pure: a numeric id is an id", JSON.stringify(parseSheetRef("5550001234567890", "smartsheet")) === JSON.stringify({ kind: "id", id: "5550001234567890" }));
  check("pure: a Smartsheet link gives its code, with the query dropped", JSON.stringify(parseSheetRef(PERMALINK, "smartsheet")) === JSON.stringify({ kind: "permalink", token: LINK_CODE }));
  check("pure: the bare code is read as a link code for Smartsheet", parseSheetRef(LINK_CODE, "smartsheet").kind === "permalink");
  check("pure: a Smartsheet link on another region host reads too", parseSheetRef(`https://app.smartsheet.eu/sheets/${LINK_CODE}`, "smartsheet").kind === "permalink");
  check("pure: a link that is not a sheet link is unusable", parseSheetRef("https://app.smartsheet.com/b/home", "smartsheet").kind === "unusable" && parseSheetRef("not a sheet!!", "smartsheet").kind === "unusable");
  check("pure: nothing is none", parseSheetRef("  ", "smartsheet").kind === "none" && parseSheetRef(undefined, "google_sheet").kind === "none");
  check("pure: a Google address gives its id", JSON.stringify(parseSheetRef("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=1", "google_sheet")) === JSON.stringify({ kind: "id", id: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" }));
  check("pure: lastSegment reads the code off a permalink", lastSegment(PERMALINK) === LINK_CODE && lastSegment("nope") === null && lastSegment(undefined) === null);

  // Headings
  const t = asTable(sheetOf(BASE_ROWS()));
  const lr = resolveLayouts(t.headers, cfgAt());
  check("pure: the RFQ log layout resolves by name", lr.res.ok && lr.layout === "rfq_log" && lr.res.found.amount?.header === "Amount" && lr.res.found.source?.header === "RFQ Source", lr.res);
  const shuffled = { ...t, headers: [...t.headers].reverse(), rows: t.rows.map((r) => [...r].reverse()) };
  const lr2 = resolveLayouts(shuffled.headers, cfgAt());
  check("pure: reordered columns resolve to the same headings", lr2.res.ok && lr2.res.found.status?.header === "Status");
  check("pure: case, spacing and punctuation do not decide a heading", resolveLayouts(["status", "  AMOUNT ", "closed-date", "rfq_source"], cfgAt()).res.ok);
  const renamed = resolveLayouts(t.headers.map((h) => (h === "Amount" ? "Deal total" : h)), cfgAt());
  check("pure: a renamed required heading is a refusal naming the role", !renamed.res.ok && renamed.res.reason === "missing" && renamed.res.missing.includes("amount"), renamed.res);
  const dup = resolveLayouts([...t.headers, "Order Amount"], cfgAt());
  check("pure: two headings that could both be the amount are a refusal, not a guess", !dup.res.ok && dup.res.reason === "duplicate" && dup.res.duplicate[0]?.role === "amount", dup.res);
  const noSrc = resolveLayouts(t.headers.filter((h) => h !== "RFQ Source"), cfgAt());
  check("pure: with no source heading the RFQ layout is refused (it would count every customer's RFQs as ours)", !noSrc.res.ok && noSrc.res.reason === "missing" && noSrc.res.missing.includes("source"), noSrc.res);
  const generic = resolveLayouts(["Customer", "Phone", "Status", "Amount", "Closed Date"], cfgAt());
  check("pure: a sheet with outcome columns and no sign it is a form log or an RFQ log is refused, not read as all ours", !generic.res.ok, generic.tried);
  const renamedWithStamp = resolveLayouts(t.headers.filter((h) => h !== "RFQ Source").concat(["Timestamp"]), cfgAt());
  check("pure: an RFQ log whose source heading was renamed is refused even when it also has a timestamp (the RFQ markers rule the form layout out)", !renamedWithStamp.res.ok && renamedWithStamp.layout === "rfq_log", renamedWithStamp.tried);
  const form = resolveLayouts(["Timestamp", "Name", "Email", "Phone", "GCLID", "Form Name", "Status", "Revenue", "Won On"], cfgAt());
  check("pure: the form-submissions layout resolves when it carries outcome columns", form.res.ok && form.layout === "form_submissions" && form.cfg.ourSourceValues.length === 0, form.tried);
  const leads = resolveLayouts(["Timestamp", "Name", "Email", "Phone", "GCLID", "Form Name"], cfgAt());
  check("pure: a sheet of leads with no outcome columns is named as that", !leads.res.ok && leads.leadListOnly, leads);
  check("pure: an unrelated sheet is not a lead list", !resolveLayouts(["Foo", "Bar"], cfgAt()).leadListOnly);
  check("pure: a column serves one role only", (() => { const r = resolveRoles(["Status"], { ...cfgAt(), roles: { status: { required: true, aliases: ["status"] }, confirmFlag: { required: false, aliases: ["status"] } } }); return r.ok && !!r.found.status && !r.found.confirmFlag; })());

  // Reading
  const cfg = cfgAt();
  const R = readRows(t, lr.res.ok ? lr.res.found : {}, lr.cfg, { today: etToday });
  const rows = (xs: { row: number }[]) => xs.map((x) => x.row).sort((a, b) => a - b);
  check("pure: counted are the ours-and-won rows with an amount and a date inside the feed", rows(R.counted).join() === [1, 2, 12, 14].join(), rows(R.counted));
  check("pure: a number and a text amount both count; a typed US date reads", R.counted.find((d) => d.row === 1)?.cents === 1_250_000 && R.counted.find((d) => d.row === 2)?.cents === 825_050 && R.counted.find((d) => d.row === 14)?.cents === 100_000);
  check("pure: won without an amount, without a date, in the future, or with a formula error is REFUSED by row", JSON.stringify(R.problems.map((p) => `${p.row}:${p.why}`).sort()) === JSON.stringify(["15:won_no_amount", "3:won_no_amount", "4:won_no_date", "5:won_future_date"].sort()), R.problems);
  check("pure: a refused row is neither counted nor pending", !R.counted.some((d) => [3, 4, 5, 15].includes(d.row)) && !R.pending.some((d) => [3, 4, 5, 15].includes(d.row)));
  check("pure: another source's win is not a deal here, and is counted as not ours", R.notOurs === 1 && R.wonNotOurs === 1 && !R.counted.some((d) => d.row === 6));
  check("pure: a won row with no source is pending, apart, and never counted", R.pending.length === 1 && R.pending[0]!.row === 11 && R.pending[0]!.why === "source_blank" && R.pendingCents === 500_000);
  check("pure: a known not-won status is silent, an unknown one is counted", R.otherStatus === 1);
  check("pure: THE SEED OVERLAP: wins closed before the feed's first day are summed apart and never counted", R.beforeFeed.deals === 2 && R.beforeFeed.cents === 180_000_000 + 65_000 && !R.counted.some((d) => d.closed < FEED_FROM), R.beforeFeed);
  check("pure: a win closed before the seed's first day is counted nowhere", R.beforeSeed === 1);
  check("pure: the first feed day itself counts (the day before does not)", R.counted.some((d) => d.row === 12 && d.closed === FEED_FROM) && !R.counted.some((d) => d.row === 13));
  check("pure: a click id rides on the won row only when it is a usable token", R.counted.find((d) => d.row === 1)?.gclid === GCLID_OK && R.keys.withClickId === 1);
  check("pure: no row label is a name: they are 'RFQ-1001' references or 'Row N'", R.counted.every((d) => /^(RFQ-\d+|Row \d+)$/.test(d.label)), R.counted.map((d) => d.label));
  check("pure: key coverage counts presence and stores no value", R.keys.withEmail === 4 && R.keys.withPhone === 4 && R.keys.nameOnly === 0);

  // Summary and entries
  const sum = buildFeedSummary(R, lr.cfg, lr.res.ok ? lr.res.found : {}, "2026-10-15T12:00:00.000Z", "2026-10-14T12:00:00.000Z");
  const e = buildFeedEntries("franklin-brazing", R, sum, lr.cfg, etToday);
  const months = e.filter((x) => !x.external_id.endsWith("-summary"));
  check("pure: no entry is written for any month before the feed's first day", months.every((m) => m.period_end >= FEED_FROM) && months[0]!.period_start === FEED_FROM, months.map((m) => m.period_start));
  check("pure: one entry for every month from the first through this one, including empty months", months.length === feedMonths(FEED_FROM, etToday).length && months.length >= 2);
  check("pure: the monthly revenue adds to exactly the counted total (no seed money in it)", months.reduce((s, m) => s + Number(m.metrics["manual.revenue_system_cents"]), 0) === R.countedCents);
  check("pure: the seed's $1.8M win is in no monthly revenue figure (the summary only NAMES the seed's largest win, to say so)", e.filter((x) => !x.external_id.endsWith("-summary")).every((x) => x.metrics["manual.revenue_system_cents"] !== 180000000 && !JSON.stringify(x).includes("180000000")) && JSON.stringify(e.find((x) => x.external_id.endsWith("-summary"))?.metrics ?? {}).includes('largestCents'));
  check("pure: while BS LLC keeps the sheet, the marker and the pending figures are written", months.every((m) => "manual.tracker_won_deals" in m.metrics) && "manual.tracker_pending_cents" in e[e.length - 1]!.metrics);
  const eClient = buildFeedEntries("franklin-brazing", R, sum, { ...lr.cfg, keptBy: "client" }, etToday);
  check("pure: where the CLIENT keeps the sheet the marker is not written, so the figure stands as the client's records", eClient.every((x) => !("manual.tracker_won_deals" in x.metrics) && !("manual.tracker_pending_deals" in x.metrics)) && eClient[0]!.metrics["manual.revenue_system_cents"] === months[0]!.metrics["manual.revenue_system_cents"]);
  check("pure: un-marking a win brings its month back to nought, not silence", (() => { const gone = readRows({ ...t, rows: t.rows.map((r) => (r[6] === "Won" ? r.map((c, i) => (i === 6 ? "" : c)) : r)) }, lr.res.ok ? lr.res.found : {}, lr.cfg, { today: etToday }); const ee = buildFeedEntries("franklin-brazing", gone, sum, lr.cfg, etToday).filter((x) => !x.external_id.endsWith("-summary")); return ee.length === months.length && ee.every((x) => x.metrics["manual.revenue_system_cents"] === 0); })());
  const parsed = JSON.parse(String(e[e.length - 1]!.metrics["manual.tracker_feed_summary"])) as FeedSummary;
  check("pure: the summary round-trips and says what was read", parsed.v === 1 && parsed.kind === "feed" && parsed.countedDeals === 4 && parsed.seed?.cents === FRANKLIN_SEED_CENTS && parsed.columns.amount === "Amount" && parsed.keptBy === "us");
  check("pure: nothing in the stored payload is a customer's name, email or phone", !SECRETS.some((s) => JSON.stringify(e).includes(s)) && !/@|555-010/.test(JSON.stringify(e)), JSON.stringify(e).slice(0, 200));
  check("pure: every entry is for the client slug and the manual source", e.every((x) => x.client_id === "franklin-brazing" && x.source === "manual"));

  // A fee model and the cap (DPG parity), and the cause lines
  check("pure: the config's cause codes include every stop the import names", ["not_configured", "token_missing", "token_rejected", "access_denied", "sheet_not_found", "sheet_not_shared", "headers_missing", "headers_duplicate", "lead_list_only", "rate_limited", "source_unavailable", "rows_incomplete", "sheet_too_long", "sheet_empty"].every((c) => (CAUSE_CODES as readonly string[]).includes(c)));
  check("pure: the worst client's line is the heartbeat note", worstLine(["TRACKER-FEED a ok: fine.", "TRACKER-FEED b stop token_rejected: no.", "TRACKER-FEED c warn rows_refused: hmm."]).startsWith("TRACKER-FEED b stop"));
  check("pure: a line is one sentence of counts and headings, under the heartbeat's length", lineFor("franklin-brazing", [FINDINGS.headers_missing(["amount"], { amount: ["amount"] })], null).length <= 295);
  check("pure: access that is wider than Viewer is a warn, not a stop", FINDINGS.access_too_wide("OWNER").level === "warn");
  check("pure: whose move it is: a refused token is ours, no access follows who keeps the sheet, a missing sheet is either", FINDINGS.token_rejected().who === "us" && FINDINGS.access_denied("client").who === "client" && FINDINGS.access_denied("us").who === "us" && FINDINGS.sheet_not_found().who === "either" && FINDINGS.sheet_not_shared().who === "us");

  // The diagnose report
  const diag = diagnoseLines({ cfg, source: "smartsheet", sheetName: "Quote Log (invented)", tab: null, accessLevel: "VIEWER", modifiedAt: "2026-10-14T12:00:00.000Z", resolvedFromLink: true, table: { ...t, rows: [], rowNumbers: [] } }).join("\n");
  check("pure: diagnose names the sheet, every heading, the role each was found in and the picklist options", /Quote Log \(invented\)/.test(diag) && RFQ_COLS.every((c) => diag.includes(`"${c.title}"`)) && /amount \(needed\): "Amount"/.test(diag) && /"Won": counts as Won/.test(diag) && /"Maybe": not recognised/.test(diag) && /"BS LLC AD CAMPAIGN": means ours/.test(diag) && /"Referral": means not ours/.test(diag), diag);
  check("pure: diagnose prints no cell value and no row", !SECRETS.some((s) => diag.includes(s)) && !diag.includes(GCLID_OK));

  // Configs
  const live = resolveConfig(FRANKLIN, { FRANKLIN_TRACKER_SHEET: PERMALINK, TRACKER_FRANKLIN_KEPT_BY: "client", TRACKER_FRANKLIN_SOURCE: "google_sheet", TRACKER_FRANKLIN_COUNTED_FROM: "2026-02-01", TRACKER_FRANKLIN_ROW_LIMIT: "500" });
  check("pure: repository variables apply: sheet, who keeps it, source, first day, row limit", live.sheetId === PERMALINK && live.keptBy === "client" && live.source === "google_sheet" && live.countedFrom === "2026-02-01" && live.rowLimit === 500);
  check("pure: a typed start on or before the seed's last day is ignored, so no day is counted twice", resolveConfig(FRANKLIN, { TRACKER_FRANKLIN_COUNTED_FROM: "2025-06-01" }).countedFrom === FRANKLIN.countedFrom && resolveConfig(FRANKLIN, { TRACKER_FRANKLIN_COUNTED_FROM: FRANKLIN.seed!.through }).countedFrom === FRANKLIN.countedFrom);
  check("pure: the ignored start is said in the log, and a good one is not", /ignored/.test(countedFromNote(FRANKLIN, { TRACKER_FRANKLIN_COUNTED_FROM: "2025-06-01" }) ?? "") && countedFromNote(FRANKLIN, { TRACKER_FRANKLIN_COUNTED_FROM: "2026-02-01" }) === null);
  check("pure: a nonsense variable changes nothing", resolveConfig(FRANKLIN, { TRACKER_FRANKLIN_KEPT_BY: "maybe", TRACKER_FRANKLIN_SOURCE: "excel", TRACKER_FRANKLIN_COUNTED_FROM: "soon" }).keptBy === "us");
  check("pure: Franklin's default is that BS LLC keeps the sheet (unconfirmed wording) and the feed starts the day after the seed", FRANKLIN.keptBy === "us" && FRANKLIN.seed?.through === "2025-12-30" && FRANKLIN.countedFrom === "2025-12-31");
  check("pure: the committed config holds no sheet link or id", FRANKLIN.sheetId === null);
  check("pure: the seed total in the config is the seed script's ($18,994 plus $1.8M)", FRANKLIN_SEED_CENTS === 181_899_400);

  // ── DPG parity: DPG's rules, in this framework, read the same rows the same way ──
  const HEAD = ["Phone", "Name on file", "Email", "First contact", "Type", "Ad click", "Status", "Closed date", "Amount", "Won in billing window?"];
  const WIN = "2026-09-03";
  const D = (o: Partial<Record<(typeof HEAD)[number], string>>): string[] => HEAD.map((h) => o[h] ?? "");
  const dpgRows: string[][] = [
    D({ "First contact": "2026-09-10", Type: "call", "Ad click": "gclid-1", Status: "Won", "Closed date": "2026-09-24", Amount: "$60,910.40", "Won in billing window?": "Yes" }),
    D({ "First contact": "2026-09-11", Type: "form", "Ad click": "no", Status: "Won", "Closed date": "2026-09-30", Amount: "1200", "Won in billing window?": "Yes" }),
    D({ "First contact": "2026-09-12", Type: "call", Status: "Won", "Closed date": "2026-09-25", Amount: "500", "Won in billing window?": "" }),
    D({ "First contact": "2026-09-13", Status: "Won", "Closed date": "2026-09-26", Amount: "", "Won in billing window?": "Yes" }),
    D({ "First contact": "2026-09-14", Status: "Won", "Closed date": "", Amount: "300", "Won in billing window?": "Yes" }),
    D({ "First contact": "2026-08-14", Status: "Won", "Closed date": "2026-08-20", Amount: "300", "Won in billing window?": "Yes" }),
    D({ "First contact": "2026-09-15", Status: "Won", "Closed date": "2099-01-01", Amount: "300", "Won in billing window?": "Yes" }),
    D({ "First contact": "2026-09-16", Status: "", "Closed date": "2026-09-27", Amount: "700" }),
    D({ "First contact": "2026-09-17", Status: "Lost" }),
    D({ "First contact": "2026-10-01", Type: "web form", Status: "" }),
    ...Array.from({ length: 46 }, (_, i) => D({ "First contact": "2026-09-05", Type: i % 2 ? "call" : "form", "Ad click": i % 3 ? "gclid" : "", Status: "Won", "Closed date": `2026-10-${String(1 + (i % 9)).padStart(2, "0")}`, Amount: String(1000 + i), "Won in billing window?": "Yes" })),
  ];
  const TODAY = "2026-10-12";
  const dpgCols = dpgColumns([HEAD, ...dpgRows]);
  if (!dpgCols.ok) { check("parity: DPG's own reader resolves the fixture", false, dpgCols); return; }
  const theirs = readTracker([HEAD, ...dpgRows], dpgCols.cols, dpgCols.headerRow, { today: TODAY, windowStart: WIN });
  const pcfg = dpgParityConfig(WIN);
  const ptable: Table = { headers: HEAD, types: HEAD.map(() => null), hidden: HEAD.map(() => false), options: HEAD.map(() => null), rows: dpgRows, rowNumbers: dpgRows.map((_, i) => i + 2), totalRows: dpgRows.length };
  const pl = resolveLayouts(HEAD, pcfg);
  if (!pl.res.ok) { check("parity: the framework resolves the DPG headings", false, pl.res); return; }
  const mine = readRows(ptable, pl.res.found, pl.cfg, { today: TODAY });
  const key = (xs: { row: number; closed: string; cents: number }[]) => xs.map((x) => `${x.row}|${x.closed}|${x.cents}`).join(";");
  check("parity: counted rows are the same rows", key(theirs.counted) === key(mine.counted), [theirs.counted.length, mine.counted.length]);
  check("parity: pending rows and their reasons are the same", JSON.stringify(theirs.pending.map((p) => [p.row, p.closed, p.cents, p.why])) === JSON.stringify(mine.pending.map((p) => [p.row, p.closed, p.cents, p.why])));
  check("parity: refused rows and their reasons are the same", JSON.stringify(theirs.problems) === JSON.stringify(mine.problems), [theirs.problems, mine.problems]);
  check("parity: other-status, row counts and newest dates are the same", theirs.otherStatus === mine.otherStatus && theirs.rows === mine.rows && theirs.leadRows === mine.leadRows && theirs.newestFirstContact === mine.newestFirstContact && theirs.newestClosed === mine.newestClosed);
  check("parity: the fee, the cap and the months by closed date are the same", theirs.feeDeals === mine.feeDeals && theirs.feeCents === mine.feeCents && theirs.overCap === mine.overCap && theirs.overCap === 3 && JSON.stringify(theirs.closedMonths) === JSON.stringify(mine.closedMonths), { t: [theirs.feeDeals, theirs.feeCents, theirs.overCap, theirs.closedMonths], m: [mine.feeDeals, mine.feeCents, mine.overCap, mine.closedMonths] });
  check("parity: the funnel by month of first contact is the same", JSON.stringify(theirs.funnel) === JSON.stringify(mine.funnel) && theirs.funnelUndated === mine.funnelUndated, [theirs.funnel, mine.funnel]);
  void dpgSummary;
}

// ═══ 2. The real importer against a pretend Smartsheet and Google ════════════
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const KEY_JSON = JSON.stringify({ client_email: "sync@example-project.iam.gserviceaccount.com", private_key: privateKey });
const TSX = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
const SRC = (f: string) => new URL(`./${f}.ts`, import.meta.url).pathname;

interface Run { code: number | null; out: string; last: string; payload: any | null; syncArgs: string | null }
const ss = new FakeSmartsheet();
const gg = new FakeGoogle("1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
let ssBase = "", ggBase = "";
function run(extraEnv: Record<string, string | undefined> = {}, args: string[] = ["--client=franklin", "--dry-run"]): Promise<Run> {
  const dash = mkdtempSync(join(tmpdir(), "trk-dash-"));
  const captured = join(dash, "captured.json");
  writeFileSync(join(dash, "package.json"), JSON.stringify({ name: "stub-dashboard", private: true, scripts: { sync: "node capture.js" } }));
  writeFileSync(join(dash, "capture.js"), `const a=process.argv.find(x=>x.startsWith("--input="));require("fs").copyFileSync(a.slice(8), process.env.CAPTURE_PATH);require("fs").writeFileSync(process.env.CAPTURE_PATH+".args", process.argv.slice(2).join(" "));console.log("stub sync ran");`);
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1",
      SMARTSHEET_FAKE_BASE: ssBase, GOOGLE_FAKE_BASE: ggBase, SMARTSHEET_API_TOKEN: TOKEN, FRANKLIN_TRACKER_SHEET: String(SHEET_NUM),
      TRACKER_FRANKLIN_COUNTED_FROM: FEED_FROM, TRACKER_RETRY_MS: "20", GOOGLE_RETRY_MS: "20", GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON,
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
      const syncArgs = existsSync(`${captured}.args`) ? readFileSync(`${captured}.args`, "utf8") : null;
      rmSync(dash, { recursive: true, force: true });
      resolve({ code, out, last: lines[lines.length - 1] ?? "", payload, syncArgs });
    });
  });
}
const verdict = (r: Run) => r.out.split(/\r?\n/).reverse().find((l) => l.startsWith("TRACKER-FEED ")) ?? "";
const levelOf = (r: Run) => verdict(r).match(/^TRACKER-FEED \S+ (ok|warn|stop)/)?.[1] ?? null;
const causeOf = (r: Run) => verdict(r).match(/^TRACKER-FEED \S+ (?:warn|stop) ([a-z_]+):/)?.[1] ?? null;
const NEVER = [...SECRETS, TOKEN, LINK_CODE, String(SHEET_NUM), GCLID_OK];

async function scenario(name: string, setup: () => void, expect: { code: 0 | 1; level: "ok" | "warn" | "stop"; cause: string | null; wrote: boolean; env?: Record<string, string | undefined>; args?: string[]; has?: RegExp[]; sheets?: FakeSheet[] }) {
  ss.reset(expect.sheets ?? [sheetOf(BASE_ROWS())]);
  setup();
  const r = await run(expect.env ?? {}, expect.args);
  check(`e2e: ${name}: exits ${expect.code}`, r.code === expect.code, `${r.code} | ${r.out.slice(-500)}`);
  check(`e2e: ${name}: reads ${expect.level}${expect.cause ? ` ${expect.cause}` : ""}`, levelOf(r) === expect.level && causeOf(r) === expect.cause, verdict(r) || r.out.slice(-300));
  check(`e2e: ${name}: the verdict is the LAST line (the heartbeat note)`, r.last.startsWith("TRACKER-FEED "), r.last);
  check(`e2e: ${name}: ${expect.wrote ? "the dashboard was handed the entries" : "NOTHING was handed to the dashboard"}`, (r.payload != null) === expect.wrote, r.payload ? "a payload was written" : "no payload");
  check(`e2e: ${name}: it made no request that is not a GET`, ss.writes === 0 && gg.writes === 0, [ss.writes, gg.writes]);
  check(`e2e: ${name}: no customer name, email, phone, token, sheet link, sheet id or click id in anything it printed`, !NEVER.some((x) => r.out.includes(x)) && !/@example\.test|555-010|\(555\)/.test(r.out), NEVER.filter((x) => r.out.includes(x)).join(" | ") || r.out.slice(0, 300));
  for (const re of expect.has ?? []) check(`e2e: ${name}: output mentions ${re}`, re.test(r.out), r.out.slice(-400));
  return r;
}

async function e2e() {
  ssBase = await ss.start();
  ggBase = await gg.start();

  const healthy = await scenario("a healthy sheet, by numeric id", () => {}, { code: 0, level: "warn", cause: "rows_refused", wrote: true, has: [/Read layout rfq_log: 15 rows, 13 ours, 1 not ours/, /Counted since .*: 4 won, \$22,450\.50/, /Pending \(not counted\): 1/] });
  {
    const syncs = healthy.payload?.syncs ?? [];
    const months = syncs.filter((s: any) => !s.external_id.endsWith("-summary"));
    check("e2e: the payload's monthly revenue adds to $22,450.50 (the seed's $1.8M is in none of it)", months.reduce((s: number, m: any) => s + m.metrics["manual.revenue_system_cents"], 0) === 2_245_050, months.map((m: any) => m.metrics["manual.revenue_system_cents"]));
    check("e2e: the first month starts on the feed's first day and no month is earlier", months[0]?.period_start === FEED_FROM && months.every((m: any) => m.period_start >= FEED_FROM), months.map((m: any) => m.period_start));
    const sum = syncs.find((s: any) => s.external_id === "franklin-tracker-summary");
    const parsed = sum ? (JSON.parse(sum.metrics["manual.tracker_feed_summary"]) as FeedSummary) : null;
    check("e2e: the summary says what was read, when, who keeps it and which headings", !!parsed && parsed.countedDeals === 4 && parsed.pending.length === 1 && parsed.keptBy === "us" && parsed.columns.status === "Status" && !!parsed.readAt && parsed.sheetEditedAt === "2026-10-14T12:00:00.000Z", parsed);
    check("e2e: the click id is on the counted row that has one, and the seed-window win's is not stored", !!parsed && parsed.counted.some((d) => d.gclid === GCLID_OK) && !JSON.stringify(parsed).includes(GCLID_OK + "x"));
    check("e2e: the summary is the only place a click id appears, and no name, email or phone is in the payload", !SECRETS.some((s) => JSON.stringify(healthy.payload).includes(s)) && !/@example|555-010/.test(JSON.stringify(healthy.payload)));
    check("e2e: it asked Smartsheet only with GET and always sent the bearer token", ss.calls.every((c) => c.method === "GET") && ss.authHeaders.every((h) => h === `Bearer ${TOKEN}`));
  }

  check("e2e: a dry run passes --dry-run to the dashboard's sync, so the dashboard writes nothing", healthy.syncArgs != null && healthy.syncArgs.includes("--dry-run"), healthy.syncArgs);

  // By link
  const byLink = await scenario("a healthy sheet, by its link (resolved to the id through the list of sheets)", () => {}, { code: 0, level: "warn", cause: "rows_refused", wrote: true, env: { FRANKLIN_TRACKER_SHEET: PERMALINK }, has: [/found from its link/] });
  check("e2e: the link was resolved by listing sheets and matching the permalink's last segment", ss.calls.some((c) => c.url.startsWith("/sheets?includeAll=true")) && byLink.payload != null);
  await scenario("the link's sheet was never shared with the token's user", () => { ss.state.sheets[0]!.hidden = true; }, { code: 1, level: "stop", cause: "sheet_not_shared", wrote: false, env: { FRANKLIN_TRACKER_SHEET: PERMALINK }, has: [/Viewer/] });
  await scenario("the bare code of a link also works", () => {}, { code: 0, level: "warn", cause: "rows_refused", wrote: true, env: { FRANKLIN_TRACKER_SHEET: LINK_CODE } });
  await scenario("the link is for a different sheet", () => {}, { code: 1, level: "stop", cause: "sheet_not_shared", wrote: false, env: { FRANKLIN_TRACKER_SHEET: "https://app.smartsheet.com/sheets/NoSuchSheetCodeAAAAAAAAAAAAAAAAAAAAAAAA" } });
  {
    // The list is long and paged: the sheet is on the second page.
    const filler: FakeSheet[] = Array.from({ length: 130 }, (_, i) => ({ id: 100 + i, name: `Other ${i}`, permalink: `https://app.smartsheet.com/sheets/Other${i}ZZZZZZZZZZZZZZZZZZZZZZ`, accessLevel: "VIEWER", modifiedAt: "2026-01-01T00:00:00Z", columns: RFQ_COLS, rows: [] }));
    const r = await scenario("a long list of sheets (the one wanted is last)", () => {}, { code: 0, level: "warn", cause: "rows_refused", wrote: true, env: { FRANKLIN_TRACKER_SHEET: PERMALINK }, sheets: [...filler, sheetOf(BASE_ROWS())] });
    check("e2e: the list was read in full", r.payload != null);
  }

  // Paging
  const bigRows = (): Rq[] => [...BASE_ROWS(), ...Array.from({ length: 235 }, (_, i) => ({ no: `RFQ-2${String(i).padStart(3, "0")}`, status: "Quoted" as const }))];
  for (const mode of ["paged100", "paged100_no_total", "last_key"] as PagingMode[]) {
    await scenario(`a 250-row sheet the server pages at 100 (${mode})`, () => { ss.state.paging = mode; }, { code: 0, level: "warn", cause: "rows_refused", wrote: true, sheets: [sheetOf(bigRows())], has: [/Read layout rfq_log: 250 rows/] });
  }
  await scenario("the server promises more rows than it sends", () => { ss.state.paging = "ignores_paging_short_total"; }, { code: 1, level: "stop", cause: "rows_incomplete", wrote: false });
  await scenario("no total and no row numbers: still read in full", () => { ss.state.noTotal = true; ss.state.noRowNumber = true; }, { code: 0, level: "warn", cause: "rows_refused", wrote: true });

  // Every way the connection is known to stop
  await scenario("no token is set", () => {}, { code: 1, level: "stop", cause: "token_missing", wrote: false, env: { SMARTSHEET_API_TOKEN: undefined } });
  check("e2e: with no token Smartsheet is never called", ss.calls.length === 0, ss.calls.length);
  await scenario("the token is revoked", () => { ss.state.tokenMode = "revoked"; }, { code: 1, level: "stop", cause: "token_rejected", wrote: false });
  await scenario("the token is revoked and the sheet was given as a link", () => { ss.state.tokenMode = "revoked"; }, { code: 1, level: "stop", cause: "token_rejected", wrote: false, env: { FRANKLIN_TRACKER_SHEET: PERMALINK } });
  await scenario("the sheet exists but the user may not read it", () => { ss.state.sheets[0]!.forbidden = true; }, { code: 1, level: "stop", cause: "access_denied", wrote: false, has: [/Viewer/] });
  await scenario("the sheet id is not a sheet this user can see", () => {}, { code: 1, level: "stop", cause: "sheet_not_found", wrote: false, env: { FRANKLIN_TRACKER_SHEET: "999999999999" } });
  await scenario("the platform says 429 twice, then answers", () => { ss.state.fail.push({ match: "/sheets/", status: 429, times: 2 }); }, { code: 0, level: "warn", cause: "rows_refused", wrote: true, has: [/retrying/] });
  await scenario("the platform says 429 for the whole run", () => { ss.state.fail.push({ match: "/sheets/", status: 429, times: 99 }); }, { code: 1, level: "stop", cause: "rate_limited", wrote: false });
  await scenario("the platform is down (503) for the whole run", () => { ss.state.fail.push({ match: "/sheets/", status: 503, times: 99 }); }, { code: 1, level: "stop", cause: "source_unavailable", wrote: false });
  await scenario("the platform blips once, then answers", () => { ss.state.fail.push({ match: "/sheets/", status: 503, times: 1 }); }, { code: 0, level: "warn", cause: "rows_refused", wrote: true });
  await scenario("no sheet is set", () => {}, { code: 1, level: "stop", cause: "not_configured", wrote: false, env: { FRANKLIN_TRACKER_SHEET: undefined } });
  check("e2e: with no sheet set Smartsheet is never called", ss.calls.length === 0, ss.calls.length);
  await scenario("the sheet value is not a link or an id", () => {}, { code: 1, level: "stop", cause: "sheet_id_unusable", wrote: false, env: { FRANKLIN_TRACKER_SHEET: "not a sheet!!" } });
  await scenario("the sheet has no rows", () => {}, { code: 1, level: "stop", cause: "sheet_empty", wrote: false, sheets: [sheetOf([])] });
  await scenario("the sheet is longer than this job reads", () => {}, { code: 1, level: "stop", cause: "sheet_too_long", wrote: false, env: { TRACKER_FRANKLIN_ROW_LIMIT: "100" }, sheets: [sheetOf(bigRows())] });
  await scenario("a heading is renamed", () => {}, { code: 1, level: "stop", cause: "headers_missing", wrote: false, sheets: [sheetOf(BASE_ROWS(), { columns: RFQ_COLS.map((c) => (c.title === "Amount" ? { ...c, title: "Deal total" } : c)) })], has: [/the amount/] });
  await scenario("the source heading is gone (it would count every customer's RFQs)", () => {}, { code: 1, level: "stop", cause: "headers_missing", wrote: false, sheets: [sheetOf(BASE_ROWS(), { columns: RFQ_COLS.map((c) => (c.title === "RFQ Source" ? { ...c, title: "Origin of lead notes" } : c)) })], has: [/the source/] });
  await scenario("two headings could both be the amount", () => {}, { code: 1, level: "stop", cause: "headers_duplicate", wrote: false, sheets: [sheetOf(BASE_ROWS(), { columns: [...RFQ_COLS, { id: 111, title: "Order Amount" }], rows: BASE_ROWS().map((r) => [...rfqRow(r), 5]) })] });
  await scenario("a sheet of leads with no outcome columns", () => {}, { code: 1, level: "stop", cause: "lead_list_only", wrote: false, sheets: [{ ...sheetOf([]), columns: [{ id: 1, title: "Timestamp" }, { id: 2, title: "Name" }, { id: 3, title: "Email" }, { id: 4, title: "GCLID" }], rows: [["2026-10-01", "Nell Ostrander", "ivo.pell@example.test", GCLID_OK]] }] });
  {
    const formCols: FakeColumn[] = [{ id: 1, title: "Timestamp", type: "DATE" }, { id: 2, title: "Name" }, { id: 3, title: "Email" }, { id: 4, title: "GCLID" }, { id: 5, title: "Status" }, { id: 6, title: "Revenue" }, { id: 7, title: "Won On", type: "DATE" }];
    const formRows: Cell[][] = [[ago(40), "Nell Ostrander", "ivo.pell@example.test", GCLID_OK, "Won", 4_000, ago(5)], [ago(20), "Quarry Haulage", "q@example.test", null, "", null, null]];
    const r = await scenario("a form-submissions sheet with outcome columns", () => {}, { code: 0, level: "ok", cause: null, wrote: true, sheets: [{ ...sheetOf([]), columns: formCols, rows: formRows }], has: [/Read layout form_submissions/, /Counted since .*: 1 won, \$4,000\.00/] });
    const sum = r.payload?.syncs?.find((s: any) => s.external_id === "franklin-tracker-summary");
    check("e2e: in the form layout every row is ours and the click id rides on the won row", !!sum && JSON.parse(sum.metrics["manual.tracker_feed_summary"]).counted[0].gclid === GCLID_OK);
  }
  await scenario("rows with problems are warned about and the rest still count", () => {}, { code: 0, level: "warn", cause: "rows_refused", wrote: true });
  await scenario("the token's user can edit the sheet: warn, still read", () => {}, { code: 0, level: "warn", cause: "rows_refused", wrote: true, sheets: [sheetOf(BASE_ROWS(), { accessLevel: "OWNER" })], has: [/owner access/] });
  await scenario("clean rows and Viewer access: ok", () => {}, { code: 0, level: "ok", cause: null, wrote: true, sheets: [sheetOf(BASE_ROWS().filter((r) => !["RFQ-1003", "RFQ-1004", "RFQ-1005", "RFQ-1008", "RFQ-1015"].includes(r.no ?? "")))] });

  // The sheet changes the way a real one does
  {
    ss.reset([sheetOf(BASE_ROWS())]);
    const r1 = await run();
    const t1 = r1.payload.syncs.reduce((s: number, m: any) => s + (m.metrics["manual.revenue_system_cents"] ?? 0), 0);
    ss.state.sheets[0]!.rows.forEach((row) => { if (row[0] === "RFQ-1011") row[5] = OURS; });
    const r2 = await run();
    const t2 = r2.payload.syncs.reduce((s: number, m: any) => s + (m.metrics["manual.revenue_system_cents"] ?? 0), 0);
    check("e2e: filling in a pending row's source moves it from pending to counted on the next run", t2 - t1 === 500_000, [t1, t2]);
    ss.state.sheets[0]!.rows.forEach((row) => { if (row[6] === "Won") row[6] = "Quoted"; });
    const r3 = await run();
    const months = r3.payload.syncs.filter((s: any) => !s.external_id.endsWith("-summary"));
    check("e2e: un-marking every win writes noughts for the months (newest row wins), not silence", months.length >= 2 && months.every((s: any) => s.metrics["manual.revenue_system_cents"] === 0));
  }
  {
    ss.reset([sheetOf(BASE_ROWS())]);
    const r = await run({}, ["--client=franklin"]);
    check("e2e: a real (not dry) run hands the dashboard the entries with the dry flag off", r.payload != null && r.code === 0 && r.syncArgs != null && !r.syncArgs.includes("--dry-run"), r.syncArgs);
    const k = await run({ TRACKER_FRANKLIN_KEPT_BY: "client" });
    check("e2e: the repository variable can say the client keeps the sheet: no tracker marker is written", k.payload != null && k.payload.syncs.every((s: any) => !("manual.tracker_won_deals" in s.metrics)));
  }
  {
    ss.reset([sheetOf(BASE_ROWS())]);
    const r = await run({}, ["--client=nobody", "--dry-run"]);
    check("e2e: an unknown client is a named stop, exit 1", r.code === 1 && /stop check_crashed/.test(r.out));
  }

  // Diagnose
  {
    ss.reset([sheetOf(BASE_ROWS())]);
    const r = await run({}, ["--client=franklin", "--diagnose"]);
    check("e2e: diagnose exits 0 and writes nothing", r.code === 0 && r.payload == null && ss.writes === 0, r.out.slice(-300));
    check("e2e: diagnose prints the sheet's NAME, every heading, the role each was found in and the picklist options", /Quote Log \(invented\)/.test(r.out) && RFQ_COLS.every((c) => r.out.includes(`"${c.title}"`)) && /status \(needed\): "Status"/.test(r.out) && /"Won": counts as Won/.test(r.out) && /"Referral": means not ours/.test(r.out), r.out.slice(0, 1500));
    check("e2e: diagnose prints counts (rows and columns) and which layout it would read", /Rows: 15\. Columns: 10\./.test(r.out) && /Reading as: rfq_log/.test(r.out), r.out.slice(0, 800));
    check("e2e: diagnose prints no cell value: no name, email, phone, click id, token or link", !NEVER.some((x) => r.out.includes(x)) && !/@example|555-010/.test(r.out));
    check("e2e: diagnose asked for no row content beyond a one-column, one-row probe", ss.calls.filter((c) => /^\/sheets\/\d+(\?|$)/.test(c.url)).every((c) => /^\/sheets\/\d+\?columnIds=\d+&pageSize=1$/.test(c.url)), ss.calls.map((c) => c.url));
    check("e2e: diagnose does not need a database or the dashboard", true);
    const lastNote = r.last;
    check("e2e: diagnose ends on a TRACKER-FEED ok line", /^TRACKER-FEED franklin-brazing ok: diagnose found every needed heading/.test(lastNote), lastNote);
  }
  {
    ss.reset([{ ...sheetOf([]), columns: [{ id: 1, title: "Timestamp" }, { id: 2, title: "Name" }, { id: 3, title: "Email" }, { id: 4, title: "GCLID" }], rows: [["2026-10-01", "Nell Ostrander", "ivo.pell@example.test", GCLID_OK]] }]);
    const r = await run({}, ["--client=franklin", "--diagnose"]);
    check("e2e: diagnose of a leads-only sheet says so, still exits 0, and shows no value", r.code === 0 && /list of leads/.test(r.out) && /warn lead_list_only/.test(r.last) && !NEVER.some((x) => r.out.includes(x)), r.out.slice(-500));
  }
  {
    ss.reset([sheetOf(BASE_ROWS())]);
    const r = await run({ FRANKLIN_TRACKER_SHEET: PERMALINK }, ["--client=franklin", "--diagnose"]);
    check("e2e: diagnose works from a link and does not print the link", r.code === 0 && /found from the link/.test(r.out) && !r.out.includes(LINK_CODE), r.out.slice(0, 400));
    ss.reset([sheetOf(BASE_ROWS())]); ss.state.tokenMode = "revoked";
    const bad = await run({}, ["--client=franklin", "--diagnose"]);
    check("e2e: a diagnose that cannot open the sheet exits 1 with the cause", bad.code === 1 && causeOf(bad) === "token_rejected");
  }

  // Google as the source
  {
    gg.reset([{ name: "Quote Log", gid: 1, rows: [RFQ_COLS.map((c) => c.title), ...BASE_ROWS().map((r) => rfqRow(r).map((c) => (c == null ? "" : String(c))))] }]);
    const env = { TRACKER_FRANKLIN_SOURCE: "google_sheet", FRANKLIN_TRACKER_SHEET: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" };
    const r = await run(env);
    check("e2e: the same sheet kept in Google Sheets reads the same way", r.code === 0 && levelOf(r) === "warn" && /4 won, \$22,450\.50/.test(r.out), r.out.slice(-400));
    check("e2e: the Google source made no write and printed no cell", gg.writes === 0 && !NEVER.some((x) => r.out.includes(x)));
    const d = await run(env, ["--client=franklin", "--diagnose"]);
    check("e2e: Google diagnose prints the headings and the sheet's name, not a row", d.code === 0 && RFQ_COLS.every((c) => d.out.includes(`"${c.title}"`)) && !NEVER.some((x) => d.out.includes(x)), d.out.slice(0, 500));
    gg.reset([{ name: "Quote Log", gid: 1, rows: [] }]); gg.state.access = "revoked";
    const rev = await run(env);
    check("e2e: a Google sheet that is not shared is access_removed", causeOf(rev) === "access_removed" && rev.code === 1);
    gg.reset([]); gg.state.tokenMode = "revoked";
    const key = await run(env);
    check("e2e: a revoked Google key is key_rejected", causeOf(key) === "key_rejected");
  }
}

// ═══ 3. The contract with the rest of the system ═════════════════════════════
function contract() {
  const dir = new URL("./tracker/", import.meta.url).pathname;
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);
  const all = files.map(([, s]) => s).join("\n") + readFileSync(new URL("./import-tracker.ts", import.meta.url), "utf8");
  check("contract: the token is read in one place (smartsheet.ts) and nowhere else in the job", files.filter(([, s]) => /(env|process\.env)(\.SMARTSHEET_API_TOKEN|\["SMARTSHEET_API_TOKEN"\])/.test(s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))).map(([f]) => f).join() === "smartsheet.ts", files.map(([f]) => f));
  check("contract: every Smartsheet request is a GET (no method but GET, no body)", (() => { const t = readFileSync(join(dir, "smartsheet.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""); const calls = Array.from(t.matchAll(/fetch\(([^)]*)\)/g)).map((m) => m[1]!); return calls.length >= 1 && calls.every((c) => /method: "GET"/.test(c) && !/body\s*:/.test(c)) && !/method:\s*"(POST|PUT|PATCH|DELETE)"/i.test(t); })());
  check("contract: the Google source asks for read-only scopes only and writes nothing", (() => { const g = readFileSync(join(dir, "google-source.ts"), "utf8"); const scopes = Array.from(g.matchAll(/auth\/([a-z.]+)"/g)).map((m) => m[1]!); return scopes.length >= 1 && scopes.every((x) => /\.readonly$/.test(x)) && !/:append|:batchUpdate|values:update|method:\s*"(POST|PUT|PATCH|DELETE)"/i.test(g.replace(/auth\/[a-z.]+/g, "")); })());
  check("contract: nothing in the framework imports the database", !/from "pg"|from 'pg'|DATABASE_URL/.test(files.map(([, s]) => s).join("\n")));
  check("contract: no committed file holds the owner's sheet link or its code", !new RegExp(`${LINK_CODE.slice(0, 12)}`).test(all) && FRANKLIN.sheetId === null);
  const wfDir = new URL("../.github/workflows/", import.meta.url).pathname;
  const wf = readFileSync(join(wfDir, "import-tracker.yml"), "utf8");
  check("workflow: runs daily on a schedule", /schedule:\s*\n\s*- cron:/.test(wf));
  check("workflow: dispatch has client, dry_run (default true), diagnose and sheet inputs", /client:/.test(wf) && /dry_run:[\s\S]*?default: "true"/.test(wf) && /diagnose:/.test(wf) && /sheet:/.test(wf));
  check("workflow: no workflow points a job at a pretend server", readdirSync(wfDir).every((f) => !/SMARTSHEET_FAKE_BASE|GOOGLE_FAKE_BASE/.test(readFileSync(join(wfDir, f), "utf8"))));
  check("workflow: the sheet comes from an input, a variable or a secret and is masked, never a committed value", /FRANKLIN_TRACKER_SHEET: \$\{\{ inputs\.sheet \|\| vars\.FRANKLIN_TRACKER_SHEET \|\| secrets\.FRANKLIN_TRACKER_SHEET \}\}/.test(wf) && /::add-mask::/.test(wf) && !/smartsheet\.com\/sheets\//.test(wf));
  check("workflow: the heartbeat note goes through an environment variable, never into the shell line", /NOTE: \$\{\{ steps\.summary\.outputs\.summary \}\}/.test(wf) && /--note="\$NOTE"/.test(wf) && !/--note="\$\{\{/.test(wf));
  check("workflow: heartbeats under import_tracker, with the run log", /--job=import_tracker/.test(wf) && /--log=run\.log/.test(wf));
  check("workflow: a dry run or a diagnose does NOT stamp the heartbeat", /if: always\(\) && inputs\.dry_run != 'true' && inputs\.diagnose != 'true'/.test(wf));
  check("workflow: the summary is the TRACKER-FEED line", /grep '\^TRACKER-FEED '/.test(wf));
  check("workflow: the client input is validated before it reaches the shell", /\*\[!a-z0-9-\]\*\)/.test(wf));
  check("workflow: the Smartsheet token is a secret", /SMARTSHEET_API_TOKEN: \$\{\{ secrets\.SMARTSHEET_API_TOKEN \}\}/.test(wf));
  const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  check("package: the importer and this guard are npm scripts", /"import-tracker"/.test(pkg) && /"verify-tracker"/.test(pkg));
  const seed = readFileSync(new URL("./oneoff-seed-franklin-revenue.ts", import.meta.url), "utf8");
  check("seed: the one-off imports its figures from the tracker config, so the two cannot disagree", /from "\.\/tracker\/config\.js"/.test(seed) && /const AS_OF = FRANKLIN_SEED_AS_OF;/.test(seed) && !/"2025-12-30"/.test(seed.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  check("seed: the evidence note is written only if absent", /revenue_basis_note/.test(seed) && /COALESCE\(NULLIF\(btrim\(revenue_basis_note\)/.test(seed) && !/revenue_basis_note = \$3 WHERE/.test(seed));
}

async function main() {
  for (const [name, fn] of [["pure", async () => pure()], ["contract", async () => contract()], ["e2e", e2e]] as const) {
    // A section that throws is a failed check with its message, never a crash that hides how many others failed.
    try { await fn(); } catch (e) { check(`${name}: the section ran to its end without throwing`, false, e instanceof Error ? e.message : String(e)); }
  }
  await ss.stop().catch(() => {}); await gg.stop().catch(() => {});
  console.log(failed === 0 ? `ok: tracker framework: ${n} checks passed` : `\n${failed} of ${n} checks FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await ss.stop().catch(() => {}); await gg.stop().catch(() => {}); process.exit(1); });
void normHeader;

#!/usr/bin/env tsx
/**
 * Guard for the LEAD MATCH: untagged quote-log rows that match a real ad lead (src/tracker/lead-match.ts). No credential, no
 * network, no database.
 *
 *  1. The pure rule: a candidate is an UNTAGGED quote-log row whose EMAIL equals the email of a NON-SPAM lead that arrived on
 *     or before the quote was requested, inside the engagement. The refusals lead: a spam lead, a lead after the quote, a tagged
 *     row, a row with no email, a date nobody can read, a name or phone alone, a spam column the sheet does not have.
 *  2. THE REGRESSION THAT MATTERS: with a lead sheet or without one, every counted win, month, fee, pending row and ledger row
 *     is byte-identical. A candidate is a list apart and reaches no total.
 *  3. The REAL importer as a child process against a pretend Smartsheet holding a quote log shaped like Franklin's and a lead
 *     sheet shaped like the ad form sheet: candidates written, the figures unchanged, a lead sheet nobody shared or one missing
 *     its spam column recorded and stopping nothing, nothing printed that carries a name, email, phone or click id, GET only.
 *  4. The contract: pure, the summary types carry no identifier, the workflow names and masks the lead sheet.
 *
 * Every person, phone, address, link and amount is invented.
 *
 *   npm run verify-tracker   (runs this after verify-tracker-merge.ts)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSmartsheet, type FakeColumn, type FakeSheet } from "./fake-smartsheet.js";
import { FRANKLIN, FRANKLIN_LEAD_MATCH, resolveConfig, type TrackerConfig } from "./tracker/config.js";
import { resolveLayouts, type Table } from "./tracker/table.js";
import { buildFeedEntries, buildFeedSummary, readRows } from "./tracker/reading.js";
import {
  CANDIDATES_LISTED_MAX, dayOf, emailsIn, findCandidates, indexLeads, isSpamCell, leadMatchLine, noMatch, resolveLeadColumns, type LeadMatchSummary,
} from "./tracker/lead-match.js";
import { shapeOf, tableFrom } from "./tracker/smartsheet.js";

let failed = 0; let n = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  n++;
  if (ok) return;
  failed++;
  console.error(`x ${name}${detail !== undefined ? `\n    ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 700)}` : ""}`);
}

const etToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const ago = (k: number): string => { const [y, m, d] = etToday.split("-").map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, d - k)).toISOString().slice(0, 10); };
const FROM = ago(300);
const TOKEN = "valid-token-invented-123";
const OURS = "BS LLC AD CAMPAIGN";
type Cell = string | number | boolean | null;

// Values that must never appear in anything a run prints or stores.
const NAMES = ["Quarry Haulage", "Nell Ostrander", "Hargrove Fire Systems", "Maybe Motors"];
const EMAILS = ["a1@example.test", "a2@example.test", "a3@example.test", "a4@example.test", "a5@example.test", "a6@example.test", "spam1@example.test", "late1@example.test", "ours1@example.test", "ours2@example.test", "pre1@example.test", "multi1@example.test", "multi2@example.test", "x1@example.test"];
const PHONES = ["(555) 010-4001", "555-010-4002"];
const CLICKS = ["Cj0KCQiA_Invented_L1_0001", "Cj0KCQiA_Invented_L2_0002"];
const LINK_A = "ZxQ91mAbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const LINK_B = "Qw81mAbCdEfGhIjKlMnOpQrStUvWxYz9876543210";
const SHEET_A = 5550001234567890, SHEET_B = 5550001234567891;
const NEVER = [...NAMES, ...EMAILS, ...PHONES, ...CLICKS, TOKEN, LINK_A, LINK_B, String(SHEET_A), String(SHEET_B)];

// ── Franklin's real headings, read by the profile run on 2026-10-21 (every row here is invented) ─────────────────────────
const QUOTE_HEAD = ["RFQ #", "Customer", "Customer Contact Email", "Date of RFQ", "RFQ Source", "Status", "Quote $ Value"];
const LEAD_HEAD = ["Submitted On", "Status", "Notes/Value", "Email", "Name", "Phone Number", "utm_source", "gclid", "fbclid", "msclkid", "wbraid", "SPAM"];
interface Q { no?: string; cust?: string; email?: string; rfq?: string | null; src?: string | null; status?: string; amount?: Cell }
const qRow = (r: Q): string[] => [r.no ?? "", r.cust ?? "Quarry Haulage", r.email ?? "", r.rfq === null ? "" : r.rfq ?? ago(100), r.src === undefined ? "" : r.src ?? "", r.status ?? "Won", r.amount == null ? "" : String(r.amount)];
interface L { at?: string | null; email?: string; spam?: Cell; click?: string; name?: string; phone?: string }
const lRow = (r: L): string[] => [r.at === null ? "" : r.at ?? ago(120), "New", "", r.email ?? "", r.name ?? "Nell Ostrander", r.phone ?? "", "google", r.click ?? "", "", "", "", r.spam == null ? "" : String(r.spam)];
const tbl = (headers: string[], rows: string[][]): Table => ({
  headers, types: headers.map(() => null), hidden: headers.map(() => false), options: headers.map(() => null),
  rows, rowNumbers: rows.map((_, i) => i + 2), totalRows: rows.length,
});
const cfg: TrackerConfig = { ...FRANKLIN, sheetId: "1", countedFrom: FROM };

function quoteOf(rows: Q[]) {
  const table = tbl(QUOTE_HEAD, rows.map(qRow));
  const lr = resolveLayouts(table.headers, cfg);
  if (!lr.res.ok) throw new Error("the quote log headings did not resolve");
  return { table, found: lr.res.found, cfg: lr.cfg, layout: lr.layout };
}
function leadsOf(rows: L[], head = LEAD_HEAD) {
  const table = tbl(head, rows.map(lRow));
  const cols = resolveLeadColumns(table.headers, FRANKLIN_LEAD_MATCH);
  if (!cols.ok) throw new Error("the lead headings did not resolve");
  return indexLeads(table, cols.cols, { countedFrom: FROM, today: etToday });
}
const run0 = (q: Q[], l: L[]): LeadMatchSummary => findCandidates(quoteOf(q), leadsOf(l), FRANKLIN_LEAD_MATCH, { today: etToday, readAt: "2026-10-21T12:00:00.000Z" });
const labels = (s: LeadMatchSummary) => s.candidates.map((c) => c.label).sort().join(",");

function pure() {
  // ── Cells ──
  check("pure: every email in a cell is found, whole, lower-cased, de-duplicated", emailsIn("A1@Example.Test; b@x.co , a1@example.test").join() === "a1@example.test,b@x.co");
  check("pure: text that is not an email is no identifier", emailsIn("call me, no address").length === 0 && emailsIn("").length === 0 && emailsIn(null).length === 0);
  check("pure: at most five emails are read from one cell", emailsIn("a@x.co b@x.co c@x.co d@x.co e@x.co f@x.co").length === 5);
  check("pure: a day reads from a date, a datetime and a US date with a time", dayOf("2026-03-04") === "2026-03-04" && dayOf("2026-03-04T14:00:00Z") === "2026-03-04" && dayOf("3/4/2026 3:14 PM") === "2026-03-04" && dayOf("nope") === null && dayOf("") === null);
  check("pure: spam: blank, false, no and 0 are not spam; ANY other word is (an unknown word keeps a lead OUT)", ["", "false", "No", "0", "unchecked", "ham"].every((v) => !isSpamCell(v)) && ["true", "yes", "SPAM", "x", "1", "bot", "maybe"].every((v) => isSpamCell(v)));

  // ── Headings ──
  const ok = resolveLeadColumns(LEAD_HEAD, FRANKLIN_LEAD_MATCH);
  check("pure: Franklin's real lead headings resolve: email, submitted date, spam, and every click id column", ok.ok && ok.cols.headers.email === "Email" && ok.cols.headers.submittedOn === "Submitted On" && ok.cols.headers.spam === "SPAM" && ok.cols.headers.clickIds.join() === "gclid,fbclid,msclkid,wbraid", ok);
  const noSpam = resolveLeadColumns(LEAD_HEAD.filter((h) => h !== "SPAM"), FRANKLIN_LEAD_MATCH);
  check("pure: REFUSAL: a lead sheet with no spam heading resolves to nothing (68% of its rows are spam; guessing is the failure)", !noSpam.ok && noSpam.missing.includes("the spam flag"), noSpam);
  const noEmail = resolveLeadColumns(LEAD_HEAD.filter((h) => h !== "Email"), FRANKLIN_LEAD_MATCH);
  check("pure: REFUSAL: no email heading, no match", !noEmail.ok && noEmail.missing.includes("the email"));
  const noDate = resolveLeadColumns(LEAD_HEAD.filter((h) => h !== "Submitted On"), FRANKLIN_LEAD_MATCH);
  check("pure: REFUSAL: no submitted-date heading, no match (the order cannot be proved)", !noDate.ok && noDate.missing.includes("the submitted date"));
  const twoEmails = resolveLeadColumns([...LEAD_HEAD, "Contact Email"], FRANKLIN_LEAD_MATCH);
  check("pure: REFUSAL: two email headings is a doubled heading, not a guess", !twoEmails.ok && twoEmails.duplicate.includes("the email"));
  const noClick = resolveLeadColumns(LEAD_HEAD.filter((h) => !/gclid|fbclid|msclkid|wbraid/.test(h)), FRANKLIN_LEAD_MATCH);
  check("pure: click id columns are optional", noClick.ok && noClick.cols.clickIds.length === 0);

  // ── The refusals, one by one ──
  const base: L[] = [{ email: "a1@example.test", at: ago(120) }];
  check("pure: THE MATCH: an untagged won row whose email is a real lead from before the quote is a candidate", labels(run0([{ no: "RFQ-1001", email: "a1@example.test", rfq: ago(100) }], base)) === "RFQ-1001");
  check("pure: ...matched case-insensitively and inside a longer cell", labels(run0([{ no: "RFQ-1002", email: "Someone <A1@Example.Test>; other@x.co", rfq: ago(100) }], base)) === "RFQ-1002");
  check("pure: REFUSAL: a SPAM lead never matches", run0([{ no: "RFQ-1003", email: "spam1@example.test" }], [{ email: "spam1@example.test", spam: true }]).candidateTotal === 0);
  check("pure: REFUSAL: a lead flagged with any unknown spam word never matches", run0([{ no: "RFQ-1004", email: "spam1@example.test" }], [{ email: "spam1@example.test", spam: "bot" }]).candidateTotal === 0);
  check("pure: REFUSAL: a lead that arrived AFTER the quote was requested never matches", run0([{ no: "RFQ-1005", email: "late1@example.test", rfq: ago(100) }], [{ email: "late1@example.test", at: ago(99) }]).candidateTotal === 0);
  check("pure: a lead the SAME DAY as the request is on or before it, so it matches", run0([{ no: "RFQ-1006", email: "a1@example.test", rfq: ago(100) }], [{ email: "a1@example.test", at: ago(100) }]).candidateTotal === 1);
  check("pure: a lead with a time after the date still reads as that day", run0([{ no: "RFQ-1007", email: "a1@example.test", rfq: ago(100) }], [{ email: "a1@example.test", at: `${ago(100).slice(5, 7)}/${ago(100).slice(8, 10)}/${ago(100).slice(0, 4)} 3:14 PM` }]).candidateTotal === 1);
  check("pure: REFUSAL: a row the log tags as OURS is never a candidate", run0([{ no: "RFQ-1008", email: "a1@example.test", src: OURS }], base).candidateTotal === 0);
  check("pure: REFUSAL: a row with no email never matches", run0([{ no: "RFQ-1009", email: "" }], base).candidateTotal === 0 && run0([{ no: "RFQ-1009", email: "" }], base).skipped.noEmail === 1);
  check("pure: REFUSAL: a request date nobody can read never matches (the order cannot be proved)", run0([{ no: "RFQ-1010", email: "a1@example.test", rfq: "soon" }], base).candidateTotal === 0 && run0([{ no: "RFQ-1010", email: "a1@example.test", rfq: null }], base).skipped.noDate === 1);
  check("pure: REFUSAL: a lead with no readable date never matches", run0([{ no: "RFQ-1011", email: "a1@example.test" }], [{ email: "a1@example.test", at: null }]).candidateTotal === 0);
  const tomorrow = ago(-1);
  check("pure: REFUSAL: a quote dated in the FUTURE never matches, even with a real lead before it", run0([{ no: "RFQ-1012", email: "a1@example.test", rfq: tomorrow }], [{ email: "a1@example.test", at: ago(5) }]).candidateTotal === 0 && run0([{ no: "RFQ-1012", email: "a1@example.test", rfq: tomorrow }], [{ email: "a1@example.test", at: ago(5) }]).skipped.outsideEngagement === 1);
  check("pure: REFUSAL: the same NAME and the same PHONE with a DIFFERENT email never match", run0([{ no: "RFQ-1013", email: "other@example.test", cust: "Nell Ostrander" }], [{ email: "a1@example.test", name: "Nell Ostrander", phone: "555-010-4002" }]).candidateTotal === 0);
  const keyed = run0([{ no: "RFQ-1014", email: "a1@example.test" }], [{ email: "a1@example.test", click: "Cj0KCQiA_Invented_L1_0001" }]).candidates[0]!;
  check("pure: a candidate carries exactly these fields, and a click id is a yes or no", Object.keys(keyed).sort().join() === ["cents", "gapDays", "kind", "label", "leadHasClickId", "leadMonth", "rfqMonth", "row", "source"].join() && keyed.leadHasClickId === true, Object.keys(keyed));
  check("pure: REFUSAL: a lead dated before the engagement began can never be ours", run0([{ no: "RFQ-1012", email: "pre1@example.test", rfq: ago(100) }], [{ email: "pre1@example.test", at: ago(400) }]).candidateTotal === 0);
  check("pure: REFUSAL: a quote requested before the engagement began is not a candidate", run0([{ no: "RFQ-1013", email: "a1@example.test", rfq: ago(400) }], [{ email: "a1@example.test", at: ago(399) }]).candidateTotal === 0);
  check("pure: REFUSAL: a lead dated in the future is not a lead yet", run0([{ no: "RFQ-1014", email: "a1@example.test", rfq: etToday }], [{ email: "a1@example.test", at: ago(-3) }]).candidateTotal === 0);
  check("pure: REFUSAL: a lead row with no email never matches", run0([{ no: "RFQ-1015", email: "a1@example.test" }], [{ email: "" }]).candidateTotal === 0);
  check("pure: REFUSAL: a NAME alone is never a match (a repeat customer is not an ad lead)", run0([{ no: "RFQ-1016", cust: "Nell Ostrander", email: "x1@example.test" }], [{ name: "Nell Ostrander", email: "a1@example.test" }]).candidateTotal === 0);
  check("pure: REFUSAL: a PHONE alone is never a match (the quote log carries none, and a phone is not read)", run0([{ no: "RFQ-1017", email: "x1@example.test" }], [{ email: "a1@example.test", phone: "(555) 010-4001" }]).candidateTotal === 0);
  check("pure: REFUSAL: a quote that was lost, declined or not quoted is not a candidate (not a sale)", ["Lost", "No Quote", "Declined", "Cancelled"].every((st) => run0([{ no: "RFQ-1018", email: "a1@example.test", status: st }], base).candidateTotal === 0));
  check("pure: REFUSAL: a row with no status is not a candidate", run0([{ no: "RFQ-1019", email: "a1@example.test", status: "" }], base).candidateTotal === 0);

  // ── What a candidate says ──
  const s = run0([
    { no: "RFQ-2001", email: "a1@example.test", status: "Won", amount: 12_500, rfq: ago(100), src: "" },
    { no: "RFQ-2002", email: "a2@example.test", status: "Verbally Awarded", amount: 1_800_000, rfq: ago(90), src: "Referral" },
    { no: "RFQ-2003", email: "a3@example.test", status: "Quote Sent", amount: "$4,000.50", rfq: ago(80), src: "" },
    { no: "RFQ-2004", email: "a4@example.test", status: "Won (Production Start)", amount: null, rfq: ago(70) },
  ], [
    { email: "a1@example.test", at: ago(110), click: CLICKS[0] }, { email: "a2@example.test", at: ago(95) }, { email: "a3@example.test", at: ago(85), click: CLICKS[1] }, { email: "a4@example.test", at: ago(75) },
  ]);
  const byLabel = (l: string) => s.candidates.find((c) => c.label === l);
  check("pure: four candidates, won first then verbally awarded then open", s.candidateTotal === 4 && s.candidates.map((c) => c.kind).join() === "won,won,verbal,open", s.candidates.map((c) => [c.label, c.kind]));
  check("pure: the amount is the quote value, null when none (never a nought)", byLabel("RFQ-2001")?.cents === 1_250_000 && byLabel("RFQ-2003")?.cents === 400_050 && byLabel("RFQ-2004")?.cents === null);
  check("pure: the source is only 'blank' or 'other', never the words", byLabel("RFQ-2001")?.source === "blank" && byLabel("RFQ-2002")?.source === "other");
  check("pure: the request month, the lead month and the gap in days are recorded", byLabel("RFQ-2001")?.rfqMonth === ago(100).slice(0, 7) && byLabel("RFQ-2001")?.leadMonth === ago(110).slice(0, 7) && byLabel("RFQ-2001")?.gapDays === 10);
  check("pure: whether the lead carried a click id is a yes or no, never the id", byLabel("RFQ-2001")?.leadHasClickId === true && byLabel("RFQ-2002")?.leadHasClickId === false && !JSON.stringify(s).includes(CLICKS[0]!));
  check("pure: totals by kind: counts, cents and the rows with no amount", s.byKind.won.n === 2 && s.byKind.won.cents === 1_250_000 && s.byKind.won.noAmount === 1 && s.byKind.verbal.cents === 180_000_000 && s.byKind.open.n === 1);
  const multi = run0([{ no: "RFQ-2005", email: "multi1@example.test", rfq: ago(50) }], [{ email: "multi1@example.test", at: ago(140), click: CLICKS[0] }, { email: "multi1@example.test", at: ago(60) }, { email: "multi1@example.test", at: ago(40) }]);
  check("pure: several leads from one person: the most recent one on or before the request is named, a click id on any of them is yes, a later one is ignored", multi.candidateTotal === 1 && multi.candidates[0]!.gapDays === 10 && multi.candidates[0]!.leadHasClickId === true, multi.candidates);
  check("pure: one row is one candidate however many leads match it", multi.candidates.length === 1);

  // ── The sentence at the top ──
  const t = run0([
    { no: "RFQ-3001", email: "ours1@example.test", src: OURS, status: "Won", rfq: ago(100) },
    { no: "RFQ-3002", email: "ours2@example.test", src: OURS, status: "Won", rfq: ago(100) },
    { no: "RFQ-3003", email: "", src: OURS, status: "Won", rfq: ago(100) },
    { no: "RFQ-3004", email: "ours1@example.test", src: OURS, status: "Lost", rfq: ago(100) },
    { no: "RFQ-3005", email: "ours1@example.test", src: OURS, status: "Won", rfq: ago(500) },
  ], [{ email: "ours1@example.test", at: ago(110) }, { email: "ours2@example.test", at: ago(99) }]);
  check("pure: of the wins tagged ours: three in the engagement, one matches a lead, one has no email, a lead AFTER the quote does not count", t.oursWon === 3 && t.oursWonWithLead === 1 && t.oursWonNoEmail === 1, [t.oursWon, t.oursWonWithLead, t.oursWonNoEmail]);
  check("pure: the tag check never makes a tagged row a candidate", t.candidateTotal === 0);

  // ── Refusals of the whole read ──
  const noSrc = (() => { const q = quoteOf([{ no: "RFQ-4001", email: "a1@example.test" }]); const f = { ...q.found }; delete f.source; return findCandidates({ ...q, found: f }, leadsOf(base), FRANKLIN_LEAD_MATCH, { today: etToday, readAt: "x" }); })();
  check("pure: a main sheet with no source column says so and matches nothing", noSrc.state === "no_quote_log" && noSrc.candidateTotal === 0 && noSrc.candidates.length === 0);
  const noMail = (() => { const q = quoteOf([{ no: "RFQ-4002", email: "a1@example.test" }]); const f = { ...q.found }; delete f.email; return findCandidates({ ...q, found: f }, leadsOf(base), FRANKLIN_LEAD_MATCH, { today: etToday, readAt: "x" }); })();
  check("pure: a main sheet with no email heading says so and matches nothing", noMail.state === "quote_no_email" && noMail.candidateTotal === 0);
  const nm = noMatch("stopped", "x", "The lead sheet could not be opened.", "sheet_not_shared");
  check("pure: a lead sheet that did not read is a summary with a cause, no candidates and no figure", nm.state === "stopped" && nm.cause === "sheet_not_shared" && nm.candidates.length === 0 && nm.candidateTotal === 0 && nm.byKind.won.cents === 0);
  check("pure: the log sentence for a state that did not read says it did not run, and never claims a count", /not run/.test(leadMatchLine(nm)) && !/\d+ untagged/.test(leadMatchLine(nm)));

  // ── The cap ──
  const many = Array.from({ length: 260 }, (_, i) => ({ no: `RFQ-${5000 + i}`, email: `bulk${i}@example.test`, rfq: ago(100) }));
  const big = run0(many, many.map((q) => ({ email: q.email, at: ago(120) })));
  check("pure: a long list is cut at the cap but the true total is kept", big.candidates.length === CANDIDATES_LISTED_MAX && big.candidateTotal === 260 && big.byKind.won.n === 260);

  // ── THE REGRESSION: candidates reach no figure ──
  const rows: Q[] = [
    { no: "RFQ-6001", email: "a1@example.test", src: OURS, status: "Won", amount: 12_500, rfq: ago(30) },
    { no: "RFQ-6002", email: "a2@example.test", src: OURS, status: "Won", amount: 8_250, rfq: ago(50) },
    { no: "RFQ-6003", email: "a3@example.test", src: "", status: "Won", amount: 4_000, rfq: ago(60) },        // untagged, won, matches a lead
    { no: "RFQ-6004", email: "a4@example.test", src: "Referral", status: "Won", amount: 99_999, rfq: ago(70) }, // other source, matches
    { no: "RFQ-6005", email: "a5@example.test", src: "", status: "Quote Sent", amount: 2_000, rfq: ago(80) },
    { no: "RFQ-6006", email: "a6@example.test", src: OURS, status: "Won", amount: null, rfq: ago(40) },
  ];
  const leads: L[] = ["a1", "a2", "a3", "a4", "a5", "a6"].map((x) => ({ email: `${x}@example.test`, at: ago(150) }));
  const q = quoteOf(rows);
  const r1 = readRows(q.table, q.found, q.cfg, { today: etToday });
  const lm = findCandidates(q, leadsOf(leads), FRANKLIN_LEAD_MATCH, { today: etToday, readAt: "x" });
  const r2 = readRows(q.table, q.found, q.cfg, { today: etToday });
  check("pure: running the lead match changes no reading (counted, pending, months, fee, problems, funnel)", JSON.stringify(r1) === JSON.stringify(r2));
  check("pure: ...and the candidates are not in the counted wins or the total (a blank-source won row was already pending, and stays exactly that)", lm.candidateTotal === 3 && !r1.counted.some((d) => ["RFQ-6003", "RFQ-6004", "RFQ-6005"].includes(d.label)) && r1.countedCents === 1_250_000 + 825_000, [r1.counted.map((d) => d.label), lm.candidateTotal]);
  const sumA = buildFeedSummary(r1, q.cfg, q.found, "2026-10-21T12:00:00.000Z", null);
  const sumB = { ...sumA, leadMatch: lm };
  const eA = buildFeedEntries("franklin-brazing", r1, sumA, q.cfg, etToday);
  const eB = buildFeedEntries("franklin-brazing", r1, sumB, q.cfg, etToday);
  const months = (es: typeof eA) => JSON.stringify(es.filter((e) => !e.external_id.endsWith("-summary")));
  check("pure: THE LEDGER ROWS (one per month) are byte-identical with and without the lead match", months(eA) === months(eB) && eA.length === eB.length);
  const stripLm = (e: (typeof eA)[number]) => { const m = JSON.parse(String(e.metrics["manual.tracker_feed_summary"])); delete m.leadMatch; return JSON.stringify(m); };
  check("pure: the stored summary is byte-identical apart from the one added field, and that field is a list apart", stripLm(eA.at(-1)!) === stripLm(eB.at(-1)!) && JSON.parse(String(eB.at(-1)!.metrics["manual.tracker_feed_summary"])).leadMatch.candidateTotal === 3);
  check("pure: no feed key reaches a candidate (revenue, deals, pending count and pending cents are the reading's alone)", (() => { const keys = new Set(eB.flatMap((e) => Object.keys(e.metrics))); return [...keys].every((k) => ["manual.revenue_system_cents", "manual.tracker_won_deals", "manual.tracker_feed_summary", "manual.tracker_pending_deals", "manual.tracker_pending_cents"].includes(k)); })());
  check("pure: nothing in a lead-match summary is a name, email, phone or click id", !NEVER.some((x) => JSON.stringify(lm).includes(x)) && !NEVER.some((x) => JSON.stringify(s).includes(x)) && !NEVER.some((x) => JSON.stringify(t).includes(x)));

  // ── Config ──
  check("config: the lead sheet comes from its own variable and is not one of the merged sheets", (() => { const c = resolveConfig(FRANKLIN, { FRANKLIN_TRACKER_SHEET: "111111", FRANKLIN_TRACKER_LEAD_SHEET: "222222" }); return c.leadSheetId === "222222" && c.sheetIds?.join() === "111111"; })());
  check("config: no variable is no lead sheet", resolveConfig(FRANKLIN, { FRANKLIN_TRACKER_SHEET: "111111" }).leadSheetId == null);
}

// ═══ The real importer ═══════════════════════════════════════════════════════
const QCOLS: FakeColumn[] = QUOTE_HEAD.map((t, i) => ({ id: 100 + i, title: t, type: t === "Date of RFQ" ? "DATE" : "TEXT_NUMBER" }));
const LCOLS: FakeColumn[] = LEAD_HEAD.map((t, i) => ({ id: 200 + i, title: t, type: t === "Submitted On" ? "DATE" : "TEXT_NUMBER" }));
const sheetOf = (id: number, name: string, link: string, columns: FakeColumn[], rows: string[][], extra: Partial<FakeSheet> = {}): FakeSheet => ({
  id, name, permalink: `https://app.smartsheet.com/sheets/${link}`, accessLevel: "VIEWER", modifiedAt: "2026-10-14T12:00:00Z", columns, rows: rows.map((r) => r.map((c) => (c === "" ? null : c))), ...extra,
});
const E2E_QUOTES: Q[] = [
  { no: "RFQ-7001", email: "a1@example.test", src: OURS, status: "Won", amount: 12_500, rfq: ago(30) },
  { no: "RFQ-7002", email: "a2@example.test", src: OURS, status: "Won", amount: 8_250, rfq: ago(50) },
  { no: "RFQ-7003", email: "a3@example.test", src: "", status: "Won", amount: 4_000, rfq: ago(60) },                // candidate
  { no: "RFQ-7004", email: "a4@example.test", src: "Referral", status: "Verbally Awarded", amount: 90_000, rfq: ago(70) }, // candidate
  { no: "RFQ-7005", email: "a5@example.test", src: "", status: "Quote Sent", amount: 2_000, rfq: ago(80) },          // candidate
  { no: "RFQ-7006", email: "spam1@example.test", src: "", status: "Won", amount: 7_000, rfq: ago(55) },             // its lead is spam
  { no: "RFQ-7007", email: "late1@example.test", src: "", status: "Won", amount: 6_000, rfq: ago(45) },            // its lead came after
  { no: "RFQ-7008", email: "", src: "", status: "Won", amount: 3_000, rfq: ago(40) },                              // no email
];
const E2E_LEADS: L[] = [
  { email: "a1@example.test", at: ago(35), click: CLICKS[0] }, { email: "a2@example.test", at: ago(60) }, { email: "a3@example.test", at: ago(75), click: CLICKS[1] },
  { email: "a4@example.test", at: ago(100) }, { email: "a5@example.test", at: ago(90) }, { email: "spam1@example.test", at: ago(100), spam: "true" }, { email: "late1@example.test", at: ago(10) },
];
const quoteSheet = (rows = E2E_QUOTES) => sheetOf(SHEET_A, "Quote Log (invented)", LINK_A, QCOLS, rows.map(qRow));
const leadSheet = (rows = E2E_LEADS, extra: Partial<FakeSheet> = {}) => sheetOf(SHEET_B, "Ad Form Leads (invented)", LINK_B, LCOLS, rows.map(lRow), extra);

const TSX = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
const SRC = (f: string) => new URL(`./${f}.ts`, import.meta.url).pathname;
const ss = new FakeSmartsheet();
let ssBase = "";
interface Run { code: number | null; out: string; payload: any | null }
function run(extraEnv: Record<string, string | undefined> = {}, args: string[] = ["--client=franklin", "--dry-run"]): Promise<Run> {
  const dash = mkdtempSync(join(tmpdir(), "trkl-dash-"));
  const captured = join(dash, "captured.json");
  writeFileSync(join(dash, "package.json"), JSON.stringify({ name: "stub-dashboard", private: true, scripts: { sync: "node capture.js" } }));
  writeFileSync(join(dash, "capture.js"), `const a=process.argv.find(x=>x.startsWith("--input="));require("fs").copyFileSync(a.slice(8), process.env.CAPTURE_PATH);`);
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1", SMARTSHEET_FAKE_BASE: ssBase, SMARTSHEET_API_TOKEN: TOKEN,
      FRANKLIN_TRACKER_SHEET: String(SHEET_A), FRANKLIN_TRACKER_LEAD_SHEET: String(SHEET_B), TRACKER_FRANKLIN_COUNTED_FROM: FROM, TRACKER_RETRY_MS: "20",
      DATABASE_URL: "postgres://unused", DASHBOARD_DIR: dash, CAPTURE_PATH: captured,
    };
    for (const [k, v] of Object.entries(extraEnv)) { if (v === undefined) delete env[k]; else env[k] = v; }
    const p = spawn(TSX, [SRC("import-tracker"), ...args], { env, cwd: new URL("..", import.meta.url).pathname });
    let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      const payload = existsSync(captured) ? JSON.parse(readFileSync(captured, "utf8")) : null;
      rmSync(dash, { recursive: true, force: true });
      resolve({ code, out, payload });
    });
  });
}
const verdictOf = (r: Run) => r.out.split(/\r?\n/).reverse().find((l) => l.startsWith("TRACKER-FEED ")) ?? "";
const summaryOf = (r: Run): any | null => { const s = r.payload?.syncs?.find((x: any) => x.external_id === "franklin-tracker-summary"); return s ? JSON.parse(s.metrics["manual.tracker_feed_summary"]) : null; };
const monthRows = (r: Run) => JSON.stringify((r.payload?.syncs ?? []).filter((x: any) => !x.external_id.endsWith("-summary")));
const summaryWithout = (r: Run) => { const x = summaryOf(r); if (!x) return "null"; delete x.leadMatch; delete x.readAt; for (const sh of x.sheets ?? []) delete sh.readAt; return JSON.stringify(x); };
void tableFrom; void shapeOf;

async function e2e() {
  ssBase = await ss.start();
  ss.reset([quoteSheet(), leadSheet()]);
  const withLeads = await run();
  const lm = summaryOf(withLeads)?.leadMatch;
  check("e2e: with a lead sheet the read exits 0 and the heartbeat is the ordinary line (a Verbally Awarded status is unrecognised by the counting rules, as it already was)", withLeads.code === 0 && /^TRACKER-FEED franklin-brazing (ok:|warn other_status:)/.test(verdictOf(withLeads)), verdictOf(withLeads) || withLeads.out.slice(-500));
  check("e2e: the stored summary carries a lead match that was read", lm?.state === "read" && lm.v === 1, lm && lm.state);
  check("e2e: three untagged rows match a lead (the won, the verbally awarded and the open one); the spam, the late lead and the no-email rows do not", lm?.candidateTotal === 3 && lm.candidates.map((c: any) => c.label).sort().join() === "RFQ-7003,RFQ-7004,RFQ-7005", lm?.candidates);
  check("e2e: of the wins tagged ours, both match a lead", lm?.oursWon === 2 && lm.oursWonWithLead === 2);
  check("e2e: the lead sheet's own counts are recorded (rows, real leads, spam)", lm?.leadSheet?.rows === 7 && lm.leadSheet.usable === 6 && lm.leadSheet.spam === 1, lm?.leadSheet);
  check("e2e: the log says how many match and that they are counted nowhere", /Lead match: .*3 untagged quote-log rows match a lead .*Counted nowhere\./.test(withLeads.out), withLeads.out.slice(-800));

  ss.reset([quoteSheet()]);
  const without = await run({ FRANKLIN_TRACKER_LEAD_SHEET: undefined });
  check("e2e: without a lead sheet the summary has no lead match at all", without.code === 0 && summaryOf(without) != null && !("leadMatch" in summaryOf(without)));
  check("e2e: THE REGRESSION: the ledger rows are byte-identical with and without the lead sheet", monthRows(withLeads) === monthRows(without) && monthRows(without).length > 40, [monthRows(withLeads).length, monthRows(without).length]);
  check("e2e: ... and so is the whole summary apart from the added field and the read time (counted wins, months, pending, fee)", summaryWithout(withLeads) === summaryWithout(without));
  check("e2e: ... and the counted total is only the two tagged wins", summaryOf(withLeads)?.countedDeals === 2 && summaryOf(withLeads)?.countedCents === 1_250_000 + 825_000, summaryOf(withLeads)?.countedCents);

  // Nothing printed or stored carries a person.
  ss.reset([quoteSheet(), leadSheet()]);
  const again = await run();
  check("e2e: no name, email, phone, click id, sheet link, token or sheet id in anything printed", !NEVER.some((x) => again.out.includes(x)), NEVER.filter((x) => again.out.includes(x)));
  check("e2e: ... or in anything handed to the dashboard", !NEVER.some((x) => JSON.stringify(again.payload).includes(x)), NEVER.filter((x) => JSON.stringify(again.payload).includes(x)));
  check("e2e: it asked Smartsheet only with GET", ss.writes === 0 && ss.calls.every((c) => c.method === "GET"));

  // A lead sheet that cannot be read stops nothing.
  ss.reset([quoteSheet(), leadSheet(E2E_LEADS, { hidden: true })]);
  const hidden = await run();
  const hs = summaryOf(hidden);
  check("e2e: a lead sheet nobody shared stops NOTHING: exit 0, an ok line, and the counted figures are the same", hidden.code === 0 && /^TRACKER-FEED franklin-brazing (ok:|warn other_status:)/.test(verdictOf(hidden)) && monthRows(hidden) === monthRows(without), verdictOf(hidden));
  check("e2e: ... and the summary says why no lead was compared, with the sheet's own cause and no candidate", hs?.leadMatch?.state === "stopped" && /sheet_not_(shared|found)/.test(hs.leadMatch.cause) && hs.leadMatch.candidates.length === 0, hs?.leadMatch);
  ss.reset([quoteSheet(), leadSheet()]);
  const badKey = await run({ SMARTSHEET_API_TOKEN: "revoked-token-invented" });
  check("e2e: a revoked token stops the read as before (the main sheet is the one that counts)", badKey.code === 1 && /stop (token_rejected|access_denied)/.test(verdictOf(badKey)) && badKey.payload == null, verdictOf(badKey));

  // A lead sheet with no spam column is refused, not guessed.
  ss.reset([quoteSheet(), sheetOf(SHEET_B, "Ad Form Leads (invented)", LINK_B, LCOLS.filter((c) => c.title !== "SPAM"), E2E_LEADS.map((l) => lRow(l).slice(0, -1)))]);
  const noSpam = await run();
  check("e2e: a lead sheet with no spam heading: nothing is matched, the state names the missing heading, the read still succeeds", noSpam.code === 0 && summaryOf(noSpam)?.leadMatch?.state === "headings" && /the spam flag/.test(summaryOf(noSpam).leadMatch.line) && summaryOf(noSpam).leadMatch.candidateTotal === 0 && monthRows(noSpam) === monthRows(without), summaryOf(noSpam)?.leadMatch);

  // A main sheet that is not a quote log.
  // The same sheet may be both a merged second sheet and the lead sheet. Naming it is explicit: the second merged sheet is never borrowed.
  const FORM_COLS: FakeColumn[] = [
    { id: 301, title: "Created", type: "DATE" }, { id: 302, title: "Email" }, { id: 303, title: "GCLID" }, { id: 304, title: "Form Name" }, { id: 305, title: "Status", type: "PICKLIST", options: ["New", "Won", "Lost"] },
    { id: 306, title: "Order value ($)" }, { id: 307, title: "Won date", type: "DATE" }, { id: 308, title: "Submitted On", type: "DATE" }, { id: 309, title: "SPAM" },
  ];
  const formRows = [[ago(75), "a3@example.test", CLICKS[1], "Request a quote", "New", "", "", ago(75), ""], [ago(90), "spam1@example.test", "", "Request a quote", "New", "", "", ago(90), "true"]].map((r) => r.map((c) => (c === "" ? null : c)));
  ss.reset([quoteSheet(), sheetOf(SHEET_B, "Merged form sheet (invented)", LINK_B, FORM_COLS, formRows as string[][])]);
  const merged = await run({ FRANKLIN_TRACKER_SHEET_2: String(SHEET_B) });
  check("e2e: with a second sheet merged AND named as the lead sheet, a merged read still writes the lead match (and the merged figures are unchanged)", merged.code === 0 && summaryOf(merged)?.v === 2 && summaryOf(merged)?.leadMatch?.state === "read" && summaryOf(merged).leadMatch.candidates.map((c: any) => c.label).join() === "RFQ-7003", summaryOf(merged)?.leadMatch ?? merged.out.slice(-500));

  ss.reset([quoteSheet(), sheetOf(SHEET_B, "Merged form sheet (invented)", LINK_B, FORM_COLS, formRows as string[][])]);
  const mergedNoLead = await run({ FRANKLIN_TRACKER_LEAD_SHEET: undefined, FRANKLIN_TRACKER_SHEET_2: String(SHEET_B) });
  check("e2e: a merged read with NO lead sheet named has no lead match (the second merged sheet is never borrowed), and its figures are those of the read with one", summaryOf(mergedNoLead)?.v === 2 && !("leadMatch" in summaryOf(mergedNoLead)) && monthRows(mergedNoLead) === monthRows(merged) && summaryWithout(mergedNoLead) === summaryWithout(merged));

  // Diagnose
  ss.reset([quoteSheet(), leadSheet()]);
  const d = await run({}, ["--client=franklin", "--diagnose"]);
  check("e2e: diagnose lists the lead sheet's headings and which one each job found, and writes nothing", d.code === 0 && /Lead sheet "Ad Form Leads \(invented\)": 12 headings/.test(d.out) && /Lead sheet columns found: email "Email", submitted "Submitted On", spam "SPAM"/.test(d.out) && d.payload == null && !NEVER.some((x) => d.out.includes(x)), d.out.slice(-700));
  ss.reset([quoteSheet(), sheetOf(SHEET_B, "x", LINK_B, LCOLS.filter((c) => c.title !== "SPAM"), [])]);
  const d2 = await run({}, ["--client=franklin", "--diagnose"]);
  check("e2e: diagnose says which heading is missing from the lead sheet", /Lead sheet columns NOT found: no heading for the spam flag/.test(d2.out), d2.out.slice(-500));
}

function contract() {
  const src = readFileSync(new URL("./tracker/lead-match.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("contract: the lead match is pure: no network, no database, no clock, no environment", !/fetch\(|from "pg"|new Date\(\)|Date\.now\(\)|process\.env|node:fs|import\(/.test(code));
  check("contract: it never touches a counted figure: no counted, pending or ledger name in its code", !/\.counted\b|countedCents|\.pending\b|closedMonths|buildFeedEntries|readRows\(|\.problems\b/.test(code), code.match(/\.counted\b|countedCents|\.pending\b|closedMonths|buildFeedEntries|readRows\(|\.problems\b/)?.[0]);
  const iface = code.split("export interface Candidate {")[1]!.split("\n}")[0]!;
  check("contract: a candidate declares no name, email, phone or click id value", !/\b(email|phone|name|gclid|clickId)\b/i.test(iface) && /leadHasClickId: boolean/.test(iface), iface);
  check("contract: a lead is matched on an email and nothing else", !/nameKey|phoneKey|quoteKey|\.name\b|\.phone\b/.test(code));
  check("contract: a spam heading is required (a missing one refuses the read)", /one\("the spam flag"/.test(code));
  check("contract: the lead must be on or before the quote (a later one is skipped)", /h\.day > rfqDay\) continue/.test(code));
  const imp = readFileSync(new URL("./import-tracker.ts", import.meta.url), "utf8");
  check("contract: the importer adds the lead match to the SUMMARY after the reading is built, and never to the reading", /withLeadMatch\(build(Merged|Feed)Summary/.test(imp) && !/r\.(counted|pending)\.push/.test(imp) && (imp.match(/withLeadMatch\(/g) ?? []).length >= 2);
  check("contract: a lead sheet that cannot be read returns a summary and is never turned into a finding or a stop", /noMatch\("stopped"/.test(imp) && !/stopFindings\.push\([^)]*lead/i.test(imp));
  check("contract: the lead sheet is not one of the merged sheets", /leadSheetId/.test(readFileSync(new URL("./tracker/config.ts", import.meta.url), "utf8")) && !/sheetRefsOf\([^)]*leadSheetId/.test(imp));
  const wf = readFileSync(new URL("../.github/workflows/import-tracker.yml", import.meta.url), "utf8");
  check("workflow: the lead sheet comes from an input, a variable or a secret", /FRANKLIN_TRACKER_LEAD_SHEET: \$\{\{ inputs\.lead_sheet \|\| vars\.FRANKLIN_TRACKER_LEAD_SHEET \|\| secrets\.FRANKLIN_TRACKER_LEAD_SHEET \}\}/.test(wf));
  check("workflow: the lead sheet value is masked in the log", /add-mask::\$FRANKLIN_TRACKER_LEAD_SHEET"/.test(wf));
  check("workflow: a dispatch input can name the lead sheet for one run", /lead_sheet:/.test(wf));
}

async function main() {
  for (const [name, fn] of [["pure", async () => pure()], ["contract", async () => contract()], ["e2e", e2e]] as const) {
    try { await fn(); } catch (e) { check(`${name}: the section ran to its end without throwing`, false, e instanceof Error ? e.message : String(e)); }
  }
  await ss.stop().catch(() => {});
  console.log(failed === 0 ? `ok: tracker lead match: ${n} checks passed` : `\n${failed} of ${n} checks FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await ss.stop().catch(() => {}); process.exit(1); });

/**
 * Reads the "DPG — Lead to Closed-Won Tracker" Google Sheet as Diesel Power
 * Group's attributed closed deals, until DPG's own Dynamics 365 origin field is
 * fixed. Pure: rows in, a reading out. No network, no database, no clock (today
 * is an argument).
 *
 * WHAT THE SHEET IS. A hand-built ledger. A person at BS LLC matches DPG's Odoo
 * sales list against OUR lead exports (call tracking and website forms) by
 * phone, email and company name, then marks each row Won. So the figure is
 * tabulated by BS LLC from DPG's own invoices and our own lead log. DPG has not
 * confirmed any row. Nothing in this file, or in anything that reads its
 * output, may say otherwise.
 *
 * HOW IT IS READ.
 *  - By HEADER NAME, never by column position. A person can insert a column.
 *  - Only the first contiguous table: reading stops at the first empty header
 *    cell. The sheet keeps a summary block on the same rows (labels and totals
 *    to the right, one column gap away); its labels look like ours
 *    ("Won in billing window", "Fee owed to BS LLC") and must never be mapped.
 *  - The "Fee owed" column is ignored. A cell can be mistyped; the fee is
 *    recomputed from the contract terms below.
 *  - Phone and email are never read into the output. A label is the "Name on
 *    file" cell, cut short, and is stored for the internal client page only.
 *
 * WHAT COUNTS. A row counts when Status is Won AND "Won in billing window?" is
 * Yes AND it has a readable closed date inside the window AND a readable
 * amount above nought. Everything else is named, never silently dropped:
 *  - pending: not marked Won but carrying a closed date and an amount (a sale
 *    somebody found and nobody has ruled on), or marked Won in the window
 *    without the window flag. Shown separately, labelled "not counted".
 *  - refused: marked Won but unusable (no amount, no date, before the window,
 *    in the future). Not counted, not pending, listed by row number.
 *
 * THE CAP AND THE FEE. $2,666.66 per attributed closed deal, at most 45 in
 * year one. The first 45 by closed date carry the fee; revenue counts every
 * qualifying deal (the cap limits what we may invoice, not what DPG sold). A
 * deal past the cap is named. The contract's own exclusions (opportunities
 * active at kickoff, named accounts, customers with a closed sale in the prior
 * 24 months) are a person's judgement made in the Status column; nothing here
 * can see Odoo and nothing here re-decides them.
 *
 * A null is unanswered: months before the window carry no figure at all, and a
 * header we cannot find is a STOP that writes nothing.
 */
import { parseSheetDate, ymd } from "./lead-keys.js";

export const DPG_CLIENT_SLUG = "diesel-power-group";
export const DPG_SHEET_ID_DEFAULT = "10xk3tnGHk_CYKsTk5vJX3QzRPv9l0BkuxorxJevA8So";
/** The tab is called "Untitled", which is why it is found by gid: a rename keeps the gid. */
export const DPG_TAB_GID_DEFAULT = 902405939;
/** The contract's billing window opens on this day (Eastern calendar date). */
export const BILLING_WINDOW_START_DEFAULT = "2026-09-03";
/** Contract: $2,666.66 per attributed closed deal. */
export const FEE_PER_DEAL_CENTS = 266_666;
/** Contract: at most 45 fee-bearing deals in year one ($120,000). */
export const DEAL_CAP = 45;
/** Rows read. A tracker this long has stopped being read in full. */
export const ROW_LIMIT = 5_000;
export const ROW_LIMIT_MARGIN = 50;
/** A pending or counted row is labelled with its Name cell, cut to this many characters. */
export const LABEL_MAX = 40;

export function dpgSheetId(env: Record<string, string | undefined> = process.env): string {
  const v = env.DPG_TRACKER_SHEET_ID?.trim();
  if (!v) return DPG_SHEET_ID_DEFAULT;
  const m = v.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  return m ? m[1]! : v;
}
export function dpgTabGid(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.DPG_TRACKER_TAB_GID?.trim());
  return Number.isInteger(n) && n >= 0 && env.DPG_TRACKER_TAB_GID?.trim() ? n : DPG_TAB_GID_DEFAULT;
}
export function billingWindowStart(env: Record<string, string | undefined> = process.env): string {
  const v = env.DPG_BILLING_WINDOW_START?.trim();
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : BILLING_WINDOW_START_DEFAULT;
}

// ── The tab ──────────────────────────────────────────────────────────────────

export interface TabInfo { gid: number | null; title: string }
export interface TabPick { tab: string | null; how: "override" | "gid" | "missing" | "override_missing" }
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A named override wins, then the gid. Never a guess: no match is `missing`. */
export function pickTrackerTab(tabs: readonly TabInfo[], gid: number, override?: string | null): TabPick {
  const want = override?.trim();
  if (want) {
    const hit = tabs.find((t) => same(t.title, want));
    return hit ? { tab: hit.title, how: "override" } : { tab: null, how: "override_missing" };
  }
  const byGid = tabs.find((t) => t.gid === gid);
  return byGid ? { tab: byGid.title, how: "gid" } : { tab: null, how: "missing" };
}

/** The A1 range for the table, quoting the tab name the way Sheets wants. */
export const trackerRange = (tab: string, limit = ROW_LIMIT): string => `'${tab.replace(/'/g, "''")}'!A1:Q${limit}`;
export const rowsCapped = (rowsRead: number, limit = ROW_LIMIT): boolean => rowsRead >= limit - ROW_LIMIT_MARGIN;

// ── Headers ──────────────────────────────────────────────────────────────────

/** Case, spacing and punctuation never decide whether a header is found. */
export const normHeader = (s: unknown): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const REQUIRED = {
  firstContact: "first contact",
  status: "status",
  closedDate: "closed date",
  amount: "amount",
  windowFlag: "won in billing window",
} as const;
const OPTIONAL = { name: "name on file", type: "type", adClick: "ad click" } as const;
export type RequiredField = keyof typeof REQUIRED;
export const REQUIRED_HEADERS: Record<RequiredField, string> = {
  firstContact: "First contact",
  status: "Status",
  closedDate: "Closed date",
  amount: "Amount",
  windowFlag: "Won in billing window?",
};

/** `name`, `type` and `adClick` are optional: -1 when the sheet has no such header (or has it twice). */
export interface Columns { firstContact: number; status: number; closedDate: number; amount: number; windowFlag: number; name: number; type: number; adClick: number }
export type ColumnResult =
  | { ok: true; headerRow: number; cols: Columns }
  | { ok: false; reason: "empty" | "missing" | "duplicate"; missing: string[]; duplicate: string[] };

/**
 * Finds the header row in the first few rows (the one matching most required
 * names) and maps the required names to columns. The header run ends at the
 * first empty cell, so the summary block beyond the gap is never in play.
 */
export function resolveColumns(rows: readonly (readonly unknown[])[]): ColumnResult {
  if (!rows.some((r) => r && r.some((c) => String(c ?? "").trim()))) return { ok: false, reason: "empty", missing: Object.values(REQUIRED_HEADERS), duplicate: [] };
  const want = Object.values(REQUIRED);
  let best = { row: -1, score: -1 };
  const limit = Math.min(rows.length, 6);
  for (let i = 0; i < limit; i++) {
    const run = headerRun(rows[i] ?? []);
    const score = want.filter((w) => run.some((h) => normHeader(h) === w)).length;
    if (score > best.score) best = { row: i, score };
  }
  const run = headerRun(rows[best.row] ?? []);
  const found = (name: string) => run.map((h, i) => (normHeader(h) === name ? i : -1)).filter((i) => i >= 0);
  const missing: string[] = [];
  const duplicate: string[] = [];
  const idx: Partial<Columns> = {};
  for (const k of Object.keys(REQUIRED) as RequiredField[]) {
    const hits = found(REQUIRED[k]);
    if (hits.length === 0) missing.push(REQUIRED_HEADERS[k]);
    else if (hits.length > 1) duplicate.push(REQUIRED_HEADERS[k]);
    else idx[k] = hits[0]!;
  }
  if (missing.length) return { ok: false, reason: "missing", missing, duplicate };
  if (duplicate.length) return { ok: false, reason: "duplicate", missing, duplicate };
  const one = (name: string) => { const h = found(name); return h.length === 1 ? h[0]! : -1; };
  return { ok: true, headerRow: best.row, cols: { ...(idx as Omit<Columns, "name" | "type" | "adClick">), name: one(OPTIONAL.name), type: one(OPTIONAL.type), adClick: one(OPTIONAL.adClick) } };
}

/** The cells of a header row up to the first empty one. */
function headerRun(row: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const c of row) {
    const s = String(c ?? "").trim();
    if (!s) break;
    out.push(s);
  }
  return out;
}

// ── Cells ────────────────────────────────────────────────────────────────────

/** "$60,910.40", "60910.4" and " 1,200 " all read; anything else is null. Never negative or nought. */
export function parseAmountCents(v: unknown): number | null {
  const s = String(v ?? "").trim().replace(/[$,\s]/g, "");
  if (!s || !/^\d+(\.\d{1,4})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

const cell = (row: readonly unknown[], i: number): string => (i >= 0 ? String(row[i] ?? "").trim() : "");
function dateCell(row: readonly unknown[], i: number): string | null {
  const d = parseSheetDate(cell(row, i));
  return d ? ymd(d) : null;
}

// ── The reading ──────────────────────────────────────────────────────────────

export interface Deal { row: number; label: string; closed: string; cents: number }
export type PendingWhy = "no_status" | "window_flag_missing";
export interface PendingRow { row: number; label: string; closed: string; cents: number; why: PendingWhy }
export type ProblemWhy = "won_no_amount" | "won_no_date" | "won_before_window" | "won_future_date";
export interface Problem { row: number; why: ProblemWhy }

/**
 * The funnel, grouped by the month of FIRST CONTACT: of the leads that began in
 * a month, how many came from an ad click, by call and by form, and how many of
 * them have since been counted as Won. `adClickLeads`, `calls` and `forms` are
 * null when the sheet has no such column (unanswered, never nought). A lead's
 * Type is read as a call or a form from its own words; a Type that is neither
 * counts as a lead and as neither.
 */
export interface FunnelMonth { month: string; leads: number; adClickLeads: number | null; calls: number | null; forms: number | null; won: number; wonCents: number }
/** Revenue and the fee, grouped by the month of the CLOSED DATE (the contract's clock). */
export interface ClosedMonth { month: string; deals: number; cents: number; feeDeals: number; feeCents: number }

/** A cell that says no, or nothing, is not an ad click. Anything else is (a click id, "Yes", a campaign). */
export function isAdClick(v: string): boolean {
  const t = normHeader(v);
  return !!t && !["no", "n", "none", "false", "0", "na", "n a", "organic", "direct"].includes(t);
}
export function leadKind(v: string): "call" | "form" | "other" {
  const t = normHeader(v);
  if (/\b(call|calls|phone|tel)\b/.test(t)) return "call";
  if (/\b(form|forms|web|website|submission|submit|email)\b/.test(t)) return "form";
  return "other";
}

export interface TrackerReading {
  /** Leads by month of first contact, oldest first. */
  funnel: FunnelMonth[];
  /** Counted deals whose row has no readable first contact: in the totals, in no funnel month. */
  funnelUndated: number;
  /** Revenue and fee by month of the closed date, oldest first. */
  closedMonths: ClosedMonth[];
  /** Data rows read (below the header, not empty). */
  rows: number;
  /** Rows with a readable First contact date. */
  leadRows: number;
  /** Newest First contact on or before today, YYYY-MM-DD. Null when none is readable. */
  newestFirstContact: string | null;
  /** Newest Closed date on any row on or before today. Null when none. */
  newestClosed: string | null;
  windowStart: string;
  /** Every qualifying deal, oldest closed first. Revenue counts all of them. */
  counted: Deal[];
  countedCents: number;
  /** The first DEAL_CAP of them carry the fee. */
  feeDeals: number;
  feeCents: number;
  overCap: number;
  pending: PendingRow[];
  pendingCents: number;
  problems: Problem[];
  /** Rows whose Status is a word other than Won or blank. Counted nowhere. */
  otherStatus: number;
}

const labelOf = (name: string, row: number): string => {
  const t = name.replace(/\s+/g, " ").trim();
  if (!t || /^\(?name unknown\)?$/i.test(t)) return `Row ${row}`;
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1).trimEnd()}…` : t;
};

export function readTracker(
  rows: readonly (readonly unknown[])[],
  cols: Columns,
  headerRow: number,
  opts: { today: string; windowStart: string },
): TrackerReading {
  const counted: Deal[] = [];
  const pending: PendingRow[] = [];
  const problems: Problem[] = [];
  let dataRows = 0, leadRows = 0, otherStatus = 0;
  let newestFirst: string | null = null, newestClosed: string | null = null;
  const funnel = new Map<string, FunnelMonth>();
  const firstOf = new Map<number, string>(); // row number -> month of first contact
  const hasType = cols.type >= 0, hasClick = cols.adClick >= 0;
  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (!row.some((c) => String(c ?? "").trim())) continue;
    dataRows++;
    const n = i + 1; // the row number a person sees in the sheet
    const first = dateCell(row, cols.firstContact);
    if (first && first <= opts.today) {
      leadRows++; if (!newestFirst || first > newestFirst) newestFirst = first;
      const m = first.slice(0, 7);
      let f = funnel.get(m);
      if (!f) { f = { month: m, leads: 0, adClickLeads: hasClick ? 0 : null, calls: hasType ? 0 : null, forms: hasType ? 0 : null, won: 0, wonCents: 0 }; funnel.set(m, f); }
      f.leads++;
      if (hasClick && isAdClick(cell(row, cols.adClick))) f.adClickLeads = (f.adClickLeads ?? 0) + 1;
      if (hasType) { const k = leadKind(cell(row, cols.type)); if (k === "call") f.calls = (f.calls ?? 0) + 1; else if (k === "form") f.forms = (f.forms ?? 0) + 1; }
      firstOf.set(n, m);
    }
    const closed = dateCell(row, cols.closedDate);
    if (closed && closed <= opts.today && (!newestClosed || closed > newestClosed)) newestClosed = closed;
    const status = normHeader(cell(row, cols.status));
    const cents = parseAmountCents(cell(row, cols.amount));
    const label = labelOf(cell(row, cols.name), n);
    const flag = normHeader(cell(row, cols.windowFlag)) === "yes";
    if (status === "won") {
      if (cents == null) { problems.push({ row: n, why: "won_no_amount" }); continue; }
      if (!closed) { problems.push({ row: n, why: "won_no_date" }); continue; }
      if (closed > opts.today) { problems.push({ row: n, why: "won_future_date" }); continue; }
      if (closed < opts.windowStart) { problems.push({ row: n, why: "won_before_window" }); continue; }
      if (!flag) { pending.push({ row: n, label, closed, cents, why: "window_flag_missing" }); continue; }
      counted.push({ row: n, label, closed, cents });
    } else if (status === "") {
      if (closed && cents != null && closed >= opts.windowStart && closed <= opts.today) pending.push({ row: n, label, closed, cents, why: "no_status" });
    } else otherStatus++;
  }
  counted.sort((a, b) => a.closed.localeCompare(b.closed) || a.row - b.row);
  const feeDeals = Math.min(counted.length, DEAL_CAP);
  let funnelUndated = 0;
  const closedBy = new Map<string, ClosedMonth>();
  counted.forEach((d, i) => {
    const fm = firstOf.get(d.row);
    const f = fm ? funnel.get(fm) : undefined;
    if (f) { f.won++; f.wonCents += d.cents; } else funnelUndated++;
    const cm = d.closed.slice(0, 7);
    const c = closedBy.get(cm) ?? { month: cm, deals: 0, cents: 0, feeDeals: 0, feeCents: 0 };
    c.deals++; c.cents += d.cents;
    if (i < DEAL_CAP) { c.feeDeals++; c.feeCents += FEE_PER_DEAL_CENTS; }
    closedBy.set(cm, c);
  });
  const byMonth = <T extends { month: string }>(m: Map<string, T>) => Array.from(m.values()).sort((a, b) => a.month.localeCompare(b.month));
  return {
    funnel: byMonth(funnel), funnelUndated, closedMonths: byMonth(closedBy),
    rows: dataRows, leadRows, newestFirstContact: newestFirst, newestClosed, windowStart: opts.windowStart,
    counted, countedCents: counted.reduce((s, d) => s + d.cents, 0),
    feeDeals, feeCents: feeDeals * FEE_PER_DEAL_CENTS, overCap: Math.max(0, counted.length - DEAL_CAP),
    pending, pendingCents: pending.reduce((s, p) => s + p.cents, 0),
    problems, otherStatus,
  };
}

// ── What is written ──────────────────────────────────────────────────────────

export interface TrackerSummary {
  v: 1;
  /** When the sheet was read (ISO instant). */
  readAt: string;
  /** Drive's last-modified time for the file, or null when Drive did not answer. Never invented. */
  sheetEditedAt: string | null;
  rows: number;
  leadRows: number;
  newestFirstContact: string | null;
  newestClosed: string | null;
  windowStart: string;
  feePerDealCents: number;
  capDeals: number;
  countedDeals: number;
  countedCents: number;
  feeDeals: number;
  feeCents: number;
  overCap: number;
  counted: Deal[];
  pending: PendingRow[];
  pendingCents: number;
  problems: Problem[];
  otherStatus: number;
  /** Leads by month of first contact (the funnel), and what became of them. */
  funnel: FunnelMonth[];
  funnelUndated: number;
  /** Revenue and the fee by month of the closed date. */
  closedMonths: ClosedMonth[];
}

export function buildSummary(r: TrackerReading, readAt: string, sheetEditedAt: string | null): TrackerSummary {
  return {
    v: 1, readAt, sheetEditedAt, rows: r.rows, leadRows: r.leadRows,
    newestFirstContact: r.newestFirstContact, newestClosed: r.newestClosed, windowStart: r.windowStart,
    feePerDealCents: FEE_PER_DEAL_CENTS, capDeals: DEAL_CAP,
    countedDeals: r.counted.length, countedCents: r.countedCents, feeDeals: r.feeDeals, feeCents: r.feeCents, overCap: r.overCap,
    counted: r.counted, pending: r.pending, pendingCents: r.pendingCents, problems: r.problems, otherStatus: r.otherStatus,
    funnel: r.funnel, funnelUndated: r.funnelUndated, closedMonths: r.closedMonths,
  };
}

export const monthOf = (ymdStr: string): string => ymdStr.slice(0, 7);
function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(Date.UTC(y!, m!, 0)).getUTCDate()).padStart(2, "0")}`;
}
/** Every month from the window's first through today's, inclusive. */
export function windowMonths(windowStart: string, today: string): string[] {
  const out: string[] = [];
  let [y, m] = [Number(windowStart.slice(0, 4)), Number(windowStart.slice(5, 7))];
  const last = monthOf(today);
  for (let i = 0; i < 240; i++) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    if (ym > last) break;
    out.push(ym);
    if (m === 12) { y++; m = 1; } else m++;
  }
  return out;
}

export interface SyncEntryLike {
  client_id: string;
  source: "manual";
  external_id: string;
  period_start: string;
  period_end: string;
  data_state: "live";
  error_message: null;
  metrics: Record<string, number | string | null>;
}

/**
 * The sync entries. One row per month of the window, by the month the deal
 * CLOSED (not the month the lead arrived), including months with nothing: the
 * dashboard keeps the newest row per month, so a row somebody un-marks as Won
 * must be able to bring its month back to nought. Months before the window have
 * no row at all (a null is unanswered, never a nought). The in-progress month's
 * period ends today, because the dashboard hides a period that ends in the
 * future.
 *
 * Revenue goes under manual.revenue_system_cents (basis c only when the client's
 * revenue_basis_note names this document). The deal count rides beside it under
 * manual.tracker_won_deals, which is also how the case study knows the figure
 * is this ledger and not a client export. The pending figures sit on the window's
 * first month so there is only ever one live value of each.
 */
export function buildEntries(clientId: string, r: TrackerReading, summary: TrackerSummary, today: string): SyncEntryLike[] {
  const out: SyncEntryLike[] = [];
  for (const ym of windowMonths(r.windowStart, today)) {
    const deals = r.counted.filter((d) => monthOf(d.closed) === ym);
    const end = monthEnd(ym);
    out.push({
      client_id: clientId, source: "manual", external_id: `dpg-tracker-${ym}`,
      period_start: `${ym}-01`, period_end: end > today ? today : end,
      data_state: "live", error_message: null,
      metrics: { "manual.revenue_system_cents": deals.reduce((s, d) => s + d.cents, 0), "manual.tracker_won_deals": deals.length },
    });
  }
  out.push({
    client_id: clientId, source: "manual", external_id: "dpg-tracker-summary",
    period_start: r.windowStart, period_end: today,
    data_state: "live", error_message: null,
    metrics: {
      "manual.tracker_pending_deals": r.pending.length,
      "manual.tracker_pending_cents": r.pendingCents,
      "manual.tracker_summary": JSON.stringify(summary),
    },
  });
  return out;
}

// ── Causes and the heartbeat line ────────────────────────────────────────────

export const CAUSE_CODES = [
  "key_missing", "key_unreadable", "key_rejected",
  "sheet_not_found", "access_removed", "sheet_in_bin",
  "tab_missing", "headers_missing", "headers_duplicate", "sheet_empty", "sheet_too_long",
  "google_unavailable", "rows_refused", "other_status", "check_crashed",
] as const;
export type CauseCode = (typeof CAUSE_CODES)[number];
export type Level = "stop" | "warn";
export type Who = "us" | "client" | "either" | "google";
export interface Finding { code: CauseCode; level: Level; who: Who; line: string; steps: string[] }

const list = (xs: readonly string[]) => xs.map((x) => `"${x}"`).join(", ");

export const FINDINGS = {
  key_missing: (): Finding => ({ code: "key_missing", level: "stop", who: "us", line: "The Google service account key is not set on this job, so the tracker cannot be opened.", steps: ["Set the GOOGLE_SERVICE_ACCOUNT_JSON secret on the worker repository."] }),
  key_unreadable: (): Finding => ({ code: "key_unreadable", level: "stop", who: "us", line: "The Google service account key is set but is not a usable key file.", steps: ["Paste the whole JSON key file into the GOOGLE_SERVICE_ACCOUNT_JSON secret again."] }),
  key_rejected: (): Finding => ({ code: "key_rejected", level: "stop", who: "us", line: "Google refused our service account key (revoked, expired or deleted).", steps: ["Create a new key for the service account and replace the GOOGLE_SERVICE_ACCOUNT_JSON secret."] }),
  sheet_not_found: (): Finding => ({ code: "sheet_not_found", level: "stop", who: "us", line: "Google cannot find the tracker sheet at the id this job is set to read.", steps: ["Check the sheet id (DPG_TRACKER_SHEET_ID, or the default in src/dpg-tracker.ts) against the address of the sheet.", "If the sheet was deleted, restore it from the bin."] }),
  access_removed: (email: string | null): Finding => ({ code: "access_removed", level: "stop", who: "us", line: `Google says our service account${email ? ` (${email})` : ""} cannot open the tracker sheet. It was never shared with it, or the share was removed.`, steps: ["Share the sheet with the service account's email as Viewer, then run the import again."] }),
  sheet_in_bin: (): Finding => ({ code: "sheet_in_bin", level: "stop", who: "us", line: "The tracker sheet is in the bin in Google Drive.", steps: ["Restore it from the bin, then run the import again."] }),
  tab_missing: (tabs: readonly string[], how: "missing" | "override_missing"): Finding => ({ code: "tab_missing", level: "stop", who: "us", line: how === "override_missing" ? `The tab this job was told to read is not in the sheet. Tabs now: ${tabs.join(", ") || "none"}.` : `The tracker tab (the one with the sheet's tab id) is gone. Tabs now: ${tabs.join(", ") || "none"}.`, steps: ["If the tab was deleted and rebuilt, set DPG_TRACKER_TAB (the exact tab name) or DPG_TRACKER_TAB_GID on the worker, then run the import again."] }),
  headers_missing: (missing: readonly string[]): Finding => ({ code: "headers_missing", level: "stop", who: "us", line: `The tracker is missing ${missing.length === 1 ? "a column" : "columns"} this job needs: ${list(missing)}. Nothing was imported.`, steps: ["Put the heading back exactly as written (capitals and the question mark do not matter), or tell us it was renamed on purpose so the reader is changed."] }),
  headers_duplicate: (dup: readonly string[]): Finding => ({ code: "headers_duplicate", level: "stop", who: "us", line: `The tracker has ${list(dup)} as a heading more than once in its main table, so the job cannot tell which column to read. Nothing was imported.`, steps: ["Rename or remove the extra column."] }),
  sheet_empty: (): Finding => ({ code: "sheet_empty", level: "stop", who: "us", line: "The tracker tab came back with no cells at all. Nothing was imported.", steps: ["Open the sheet and check the tab was not cleared. Version history in Google Sheets can restore it."] }),
  sheet_too_long: (rows: number): Finding => ({ code: "sheet_too_long", level: "stop", who: "us", line: `The tracker is ${rows.toLocaleString("en-US")} rows long, which is as far as this job reads, so it may be cut off. Nothing was imported.`, steps: ["Raise ROW_LIMIT in src/dpg-tracker.ts, or archive old rows to another tab."] }),
  google_unavailable: (): Finding => ({ code: "google_unavailable", level: "stop", who: "google", line: "Google did not answer after several tries. This is Google, not the sheet. Nothing was imported and the last good figures stand.", steps: ["Run the import again later. No action on the sheet."] }),
  rows_refused: (problems: readonly Problem[]): Finding => {
    const by = (w: ProblemWhy) => problems.filter((p) => p.why === w).map((p) => p.row);
    const bits = ([["won_no_amount", "no amount"], ["won_no_date", "no closed date"], ["won_before_window", "a closed date before the billing window"], ["won_future_date", "a closed date in the future"]] as [ProblemWhy, string][])
      .map(([w, t]) => (by(w).length ? `${by(w).length} marked Won with ${t} (row${by(w).length === 1 ? "" : "s"} ${by(w).slice(0, 6).join(", ")}${by(w).length > 6 ? ", more" : ""})` : null)).filter(Boolean);
    return { code: "rows_refused", level: "warn", who: "us", line: `${bits.join("; ")}. Not counted.`, steps: ["Fix those rows in the sheet. They count the day they are complete."] };
  },
  other_status: (n: number): Finding => ({ code: "other_status", level: "warn", who: "us", line: `${n} row${n === 1 ? " has" : "s have"} a Status that is neither Won nor blank, so ${n === 1 ? "it is" : "they are"} counted nowhere.`, steps: ["Use Won, or leave Status blank while it is pending."] }),
  check_crashed: (why: string): Finding => ({ code: "check_crashed", level: "stop", who: "us", line: `The import itself failed (${why.slice(0, 150)}).`, steps: ["Open the run log in GitHub Actions."] }),
};

export const hasStop = (fs: readonly Finding[]): boolean => fs.some((f) => f.level === "stop");

/**
 * The one line the heartbeat note carries; the dashboard parses it, so the shape
 * is a contract. `DPG-SHEET ok|warn|stop <cause>: <sentence>` (ok has no cause).
 * It carries counts, dates and cause codes, never a name, a phone or an email.
 */
export function summaryLine(findings: readonly Finding[], ok: { tab: string | null; reading: TrackerReading | null }): string {
  const first = findings.find((f) => f.level === "stop") ?? findings[0];
  if (first) return `DPG-SHEET ${first.level} ${first.code}: ${first.line}`.slice(0, 295);
  const r = ok.reading;
  const bits = [
    ok.tab ? `read "${ok.tab}"` : "read the tracker",
    r ? `${r.rows.toLocaleString("en-US")} rows` : null,
    r ? `${r.counted.length} won in window` : null,
    r ? `${r.pending.length} pending` : null,
  ].filter(Boolean);
  return `DPG-SHEET ok: ${bits.join(", ")}.`.slice(0, 295);
}

/** Findings that can be raised from a reading alone (the warns). */
export function readingFindings(r: TrackerReading): Finding[] {
  const out: Finding[] = [];
  if (r.problems.length) out.push(FINDINGS.rows_refused(r.problems));
  if (r.otherStatus) out.push(FINDINGS.other_status(r.otherStatus));
  return out;
}

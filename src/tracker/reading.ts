/**
 * What a tracker sheet says, decided. Pure: a Table and a config in, a reading
 * out. No network, no database, no clock (today is an argument).
 *
 * THE RULES (argued in the dashboard's CLAUDE.md, "DPG's closed-deal tracker",
 * and carried here word for word):
 *  - A row counts as a win only when its status says Won, its amount is above
 *    nought, its closed date is a real date on or after `countedFrom` and not in
 *    the future, and (where the sheet says which rows are ours) its source says
 *    ours.
 *  - Won without an amount or a date is REFUSED and named by row number. It is
 *    never counted, never a nought.
 *  - Won but not confirmed (a flag column says no, or the source cell is blank)
 *    is PENDING: shown apart, never counted.
 *  - A row that is not ours is not a deal here at all. It is counted and named
 *    as "not ours" and nothing else.
 *  - Wins closed BEFORE `countedFrom` are never counted by the feed. For Franklin
 *    `countedFrom` is the contract start, so these are sales from before the
 *    engagement; where a client's `countedFrom` is later than the one-time seed they belong to the seed that already
 *    holds them. They are read, summed and shown beside the seed so the two can
 *    be reconciled, and they are NEVER written as revenue: that would count them
 *    twice.
 *  - A name, phone number or email is never stored or printed. A row is labelled
 *    "Row N", or by a number-bearing reference column the config declares.
 */
import { type RoleName, type TrackerConfig } from "./config.js";
import { normHeader } from "./config.js";
import { isClickId, nameKey, normEmail, parseAmountCents, parseDay, phoneKey, quoteKey, safeLabel, type RoleFound, type Table } from "./table.js";

export interface Deal {
  row: number; label: string; closed: string; cents: number; gclid: string | null; clickOn: string | null;
  /** Merged reads only: which sheet (0-based, in the order configured) this row is on, and any other sheet it is also on. */
  sheet?: number; alsoOn?: number[];
}
export type PendingWhy = "no_status" | "window_flag_missing" | "source_blank" | "could_be_same";
export interface PendingRow extends Deal { why: PendingWhy; /** could_be_same only: the label of the counted row it looks like. */ like?: string }
export type ProblemWhy = "won_no_amount" | "won_no_date" | "won_before_window" | "won_future_date";
export interface Problem { row: number; why: ProblemWhy; /** Merged reads only: the sheet (0-based) the row is on. */ sheet?: number }

/**
 * One row that matters when two sheets are read together. Held in memory for the merge and NEVER written or printed:
 * it carries the identifiers the rows are matched on.
 */
export type ItemKind = "counted" | "pending" | "no_amount" | "no_date" | "before_feed";
export interface RowItem {
  sheet: number; row: number; label: string; kind: ItemKind; layout: string;
  closed: string | null; cents: number | null; gclid: string | null; first: string | null;
  pendingWhy: PendingWhy | null;
  email: string | null; phone: string | null; quote: string | null; name: string | null;
  hasEmail: boolean; hasPhone: boolean; hasFormId: boolean; badClick: boolean;
}

export interface FunnelMonth { month: string; leads: number; adClickLeads: number | null; calls: number | null; forms: number | null; won: number; wonCents: number }
export interface ClosedMonth { month: string; deals: number; cents: number; feeDeals: number; feeCents: number }

export interface KeyCoverage { withClickId: number; withEmail: number; withPhone: number; withFormId: number; nameOnly: number; badClickId: number }

export interface Reading {
  funnel: FunnelMonth[];
  funnelUndated: number;
  closedMonths: ClosedMonth[];
  rows: number;
  /** Rows that are ours (or every row, where the sheet has no source column). */
  ourRows: number;
  leadRows: number;
  newestFirstContact: string | null;
  newestClosed: string | null;
  countedFrom: string;
  counted: Deal[];
  countedCents: number;
  feeDeals: number;
  feeCents: number;
  overCap: number;
  pending: PendingRow[];
  pendingCents: number;
  problems: Problem[];
  otherStatus: number;
  notOurs: number;
  wonNotOurs: number;
  sourceBlank: number;
  /** Ours and won, closed before the feed starts, on or after the seed's first day. The seed holds these. */
  beforeFeed: { deals: number; cents: number; noAmount: number; newest: string | null };
  /** Ours and won, closed before the seed's first day. Counted nowhere. */
  beforeSeed: number;
  keys: KeyCoverage;
}

export const LABEL_FALLBACK = (n: number) => `Row ${n}`;
const cellOf = (row: readonly string[], f: RoleFound | undefined): string => (f ? String(row[f.index] ?? "").trim() : "");

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

export function readRows(table: Table, found: Partial<Record<RoleName, RoleFound>>, cfg: TrackerConfig, opts: { today: string; collect?: { sheet: number; items: RowItem[] } }): Reading {
  const won = new Set(cfg.wonValues.map(normHeader));
  const notWon = new Set(cfg.knownNotWonValues.map(normHeader));
  const ours = new Set(cfg.ourSourceValues.map(normHeader));
  const hasSource = !!found.source && ours.size > 0;
  const seed = cfg.seed;
  const counted: Deal[] = [];
  const pending: PendingRow[] = [];
  const problems: Problem[] = [];
  const keys: KeyCoverage = { withClickId: 0, withEmail: 0, withPhone: 0, withFormId: 0, nameOnly: 0, badClickId: 0 };
  const beforeFeed = { deals: 0, cents: 0, noAmount: 0, newest: null as string | null };
  let beforeSeed = 0, dataRows = 0, ourRows = 0, leadRows = 0, otherStatus = 0, notOurs = 0, wonNotOurs = 0, sourceBlank = 0;
  let newestFirst: string | null = null, newestClosed: string | null = null;
  const funnel = new Map<string, FunnelMonth>();
  const firstOf = new Map<number, string>();
  const hasType = !!found.type, hasClick = !!found.gclid;

  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i] ?? [];
    if (!row.some((c) => String(c ?? "").trim())) continue;
    dataRows++;
    const n = table.rowNumbers[i] ?? i + 2;
    const closed = parseDay(cellOf(row, found.closedDate));
    if (closed && closed <= opts.today && (!newestClosed || closed > newestClosed)) newestClosed = closed;

    // Whose row is it? Only a source cell that names something else takes a row out entirely.
    const srcNorm = normHeader(cellOf(row, found.source));
    const statusNorm = normHeader(cellOf(row, found.status));
    const isWon = won.has(statusNorm);
    let sourceOk = true;
    if (hasSource) {
      if (srcNorm === "") sourceOk = false;
      else if (!ours.has(srcNorm)) { notOurs++; if (isWon) wonNotOurs++; continue; }
    }
    if (hasSource && !sourceOk) sourceBlank++;
    if (sourceOk) ourRows++;

    // The funnel is the leads that are ours, by month of first contact.
    const first = parseDay(cellOf(row, found.firstContact));
    if (sourceOk && first && first <= opts.today) {
      leadRows++; if (!newestFirst || first > newestFirst) newestFirst = first;
      const m = first.slice(0, 7);
      let f = funnel.get(m);
      if (!f) { f = { month: m, leads: 0, adClickLeads: hasClick ? 0 : null, calls: hasType ? 0 : null, forms: hasType ? 0 : null, won: 0, wonCents: 0 }; funnel.set(m, f); }
      f.leads++;
      if (hasClick && isAdClick(cellOf(row, found.gclid))) f.adClickLeads = (f.adClickLeads ?? 0) + 1;
      if (hasType) { const k = leadKind(cellOf(row, found.type)); if (k === "call") f.calls = (f.calls ?? 0) + 1; else if (k === "form") f.forms = (f.forms ?? 0) + 1; }
      firstOf.set(n, m);
    }

    const cents = parseAmountCents(cellOf(row, found.amount));
    const labelCell = found.rowLabel ? safeLabel(cellOf(row, found.rowLabel)) : null;
    const label = labelCell ?? LABEL_FALLBACK(n);
    const rawClick = cellOf(row, found.gclid);
    const gclid = rawClick && isClickId(rawClick) ? rawClick : null;
    const flagOk = found.confirmFlag ? normHeader(cellOf(row, found.confirmFlag)) === "yes" : true;
    const mk = (): Deal => ({ row: n, label, closed: closed as string, cents: cents as number, gclid, clickOn: first });
    // For a merged read of several sheets: keep what the merge matches on, in memory only.
    const item = (kind: ItemKind, pendingWhy: PendingWhy | null = null) => {
      const c = opts.collect;
      if (!c) return;
      const email = cellOf(row, found.email), phone = cellOf(row, found.phone);
      c.items.push({
        sheet: c.sheet, row: n, label, kind, layout: cfg.layoutName, closed, cents, gclid, first, pendingWhy,
        email: normEmail(email), phone: phoneKey(phone), quote: cfg.layoutName === "rfq_log" ? quoteKey(labelCell) : null, name: nameKey(cellOf(row, found.name)),
        hasEmail: !!email, hasPhone: !!phone, hasFormId: !!cellOf(row, found.formId), badClick: !gclid && !!rawClick,
      });
    };

    if (isWon) {
      if (seed != null) {
        // History comes first. A win closed before the feed started is the seed's, whatever its amount.
        if (closed && closed < cfg.countedFrom) {
          if (closed >= seed.from) {
            beforeFeed.deals++;
            if (cents == null) beforeFeed.noAmount++; else beforeFeed.cents += cents;
            if (!beforeFeed.newest || closed > beforeFeed.newest) beforeFeed.newest = closed;
            item("before_feed");
          } else beforeSeed++;
          continue;
        }
        if (cents == null) { problems.push({ row: n, why: "won_no_amount" }); item("no_amount"); continue; }
        if (!closed) { problems.push({ row: n, why: "won_no_date" }); item("no_date"); continue; }
        if (closed > opts.today) { problems.push({ row: n, why: "won_future_date" }); continue; }
      } else {
        if (cents == null) { problems.push({ row: n, why: "won_no_amount" }); item("no_amount"); continue; }
        if (!closed) { problems.push({ row: n, why: "won_no_date" }); item("no_date"); continue; }
        if (closed > opts.today) { problems.push({ row: n, why: "won_future_date" }); continue; }
        if (closed < cfg.countedFrom) { problems.push({ row: n, why: "won_before_window" }); continue; }
      }
      if (hasSource && !sourceOk) { pending.push({ ...mk(), why: "source_blank" }); item("pending", "source_blank"); continue; }
      if (!flagOk) { pending.push({ ...mk(), why: "window_flag_missing" }); item("pending", "window_flag_missing"); continue; }
      counted.push(mk());
      item("counted");
      if (gclid) keys.withClickId++; else if (rawClick) keys.badClickId++;
      if (cellOf(row, found.email)) keys.withEmail++;
      if (cellOf(row, found.phone)) keys.withPhone++;
      if (cellOf(row, found.formId)) keys.withFormId++;
      if (!gclid && !cellOf(row, found.email) && !cellOf(row, found.phone) && !cellOf(row, found.formId) && cellOf(row, found.name)) keys.nameOnly++;
    } else if (statusNorm === "") {
      if (cfg.blankStatusPending && sourceOk && closed && cents != null && closed >= cfg.countedFrom && closed <= opts.today) { pending.push({ ...mk(), why: "no_status" }); item("pending", "no_status"); }
    } else if (!notWon.has(statusNorm)) otherStatus++;
  }

  counted.sort((a, b) => a.closed.localeCompare(b.closed) || a.row - b.row);
  const capDeals = cfg.fee?.capDeals ?? 0;
  const feeDeals = cfg.fee ? Math.min(counted.length, capDeals) : 0;
  let funnelUndated = 0;
  const closedBy = new Map<string, ClosedMonth>();
  counted.forEach((d, i) => {
    const fm = firstOf.get(d.row);
    const f = fm ? funnel.get(fm) : undefined;
    if (f) { f.won++; f.wonCents += d.cents; } else funnelUndated++;
    const cm = d.closed.slice(0, 7);
    const c = closedBy.get(cm) ?? { month: cm, deals: 0, cents: 0, feeDeals: 0, feeCents: 0 };
    c.deals++; c.cents += d.cents;
    if (cfg.fee && i < capDeals) { c.feeDeals++; c.feeCents += cfg.fee.perDealCents; }
    closedBy.set(cm, c);
  });
  const byMonth = <T extends { month: string }>(m: Map<string, T>) => Array.from(m.values()).sort((a, b) => a.month.localeCompare(b.month));
  return {
    funnel: byMonth(funnel), funnelUndated, closedMonths: byMonth(closedBy),
    rows: dataRows, ourRows, leadRows, newestFirstContact: newestFirst, newestClosed, countedFrom: cfg.countedFrom,
    counted, countedCents: counted.reduce((s, d) => s + d.cents, 0),
    feeDeals, feeCents: cfg.fee ? feeDeals * cfg.fee.perDealCents : 0, overCap: cfg.fee ? Math.max(0, counted.length - capDeals) : 0,
    pending, pendingCents: pending.reduce((s, p) => s + p.cents, 0),
    problems, otherStatus, notOurs, wonNotOurs, sourceBlank, beforeFeed, beforeSeed, keys,
  };
}

// ── What is written ──────────────────────────────────────────────────────────

/** Counted rows kept in the stored summary. A sheet with more keeps the newest. */
export const COUNTED_LISTED_MAX = 1_500;

/** What one sheet contributed to a merged read. Counts, labels and headings only. */
export interface SheetSummary {
  index: number;
  /** "Quote / RFQ sheet", "Ad form sheet" or "Sheet 2". */
  label: string;
  layout: string | null;
  state: "read" | "stopped";
  /** A cause code, when stopped. */
  cause: string | null;
  /** The worker's own sentence, when stopped. */
  line: string | null;
  readAt: string | null;
  sheetEditedAt: string | null;
  rows: number;
  ourRows: number;
  /** Counted deals in the combined figure that this sheet carries, including the ones also on another sheet. */
  wins: number;
  /** Of those, the ones also on another sheet. */
  onBoth: number;
  /** Rows held as "could be the same deal as a row on the other sheet". */
  held: number;
  pending: number;
  refused: number;
  newestClosed: string | null;
  columns: Record<string, string>;
}
export interface MergeSummary {
  /** Deals proved to be the same sale on two sheets and counted once. */
  sameOnBoth: number;
  /** The same sale on another sheet as one the entered figure already holds: not counted again. */
  inSeed: number;
  /** Matched deals whose sheets disagree: counted at the lower amount and the later date. */
  conflicts: { label: string; sheet: number; kind: "amount" | "date" | "both" }[];
  /** Rows held pending: they look like a row on an earlier sheet and nothing proves it. Labels only. */
  couldBeSame: { label: string; sheet: number; like: string; likeSheet: number }[];
}

export interface FeedSummary {
  /** 1: one sheet. 2: several sheets read together (sheets and merge are present). */
  v: 1 | 2;
  kind: "feed";
  key: string;
  readAt: string;
  sheetEditedAt: string | null;
  sourceKind: TrackerConfig["source"];
  keptBy: TrackerConfig["keptBy"];
  sheetLabel: string;
  countedFrom: string;
  seed: { from: string; through: string; cents: number; label: string; largestCents: number | null } | null;
  rows: number;
  ourRows: number;
  leadRows: number;
  newestFirstContact: string | null;
  newestClosed: string | null;
  /** The earliest closed day among the counted wins: the card says so when it is after the first day counted, instead of inventing earlier sales. */
  oldestClosed: string | null;
  countedDeals: number;
  countedCents: number;
  /** The newest counted rows (all of them up to COUNTED_LISTED_MAX). */
  counted: Deal[];
  countedListed: number;
  pending: PendingRow[];
  pendingCents: number;
  problems: Problem[];
  otherStatus: number;
  notOurs: number;
  wonNotOurs: number;
  sourceBlank: number;
  beforeFeed: Reading["beforeFeed"];
  beforeSeed: number;
  funnel: FunnelMonth[];
  funnelUndated: number;
  closedMonths: ClosedMonth[];
  keys: KeyCoverage;
  /** Which heading each role was read from. Headings only, never a cell. */
  columns: Partial<Record<RoleName, string>>;
  /** v2 only. */
  sheets?: SheetSummary[];
  merge?: MergeSummary;
}

export function buildFeedSummary(
  r: Reading, cfg: TrackerConfig, found: Partial<Record<RoleName, RoleFound>>, readAt: string, sheetEditedAt: string | null,
): FeedSummary {
  const columns: Partial<Record<RoleName, string>> = {};
  for (const [k, v] of Object.entries(found) as [RoleName, RoleFound][]) columns[k] = v.header;
  const listed = r.counted.length > COUNTED_LISTED_MAX ? r.counted.slice(-COUNTED_LISTED_MAX) : r.counted;
  return {
    v: 1, kind: "feed", key: cfg.key, readAt, sheetEditedAt, sourceKind: cfg.source, keptBy: cfg.keptBy, sheetLabel: cfg.sheetLabel,
    countedFrom: cfg.countedFrom, seed: cfg.seed ? { from: cfg.seed.from, through: cfg.seed.through, cents: cfg.seed.cents, label: cfg.seed.label, largestCents: cfg.seed.largestCents ?? null } : null,
    rows: r.rows, ourRows: r.ourRows, leadRows: r.leadRows, newestFirstContact: r.newestFirstContact, newestClosed: r.newestClosed,
    oldestClosed: r.counted.reduce<string | null>((m, d) => (m == null || d.closed < m ? d.closed : m), null),
    countedDeals: r.counted.length, countedCents: r.countedCents, counted: listed, countedListed: listed.length,
    pending: r.pending, pendingCents: r.pendingCents, problems: r.problems, otherStatus: r.otherStatus,
    notOurs: r.notOurs, wonNotOurs: r.wonNotOurs, sourceBlank: r.sourceBlank, beforeFeed: r.beforeFeed, beforeSeed: r.beforeSeed,
    funnel: r.funnel, funnelUndated: r.funnelUndated, closedMonths: r.closedMonths, keys: r.keys, columns,
  };
}

export const monthOf = (d: string): string => d.slice(0, 7);
function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(Date.UTC(y!, m!, 0)).getUTCDate()).padStart(2, "0")}`;
}
/** Every month from the feed's first through today's, inclusive. */
export function feedMonths(countedFrom: string, today: string): string[] {
  const out: string[] = [];
  let y = Number(countedFrom.slice(0, 4)), m = Number(countedFrom.slice(5, 7));
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
  client_id: string; source: "manual"; external_id: string; period_start: string; period_end: string;
  data_state: "live"; error_message: null; metrics: Record<string, number | string | null>;
}

/**
 * The sync entries. One row per month from the first feed month through this
 * one, by the month the deal CLOSED, including months with nothing: the
 * dashboard keeps the newest row per month, so a row somebody un-marks as Won
 * can bring its month back to nought. Nothing is written for any month before
 * `countedFrom`: the seed holds those, and a second figure would count them
 * twice. A partial first month starts on `countedFrom`. The in-progress month
 * ends today, because the dashboard hides a period that ends in the future.
 *
 * `manual.tracker_won_deals` (the marker the case study reads as "this is a
 * tracker, not a client export") is written only when BS LLC keeps the sheet.
 * Where the client keeps it, the revenue stands as the client's own records.
 */
export function buildFeedEntries(clientId: string, r: Reading, summary: FeedSummary, cfg: TrackerConfig, today: string): SyncEntryLike[] {
  const out: SyncEntryLike[] = [];
  const marker = cfg.keptBy === "us";
  for (const ym of feedMonths(cfg.countedFrom, today)) {
    const deals = r.counted.filter((d) => monthOf(d.closed) === ym);
    const end = monthEnd(ym);
    const start = `${ym}-01`;
    const metrics: Record<string, number | string | null> = { "manual.revenue_system_cents": deals.reduce((s, d) => s + d.cents, 0) };
    if (marker) metrics["manual.tracker_won_deals"] = deals.length;
    out.push({
      client_id: clientId, source: "manual", external_id: `${cfg.key}-tracker-${ym}`,
      period_start: start < cfg.countedFrom ? cfg.countedFrom : start, period_end: end > today ? today : end,
      data_state: "live", error_message: null, metrics,
    });
  }
  const sm: Record<string, number | string | null> = { "manual.tracker_feed_summary": JSON.stringify(summary) };
  if (marker) { sm["manual.tracker_pending_deals"] = r.pending.length; sm["manual.tracker_pending_cents"] = r.pendingCents; }
  out.push({
    client_id: clientId, source: "manual", external_id: `${cfg.key}-tracker-summary`,
    period_start: cfg.countedFrom, period_end: today, data_state: "live", error_message: null, metrics: sm,
  });
  return out;
}

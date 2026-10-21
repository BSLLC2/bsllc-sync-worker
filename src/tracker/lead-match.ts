/**
 * Which untagged quote-log rows belong to somebody who filled in the ad form, found, never guessed, never counted.
 * Pure: two tables and a config in, a summary out. No network, no database, no clock (today is an argument).
 *
 * WHY. A quote log counts a sale as ours only when somebody tags it ("RFQ Source = BS LLC AD CAMPAIGN"). Staff do not tag
 * reliably, so a sale that began as an ad form fill can sit in the log untagged and never be counted. The second sheet (the
 * ad form sheet) holds every web lead. This module finds the CANDIDATES: quote-log rows that are not tagged ours and whose
 * email is the email of a real (non-spam) lead who arrived on or before the quote was requested.
 *
 * WHAT A CANDIDATE IS. A question for a person, never an answer.
 *   - It is written into the tracker summary as a list apart (`leadMatch.candidates`). It is NEVER added to a counted win,
 *     the won revenue by month, the fee, the pending list or any total. A won candidate is pending in the sense that nothing
 *     counts it until the sheet itself says it is ours: a person (or the client) tags the row, and the next read counts it
 *     through the ordinary path. `readRows` is not touched by anything here.
 *   - It is found by an EMAIL EQUAL, case folded, and nothing else. Never a name, never a company, never a phone. (A phone
 *     is not on the quote log. A name is how a repeat customer looks like an ad lead.)
 *   - The lead must be NOT SPAM, must arrive on or before the quote's request date, and must be inside the engagement
 *     (on or after `countedFrom`, not in the future). A lead after the quote cannot have started it. A spam column the sheet
 *     does not have is a refusal to match at all, because 68% of that sheet's rows are spam and guessing is the failure.
 *   - A date this cannot read is "cannot prove the order", so it never matches. A row with no email never matches.
 *   - A row the log already tags as ours is never a candidate.
 *
 * WHAT IT PRINTS AND STORES. Counts, row labels ("RFQ-1042" or "Row 12"), statuses as one of three words, months, a gap in
 * days and whether a click id exists. NEVER a name, a phone, an email, a click id, a note or any cell of text.
 */
import { normHeader, type LeadMatchSpec, type RoleName, type TrackerConfig } from "./config.js";
export { FRANKLIN_LEAD_MATCH, type LeadMatchSpec } from "./config.js";
import { LABEL_FALLBACK } from "./reading.js";
import { parseAmountCents, parseDay, safeLabel, type RoleFound, type Table } from "./table.js";

/** Our own lines, said as ours in every sentence. */
export const CANDIDATES_LISTED_MAX = 200;
/** Spam words (folded) that mean "not spam". Anything else non-blank counts as spam: an unknown word keeps a lead OUT. */
const NOT_SPAM = new Set(["", "false", "no", "n", "0", "unchecked", "not spam", "ham", "ok", "clear"]);

export type CandidateKind = "won" | "verbal" | "open";
export interface Candidate {
  row: number;
  label: string;
  kind: CandidateKind;
  /** "blank": the source cell is empty. "other": it names another source. Never the words themselves. */
  source: "blank" | "other";
  cents: number | null;
  /** YYYY-MM of the quote's request date. */
  rfqMonth: string;
  /** YYYY-MM of the matching lead (the most recent one on or before the request). */
  leadMonth: string;
  /** Days from that lead to the request. */
  gapDays: number;
  /** A click id exists on a matching lead. The id itself is never read out. */
  leadHasClickId: boolean;
}
export interface KindTotals { n: number; cents: number; noAmount: number }

export type LeadMatchState =
  | "read"            // both sheets read, candidates (possibly none) computed
  | "no_lead_sheet"   // this client has no lead sheet configured, or none was named
  | "stopped"         // the lead sheet could not be opened (cause carries the code)
  | "headings"        // the lead sheet lacks a heading this needs, or has two of one
  | "no_quote_log"    // the main sheet is not laid out as a quote log with a source column
  | "quote_no_email"; // the quote log has no email heading or no request date, so nothing can be matched

export interface LeadSheetFacts {
  rows: number;
  /** Non-spam leads with a usable email and a date inside the engagement. */
  usable: number;
  spam: number;
  noEmail: number;
  noDate: number;
  /** Dated before the engagement began, or in the future. */
  outside: number;
  /** Of the usable leads, how many carry a click id of any kind. */
  withClickId: number;
  /** Headings only, never a cell. */
  columns: { submittedOn: string; email: string; spam: string; clickIds: string[] };
}

export interface LeadMatchSummary {
  v: 1;
  state: LeadMatchState;
  /** A cause code from the tracker's own list when state is "stopped". */
  cause: string | null;
  /** One sentence for the log and the card when the state is not "read". Headings and counts only. */
  line: string | null;
  readAt: string;
  leadSheet: LeadSheetFacts | null;
  /** Newest first within a kind, won then verbal then open, up to CANDIDATES_LISTED_MAX. */
  candidates: Candidate[];
  candidateTotal: number;
  byKind: Record<CandidateKind, KindTotals>;
  /** Quote-log rows tagged as ours, marked won, requested inside the engagement. */
  oursWon: number;
  /** Of those, how many match a real lead the same way a candidate does. */
  oursWonWithLead: number;
  /** Of those, how many carry no email, so nothing could be matched. */
  oursWonNoEmail: number;
  skipped: { noEmail: number; noDate: number; outsideEngagement: number; status: number };
}

const emptyKinds = (): Record<CandidateKind, KindTotals> => ({ won: { n: 0, cents: 0, noAmount: 0 }, verbal: { n: 0, cents: 0, noAmount: 0 }, open: { n: 0, cents: 0, noAmount: 0 } });

/** The summary for a state in which nothing could be matched. Never carries a count of candidates. */
export function noMatch(state: Exclude<LeadMatchState, "read">, readAt: string, line: string, cause: string | null = null, leadSheet: LeadSheetFacts | null = null): LeadMatchSummary {
  return {
    v: 1, state, cause, line, readAt, leadSheet, candidates: [], candidateTotal: 0, byKind: emptyKinds(),
    oursWon: 0, oursWonWithLead: 0, oursWonNoEmail: 0, skipped: { noEmail: 0, noDate: 0, outsideEngagement: 0, status: 0 },
  };
}

// ── Cells ────────────────────────────────────────────────────────────────────

/** Every email address in a cell, lower-cased, whole address, at most five. "a@x.com; B@y.com" gives two. */
export function emailsIn(cell: unknown): string[] {
  const out: string[] = [];
  for (const m of String(cell ?? "").matchAll(/[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)*\.[a-z]{2,}/gi)) {
    const e = m[0].toLowerCase();
    if (!out.includes(e)) out.push(e);
    if (out.length >= 5) break;
  }
  return out;
}
/** A day from a typed cell, with or without a time after it ("10/21/2026 3:14 PM", "2026-10-21T15:14:00Z"). */
export function dayOf(cell: unknown): string | null {
  const s = String(cell ?? "").trim();
  if (!s) return null;
  return parseDay(s) ?? parseDay(s.split(/\s+/)[0] ?? "");
}
export const isSpamCell = (cell: unknown): boolean => !NOT_SPAM.has(normHeader(cell));
const dayNumber = (ymd: string): number => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);
const gap = (from: string, to: string): number => dayNumber(to) - dayNumber(from);
const cellAt = (row: readonly string[], i: number | undefined): string => (i == null || i < 0 ? "" : String(row[i] ?? "").trim());

// ── The lead sheet ───────────────────────────────────────────────────────────

export interface LeadColumns { submittedOn: number; email: number; spam: number; clickIds: number[]; headers: LeadSheetFacts["columns"] }
export type LeadColumnsResult = { ok: true; cols: LeadColumns } | { ok: false; missing: string[]; duplicate: string[] };

/** Finds the lead sheet's columns by heading name. A missing or doubled one is a refusal, never a guess. */
export function resolveLeadColumns(headers: readonly string[], spec: LeadMatchSpec): LeadColumnsResult {
  const normed = headers.map(normHeader);
  const claimed = new Set<number>();
  const find = (aliases: readonly string[]): number[] => {
    const want = new Set(aliases.map(normHeader));
    return normed.map((h, i) => (h && want.has(h) && !claimed.has(i) ? i : -1)).filter((i) => i >= 0);
  };
  const missing: string[] = [], duplicate: string[] = [];
  const one = (name: string, aliases: readonly string[]): number => {
    const hits = find(aliases);
    if (hits.length === 0) { missing.push(name); return -1; }
    if (hits.length > 1) { duplicate.push(name); return -1; }
    claimed.add(hits[0]!);
    return hits[0]!;
  };
  const email = one("the email", spec.roles.email);
  const submittedOn = one("the submitted date", spec.roles.submittedOn);
  const spam = one("the spam flag", spec.roles.spam);
  const clickIds = find(spec.roles.clickIds);
  if (missing.length || duplicate.length) return { ok: false, missing, duplicate };
  return { ok: true, cols: { submittedOn, email, spam, clickIds, headers: { submittedOn: headers[submittedOn]!, email: headers[email]!, spam: headers[spam]!, clickIds: clickIds.map((i) => headers[i]!) } } };
}

/** One usable lead: when it arrived and whether it carried a click id. Held in memory only, keyed by email. */
export interface LeadHit { day: string; click: boolean }
export interface LeadIndex { byEmail: Map<string, LeadHit[]>; facts: LeadSheetFacts }

export function indexLeads(table: Table, cols: LeadColumns, o: { countedFrom: string; today: string }): LeadIndex {
  const byEmail = new Map<string, LeadHit[]>();
  const facts: LeadSheetFacts = { rows: 0, usable: 0, spam: 0, noEmail: 0, noDate: 0, outside: 0, withClickId: 0, columns: cols.headers };
  for (const row of table.rows) {
    if (!row.some((c) => String(c ?? "").trim())) continue;
    facts.rows++;
    // Spam first: a spam row is nothing else, whatever else it carries.
    if (isSpamCell(cellAt(row, cols.spam))) { facts.spam++; continue; }
    const emails = emailsIn(cellAt(row, cols.email));
    if (emails.length === 0) { facts.noEmail++; continue; }
    const day = dayOf(cellAt(row, cols.submittedOn));
    if (!day) { facts.noDate++; continue; }
    if (day < o.countedFrom || day > o.today) { facts.outside++; continue; }
    const click = cols.clickIds.some((i) => cellAt(row, i) !== "");
    facts.usable++;
    if (click) facts.withClickId++;
    for (const e of emails) { const l = byEmail.get(e) ?? []; l.push({ day, click }); byEmail.set(e, l); }
  }
  return { byEmail, facts };
}

// ── The quote log ────────────────────────────────────────────────────────────

/**
 * The best qualifying lead for one quote row: every lead with this email that arrived on or before the request, the most
 * recent one named, and whether ANY of them carried a click id. Null when no lead qualifies.
 */
export function leadFor(emails: readonly string[], rfqDay: string, leads: LeadIndex): { day: string; click: boolean } | null {
  let best: string | null = null, click = false;
  for (const e of emails) {
    for (const h of leads.byEmail.get(e) ?? []) {
      if (h.day > rfqDay) continue; // a lead after the quote cannot have started it
      if (!best || h.day > best) best = h.day;
      if (h.click) click = true;
    }
  }
  return best ? { day: best, click } : null;
}

const kindOf = (statusNorm: string, cfg: TrackerConfig, spec: LeadMatchSpec): CandidateKind | null => {
  if (cfg.wonValues.map(normHeader).includes(statusNorm)) return "won";
  if (/\bverbal/.test(statusNorm)) return "verbal";
  if (spec.openStatuses.map(normHeader).includes(statusNorm)) return "open";
  return null;
};

/**
 * The candidates. `quote` is the quote log's table and the columns the framework already found in it, read with the
 * layout's own config (so "ours" means what it means to the counted figure). Nothing here changes a reading.
 */
export function findCandidates(
  quote: { table: Table; found: Partial<Record<RoleName, RoleFound>>; cfg: TrackerConfig },
  leads: LeadIndex, spec: LeadMatchSpec, o: { today: string; readAt: string },
): LeadMatchSummary {
  const { table, found, cfg } = quote;
  const ours = new Set(cfg.ourSourceValues.map(normHeader));
  if (!found.source || ours.size === 0) {
    return noMatch("no_quote_log", o.readAt, "The main sheet has no source column that says which rows are ours, so there is nothing to compare the leads against.", null, leads.facts);
  }
  if (!found.email || (!found.firstContact && !found.closedDate)) {
    return noMatch("quote_no_email", o.readAt, `The main sheet has no ${!found.email ? "email heading" : "request date heading"}, so no row can be matched to a lead.`, null, leads.facts);
  }
  const rfqCol = found.firstContact ?? found.closedDate!;
  const out: Candidate[] = [];
  const skipped = { noEmail: 0, noDate: 0, outsideEngagement: 0, status: 0 };
  let oursWon = 0, oursWonWithLead = 0, oursWonNoEmail = 0;
  const won = new Set(cfg.wonValues.map(normHeader));

  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i] ?? [];
    if (!row.some((c) => String(c ?? "").trim())) continue;
    const n = table.rowNumbers[i] ?? i + 2;
    const srcNorm = normHeader(cellAt(row, found.source.index));
    const isOurs = srcNorm !== "" && ours.has(srcNorm);
    const statusNorm = normHeader(cellAt(row, found.status?.index));
    const rfq = dayOf(cellAt(row, rfqCol.index));
    const emails = emailsIn(cellAt(row, found.email.index));

    if (isOurs) {
      // Only for the one sentence at the top of the group: do the sales the log tags as ours match a lead at all?
      if (won.has(statusNorm) && rfq && rfq >= cfg.countedFrom && rfq <= o.today) {
        oursWon++;
        if (emails.length === 0) oursWonNoEmail++;
        else if (leadFor(emails, rfq, leads)) oursWonWithLead++;
      }
      continue; // a row tagged ours is never a candidate
    }

    const kind = statusNorm ? kindOf(statusNorm, cfg, spec) : null;
    if (!kind) { skipped.status++; continue; }
    if (emails.length === 0) { skipped.noEmail++; continue; }
    if (!rfq) { skipped.noDate++; continue; }
    if (rfq < cfg.countedFrom || rfq > o.today) { skipped.outsideEngagement++; continue; }
    const lead = leadFor(emails, rfq, leads);
    if (!lead) continue;
    const labelCell = found.rowLabel ? safeLabel(cellAt(row, found.rowLabel.index)) : null;
    out.push({
      row: n, label: labelCell ?? LABEL_FALLBACK(n), kind, source: srcNorm === "" ? "blank" : "other",
      cents: found.amount ? parseAmountCents(cellAt(row, found.amount.index)) : null,
      rfqMonth: rfq.slice(0, 7), leadMonth: lead.day.slice(0, 7), gapDays: Math.max(0, gap(lead.day, rfq)), leadHasClickId: lead.click,
    });
  }

  const byKind = emptyKinds();
  for (const c of out) {
    const k = byKind[c.kind];
    k.n++;
    if (c.cents == null) k.noAmount++; else k.cents += c.cents;
  }
  const order: Record<CandidateKind, number> = { won: 0, verbal: 1, open: 2 };
  const listed = [...out].sort((a, b) => order[a.kind] - order[b.kind] || b.rfqMonth.localeCompare(a.rfqMonth) || b.row - a.row).slice(0, CANDIDATES_LISTED_MAX);
  return {
    v: 1, state: "read", cause: null, line: null, readAt: o.readAt, leadSheet: leads.facts,
    candidates: listed, candidateTotal: out.length, byKind, oursWon, oursWonWithLead, oursWonNoEmail, skipped,
  };
}

/** The one-line log sentence for a summary. Counts only. */
export function leadMatchLine(s: LeadMatchSummary): string {
  if (s.state !== "read") return `Lead match: not run (${s.line ?? s.state}).`;
  const l = s.leadSheet;
  return `Lead match: ${l ? `${l.rows} lead rows, ${l.usable} real leads in the engagement (${l.spam} spam, ${l.noEmail} with no email, ${l.noDate} with no date, ${l.outside} outside it), ` : ""}${s.candidateTotal} untagged quote-log row${s.candidateTotal === 1 ? "" : "s"} match a lead (${s.byKind.won.n} won, ${s.byKind.verbal.n} verbally awarded, ${s.byKind.open.n} open). Counted nowhere. ${s.oursWonWithLead} of ${s.oursWon} wins tagged ours match a lead (${s.oursWonNoEmail} have no email).`;
}

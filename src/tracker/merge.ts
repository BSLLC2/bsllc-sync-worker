/**
 * Two sheets, one figure. Pure: readings and the rows they kept in, a merged reading out.
 * No network, no database, no clock (today is an argument).
 *
 * A client can keep more than one sales sheet (Franklin keeps the quote log and a
 * sheet of ad-form leads), and the same ad-sourced sale can be on both. The rule
 * that decides what is the same sale is the heart of this file, so it is argued here.
 *
 * ── WHEN TWO ROWS ARE THE SAME DEAL ──────────────────────────────────────────
 * ONLY by an identifier somebody recorded, tried in this order and no other:
 *   1. the same click id,   2. the same email (case and spacing folded),
 *   3. the same phone (last ten digits),   4. the same RFQ or quote number.
 * NEVER by a person's or company's name. A name is how a repeat customer looks
 * like a duplicate, and a wrong merge silently loses a sale.
 *
 * A match is accepted only when it is one row on each sheet. If a sheet has two
 * rows with that email (a repeat customer), it is not a proof of which one, so
 * nothing is merged on that identifier. A group never holds two rows of one sheet.
 *
 * ── WHAT COUNTS ONCE ─────────────────────────────────────────────────────────
 *  - A group with a counted row on either sheet is ONE deal. Its rows on the other
 *    sheet (pending, won with no amount, won with no date) are absorbed by it.
 *  - AMOUNT: all matched rows that carry one agree, or it is a named conflict and
 *    the deal is counted at the LOWER. A row with no amount lets the other sheet
 *    supply it (the form sheet's typed Order value counts when the quote log has none).
 *  - DATE: where the matched rows disagree it is a named conflict and the LATER
 *    date is used, so a deal is never put in an earlier month than both sheets support.
 *  - SEED: the one-off seed was entered from the RFQ log. A deal the RFQ log dates
 *    before the feed began is already in the entered figure, so the same deal on
 *    another sheet is NOT counted again (`inSeed`).
 *
 * ── WHAT IS NOT PROVABLE ─────────────────────────────────────────────────────
 * Two counted rows on different sheets that no identifier links, but that look
 * alike (the same name within 21 days, or the same amount to the cent within
 * 7 days; both our own lines), or that share an identifier ambiguously, are not
 * merged and not both counted: the row on the LATER sheet is held PENDING as
 * "could be the same as a row on the other sheet" and counted nowhere until the
 * sheets say it is a different deal (a shared identifier makes it one, a changed
 * date or amount makes it two). The sheet order in the configuration decides which
 * is "later", so list the quote log first.
 *
 * Nothing here prints or stores a name, phone, email or click id beyond the
 * counted row's click id (kept for the offline file, as before). Rows are named
 * "RFQ-1042" or "Row 12".
 */
import type { TrackerConfig } from "./config.js";
import type {
  ClosedMonth, Deal, FeedSummary, FunnelMonth, KeyCoverage, MergeSummary, PendingRow, Problem, Reading, RowItem, SheetSummary,
} from "./reading.js";
import { buildFeedSummary } from "./reading.js";

export const COULD_BE_SAME_NAME_DAYS = 21;
export const COULD_BE_SAME_AMOUNT_DAYS = 7;

export interface SheetRead {
  index: number;
  layout: string;
  label: string;
  reading: Reading;
  items: RowItem[];
  readAt: string;
  editedAt: string | null;
  columns: Record<string, string>;
}
export interface SheetStopped { index: number; label: string; cause: string; line: string }

export interface Merged { reading: Reading; sheets: SheetSummary[]; merge: MergeSummary }

const dayNumber = (ymd: string): number => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);
const daysApart = (a: string, b: string): number => Math.abs(dayNumber(a) - dayNumber(b));
const KEY_KINDS = ["gclid", "email", "phone", "quote"] as const;
type KeyKind = (typeof KEY_KINDS)[number];
const keyOf = (it: RowItem, k: KeyKind): string | null => (k === "gclid" ? it.gclid : it[k]);
const isRowLabel = (l: string) => /^Row \d+$/.test(l);

/** What the sheets are called. The layout says what the sheet is; a repeat gets its number. */
export function sheetLabels(layouts: readonly (string | null)[]): string[] {
  const base = (l: string | null, i: number) => (l === "rfq_log" ? "Quote / RFQ sheet" : l === "form_submissions" ? "Ad form sheet" : `Sheet ${i + 1}`);
  const names = layouts.map(base);
  return names.map((n, i) => (names.filter((x) => x === n).length > 1 ? `${n} ${names.slice(0, i + 1).filter((x) => x === n).length}` : n));
}

interface DealOut {
  deal: Deal;
  members: RowItem[];
  sheets: number[];
  conflict: "amount" | "date" | "both" | null;
}

export function mergeSheets(reads: readonly SheetRead[], stopped: readonly SheetStopped[], cfg: TrackerConfig, today: string): Merged {
  const sorted = [...reads].sort((a, b) => a.index - b.index);
  const all: RowItem[] = sorted.flatMap((r) => r.items);

  // ── groups: rows that are provably one deal ────────────────────────────────
  const parent = all.map((_, i) => i);
  const sheetSet: Set<number>[] = all.map((it) => new Set([it.sheet]));
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; } return x; };
  const union = (a: number, b: number): boolean => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return true;
    const sa = sheetSet[ra]!, sb = sheetSet[rb]!;
    for (const s of sb) if (sa.has(s)) return false; // a group never holds two rows of one sheet
    parent[rb] = ra;
    for (const s of sb) sa.add(s);
    return true;
  };
  const ambiguousPairs = new Set<string>();
  const pairKey = (i: number, j: number) => (i < j ? `${i}|${j}` : `${j}|${i}`);
  const buckets: { kind: KeyKind; idx: number[] }[] = [];
  for (const kind of KEY_KINDS) {
    const by = new Map<string, number[]>();
    all.forEach((it, i) => { const v = keyOf(it, kind); if (v) (by.get(v) ?? by.set(v, []).get(v)!).push(i); });
    for (const idx of by.values()) {
      const sheets = new Set(idx.map((i) => all[i]!.sheet));
      if (sheets.size < 2) continue;
      const perSheet = new Map<number, number[]>();
      idx.forEach((i) => (perSheet.get(all[i]!.sheet) ?? perSheet.set(all[i]!.sheet, []).get(all[i]!.sheet)!).push(i));
      const exactlyOne = Array.from(perSheet.values()).every((x) => x.length === 1);
      let merged = false;
      if (exactlyOne) {
        merged = true;
        const first = idx[0]!;
        // Try each pair against the first; any refusal makes the whole bucket ambiguous.
        for (const j of idx.slice(1)) if (!union(first, j)) merged = false;
      }
      if (!merged) buckets.push({ kind, idx });
    }
  }
  const groupSize = new Map<number, number>();
  all.forEach((_, i) => groupSize.set(find(i), (groupSize.get(find(i)) ?? 0) + 1));
  const single = (i: number) => groupSize.get(find(i)) === 1;
  for (const b of buckets) {
    for (const i of b.idx) for (const j of b.idx) {
      if (i < j && all[i]!.sheet !== all[j]!.sheet && single(i) && single(j)) ambiguousPairs.add(pairKey(i, j));
    }
  }

  const groups = new Map<number, number[]>();
  all.forEach((_, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(i));

  // ── each group becomes a counted deal, a seed row, or itself ────────────────
  const deals: DealOut[] = [];
  const keptPending: PendingRow[] = [];
  const absorbed = new Set<string>();
  const bf: { cents: number | null; closed: string | null }[] = [];
  let sameOnBoth = 0, inSeed = 0;
  const validDate = (d: string | null): d is string => !!d && d >= cfg.countedFrom && d <= today;
  const k = (it: RowItem) => `${it.sheet}|${it.row}`;

  for (const idx of Array.from(groups.values()).sort((a, b) => a[0]! - b[0]!)) {
    const members = idx.map((i) => all[i]!);
    const multi = new Set(members.map((m) => m.sheet)).size >= 2;
    const hasC = members.some((m) => m.kind === "counted");
    const seeded = multi && members.some((m) => m.kind === "before_feed" && m.layout === "rfq_log");
    if (seeded) {
      // The entered figure holds it (it was entered from the quote log). Not counted again.
      if (hasC) inSeed++;
      const rep = members.find((m) => m.kind === "before_feed" && m.layout === "rfq_log")!;
      bf.push({ cents: rep.cents, closed: rep.closed });
      for (const m of members) if (m !== rep) absorbed.add(k(m));
      continue;
    }
    if (multi && hasC) {
      sameOnBoth++;
      const withAmount = members.filter((m) => m.cents != null);
      const amounts = Array.from(new Set(withAmount.map((m) => m.cents as number)));
      const cents = Math.min(...amounts);
      const dated = members.filter((m) => m.closed);
      const dates = Array.from(new Set(dated.map((m) => m.closed as string)));
      const closed = dated.map((m) => m.closed).filter(validDate).sort().pop() as string;
      const conflict = amounts.length > 1 && dates.length > 1 ? "both" : amounts.length > 1 ? "amount" : dates.length > 1 ? "date" : null;
      const named = members.find((m) => !isRowLabel(m.label)) ?? members[0]!;
      const gclid = (members.find((m) => m.kind === "counted" && m.gclid)?.gclid ?? members.find((m) => m.gclid)?.gclid) ?? null;
      const firsts = members.map((m) => m.first).filter((x): x is string => !!x).sort();
      const sheets = Array.from(new Set(members.map((m) => m.sheet))).sort((a, b) => a - b);
      deals.push({
        deal: { row: named.row, label: named.label, closed, cents, gclid, clickOn: firsts[0] ?? null, sheet: named.sheet, alsoOn: sheets.filter((s) => s !== named.sheet) },
        members, sheets, conflict,
      });
      for (const m of members) absorbed.add(k(m));
      continue;
    }
    // Not provably one deal on two sheets: every row stands as it is.
    for (const m of members) {
      if (m.kind === "counted") {
        deals.push({ deal: { row: m.row, label: m.label, closed: m.closed as string, cents: m.cents as number, gclid: m.gclid, clickOn: m.first, sheet: m.sheet }, members: [m], sheets: [m.sheet], conflict: null });
      } else if (m.kind === "pending") {
        keptPending.push({ row: m.row, label: m.label, closed: m.closed as string, cents: m.cents as number, gclid: m.gclid, clickOn: m.first, why: m.pendingWhy ?? "no_status", sheet: m.sheet });
      }
    }
    const bfs = members.filter((m) => m.kind === "before_feed");
    if (bfs.length) { const rep = bfs.find((m) => m.layout === "rfq_log") ?? bfs[0]!; bf.push({ cents: rep.cents, closed: rep.closed }); }
  }

  // ── lookalikes on a later sheet are held, never counted ─────────────────────
  const itemIndex = new Map<RowItem, number>(all.map((it, i) => [it, i]));
  const heldOut: PendingRow[] = [];
  const couldBeSame: MergeSummary["couldBeSame"] = [];
  const order = [...deals].sort((a, b) => Math.min(...a.sheets) - Math.min(...b.sheets));
  const counted: DealOut[] = [];
  for (const d of order) {
    const lowest = Math.min(...d.sheets);
    let like: DealOut | null = null;
    if (d.sheets.length === 1) {
      for (const y of counted) {
        if (Math.min(...y.sheets) >= lowest || y.sheets.includes(lowest)) continue;
        const ambiguous = d.members.some((x) => y.members.some((z) => ambiguousPairs.has(pairKey(itemIndex.get(x)!, itemIndex.get(z)!))));
        const x = d.members[0]!;
        const nameLike = !!x.name && y.members.some((z) => z.name === x.name) && daysApart(d.deal.closed, y.deal.closed) <= COULD_BE_SAME_NAME_DAYS;
        const amountLike = d.deal.cents === y.deal.cents && daysApart(d.deal.closed, y.deal.closed) <= COULD_BE_SAME_AMOUNT_DAYS;
        if (ambiguous || nameLike || amountLike) { like = y; break; }
      }
    }
    if (like) {
      heldOut.push({ ...d.deal, why: "could_be_same", like: like.deal.label, sheet: lowest });
      couldBeSame.push({ label: d.deal.label, sheet: lowest, like: like.deal.label, likeSheet: like.deal.sheet ?? Math.min(...like.sheets) });
    } else counted.push(d);
  }
  counted.sort((a, b) => a.deal.closed.localeCompare(b.deal.closed) || (a.deal.sheet ?? 0) - (b.deal.sheet ?? 0) || a.deal.row - b.deal.row);

  // ── the reading ────────────────────────────────────────────────────────────
  const funnelRead = sorted.find((r) => r.layout === "form_submissions") ?? sorted[0]!;
  const funnel: FunnelMonth[] = funnelRead.reading.funnel.map((f) => ({ ...f, won: 0, wonCents: 0 }));
  let funnelUndated = 0;
  const closedBy = new Map<string, ClosedMonth>();
  const capDeals = cfg.fee?.capDeals ?? 0;
  const dealsList: Deal[] = counted.map((c) => c.deal);
  dealsList.forEach((d, i) => {
    const f = d.clickOn ? funnel.find((x) => x.month === d.clickOn!.slice(0, 7)) : undefined;
    if (f) { f.won++; f.wonCents += d.cents; } else funnelUndated++;
    const cm = d.closed.slice(0, 7);
    const c = closedBy.get(cm) ?? { month: cm, deals: 0, cents: 0, feeDeals: 0, feeCents: 0 };
    c.deals++; c.cents += d.cents;
    if (cfg.fee && i < capDeals) { c.feeDeals++; c.feeCents += cfg.fee.perDealCents; }
    closedBy.set(cm, c);
  });
  const closedMonths = Array.from(closedBy.values()).sort((a, b) => a.month.localeCompare(b.month));

  const keys: KeyCoverage = { withClickId: 0, withEmail: 0, withPhone: 0, withFormId: 0, nameOnly: 0, badClickId: 0 };
  for (const c of counted) {
    const m = c.members;
    const click = !!c.deal.gclid;
    const email = m.some((x) => x.hasEmail), phone = m.some((x) => x.hasPhone), form = m.some((x) => x.hasFormId);
    if (click) keys.withClickId++; else if (m.some((x) => x.badClick)) keys.badClickId++;
    if (email) keys.withEmail++;
    if (phone) keys.withPhone++;
    if (form) keys.withFormId++;
    if (!click && !email && !phone && !form && m.some((x) => x.name)) keys.nameOnly++;
  }

  // Rows the single-sheet readings listed that nothing absorbed, carrying the sheet they are on.
  const problems: Problem[] = [];
  const pending: PendingRow[] = [];
  for (const r of sorted) {
    for (const p of r.reading.problems) {
      const isItem = p.why === "won_no_amount" || p.why === "won_no_date";
      if (isItem && absorbed.has(`${r.index}|${p.row}`)) continue;
      problems.push({ ...p, sheet: r.index });
    }
    for (const p of r.reading.pending) {
      if (absorbed.has(`${r.index}|${p.row}`)) continue;
      pending.push({ ...p, sheet: r.index });
    }
  }
  const pendingAll = [...pending, ...heldOut].sort((a, b) => (a.sheet ?? 0) - (b.sheet ?? 0) || a.row - b.row);

  const beforeFeed = {
    deals: bf.length,
    cents: bf.reduce((s, x) => s + (x.cents ?? 0), 0),
    noAmount: bf.filter((x) => x.cents == null).length,
    newest: bf.map((x) => x.closed).filter((x): x is string => !!x).sort().pop() ?? null,
  };
  const max = (xs: (string | null)[]): string | null => xs.filter((x): x is string => !!x).sort().pop() ?? null;
  const sum = (f: (r: Reading) => number) => sorted.reduce((s, r) => s + f(r.reading), 0);
  const totalCounted = dealsList.reduce((s, d) => s + d.cents, 0);
  const reading: Reading = {
    funnel, funnelUndated, closedMonths,
    rows: sum((r) => r.rows), ourRows: sum((r) => r.ourRows), leadRows: funnelRead.reading.leadRows,
    newestFirstContact: max(sorted.map((r) => r.reading.newestFirstContact)), newestClosed: max(sorted.map((r) => r.reading.newestClosed)),
    countedFrom: cfg.countedFrom,
    counted: dealsList, countedCents: totalCounted,
    feeDeals: cfg.fee ? Math.min(dealsList.length, capDeals) : 0,
    feeCents: cfg.fee ? Math.min(dealsList.length, capDeals) * cfg.fee.perDealCents : 0,
    overCap: cfg.fee ? Math.max(0, dealsList.length - capDeals) : 0,
    pending: pendingAll, pendingCents: pendingAll.reduce((s, p) => s + p.cents, 0),
    problems, otherStatus: sum((r) => r.otherStatus), notOurs: sum((r) => r.notOurs), wonNotOurs: sum((r) => r.wonNotOurs), sourceBlank: sum((r) => r.sourceBlank),
    beforeFeed, beforeSeed: sum((r) => r.beforeSeed), keys,
  };

  // ── what each sheet contributed ────────────────────────────────────────────
  const sheets: SheetSummary[] = [
    ...sorted.map((r): SheetSummary => {
      const mine = counted.filter((c) => c.sheets.includes(r.index));
      return {
        index: r.index, label: r.label, layout: r.layout, state: "read", cause: null, line: null, readAt: r.readAt, sheetEditedAt: r.editedAt,
        rows: r.reading.rows, ourRows: r.reading.ourRows, wins: mine.length, onBoth: mine.filter((c) => c.sheets.length > 1).length,
        held: heldOut.filter((h) => h.sheet === r.index).length, pending: pending.filter((p) => p.sheet === r.index).length,
        refused: problems.filter((p) => p.sheet === r.index).length, newestClosed: r.reading.newestClosed, columns: r.columns,
      };
    }),
    ...stopped.map((s): SheetSummary => ({
      index: s.index, label: s.label, layout: null, state: "stopped", cause: s.cause, line: s.line, readAt: null, sheetEditedAt: null,
      rows: 0, ourRows: 0, wins: 0, onBoth: 0, held: 0, pending: 0, refused: 0, newestClosed: null, columns: {},
    })),
  ].sort((a, b) => a.index - b.index);

  const merge: MergeSummary = {
    sameOnBoth, inSeed,
    conflicts: counted.filter((c) => c.conflict).map((c) => ({ label: c.deal.label, sheet: c.deal.sheet ?? 0, kind: c.conflict! })),
    couldBeSame,
  };
  return { reading, sheets, merge };
}

/** The stored summary for a merged read (v2): the single-sheet fields over the combined figure, plus what each sheet gave. */
export function buildMergedSummary(m: Merged, cfg: TrackerConfig, readAt: string): FeedSummary {
  const edited = m.sheets.map((s) => s.sheetEditedAt).filter((x): x is string => !!x).sort().pop() ?? null;
  const base = buildFeedSummary(m.reading, cfg, {}, readAt, edited);
  const firstRead = m.sheets.find((s) => s.state === "read");
  return { ...base, v: 2, sheetLabel: cfg.multiSheetLabel ?? cfg.sheetLabel, columns: firstRead?.columns ?? {}, sheets: m.sheets, merge: m.merge };
}

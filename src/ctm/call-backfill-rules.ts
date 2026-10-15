/**
 * The call correction's matching rules, COPIED from the dashboard's `shared/call-backfill.ts`
 * (and `isCallerIdText` from `shared/call-shape.ts`) because the two repositories cannot import
 * from each other. The dashboard's `npm run verify:wiring` compares every region marked below
 * byte for byte and fails on drift, so a call matched here is matched by the rule the owner's
 * one-time correction uses. Change both or neither.
 *
 * What is NOT copied: the CSV reader and its column table (this job reads `ctm_calls`, which
 * already holds only the fields it may keep), and the dashboard's writer.
 *
 * Here the "phone key" is the salted caller hash (`ctm_calls.caller_hash` against the same hash of
 * each stored form's phone), not the last ten digits, so no number is ever held. The planner only
 * ever uses it as an opaque key.
 */

export const CALL_STATUSES = ["answered", "hangup", "no_answer"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

// ── copied: caller-ID text (shared/call-shape.ts) ───────────────────────────
const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "),
);

/** Caller-ID text: ALL CAPS, or a city and a real two-letter state. */
export function isCallerIdText(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s) return false;
  if (/[A-Za-z]/.test(s) && s === s.toUpperCase()) return true;
  const m = /^([A-Za-z.'-]+(?: [A-Za-z.'-]+)*) ([A-Z]{2})$/.exec(s);
  return Boolean(m && US_STATES.has(m[2]!));
}

// ── copied: the window constants (shared/call-backfill.ts) ──────────────────
/** OUR LINES, said as such: how far from the call a stored row may sit. */
export const MATCH_BEFORE_START_SECONDS = 60;
export const MATCH_AFTER_END_SECONDS = 300;
/** The webhook's own fold window, the same ten minutes as createWebInquiry. */
export const FOLD_WINDOW_SECONDS = 600;

// ── reading the file (not copied: this job reads ctm_calls, not a CSV) ──────
// ── copied: the call and the read it comes from ─────────────────────────────
export interface ExportCall {
  /** Last ten digits of the caller's number; used to find a row and never printed. */
  phoneKey: string;
  source: string | null;
  status: CallStatus | null;
  durationSeconds: number | null;
  ringSeconds: number | null;
  talkSeconds: number | null;
  startedAt: Date;
  label: string | null;
  tagRepeat: boolean | null;
  tagAdsConversion: boolean | null;
  direction: "inbound" | "outbound" | null;
  callId: string | null;
}

export interface ExportRead {
  calls: ExportCall[];
  /** Rows in the file after the header. */
  rows: number;
  /** Rows with no usable caller number (a withheld or blocked call). */
  noNumber: number;
  /** Rows whose date or time could not be read. */
  badTime: number;
  /** Required columns the file does not have, by what they are for. Empty when usable. */
  missing: string[];
}

/** Read the export, keeping only the twelve named columns. */ // not copied: ctm_calls is already narrow

// ── copied: clustering, matching and the plan ───────────────────────────────
const rankOf = (s: CallStatus | null) => (s === "answered" ? 3 : s === "hangup" ? 2 : s === "no_answer" ? 1 : 0);

/** The instant the webhook would have fired: the end of the call. */
const endOf = (c: ExportCall) => new Date(c.startedAt.getTime() + (c.durationSeconds ?? 0) * 1000);

export interface CallCluster {
  calls: ExportCall[];
  phoneKey: string;
  firstStart: Date;
  firstEnd: Date;
  best: ExportCall;
}

/** Group an export the way the webhook folds it: same number, each call's end
 *  within ten minutes of the first call's end. */
export function clusterCalls(calls: readonly ExportCall[]): CallCluster[] {
  const byPhone = new Map<string, ExportCall[]>();
  for (const c of calls) { const l = byPhone.get(c.phoneKey) ?? []; l.push(c); byPhone.set(c.phoneKey, l); }
  const out: CallCluster[] = [];
  for (const [phoneKey, list] of Array.from(byPhone.entries())) {
    list.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    let cur: ExportCall[] = [];
    let firstEnd = 0;
    const flush = () => {
      if (!cur.length) return;
      const best = cur.reduce((b, c) => (rankOf(c.status) > rankOf(b.status) || (rankOf(c.status) === rankOf(b.status) && rankOf(c.status) > 0 && (c.talkSeconds ?? -1) > (b.talkSeconds ?? -1)) ? c : b));
      out.push({ calls: cur, phoneKey, firstStart: cur[0]!.startedAt, firstEnd: endOf(cur[0]!), best });
      cur = [];
    };
    for (const c of list) {
      const end = endOf(c).getTime();
      if (cur.length && end - firstEnd < FOLD_WINDOW_SECONDS * 1000) cur.push(c);
      else { flush(); cur = [c]; firstEnd = end; }
    }
    flush();
  }
  return out;
}

/** A stored row, as much as matching and filling needs. NEVER carries the raw
 *  payload, a recording or anything else a call can hold. */
export interface StoredRow {
  id: string;
  phoneKey: string | null;
  submittedAt: Date;
  formName: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  callStatus: string | null;
  callTalkSeconds: number | null;
  callRingSeconds: number | null;
  callDurationSeconds: number | null;
  callDirection: string | null;
  callTrackingLabel: string | null;
  callRepeatCount: number | null;
  callTagRepeat: boolean | null;
  callTagAdsConversion: boolean | null;
}

export type RowKind = "call" | "unnamed" | "left_alone";

/** What the row is, from the row alone. A named form or an email is a form. */
export function rowKind(r: StoredRow): RowKind {
  const name = (r.formName ?? "").trim();
  if (/^\s*phone\s*:/i.test(name)) return "call";
  if (name === "" && !(r.email ?? "").trim()) return "unnamed";
  return "left_alone";
}

export interface RowPlan {
  rowId: string;
  /** The new form name, or null when the row already is a call. */
  relabel: string | null;
  /** Columns to fill (each is NULL on the row today). */
  fill: Partial<{
    callStatus: CallStatus; callTalkSeconds: number; callRingSeconds: number; callDurationSeconds: number;
    callDirection: "inbound" | "outbound"; callTrackingLabel: string; callRepeatCount: number;
    callTagRepeat: boolean; callTagAdsConversion: boolean;
  }>;
  /** True when the relabelled row's first name is not caller-ID text (shown, not blocked). */
  relabelNotCallerId: boolean;
  repeats: number;
}

export interface BackfillCounts {
  exportRows: number;
  calls: number;
  noNumber: number;
  badTime: number;
  clusters: number;
  /** Calls folded into another call of their cluster (what the webhook folds). */
  foldedCalls: number;
  matched: number;
  wouldRelabel: number;
  wouldRelabelNotCallerId: number;
  wouldFill: number;
  alreadyDescribed: number;
  leftAlone: number;
  unmatched: number;
  ambiguous: number;
  /** Cells that would be filled, by column. */
  filledCells: Record<string, number>;
}

export interface BackfillPlan { plans: RowPlan[]; counts: BackfillCounts }

export function planBackfill(read: ExportRead, rows: readonly StoredRow[]): BackfillPlan {
  const clusters = clusterCalls(read.calls);
  const counts: BackfillCounts = {
    exportRows: read.rows, calls: read.calls.length, noNumber: read.noNumber, badTime: read.badTime, clusters: clusters.length,
    foldedCalls: read.calls.length - clusters.length, matched: 0, wouldRelabel: 0, wouldRelabelNotCallerId: 0, wouldFill: 0,
    alreadyDescribed: 0, leftAlone: 0, unmatched: 0, ambiguous: 0, filledCells: {},
  };
  // Candidate rows per cluster, by number and the time window.
  const byPhone = new Map<string, StoredRow[]>();
  for (const r of rows) if (r.phoneKey) { const l = byPhone.get(r.phoneKey) ?? []; l.push(r); byPhone.set(r.phoneKey, l); }
  const candidates = clusters.map((c) =>
    (byPhone.get(c.phoneKey) ?? []).filter((r) => {
      const t = r.submittedAt.getTime();
      return t >= c.firstStart.getTime() - MATCH_BEFORE_START_SECONDS * 1000 && t <= c.firstEnd.getTime() + MATCH_AFTER_END_SECONDS * 1000;
    }));
  // A row wanted by two clusters is ambiguous for both.
  const wantedBy = new Map<string, number>();
  for (const list of candidates) for (const r of list) wantedBy.set(r.id, (wantedBy.get(r.id) ?? 0) + 1);

  const plans: RowPlan[] = [];
  clusters.forEach((c, i) => {
    const list = candidates[i]!;
    if (list.length === 0) { counts.unmatched++; return; }
    if (list.length > 1 || (wantedBy.get(list[0]!.id) ?? 0) > 1) { counts.ambiguous++; return; }
    const row = list[0]!;
    counts.matched++;
    const kind = rowKind(row);
    if (kind === "left_alone") { counts.leftAlone++; return; }
    const b = c.best;
    const repeats = c.calls.length - 1;
    const fill: RowPlan["fill"] = {};
    const put = <K extends keyof RowPlan["fill"]>(k: K, current: unknown, value: RowPlan["fill"][K] | null | undefined) => {
      if (current == null && value != null) { fill[k] = value as never; counts.filledCells[k] = (counts.filledCells[k] ?? 0) + 1; }
    };
    put("callStatus", row.callStatus, b.status);
    put("callTalkSeconds", row.callTalkSeconds, b.talkSeconds);
    put("callRingSeconds", row.callRingSeconds, b.ringSeconds);
    put("callDurationSeconds", row.callDurationSeconds, b.durationSeconds);
    put("callDirection", row.callDirection, b.direction);
    put("callTrackingLabel", row.callTrackingLabel, b.label ?? c.calls.find((x) => x.label)?.label ?? null);
    put("callRepeatCount", row.callRepeatCount, repeats);
    const anyTag = (f: "tagRepeat" | "tagAdsConversion") => (c.calls.some((x) => x[f] === true) ? true : c.calls.some((x) => x[f] === false) ? false : null);
    put("callTagRepeat", row.callTagRepeat, anyTag("tagRepeat"));
    put("callTagAdsConversion", row.callTagAdsConversion, anyTag("tagAdsConversion"));
    const relabel = kind === "unnamed" ? `Phone: ${(c.calls[0]!.source ?? "").trim() || "CallTrackingMetrics"}` : null;
    const notCallerId = relabel != null && !(isCallerIdText(row.firstName) && (!(row.lastName ?? "").trim() || isCallerIdText(row.lastName)));
    if (relabel) { counts.wouldRelabel++; if (notCallerId) counts.wouldRelabelNotCallerId++; }
    if (Object.keys(fill).length) counts.wouldFill++;
    if (!relabel && Object.keys(fill).length === 0) { counts.alreadyDescribed++; return; }
    plans.push({ rowId: row.id, relabel, fill, relabelNotCallerId: notCallerId, repeats });
  });
  return { plans, counts };
}

// ── copied: the report lines ────────────────────────────────────────────────
/** The dry run, as lines. Counts only: never a number, a name or caller-ID text. */
export function backfillReportLines(counts: BackfillCounts, applied: boolean): string[] {
  const verb = applied ? "" : "would ";
  const cells = Object.entries(counts.filledCells).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(", ");
  return [
    `export: ${counts.exportRows} rows, ${counts.calls} calls read, ${counts.noNumber} with no usable number, ${counts.badTime} with an unreadable time.`,
    `grouped the way the webhook folds them: ${counts.clusters} rows' worth of calls (${counts.foldedCalls} calls fold into another within ten minutes).`,
    `matched to a stored row: ${counts.matched}. unmatched: ${counts.unmatched}. ambiguous (left alone): ${counts.ambiguous}. a form with an email or a form name (left alone): ${counts.leftAlone}.`,
    `${verb}relabel as a call: ${counts.wouldRelabel} (${counts.wouldRelabelNotCallerId} of them with a name that is not caller-ID text).`,
    `${verb}fill details on: ${counts.wouldFill} rows${cells ? ` (${cells})` : ""}. already described, nothing to do: ${counts.alreadyDescribed}.`,
  ];
}

export { CALL_STATUSES as BACKFILL_CALL_STATUSES };

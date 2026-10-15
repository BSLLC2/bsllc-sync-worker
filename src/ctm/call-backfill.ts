/**
 * Matching the call log (`ctm_calls`) to the stored forms and calls (`web_inquiries`) IN THE DATABASE, and
 * writing what the call tracker knows onto the rows that lack it. No file leaves the database and no phone
 * number is ever held outside memory: a caller is a salted hash on one side, and each stored phone is hashed
 * with the SAME key (`callerHashOf`, the last ten digits) before it is compared.
 *
 * Two uses of one planner (`call-backfill-rules.ts`, copied byte for byte from the dashboard's one-time CSV
 * correction so a call is matched by one rule whichever way it arrives):
 *
 *   BACKFILL   `npm run backfill-calls-from-ctm -- --client=<slug>`      a dry run by default; `--apply` writes.
 *              Relabels a row with no form name and no email as a call, and fills what is blank.
 *   DAILY FILL called from the daily reader for a client's recent rows. FILLS BLANK DETAILS ON A ROW THAT IS
 *              ALREADY A CALL and nothing else: it never relabels (a classification is the backfill's act,
 *              done on purpose) and never touches a row the planner did not match cleanly.
 *
 * ── WHAT IT WRITES ───────────────────────────────────────────────────────────────────────────────────────
 *   • `web_inquiries` call_* columns, `COALESCE(column, value)`: a value already on the row is never replaced
 *     and a second run changes nothing. Nothing is deleted and no row is created.
 *   • `form_name` only on the backfill, only `Phone: <source>`, and only where the UPDATE itself still finds the
 *     name blank and no email (a row that changed between the read and the write is left alone).
 *   • ONE internal `client_activity_log` line per client per run that wrote anything, counts only,
 *     `visible_to_client` false.
 *
 * ── WHAT IT NEVER DOES ───────────────────────────────────────────────────────────────────────────────────
 * It never selects `raw_json`, a message, a recording, a transcript or a note (none is stored on either side),
 * never prints a phone number, a name or caller-ID text, and never reads a third party: both tables are this
 * app's own. The stored phone, first name and last name are read into memory to hash the phone and to judge
 * whether a relabelled row's name was caller-ID text; they appear in no output.
 */
import { callerHashOf } from "./map.js";
import {
  planBackfill, backfillReportLines,
  type BackfillCounts, type BackfillPlan, type ExportCall, type ExportRead, type RowPlan, type StoredRow, type CallStatus,
} from "./call-backfill-rules.js";

/** Anything with a pg-style `query`, so a guard can drive a real scratch schema. */
export interface Pg { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> }

/** The history line's category and title. Literal, so the dashboard's wiring guard can read the insert. */
export const BACKFILL_HISTORY_TITLE = "Calls corrected from the call tracker's log";
export const DAILY_HISTORY_TITLE = "Calls given their details from the call tracker";

export const SELECT_CTM_CALLS = `SELECT ctm_call_id, called_at, tracking_source, tracking_label, status, talk_seconds, ring_seconds, duration_seconds, direction, tags_repeat, tags_google_ads_conversion, caller_hash
  FROM ctm_calls WHERE client_id = $1 AND called_at >= $2::timestamptz AND called_at <= $3::timestamptz ORDER BY called_at`;

/** Named columns only. No raw_json, no message, no address. `email` is reduced to "present or not" in SQL. */
export const SELECT_INQUIRIES = `SELECT id, phone, submitted_at, form_name, CASE WHEN btrim(coalesce(email, '')) = '' THEN NULL ELSE 'present' END AS email,
    first_name, last_name, call_status, call_talk_seconds, call_ring_seconds, call_duration_seconds, call_direction,
    call_tracking_label, call_repeat_count, call_tag_repeat, call_tag_ads_conversion
  FROM web_inquiries WHERE client_slug = $1 AND submitted_at >= $2::timestamptz AND submitted_at <= $3::timestamptz`;

/** One row, filled only where blank. The relabel is guarded in the statement itself. */
export const UPDATE_INQUIRY = `UPDATE web_inquiries SET
    form_name = CASE WHEN $3::text IS NOT NULL AND coalesce(form_name, '') = '' AND coalesce(email, '') = '' THEN $3::text ELSE form_name END,
    call_status = COALESCE(call_status, $4::text),
    call_talk_seconds = COALESCE(call_talk_seconds, $5::int),
    call_ring_seconds = COALESCE(call_ring_seconds, $6::int),
    call_duration_seconds = COALESCE(call_duration_seconds, $7::int),
    call_direction = COALESCE(call_direction, $8::text),
    call_tracking_label = COALESCE(call_tracking_label, $9::text),
    call_repeat_count = COALESCE(call_repeat_count, $10::int),
    call_tag_repeat = COALESCE(call_tag_repeat, $11::boolean),
    call_tag_ads_conversion = COALESCE(call_tag_ads_conversion, $12::boolean)
  WHERE id = $1 AND client_slug = $2`;

export const INSERT_HISTORY = `INSERT INTO client_activity_log (id, client_id, category, title, client_summary, internal_detail, visible_to_client, occurred_at, created_by)
  VALUES ($1, $2, 'reporting', $3, NULL, $4, false, $5, $6)`;

const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));
const bool = (v: unknown): boolean | null => (v == null ? null : Boolean(v));

/** The Eastern calendar day, for the history line's date. */
export function easternDay(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** A call-log row as the planner reads a call. A row with no usable caller is counted, never matched. */
export function exportCallOf(r: Record<string, unknown>): ExportCall | null {
  const hash = str(r.caller_hash);
  if (!hash) return null;
  const status = str(r.status);
  const dir = str(r.direction);
  return {
    phoneKey: hash,
    source: str(r.tracking_source),
    status: status === "answered" || status === "hangup" || status === "no_answer" ? (status as CallStatus) : null,
    durationSeconds: num(r.duration_seconds),
    ringSeconds: num(r.ring_seconds),
    talkSeconds: num(r.talk_seconds),
    startedAt: asDate(r.called_at),
    label: str(r.tracking_label),
    tagRepeat: bool(r.tags_repeat),
    tagAdsConversion: bool(r.tags_google_ads_conversion),
    direction: dir === "inbound" || dir === "outbound" ? dir : null,
    callId: str(r.ctm_call_id),
  };
}

export function readOf(rows: Array<Record<string, unknown>>): ExportRead {
  const calls: ExportCall[] = [];
  let noNumber = 0;
  for (const r of rows) { const c = exportCallOf(r); if (c) calls.push(c); else noNumber++; }
  return { calls, rows: rows.length, noNumber, badTime: 0, missing: [] };
}

/** A stored row as the planner reads it, with the phone replaced by its hash. The phone is not kept. */
export function storedRowOf(r: Record<string, unknown>, hashKey: string): StoredRow {
  return {
    id: String(r.id),
    phoneKey: callerHashOf(r.phone, hashKey),
    submittedAt: asDate(r.submitted_at),
    formName: str(r.form_name),
    email: str(r.email),
    firstName: str(r.first_name),
    lastName: str(r.last_name),
    callStatus: str(r.call_status),
    callTalkSeconds: num(r.call_talk_seconds),
    callRingSeconds: num(r.call_ring_seconds),
    callDurationSeconds: num(r.call_duration_seconds),
    callDirection: str(r.call_direction),
    callTrackingLabel: str(r.call_tracking_label),
    callRepeatCount: num(r.call_repeat_count),
    callTagRepeat: bool(r.call_tag_repeat),
    callTagAdsConversion: bool(r.call_tag_ads_conversion),
  };
}

export interface Window { from: Date; to: Date }
const MIN = 60_000;
/** A row can be filed up to five minutes after its call ends and a call can run for hours. */
const ROW_PAD_AFTER_MS = 6 * 60 * MIN;
const ROW_PAD_BEFORE_MS = 2 * MIN;

/** Read both sides for a window and plan. Reads only. */
export async function planFromDb(db: Pg, c: { clientId: string; slug: string }, hashKey: string, win: Window | null): Promise<BackfillPlan & { callRows: number }> {
  const callFrom = win ? win.from : new Date(0);
  const callTo = win ? win.to : new Date("2100-01-01T00:00:00Z");
  const calls = (await db.query(SELECT_CTM_CALLS, [c.clientId, callFrom.toISOString(), callTo.toISOString()])).rows;
  const rowFrom = new Date(callFrom.getTime() - ROW_PAD_BEFORE_MS);
  const rowTo = win ? new Date(callTo.getTime() + ROW_PAD_AFTER_MS) : callTo;
  const stored = (await db.query(SELECT_INQUIRIES, [c.slug, rowFrom.toISOString(), rowTo.toISOString()])).rows.map((r) => storedRowOf(r, hashKey));
  const plan = planBackfill(readOf(calls), stored);
  return { ...plan, callRows: calls.length };
}

/** Apply a plan inside one transaction. Returns the rows actually changed. */
export async function applyPlans(db: Pg, slug: string, plans: readonly RowPlan[]): Promise<number> {
  let written = 0;
  await db.query("BEGIN");
  try {
    for (const p of plans) {
      const f = p.fill;
      const res = await db.query(UPDATE_INQUIRY, [p.rowId, slug, p.relabel, f.callStatus ?? null, f.callTalkSeconds ?? null, f.callRingSeconds ?? null, f.callDurationSeconds ?? null, f.callDirection ?? null, f.callTrackingLabel ?? null, f.callRepeatCount ?? null, f.callTagRepeat ?? null, f.callTagAdsConversion ?? null]);
      written += res.rowCount ?? 0;
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  }
  return written;
}

/** One internal line, counts only. */
export async function writeHistory(db: Pg, clientId: string, title: string, detail: string, by: string, at: Date, id: string): Promise<void> {
  await db.query(INSERT_HISTORY, [id, clientId, title, detail, easternDay(at), by]);
}

export interface BackfillOutcome {
  ok: boolean;
  message?: string;
  counts?: BackfillCounts;
  callRows: number;
  lines: string[];
  applied: boolean;
  written: number;
}

/** The one-time correction for a client, from the call log already in the database. */
export async function runBackfill(db: Pg, o: { clientId: string; slug: string; hashKey: string; apply: boolean; by: string; now: Date; newId: () => string }): Promise<BackfillOutcome> {
  const plan = await planFromDb(db, o, o.hashKey, null);
  const lines = backfillReportLines(plan.counts, o.apply);
  if (plan.callRows === 0) {
    return { ok: true, counts: plan.counts, callRows: 0, applied: false, written: 0, lines: ["the call log holds no calls for this client yet, so there is nothing to match. Read it first with the call-log reader (and the `days` input for history), then run this again.", ...lines] };
  }
  let written = 0;
  if (o.apply) {
    written = await applyPlans(db, o.slug, plan.plans);
    const c = plan.counts;
    // A run that changed nothing (a second run) leaves no line: the line says what was done.
    if (written > 0) await writeHistory(db, o.clientId, BACKFILL_HISTORY_TITLE,
      `${c.matched} calls matched a stored row. ${c.wouldRelabel} filed as calls, ${c.wouldFill} rows given their details, ${written} rows written. ${c.ambiguous} left alone as ambiguous, ${c.unmatched} with no row. Corrected from the call tracker's log by ${o.by}.`,
      o.by, o.now, o.newId());
  }
  return { ok: true, counts: plan.counts, callRows: plan.callRows, lines, applied: o.apply, written };
}

export interface DailyFill {
  /** Rows whose blank details were filled (or would be, on a dry run). */
  rows: number;
  /** Cells filled, by column. */
  cells: Record<string, number>;
  /** Rows that need a person to relabel them as calls first (the backfill's act). */
  leftForBackfill: number;
  ambiguous: number;
  /** Calls in the window with no stored row (the reconciliation names those days). */
  unmatched: number;
  written: number;
}

/** The days a daily fill looks back over. Our own line. */
export const DAILY_FILL_DAYS = 14;

/** Fill blank call details on recent rows that are already calls. Never relabels. */
export async function runDailyFill(db: Pg, o: { clientId: string; slug: string; hashKey: string; apply: boolean; now: Date; days?: number; newId: () => string }): Promise<DailyFill> {
  const days = o.days ?? DAILY_FILL_DAYS;
  // The call window starts a day earlier than the rows it fills, so a call that began just before the window still folds into its cluster.
  const win: Window = { from: new Date(o.now.getTime() - (days + 1) * 86_400_000), to: o.now };
  const plan = await planFromDb(db, o, o.hashKey, win);
  const mine = plan.plans.filter((p) => p.relabel == null && Object.keys(p.fill).length > 0);
  const cells: Record<string, number> = {};
  for (const p of mine) for (const k of Object.keys(p.fill)) cells[k] = (cells[k] ?? 0) + 1;
  const out: DailyFill = { rows: mine.length, cells, leftForBackfill: plan.counts.wouldRelabel, ambiguous: plan.counts.ambiguous, unmatched: plan.counts.unmatched, written: 0 };
  if (o.apply && mine.length) {
    out.written = await applyPlans(db, o.slug, mine);
    if (out.written > 0) {
      await writeHistory(db, o.clientId, DAILY_HISTORY_TITLE,
        `${out.written} call${out.written === 1 ? "" : "s"} from the last ${days} days had details missing (how it ended, talk time, tracking label) that the call tracker's log holds. They were filled in. Nothing already on a call was changed.`,
        "Call tracker reader", o.now, o.newId());
    }
  }
  return out;
}

export function dailyFillLine(d: DailyFill, dry: boolean): string {
  const bits = [`${dry ? "would fill" : "filled"} ${dry ? d.rows : d.written} call${(dry ? d.rows : d.written) === 1 ? "" : "s"}`];
  if (d.leftForBackfill) bits.push(`${d.leftForBackfill} filed as a form that the correction can relabel`);
  if (d.ambiguous) bits.push(`${d.ambiguous} ambiguous, left alone`);
  return bits.join(", ");
}

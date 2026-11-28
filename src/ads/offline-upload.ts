/**
 * OFFLINE CONVERSION UPLOAD: the decisions, pure.
 *
 * A client's sales sheet counted a win (the stored feed summary, written by the
 * tracker job). This module decides which of those wins may be sent back to
 * Google Ads as an offline click conversion through the Data Manager API (src/ads/data-manager.ts), what each is worth, and whether the
 * conversion action it would land on is safe to use. The job in
 * src/upload-offline-conversions.ts only gathers and calls Google.
 *
 * Owner sign-off (sebastien@bsllc.biz, 2026-11-16) is conditional on these
 * safeguards, and every one is a function here so a test can fail it:
 *   - a client is uploaded for only if it is on an explicit allow-list
 *   - (checked in data-manager.ts actionFault) the action must already exist, be an upload-from-clicks action, enabled,
 *     and SECONDARY (not primary for its goal). It is never created or changed
 *   - a value is only the amount the sheet recorded, cut to the ceiling the
 *     client's own offline value setting names. Never customer_value_cents
 *   - a click id counts only inside 90 days of the closed date
 *   - the first real run is validate-only; sending needs a recent validation
 *   - nothing here prints a click id, a name, a phone or an email
 *
 * The rules below (judgeWin, the value modes) are copies of the dashboard's
 * shared/offline-conversions.ts. The repos cannot import from each other, so
 * `npm run verify:wiring` compares the constants.
 */

export const GOOGLE_CLICK_WINDOW_DAYS = 90;
export const MAX_VALUE_CAP_CENTS = 100_000_000;
export const VALUE_MODES = ["amount", "capped", "count"] as const;
export type ValueMode = (typeof VALUE_MODES)[number];
export const MODES = ["dry", "validate", "send"] as const;
export type RunMode = (typeof MODES)[number];

export interface AllowEntry { action: string }
export interface AllowList { list: Record<string, AllowEntry>; fault: string | null }

const slugOk = (s: string) => /^[a-z0-9][a-z0-9-]{1,80}$/.test(s);

/** OFFLINE_UPLOAD_CLIENTS: {"client-slug": {"action": "Name of the secondary action"}}. Anything unreadable allows nobody. */
export function parseAllowList(raw: string | null | undefined): AllowList {
  if (!raw || !raw.trim()) return { list: {}, fault: null };
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return { list: {}, fault: "The allow-list is not valid JSON, so no client is allowed." }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { list: {}, fault: "The allow-list must be an object of client names, so no client is allowed." };
  const list: Record<string, AllowEntry> = {};
  for (const [slug, v] of Object.entries(o as Record<string, unknown>)) {
    const action = v && typeof v === "object" ? (v as { action?: unknown }).action : null;
    if (!slugOk(slug) || typeof action !== "string" || action.trim().length < 3 || action.length > 120) {
      return { list: {}, fault: `The allow-list entry for "${slug.slice(0, 40)}" is not a client name with an action name, so no client is allowed.` };
    }
    list[slug] = { action: action.trim() };
  }
  return { list, fault: null };
}

export interface Win { row: number; closed: string; cents: number; gclid: string | null; clickOn: string | null }
export type Verdict = "ready" | "no_click_id" | "bad_click_id" | "no_date" | "future_or_today" | "no_click_date" | "before_click" | "too_late" | "no_amount" | "already_sent";

export const isPlainClickId = (v: string): boolean => /^[A-Za-z0-9_\-.]{8,200}$/.test(v);
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const ymdMs = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const m = YMD.exec(s.slice(0, 10));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === s.slice(0, 10) ? ms : null;
};
const daysBetween = (a: string, b: string): number | null => {
  const x = ymdMs(a), y = ymdMs(b);
  return x == null || y == null ? null : Math.round((y - x) / 86_400_000);
};
export const sentKey = (clickId: string, closed: string): string => `${clickId}|${closed.slice(0, 10)}`;

/**
 * today is the business day in Eastern. A win closed TODAY waits a day: its
 * conversion time would be in the future and Google refuses a future time.
 */
export function judgeWin(w: Win, today: string, sent: ReadonlySet<string>): Verdict {
  if (!w.gclid || !w.gclid.trim()) return "no_click_id";
  if (!isPlainClickId(w.gclid.trim())) return "bad_click_id";
  const closed = ymdMs(w.closed);
  const now = ymdMs(today);
  if (closed == null) return "no_date";
  if (now != null && closed >= now) return "future_or_today";
  if (!w.clickOn) return "no_click_date";
  const gap = daysBetween(w.clickOn, w.closed);
  if (gap == null) return "no_click_date";
  if (gap < 0) return "before_click";
  if (gap > GOOGLE_CLICK_WINDOW_DAYS) return "too_late";
  if (!Number.isFinite(w.cents) || w.cents < 0) return "no_amount";
  if (sent.has(sentKey(w.gclid.trim(), w.closed))) return "already_sent";
  return "ready";
}

export interface ValueSetting { mode: ValueMode; capCents: number | null }
/** app_settings `offline_value:<clientId>`. A sheet client defaults to capped with no ceiling, which stops the run. */
export function parseValueSetting(raw: string | null | undefined): ValueSetting {
  const none: ValueSetting = { mode: "capped", capCents: null };
  if (!raw) return none;
  try {
    const o = JSON.parse(raw);
    if (!o || !(VALUE_MODES as readonly string[]).includes(o.mode)) return none;
    const cap = Number(o.capCents);
    return { mode: o.mode as ValueMode, capCents: Number.isInteger(cap) && cap > 0 && cap <= MAX_VALUE_CAP_CENTS ? cap : null };
  } catch { return none; }
}

export interface Row { gclid: string; closed: string; valueCents: number | null; transactionId: string }
export interface Plan {
  ok: boolean; refusal: string | null; rows: Row[];
  counts: Record<Verdict, number> & { cut: number; total: number };
}
export const CAP_MISSING = "The value is set to a ceiling and no ceiling is typed, so nothing is sent. Type the most one sale may be worth in the dashboard, or choose count only.";

export function planUpload(wins: readonly Win[], today: string, sent: ReadonlySet<string>, setting: ValueSetting): Plan {
  const counts = { ready: 0, no_click_id: 0, bad_click_id: 0, no_date: 0, future_or_today: 0, no_click_date: 0, before_click: 0, too_late: 0, no_amount: 0, already_sent: 0, cut: 0, total: wins.length } as Plan["counts"];
  if (setting.mode === "capped" && setting.capCents == null) return { ok: false, refusal: CAP_MISSING, rows: [], counts };
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const w of wins) {
    let v = judgeWin(w, today, sent);
    const key = w.gclid ? sentKey(w.gclid.trim(), w.closed) : "";
    if (v === "ready" && seen.has(key)) v = "already_sent";
    counts[v] += 1;
    if (v !== "ready") continue;
    seen.add(key);
    let value: number | null = null;
    if (setting.mode === "amount") value = w.cents > 0 ? w.cents : null;
    else if (setting.mode === "capped") {
      const cap = setting.capCents as number;
      if (w.cents > cap) { counts.cut += 1; value = cap; } else value = w.cents > 0 ? w.cents : null;
    }
    rows.push({ gclid: w.gclid!.trim(), closed: w.closed.slice(0, 10), valueCents: value, transactionId: `sheet-${w.gclid!.trim().slice(0, 16)}-${w.closed.slice(0, 10)}` });
  }
  return { ok: true, refusal: null, rows, counts };
}

/** The line the heartbeat carries. Counts only. */
export function summaryLine(parts: { mode: RunMode; clients: number; ready: number; sent: number; rejected: number; stopped: number }): string {
  const { mode, clients, ready, sent, rejected, stopped } = parts;
  const head = mode === "dry" ? "dry run" : mode === "validate" ? "validated only, nothing was sent" : "sent";
  return `${head}: ${clients} client(s), ${ready} ready, ${sent} accepted, ${rejected} rejected${stopped ? `, ${stopped} stopped` : ""}`;
}

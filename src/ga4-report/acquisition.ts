/**
 * Where a site's visits came from over the last 28 complete days, against the 28 days before:
 * sessions, engaged sessions and key events, by channel group and by source and medium.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The Website performance report is MONTHLY (ga4_report_rows, one row per finished calendar
 * month), so it cannot say how traffic acquisition moved over the last four weeks, and the
 * four weeks that matter rarely line up with a month. This reads the same property for two
 * rolling windows and keeps both, each row carrying its own window dates. The monthly rows
 * are untouched and are not read here.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 *  1. READ-ONLY toward Google, counts only. No user id, no IP, no client id from analytics.
 *  2. THE WINDOWS END `GA4_LAG_DAYS` BEFORE TODAY, the same assumption the page-behaviour reader
 *     makes, so a window is made of complete days. `current` is the 28 days ending there and
 *     `before` the 28 days before that.
 *  3. A KIND IS READ IN FULL, BOTH WINDOWS, OR NOT AT ALL. A comparison with one side missing is
 *     worse than none, so a kind that fails (or is too big to read in full) keeps its earlier rows
 *     and is named on the run row.
 *  4. A MISSING ROW IS A REAL NOUGHT ONLY WHERE THE WINDOW WAS READ IN FULL. GA4 sends no row for a
 *     source with no sessions, and the run row says which windows were read.
 *  5. A METRIC THE PROPERTY REJECTED IS A NULL COLUMN, NEVER A NOUGHT. A 400 moves down the metric
 *     ladder (key events, then conversions, then none); nothing else does.
 *  6. THE COUNTRY AND OWN-HOSTNAME SETTINGS A PERSON TYPED ARE APPLIED, so these figures leave out
 *     the same traffic the monthly report leaves out. The channel exclusion is applied to the
 *     source-and-medium list and NOT to the channel list, which has to show every channel.
 *
 * NONE OF THE REQUEST SHAPES HAS BEEN RUN AGAINST A LIVE PROPERTY. They are written from the Data
 * API's documentation; `keyEvents` and `sessionDefaultChannelGroup` together in one request is the
 * least certain (the ladder drops the metric if the property refuses it).
 */
import { HttpError, safeMessage } from "../page-behaviour/http.js";
import { ga4Windows } from "../page-behaviour/ga4.js";
import type { Windows } from "../page-behaviour/types.js";
import { andFilters, channelExclusionFilter, exclusionFilter, hostFilter, postAll, type Io } from "./ga4.js";
import type { ReportConfig } from "./types.js";

export const ACQUISITION_KINDS = ["channel", "source_medium"] as const;
export type AcquisitionKind = (typeof ACQUISITION_KINDS)[number];
export const ACQUISITION_PERIODS = ["current", "before"] as const;
export type AcquisitionPeriod = (typeof ACQUISITION_PERIODS)[number];
export const ACQUISITION_STATUSES = ["ok", "off", "error", "no_data"] as const;
export type AcquisitionStatus = (typeof ACQUISITION_STATUSES)[number];

/** Rows kept per kind per window. The ceiling cuts the smallest. OURS. */
export const ACQUISITION_TOP_N: Record<AcquisitionKind, number> = { channel: 40, source_medium: 100 };

/** Most complete first. A dropped metric becomes a NULL column. */
export const ACQUISITION_LADDER: ReadonlyArray<readonly string[]> = [
  ["sessions", "engagedSessions", "keyEvents"],
  ["sessions", "engagedSessions", "conversions"],
  ["sessions", "engagedSessions"],
  ["sessions"],
];

const DIMENSION: Record<AcquisitionKind, string> = { channel: "sessionDefaultChannelGroup", source_medium: "sessionSourceMedium" };

export interface AcquisitionRowOut {
  kind: AcquisitionKind;
  period: AcquisitionPeriod;
  windowStart: string;
  windowEnd: string;
  key: string;
  sessions: number | null;
  engagedSessions: number | null;
  keyEvents: number | null;
}

export interface AcquisitionResult {
  status: AcquisitionStatus;
  detail: string | null;
  windows: Windows | null;
  /** Rows by kind, only for kinds read in full for both windows. */
  kinds: Partial<Record<AcquisitionKind, AcquisitionRowOut[]>>;
  failedKinds: AcquisitionKind[];
  cappedKinds: AcquisitionKind[];
  config: ReportConfig;
  rows: number;
}

export const acquisitionWindows = (today: string): Windows => ga4Windows(today);

export function acquisitionRequest(
  window: { start: string; end: string }, kind: AcquisitionKind, metrics: readonly string[],
  countries: readonly string[], channels: readonly string[] = [], hosts: readonly string[] = [],
) {
  const dimensionFilter = andFilters(exclusionFilter(countries), kind === "channel" ? null : channelExclusionFilter(channels), hostFilter(hosts));
  return {
    dateRanges: [{ startDate: window.start, endDate: window.end }],
    dimensions: [{ name: DIMENSION[kind] }],
    metrics: metrics.map((name) => ({ name })),
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    ...(dimensionFilter ? { dimensionFilter } : {}),
  };
}

interface GaRow { dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }
interface GaReport { metricHeaders?: Array<{ name?: string }>; rows?: GaRow[] }

const num = (v: string | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const whole = (n: number | null): number | null => (n == null ? null : Math.round(n));
const add = (a: number | null, b: number | null): number | null => (b == null ? a : (a ?? 0) + b);
const keyText = (v: string | undefined, max = 160): string => {
  const t = String(v ?? "").trim();
  return (t === "" ? "(not set)" : t).slice(0, max);
};

/** One report's rows to one row per key. A repeated key is summed. */
export function parseAcquisition(report: unknown, kind: AcquisitionKind, period: AcquisitionPeriod, window: { start: string; end: string }): AcquisitionRowOut[] {
  const r = (report ?? {}) as GaReport;
  const names = (r.metricHeaders ?? []).map((h) => String(h.name ?? ""));
  const at = (n: string) => names.indexOf(n);
  const keyAt = at("keyEvents") >= 0 ? at("keyEvents") : at("conversions");
  const ix = { sessions: at("sessions"), engaged: at("engagedSessions"), keyEvents: keyAt };
  const by = new Map<string, AcquisitionRowOut>();
  for (const row of r.rows ?? []) {
    const key = keyText(row.dimensionValues?.[0]?.value);
    const mv = row.metricValues ?? [];
    const get = (i: number) => (i >= 0 ? num(mv[i]?.value) : null);
    const cur = by.get(key) ?? { kind, period, windowStart: window.start, windowEnd: window.end, key, sessions: null, engagedSessions: null, keyEvents: null };
    cur.sessions = add(cur.sessions, whole(get(ix.sessions)));
    cur.engagedSessions = add(cur.engagedSessions, whole(get(ix.engaged)));
    cur.keyEvents = add(cur.keyEvents, get(ix.keyEvents));
    by.set(key, cur);
  }
  return Array.from(by.values());
}

/** The busiest `n` rows, ties by key. Says whether anything was cut. */
export function topRows(rows: readonly AcquisitionRowOut[], n: number): { kept: AcquisitionRowOut[]; cut: boolean } {
  const sorted = [...rows].sort((a, b) => (b.sessions ?? 0) - (a.sessions ?? 0) || a.key.localeCompare(b.key));
  return { kept: sorted.slice(0, n), cut: sorted.length > n };
}

/** Tries each rung of a metric ladder. Only a 400 moves to the next; the last error is thrown. */
async function ladder<T>(rungs: ReadonlyArray<readonly string[]>, run: (metrics: readonly string[]) => Promise<T>): Promise<T> {
  let last: unknown = null;
  for (const metrics of rungs) {
    try { return await run(metrics); }
    catch (e) {
      last = e;
      if (!(e instanceof HttpError) || e.status !== 400) throw e;
    }
  }
  throw last;
}

export interface KindRead { rows: AcquisitionRowOut[]; cut: boolean; tooBig: boolean }

/** One kind, BOTH windows. Either window too big or failing fails the whole kind. */
export async function readAcquisitionKind(io: Io, windows: Windows, kind: AcquisitionKind, config: ReportConfig): Promise<KindRead> {
  const out: AcquisitionRowOut[] = [];
  let cut = false;
  // One metric rung is chosen for the kind (from the current window) and used for both, so the two sides never measure different things.
  let used: readonly string[] | null = null;
  for (const period of ACQUISITION_PERIODS) {
    const w = period === "current" ? windows.current : windows.prior;
    const paged = await ladder(used ? [used] : ACQUISITION_LADDER, (metrics) =>
      postAll(io, acquisitionRequest(w, kind, metrics, config.excludeCountries, config.excludeChannels, config.ownHostnames), `GA4 runReport (acquisition ${kind})`).then((p) => { used = metrics; return p; }));
    if (paged.truncated) return { rows: [], cut: false, tooBig: true };
    const { kept, cut: c } = topRows(parseAcquisition(paged.report, kind, period, w), ACQUISITION_TOP_N[kind]);
    if (c) cut = true;
    out.push(...kept);
  }
  return { rows: out, cut, tooBig: false };
}

export interface AcquisitionDeps { today: string }

export async function readClientAcquisition(property: string | null, config: ReportConfig, io: Io | null, deps: AcquisitionDeps, tokenError: string | null = null): Promise<AcquisitionResult> {
  const base = (status: AcquisitionStatus, detail: string | null, extra: Partial<AcquisitionResult> = {}): AcquisitionResult =>
    ({ status, detail, windows: null, kinds: {}, failedKinds: [], cappedKinds: [], config, rows: 0, ...extra });
  if (!property) return base("off", "No analytics property is connected for this account.");
  if (tokenError || !io) return base("error", tokenError ?? "No analytics token.");
  const windows = acquisitionWindows(deps.today);
  const kinds: Partial<Record<AcquisitionKind, AcquisitionRowOut[]>> = {};
  const failed: AcquisitionKind[] = [];
  const capped: AcquisitionKind[] = [];
  let firstError: string | null = null;
  for (const kind of ACQUISITION_KINDS) {
    try {
      const r = await readAcquisitionKind(io, windows, kind, config);
      if (r.tooBig) { failed.push(kind); firstError ??= `${kind} was more rows than one read allows.`; continue; }
      kinds[kind] = r.rows;
      if (r.cut) capped.push(kind);
    } catch (e) {
      failed.push(kind);
      firstError ??= safeMessage(e, [io.token]);
    }
  }
  const rows = Object.values(kinds).reduce((n, list) => n + (list?.length ?? 0), 0);
  const read = ACQUISITION_KINDS.filter((k) => kinds[k] != null);
  if (read.length === 0) return base("error", `Neither list could be read, so nothing was written. ${firstError ?? ""}`.trim(), { windows, failedKinds: failed });
  if (rows === 0) return base("no_data", "The property had no visits in either window.", { windows, kinds, cappedKinds: capped, failedKinds: failed });
  const notes: string[] = [];
  if (failed.length) notes.push(`These could not be read in full for both windows and keep their earlier rows: ${failed.join(", ")}.${firstError ? ` ${firstError}` : ""}`);
  return { status: "ok", detail: notes.length ? notes.join(" ") : null, windows, kinds, failedKinds: failed, cappedKinds: capped, config, rows };
}

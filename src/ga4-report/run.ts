/**
 * One client's Website performance read.
 *
 * Takes a fetch and a token supplier, so the guard drives the real orchestration
 * with a pretend Google and no network or database. Returns what the store should
 * write and the run's own status; writing it is `store.ts`'s job.
 *
 * EVERY CLIENT ENDS AS A STATUS, NEVER AS SILENCE.
 *   off      no analytics property is connected
 *   error    the token, the daily read, or every report failed
 *   no_data  the property answered and had no visits in the window
 *   capped   the daily read, or a report, was too big to read in full
 *   ok       the daily totals were read; any report that failed is named in
 *            `failedKinds` and keeps its earlier rows
 *
 * The DAILY read is the gate: when it does not complete nothing else is read and
 * nothing is written but the run row. A report that fails is left exactly as it
 * was. A kind is replaced only when it was read in full.
 */
import { safeMessage } from "../page-behaviour/http.js";
import { monthsBetween, readWindow } from "./months.js";
import { kindSpecs, readDaily, readKind, type Io } from "./ga4.js";
import {
  DEFAULT_MONTHS, PAUSE_MS, REPORT_KINDS,
  type ClientCtx, type ClientReportResult, type FetchLike, type ReportConfig, type ReportKind, type ReportRowOut, type RunStatus,
} from "./types.js";

export interface Deps {
  fetch: FetchLike;
  /** An analytics token. Throws with a plain message where it cannot mint one. */
  token: () => Promise<string>;
  /** Today, UTC, as YYYY-MM-DD. */
  today: string;
  /** Months of history. */
  months?: number;
  /** Wait between calls to the property and before a retry. Defaults to the real thing; the guard passes a no-op. */
  sleep?: (ms: number) => Promise<void>;
  pauseMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function result(config: ReportConfig, status: RunStatus, detail: string | null, extra: Partial<ClientReportResult> = {}): ClientReportResult {
  return {
    status, detail, daily: null, firstDay: null, lastDay: null, firstMonth: null, lastMonth: null, months: [],
    kinds: {}, cappedKinds: [], failedKinds: [], config, rows: 0, ...extra,
  };
}

export async function readClientReport(ctx: ClientCtx, config: ReportConfig, deps: Deps): Promise<ClientReportResult> {
  if (!ctx.ga4Property) return result(config, "off", "No analytics property is connected for this account.");
  const w = readWindow(deps.today, deps.months ?? DEFAULT_MONTHS);
  if (!w) return result(config, "error", "The read window could not be worked out from today's date.");

  let token: string;
  try { token = await deps.token(); } catch (e) { return result(config, "error", safeMessage(e)); }
  const sleep = deps.sleep ?? realSleep;
  const io: Io = { fetch: deps.fetch, token, property: ctx.ga4Property, sleep, pauseMs: deps.pauseMs ?? PAUSE_MS, calls: 0 };
  const say = (e: unknown) => safeMessage(e, [token]);

  /* ── the daily totals are the gate ── */
  let daily;
  try { daily = await readDaily(io, w, config.excludeCountries); }
  catch (e) { return result(config, "error", `The daily totals could not be read, so nothing was written. ${say(e)}`); }
  if (daily.kind === "too_big") {
    return result(config, "capped", "The daily totals were more rows than one read allows, so nothing was written for this account.");
  }
  if (daily.kind === "empty") return result(config, "no_data", "The property had no visits in the window.");

  const { rows: dailyRows, firstDay, lastDay } = daily.read;
  const months = monthsBetween(firstDay, lastDay);
  const monthSet = new Set(months);

  /* ── each report, on its own ── */
  const specs = kindSpecs(config.groups, config.formEvent);
  const kinds: Partial<Record<ReportKind, ReportRowOut[]>> = {};
  const failed: ReportKind[] = [];
  const capped: ReportKind[] = [];
  const tooBig: ReportKind[] = [];
  let attempted = 0;
  let firstError: string | null = null;
  for (const kind of REPORT_KINDS) {
    const ofKind = specs.filter((s) => s.kind === kind);
    // A group kind with no groups configured reads in full as nothing, which clears rows of a group since removed.
    if (ofKind.length === 0) { kinds[kind] = []; continue; }
    attempted += 1;
    try {
      const r = await readKind(io, w, ofKind, config.excludeCountries, monthSet);
      if (r.tooBig) { failed.push(kind); tooBig.push(kind); continue; }
      kinds[kind] = r.rows;
      if (r.cut) capped.push(kind);
    } catch (e) {
      failed.push(kind);
      firstError ??= say(e);
    }
  }

  const rows = dailyRows.length + Object.values(kinds).reduce((n, list) => n + (list?.length ?? 0), 0);
  const base = { daily: dailyRows, firstDay, lastDay, firstMonth: months[0] ?? null, lastMonth: months[months.length - 1] ?? null, months, kinds, cappedKinds: capped, failedKinds: failed, rows };
  if (attempted > 0 && failed.length === attempted && tooBig.length < failed.length) {
    return result(config, "error", `The daily totals were read, but every report failed and keeps its earlier rows. ${firstError ?? ""}`.trim(), base);
  }
  const notes: string[] = [];
  if (failed.length) notes.push(`These reports could not be read in full and keep their earlier rows: ${failed.join(", ")}.${firstError ? ` ${firstError}` : ""}`);
  if (tooBig.length) notes.push(`More rows than one read allows: ${tooBig.join(", ")}.`);
  return result(config, tooBig.length ? "capped" : "ok", notes.length ? notes.join(" ") : null, base);
}

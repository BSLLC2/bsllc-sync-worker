/**
 * One GA4 reader for the audit. A query names its dimensions, metrics, filter and up
 * to four date ranges; rows come back as plain objects with the range they belong to.
 *
 * READ-ONLY. Nothing here writes to Google or to a database. Quota: every question
 * about the current window, the prior period and the prior year is ONE request (GA4
 * accepts four named date ranges), and an answer for a window that ended at least
 * CACHE_MIN_AGE_DAYS ago is cached on disk by a hash of the request, so a re-run costs
 * nothing for history. A window that touches the last few days is never cached.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { postAll, type Io, type Filter } from "../ga4-report/ga4.js";
import { addDays } from "../page-behaviour/paths.js";
import type { Window } from "./periods.js";

export interface Query {
  dims: readonly string[];
  metrics: readonly string[];
  ranges: readonly Window[];
  filter?: Filter | null;
  /** The metric rows are read in descending order of. */
  orderBy?: string;
}

export interface Row {
  /** Dimension values in the order asked for. */
  dims: string[];
  /** Index into the ranges of the query. */
  range: number;
  /** A metric the property did not return is null, never 0. */
  m: Record<string, number | null>;
}

export interface Result { rows: Row[]; truncated: boolean }
export type Reader = (q: Query) => Promise<Result>;

export const CACHE_MIN_AGE_DAYS = 4;

const num = (v: string | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function requestBody(q: Query): Record<string, unknown> {
  if (q.ranges.length < 1 || q.ranges.length > 4) throw new Error("A query needs one to four date ranges.");
  return {
    dateRanges: q.ranges.map((w, i) => ({ startDate: w.start, endDate: w.end, name: `r${i}` })),
    dimensions: q.dims.map((name) => ({ name })),
    metrics: q.metrics.map((name) => ({ name })),
    ...(q.orderBy ? { orderBys: [{ metric: { metricName: q.orderBy }, desc: true }] } : {}),
    ...(q.filter ? { dimensionFilter: q.filter } : {}),
    keepEmptyRows: false,
  };
}

interface GaRow { dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }
interface GaReport { dimensionHeaders?: Array<{ name?: string }>; metricHeaders?: Array<{ name?: string }>; rows?: GaRow[] }

/** The dateRange dimension GA4 adds when there is more than one range, found by its header, not its position. */
export function parseRows(report: unknown, q: Query): Row[] {
  const r = (report ?? {}) as GaReport;
  const dimNames = (r.dimensionHeaders ?? []).map((h) => String(h.name ?? ""));
  const rangeAt = dimNames.indexOf("dateRange");
  const metricNames = (r.metricHeaders ?? []).map((h) => String(h.name ?? ""));
  const out: Row[] = [];
  for (const row of r.rows ?? []) {
    const dv = (row.dimensionValues ?? []).map((d) => String(d.value ?? ""));
    let range = 0;
    if (rangeAt >= 0) {
      const name = dv[rangeAt] ?? "";
      const m = /^r(\d)$/.exec(name);
      if (!m) continue;
      range = Number(m[1]);
    }
    const dims = dv.filter((_, i) => i !== rangeAt).slice(0, q.dims.length);
    const m: Record<string, number | null> = {};
    q.metrics.forEach((name) => {
      const i = metricNames.indexOf(name);
      m[name] = i >= 0 ? num(row.metricValues?.[i]?.value) : null;
    });
    out.push({ dims, range, m });
  }
  return out;
}

export interface ReaderOptions {
  io: Io;
  today: string;
  cacheDir?: string;
  /** Counts requests actually sent, for the run's own report. */
  stats?: { sent: number; cached: number };
}

const hashOf = (property: string, body: unknown) => createHash("sha256").update(property).update(JSON.stringify(body)).digest("hex").slice(0, 32);

/** A cache is only read or written when every range ended long enough ago for the numbers to have settled. */
export function cacheable(q: Query, today: string): boolean {
  const limit = addDays(today, -CACHE_MIN_AGE_DAYS);
  return q.ranges.every((w) => w.end <= limit);
}

export function ga4Reader(opt: ReaderOptions): Reader {
  const stats = opt.stats ?? { sent: 0, cached: 0 };
  return async (q) => {
    const body = requestBody(q);
    const file = opt.cacheDir && cacheable(q, opt.today) ? join(opt.cacheDir, `${hashOf(opt.io.property, body)}.json`) : null;
    if (file && existsSync(file)) {
      try {
        const hit = JSON.parse(readFileSync(file, "utf8")) as Result;
        stats.cached++;
        return hit;
      } catch { /* a bad cache file is simply asked again */ }
    }
    const paged = await postAll(opt.io, body, `GA4 audit (${q.dims.join(",") || "totals"})`);
    stats.sent++;
    const result: Result = { rows: parseRows(paged.report, q), truncated: paged.truncated };
    if (file && !result.truncated) {
      mkdirSync(opt.cacheDir!, { recursive: true });
      writeFileSync(file, JSON.stringify(result));
    }
    return result;
  };
}

/* ───────────── helpers over rows ───────────── */

/** Metric totals per range, summed over whatever dimensions the query had. */
export function totalsByRange(rows: readonly Row[], metrics: readonly string[], ranges: number): Array<Record<string, number | null>> {
  const out: Array<Record<string, number | null>> = Array.from({ length: ranges }, () => Object.fromEntries(metrics.map((m) => [m, null])));
  for (const r of rows) {
    for (const m of metrics) {
      const v = r.m[m];
      if (v == null) continue;
      out[r.range]![m] = (out[r.range]![m] ?? 0) + v;
    }
  }
  return out;
}

/** One map per range from a joined key to a metric record. */
export function keyed(rows: readonly Row[], keyOf: (d: string[]) => string, _ranges: 3): [Map<string, Record<string, number | null>>, Map<string, Record<string, number | null>>, Map<string, Record<string, number | null>>] {
  const out: [Map<string, Record<string, number | null>>, Map<string, Record<string, number | null>>, Map<string, Record<string, number | null>>] = [new Map(), new Map(), new Map()];
  for (const r of rows) {
    const k = keyOf(r.dims);
    const slot = out[r.range as 0 | 1 | 2];
    if (!slot) continue;
    const cur = slot.get(k) ?? {};
    for (const [m, v] of Object.entries(r.m)) cur[m] = v == null ? (cur[m] ?? null) : (cur[m] ?? 0) + v;
    slot.set(k, cur);
  }
  return out;
}

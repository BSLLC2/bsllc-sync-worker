/**
 * Anomaly flags in both directions, and a cautious projection.
 *
 * Weekly series (Monday to Sunday, complete weeks only). A week is flagged when it
 * sits outside a band around the median of the eight weeks before it. A step change is
 * the single split of the series that shifts its mean most, reported only when both
 * sides are long enough. A flag says WHERE a figure moved. It never says why.
 *
 * Every threshold below is ours and is printed with the result.
 */
import { addDays } from "../page-behaviour/paths.js";
import { weekStart } from "./periods.js";

export const BAND = 0.35;
export const TRAILING_WEEKS = 8;
export const MIN_LEVEL = 20;
export const STEP_MIN_SEGMENT_WEEKS = 6;
export const STEP_MIN_SHIFT = 0.25;
export const PROJECTION_MIN_CLEAN_MONTHS = 24;

export interface Week { start: string; value: number }

/** Daily values to complete weeks. A partial first or last week is dropped. */
export function toWeeks(days: ReadonlyMap<string, number>, firstDay: string, lastDay: string): Week[] {
  const out = new Map<string, number>();
  for (const [d, v] of days) { if (d < firstDay || d > lastDay) continue; const w = weekStart(d); out.set(w, (out.get(w) ?? 0) + v); }
  return [...out.entries()].filter(([w]) => w >= weekStart(firstDay) && addDays(w, 6) <= lastDay).sort((a, b) => a[0].localeCompare(b[0])).map(([start, value]) => ({ start, value })).filter((w) => w.start >= firstDay);
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export interface Flag { week: string; value: number; expected: number; deviation: number; direction: "up" | "down" }

export function flagWeeks(weeks: readonly Week[]): Flag[] {
  const out: Flag[] = [];
  for (let i = TRAILING_WEEKS; i < weeks.length; i++) {
    const base = median(weeks.slice(i - TRAILING_WEEKS, i).map((w) => w.value));
    if (base < MIN_LEVEL) continue;
    const dev = (weeks[i]!.value - base) / base;
    if (Math.abs(dev) >= BAND) out.push({ week: weeks[i]!.start, value: weeks[i]!.value, expected: base, deviation: dev, direction: dev > 0 ? "up" : "down" });
  }
  return out;
}

export interface Step { before: string; after: string; meanBefore: number; meanAfter: number; shift: number; direction: "up" | "down" }

/** The one split that moves the mean most, or null when no split is long enough or big enough. */
export function stepChange(weeks: readonly Week[]): Step | null {
  let best: Step | null = null;
  for (let i = STEP_MIN_SEGMENT_WEEKS; i <= weeks.length - STEP_MIN_SEGMENT_WEEKS; i++) {
    const a = weeks.slice(0, i), b = weeks.slice(i);
    const ma = a.reduce((n, w) => n + w.value, 0) / a.length, mb = b.reduce((n, w) => n + w.value, 0) / b.length;
    if (ma < MIN_LEVEL && mb < MIN_LEVEL) continue;
    const shift = ma === 0 ? 0 : (mb - ma) / ma;
    if (Math.abs(shift) < STEP_MIN_SHIFT) continue;
    if (!best || Math.abs(shift) > Math.abs(best.shift)) best = { before: a[a.length - 1]!.start, after: b[0]!.start, meanBefore: ma, meanAfter: mb, shift, direction: shift > 0 ? "up" : "down" };
  }
  return best;
}

export interface Projection { ok: boolean; reason: string; low: number | null; high: number | null; months: number }

/**
 * A range for the next complete month, only with at least PROJECTION_MIN_CLEAN_MONTHS
 * clean months. The range is last year's same month times the lowest and highest
 * year-on-year ratio seen across clean months. It is a projection, not a forecast, and it says so.
 */
export function project(cleanMonths: ReadonlyMap<string, number>, nextMonth: string): Projection {
  const keys = [...cleanMonths.keys()].sort();
  if (keys.length < PROJECTION_MIN_CLEAN_MONTHS) return { ok: false, reason: `Only ${keys.length} clean complete months are available and a projection needs ${PROJECTION_MIN_CLEAN_MONTHS}. The months from Nov 2025 to Aug 2026 are left out because of the automated traffic, which breaks the run of clean history. No projection is given.`, low: null, high: null, months: keys.length };
  const ratios: number[] = [];
  for (const k of keys) { const prev = `${Number(k.slice(0, 4)) - 1}${k.slice(4)}`; const a = cleanMonths.get(k), b = cleanMonths.get(prev); if (a != null && b != null && b > 0) ratios.push(a / b); }
  const lastYear = cleanMonths.get(`${Number(nextMonth.slice(0, 4)) - 1}${nextMonth.slice(4)}`);
  if (ratios.length < 6 || lastYear == null) return { ok: false, reason: "There is no clean same month last year, or fewer than six year-on-year pairs, so no range can be given.", low: null, high: null, months: keys.length };
  return { ok: true, reason: `A range for ${nextMonth}: last year's figure for that month times the lowest and highest year-on-year ratio across ${ratios.length} clean pairs. It is a projection from past ratios, not a forecast.`, low: Math.round(lastYear * Math.min(...ratios)), high: Math.round(lastYear * Math.max(...ratios)), months: keys.length };
}

/**
 * Windows and periods. Everything is UTC and plain YYYY-MM-DD strings.
 *
 * The report runs for ANY window. For the window asked for it works out two
 * comparison periods: the period of the same length straight before it, and the
 * same calendar dates one year earlier. A window may touch the stretch the bot
 * flood ran through; `touches()` says so, and the report warns instead of
 * pretending the comparison is clean.
 */
import { addDays } from "../page-behaviour/paths.js";

export interface Window {
  start: string;
  end: string;
  /**
   * A comparison range the person chose. When set it REPLACES "the period of the same length
   * straight before"; the same dates a year earlier is still worked out. Never part of a request.
   */
  compare?: { start: string; end: string };
}
export interface Periods { current: Window; prior: Window; priorYear: Window }

export const isYmd = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Days in the window, both ends counted. */
export function daysIn(w: Window): number {
  return Math.round((Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The same calendar date one year earlier; 29 February becomes 28 February. */
export function yearEarlier(ymd: string): string {
  const y = Number(ymd.slice(0, 4)) - 1;
  const md = ymd.slice(5);
  return md === "02-29" ? `${y}-02-28` : `${y}-${md}`;
}

/** A reason a chosen comparison range cannot be used, or null. It may not overlap the window: a day in both would be counted on both sides. */
export function compareProblem(w: Window): string | null {
  const c = w.compare;
  if (!c) return null;
  if (!isYmd(c.start) || !isYmd(c.end)) return "The comparison range needs two real dates (YYYY-MM-DD).";
  if (c.start > c.end) return "The comparison range starts after it ends.";
  if (c.start <= w.end && w.start <= c.end) return "The comparison range overlaps the window, so some days would be counted on both sides.";
  return null;
}

/** How a sentence names the comparison period. */
export const priorName = (w: Window): string => (w.compare ? "the comparison period" : "the period before");

export const hasCustomCompare = (w: Window): boolean => !!w.compare;

/** The window without its comparison range: what a request is built from. */
export const plain = (w: Window): Window => ({ start: w.start, end: w.end });

export function periodsFor(w: Window): Periods {
  const n = daysIn(w);
  const priorEnd = addDays(w.start, -1);
  const bad = compareProblem(w);
  if (bad) throw new Error(bad);
  return {
    current: plain(w),
    prior: w.compare ? { start: w.compare.start, end: w.compare.end } : { start: addDays(priorEnd, -(n - 1)), end: priorEnd },
    priorYear: { start: yearEarlier(w.start), end: yearEarlier(w.end) },
  };
}

/** Whether two windows share at least one day. */
export const touches = (a: Window, b: Window): boolean => a.start <= b.end && b.start <= a.end;

export const inWindow = (day: string, w: Window): boolean => day >= w.start && day <= w.end;

/** The default window: 1 January of the end date's year to the end date. */
export function defaultWindow(today: string, lagDays: number): Window {
  const end = addDays(today, -lagDays);
  return { start: `${end.slice(0, 4)}-01-01`, end };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Jan 1 to Sep 30, 2026" for a window. */
export function label(w: Window): string {
  const f = (s: string) => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8, 10))}`;
  const ys = w.start.slice(0, 4), ye = w.end.slice(0, 4);
  return ys === ye ? `${f(w.start)} to ${f(w.end)}, ${ye}` : `${f(w.start)}, ${ys} to ${f(w.end)}, ${ye}`;
}

/** First and last day of every complete calendar month inside the window. */
export function completeMonths(w: Window): string[] {
  const out: string[] = [];
  let y = Number(w.start.slice(0, 4)), m = Number(w.start.slice(5, 7));
  if (w.start.slice(8, 10) !== "01") { m += 1; if (m === 13) { m = 1; y += 1; } }
  for (let guard = 0; guard < 240; guard++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    const first = `${key}-01`;
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (last > w.end) break;
    if (first >= w.start) out.push(key);
    m += 1; if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

export const monthRange = (key: string): Window => ({ start: `${key}-01`, end: new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).toISOString().slice(0, 10) });

/** Monday of the ISO week that holds `day`. */
export function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}

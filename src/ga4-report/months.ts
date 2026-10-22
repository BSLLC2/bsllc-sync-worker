/**
 * The read window and month arithmetic. Everything is UTC and plain strings.
 *
 * The window is the last N COMPLETE calendar months plus the days of the current
 * month up to `today - lag`. The newest month can therefore be part of a month, and
 * the run records `last_day` so the dashboard can tell.
 */
import { addDays } from "../page-behaviour/paths.js";
import { GA4_LAG_DAYS, MAX_MONTHS } from "./types.js";

const pad = (n: number) => String(n).padStart(2, "0");

export interface ReadWindow { start: string; end: string }

export function readWindow(today: string, months: number, lagDays: number = GA4_LAG_DAYS): ReadWindow | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m) return null;
  const n = Math.max(1, Math.min(MAX_MONTHS, Math.floor(months) || 1));
  let y = Number(m[1]), mo = Number(m[2]) - n;
  while (mo < 1) { mo += 12; y -= 1; }
  const start = `${y}-${pad(mo)}-01`;
  const end = addDays(today, -lagDays);
  return end < start ? null : { start, end };
}

/** "202607" is "2026-07"; anything else is null. */
export function monthFromYearMonth(v: string | undefined): string | null {
  const m = /^(\d{4})(0[1-9]|1[0-2])$/.exec(String(v ?? "").trim());
  return m ? `${m[1]}-${m[2]}` : null;
}

/** "20260714" is "2026-07-14"; a date that is not a real calendar day is null. */
export function dayFromGa4Date(v: string | undefined): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

export const monthOf = (day: string): string => day.slice(0, 7);

/** Every month from the one holding `start` to the one holding `end`, oldest first. */
export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let y = Number(start.slice(0, 4)), mo = Number(start.slice(5, 7));
  const last = end.slice(0, 7);
  for (let guard = 0; guard < 120; guard++) {
    const key = `${y}-${pad(mo)}`;
    if (key > last) break;
    out.push(key);
    mo += 1;
    if (mo === 13) { mo = 1; y += 1; }
  }
  return out;
}

/** Every day from `start` to `end` inclusive. */
export function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start, guard = 0; d <= end && guard < 2000; d = addDays(d, 1), guard++) out.push(d);
  return out;
}

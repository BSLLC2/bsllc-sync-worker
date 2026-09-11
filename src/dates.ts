/**
 * Date helpers for the trailing-window model.
 *
 * The dashboard's trend engine (storage.getMetricTrend) picks each comparison
 * snapshot by `synced_at`, NOT by period_end. So a historical backfill must
 * emit one entry per weekly as-of date D with synced_at = D — otherwise every
 * row lands at "now" and no week/month/quarter deltas ever appear.
 */

/** Trailing window length, in days, that each snapshot summarises. */
export const WINDOW_DAYS = 30;

/** New Date shifted by whole days (UTC), without mutating the input. */
export function shiftDays(d: Date, deltaDays: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + deltaDays);
  return out;
}

/** 'YYYY-MM-DD' in UTC — the form GAQL's segments.date expects. */
export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Weekly as-of dates for the backfill, newest first: [today, today-7, ...].
 * Insert order does not matter — the reader sorts by synced_at — so we keep it
 * simple. Time-of-day is preserved so successive weeks are cleanly distinct.
 */
export function weeklyAsOfDates(weeks: number, today: Date): Date[] {
  const out: Date[] = [];
  for (let i = 0; i < weeks; i++) out.push(shiftDays(today, -i * 7));
  return out;
}

/**
 * The reporting window that ends at as-of date D: query dates run D-29..D
 * (30 days inclusive), while period_start is recorded as D-30d so the stored
 * window reads as a clean 30-day span.
 */
export function windowFor(asOf: Date): {
  queryStart: string;
  queryEnd: string;
  periodStart: Date;
  periodEnd: Date;
} {
  return {
    queryStart: ymd(shiftDays(asOf, -(WINDOW_DAYS - 1))),
    queryEnd: ymd(asOf),
    periodStart: shiftDays(asOf, -WINDOW_DAYS),
    periodEnd: asOf,
  };
}

export interface Window { queryStart: string; queryEnd: string; periodStart: Date; periodEnd: Date; label: string }

/**
 * Calendar-month windows the daily pull also records alongside the trailing
 * 30 days: the month to date (period_start = the 1st, so the dashboard's
 * month-by-month table gets a real current-month cell instead of the rolling
 * window's start-month bucket), plus the just-finished month for the first
 * `finalizeDays` days after it closes so its final figure lands once the
 * platform has settled.
 */
export function calendarWindows(asOf: Date, finalizeDays = 5): Window[] {
  const y = asOf.getUTCFullYear();
  const m = asOf.getUTCMonth();
  const monthStart = new Date(Date.UTC(y, m, 1));
  const out: Window[] = [{ queryStart: ymd(monthStart), queryEnd: ymd(asOf), periodStart: monthStart, periodEnd: asOf, label: "month-to-date" }];
  if (asOf.getUTCDate() <= finalizeDays) {
    const prevStart = new Date(Date.UTC(y, m - 1, 1));
    const prevEnd = new Date(Date.UTC(y, m, 0));
    out.push({ queryStart: ymd(prevStart), queryEnd: ymd(prevEnd), periodStart: prevStart, periodEnd: prevEnd, label: "previous month" });
  }
  return out;
}

/**
 * Calendar-month snapshot bounds for a "YYYY-MM" (or "YYYYMM") key, shared by
 * every monthly importer (GA4, Search Console, D365, HubSpot) so their rows
 * line up and none of them can stamp the future.
 *
 * The in-progress month is capped at today: capping at the calendar month's
 * last day used to stamp period_end/synced_at weeks ahead, which the Data
 * health page reads as "Bad timestamp (future)" and which then out-ranks
 * every later, correct row in "latest reading" picks. Finished months keep
 * their real end date and a noon-UTC synced_at on that date (a backfill must
 * backdate synced_at so trend windows land). The in-progress month gets
 * synced_at = now: noon of today is still up to 12h in the future for the
 * 07:xx UTC crons, enough to trip the future-timestamp check every morning.
 */
export function monthSnapshot(ymKey: string, now = new Date()): { start: string; end: string; syncedAt: string } {
  const ym = ymKey.length === 6 ? `${ymKey.slice(0, 4)}-${ymKey.slice(4, 6)}` : ymKey;
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEnd = `${ym}-${String(last).padStart(2, "0")}`;
  const today = ymd(now);
  const end = monthEnd > today ? today : monthEnd;
  return { start: `${ym}-01`, end, syncedAt: end < today ? `${end}T12:00:00.000Z` : now.toISOString() };
}

/**
 * Search Console only keeps ~16 months of data. Asking for anything older
 * returns a 400, which used to fail the whole GSC backfill and leave an
 * "error" row newer than every good one — so connector health then read the
 * source as failing (see `isConnectorFailing`'s rule). A contract start older
 * than the window (OCH, Aug 2024) is clamped to it instead.
 *
 * The floor is today minus 16 months, plus one day: the oldest date the API
 * will still answer for.
 */
export const GSC_RETENTION_MONTHS = 16;

export function gscRetentionFloor(now = new Date()): string {
  const floor = new Date(now);
  floor.setUTCMonth(floor.getUTCMonth() - GSC_RETENTION_MONTHS);
  floor.setUTCDate(floor.getUTCDate() + 1);
  return ymd(floor);
}

/** The `--since` to actually query, and whether it had to be clamped. */
export function clampSinceToGscRetention(since: string, now = new Date()): { since: string; clamped: boolean; floor: string } {
  const floor = gscRetentionFloor(now);
  return since < floor ? { since: floor, clamped: true, floor } : { since, clamped: false, floor };
}

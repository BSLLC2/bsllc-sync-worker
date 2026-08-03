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

/**
 * A zero is only a zero when the thing counting was switched on.
 *
 * An analytics property answers "how many key events last month?" with 0 in
 * two completely different situations: nobody converted, and nobody ever
 * configured a key event. The API cannot tell you which, and a tile reading
 * "0 conversions · live" reads as poor performance either way — a client's
 * form posted nine real submissions to our own webhook in a fortnight while
 * their property reported zero, because there was no key event on it to fire.
 *
 * The one piece of positive evidence available without asking a second API is
 * the property's OWN history: if it has ever reported a non-zero figure for
 * that metric, it is configured to report it, and a zero month is a real
 * zero. If it has never reported anything, we have no evidence it reports the
 * metric at all, and the honest value is "no data" — not zero.
 *
 * This corrects itself. The importer re-reads the whole window every run, so
 * the first time a key event fires, every earlier month in that window
 * re-plants as a genuine live zero on the next run. Nothing is lost, and
 * nothing has to be backfilled by hand.
 *
 * (The GA4 Admin API would answer "is a key event configured" directly. It is
 * deliberately not used: it needs its own grant on every property, it adds a
 * failure mode to an importer that currently has one, and it would still say
 * "configured" for a property whose only key event has never fired — which is
 * the case this rule already handles correctly within a run or two.)
 *
 * Pure. Verified by `npm run verify-zero-vs-nothing`.
 */

/** Has this property ever reported this metric at all, anywhere in the window
 *  we pulled? One non-zero figure is enough. */
export function reportsMetric(windowValues: Array<number | null | undefined>): boolean {
  return windowValues.some((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
}

/**
 * The value to plant for one period, given what the whole window shows.
 *
 * `null` is not "drop it" — the dashboard's sync turns a null inside a live
 * entry into a `no_data` row for that one metric key (server/sync.ts), which
 * is exactly the distinction wanted: the run happened, the metric has nothing
 * behind it. Omitting the key entirely would leave no row at all, which reads
 * as "never imported" and is the bug in the other direction.
 */
export function evidencedMetric(value: number, windowValues: Array<number | null | undefined>): number | null {
  if (!Number.isFinite(value)) return null;
  if (value > 0) return value;
  return reportsMetric(windowValues) ? value : null;
}

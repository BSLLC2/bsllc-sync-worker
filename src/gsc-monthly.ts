/**
 * Bucketing Search Console's daily rows into calendar months.
 *
 * Extracted from import-gsc-api.ts so it can be tested: that file calls main()
 * on import, so anything inside it is unreachable from a test.
 */

export interface DayRow { date: string; clicks: number; impressions: number; position: number }
export interface MonthBucket { clicks: number; impressions: number; posWeighted: number }

/**
 * Sums daily rows into calendar months. Clicks/impressions add directly;
 * position is impressions-weighted (not a naive average of daily averages) so a
 * high-traffic day's ranking counts more than a near-zero-traffic one — the same
 * principle CTR already gets by being recomputed from the summed totals rather
 * than averaged.
 */
export function bucketMonthly(rows: DayRow[]): Map<string, MonthBucket> {
  const m = new Map<string, MonthBucket>();
  for (const r of rows) {
    const ym = r.date.slice(0, 7);
    const cur = m.get(ym) ?? { clicks: 0, impressions: 0, posWeighted: 0 };
    cur.clicks += r.clicks;
    cur.impressions += r.impressions;
    cur.posWeighted += r.position * r.impressions;
    m.set(ym, cur);
  }
  return m;
}

/** The average position to store for a month: impressions-weighted, or null
 *  when the month had no impressions at all (dividing would be 0/0). */
export function monthAvgPosition(b: MonthBucket): number | null {
  return b.impressions > 0 ? b.posWeighted / b.impressions : null;
}

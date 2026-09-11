/**
 * src/gsc-monthly.ts — daily Search Console rows → one snapshot per calendar
 * month.
 *
 * The thing worth holding is that average position is IMPRESSIONS-WEIGHTED. A
 * naive average of daily averages lets a day with three impressions at
 * position 2 outweigh a day with three thousand at position 20, which makes a
 * client's search position look far better than it is on the one number they
 * look at.
 */
import { describe, it, expect } from "vitest";
import { bucketMonthly, monthAvgPosition, type DayRow } from "../src/gsc-monthly.js";

const day = (date: string, clicks: number, impressions: number, position: number): DayRow => ({ date, clicks, impressions, position });

describe("bucketMonthly", () => {
  it("sums clicks and impressions into the right calendar month", () => {
    const m = bucketMonthly([
      day("2026-08-30", 5, 100, 10),
      day("2026-08-31", 7, 200, 12),
      day("2026-09-01", 2, 50, 8),
    ]);
    expect(Array.from(m.keys()).sort()).toEqual(["2026-08", "2026-09"]);
    expect(m.get("2026-08")).toMatchObject({ clicks: 12, impressions: 300 });
    expect(m.get("2026-09")).toMatchObject({ clicks: 2, impressions: 50 });
  });

  it("weights average position by impressions, not by day", () => {
    // One great day with 3 impressions, one ordinary day with 3,000.
    const m = bucketMonthly([day("2026-08-01", 1, 3, 2), day("2026-08-02", 40, 3_000, 20)]);
    const avg = monthAvgPosition(m.get("2026-08")!)!;
    const naiveDailyAverage = (2 + 20) / 2;
    expect(avg).toBeCloseTo((2 * 3 + 20 * 3_000) / 3_003, 6);
    expect(avg).toBeCloseTo(19.98, 2);
    // The naive average would claim position 11 on a month that really sat at 20.
    expect(avg).toBeGreaterThan(naiveDailyAverage);
  });

  it("returns no position for a month with no impressions, rather than 0", () => {
    // Position 0 would render as the best possible ranking on the client's card.
    const m = bucketMonthly([day("2026-08-01", 0, 0, 0)]);
    expect(monthAvgPosition(m.get("2026-08")!)).toBeNull();
  });

  it("handles an empty day list", () => {
    expect(bucketMonthly([]).size).toBe(0);
  });

  it("buckets by the date string, so a timezone can never move a day into the wrong month", () => {
    // The suite runs at America/New_York; 2026-09-01 read as a local instant is
    // 2026-08-31. The bucket key must come from the string.
    const m = bucketMonthly([day("2026-09-01", 1, 10, 5)]);
    expect(Array.from(m.keys())).toEqual(["2026-09"]);
  });

  it("keeps months separate across a year boundary", () => {
    const m = bucketMonthly([day("2026-12-31", 1, 10, 5), day("2027-01-01", 2, 20, 6)]);
    expect(Array.from(m.keys()).sort()).toEqual(["2026-12", "2027-01"]);
  });

  it("adds up a full month of days without drift", () => {
    const rows: DayRow[] = [];
    for (let d = 1; d <= 31; d++) rows.push(day(`2026-08-${String(d).padStart(2, "0")}`, 1, 100, 10));
    const b = bucketMonthly(rows).get("2026-08")!;
    expect(b.clicks).toBe(31);
    expect(b.impressions).toBe(3_100);
    expect(monthAvgPosition(b)).toBeCloseTo(10, 10);
  });
});

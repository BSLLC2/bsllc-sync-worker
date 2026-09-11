/**
 * src/dates.ts — the window and snapshot maths every importer shares.
 *
 * Two of these have caused real incidents:
 *
 *  - The in-progress month used to be stamped at the calendar month's LAST day,
 *    so period_end and synced_at landed weeks in the future. The Data health
 *    page reads that as "Bad timestamp (future)", and worse, a future synced_at
 *    out-ranks every later, correct row in a "latest reading" pick — so a stale
 *    number kept winning. monthSnapshot caps the in-progress month at today.
 *  - A GSC backfill asked for a date older than Search Console's ~16-month
 *    retention, got a 400, failed the whole run, and left an `error` row newer
 *    than every good one — which made connector health call the source failing
 *    until somebody noticed.
 */
import { describe, it, expect } from "vitest";
import {
  ymd, shiftDays, weeklyAsOfDates, windowFor, calendarWindows, monthSnapshot,
  gscRetentionFloor, clampSinceToGscRetention, WINDOW_DAYS, GSC_RETENTION_MONTHS,
} from "../src/dates.js";

const at = (iso: string) => new Date(iso);

describe("monthSnapshot — the in-progress month can never stamp the future", () => {
  const NOW = at("2026-09-11T07:20:00.000Z"); // a 07:xx UTC cron, mid-month

  it("caps the CURRENT month at today, not at the month's last day", () => {
    const s = monthSnapshot("2026-09", NOW);
    expect(s.start).toBe("2026-09-01");
    expect(s.end).toBe("2026-09-11");
    expect(s.end).not.toBe("2026-09-30");
  });

  it("stamps the current month's synced_at at NOW, never at a future noon", () => {
    const s = monthSnapshot("2026-09", NOW);
    expect(s.syncedAt).toBe(NOW.toISOString());
    // Noon today is up to 12h ahead for an 07:xx cron — enough to trip the
    // future-timestamp check every single morning.
    expect(s.syncedAt).not.toBe("2026-09-11T12:00:00.000Z");
    expect(new Date(s.syncedAt).getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it("never returns an end or a synced_at after now, for any month of the year", () => {
    for (let m = 1; m <= 12; m++) {
      const s = monthSnapshot(`2026-${String(m).padStart(2, "0")}`, NOW);
      expect(s.end <= ymd(NOW), `${s.end} must not be after today`).toBe(true);
      expect(new Date(s.syncedAt).getTime(), `month ${m} synced_at is in the future`).toBeLessThanOrEqual(NOW.getTime());
    }
  });

  it("keeps a finished month's real end date and backdates synced_at to noon that day", () => {
    const s = monthSnapshot("2026-08", NOW);
    expect(s.start).toBe("2026-08-01");
    expect(s.end).toBe("2026-08-31");
    // A backfill MUST backdate synced_at or every row lands at "now" and the
    // dashboard's week/month/quarter deltas never appear.
    expect(s.syncedAt).toBe("2026-08-31T12:00:00.000Z");
  });

  it("gets each month's length right, leap years included", () => {
    expect(monthSnapshot("2026-02", at("2026-12-31T00:00:00Z")).end).toBe("2026-02-28");
    expect(monthSnapshot("2024-02", at("2026-12-31T00:00:00Z")).end).toBe("2024-02-29");
    expect(monthSnapshot("2026-04", at("2026-12-31T00:00:00Z")).end).toBe("2026-04-30");
    expect(monthSnapshot("2026-12", at("2027-06-01T00:00:00Z")).end).toBe("2026-12-31");
  });

  it("accepts the compact YYYYMM key some importers pass", () => {
    expect(monthSnapshot("202608", NOW)).toEqual(monthSnapshot("2026-08", NOW));
  });

  it("treats the last day of the in-progress month as finished only once it is past", () => {
    const onTheLast = monthSnapshot("2026-09", at("2026-09-30T07:00:00Z"));
    expect(onTheLast.end).toBe("2026-09-30");
    // Still the current day → synced_at is now, not a backdated noon.
    expect(onTheLast.syncedAt).toBe("2026-09-30T07:00:00.000Z");
    const nextDay = monthSnapshot("2026-09", at("2026-10-01T07:00:00Z"));
    expect(nextDay.end).toBe("2026-09-30");
    expect(nextDay.syncedAt).toBe("2026-09-30T12:00:00.000Z");
  });

  it("is unaffected by the machine's timezone", () => {
    // Everything here goes through toISOString, i.e. UTC. The suite runs at
    // America/New_York, where a naive local read of 2026-09-01T00:00 is
    // 2026-08-31 — so these answers would shift if any of it used local parts.
    expect(monthSnapshot("2026-09", at("2026-09-01T03:00:00Z")).start).toBe("2026-09-01");
    expect(monthSnapshot("2026-09", at("2026-09-01T03:00:00Z")).end).toBe("2026-09-01");
    expect(ymd(at("2026-09-01T03:00:00Z"))).toBe("2026-09-01");
  });
});

describe("Search Console's 16-month retention clamp", () => {
  const NOW = at("2026-09-11T07:20:00.000Z");

  it("puts the floor 16 months back, plus a day", () => {
    expect(GSC_RETENTION_MONTHS).toBe(16);
    expect(gscRetentionFloor(NOW)).toBe("2025-05-12");
  });

  it("clamps a contract start older than the window and says it clamped", () => {
    // OCH's contract start, Aug 2024 — the one that failed the whole backfill.
    const r = clampSinceToGscRetention("2024-08-01", NOW);
    expect(r.clamped).toBe(true);
    expect(r.since).toBe("2025-05-12");
    expect(r.floor).toBe("2025-05-12");
  });

  it("leaves a date inside the window alone", () => {
    const r = clampSinceToGscRetention("2026-01-01", NOW);
    expect(r.clamped).toBe(false);
    expect(r.since).toBe("2026-01-01");
  });

  it("holds the boundary exactly: the floor itself is allowed, a day earlier is not", () => {
    expect(clampSinceToGscRetention("2025-05-12", NOW).clamped).toBe(false);
    expect(clampSinceToGscRetention("2025-05-11", NOW).clamped).toBe(true);
  });

  it("never returns a since older than the floor, whatever it is given", () => {
    for (const since of ["1999-01-01", "2020-06-30", "2025-05-11", "2025-05-12", "2026-09-10"]) {
      const r = clampSinceToGscRetention(since, NOW);
      expect(r.since >= r.floor, `${since} → ${r.since} is before the floor`).toBe(true);
    }
  });

  it("moves the floor with the clock, so the window stays 16 months", () => {
    expect(gscRetentionFloor(at("2026-01-15T00:00:00Z"))).toBe("2024-09-16");
    expect(gscRetentionFloor(at("2026-03-31T00:00:00Z"))).toBe("2024-12-02"); // Nov 31 → Dec 1, +1 day
  });
});

describe("trailing windows", () => {
  it("runs a 30-day inclusive query window and records period_start a day earlier", () => {
    const w = windowFor(at("2026-09-11T00:00:00Z"));
    expect(WINDOW_DAYS).toBe(30);
    expect(w.queryStart).toBe("2026-08-13");
    expect(w.queryEnd).toBe("2026-09-11");
    // 13 Aug → 11 Sep inclusive is exactly 30 days.
    expect((Date.parse(w.queryEnd) - Date.parse(w.queryStart)) / 86_400_000 + 1).toBe(30);
    expect(ymd(w.periodStart)).toBe("2026-08-12");
  });

  it("walks the backfill's as-of dates back a week at a time, newest first", () => {
    const d = weeklyAsOfDates(4, at("2026-09-11T10:00:00Z")).map(ymd);
    expect(d).toEqual(["2026-09-11", "2026-09-04", "2026-08-28", "2026-08-21"]);
  });

  it("keeps the time of day so successive weeks stay distinct", () => {
    const d = weeklyAsOfDates(2, at("2026-09-11T10:30:00Z"));
    expect(d[0]!.toISOString()).toBe("2026-09-11T10:30:00.000Z");
    expect(d[1]!.toISOString()).toBe("2026-09-04T10:30:00.000Z");
  });

  it("shifts days without mutating its input, across a month and a year", () => {
    const d = at("2026-09-01T00:00:00Z");
    expect(ymd(shiftDays(d, -1))).toBe("2026-08-31");
    expect(ymd(d)).toBe("2026-09-01"); // unchanged
    expect(ymd(shiftDays(at("2026-12-31T00:00:00Z"), 1))).toBe("2027-01-01");
  });
});

describe("calendar windows the daily pull records alongside the rolling one", () => {
  it("always records the month to date, anchored on the 1st", () => {
    const w = calendarWindows(at("2026-09-11T00:00:00Z"));
    expect(w.map((x) => x.label)).toEqual(["month-to-date"]);
    expect(w[0]!.queryStart).toBe("2026-09-01");
    expect(w[0]!.queryEnd).toBe("2026-09-11");
  });

  it("also finalizes the previous month for the first few days after it closes", () => {
    const w = calendarWindows(at("2026-09-03T00:00:00Z"));
    expect(w.map((x) => x.label)).toEqual(["month-to-date", "previous month"]);
    expect(w[1]!.queryStart).toBe("2026-08-01");
    expect(w[1]!.queryEnd).toBe("2026-08-31");
  });

  it("stops finalizing once the window has passed", () => {
    expect(calendarWindows(at("2026-09-05T00:00:00Z")).length).toBe(2);
    expect(calendarWindows(at("2026-09-06T00:00:00Z")).length).toBe(1);
  });

  it("rolls back into the previous year on the 1st of January", () => {
    const w = calendarWindows(at("2027-01-02T00:00:00Z"));
    expect(w[1]!.queryStart).toBe("2026-12-01");
    expect(w[1]!.queryEnd).toBe("2026-12-31");
  });
});

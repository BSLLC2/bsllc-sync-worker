/**
 * src/audit-jobs.ts and src/job-cadence.ts — the two different questions about
 * "is this job late", and the morning audit's re-run plan.
 *
 *   audit-jobs.staleJobs  → which importer should the 07:00 audit re-run NOW
 *                           (fixed windows, a bit longer than each schedule)
 *   job-cadence           → what freshness SLA a job has, DERIVED from the cron
 *                           lines in .github/workflows so the SLA cannot drift
 *                           from the schedule
 *
 * `--mode=plan` writes staleJobs' steps to $GITHUB_OUTPUT as `rerun=`, so the
 * window being wrong either silently skips a broken importer (nobody learns) or
 * re-runs all fourteen every morning (and the audit stops meaning anything).
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { DAILY, staleJobs, rerunSteps, type Heartbeat } from "../src/audit-jobs.js";
import { cronMaxGapHours, slaFromInterval, deriveJobCadences, IN_SCRIPT_HEARTBEATS } from "../src/job-cadence.js";

const NOW = new Date("2026-09-11T07:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const beat = (job: string, h: number, ok = true): Heartbeat => ({ job, ran_at: hoursAgo(h), ok });
/** Every job healthy, except the ones overridden. */
const allHealthy = (over: Heartbeat[] = []): Heartbeat[] => {
  const base = Object.keys(DAILY).map((job) => beat(job, 1));
  const byJob = new Map(base.map((b) => [b.job, b]));
  for (const b of over) byJob.set(b.job, b);
  return Array.from(byJob.values());
};

describe("the audit's re-run plan", () => {
  it("re-runs nothing when every job succeeded an hour ago", () => {
    expect(staleJobs(allHealthy(), NOW)).toEqual([]);
    expect(rerunSteps(staleJobs(allHealthy(), NOW))).toBe("");
  });

  it("re-runs a job that has never run at all", () => {
    const stale = staleJobs([], NOW);
    expect(stale.length).toBe(Object.keys(DAILY).length);
    expect(rerunSteps(stale).split(",")).toContain("ga4");
  });

  it("re-runs a job whose last run FAILED, however recent", () => {
    const stale = staleJobs(allHealthy([beat("import_ga4", 0.1, false)]), NOW);
    expect(stale.map(([job]) => job)).toEqual(["import_ga4"]);
    expect(rerunSteps(stale)).toBe("ga4");
  });

  it("holds the daily window at 26 hours, so a late start is not 'stale'", () => {
    expect(staleJobs(allHealthy([beat("import_ga4", 25)]), NOW)).toEqual([]);
    expect(staleJobs(allHealthy([beat("import_ga4", 27)]), NOW).map(([j]) => j)).toEqual(["import_ga4"]);
  });

  it("holds the twice-daily window at 14 hours for hubspot_deals", () => {
    expect(DAILY.hubspot_deals!.hours).toBe(14);
    expect(staleJobs(allHealthy([beat("hubspot_deals", 13)]), NOW)).toEqual([]);
    expect(staleJobs(allHealthy([beat("hubspot_deals", 15)]), NOW).map(([j]) => j)).toEqual(["hubspot_deals"]);
  });

  it("holds the weekly jobs at 8 days, so a weekly importer is not re-run daily", () => {
    for (const job of ["seo_import", "aeo_import", "domain_authority_import"]) {
      expect(DAILY[job]!.hours).toBe(8 * 24);
      expect(staleJobs(allHealthy([beat(job, 7 * 24)]), NOW)).toEqual([]);
      expect(staleJobs(allHealthy([beat(job, 9 * 24)]), NOW).map(([j]) => j)).toEqual([job]);
    }
  });

  it("treats an unparseable heartbeat timestamp as stale rather than fresh", () => {
    const stale = staleJobs(allHealthy([{ job: "import_ga4", ran_at: "not a date", ok: true }]), NOW);
    expect(stale.map(([j]) => j)).toEqual(["import_ga4"]);
  });

  it("ignores a heartbeat for a job the audit does not track", () => {
    expect(staleJobs(allHealthy([{ job: "some_other_job", ran_at: hoursAgo(900), ok: false }]), NOW)).toEqual([]);
  });

  it("gives every tracked job a distinct workflow step and a positive window", () => {
    const steps = Object.values(DAILY).map((c) => c.step);
    expect(new Set(steps).size).toBe(steps.length);
    for (const [job, cfg] of Object.entries(DAILY)) {
      expect(cfg.hours, `${job} needs a positive window`).toBeGreaterThan(0);
      expect(cfg.step, `${job} needs a step key`).toBeTruthy();
    }
  });

  it("lists the steps in a form the workflow can split on a comma", () => {
    const stale = staleJobs(allHealthy([beat("import_ga4", 99), beat("import_gsc", 99)]), NOW);
    expect(rerunSteps(stale)).toBe("ga4,gsc");
  });
});

describe("cadence derived from the workflow files", () => {
  const WORKFLOWS = path.resolve(import.meta.dirname, "..", ".github", "workflows");
  // Derived once: deriveJobCadences scans every cron minute-by-minute over a
  // 14-month window, which costs ~2s per call over this many workflows.
  const cadences = deriveJobCadences(WORKFLOWS);

  it("measures the longest gap between firings of a cron, in hours", () => {
    expect(cronMaxGapHours("0 7 * * *")).toBe(24);          // daily
    expect(cronMaxGapHours("0 7,19 * * *")).toBe(12);       // twice daily
    expect(cronMaxGapHours("0 7 * * 1-5")).toBe(72);        // weekdays: the weekend is the gap
    expect(cronMaxGapHours("0 7 * * 1")).toBe(168);         // weekly
  });

  it("returns null for something that is not a 5-field cron", () => {
    expect(cronMaxGapHours("not a cron")).toBeNull();
    expect(cronMaxGapHours("0 7 * *")).toBeNull();
  });

  it("gives an SLA with real slack, never tighter than the interval", () => {
    expect(slaFromInterval(24)).toBe(36);
    expect(slaFromInterval(1)).toBe(3); // 1.5h would be tighter than GitHub's own delays
    for (const h of [0.25, 1, 6, 24, 72, 168]) expect(slaFromInterval(h)).toBeGreaterThan(h);
  });

  it("finds a cadence for every job that stamps a heartbeat, from real workflow files", () => {
    expect(cadences.size).toBeGreaterThan(5);
    for (const [job, c] of cadences) {
      expect(c.workflow, `${job} needs a workflow`).toMatch(/\.ya?ml$/);
      if (c.intervalHours != null) {
        expect(c.slaHours).toBe(slaFromInterval(c.intervalHours));
        expect(c.crons.length).toBeGreaterThan(0);
      } else {
        // On-demand only: no staleness, just success or failure.
        expect(c.slaHours).toBeNull();
      }
    }
  });

  it("derives a cadence for the audit's own in-script heartbeats too", () => {
    const files = new Set(readdirSync(WORKFLOWS));
    for (const [job, wf] of Object.entries(IN_SCRIPT_HEARTBEATS)) {
      expect(files.has(wf), `${wf} is named in IN_SCRIPT_HEARTBEATS but does not exist`).toBe(true);
      expect(cadences.get(job), `${job} should have a derived cadence`).toBeTruthy();
    }
  });

  it("gives the morning audit a weekday cadence, so the weekend is not 'stale'", () => {
    const c = cadences.get("morning_audit");
    expect(c?.workflow).toBe("morning-audit.yml");
    // Weekday-only: the longest gap is Friday → Monday.
    expect(c?.intervalHours).toBe(72);
    expect(c?.slaHours).toBe(108);
  });

  it("covers every audit-tracked importer with a derived cadence as well", () => {
    // The two tables answer different questions but must not disagree about
    // which jobs exist: a job the audit re-runs with no workflow that stamps
    // its heartbeat can never come back healthy.
    const missing = Object.keys(DAILY).filter((job) => !cadences.has(job));
    expect(missing).toEqual([]);
  });
});

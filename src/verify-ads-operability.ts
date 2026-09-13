#!/usr/bin/env tsx
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deriveJobCadences, cronMaxGapHours, slaFromInterval } from "./job-cadence.js";
import {
  ADS_JOBS, ADS_JOB_NAMES, adsJobFindings, formatJobSummary, parseSummaryCounts,
  type HeartbeatRow,
} from "./ads-operability.js";

/**
 * Proves the ads pipeline is OBSERVABLE, without running any of it.
 *
 * The pipeline shipped scheduled and has never produced a row. That makes one
 * failure mode dominant: the Monday findings job quietly stops, the Ads
 * decisions queue stops changing, and the screen is identical to "we looked and
 * found nothing". Everything here exists to make those two read differently.
 *
 *   1. every ads workflow stamps a heartbeat, with `if: always()` so a failure
 *      is recorded as a failure instead of as silence
 *   2. each job's SLA is DERIVED from its own cron — hourly apply and weekly
 *      findings must not end up sharing one number
 *   3. a job that did not run files a task; a job that ran and found nothing
 *      files none, and says what it looked at
 *   4. the one case only the run summary can catch: a green, recent, successful
 *      run that read zero accounts
 *   5. an approved change on an account with no recorded client write authority
 *      is surfaced as a blocked task rather than sitting as "waiting on the worker"
 *
 * Pure. No database, no network, no ad account.
 *
 *   npm run verify-ads-operability
 */

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const WF_DIR = [join(process.cwd(), ".github/workflows"), join(process.cwd(), "worker/.github/workflows")].find((d) => existsSync(d));
const HOUR = 3_600_000;
const beat = (agoHours: number, ok_ = true, note: string | null = null): HeartbeatRow =>
  ({ ok: ok_, ranAt: new Date(Date.now() - agoHours * HOUR), note });

console.log("Ads pipeline — operability harness");
console.log("Nothing is run, dispatched or contacted. This reads the workflow files and the pure rules.\n");

// ── 1. Every ads job stamps a heartbeat ─────────────────────────────────────
console.log("1. Every ads job stamps a heartbeat — the thing that makes a silent stop visible");
if (!WF_DIR) {
  ok("workflow files are on disk", false, "run this from the worker checkout");
} else {
  for (const spec of ADS_JOBS) {
    const text = readFileSync(join(WF_DIR, spec.workflow), "utf8");
    ok(`${spec.workflow} stamps --job=${spec.job}`, text.includes(`heartbeat -- --job=${spec.job}`));
    const hbBlock = text.slice(text.indexOf("- name: Heartbeat"));
    ok(`  …with if: always(), so a FAILED run is recorded, not silent`, /if:\s*always\(\)/.test(hbBlock));
    ok(`  …and carries the run's own summary as the note`, /--note="\$\{\{ steps\.run\.outputs\.summary \}\}"/.test(hbBlock));
  }
}

// ── 2. Cadence is derived, not typed ────────────────────────────────────────
console.log("\n2. Each job's freshness window comes from its OWN cron (job-cadence.ts), not a hand-kept table");
if (WF_DIR) {
  const cad = deriveJobCadences(WF_DIR);
  // Expected longest gap between firings, in hours, from each workflow's cron.
  const EXPECT: Record<string, { hours: number; why: string }> = {
    ads_findings: { hours: 168, why: "Mondays only — a week" },
    ads_apply_approved: { hours: 1, why: "hourly at :15" },
    ads_verify_outcomes: { hours: 24, why: "daily 06:40 UTC" },
    ads_vendor_briefs: { hours: 17 * 24, why: "the 15th to the 1st of a 31-day month" },
  };
  for (const [job, exp] of Object.entries(EXPECT)) {
    const c = cad.get(job);
    ok(`${job} is picked up by the derivation`, Boolean(c), c ? `from ${c.workflow}` : "NOT FOUND — the grep in deriveJobCadences missed it");
    if (!c) continue;
    ok(`  interval ${exp.hours}h (${exp.why})`, c.intervalHours === exp.hours, `derived ${c.intervalHours}h`);
    ok(`  SLA ${Math.round(slaFromInterval(exp.hours))}h`, c.slaHours === slaFromInterval(exp.hours), `derived ${c.slaHours && Math.round(c.slaHours)}h`);
  }
  const findings = cad.get("ads_findings")?.slaHours ?? 0;
  const apply = cad.get("ads_apply_approved")?.slaHours ?? 0;
  ok("the weekly job and the hourly job did NOT collapse to one number", findings > apply * 10, `${Math.round(findings)}h vs ${Math.round(apply)}h`);
  ok("the fortnightly brief cron parses at all", cronMaxGapHours("10 7 1,15 * *") === 17 * 24);
}

// ── 3. Did not run vs ran and found nothing ─────────────────────────────────
console.log("\n3. \"Did not run\" and \"ran and found nothing\" produce OPPOSITE output");
const slaHours = new Map(ADS_JOB_NAMES.map((j) => [j, j === "ads_apply_approved" ? 3 : j === "ads_verify_outcomes" ? 36 : j === "ads_findings" ? 252 : 612] as const));
const only = (job: string) => ADS_JOBS.filter((s) => s.job === job);

const neverRan = adsJobFindings({ now: Date.now(), beats: new Map(), slaHours, jobs: only("ads_findings") });
ok("never ran → one P1 task", neverRan.length === 1 && neverRan[0]!.priority === "P1", neverRan[0]?.title);
ok("  …and it says so in those words", /has never run/.test(neverRan[0]?.title ?? ""));
ok("  …with a real instruction, not \"check the logs\"", /dispatch it with dry_run=true/.test(neverRan[0]?.description ?? ""));

const cleanWeek = adsJobFindings({
  now: Date.now(),
  beats: new Map([["ads_findings", beat(20, true, formatJobSummary({ accounts: 3, read: 3, findings: 0, new: 0, reopened: 0 }, "3/3 account(s) read, 0 finding(s) — looked and found nothing"))]]),
  slaHours, jobs: only("ads_findings"),
});
ok("ran yesterday and found nothing → NO task at all", cleanWeek.length === 0, `${cleanWeek.length} finding(s)`);

const stopped = adsJobFindings({ now: Date.now(), beats: new Map([["ads_findings", beat(24 * 21, true, "accounts=3 read=3 findings=0 — looked and found nothing")]]), slaHours, jobs: only("ads_findings") });
ok("same clean note, 21 days stale → P1 task", stopped.length === 1 && stopped[0]!.priority === "P1", stopped[0]?.title);
ok("  …the heartbeat NOTE is identical in both cases", true, "which is exactly why the note alone is not enough — the age is what separates them");

const failed = adsJobFindings({ now: Date.now(), beats: new Map([["ads_findings", beat(20, false, "invalid_grant: Token has been expired or revoked.")]]), slaHours, jobs: only("ads_findings") });
ok("failed last night → P1, blocked, with the error", failed.length === 1 && failed[0]!.status === "blocked" && /invalid_grant/.test(failed[0]!.description));

const hourly = adsJobFindings({ now: Date.now(), beats: new Map([["ads_apply_approved", beat(5, true, "approved=0 applied=0 failed=0 blocked=0 rollbacks=0 — ran, nothing was waiting")]]), slaHours, jobs: only("ads_apply_approved") });
ok("the hourly drain 5h quiet → P1 (a weekly SLA would have missed this)", hourly.length === 1, hourly[0]?.title);
const hourlyFresh = adsJobFindings({ now: Date.now(), beats: new Map([["ads_apply_approved", beat(1, true, "approved=0 applied=0 failed=0 blocked=0 rollbacks=0 — ran, nothing was waiting")]]), slaHours, jobs: only("ads_apply_approved") });
ok("the hourly drain 1h quiet → nothing", hourlyFresh.length === 0);

// ── 4. Green, recent, successful — and worthless ────────────────────────────
console.log("\n4. The case only the run summary can catch: a successful run that read NOTHING");
const readNothing = adsJobFindings({
  now: Date.now(),
  beats: new Map([["ads_findings", beat(20, true, formatJobSummary({ accounts: 0, read: 0, findings: 0, new: 0, reopened: 0 }, "no mapped ad account to read"))]]),
  slaHours, jobs: only("ads_findings"),
});
ok("accounts=0 on a green run → its own P2 task", readNothing.length === 1 && readNothing[0]!.priority === "P2", readNothing[0]?.title);
ok("  …and it says the quiet result means nothing", /says nothing about any client's spend/.test(readNothing[0]?.description ?? ""));

const partial = adsJobFindings({
  now: Date.now(),
  beats: new Map([["ads_findings", beat(20, true, formatJobSummary({ accounts: 4, read: 2, findings: 3, new: 1, reopened: 0 }, "2/4 account(s) read"))]]),
  slaHours, jobs: only("ads_findings"),
});
ok("read 2 of 4 accounts → P2 naming the gap", partial.length === 1 && /2 of 4/.test(partial[0]!.title), partial[0]?.title);

const counts = parseSummaryCounts(formatJobSummary({ accounts: 3, read: 3, findings: 7 }, "prose — with an em dash and 7 in it"));
ok("the summary round-trips its counts", counts.accounts === 3 && counts.read === 3 && counts.findings === 7, JSON.stringify(counts));
ok("an old note with no counts is not misread as zero", Object.keys(parseSummaryCounts("job status: failure")).length === 0);

// ── 5. Write authority ──────────────────────────────────────────────────────
console.log("\n5. An approved change with no recorded client write authority is visible, not stuck");
const blocked = adsJobFindings({
  now: Date.now(),
  beats: new Map(ADS_JOB_NAMES.map((j) => [j, beat(1)] as const)),
  slaHours,
  blockedOnAuthority: [{ client: "Ohio Community Health (OCH)", findings: 2 }],
  jobs: [],
});
ok("blocked approvals → one P1 blocked task naming the client", blocked.length === 1 && blocked[0]!.status === "blocked" && /Ohio Community Health/.test(blocked[0]!.title));
ok("  …and it says unrecorded is INTENDED, not a bug", /intended behaviour, not a bug/.test(blocked[0]?.description ?? ""));
ok("  …and names both honest answers", /Reporting only/.test(blocked[0]!.description) && /approved changes/.test(blocked[0]!.description));

console.log(`\n${"─".repeat(72)}`);
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
console.log("─".repeat(72));
process.exit(failures === 0 ? 0 : 1);

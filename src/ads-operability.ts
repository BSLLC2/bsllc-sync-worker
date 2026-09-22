/**
 * Operability of the paid-media pipeline: the four ads jobs, what each one's
 * heartbeat means, and how to tell a job that DID NOT RUN apart from one that
 * ran and found nothing.
 *
 * Those two look identical from the dashboard — an empty Ads decisions queue —
 * and they are opposite situations. For a tool built to stop opinions drifting,
 * "no issues found this week" is the answer people will act on, so a silent
 * stop that produces the same screen is the worst failure this feature has.
 *
 * The distinction is made in two places and both are needed:
 *   1. THE HEARTBEAT EXISTS AT ALL. Every ads workflow now stamps
 *      job_heartbeats (see .github/workflows/ads-*.yml). No row, a row older
 *      than the SLA derived from the workflow's own cron, or ok=false, means
 *      the job did not run (or ran and died). The morning audit files that as
 *      a P1 task naming the exact fix.
 *   2. THE HEARTBEAT'S NOTE. A successful run writes its own counts —
 *      `accounts=3 read=3 findings=0 …` — so "ran and found nothing" is a
 *      dated, provable statement with the sample size attached, not an absence.
 *      That also catches the nastiest case: a run that succeeded having read
 *      ZERO accounts. It is green, it is recent, it found nothing, and it
 *      means nothing. `read=0` is a finding of its own.
 *
 * Pure: no I/O, no clock of its own (`now` is passed in), no DB. Tested by
 * `npm run verify-ads-operability`.
 */
import { appendFileSync } from "node:fs";

export interface AdsJobSpec {
  /** job_heartbeats.job — must match the workflow's `--job=` exactly. */
  job: string;
  workflow: string;
  label: string;
  /** The schedule in words, for the task text. */
  cadence: string;
  /** What a healthy run with nothing to report actually means. */
  quiet: string;
  /** The exact thing to do when it misses or fails. Never "check the logs". */
  fix: string;
}

/**
 * The five jobs. `job` names are also what `deriveJobCadences` picks up from
 * the workflow files, so the SLA for each comes from its own cron rather than
 * a number typed here: hourly for apply, daily for verify, weekly for
 * findings, fortnightly for briefs.
 */
export const ADS_JOBS: AdsJobSpec[] = [
  {
    job: "ads_findings",
    workflow: "ads-findings.yml",
    label: "Ads findings audit",
    cadence: "Mondays 06:30 UTC",
    quiet: "A clean week is a real answer — but only when the run happened and read the accounts. The heartbeat note carries accounts/read/findings counts so a quiet week can be told apart from a dead job.",
    fix: "Open bsllc-sync-worker → Actions → \"Ads findings audit (read-only)\" and read the last run. A GOOGLE_ADS_* secret that expired shows as an auth error on the first account; a Node/dependency failure shows in `npm ci`. Re-run it with Run workflow (it is read-only — it writes findings, never a change to an ad account). If it has never run at all, this is the first run: dispatch it with dry_run=true first, then for real.",
  },
  {
    job: "ads_apply_approved",
    workflow: "ads-apply-approved.yml",
    label: "Ads apply-approved drain",
    cadence: "hourly at :15, plus a dispatch on every Approve",
    quiet: "Nothing approved is the normal state. What is NOT normal is an approval sitting in the queue while this job is dead — the dashboard says \"Approved — waiting on the worker\" and waits forever.",
    fix: "Open bsllc-sync-worker → Actions → \"Ads — apply approved changes\". This is the only job that writes to a live ad account, so do not re-run it blind: open the last run first and read which finding it was on. If it is failing on one finding, that finding's history in the dashboard (Ads decisions → expand → History) carries the same error. Re-run with dry_run=true to validate against the live accounts without applying anything.",
  },
  {
    job: "ads_verify_outcomes",
    workflow: "ads-verify-outcomes.yml",
    label: "Ads outcome verification",
    cadence: "daily 06:40 UTC",
    quiet: "Nothing due is normal — an after-check only exists 14 and 28 days after a change was applied, and nothing has been applied yet.",
    fix: "Open bsllc-sync-worker → Actions → \"Ads — verify outcomes (read-only)\" and re-run it. It is read-only against every platform; it writes outcomes onto findings. While it is down, applied changes silently never get a verdict, which is precisely the record the pipeline exists to build — so this one being quietly broken costs more the longer it lasts.",
  },
  {
    job: "ads_change_history",
    workflow: "ads-change-history.yml",
    label: "Ads change history capture",
    cadence: "every six hours, at :10",
    quiet: "An account nobody touched genuinely produces no new rows, and a second run inside the same window produces none either — the note carries accounts/read/events counts so both read as what they are. What this job must never do is stop: the platform keeps change_event for 30 DAYS and then deletes it, so a silent stop is account history being lost rather than a stale reading.",
    fix: "Open bsllc-sync-worker → Actions → \"Ads change history capture (read-only)\" and re-run it. It is a SELECT against change_event and writes nothing to any ad account. Fix it the same day: every day it is down is a day of change history that cannot be recovered afterwards, and while it is down the settle-window guard in the dashboard cannot see a change a subcontractor made by hand.",
  },
];

// `ads_vendor_briefs` is deliberately NOT in this list any more (2026-09-22).
// The generator moved into the dashboard app, where it is a Vercel cron
// (`GET /api/cron/ads-vendor-briefs`) that stamps the same heartbeat key — it
// only ever read `ads_findings` out of Postgres and wrote `ads_briefs` and a
// task, so it never needed to be here. This file reads WORKER jobs; the app's
// own Data health page reads that heartbeat through its own JOB_SLA_HOURS
// entry, which is unchanged.

export const ADS_JOB_NAMES = ADS_JOBS.map((j) => j.job);

// ── The run summary ──────────────────────────────────────────────────────────
/**
 * One line per run, `key=number` pairs first and prose after. The pairs are
 * what makes a green-but-meaningless run visible; the prose is what a person
 * reads on the Data health page.
 */
export function formatJobSummary(counts: Record<string, number>, prose: string): string {
  const pairs = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ");
  return `${pairs} — ${prose}`.slice(0, 300);
}

/** Counts back out of a heartbeat note. Unknown/old formats yield {}. */
export function parseSummaryCounts(note: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of (note ?? "").matchAll(/\b([a-z_]+)=(-?\d+)\b/g)) out[m[1]!] = Number(m[2]);
  return out;
}

/**
 * Hands the summary to the workflow so its Heartbeat step can pass it as
 * `--note`. Also prints it, so the line exists in the Actions log even when
 * run by hand. No-ops outside GitHub Actions.
 */
export function emitJobSummary(summary: string): void {
  console.log(`summary: ${summary}`);
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  try {
    appendFileSync(out, `summary=${summary.replace(/\r?\n/g, " ")}\n`);
  } catch {
    /* never fail a real run over its own bookkeeping */
  }
}

// ── What the morning audit files ─────────────────────────────────────────────
export interface HeartbeatRow {
  ok: boolean;
  ranAt: Date;
  note: string | null;
}

export interface AdsJobProblem {
  key: string;
  title: string;
  priority: "P1" | "P2" | "P3";
  description: string;
  status?: "blocked" | "not_started";
}

const day = (d: Date) => new Date(d).toISOString().slice(0, 10);
// Hours, not days. An hourly job (the apply drain, SLA 3h) is stale long
// before a whole day has passed, and rounding the age down to days made it
// permanently fresh — caught by verify-ads-operability, which is the reason
// the harness tests the hourly and the weekly job side by side.
const ageHours = (now: number, d: Date) => (now - new Date(d).getTime()) / 3_600_000;
const ageDaysText = (now: number, d: Date) => Math.max(0, Math.round(ageHours(now, d) / 24));

/**
 * One finding per ads job that is missing, stale or failing — plus the case
 * nothing else can see: a run that succeeded and read nothing.
 *
 * `slaHours` comes from deriveJobCadences (the workflow's own cron), so this
 * function never has to know that findings is weekly and apply is hourly.
 * A job with a null SLA fires on demand only and can never be "stale".
 */
export function adsJobFindings(opts: {
  now: number;
  beats: Map<string, HeartbeatRow | undefined>;
  slaHours: Map<string, number | null | undefined>;
  /** Approved findings currently waiting on the apply job, for the stuck check. */
  approvedWaiting?: number;
  /** Approved findings the apply job refused for want of write authority. */
  blockedOnAuthority?: { client: string; findings: number }[];
  jobs?: AdsJobSpec[];
}): AdsJobProblem[] {
  const { now, beats, slaHours } = opts;
  const out: AdsJobProblem[] = [];
  for (const spec of opts.jobs ?? ADS_JOBS) {
    const b = beats.get(spec.job);
    const sla = slaHours.get(spec.job);

    if (!b) {
      out.push({
        key: `ads-job:${spec.job}`,
        priority: "P1",
        title: `${spec.label} has never run`,
        description:
          `${spec.workflow} is scheduled (${spec.cadence}) and has never stamped a heartbeat, so it has never completed once. ` +
          `Until it does, an empty Ads decisions queue means nothing — it is not "no issues this week", it is "we have never looked".\n\n${spec.fix}`,
      });
      continue;
    }
    if (!b.ok) {
      out.push({
        key: `ads-job:${spec.job}`,
        priority: "P1",
        status: "blocked",
        title: `${spec.label} failed on ${day(b.ranAt)}`,
        description:
          `Last run failed${b.note ? `: ${b.note.slice(0, 200)}` : "."}\n\nWhile it is failing, nothing anywhere shows a gap — the queue just stops changing.\n\n${spec.fix}`,
      });
      continue;
    }
    if (sla != null && ageHours(now, b.ranAt) > sla) {
      const age = ageHours(now, b.ranAt);
      out.push({
        key: `ads-job:${spec.job}`,
        priority: "P1",
        title: `${spec.label} has not succeeded since ${day(b.ranAt)}`,
        description:
          `Expected ${spec.cadence}; last success ${age < 48 ? `${Math.round(age)} hour(s)` : `${ageDaysText(now, b.ranAt)} day(s)`} ago, past its ${Math.round(sla)}h freshness window (derived from the workflow's own cron). ` +
          `A schedule that silently stopped looks exactly like a quiet week on screen.\n\n${spec.fix}`,
      });
      continue;
    }

    // Ran, succeeded, and on time. The only remaining question is whether it
    // actually looked at anything — a run that read zero accounts is green,
    // recent, empty and worthless, and nothing else in the system can see it.
    const counts = parseSummaryCounts(b.note);
    if (spec.job === "ads_findings" && "accounts" in counts && counts.accounts === 0) {
      out.push({
        key: `ads-job:${spec.job}:no-accounts`,
        priority: "P2",
        title: "The weekly ads audit ran clean but had no ad account to read",
        description:
          `${day(b.ranAt)}: the audit completed successfully across zero accounts, so "no findings" says nothing about any client's spend. ` +
          `It reads clients with status launch/active that have an enabled Google Ads mapping with a customer ID filled in. ` +
          `Fix: Admin → Connectors — confirm each paid client's Google Ads row is enabled and carries the 10-digit customer ID, and that the client's status is not paused.`,
      });
    }
    if (spec.job === "ads_findings" && typeof counts.accounts === "number" && typeof counts.read === "number" && counts.read < counts.accounts) {
      out.push({
        key: `ads-job:${spec.job}:partial-read`,
        priority: "P2",
        title: `The weekly ads audit could only read ${counts.read} of ${counts.accounts} ad accounts`,
        description:
          `${day(b.ranAt)}: ${counts.accounts - counts.read} account(s) failed to read, so their findings are not missing — they were never produced, and the queue cannot tell the difference. ` +
          `Almost always a permission: the account is not under the BS LLC manager (MCC 214-171-2409) or the shared user lost access. Re-link it, then re-run "Ads findings audit (read-only)".`,
      });
    }
  }

  // An approval that cannot be applied. The dashboard shows these under
  // "Approved — waiting on the worker", which reads as a slow worker rather
  // than as a permission nobody recorded.
  for (const b of opts.blockedOnAuthority ?? []) {
    out.push({
      key: `ads-authority:${b.client.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`,
      priority: "P1",
      status: "blocked",
      title: `${b.client} — ${b.findings} approved ads change(s) refused: no write authority recorded`,
      description:
        `Someone approved ${b.findings} change(s) on ${b.client}'s ad account, and the apply job refused every one of them because nothing records that the client agreed to us changing their account. ` +
        `This is the intended behaviour, not a bug: unrecorded means read-only.\n\n` +
        `Fix: open the client → Paid campaigns → "What we may change here". Record either "Reporting only" (and dismiss the approved findings — they will become vendor briefs) or "We may make approved changes", with the clause or the call the permission came from. The apply job picks them up on its next hourly run.`,
    });
  }

  return out;
}

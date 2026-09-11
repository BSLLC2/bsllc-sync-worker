/**
 * Derives each heartbeat job's expected cadence from the workflow files
 * themselves, so the freshness SLA can never drift from the schedule again.
 *
 * For every .github/workflows/*.yml: the `--job=<name>` its Heartbeat step
 * passes, and its `cron:` lines. A job's interval is the longest gap between
 * two consecutive firings of its cron(s) (a weekday-only job's gap is the
 * weekend); its SLA is 1.5× that, with at least 2h of slack for GitHub's
 * scheduled-run delays (several hours late on a busy day is routine). A job
 * with no cron at all fires on demand (workflow_dispatch) — it has no
 * staleness, only success/failure.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface JobCadence {
  /** Hours between firings at the longest gap (null = on demand only). */
  intervalHours: number | null;
  /** Freshness SLA in hours (null = on demand only, never "stale"). */
  slaHours: number | null;
  crons: string[];
  workflow: string;
}

// Expand one cron field: "*", "*\/15" (step), "1,15" (list), "1-5" (range).
function expandField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range = "", stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo = min, hi = max;
    if (range !== "*" && range !== "") {
      const [a, b] = range.split("-").map(Number);
      lo = a!; hi = b ?? a!;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Longest gap in hours between consecutive firings of a 5-field cron
 *  (UTC), scanned minute by minute over a 14-month window so monthly and
 *  weekday-only schedules are measured correctly. */
export function cronMaxGapHours(cron: string, from = new Date(Date.UTC(2026, 0, 1))): number | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minutes = expandField(f[0]!, 0, 59), hours = expandField(f[1]!, 0, 23);
  const doms = expandField(f[2]!, 1, 31), months = expandField(f[3]!, 1, 12), dows = expandField(f[4]!, 0, 7);
  if (dows.has(7)) dows.add(0);
  const domStar = f[2] === "*", dowStar = f[4] === "*";
  let prev: number | null = null, maxGap = 0, fired = 0;
  const end = from.getTime() + 425 * 86_400_000;
  for (let t = from.getTime(); t < end; t += 60_000) {
    const d = new Date(t);
    if (!minutes.has(d.getUTCMinutes()) || !hours.has(d.getUTCHours()) || !months.has(d.getUTCMonth() + 1)) continue;
    const domOk = doms.has(d.getUTCDate()), dowOk = dows.has(d.getUTCDay());
    // Standard cron: when both day fields are restricted, either one matches.
    const dayOk = domStar && dowStar ? true : domStar ? dowOk : dowStar ? domOk : domOk || dowOk;
    if (!dayOk) continue;
    if (prev != null) maxGap = Math.max(maxGap, t - prev);
    prev = t; fired++;
    if (fired > 20000) break; // every-minute crons: gap is already known
  }
  return prev == null ? null : Math.max(maxGap, 60_000) / 3_600_000;
}

export function slaFromInterval(intervalHours: number): number {
  return Math.max(intervalHours * 1.5, intervalHours + 2);
}

/** Heartbeats written by a script itself rather than by a `--job=` step, so
 *  the grep above can't see them: job → the workflow that runs the script. */
export const IN_SCRIPT_HEARTBEATS: Record<string, string> = {
  morning_audit: "morning-audit.yml",
  freshness_monitor: "monitor-freshness.yml",
};

/** job name → cadence, from every workflow that stamps a heartbeat. */
export function deriveJobCadences(workflowsDir: string, inScript: Record<string, string> = IN_SCRIPT_HEARTBEATS): Map<string, JobCadence> {
  const out = new Map<string, JobCadence>();
  for (const file of readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const text = readFileSync(join(workflowsDir, file), "utf8");
    const jobs = Array.from(text.matchAll(/heartbeat -- --job=([A-Za-z0-9_-]+)/g)).map((m) => m[1]!);
    for (const [job, wf] of Object.entries(inScript)) if (wf === file) jobs.push(job);
    if (!jobs.length) continue;
    // Only `cron:` lines under `schedule:`; comments stripped.
    const crons = Array.from(text.matchAll(/^\s*-\s*cron:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/gm)).map((m) => m[1]!.trim());
    const gaps = crons.map((c) => cronMaxGapHours(c)).filter((g): g is number => g != null);
    const intervalHours = gaps.length ? Math.max(...gaps) : null;
    for (const job of jobs) {
      const prevCad = out.get(job);
      // A job stamped by several workflows (e.g. the morning audit re-runs
      // importers and stamps their heartbeat too) keeps its own workflow's
      // cadence — the tightest schedule found for it.
      const cad: JobCadence = { intervalHours, slaHours: intervalHours == null ? null : slaFromInterval(intervalHours), crons, workflow: file };
      if (!prevCad || (cad.intervalHours != null && (prevCad.intervalHours == null || cad.intervalHours < prevCad.intervalHours))) out.set(job, cad);
    }
  }
  return out;
}

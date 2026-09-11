/**
 * Which importers the morning audit expects to have run, how recently, and
 * which workflow step re-runs each one.
 *
 * Extracted from audit-and-repair.ts (which calls main() on import, so nothing
 * inside it is reachable from a test). `--mode=plan` turns `staleJobs()` into
 * the `rerun=` output the workflow uses to re-run only what missed, so a wrong
 * cadence here either silently skips a broken importer or re-runs every job
 * every morning.
 *
 * These are the audit's own fixed windows, deliberately a little longer than
 * each schedule: a daily job is 26h, not 24h, so a run that starts a few minutes
 * late (or queues behind another workflow) is not called stale; hubspot_deals
 * runs twice a day, so its window is 14h. Separate from ./job-cadence.ts, which
 * DERIVES a freshness SLA from the cron lines in the workflow files for
 * monitor-freshness — that one answers "is this data stale", this one answers
 * "which importer should the audit re-run right now".
 */

export interface AuditJob { step: string; hours: number }

export const DAY_HOURS = 24;

export const DAILY: Record<string, AuditJob> = {
  incremental_sync: { step: "ads", hours: 26 },
  import_hubspot_metrics: { step: "hubspot_metrics", hours: 26 },
  import_och: { step: "och", hours: 26 },
  import_ga4: { step: "ga4", hours: 26 },
  import_gsc: { step: "gsc", hours: 26 },
  import_d365: { step: "d365", hours: 26 },
  match_web_leads_to_crm: { step: "crm_match", hours: 26 },
  hubspot_deals: { step: "hubspot_deals", hours: 14 },
  qbo_invoices_sync: { step: "qbo", hours: 26 },
  qbo_financials: { step: "qbo_financials", hours: 26 },
  qbo_depth: { step: "qbo_depth", hours: 26 },
  seo_import: { step: "seo", hours: 8 * DAY_HOURS },
  aeo_import: { step: "aeo", hours: 8 * DAY_HOURS },
  domain_authority_import: { step: "authority", hours: 8 * DAY_HOURS },
};

/** One row of job_heartbeats. */
export interface Heartbeat { job: string; ran_at: Date | string; ok: boolean }

/**
 * The jobs to re-run this morning: never ran, last run FAILED, or the last
 * success is older than its window. `ok = false` counts as stale however recent
 * it is — a job that ran and failed has not done its work.
 */
export function staleJobs(beats: Iterable<Heartbeat>, now: Date = new Date()): Array<[string, AuditJob]> {
  const byJob = new Map<string, Heartbeat>();
  for (const b of beats) byJob.set(b.job, b);
  return Object.entries(DAILY).filter(([job, cfg]) => {
    const b = byJob.get(job);
    if (!b || !b.ok) return true;
    const ranAt = b.ran_at instanceof Date ? b.ran_at : new Date(b.ran_at);
    if (Number.isNaN(ranAt.getTime())) return true;
    return now.getTime() - ranAt.getTime() > cfg.hours * 3_600_000;
  });
}

/** The `rerun=` value written to $GITHUB_OUTPUT: the workflow step keys. */
export function rerunSteps(stale: Array<[string, AuditJob]>): string {
  return stale.map(([, cfg]) => cfg.step).join(",");
}

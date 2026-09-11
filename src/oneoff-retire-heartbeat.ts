#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off: delete a job_heartbeats row for a job that no longer exists.
 *
 * Heartbeats are keyed by the literal --job= name each workflow passes; when
 * a job is renamed the old row stays behind forever and, since nothing
 * refreshes it, reads as "Not flowing" on the Data health page. qbo_estimate
 * is the case at hand: import-qbo-invoices.yml stamped it until commit
 * b628569 (2026-08-29) renamed the job to qbo_invoice. The freshness monitor
 * now prints such orphans instead of alerting on them; this removes the row.
 *
 *   npm run oneoff-retire-heartbeat -- --job=qbo_estimate --dry-run   (read-only)
 *   npm run oneoff-retire-heartbeat -- --job=qbo_estimate             (applies)
 */
function arg(name: string): string { return (process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "").trim(); }
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const job = arg("job");
  if (!job) throw new Error("Pass --job=<heartbeat job name>.");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows } = await c.query<{ job: string; ran_at: Date; ok: boolean; note: string | null }>(`SELECT job, ran_at, ok, note FROM job_heartbeats WHERE job = $1`, [job]);
    if (!rows[0]) { console.log(`No heartbeat row for "${job}". Nothing to do.`); return; }
    const r = rows[0];
    console.log(`${r.job}: last ran ${r.ran_at.toISOString()} ok=${r.ok}${r.note ? ` note=${r.note}` : ""}`);
    if (dryRun) { console.log("(dry-run — no changes written)"); return; }
    await c.query(`DELETE FROM job_heartbeats WHERE job = $1`, [job]);
    console.log(`Deleted the "${job}" heartbeat row.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

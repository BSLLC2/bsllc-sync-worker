#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Stamps a job heartbeat so the dashboard's Data Health cockpit can tell whether
 * a non-metric pipeline actually ran and succeeded. Called as the final step of
 * a workflow, passing the runner's job status:
 *
 *   npm run heartbeat -- --job=db_backup --status=${{ job.status }} [--note="…"]
 *
 * status success → ok=true; anything else → ok=false.
 */
function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

async function main() {
  const job = arg("job");
  if (!job) throw new Error("Pass --job=<name>.");
  const status = (arg("status") || "success").toLowerCase();
  const ok = status === "success";
  const note = arg("note") ?? (ok ? null : `job status: ${status}`);

  const url = process.env.DATABASE_URL;
  if (!url?.trim()) throw new Error("Missing DATABASE_URL");
  const c = new pg.Client({ connectionString: url.trim() });
  await c.connect();
  try {
    // Schema-qualified on purpose: this is the one safety net that must
    // never itself fail silently (see backup-db.yml's 2026-08-26 incident,
    // where a bare unqualified CREATE TABLE hit "no schema has been
    // selected to create in" on a connection whose search_path came back
    // empty — a transient Postgres-side hiccup, but this is cheap insurance
    // against it recurring).
    await c.query(`CREATE TABLE IF NOT EXISTS public.job_heartbeats (
      job TEXT PRIMARY KEY, ran_at TIMESTAMPTZ NOT NULL DEFAULT now(), ok BOOLEAN NOT NULL DEFAULT true, note TEXT
    )`);
    await c.query(
      `INSERT INTO public.job_heartbeats (job, ran_at, ok, note) VALUES ($1, now(), $2, $3)
       ON CONFLICT (job) DO UPDATE SET ran_at = now(), ok = EXCLUDED.ok, note = EXCLUDED.note`,
      [job, ok, note],
    );
    console.log(`Heartbeat: ${job} → ${ok ? "ok" : "FAIL"}${note ? ` (${note})` : ""}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Stamps a job heartbeat so the dashboard's Data Health cockpit can tell whether
 * a non-metric pipeline actually ran and succeeded. Called as the final step of
 * a workflow, passing the runner's job status:
 *
 *   npm run heartbeat -- --job=db_backup --status=${{ job.status }} [--note="…"] [--log=run.log]
 *
 * status success → ok=true; anything else → ok=false.
 *
 * --log=<file>: the script's captured stdout+stderr (workflow: `npm run x 2>&1
 * | tee run.log`). On failure the note becomes the log's last meaningful line
 * — every script here ends with console.error(e.message) before exit 1 — so
 * the Data health page shows WHY ("missing_scope", "Sheets GET … → 503")
 * instead of the bare "job status: failure" it showed until now.
 */
import { existsSync, readFileSync } from "node:fs";

function lastLogLine(file: string): string | null {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter((l) => l && !/^npm\s+(ERR!|error|warn|notice)/i.test(l) && !/^> /.test(l) && !/^\s*at /.test(l));
  return lines.length ? lines[lines.length - 1]!.slice(0, 300) : null;
}
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
  const log = arg("log");
  const note = arg("note") ?? (ok ? null : (log && lastLogLine(log)) ?? `job status: ${status}`);

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

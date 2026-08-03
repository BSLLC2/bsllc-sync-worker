import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { Config } from "./config.js";

/** One entry in the dashboard's sync contract (see SYNC_INTERFACE.md). */
export interface SyncEntry {
  client_id: string;
  source: "google_ads";
  external_id: string;
  period_start: string;
  period_end: string;
  /** Omitted for incremental (defaults to now()); set for backfill (backdated). */
  synced_at?: string;
  data_state: "live" | "no_data" | "error";
  error_message: string | null;
  metrics: Record<string, number | string | boolean | null>;
}

/**
 * Write the payload to a temp file and hand it to the dashboard's `npm run sync`.
 * The worker owns zero database writes — sync.ts validates and inserts. Returns
 * the child exit code (0 ok · 1 bad input · 2 one or more entries failed).
 */
export function runDashboardSync(
  cfg: Config,
  syncs: SyncEntry[],
  opts: { dryRun: boolean },
): number {
  const dir = mkdtempSync(join(tmpdir(), "adsync-"));
  const file = join(dir, "sync.json");
  writeFileSync(file, JSON.stringify({ syncs }, null, 2));
  console.log(`\n→ Wrote ${syncs.length} sync entr${syncs.length === 1 ? "y" : "ies"} to ${file}`);

  const args = ["run", "sync", "--", `--input=${file}`];
  if (opts.dryRun) args.push("--dry-run");

  const res = spawnSync("npm", args, {
    cwd: cfg.dashboardDir,
    stdio: "inherit",
    // The dashboard checkout reads DATABASE_URL; pass ours through so the two
    // stay in lockstep even if its own .env is absent.
    env: { ...process.env, DATABASE_URL: cfg.databaseUrl },
  });

  if (res.error) {
    console.error(`Failed to run \`npm run sync\` in ${cfg.dashboardDir}:`, res.error.message);
    return 1;
  }
  return res.status ?? 1;
}

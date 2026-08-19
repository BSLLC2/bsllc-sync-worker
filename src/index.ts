import { loadConfig } from "./config.js";
import { resolveTargets, type Target } from "./targets.js";
import { makeAdsApi, pullWindow, pullVerifiedConversions } from "./google-ads.js";
import { runDashboardSync, type SyncEntry } from "./emit.js";
import { weeklyAsOfDates, windowFor } from "./dates.js";

// Must match CONVERSION_ACTION_NAME in import-offline-conversions.ts — that's
// the only action fed exclusively by real, sheet-matched admissions.
const VERIFIED_CONVERSION_ACTION_NAME = "Admission (offline)";

interface Args {
  mode: "backfill" | "incremental";
  weeks: number;
  dryRun: boolean;
  accountsFile?: string;
  onlyClient: string;
}

function parseArgs(argv: string[]): Args {
  let mode: Args["mode"] = "incremental";
  let weeks = 52;
  let dryRun = false;
  let accountsFile: string | undefined;
  let onlyClient = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--mode=")) mode = a.slice(7) as Args["mode"];
    else if (a === "--mode") mode = argv[++i] as Args["mode"];
    else if (a.startsWith("--weeks=")) weeks = Number(a.slice(8));
    else if (a === "--weeks") weeks = Number(argv[++i]);
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--accounts=")) accountsFile = a.slice(11);
    else if (a === "--accounts") accountsFile = argv[++i];
    else if (a.startsWith("--client=")) onlyClient = a.slice("--client=".length).trim();
  }
  if (mode !== "backfill" && mode !== "incremental") {
    throw new Error(`--mode must be "backfill" or "incremental" (got "${mode}")`);
  }
  if (!Number.isFinite(weeks) || weeks < 1) {
    throw new Error(`--weeks must be a positive integer (got "${weeks}")`);
  }
  return { mode, weeks, dryRun, accountsFile, onlyClient };
}

/** A (target, as-of date) unit of work. */
interface Job {
  target: Target;
  asOf: Date;
  /** Backdate synced_at for backfill; omit for incremental. */
  backdate: boolean;
}

function buildJobs(args: Args, targets: Target[], now: Date): Job[] {
  if (args.mode === "incremental") {
    return targets.map((target) => ({ target, asOf: now, backdate: false }));
  }
  const dates = weeklyAsOfDates(args.weeks, now);
  const jobs: Job[] = [];
  for (const target of targets) {
    for (const asOf of dates) jobs.push({ target, asOf, backdate: true });
  }
  return jobs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const api = makeAdsApi(cfg);

  let { targets, from } = await resolveTargets(cfg, args.accountsFile);
  if (args.onlyClient) targets = targets.filter((t) => t.clientRef === args.onlyClient);
  if (targets.length === 0) {
    console.error(
      "No Google Ads accounts to sync. Enable them in Admin → Connectors, or " +
        "provide accounts.json (see accounts.example.json).",
    );
    process.exit(1);
  }
  console.log(
    `Mode: ${args.mode}${args.mode === "backfill" ? ` (${args.weeks} weeks)` : ""} · ` +
      `${targets.length} account(s) from ${from === "db" ? "connector_mappings" : "accounts.json"}` +
      `${args.dryRun ? " · DRY RUN" : ""}`,
  );

  // Date.now() is fine here — this is the real worker on the VPS, not a
  // deterministic-replay context.
  const now = new Date();
  const jobs = buildJobs(args, targets, now);
  console.log(`Planned ${jobs.length} account-window pull(s).\n`);

  const syncs: SyncEntry[] = [];
  let ok = 0;
  let failed = 0;

  for (const [i, job] of jobs.entries()) {
    const { target, asOf, backdate } = job;
    const w = windowFor(asOf);
    const label = `${target.clientLabel} [${target.customerId}] ${w.queryStart}..${w.queryEnd}`;

    const base = {
      client_id: target.clientRef,
      source: "google_ads" as const,
      external_id: target.customerId,
      period_start: w.periodStart.toISOString(),
      period_end: w.periodEnd.toISOString(),
      ...(backdate ? { synced_at: asOf.toISOString() } : {}),
    };

    try {
      const res = await pullWindow(api, cfg, target.customerId, w.queryStart, w.queryEnd);
      // "ads.conversions" is every conversion action in the account (form
      // fills, calls, page views…) — not the real, sheet-verified admissions
      // this client actually closed. Where a client runs the offline-
      // conversion loop (import-offline-conversions.ts), also pull JUST that
      // conversion action so revenue/CPL can be reported on real outcomes,
      // not raw on-platform conversion volume. Only in incremental mode or a
      // single-client run — this is an extra API call per account per pull,
      // and backfill × 52 weeks × every account would multiply that badly.
      if (res.state === "live" && (args.mode === "incremental" || args.onlyClient)) {
        try {
          const verified = await pullVerifiedConversions(
            api, cfg, target.customerId, w.queryStart, w.queryEnd, VERIFIED_CONVERSION_ACTION_NAME,
          );
          if (verified) {
            res.metrics["ads.verified_conversions"] = verified.conversions;
            res.metrics["ads.verified_conversion_value"] = verified.value;
            const cost = res.metrics["ads.cost_micros"];
            res.metrics["ads.verified_cost_per_conversion"] =
              cost != null && verified.conversions > 0 ? cost / verified.conversions : null;
          }
        } catch (verifiedErr) {
          // Non-fatal — the account-wide metrics above still land either way.
          console.log(`    (verified-conversion pull failed for ${label}: ${formatError(verifiedErr)})`);
        }
      }
      syncs.push({ ...base, data_state: res.state, error_message: null, metrics: res.metrics });
      ok++;
      process.stdout.write(`  [${i + 1}/${jobs.length}] ${res.state.padEnd(7)} ${label}\n`);
    } catch (err) {
      const message = formatError(err);
      syncs.push({ ...base, data_state: "error", error_message: message, metrics: {} });
      failed++;
      process.stdout.write(`  [${i + 1}/${jobs.length}] ERROR   ${label} — ${message}\n`);
    }

    // Gentle spacing so a 400+ pull backfill stays well under Google Ads rate
    // limits; the client also backs off on its own.
    if (i < jobs.length - 1) await sleep(150);
  }

  console.log(`\nPulled ${ok} ok, ${failed} error, ${syncs.length} total entries.`);

  const code = runDashboardSync(cfg, syncs, { dryRun: args.dryRun });
  if (code !== 0) {
    console.error(`\nDashboard sync exited ${code} — see the summary above.`);
    process.exit(code);
  }
  console.log("\nDone.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The google-ads-api client throws a GoogleAdsFailure object, not an Error, so
 * `String(err)` yields a useless "[object Object]". Unwrap the real reason:
 * each entry carries an error_code ({ authorization_error: "USER_PERMISSION_DENIED" })
 * and a human message. Fall back to JSON so nothing is ever lost.
 */
function formatError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === "object") {
    const anyErr = err as { errors?: unknown; message?: unknown };
    if (Array.isArray(anyErr.errors) && anyErr.errors.length > 0) {
      return anyErr.errors
        .map((e) => {
          const ge = e as { error_code?: Record<string, unknown>; message?: string };
          const code = ge.error_code
            ? Object.entries(ge.error_code)
                .map(([k, v]) => `${k}=${v}`)
                .join(",")
            : "";
          return [code, ge.message].filter(Boolean).join(" ");
        })
        .join(" | ");
    }
    if (typeof anyErr.message === "string" && anyErr.message) return anyErr.message;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

main().catch((err) => {
  console.error("Worker failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});

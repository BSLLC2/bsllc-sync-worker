#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { openCustomer } from "./apply-ads-changes.js";
import { mappedAccounts } from "./ads/store.js";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";
import {
  DAILY_GAQL, MAX_DAILY_ROWS, NO_ACCOUNTS_NOTE, PLATFORM, accountLine, buildDailyRows,
  ensureDailyTables, hasSpan, loadCoverage, readWindow, recordDailyFailure, storeDaily,
} from "./ads/daily-metrics.js";

/**
 * Read each mapped ad account's campaigns, one row per campaign per day.
 *
 * READ-ONLY: every query is a SELECT; nothing is written to any ad platform.
 * The reasoning, the null-versus-zero rule and the coverage record are in
 * src/ads/daily-metrics.ts.
 *
 *   npm run ads-daily-metrics                      (every mapped account)
 *   npm run ads-daily-metrics -- --client=slug     (one account; stamps no book-wide heartbeat)
 *   npm run ads-daily-metrics -- --days=90         (a wider window than the default)
 *   npm run ads-daily-metrics -- --dry-run         (read and print, write nothing)
 *
 * The first run for an account reads about sixty days; every run after reads
 * the last fourteen, which restates conversions the platform attributes late.
 */
function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}
const hasFlag = (name: string) => process.argv.slice(2).includes(`--${name}`);

async function main() {
  const cfg = loadConfig();
  const onlyClient = arg("client") ?? "";
  const dryRun = hasFlag("dry-run");
  const daysArg = arg("days") ? Number(arg("days")) : undefined;
  if (daysArg != null && !(Number.isFinite(daysArg) && daysArg >= 1)) {
    console.error(`--days must be a number of days, 1 or more (got "${arg("days")}").`);
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });

  const c = new pg.Client({ connectionString: cfg.databaseUrl });
  await c.connect();
  try {
    if (!dryRun) await ensureDailyTables(c);
    const targets = await mappedAccounts(c, PLATFORM, onlyClient || undefined);
    if (!targets.length) {
      console.log(`No mapped ${PLATFORM} accounts${onlyClient ? ` for ${onlyClient}` : ""}.`);
      emitJobSummary(formatJobSummary({ accounts: 0, read: 0, rows: 0 }, NO_ACCOUNTS_NOTE));
      return;
    }
    console.log(`Ads daily metrics · ${targets.length} account(s) · ${today}`);
    console.log(`READ-ONLY — every query is a SELECT. Nothing is written to any ad account.\n`);

    let read = 0, failed = 0, totalRows = 0;
    const problems: string[] = [];
    for (const t of targets) {
      const accountId = digitsOnly(t.accountId);
      try {
        // A dry run on a database the table is not in yet reads as a first run.
        const prev = await loadCoverage(c, accountId).catch((e) => { if (dryRun) return null; throw e; });
        const window = readWindow(today, !hasSpan(prev), daysArg);
        const customer = await openCustomer(api, cfg, accountId);
        const raw: any[] = await customer.query(DAILY_GAQL.replace("{{start}}", window.start).replace("{{end}}", window.end));
        const list = Array.isArray(raw) ? raw : [];
        if (list.length >= MAX_DAILY_ROWS) {
          // A truncated read written as complete would turn every missing day into a nought.
          throw new Error(`the read came back at the ${MAX_DAILY_ROWS}-row ceiling, so it cannot be called complete and nothing was written`);
        }
        const rows = buildDailyRows(list);
        const campaigns = new Set(rows.map((r) => r.campaignId)).size;
        const nulls = rows.filter((r) => r.conversions == null).length;
        read += 1; totalRows += rows.length;
        console.log(accountLine(t.clientName, rows.length, campaigns, window, nulls ? `${nulls} with no conversion evidence, stored as unanswered` : hasSpan(prev) ? "" : "first run, backfilled"));
        if (dryRun) { console.log(`      (dry run, nothing written)`); continue; }
        const cov = await storeDaily(c, t.clientId, accountId, rows, window, `${rows.length} campaign-days, ${window.start} to ${window.end}`);
        if (cov.restarted) problems.push(`${t.clientName}: the last good read was more than a day before this window, so coverage restarts at ${cov.coveredFrom}`);
      } catch (e) {
        // One account must not take the run down for every other client, and a
        // failure is a row that says so, never a clean read.
        failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        problems.push(`${t.clientName} failed: ${msg.slice(0, 200)}`);
        console.log(`  ⚠ ${t.clientName}: ${msg.slice(0, 200)}`);
        if (!dryRun) await recordDailyFailure(c, t.clientId, accountId, today, msg).catch(() => {});
      }
    }

    console.log(`\n${"─".repeat(72)}`);
    console.log(`${read}/${targets.length} account(s) read · ${totalRows} campaign-day${totalRows === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`);
    for (const p of problems) console.log(`  · ${p}`);
    if (dryRun) { console.log(`\nDry run complete — nothing written.`); return; }

    emitJobSummary(formatJobSummary(
      { accounts: targets.length, read, rows: totalRows, failed },
      read === 0 ? "no account could be read — no campaign day was captured for any client today" : `${read}/${targets.length} account(s) read, ${totalRows} campaign-days`,
    ));
    // Every account failing is a failed run, not a green one that read nothing.
    if (read === 0) process.exit(1);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { openCustomer } from "./apply-ads-changes.js";
import { mappedAccounts } from "./ads/store.js";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";
import {
  MAX_ROWS, NO_ACCOUNTS_NOTE, PLATFORM, SEARCH_TERM_DAYS_GAQL,
  accountLine, buildSearchTermRows, ensureSearchTermTables, recordSearchTermFailure, storeSearchTermDays, termWindow,
} from "./ads/search-term-days.js";
import type { UnrecognisedEnum } from "./ads/structure-snapshot.js";

/**
 * Each search term, by day, for the last 90 days. READ-ONLY: every query is a
 * SELECT; nothing is written to any ad platform. The reasoning is in
 * src/ads/search-term-days.ts.
 *
 *   npm run ads-search-term-days                      (every mapped account)
 *   npm run ads-search-term-days -- --client=slug     (one account; stamps no book-wide heartbeat)
 *   npm run ads-search-term-days -- --days=30         (a shorter window)
 *   npm run ads-search-term-days -- --dry-run         (read and print, write nothing)
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
  const window = termWindow(today, daysArg);
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });

  const c = new pg.Client({ connectionString: cfg.databaseUrl });
  await c.connect();
  try {
    if (!dryRun) await ensureSearchTermTables(c);
    const targets = await mappedAccounts(c, PLATFORM, onlyClient || undefined);
    if (!targets.length) {
      console.log(`No mapped ${PLATFORM} accounts${onlyClient ? ` for ${onlyClient}` : ""}.`);
      emitJobSummary(formatJobSummary({ accounts: 0, read: 0, rows: 0 }, NO_ACCOUNTS_NOTE));
      return;
    }
    console.log(`Ads search term days · ${targets.length} account(s) · ${window.start} to ${window.end}`);
    console.log(`READ-ONLY — every query is a SELECT. Nothing is written to any ad account.\n`);

    let read = 0, failed = 0, totalRows = 0;
    const problems: string[] = [];
    const query = SEARCH_TERM_DAYS_GAQL.replace("{{start}}", window.start).replace("{{end}}", window.end);

    for (const t of targets) {
      const accountId = digitsOnly(t.accountId);
      try {
        const customer: any = await openCustomer(api, cfg, accountId);
        const raw: any[] = await customer.query(query);
        const list = Array.isArray(raw) ? raw : [];
        if (list.length >= MAX_ROWS) {
          // A truncated read written as complete turns every missing term into one that did not spend.
          throw new Error(`the search term read came back at the ${MAX_ROWS}-row ceiling, so it cannot be called complete and nothing was written`);
        }
        const report: UnrecognisedEnum[] = [];
        const rows = buildSearchTermRows(list, report);
        console.log(accountLine(t.clientName, rows.length, window));
        for (const u of report.slice(0, 3)) problems.push(`${t.clientName}: ${u.field} = ${u.raw} stored as UNRECOGNISED`);
        read += 1;
        totalRows += rows.length;
        if (dryRun) { console.log(`      (dry run, nothing written)`); continue; }
        await storeSearchTermDays(c, t.clientId, accountId, rows, window);
      } catch (e) {
        // One account must not take the others down, and a failure is a row that says so, never a clean read.
        failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        problems.push(`${t.clientName} failed: ${msg.slice(0, 200)}`);
        console.log(`  ⚠ ${t.clientName}: ${msg.slice(0, 200)}`);
        if (!dryRun) await recordSearchTermFailure(c, t.clientId, accountId, msg).catch(() => {});
      }
    }

    console.log(`\n${"─".repeat(72)}`);
    console.log(`${read}/${targets.length} account(s) read · ${totalRows} search term day row(s)${failed ? ` · ${failed} failed` : ""}`);
    for (const p of problems) console.log(`  · ${p}`);
    if (dryRun) { console.log(`\nDry run complete — nothing written.`); return; }

    emitJobSummary(formatJobSummary(
      { accounts: targets.length, read, rows: totalRows, failed },
      read === 0 ? "no account could be read — no search term was captured for any client today" : `${read}/${targets.length} account(s) read, ${totalRows} search term day rows`,
    ));
    if (read === 0) process.exit(1);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

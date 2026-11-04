#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { openCustomer } from "./apply-ads-changes.js";
import { mappedAccounts } from "./ads/store.js";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";
import {
  CONVERSION_ACTION_METRICS_GAQL, KEYWORD_METRICS_GAQL, MAX_ROWS, NO_ACCOUNTS_NOTE, PLATFORM,
  accountLine, buildConversionActionRows, buildKeywordRows, ensureKeywordMetricTables, metricsWindow,
  recordKeywordMetricFailure, storeConversionActionMetrics, storeKeywordMetrics, type Part,
} from "./ads/keyword-metrics.js";
import type { UnrecognisedEnum } from "./ads/structure-snapshot.js";

/**
 * Each keyword's last 30 days, and each campaign's conversions by conversion
 * action. READ-ONLY: every query is a SELECT; nothing is written to any ad
 * platform. The reasoning is in src/ads/keyword-metrics.ts.
 *
 *   npm run ads-keyword-metrics                      (every mapped account)
 *   npm run ads-keyword-metrics -- --client=slug     (one account; stamps no book-wide heartbeat)
 *   npm run ads-keyword-metrics -- --days=14         (a shorter window)
 *   npm run ads-keyword-metrics -- --dry-run         (read and print, write nothing)
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
  const window = metricsWindow(today, daysArg);
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });

  const c = new pg.Client({ connectionString: cfg.databaseUrl });
  await c.connect();
  try {
    if (!dryRun) await ensureKeywordMetricTables(c);
    const targets = await mappedAccounts(c, PLATFORM, onlyClient || undefined);
    if (!targets.length) {
      console.log(`No mapped ${PLATFORM} accounts${onlyClient ? ` for ${onlyClient}` : ""}.`);
      emitJobSummary(formatJobSummary({ accounts: 0, read: 0, keywords: 0, actions: 0 }, NO_ACCOUNTS_NOTE));
      return;
    }
    console.log(`Ads keyword metrics · ${targets.length} account(s) · ${window.start} to ${window.end}`);
    console.log(`READ-ONLY — every query is a SELECT. Nothing is written to any ad account.\n`);

    let read = 0, failedParts = 0, totalKeywords = 0, totalActions = 0;
    const problems: string[] = [];
    const query = (gaql: string) => gaql.replace("{{start}}", window.start).replace("{{end}}", window.end);

    for (const t of targets) {
      const accountId = digitsOnly(t.accountId);
      let customer: any;
      try {
        customer = await openCustomer(api, cfg, accountId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failedParts += 2;
        problems.push(`${t.clientName} failed: ${msg.slice(0, 200)}`);
        console.log(`  ⚠ ${t.clientName}: ${msg.slice(0, 200)}`);
        if (!dryRun) for (const p of ["keywords", "conversion_actions"] as Part[]) await recordKeywordMetricFailure(c, t.clientId, accountId, p, window, msg).catch(() => {});
        continue;
      }
      let okParts = 0;
      for (const part of ["keywords", "conversion_actions"] as Part[]) {
        try {
          const raw: any[] = await customer.query(query(part === "keywords" ? KEYWORD_METRICS_GAQL : CONVERSION_ACTION_METRICS_GAQL));
          const list = Array.isArray(raw) ? raw : [];
          if (list.length >= MAX_ROWS) {
            // A truncated read written as complete turns every missing keyword into one that did not spend.
            throw new Error(`the ${part} read came back at the ${MAX_ROWS}-row ceiling, so it cannot be called complete and nothing was written`);
          }
          const report: UnrecognisedEnum[] = [];
          const rows = part === "keywords" ? buildKeywordRows(list, report) : buildConversionActionRows(list);
          console.log(accountLine(t.clientName, part, rows.length, window));
          for (const u of report.slice(0, 3)) problems.push(`${t.clientName}: ${u.field} = ${u.raw} stored as UNRECOGNISED`);
          okParts += 1;
          if (part === "keywords") totalKeywords += rows.length; else totalActions += rows.length;
          if (dryRun) { console.log(`      (dry run, nothing written)`); continue; }
          if (part === "keywords") await storeKeywordMetrics(c, t.clientId, accountId, rows as ReturnType<typeof buildKeywordRows>, window);
          else await storeConversionActionMetrics(c, t.clientId, accountId, rows as ReturnType<typeof buildConversionActionRows>, window);
        } catch (e) {
          // One part must not take the other down, and a failure is a row that says so, never a clean read.
          failedParts += 1;
          const msg = e instanceof Error ? e.message : String(e);
          problems.push(`${t.clientName} ${part} failed: ${msg.slice(0, 200)}`);
          console.log(`  ⚠ ${t.clientName} (${part}): ${msg.slice(0, 200)}`);
          if (!dryRun) await recordKeywordMetricFailure(c, t.clientId, accountId, part, window, msg).catch(() => {});
        }
      }
      if (okParts > 0) read += 1;
    }

    console.log(`\n${"─".repeat(72)}`);
    console.log(`${read}/${targets.length} account(s) read · ${totalKeywords} keyword row(s) · ${totalActions} conversion action row(s)${failedParts ? ` · ${failedParts} part(s) failed` : ""}`);
    for (const p of problems) console.log(`  · ${p}`);
    if (dryRun) { console.log(`\nDry run complete — nothing written.`); return; }

    emitJobSummary(formatJobSummary(
      { accounts: targets.length, read, keywords: totalKeywords, actions: totalActions, failed: failedParts },
      read === 0 ? "no account could be read — no keyword figure was captured for any client today" : `${read}/${targets.length} account(s) read, ${totalKeywords} keywords, ${totalActions} conversion action rows`,
    ));
    if (read === 0) process.exit(1);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

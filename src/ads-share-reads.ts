#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { openCustomer } from "./apply-ads-changes.js";
import { mappedAccounts } from "./ads/store.js";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";
import {
  DAY_PARTS, GEO_GAQL, GEO_GAQL_COUNTRY_ONLY, KEYWORD_QUALITY_GAQL, MAX_ROWS, NO_ACCOUNTS_NOTE, PARTS, PLATFORM, QUERY_BY_PART,
  accountLine, buildGeoRows, buildQualityRows, buildSegmentRows, buildShareRows, dayWindow, ensureShareTables, fillWindow,
  hasSpan, loadPartCoverage, recordShareFailure, sliceWindow, storeGeo, storeKeywordQuality, storeSegmentDays, storeShareDays,
  windowEndingYesterday, type Part,
} from "./ads/share-reads.js";
import type { UnrecognisedEnum } from "./ads/structure-snapshot.js";

/**
 * Why a campaign is limited, as the platform reports it: impression share lost
 * to budget and to rank, each keyword's quality score and first-page cost, the
 * hours and devices the money went through and the places it went.
 *
 * READ-ONLY: every query is a SELECT; nothing is written to any ad platform.
 * The reasoning, the null rules and the coverage record are in
 * src/ads/share-reads.ts.
 *
 *   npm run ads-share-reads                      (every mapped account)
 *   npm run ads-share-reads -- --client=slug     (one account; stamps no book-wide heartbeat)
 *   npm run ads-share-reads -- --days=90         (a wider day window; window parts stay at 30)
 *   npm run ads-share-reads -- --dry-run         (read and print, write nothing)
 *
 * The first run for a day part reads 60 days; every run after reads the last 14.
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
    if (!dryRun) await ensureShareTables(c);
    const targets = await mappedAccounts(c, PLATFORM, onlyClient || undefined);
    if (!targets.length) {
      console.log(`No mapped ${PLATFORM} accounts${onlyClient ? ` for ${onlyClient}` : ""}.`);
      emitJobSummary(formatJobSummary({ accounts: 0, read: 0, rows: 0 }, NO_ACCOUNTS_NOTE));
      return;
    }
    console.log(`Ads share reads · ${targets.length} account(s) · ${today}`);
    console.log(`READ-ONLY — every query is a SELECT. Nothing is written to any ad account.\n`);

    let read = 0, failedParts = 0, totalRows = 0;
    const problems: string[] = [];

    for (const t of targets) {
      const accountId = digitsOnly(t.accountId);
      let customer: any;
      try {
        customer = await openCustomer(api, cfg, accountId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failedParts += PARTS.length;
        problems.push(`${t.clientName} failed: ${msg.slice(0, 200)}`);
        console.log(`  ⚠ ${t.clientName}: ${msg.slice(0, 200)}`);
        if (!dryRun) for (const p of PARTS) await recordShareFailure(c, t.clientId, accountId, p, today, msg).catch(() => {});
        continue;
      }
      let okParts = 0;
      for (const part of PARTS as readonly Part[]) {
        try {
          const report: UnrecognisedEnum[] = [];
          let rowsOut = 0;
          let window: { start: string; end: string };
          if (DAY_PARTS.includes(part)) {
            // A dry run on a database the tables are not in yet reads as a first run.
            const prev = await loadPartCoverage(c, accountId, part).catch((e) => { if (dryRun) return null; throw e; });
            window = dayWindow(today, !hasSpan(prev), daysArg);
            const raw: any[] = [];
            for (const slice of sliceWindow(window)) {
              const list = await customer.query(fillWindow(QUERY_BY_PART[part], slice));
              const arr = Array.isArray(list) ? list : [];
              if (arr.length >= MAX_ROWS) {
                // A truncated read written as complete would turn every missing row into a nought.
                throw new Error(`the ${part} read for ${slice.start} to ${slice.end} came back at the ${MAX_ROWS}-row ceiling, so it cannot be called complete and nothing was written`);
              }
              raw.push(...arr);
            }
            const note = `${part}, ${window.start} to ${window.end}`;
            if (part === "share_days") {
              const rows = buildShareRows(raw);
              rowsOut = rows.length;
              console.log(accountLine(t.clientName, part, rows.length, window));
              if (!dryRun) { const cov = await storeShareDays(c, t.clientId, accountId, rows, window, note); if (cov.restarted) problems.push(`${t.clientName} ${part}: the last good read was more than a day before this window, so coverage restarts at ${cov.coveredFrom}`); }
            } else {
              const kind = part === "segment_hours" ? "hour" : "device";
              const rows = buildSegmentRows(raw, kind, report);
              rowsOut = rows.length;
              console.log(accountLine(t.clientName, part, rows.length, window));
              if (!dryRun) { const cov = await storeSegmentDays(c, t.clientId, accountId, kind, rows, window, note); if (cov.restarted) problems.push(`${t.clientName} ${part}: the last good read was more than a day before this window, so coverage restarts at ${cov.coveredFrom}`); }
            }
          } else if (part === "keyword_quality") {
            window = windowEndingYesterday(today, daysArg);
            const list = await customer.query(KEYWORD_QUALITY_GAQL);
            const arr = Array.isArray(list) ? list : [];
            if (arr.length >= MAX_ROWS) throw new Error(`the ${part} read came back at the ${MAX_ROWS}-row ceiling, so it cannot be called complete and nothing was written`);
            const rows = buildQualityRows(arr, report);
            rowsOut = rows.length;
            console.log(accountLine(t.clientName, part, rows.length, window));
            if (!dryRun) await storeKeywordQuality(c, t.clientId, accountId, rows, window);
          } else {
            window = windowEndingYesterday(today, daysArg);
            let list: any;
            let note = "";
            try {
              list = await customer.query(fillWindow(GEO_GAQL, window));
            } catch (first) {
              // The finer place is the optional part: if the platform refuses it with this view, read the country alone and say so.
              list = await customer.query(fillWindow(GEO_GAQL_COUNTRY_ONLY, window));
              note = `finer places not read (${(first instanceof Error ? first.message : String(first)).slice(0, 80)})`;
            }
            const arr = Array.isArray(list) ? list : [];
            if (arr.length >= MAX_ROWS) throw new Error(`the ${part} read came back at the ${MAX_ROWS}-row ceiling, so it cannot be called complete and nothing was written`);
            const rows = buildGeoRows(arr);
            rowsOut = rows.length;
            console.log(accountLine(t.clientName, part, rows.length, window) + (note ? ` (${note})` : ""));
            if (note) problems.push(`${t.clientName} ${part}: ${note}`);
            if (!dryRun) await storeGeo(c, t.clientId, accountId, rows, window, note);
          }
          for (const u of report.slice(0, 3)) problems.push(`${t.clientName}: ${u.field} = ${u.raw} stored as UNRECOGNISED`);
          okParts += 1;
          totalRows += rowsOut;
          if (dryRun) console.log(`      (dry run, nothing written)`);
        } catch (e) {
          // One part must not take the others down, and a failure is a row that says so, never a clean read.
          failedParts += 1;
          const msg = e instanceof Error ? e.message : String(e);
          problems.push(`${t.clientName} ${part} failed: ${msg.slice(0, 200)}`);
          console.log(`  ⚠ ${t.clientName} (${part}): ${msg.slice(0, 200)}`);
          if (!dryRun) await recordShareFailure(c, t.clientId, accountId, part, today, msg).catch(() => {});
        }
      }
      if (okParts > 0) read += 1;
    }

    console.log(`\n${"─".repeat(72)}`);
    console.log(`${read}/${targets.length} account(s) read · ${totalRows} row(s)${failedParts ? ` · ${failedParts} part(s) failed` : ""}`);
    for (const p of problems) console.log(`  · ${p}`);
    if (dryRun) { console.log(`\nDry run complete — nothing written.`); return; }

    emitJobSummary(formatJobSummary(
      { accounts: targets.length, read, rows: totalRows, failed: failedParts },
      read === 0 ? "no account could be read — no impression share, quality score or segment was captured for any client today" : `${read}/${targets.length} account(s) read, ${totalRows} rows`,
    ));
    if (read === 0) process.exit(1);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

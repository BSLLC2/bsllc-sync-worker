#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { openCustomer } from "./apply-ads-changes.js";
import { mappedAccounts } from "./ads/store.js";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";
import {
  CLICK_GAQL, MAX_DAY_ROWS, NO_ACCOUNTS_NOTE, PLATFORM, accountLine, ensureClickTables, hasSpan, keepKnown, loadClickCoverage,
  loadKnownClickIds, readDays, recordClickFailure, storeClicks,
} from "./ads/click-map.js";

/**
 * Place each known click id on the campaign it came from.
 *
 * READ-ONLY: one SELECT per account per day; nothing is written to any ad platform. The reasoning, the keep-only-a-lead rule and
 * the coverage record are in src/ads/click-map.ts.
 *
 *   npm run ads-click-map                      (every mapped account)
 *   npm run ads-click-map -- --client=slug     (one account; stamps no book-wide heartbeat)
 *   npm run ads-click-map -- --days=30         (fewer days than the default)
 *   npm run ads-click-map -- --dry-run         (read and print, write nothing)
 */
function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}
const hasFlag = (name: string) => process.argv.slice(2).includes(`--${name}`);
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

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
    if (!dryRun) await ensureClickTables(c);
    const targets = await mappedAccounts(c, PLATFORM, onlyClient || undefined);
    if (!targets.length) {
      console.log(`No mapped ${PLATFORM} accounts${onlyClient ? ` for ${onlyClient}` : ""}.`);
      emitJobSummary(formatJobSummary({ accounts: 0, read: 0, rows: 0 }, NO_ACCOUNTS_NOTE));
      return;
    }
    console.log(`Ads click map · ${targets.length} account(s) · ${today}`);
    console.log(`READ-ONLY — every query is a SELECT. Nothing is written to any ad account. Only a click id already on one of this client's enquiries is kept.\n`);

    let read = 0, failed = 0, totalKept = 0;
    const problems: string[] = [];
    for (const t of targets) {
      const accountId = digitsOnly(t.accountId);
      try {
        const known = await loadKnownClickIds(c, slugify(t.clientName), today);
        const prev = await loadClickCoverage(c, accountId).catch((e) => { if (dryRun) return null; throw e; });
        const days = readDays(today, !hasSpan(prev), daysArg);
        const window = { start: days[0]!, end: days[days.length - 1]! };
        if (!known.size) {
          // Nothing to place, and that is a read: the coverage still moves so a lead that arrives later is not mistaken for unread.
          console.log(accountLine(t.clientName, days.length, 0, 0, "no enquiry carries a click id yet"));
          if (!dryRun) { await storeClicks(c, t.clientId, accountId, [], window, days.length, "no known click id"); read += 1; }
          continue;
        }
        const customer = await openCustomer(api, cfg, accountId);
        const kept = new Map<string, ReturnType<typeof keepKnown>[number]>();
        for (const day of days) {
          const raw = await customer.query(CLICK_GAQL.replace("{{day}}", day));
          const list = Array.isArray(raw) ? raw : [];
          if (list.length >= MAX_DAY_ROWS) {
            // A truncated day written as complete would turn every missing click into a click that never happened.
            throw new Error(`${day} came back at the ${MAX_DAY_ROWS}-row ceiling, so it cannot be called complete and nothing was written`);
          }
          for (const r of keepKnown(list, known)) kept.set(r.gclid, r);
        }
        const rows = Array.from(kept.values());
        read += 1; totalKept += rows.length;
        console.log(accountLine(t.clientName, days.length, rows.length, known.size, hasSpan(prev) ? "" : "first run, backfilled"));
        if (dryRun) { console.log(`      (dry run, nothing written)`); continue; }
        const cov = await storeClicks(c, t.clientId, accountId, rows, window, days.length, `${rows.length} of ${known.size} known click ids, ${window.start} to ${window.end}`);
        if (cov.restarted) problems.push(`${t.clientName}: the last good read was more than a day before this window, so coverage restarts at ${cov.coveredFrom}`);
      } catch (e) {
        failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        problems.push(`${t.clientName} failed: ${msg.slice(0, 200)}`);
        console.log(`  ⚠ ${t.clientName}: ${msg.slice(0, 200)}`);
        if (!dryRun) await recordClickFailure(c, t.clientId, accountId, today, msg).catch(() => {});
      }
    }

    console.log(`\n${"─".repeat(72)}`);
    console.log(`${read}/${targets.length} account(s) read · ${totalKept} click${totalKept === 1 ? "" : "s"} placed${failed ? ` · ${failed} failed` : ""}`);
    for (const p of problems) console.log(`  · ${p}`);
    if (dryRun) { console.log(`\nDry run complete — nothing written.`); return; }

    emitJobSummary(formatJobSummary(
      { accounts: targets.length, read, rows: totalKept, failed },
      read === 0 ? "no account could be read — no click was placed on a campaign for any client today" : `${read}/${targets.length} account(s) read, ${totalKept} clicks placed`,
    ));
    if (read === 0) process.exit(1);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

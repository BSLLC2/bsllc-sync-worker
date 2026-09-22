#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { openCustomer } from "./apply-ads-changes.js";
import { mappedAccounts } from "./ads/store.js";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";
import {
  CHANGE_LOOKBACK_DAYS, CHANGE_ROW_LIMIT, captureWindows, changeGaql,
  normalizeChangeEvent, recordScan, recordScanFailure, storeChangeEvents,
  type CapturedChange,
} from "./ads/change-history.js";

/**
 * Capture what changed in each mapped ad account, including the changes we did
 * not make.
 *
 * ── The gap ────────────────────────────────────────────────────────────────
 *
 * Every record of change in the dashboard covered changes made through its own
 * approve queue. A subcontractor logging into Google Ads and raising a budget
 * by hand left no trace, so the settle-window guard read a campaign somebody
 * moved on Tuesday as quiet on Friday, the after-check credited us with
 * somebody else's work, and nothing told a vendor what to leave alone.
 *
 * ── THE CADENCE, AND WHY IT IS NOT DAILY ───────────────────────────────────
 *
 * `change_event` is capped at 30 days and anything older is DELETED, so a day
 * not captured is account history lost for good. This runs every SIX HOURS and
 * re-reads the WHOLE thirty days every time. Re-reading is free — rows are
 * keyed on the platform's own identity for the event, so a second run writes
 * nothing — and it means nothing is lost until every run inside a thirty-day
 * stretch has failed, while the heartbeat SLA fires after two missed firings.
 * A daily job reading only the previous day would lose a week to a week of
 * failures.
 *
 * Six hours is also what the consumer needs. The settle-window guard is the
 * thing this feeds, and a vendor's Tuesday change has to be visible before
 * Friday's approval.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 *
 * `change_event` is a SELECT. This job writes nothing to any ad account,
 * proposes nothing and applies nothing.
 *
 *   npm run ads-change-history
 *   npm run ads-change-history -- --client=ohio-community-health
 *   npm run ads-change-history -- --dry-run     (read and print, write nothing)
 */

const PLATFORM = "google_ads";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}
const hasFlag = (name: string) => process.argv.slice(2).includes(`--${name}`);

async function captureAccount(
  customer: any,
  windows: Array<[string, string]>,
): Promise<{ events: CapturedChange[]; undated: number; cappedWindows: string[] }> {
  const byKey = new Map<string, CapturedChange>();
  let undated = 0;
  const cappedWindows: string[] = [];

  for (const [from, to] of windows) {
    const rows = await customer.query(changeGaql(from, to));
    // A window that comes back AT the row cap is a window we cannot claim to
    // have read in full. It is NAMED rather than assumed complete — a silent
    // truncation would store a hole and nothing would ever say so.
    if (Array.isArray(rows) && rows.length >= CHANGE_ROW_LIMIT) cappedWindows.push(`${from}..${to}`);
    for (const r of rows ?? []) {
      const e = normalizeChangeEvent(r);
      if (!e) { undated += 1; continue; }
      // Windows are inclusive at both ends, so the same event can land in two
      // of them. Collapsing on the key here keeps the insert count honest.
      byKey.set(e.eventKey, e);
    }
  }
  return { events: Array.from(byKey.values()), undated, cappedWindows };
}

async function main() {
  const cfg = loadConfig();
  const onlyClient = arg("client") ?? "";
  const dryRun = hasFlag("dry-run");
  const api = new GoogleAdsApi({
    client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken,
  });

  const c = new pg.Client({ connectionString: cfg.databaseUrl });
  await c.connect();
  try {
    const targets = await mappedAccounts(c, PLATFORM, onlyClient || undefined);
    if (!targets.length) {
      console.log(`No mapped ${PLATFORM} accounts${onlyClient ? ` for ${onlyClient}` : ""}.`);
      // Said out loud on the heartbeat. A run that succeeded across ZERO
      // accounts is green, recent, and means nothing at all.
      emitJobSummary(formatJobSummary(
        { accounts: 0, read: 0, events: 0, new: 0 },
        "no mapped ad account to read — an empty change history says nothing about anyone's account",
      ));
      return;
    }

    const now = new Date();
    const windows = captureWindows(now);
    const windowFrom = windows[0]![0];
    const windowTo = windows[windows.length - 1]![1];
    console.log(
      `Change history capture · ${targets.length} account(s) · ${windowFrom}..${windowTo} `
      + `(${CHANGE_LOOKBACK_DAYS}-day cap, ${windows.length} windows)`,
    );
    console.log(`READ-ONLY — change_event is a SELECT. Nothing is written to any ad account.\n`);

    let read = 0, totalEvents = 0, totalNew = 0, restarts = 0, digestKeys = 0;
    const problems: string[] = [];

    for (const t of targets) {
      const accountId = digitsOnly(t.accountId);
      try {
        const customer = await openCustomer(api, cfg, accountId);
        const { events, undated, cappedWindows } = await captureAccount(customer, windows);
        read += 1;
        totalEvents += events.length;
        digestKeys += events.filter((e) => !e.keyFromPlatform).length;

        // What a person can act on: how many changes, how many were made by
        // hand rather than by a machine, and when the newest one was. NO
        // ADDRESS IS PRINTED — the count of distinct actors is the useful half
        // and the identities are not a log's business.
        const byHand = events.filter((e) => e.actorKind === "person").length;
        const external = events.filter((e) => e.actorInternal === false).length;
        const newest = events.reduce<string | null>((a, e) => (a && a > e.changedAt ? a : e.changedAt), null);

        if (dryRun) {
          console.log(
            `  ${t.clientName}: ${events.length} change(s) · ${byHand} by hand · ${external} from outside this company`
            + `${newest ? ` · newest ${newest.slice(0, 10)}` : ""} · (dry run, nothing written)`,
          );
          continue;
        }

        const { inserted } = await storeChangeEvents(c, t.clientId, PLATFORM, accountId, events);
        totalNew += inserted;
        const note = `${events.length} events, ${byHand} by hand, ${inserted} new`;
        const { coveredFrom, restarted } = await recordScan(c, t.clientId, PLATFORM, accountId, windowFrom, windowTo, note);
        if (restarted) restarts += 1;

        console.log(
          `  ${t.clientName}: ${events.length} change(s) · ${byHand} by hand · ${external} from outside this company`
          + ` · ${inserted} new · covered from ${coveredFrom}`
          + `${restarted ? " (coverage restarted — the previous scan was older than the platform's own cap, so the gap is gone)" : ""}`,
        );
        if (undated) problems.push(`${t.clientName}: ${undated} event(s) carried no date and were not stored`);
        for (const w of cappedWindows) {
          problems.push(`${t.clientName}: window ${w} came back at the ${CHANGE_ROW_LIMIT}-row cap — read it again in narrower windows before trusting that stretch`);
        }
      } catch (e) {
        // One account's credentials or API hiccup must not take the run down
        // for every other client. The scan row is marked failed rather than
        // moved forward, so every reading keeps telling the truth about how
        // far back it can see.
        const msg = e instanceof Error ? e.message : String(e);
        problems.push(`${t.clientName} [${accountId}] failed: ${msg.slice(0, 200)}`);
        console.log(`  ⚠ ${t.clientName}: ${msg.slice(0, 200)}`);
        if (!dryRun) await recordScanFailure(c, PLATFORM, accountId, msg).catch(() => {});
      }
    }

    console.log(`\n${"─".repeat(72)}`);
    console.log(
      `${read}/${targets.length} account(s) read · ${totalEvents} change(s) in the window · ${totalNew} new row(s)`
      + `${totalNew === 0 && read > 0 ? " — nothing new, which is what a second run inside the window looks like" : ""}`,
    );
    if (restarts) console.log(`${restarts} account(s) restarted their coverage after a gap longer than the ${CHANGE_LOOKBACK_DAYS}-day cap.`);
    if (digestKeys) console.log(`${digestKeys} event(s) carried no resource name and were keyed on a digest of their own fields.`);
    for (const p of problems) console.log(`  · ${p}`);
    if (dryRun) { console.log(`\nDry run complete — nothing written.`); return; }

    emitJobSummary(formatJobSummary(
      { accounts: targets.length, read, events: totalEvents, new: totalNew },
      read === 0
        ? "no account could be read — the change history is not being captured and the 30-day cap is running"
        : `${read}/${targets.length} account(s) read, ${totalEvents} change(s) in the last ${CHANGE_LOOKBACK_DAYS} days`,
    ));
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

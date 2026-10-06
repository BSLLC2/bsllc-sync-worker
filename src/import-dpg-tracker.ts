#!/usr/bin/env tsx
import "dotenv/config";
import { runDashboardSync, type SyncEntry } from "./emit.js";
import { readTrackerSheet } from "./dpg-tracker-read.js";
import {
  DEAL_CAP, DPG_CLIENT_SLUG, FINDINGS, billingWindowStart, buildEntries, buildSummary, dpgSheetId, dpgTabGid,
  hasStop, readingFindings, summaryLine, type Finding,
} from "./dpg-tracker.js";

/**
 * Diesel Power Group's attributed closed deals, from the "DPG — Lead to
 * Closed-Won Tracker" sheet a person at BS LLC keeps by matching DPG's Odoo
 * sales against our own lead log. It stands in for DPG's Dynamics 365 origin
 * field until that is fixed. Reads the sheet (read-only, the shared service
 * account), writes monthly won revenue by CLOSED date and a summary through the
 * dashboard's sync contract. Never writes to the sheet.
 *
 * A heading it cannot find, a sheet it cannot open, or a tracker too long to
 * read is a STOP with a named cause: nothing is written, the last good figures
 * stand, and the heartbeat note says why. Its last printed line is that note
 * (`DPG-SHEET ok|warn|stop <cause>: sentence`), a contract with the dashboard.
 * It prints counts and dates only: never a name, a phone number or an email.
 *
 *   npm run import-dpg-tracker -- --dry-run     # read + print, write nothing
 *   DPG_TRACKER_SHEET_ID / DPG_TRACKER_TAB_GID / DPG_TRACKER_TAB / DPG_BILLING_WINDOW_START (all optional)
 */
const businessDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function finish(findings: Finding[], line: string): never {
  for (const f of findings) {
    console.log(`\n[${f.level}] ${f.code} (${f.who === "us" ? "ours to fix" : f.who === "client" ? "the client's to fix" : f.who === "google" ? "Google's" : "find out first"}): ${f.line}`);
    f.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  }
  // The heartbeat reads the LAST line. Keep it last.
  console.log(`\n${line}`);
  process.exit(hasStop(findings) ? 1 : 0);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const client = arg("client") ?? DPG_CLIENT_SLUG;
  const today = businessDay();
  const windowStart = billingWindowStart();
  console.log(`DPG tracker import${dryRun ? " (dry-run)" : ""}, window opens ${windowStart}, today ${today}`);

  const res = await readTrackerSheet(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, {
    sheetId: dpgSheetId(), gid: dpgTabGid(), tabOverride: process.env.DPG_TRACKER_TAB?.trim() || null, today, windowStart,
  });
  if (res.kind === "stop") finish([res.finding], summaryLine([res.finding], { tab: res.tab, reading: null }));

  const r = res.reading;
  const warns = readingFindings(r);
  console.log(`Read "${res.tab}": ${r.rows} rows, ${r.leadRows} with a first-contact date, newest first contact ${r.newestFirstContact ?? "none"}, newest closed date ${r.newestClosed ?? "none"}.`);
  console.log(`Counted: ${r.counted.length} won in window, ${dollars(r.countedCents)}. Fee on ${r.feeDeals} (cap ${DEAL_CAP}), ${dollars(r.feeCents)}.${r.overCap ? ` ${r.overCap} past the cap.` : ""}`);
  console.log(`Pending (not counted): ${r.pending.length}, ${dollars(r.pendingCents)}. Refused: ${r.problems.length}. Other status: ${r.otherStatus}.`);
  console.log(res.driveChecked ? `Sheet last edited ${res.sheetEditedAt ?? "(Drive gave no time)"}.` : "Sheet edit time not available (Google Drive did not answer).");

  const summary = buildSummary(r, new Date().toISOString(), res.sheetEditedAt);
  const entries = buildEntries(client, r, summary, today);
  for (const e of entries) {
    if (e.external_id === "dpg-tracker-summary") continue;
    console.log(`  ${e.period_start.slice(0, 7)}: ${e.metrics["manual.tracker_won_deals"]} won, ${dollars(Number(e.metrics["manual.revenue_system_cents"]))}`);
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  const dashboardDir = process.env.DASHBOARD_DIR?.trim();
  if (!databaseUrl || !dashboardDir) {
    const f = FINDINGS.check_crashed("DATABASE_URL or DASHBOARD_DIR is not set, so nothing could be recorded");
    finish([f], summaryLine([f], { tab: res.tab, reading: r }));
  }
  const code = runDashboardSync({ databaseUrl: databaseUrl!, dashboardDir: dashboardDir! }, entries as SyncEntry[], { dryRun });
  if (code !== 0) {
    const f = FINDINGS.check_crashed(`the dashboard sync exited ${code}`);
    finish([f], summaryLine([f], { tab: res.tab, reading: r }));
  }
  finish(warns, summaryLine(warns, { tab: res.tab, reading: r }));
}

main().catch((e) => {
  const why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ");
  console.error(`DPG-SHEET stop check_crashed: the import itself failed (${why.slice(0, 150)}).`);
  process.exit(1);
});

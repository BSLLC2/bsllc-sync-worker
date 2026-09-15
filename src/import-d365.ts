#!/usr/bin/env tsx
import "dotenv/config";
import { runDashboardSync, type SyncEntry } from "./emit.js";
import { monthSnapshot } from "./dates.js";
import { loadD365Config, fetchClosedWon, classify, type Bucket } from "./d365.js";
import { detectSampleRecords, suspicionLine, verdictFor, type CrmRecordShape } from "./sample-detect.js";

/**
 * D365 → dashboard: Closed Won revenue for DPG, attributed off the Contact's
 * first-touch source. Emits three report buckets per month (bsllc / other /
 * unknown) plus manual (excluded) so totals reconcile, and a billable
 * convenience = bsllc + other. See docs/D365_CLOSED_WON_BRIEF.md.
 *
 * ALSO emits one entry per deal (metric "d365.deal_won_cents" + a text label
 * and bucket), tagged with the opportunity id as `item_id` so a case study
 * can show named, dollar-valued wins instead of only a monthly total. Safe
 * to re-run daily even though fetchClosedWon() re-pulls every deal since the
 * 9/3 floor each time -- metric_snapshots dedupes on (client, source,
 * metricKey, item_id), so already-recorded deals are silently skipped
 * instead of piling up as duplicates.
 *
 * Usage:
 *   npm run import-d365 -- [--slug=diesel-power-group] [--dry-run]
 */

const DEFAULT_SLUG = "diesel-power-group";


/**
 * A run that produced no figures, planted anyway, for the current month.
 *
 * `no_data` is a first-class state across this system (see `_sync.status` in
 * the dashboard's sync, and the connector-failing rule: newest error strictly
 * newer than newest live/no_data). It means "the pipeline worked and the
 * account was empty" — which is a real, reportable answer about a CRM, and
 * the opposite of never having run. The GSC and Search importers already
 * plant it on an empty window; this matches them.
 */
function emptyRun(slug: string, state: "no_data" | "error", error: string | null): SyncEntry {
  const { start, end, syncedAt } = monthSnapshot(new Date().toISOString().slice(0, 7));
  return {
    client_id: slug,
    source: "d365",
    period_start: start,
    period_end: end,
    synced_at: syncedAt,
    data_state: state,
    error_message: error,
    metrics: {},
  };
}

interface Agg { revCents: Record<Bucket, number>; deals: Record<Bucket, number> }
function emptyAgg(): Agg {
  return {
    revCents: { bsllc: 0, other: 0, manual: 0, unknown: 0 },
    deals: { bsllc: 0, other: 0, manual: 0, unknown: 0 },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const slug = (argv.find((a) => a.startsWith("--slug="))?.slice("--slug=".length) || DEFAULT_SLUG).trim();

  const databaseUrl = process.env.DATABASE_URL?.trim();
  const dashboardDir = process.env.DASHBOARD_DIR?.trim();
  if (!databaseUrl || !dashboardDir) throw new Error("Missing DATABASE_URL / DASHBOARD_DIR.");

  const cfg = loadD365Config();
  console.log(`D365 import — Closed Won for ${slug}${dryRun ? " (dry-run)" : ""}`);

  // Every run ends on the record, in one of three states, because the app
  // cannot tell them apart from the outside: live (figures), no_data (we got
  // in, nothing has closed) or error (we did not get in). Before this, a
  // successful empty read planted NOTHING, so a connector that authenticated
  // and answered every single morning was indistinguishable from one that had
  // never run — which is also why this client's CRM launch step read as not
  // connected while the connection worked perfectly.
  let opps: Awaited<ReturnType<typeof fetchClosedWon>>;
  try {
    opps = await fetchClosedWon(cfg);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    console.error(`  FAILED to read D365: ${msg}`);
    const code = runDashboardSync({ databaseUrl, dashboardDir }, [emptyRun(slug, "error", msg)], { dryRun });
    process.exit(code || 1);
  }
  console.log(`  fetched ${opps.length} Closed Won opportunit${opps.length === 1 ? "y" : "ies"}.`);

  // Demo data the CRM shipped with is revenue that never happened, and until
  // now nothing here looked for it at all — every stock record in the org went
  // straight into the monthly totals. The detector works on how a row ARRIVED
  // rather than on a list of stock company names, because the name list is
  // what failed: an org whose demo records carried no catalogue word in any
  // field read as entirely genuine. See src/sample-detect.ts.
  const verdicts = detectSampleRecords(
    opps.map((o): CrmRecordShape => ({
      id: o.opportunityid,
      text: [o.name, o.parentcontactid?.fullname],
      writtenAt: o.createdon ?? null,
      writtenBy: o._createdby_value ?? null,
      importSequenceNumber: o.importsequencenumber ?? null,
      overriddenCreatedOn: o.overriddencreatedon ?? null,
      businessDate: (o.actualclosedate ?? o.overriddencreatedon ?? o.createdon ?? "").slice(0, 10) || null,
    })),
  );

  const byMonth = new Map<string, Agg>();
  const dealSyncs: SyncEntry[] = [];
  let noCloseDate = 0, noContact = 0, confirmedSamples = 0, suspectDeals = 0, suspectCents = 0;
  const bucketTotals: Record<Bucket, number> = { bsllc: 0, other: 0, manual: 0, unknown: 0 };

  for (const o of opps) {
    if (!o.actualclosedate) { noCloseDate++; continue; }
    const verdict = verdictFor(verdicts, o.opportunityid);
    // Confirmed demo data is dropped from every total. A SUSPECTED row is
    // kept: it is equally the shape of a client migrating their own history,
    // and quietly deleting a client's real revenue is the same size of
    // mistake as quietly counting demo data. It is counted and said out loud.
    if (verdict.confirmed) { confirmedSamples++; continue; }
    if (verdict.suspect) { suspectDeals++; suspectCents += Math.round((o.actualvalue ?? 0) * 100); }
    const contact = o.parentcontactid ?? null;
    if (!contact) noContact++;
    const bucket = classify(contact?.new_firsttouchsource ?? null, contact?.createdon ?? null);
    const ym = o.actualclosedate.slice(0, 7); // YYYY-MM
    const cents = Math.round((o.actualvalue ?? 0) * 100);
    const agg = byMonth.get(ym) ?? emptyAgg();
    agg.revCents[bucket] += cents;
    agg.deals[bucket] += 1;
    byMonth.set(ym, agg);
    bucketTotals[bucket] += 1;

    // One row per deal, named and dollar-valued, so a case study can list
    // real wins instead of only a monthly total. item_id dedupes re-runs.
    const closeDate = o.actualclosedate.slice(0, 10);
    const label = [contact?.fullname?.trim() || null, o.name?.trim() || null].filter(Boolean).join(" — ") || "(unnamed)";
    // A deal closed TODAY must not be stamped noon-today (up to 4h ahead of
    // the 07:50 UTC cron, which reads as a future timestamp) — use now.
    const closedToday = closeDate >= new Date().toISOString().slice(0, 10);
    dealSyncs.push({
      client_id: slug,
      source: "d365",
      item_id: o.opportunityid,
      period_start: closeDate,
      period_end: closeDate,
      synced_at: closedToday ? new Date().toISOString() : `${closeDate}T12:00:00.000Z`,
      data_state: "live",
      error_message: null,
      metrics: {
        "d365.deal_won_cents": cents,
        "d365.deal_won_label": label,
        "d365.deal_won_bucket": bucket,
      },
    });
  }

  console.log(
    `  classified: ${bucketTotals.bsllc} BS LLC · ${bucketTotals.other} other · ` +
      `${bucketTotals.unknown} unknown(pre-field) · ${bucketTotals.manual} manual(excluded)` +
      `${noContact ? ` · ${noContact} with no Contact` : ""}` +
      `${noCloseDate ? ` · ${noCloseDate} skipped (no close date)` : ""}` +
      `${confirmedSamples ? ` · ${confirmedSamples} skipped (confirmed sample/demo record)` : ""}`,
  );
  const suspicion = suspicionLine(suspectDeals, suspectCents, opps.length);
  if (suspicion) console.log(`  ${suspicion}`);

  const syncs: SyncEntry[] = [];
  for (const [ym, a] of Array.from(byMonth.entries()).sort()) {
    // A deal closed in the CURRENT, in-progress month — monthSnapshot caps
    // that month at today so nothing is stamped in the future.
    const { start, end, syncedAt } = monthSnapshot(ym);
    syncs.push({
      client_id: slug,
      source: "d365",
      period_start: start,
      period_end: end,
      synced_at: syncedAt,
      data_state: "live",
      error_message: null,
      metrics: {
        "d365.cw_revenue_bsllc_cents": a.revCents.bsllc,
        "d365.cw_revenue_other_cents": a.revCents.other,
        "d365.cw_revenue_unknown_cents": a.revCents.unknown,
        "d365.cw_revenue_manual_cents": a.revCents.manual,
        "d365.cw_revenue_billable_cents": a.revCents.bsllc + a.revCents.other,
        "d365.cw_deals_bsllc": a.deals.bsllc,
        "d365.cw_deals_other": a.deals.other,
        "d365.cw_deals_unknown": a.deals.unknown,
        "d365.cw_deals_manual": a.deals.manual,
      },
    });
  }

  const allSyncs = syncs.concat(dealSyncs);
  if (!allSyncs.length) {
    console.log(
      "No Closed Won opportunities with a close date — planting a no_data snapshot for this month so that a connector which works and has nothing to report is not read as one that has never run.",
    );
    const code = runDashboardSync({ databaseUrl, dashboardDir }, [emptyRun(slug, "no_data", null)], { dryRun });
    process.exit(code);
  }
  console.log(`\nPlanting ${syncs.length} monthly snapshot(s) + ${dealSyncs.length} per-deal row(s).`);
  const code = runDashboardSync({ databaseUrl, dashboardDir }, allSyncs, { dryRun });
  process.exit(code);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

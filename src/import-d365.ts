#!/usr/bin/env tsx
import "dotenv/config";
import { runDashboardSync, type SyncEntry } from "./emit.js";
import { loadD365Config, fetchClosedWon, classify, type Bucket } from "./d365.js";

/**
 * D365 → dashboard: Closed Won revenue for DPG, attributed off the Contact's
 * first-touch source. Emits three report buckets per month (bsllc / other /
 * unknown) plus manual (excluded) so totals reconcile, and a billable
 * convenience = bsllc + other. See docs/D365_CLOSED_WON_BRIEF.md.
 *
 * Usage:
 *   npm run import-d365 -- [--slug=diesel-power-group] [--dry-run]
 */

const DEFAULT_SLUG = "diesel-power-group";

function monthBounds(ym: string): { start: string; end: string } {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${String(last).padStart(2, "0")}` };
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

  const opps = await fetchClosedWon(cfg);
  console.log(`  fetched ${opps.length} Closed Won opportunit${opps.length === 1 ? "y" : "ies"}.`);

  const byMonth = new Map<string, Agg>();
  let noCloseDate = 0, noContact = 0;
  const bucketTotals: Record<Bucket, number> = { bsllc: 0, other: 0, manual: 0, unknown: 0 };

  for (const o of opps) {
    if (!o.actualclosedate) { noCloseDate++; continue; }
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
  }

  console.log(
    `  classified: ${bucketTotals.bsllc} BS LLC · ${bucketTotals.other} other · ` +
      `${bucketTotals.unknown} unknown(pre-field) · ${bucketTotals.manual} manual(excluded)` +
      `${noContact ? ` · ${noContact} with no Contact` : ""}` +
      `${noCloseDate ? ` · ${noCloseDate} skipped (no close date)` : ""}`,
  );

  const syncs: SyncEntry[] = [];
  for (const [ym, a] of Array.from(byMonth.entries()).sort()) {
    const { start, end } = monthBounds(ym);
    syncs.push({
      client_id: slug,
      source: "d365",
      period_start: start,
      period_end: end,
      synced_at: `${end}T12:00:00.000Z`,
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

  if (!syncs.length) {
    console.log("No Closed Won opportunities with a close date — nothing to plant.");
    process.exit(0);
  }
  console.log(`\nPlanting ${syncs.length} monthly snapshot(s).`);
  const code = runDashboardSync({ databaseUrl, dashboardDir }, syncs, { dryRun });
  process.exit(code);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

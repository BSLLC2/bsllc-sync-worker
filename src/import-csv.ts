#!/usr/bin/env tsx
import "dotenv/config";
import { readFileSync } from "node:fs";
import { runDashboardSync, type SyncEntry } from "./emit.js";

/**
 * One-time history importer. Reads a Google Ads UI "Report Editor" CSV export
 * (rows = Week, columns = Cost / Impr. / Clicks / Conversions / …) and plants
 * it as backdated snapshots through the dashboard's `npm run sync` seam. Uses
 * ZERO Google Ads API quota — it never calls the API, it reads the CSV.
 *
 * To stay on the same scale as the live worker (which reports a trailing 30-day
 * window), each weekly row is emitted as a rolling 4-week (~30-day) sum, with
 * synced_at backdated to that week so the dashboard's WoW/MoM/QoQ trends line up.
 *
 * Usage:
 *   tsx src/import-csv.ts --file=data/och-weekly.csv \
 *       --client="Ohio Recovery Centers" --customer=8350689003 [--dry-run]
 */

interface Args {
  file: string;
  client: string;
  customer: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let file = "";
  let client = "";
  let customer = "";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--file=")) file = a.slice(7);
    else if (a === "--file") file = argv[++i]!;
    else if (a.startsWith("--client=")) client = a.slice(9);
    else if (a === "--client") client = argv[++i]!;
    else if (a.startsWith("--customer=")) customer = a.slice(11);
    else if (a === "--customer") customer = argv[++i]!;
    else if (a === "--dry-run") dryRun = true;
  }
  if (!file || !client || !customer) {
    throw new Error("Required: --file=<csv> --client=<name/slug> --customer=<digits>");
  }
  return { file, client, customer: customer.replace(/[^0-9]/g, ""), dryRun };
}

/** CSV line split that respects quoted fields containing commas ("2,211"). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Strip quotes, thousands commas and % signs, then parse. */
function num(s: string | undefined): number {
  if (s == null) return 0;
  const n = Number(s.replace(/["',%\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var ${name}.`);
  return v.trim();
}

function shiftDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

interface WeekRow {
  date: Date;
  cost: number;
  impr: number;
  clicks: number;
  conv: number;
}

const WINDOW_WEEKS = 4; // ~30-day trailing window, matching the live worker

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dashboardDir = req("DASHBOARD_DIR");
  const databaseUrl = req("DATABASE_URL");

  const lines = readFileSync(args.file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");

  // The export has a couple of preamble lines; find the real header.
  const headerIdx = lines.findIndex((l) => /(^|,)Week(,|$)/.test(l) && /Cost/i.test(l));
  if (headerIdx < 0) throw new Error("Could not find a header row containing 'Week' and 'Cost'.");
  const header = parseCsvLine(lines[headerIdx]!).map((h) => h.trim());
  const idx = (pred: (h: string) => boolean) => header.findIndex(pred);
  const iWeek = idx((h) => /^week$/i.test(h));
  const iCost = idx((h) => /^cost$/i.test(h));
  const iImpr = idx((h) => /^impr/i.test(h));
  const iClicks = idx((h) => /^clicks$/i.test(h));
  const iConv = idx((h) => /^conversions$/i.test(h));
  if ([iWeek, iCost, iImpr, iClicks, iConv].some((i) => i < 0)) {
    throw new Error(`Missing a required column. Found header: ${header.join(", ")}`);
  }

  const weeks: WeekRow[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const f = parseCsvLine(line);
    const ds = f[iWeek]?.trim();
    if (!ds || !/^\d{4}-\d{2}-\d{2}$/.test(ds)) continue;
    weeks.push({
      date: new Date(`${ds}T00:00:00Z`),
      cost: num(f[iCost]),
      impr: num(f[iImpr]),
      clicks: num(f[iClicks]),
      conv: num(f[iConv]),
    });
  }
  weeks.sort((a, b) => a.date.getTime() - b.date.getTime());

  const syncs: SyncEntry[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const asOf = weeks[i]!.date;
    const win = weeks.slice(Math.max(0, i - WINDOW_WEEKS + 1), i + 1);
    const cost = win.reduce((s, w) => s + w.cost, 0);
    const impr = win.reduce((s, w) => s + w.impr, 0);
    const clicks = win.reduce((s, w) => s + w.clicks, 0);
    const conv = win.reduce((s, w) => s + w.conv, 0);

    const syncedAt = new Date(asOf);
    syncedAt.setUTCHours(12);
    const base = {
      client_id: args.client,
      source: "google_ads" as const,
      external_id: args.customer,
      period_start: shiftDays(asOf, -(WINDOW_WEEKS * 7)).toISOString(),
      period_end: asOf.toISOString(),
      synced_at: syncedAt.toISOString(),
    };

    // Pre-launch weeks with no activity are recorded as no_data, not a row of
    // zeros, so scoring/ trends skip them instead of reading a real zero.
    if (cost === 0 && impr === 0 && clicks === 0) {
      syncs.push({ ...base, data_state: "no_data", error_message: null, metrics: {} });
      continue;
    }

    syncs.push({
      ...base,
      data_state: "live",
      error_message: null,
      metrics: {
        "ads.cost_micros": Math.round(cost * 1_000_000),
        "ads.impressions": impr,
        "ads.clicks": clicks,
        "ads.conversions": conv,
        // Recomputed over the 30-day window from raw components (never averaged).
        "ads.cost_per_conversion": conv > 0 ? Math.round((cost / conv) * 1_000_000) : null,
        "ads.ctr": impr > 0 ? clicks / impr : null,
        "ads.average_cpc": clicks > 0 ? Math.round((cost / clicks) * 1_000_000) : null,
      },
    });
  }

  const live = syncs.filter((s) => s.data_state === "live").length;
  console.log(
    `Parsed ${weeks.length} weeks → ${syncs.length} snapshots ` +
      `(${live} live) for ${args.client} [${args.customer}]`,
  );

  const code = runDashboardSync({ dashboardDir, databaseUrl }, syncs, { dryRun: args.dryRun });
  process.exit(code);
}

main();

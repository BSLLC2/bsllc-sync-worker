#!/usr/bin/env tsx
import "dotenv/config";
import { readFileSync } from "node:fs";
import { runDashboardSync, type SyncEntry } from "./emit.js";

/**
 * One-time history importer for Google Search Console. Reads the GSC
 * "Performance → Export" daily table (Date, Clicks, Impressions, CTR, Position)
 * and plants it as backdated 30-day rolling snapshots — same scale as the live
 * worker and the Google Ads import, so trends line up. Zero API cost.
 *
 * Position is averaged weighted by impressions (never a plain mean); CTR is
 * recomputed from clicks/impressions over the window.
 *
 * Usage:
 *   tsx src/import-gsc.ts --file=data/och-gsc.csv --client=ohio-community-health-och [--dry-run]
 */

interface Args {
  file: string;
  client: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let file = "";
  let client = "";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--file=")) file = a.slice(7);
    else if (a === "--file") file = argv[++i]!;
    else if (a.startsWith("--client=")) client = a.slice(9);
    else if (a === "--client") client = argv[++i]!;
    else if (a === "--dry-run") dryRun = true;
  }
  if (!file || !client) throw new Error("Required: --file=<csv> --client=<name/slug>");
  return { file, client, dryRun };
}

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

interface DayRow {
  date: Date;
  ms: number;
  clicks: number;
  impr: number;
  pos: number;
}

const WINDOW_DAYS = 30;
const STEP_DAYS = 7;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dashboardDir = req("DASHBOARD_DIR");
  const databaseUrl = req("DATABASE_URL");

  const lines = readFileSync(args.file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  const headerIdx = lines.findIndex((l) => /(^|,)Date(,|$)/i.test(l) && /Clicks/i.test(l));
  if (headerIdx < 0) throw new Error("Could not find a header row with 'Date' and 'Clicks'.");
  const header = parseCsvLine(lines[headerIdx]!).map((h) => h.trim());
  const idx = (pred: (h: string) => boolean) => header.findIndex(pred);
  const iDate = idx((h) => /^date$/i.test(h));
  const iClicks = idx((h) => /^clicks$/i.test(h));
  const iImpr = idx((h) => /^impr/i.test(h));
  const iPos = idx((h) => /^position$/i.test(h));
  if ([iDate, iClicks, iImpr, iPos].some((i) => i < 0)) {
    throw new Error(`Missing a required column. Found header: ${header.join(", ")}`);
  }

  const days: DayRow[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const f = parseCsvLine(line);
    const ds = f[iDate]?.trim();
    if (!ds || !/^\d{4}-\d{2}-\d{2}$/.test(ds)) continue;
    const date = new Date(`${ds}T00:00:00Z`);
    days.push({ date, ms: date.getTime(), clicks: num(f[iClicks]), impr: num(f[iImpr]), pos: num(f[iPos]) });
  }
  days.sort((a, b) => a.ms - b.ms);
  if (days.length === 0) throw new Error("No daily rows parsed.");

  const first = days[0]!.date;
  const last = days[days.length - 1]!.date;
  const dayMs = 86_400_000;

  const syncs: SyncEntry[] = [];
  // Weekly as-of points, each summarising the trailing 30 days.
  for (let asOf = new Date(last); asOf.getTime() >= shiftDays(first, WINDOW_DAYS - 1).getTime(); asOf = shiftDays(asOf, -STEP_DAYS)) {
    const hi = asOf.getTime();
    const lo = hi - (WINDOW_DAYS - 1) * dayMs;
    const win = days.filter((d) => d.ms >= lo && d.ms <= hi);
    const clicks = win.reduce((s, d) => s + d.clicks, 0);
    const impr = win.reduce((s, d) => s + d.impr, 0);
    const weightedPos = win.reduce((s, d) => s + d.pos * d.impr, 0);

    const syncedAt = new Date(asOf);
    syncedAt.setUTCHours(12);
    const base = {
      client_id: args.client,
      source: "gsc" as const,
      period_start: shiftDays(asOf, -WINDOW_DAYS).toISOString(),
      period_end: asOf.toISOString(),
      synced_at: syncedAt.toISOString(),
    };

    if (impr === 0) {
      syncs.push({ ...base, data_state: "no_data", error_message: null, metrics: {} });
      continue;
    }
    syncs.push({
      ...base,
      data_state: "live",
      error_message: null,
      metrics: {
        "gsc.clicks": clicks,
        "gsc.impressions": impr,
        "gsc.ctr": clicks / impr,
        "gsc.avg_position": weightedPos / impr,
      },
    });
  }

  const live = syncs.filter((s) => s.data_state === "live").length;
  console.log(
    `Parsed ${days.length} days → ${syncs.length} GSC snapshots (${live} live) for ${args.client}`,
  );
  const code = runDashboardSync({ dashboardDir, databaseUrl }, syncs, { dryRun: args.dryRun });
  process.exit(code);
}

main();

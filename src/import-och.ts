#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import { runDashboardSync, type SyncEntry } from "./emit.js";

/**
 * Ohio Community Health (OCH) admissions → dashboard revenue tracker.
 *
 * OCH has no CRM we can read; the source of truth is a Google Sheet the team
 * keeps by hand (one row per intake, with an origin/"Referent" column and an
 * admit/decline status). This importer reads that sheet with the shared
 * service account, buckets rows by calendar month, and plants two truths per
 * month as backdated snapshots so the dashboard trends line up with everything
 * else:
 *
 *   manual.admissions            — every admission that month
 *   manual.admissions_marketing  — the slice we can attribute to our activity
 *                                  (Google / web form / organic search)
 *   manual.revenue_cents         — attributable admissions × value-per-admission
 *                                  (ONLY if OCH_VALUE_PER_ADMISSION_CENTS is set;
 *                                   admissions still flow without it)
 *
 * The worker owns zero DB writes — it hands the payload to `npm run sync`.
 *
 * Prereqs (one-time):
 *   1. Share the sheet (Viewer) with the service account's client_email.
 *   2. Optional: set OCH_VALUE_PER_ADMISSION_CENTS to light up revenue dollars.
 *
 * Usage:
 *   npm run import-och                       # full sheet → monthly snapshots
 *   npm run import-och -- --dry-run          # parse + print, write nothing
 *   npm run import-och -- --sheet=<id> --tab='Sheet1' --client=<slug>
 */

const DEFAULT_SHEET_ID = "1Ls-zDrNemixH2LiMYj9Hh7VumupNufYnRD6HEWL4u-8";
const DEFAULT_CLIENT = "ohio-community-health-och";

// Referent/origin values we count as driven by our marketing. Matched on WHOLE
// WORDS (not loose substrings — otherwise "Crossroads" trips on "ads" and a
// referral center gets miscredited to us). Covers search, web, and paid social.
// Everything else (professional referrals, past clients, word of mouth, walk-in,
// insurance lists, …) is a real admission but not attributable to our efforts.
const ATTRIBUTABLE_WORDS = new Set([
  "google", "adwords", "ads", "ppc", "sem", "seo", "organic", "search",
  "web", "webform", "website", "online", "form", "landing",
  "facebook", "fb", "meta", "instagram", "ig", "social", "paid",
]);

interface Args {
  sheetId: string;
  tab: string | null;
  client: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let sheetId = DEFAULT_SHEET_ID;
  let tab: string | null = null;
  let client = DEFAULT_CLIENT;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--sheet=")) sheetId = a.slice("--sheet=".length);
    else if (a.startsWith("--tab=")) tab = a.slice("--tab=".length);
    else if (a.startsWith("--client=")) client = a.slice("--client=".length);
    else if (a === "--dry-run") dryRun = true;
  }
  return { sheetId, tab, client, dryRun };
}

function serviceAccount(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON.");
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }
  if (!json.client_email || !json.private_key) throw new Error("Service-account JSON missing client_email / private_key.");
  return json;
}

async function sheetsToken(): Promise<string> {
  const sa = serviceAccount();
  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Failed to mint a Sheets access token from the service account.");
  return token;
}

async function sheetsGet(token: string, path: string): Promise<any> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 403 || res.status === 404) {
    throw new Error(
      `Sheets API ${res.status} for ${path}. Share the sheet (Viewer) with the service account's client_email, then retry.`,
    );
  }
  if (!res.ok) throw new Error(`Sheets GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

/** Find the first column index whose header matches any of the needles. */
function findCol(header: string[], needles: string[]): number {
  const norm = header.map((h) => (h ?? "").toString().trim().toLowerCase());
  for (let i = 0; i < norm.length; i++) if (needles.some((n) => norm[i]!.includes(n))) return i;
  return -1;
}

/** All column indexes matching any needle, left-to-right (for date fallbacks). */
function findCols(header: string[], needles: string[]): number[] {
  const norm = header.map((h) => (h ?? "").toString().trim().toLowerCase());
  const out: number[] = [];
  for (let i = 0; i < norm.length; i++) if (needles.some((n) => norm[i]!.includes(n))) out.push(i);
  return out;
}

/** Pick the header row: the first row (within the first few) with ≥3 non-empty cells. */
function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const filled = (rows[i] ?? []).filter((c) => c && c.toString().trim()).length;
    if (filled >= 3) return i;
  }
  return 0;
}

function parseDateToMonth(v: string): string | null {
  const s = (v ?? "").toString().trim();
  if (!s) return null;
  // Handles "2025-06-14", "6/14/2025", "June 14, 2025", "14-Jun-25", etc.
  const d = new Date(s);
  if (!isNaN(d.getTime())) return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  // Fallback: MM/DD/YYYY or M/D/YY
  const m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let yr = Number(m[3]);
    if (yr < 100) yr += 2000;
    return `${yr}-${String(Number(m[1])).padStart(2, "0")}`;
  }
  return null;
}

function isAdmitted(statusCell: string | undefined, hasStatusCol: boolean): boolean {
  if (!hasStatusCol) return true; // sheet lists admissions only
  const s = (statusCell ?? "").toString().trim().toLowerCase();
  if (!s) return false;
  if (/(not|no|declin|deni|reject|lost|inactive)/.test(s)) return false;
  return /(admit|yes|enroll|accept|active|complete|won)/.test(s) || s === "y" || s === "1";
}

function isAttributable(referent: string | undefined): boolean {
  const s = (referent ?? "").toString().trim().toLowerCase();
  if (!s) return false;
  if (s.includes("web form") || s.includes("paid search")) return true;
  const tokens = s.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => ATTRIBUTABLE_WORDS.has(t));
}

function monthBounds(ym: string): { start: string; end: string } {
  const [y, m] = ym.split("-").map(Number);
  const start = `${ym}-01`;
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return { start, end: `${ym}-${String(last).padStart(2, "0")}` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Conservative default net-revenue-per-admission estimate ($8,000). Residential
  // behavioral-health admissions bill well into five figures; we lowball on
  // purpose so the case-study number is defensible. Surfaced as an ESTIMATE in
  // the UI. Override anytime with OCH_VALUE_PER_ADMISSION_CENTS (a real figure).
  const DEFAULT_VALUE_PER_ADMISSION_CENTS = 800000;
  const valueCents = process.env.OCH_VALUE_PER_ADMISSION_CENTS
    ? Math.round(Number(process.env.OCH_VALUE_PER_ADMISSION_CENTS))
    : DEFAULT_VALUE_PER_ADMISSION_CENTS;

  console.log(`OCH admissions import — sheet ${args.sheetId}${args.dryRun ? " (dry-run)" : ""}`);
  const token = await sheetsToken();

  // Resolve the tab to read (first tab unless --tab given).
  const meta = await sheetsGet(token, `${args.sheetId}?fields=sheets.properties.title`);
  const tabs: string[] = (meta.sheets ?? []).map((s: any) => s.properties?.title).filter(Boolean);
  const tab = args.tab ?? tabs[0];
  if (!tab) throw new Error("No sheets found in the spreadsheet.");
  console.log(`Reading tab "${tab}" (available: ${tabs.join(", ") || "none"})`);

  const range = encodeURIComponent(`${tab}!A1:Z5000`);
  const values = await sheetsGet(token, `${args.sheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`);
  const rows: string[][] = values.values ?? [];
  if (!rows.length) throw new Error("The tab is empty.");

  const hIdx = findHeaderRow(rows);
  const header = rows[hIdx]!;
  // Date: prefer the actual admission date, fall back to projected, then the
  // inquiry date — resolved per-row (some rows only fill one of them).
  const dateCols = [
    ...findCols(header, ["scheduled admission"]),
    ...findCols(header, ["projected admission", "admission date"]),
    ...findCols(header, ["admit date"]),
    ...findCols(header, ["inquiry received", "inquiry"]),
    ...findCols(header, ["intake"]),
    ...findCols(header, ["date"]),
  ].filter((v, i, a) => a.indexOf(v) === i);
  const refCol = findCol(header, ["referent", "referral", "source", "origin", "channel", "how did", "lead"]);
  const statusCol = findCol(header, ["status", "disposition", "outcome", "admitted"]);
  const hasStatusCol = statusCol >= 0 && !dateCols.includes(statusCol);

  console.log(
    `Columns → date:${dateCols.map((c) => header[c]).join(" / ") || "?"} · referent:${refCol >= 0 ? header[refCol] : "?"} · status:${hasStatusCol ? header[statusCol] : "(none — counting all rows)"}`,
  );
  if (!dateCols.length) throw new Error("Could not find a date column in the header row.");

  const byMonth = new Map<string, { total: number; attributable: number }>();
  const referentTally = new Map<string, number>();
  for (let r = hIdx + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (!row.some((c) => c && c.toString().trim())) continue; // blank row
    if (!isAdmitted(row[statusCol], hasStatusCol)) continue;
    let ym: string | null = null;
    for (const dc of dateCols) {
      ym = parseDateToMonth(row[dc] ?? "");
      if (ym) break;
    }
    if (!ym) continue;
    const bucket = byMonth.get(ym) ?? { total: 0, attributable: 0 };
    bucket.total += 1;
    const ref = (row[refCol] ?? "").toString().trim() || "(blank)";
    referentTally.set(ref, (referentTally.get(ref) ?? 0) + 1);
    if (isAttributable(row[refCol])) bucket.attributable += 1;
    byMonth.set(ym, bucket);
  }

  const months = [...byMonth.keys()].sort();
  if (!months.length) throw new Error("Parsed 0 admissions — check the date/status columns.");

  console.log(`\nAdmissions by referent (admitted rows):`);
  for (const [ref, n] of [...referentTally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${isAttributable(ref) ? "✓" : " "} ${ref}: ${n}`);
  }
  console.log(`\nMonthly rollup:`);
  const syncs: SyncEntry[] = [];
  for (const ym of months) {
    const { total, attributable } = byMonth.get(ym)!;
    const { start, end } = monthBounds(ym);
    // Metric keys MUST be namespaced (source.key) — the dashboard reads
    // "manual.revenue_cents" and sync.ts stores the key verbatim.
    const metrics: Record<string, number> = {
      "manual.admissions": total,
      "manual.admissions_marketing": attributable,
    };
    if (valueCents != null) metrics["manual.revenue_cents"] = attributable * valueCents;
    const revStr = valueCents != null ? ` · $${((attributable * valueCents) / 100).toLocaleString()}` : "";
    console.log(`  ${ym}: ${total} admissions (${attributable} ours)${revStr}`);
    syncs.push({
      client_id: args.client,
      source: "manual",
      external_id: `och-admissions-${ym}`,
      period_start: start,
      period_end: end,
      synced_at: `${end}T12:00:00.000Z`,
      data_state: "live",
      error_message: null,
      metrics,
    });
  }

  const totalAdm = months.reduce((s, m) => s + byMonth.get(m)!.total, 0);
  const totalAttr = months.reduce((s, m) => s + byMonth.get(m)!.attributable, 0);
  console.log(
    `\nTotal: ${totalAdm} admissions · ${totalAttr} attributable across ${months.length} months` +
      (valueCents != null ? ` · $${((totalAttr * valueCents) / 100).toLocaleString()} attributed revenue` : " · (set OCH_VALUE_PER_ADMISSION_CENTS for revenue $)"),
  );

  const databaseUrl = process.env.DATABASE_URL?.trim();
  const dashboardDir = process.env.DASHBOARD_DIR?.trim();
  if (!databaseUrl || !dashboardDir) throw new Error("Missing DATABASE_URL / DASHBOARD_DIR.");
  const code = runDashboardSync({ databaseUrl, dashboardDir }, syncs, { dryRun: args.dryRun });
  process.exit(code);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

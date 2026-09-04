#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import pg from "pg";
import { runDashboardSync, type SyncEntry, type AdmissionRecord } from "./emit.js";
import { phone10, lastDobKey, lastNameOf, parseSheetDate, ym as ymOf, isAdmittedStatus, reportUnrecognizedStatuses } from "./lead-keys.js";

/** The per-client customer value (value per conversion) set in the dashboard
 *  header — the source of truth. Matched to the client by slugified name. */
async function customerValueFromDb(databaseUrl: string, slug: string): Promise<number | null> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string; customer_value_cents: number | null }>(
      "SELECT name, customer_value_cents FROM clients WHERE customer_value_cents IS NOT NULL",
    );
    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    for (const r of rows) if (slugify(r.name) === slug) return r.customer_value_cents;
    return null;
  } finally {
    await client.end();
  }
}

// Same "is this a marketing channel" word-set as isAttributable below, applied
// to a web_inquiries row's own utm_source/utm_medium instead of the sheet's
// hand-typed Referent -- a gclid alone already implies paid search, so any
// gclid counts regardless of utm text.
const ATTRIBUTABLE_UTM_WORDS = new Set([
  "google", "adwords", "ads", "ppc", "sem", "cpc", "search",
  "web", "webform", "website", "online", "form", "organic",
  "facebook", "fb", "meta", "instagram", "ig", "social", "paid", "gbp", "gmb",
]);

interface WebInquiryMatch { source: string; submittedAt: Date }
type WebInquiryIndex = { byPhone: Map<string, WebInquiryMatch[]>; byLastDob: Map<string, WebInquiryMatch[]> };

// A web lead only explains an admission that came AFTER it and reasonably
// soon after it — an inquiry from a year earlier doesn't make this month's
// professional referral "ours".
const MATCH_WINDOW_DAYS = 180;
function inquiryExplains(list: WebInquiryMatch[] | undefined, admitted: Date): WebInquiryMatch | null {
  if (!list?.length) return null;
  const t = admitted.getTime();
  return list.find((m) => m.submittedAt.getTime() <= t + 86_400_000 && m.submittedAt.getTime() >= t - MATCH_WINDOW_DAYS * 86_400_000) ?? null;
}

/** Every web_inquiries row for this client that carries a gclid OR a
 *  recognizable marketing utm_source, indexed by phone (last 10 digits) and
 *  by lastname|dob -- the same two keys import-offline-conversions.ts
 *  already trusts to tie a Google Ads click to a real admission. Used here
 *  to grow "attributable" beyond whatever the intake team happened to type
 *  in the sheet's free-text Referent column: a patient who really came from
 *  a tracked ad/form/call still counts even if intake logged the CLINICAL
 *  referral partner that processed their case instead of how they first
 *  found OCH. */
async function loadWebInquiryMatchIndex(databaseUrl: string, clientSlug: string): Promise<WebInquiryIndex> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ phone: string | null; dob: string | null; last_name: string | null; gclid: string | null; utm_source: string | null; utm_medium: string | null; submitted_at: Date }>(
      `SELECT phone, dob, last_name, gclid, utm_source, utm_medium, submitted_at FROM web_inquiries WHERE client_slug = $1`,
      [clientSlug],
    );
    const byPhone = new Map<string, WebInquiryMatch[]>();
    const byLastDob = new Map<string, WebInquiryMatch[]>();
    for (const r of rows) {
      const hasGclid = !!(r.gclid && r.gclid.trim());
      const utmWords = `${r.utm_source ?? ""} ${r.utm_medium ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const utmAttributable = utmWords.some((w) => ATTRIBUTABLE_UTM_WORDS.has(w));
      if (!hasGclid && !utmAttributable) continue; // not a marketing-tracked lead
      const match: WebInquiryMatch = { source: hasGclid ? "gclid" : `utm:${r.utm_source ?? r.utm_medium}`, submittedAt: new Date(r.submitted_at) };
      const p = phone10(r.phone);
      if (p) byPhone.set(p, [...(byPhone.get(p) ?? []), match]);
      const ld = lastDobKey(r.last_name, r.dob);
      if (ld) byLastDob.set(ld, [...(byLastDob.get(ld) ?? []), match]);
    }
    return { byPhone, byLastDob };
  } finally {
    await client.end();
  }
}

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

/** Statuses isAdmittedStatus couldn't classify this run — printed once at the end. */
const unrecognizedStatuses = new Set<string>();
function isAdmitted(statusCell: string | undefined, hasStatusCol: boolean): boolean {
  if (!hasStatusCol) return true; // sheet lists admissions only
  return isAdmittedStatus(statusCell, unrecognizedStatuses); // shared with import-offline-conversions
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
  // Priority: the editable dashboard "Customer value" field → env override → default.
  // Deliberately NOT caught: a transient DB failure here used to fall back to
  // the default value and an empty cross-check index, then write LOWER numbers
  // with a fresh synced_at (which wins "latest") and exit 0. Failing loudly
  // trips the heartbeat and the freshness alert instead.
  const dbUrlForValue = process.env.DATABASE_URL?.trim();
  const dbValue = dbUrlForValue ? await customerValueFromDb(dbUrlForValue, args.client) : null;
  const valueCents = dbValue
    ?? (process.env.OCH_VALUE_PER_ADMISSION_CENTS ? Math.round(Number(process.env.OCH_VALUE_PER_ADMISSION_CENTS)) : DEFAULT_VALUE_PER_ADMISSION_CENTS);
  console.log(`Value per admission: $${(valueCents / 100).toLocaleString()} (${dbValue != null ? "from dashboard Customer value" : "default/env"})`);

  console.log(`OCH admissions import — sheet ${args.sheetId}${args.dryRun ? " (dry-run)" : ""}`);
  const token = await sheetsToken();

  // Resolve the tab to read: --tab, else the tab NAMED for admissions, else
  // the first tab. By name, not position — someone dragging "Web Inquiries"
  // to the front would otherwise turn every form fill into an admission.
  const meta = await sheetsGet(token, `${args.sheetId}?fields=sheets.properties.title`);
  const tabs: string[] = (meta.sheets ?? []).map((s: any) => s.properties?.title).filter(Boolean);
  const tab = args.tab ?? tabs.find((t) => /admission/i.test(t)) ?? tabs[0];
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
  const phoneCol = findCol(header, ["phone"]);
  const dobCol = findCol(header, ["dob", "birth"]);
  const nameCol = findCol(header, ["name"]);

  // Cross-check against web_inquiries (real form/gclid captures) so a row can
  // count as attributable even when intake typed the CLINICAL referral
  // partner into Referent instead of how the patient actually found OCH —
  // see loadWebInquiryMatchIndex's comment.
  // Not caught either (see customerValueFromDb above): an empty index would
  // silently drop every web-inquiry-only attribution for the month.
  const webInquiryIndex: WebInquiryIndex = dbUrlForValue
    ? await loadWebInquiryMatchIndex(dbUrlForValue, args.client)
    : { byPhone: new Map(), byLastDob: new Map() };
  console.log(`Web-inquiry cross-check index: ${webInquiryIndex.byPhone.size} phone(s), ${webInquiryIndex.byLastDob.size} lastname|dob key(s).`);

  console.log(
    `Columns → date:${dateCols.map((c) => header[c]).join(" / ") || "?"} · referent:${refCol >= 0 ? header[refCol] : "?"} · status:${hasStatusCol ? header[statusCol] : "(none — counting all rows)"}`,
  );
  if (!dateCols.length) throw new Error("Could not find a date column in the header row.");

  // Data-quality guard: ignore rows dated in the future (e.g. a "2027" typo for
  // 2026). A future month would otherwise become the "latest" period and skew
  // the revenue tile + break week/month/quarter deltas.
  const now = new Date();
  const currentYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  // Per-admission records behind the monthly rollup below — an explicit
  // dashboard drill-down click reads these, nothing else does. Only what
  // identifies a row: name/phone/dob/referent, no clinical detail.
  const admissionRecords: AdmissionRecord[] = [];

  const byMonth = new Map<string, { total: number; attributable: number }>();
  // The current, still-open month's count — provisional, shown separately
  // from byMonth so the board's trusted month-over-month history never
  // includes a partial month.
  const currentMonthBucket = { total: 0, attributable: 0 };
  const referentTally = new Map<string, number>();
  // Per-month breakdown too -- an all-months tally can hide a month where
  // attribution silently collapsed to 0 even though every other month has
  // some (e.g. a new Referent label started appearing that ATTRIBUTABLE_WORDS
  // doesn't recognize). See DEBUG_MONTH below.
  const referentTallyByMonth = new Map<string, Map<string, number>>();
  let skippedFuture = 0;
  let attributedByReferent = 0;
  let attributedByWebInquiryOnly = 0;
  for (let r = hIdx + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (!row.some((c) => c && c.toString().trim())) continue; // blank row
    if (!isAdmitted(row[statusCol], hasStatusCol)) continue;
    let admittedOn: Date | null = null;
    for (const dc of dateCols) {
      admittedOn = parseSheetDate(row[dc]);
      if (admittedOn) break;
    }
    if (!admittedOn) continue;
    const ym = ymOf(admittedOn);
    // A real future date (a "2027" typo, say) never belongs to any bucket.
    // The CURRENT month is different: it's incomplete, not invalid, so it's
    // tallied separately (currentMonthBucket) instead of the historical
    // byMonth map the board's trend reads — a provisional count the UI can
    // show as explicitly "not final", without the partial month polluting
    // the trusted month-over-month history.
    if (ym > currentYm) { skippedFuture++; continue; }
    const isCurrentMonth = ym === currentYm;
    const bucket = isCurrentMonth ? currentMonthBucket : (byMonth.get(ym) ?? { total: 0, attributable: 0 });
    bucket.total += 1;
    const ref = (row[refCol] ?? "").toString().trim() || "(blank)";
    referentTally.set(ref, (referentTally.get(ref) ?? 0) + 1);
    const monthTally = referentTallyByMonth.get(ym) ?? new Map<string, number>();
    monthTally.set(ref, (monthTally.get(ref) ?? 0) + 1);
    referentTallyByMonth.set(ym, monthTally);
    const referentSaysYes = isAttributable(row[refCol]);
    let webInquiryMatch = false;
    let webInquiryMatchVia: "web_inquiry_phone" | "web_inquiry_dob" | null = null;
    // A gclid match means this specific admission came from an actual Google
    // Ads click, not just some marketing-tracked form fill (utm text) — kept
    // as its own attribution_source value so the dashboard's Google Ads
    // "See who" only ever shows people who really clicked an ad.
    let webInquiryMatchedGclid = false;
    if (!referentSaysYes) {
      const p = phoneCol >= 0 ? phone10(row[phoneCol]) : null;
      const ld = nameCol >= 0 && dobCol >= 0 ? lastDobKey(lastNameOf(row[nameCol]), row[dobCol]) : null;
      const byPhone = p ? inquiryExplains(webInquiryIndex.byPhone.get(p), admittedOn) : null;
      const byDob = !byPhone && ld ? inquiryExplains(webInquiryIndex.byLastDob.get(ld), admittedOn) : null;
      const matched = byPhone ?? byDob;
      if (matched) {
        webInquiryMatch = true;
        webInquiryMatchVia = byPhone ? "web_inquiry_phone" : "web_inquiry_dob";
        webInquiryMatchedGclid = matched.source === "gclid";
      }
    }
    const attributable = referentSaysYes || webInquiryMatch;
    if (!isCurrentMonth) {
      if (referentSaysYes) attributedByReferent++;
      else if (webInquiryMatch) attributedByWebInquiryOnly++;
    }
    if (attributable) bucket.attributable += 1;
    if (!isCurrentMonth) byMonth.set(ym, bucket);
    admissionRecords.push({
      client_id: args.client,
      admitted_on: admittedOn.toISOString().slice(0, 10),
      name: nameCol >= 0 ? (row[nameCol] ?? "").toString().trim() || null : null,
      phone: phoneCol >= 0 ? (row[phoneCol] ?? "").toString().trim() || null : null,
      dob: dobCol >= 0 ? (row[dobCol] ?? "").toString().trim() || null : null,
      referent: ref === "(blank)" ? null : ref,
      attributable,
      attribution_source: referentSaysYes ? "referent" : webInquiryMatchedGclid ? "web_inquiry_gclid" : webInquiryMatchVia,
    });
  }

  const months = [...byMonth.keys()].sort();
  if (!months.length) throw new Error("Parsed 0 admissions — check the date/status columns.");
  if (skippedFuture) console.log(`Skipped ${skippedFuture} future-dated row(s) (likely a year typo).`);
  reportUnrecognizedStatuses(unrecognizedStatuses);
  console.log(`Attributable via Referent text: ${attributedByReferent} · via web_inquiries phone/DOB match only (Referent said no/blank): ${attributedByWebInquiryOnly}`);

  // Debug aid: print the referent breakdown for a specific month (set via
  // --debug-month=YYYY-MM) so a month whose attributable count looks wrong
  // can be diagnosed without guessing from the all-months tally.
  const debugMonth = process.argv.find((a) => a.startsWith("--debug-month="))?.slice("--debug-month=".length);
  if (debugMonth) {
    const monthTally = referentTallyByMonth.get(debugMonth);
    console.log(`\nReferent breakdown for ${debugMonth}:`);
    if (!monthTally) console.log(`  (no admitted rows found for this month)`);
    else for (const [ref, n] of [...monthTally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${isAttributable(ref) ? "✓" : " "} ${ref}: ${n}`);
    }
  }

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
      // Leave synced_at unset → the dashboard stamps it "now" (actual pull
      // time). The month each row covers lives in period_start/period_end, and
      // trends + "current period" are computed from THAT, so freshness can
      // honestly read "just now" instead of looking a month stale.
      data_state: "live",
      error_message: null,
      metrics,
    });
  }

  // Provisional current-month figures, kept out of `syncs`' month-by-month
  // series above (separate metric keys) so the trusted historical trend is
  // never touched by a month that can still change before it closes.
  {
    const { start, end } = monthBounds(currentYm);
    console.log(`  ${currentYm} (in progress): ${currentMonthBucket.total} admissions (${currentMonthBucket.attributable} ours) so far — provisional, not final`);
    syncs.push({
      client_id: args.client,
      source: "manual",
      external_id: `och-admissions-current-${currentYm}`,
      period_start: start,
      period_end: end,
      data_state: "live",
      error_message: null,
      metrics: {
        "manual.admissions_current": currentMonthBucket.total,
        "manual.admissions_marketing_current": currentMonthBucket.attributable,
      },
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

  // Purge future-dated manual snapshots left behind by earlier imports (e.g. a
  // "2027" year typo that predates the future-date guard). The guard stops us
  // WRITING them, but rows already in the table would otherwise linger and, being
  // backdated to a future synced_at, keep winning the "latest" pick. Idempotent.
  if (!args.dryRun) {
    const purged = await purgeFutureManualRows(databaseUrl, args.client).catch((e) => {
      console.warn(`Could not purge future-dated rows: ${e instanceof Error ? e.message : e}`);
      return 0;
    });
    if (purged > 0) console.log(`Purged ${purged} stale future-dated manual snapshot row(s).`);
  }

  const code = runDashboardSync({ databaseUrl, dashboardDir }, syncs, { dryRun: args.dryRun }, admissionRecords);
  process.exit(code);
}

/** Housekeeping for this client's manual snapshots: (1) delete any row whose
 *  period has NOT completed yet (period_end in the future) — a "2027" typo or
 *  a stale row from before the current-month guard existed, excluded from the
 *  board and only adding noise -- EXCEPT the two current-month provisional
 *  keys below, whose period_end is legitimately always in the future until
 *  the month actually closes; those are meant to persist and get overwritten
 *  in place, not purged every run; (2) dedupe, keeping the newest write per
 *  (metric_key, period) so repeated imports don't pile up copies. Matches the
 *  client by slugified name (the sheet speaks slugs; the table keys on id). */
async function purgeFutureManualRows(databaseUrl: string, slug: string): Promise<number> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string; name: string }>("SELECT id, name FROM clients");
    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const match = rows.find((r) => slugify(r.name) === slug);
    if (!match) return 0;
    const future = await client.query(
      `DELETE FROM metric_snapshots
        WHERE client_id = $1 AND source = 'manual' AND metric_key LIKE 'manual.%'
          AND metric_key NOT IN ('manual.admissions_current', 'manual.admissions_marketing_current')
          AND period_end > now()`,
      [match.id],
    );
    const dupes = await client.query(
      `DELETE FROM metric_snapshots a USING metric_snapshots b
        WHERE a.client_id = $1 AND a.source = 'manual' AND a.metric_key LIKE 'manual.%'
          AND b.client_id = a.client_id AND b.source = a.source AND b.metric_key = a.metric_key
          AND coalesce(b.period_end, b.period_start) IS NOT DISTINCT FROM coalesce(a.period_end, a.period_start)
          AND (b.synced_at > a.synced_at OR (b.synced_at = a.synced_at AND b.ctid > a.ctid))`,
      [match.id],
    );
    return (future.rowCount ?? 0) + (dupes.rowCount ?? 0);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

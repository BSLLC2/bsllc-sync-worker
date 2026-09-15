#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import pg from "pg";
import { runDashboardSync, type SyncEntry, type AdmissionRecord } from "./emit.js";
import { phone10, lastDobKey, lastNameOf, parseSheetDate, ym as ymOf, isAdmittedStatus, reportUnrecognizedStatuses } from "./lead-keys.js";
// The rescue: an admission intake labelled with a word our list does not
// know can still be ours if a lead we captured carries the same phone (or
// surname + DOB). It is the only path that catches those, so it is pure and
// tested rather than inline here — see och-lead-match.ts.
import { buildLeadIndex, matchAdmission, leadLine, MATCH_WINDOW_DAYS, type LeadIndex } from "./och-lead-match.js";
import { findHeaderRow, resolveAdmissionColumns, describeColumns, contentResolvedNote, type AdmissionColumns } from "./och-sheet-columns.js";
import { backfillExclusionLine } from "./lead-provenance.js";
import { isAttributable, referentVerdict } from "./och-attribution.js";

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

/** Every `web_inquiries` row for this client, handed to the pure matcher.
 *  The query selects only what a match needs — no name, no email.
 *
 *  Which of those rows may ATTRIBUTE an admission is och-lead-match.ts's
 *  decision, not this function's: live captures carrying a gclid or a
 *  marketing UTM. A row typed in from the client's own export is kept as a
 *  lead and excluded from attribution, because the export never held a click
 *  (lead-provenance.ts). That exclusion is what moved lifetime attribution
 *  from 51 to 49 on 2026-09-15; the two admissions it dropped were credited
 *  to us on the strength of rows a person typed in.
 */
async function loadLeadIndex(databaseUrl: string, clientSlug: string): Promise<LeadIndex> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ phone: string | null; dob: string | null; last_name: string | null; gclid: string | null; utm_source: string | null; utm_medium: string | null; raw_json: string | null; submitted_at: Date }>(
      `SELECT phone, dob, last_name, gclid, utm_source, utm_medium, raw_json, submitted_at FROM web_inquiries WHERE client_slug = $1`,
      [clientSlug],
    );
    const index = buildLeadIndex(rows.map((r) => ({
      phone: r.phone, dob: r.dob, lastName: r.last_name, gclid: r.gclid,
      utmSource: r.utm_source, utmMedium: r.utm_medium, rawJson: r.raw_json,
      submittedAt: new Date(r.submitted_at),
    })));
    if (index.counts.typedIn) console.log(`  ${backfillExclusionLine(index.counts.typedIn)}`);
    return index;
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

// The Referent rule — which hand-typed origin values count as ours — lives in
// och-attribution.ts, so import-och and debug-och-month can never disagree
// about what "ours" means. See verify-och-attribution.ts.

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

/** Statuses isAdmittedStatus couldn't classify this run — printed once at the end. */
const unrecognizedStatuses = new Set<string>();
function isAdmitted(statusCell: string | undefined, hasStatusCol: boolean): boolean {
  if (!hasStatusCol) return true; // sheet lists admissions only
  return isAdmittedStatus(statusCell, unrecognizedStatuses); // shared with import-offline-conversions
}


function monthBounds(ym: string): { start: string; end: string } {
  const [y, m] = ym.split("-").map(Number);
  const start = `${ym}-01`;
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return { start, end: `${ym}-${String(last).padStart(2, "0")}` };
}

/**
 * A header we cannot read is a FAILED run, not a quiet one. Report it the way
 * every other importer reports a failure — one `data_state: "error"` entry with
 * the message on it — so the connector reads as failing in Admin → Connectors,
 * the morning audit files it, and the freshness monitor notices. Exiting 0 with
 * a console line is what let six days of nameless duplicate rows accumulate.
 *
 * No metrics ride along: the entry lands as a `_sync.status` row (see the
 * dashboard's sync.ts), so nothing is overwritten with a made-up number, and
 * no `external_id` is sent so no connector mapping is touched. A --dry-run
 * still writes nothing but still exits non-zero.
 */
function reportHeaderFailure(args: Args, message: string): never {
  console.error(`\n✗ ${message}`);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const dashboardDir = process.env.DASHBOARD_DIR?.trim();
  if (!databaseUrl || !dashboardDir) {
    console.error("Missing DATABASE_URL / DASHBOARD_DIR — could not record the failure on the dashboard.");
    process.exit(1);
  }
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const { start, end } = monthBounds(ym);
  const code = runDashboardSync({ databaseUrl, dashboardDir }, [{
    client_id: args.client,
    source: "manual",
    period_start: start,
    period_end: end,
    data_state: "error",
    error_message: message.slice(0, 300),
    metrics: {},
  }], { dryRun: args.dryRun });
  process.exit(code === 0 ? 1 : code);
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
  // Every column this run needs, or a stop. The columns are resolved from the
  // headings AND from the data under them (och-sheet-columns.ts): the sheet is
  // the client's, they rename their own headings, and an importer that stops
  // dead on a retitled column is our fragility, not their mistake. What still
  // stops the run is a board no signal can read — a -1 name column wrote an
  // empty name onto every admission for six days and exited 0. The Referent
  // column is required here (it is not for the conversions importer): without
  // it every admission silently reads as not ours, which is a wrong number
  // rather than a missing one. The failure is reported to the dashboard as a
  // failing connector, not just to a log nobody reads.
  let cols: AdmissionColumns;
  try {
    cols = resolveAdmissionColumns(rows, { tab, headerRowIndex: hIdx }, { require: ["name", "date", "contact", "referent"] });
  } catch (e) {
    return reportHeaderFailure(args, e instanceof Error ? e.message : String(e));
  }
  const { dateCols, inquiryCols, refCol, statusCol, hasStatusCol, phoneCol, dobCol, nameCol } = cols;

  // Cross-check against web_inquiries so a row can count as ours even when
  // intake typed the CLINICAL referral partner into Referent instead of how
  // the patient actually found OCH — see och-lead-match.ts.
  // Not caught either (see customerValueFromDb above): an empty index would
  // silently drop every web-inquiry-only attribution for the month.
  const leadIndex: LeadIndex = dbUrlForValue
    ? await loadLeadIndex(dbUrlForValue, args.client)
    : buildLeadIndex([]);
  console.log(
    `Web-inquiry cross-check index: ${leadIndex.attributing.byPhone.size} phone(s), ${leadIndex.attributing.byLastDob.size} lastname|dob key(s) ` +
    `— from ${leadIndex.counts.attributing} lead(s) carrying channel evidence of ${leadIndex.counts.total} held` +
    `${leadIndex.counts.typedIn ? ` (${leadIndex.counts.typedIn} typed in, which prove an enquiry and no channel)` : ""}.`,
  );

  console.log(`Columns → ${describeColumns(header, cols)}`);
  const resolvedNote = contentResolvedNote(cols);
  if (resolvedNote) console.log(resolvedNote);

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
  let skippedFuture = 0;
  // Admitted rows the board gives no ADMISSION date for. They used to fall
  // back to Inquiry Received, which dated the admission to the month the
  // patient first rang — moving revenue between months without changing the
  // total, which is the kind of wrong nothing ever catches. An admission we
  // cannot date belongs to no month; it is counted here and reported, and the
  // fix is OCH filling the date in, not this importer inventing one.
  let admittedNoDate = 0;
  let attributedByReferent = 0;
  let attributedByWebInquiryOnly = 0;
  // Every rescue this run, current month included — the canary below reads it.
  let rescuedByLead = 0;
  // --debug-month=YYYY-MM prints that month row by row at the end of the run:
  // what intake actually typed in Referent, verbatim, rather than a tally of
  // what our word list matched. Redacted — no name, no DOB, phone as the last
  // four digits only — because this goes in a run log a person reads.
  const debugMonth = process.argv.find((a) => a.startsWith("--debug-month="))?.slice("--debug-month=".length);
  interface DebugRow { admitted: string; inquiry: string; status: string; phone: string; referent: string; ours: boolean; by: "referent" | "lead" | null; lead: string }
  const debugRows: DebugRow[] = [];
  let debugNotAdmitted = 0;
  const last4 = (v: unknown) => { const d = String(v ?? "").replace(/[^0-9]/g, ""); return d ? `…${d.slice(-4)}` : "—"; };
  const cellOf = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").toString().replace(/\s+/g, " ").trim() : "");
  for (let r = hIdx + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (!row.some((c) => c && c.toString().trim())) continue; // blank row
    if (!isAdmitted(row[statusCol], hasStatusCol)) {
      if (debugMonth) {
        let d: Date | null = null;
        for (const dc of dateCols) { d = parseSheetDate(row[dc]); if (d) break; }
        if (d && ymOf(d) === debugMonth) debugNotAdmitted++;
      }
      continue;
    }
    let admittedOn: Date | null = null;
    for (const dc of dateCols) {
      admittedOn = parseSheetDate(row[dc]);
      if (admittedOn) break;
    }
    if (!admittedOn) { admittedNoDate++; continue; }
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
    const referentSaysYes = isAttributable(row[refCol]);
    // Run the match on every admission, not only the ones the Referent text
    // gives up on: a row the text already claims still deserves to say whether
    // we hold the lead behind it, and the readout prints it.
    const verdict = matchAdmission(leadIndex, {
      phone: phoneCol >= 0 ? phone10(row[phoneCol]) : null,
      lastDob: nameCol >= 0 && dobCol >= 0 ? lastDobKey(lastNameOf(row[nameCol]), row[dobCol]) : null,
    }, admittedOn);
    const webInquiryMatch = !referentSaysYes && !!verdict.attributing;
    const webInquiryMatchVia = webInquiryMatch ? verdict.via : null;
    // A gclid match means this specific admission came from an actual Google
    // Ads click, not just some marketing-tracked form fill (utm text) — kept
    // as its own attribution_source value so the dashboard's Google Ads
    // "See who" only ever shows people who really clicked an ad.
    const webInquiryMatchedGclid = webInquiryMatch && verdict.attributing?.evidence === "gclid";
    const attributable = referentSaysYes || webInquiryMatch;
    if (webInquiryMatch) rescuedByLead++;
    if (!isCurrentMonth) {
      if (referentSaysYes) attributedByReferent++;
      else if (webInquiryMatch) attributedByWebInquiryOnly++;
    }
    if (attributable) bucket.attributable += 1;
    if (!isCurrentMonth) byMonth.set(ym, bucket);
    if (debugMonth && ym === debugMonth) {
      debugRows.push({
        admitted: admittedOn.toISOString().slice(0, 10),
        inquiry: inquiryCols.map((c) => cellOf(row, c)).find((v) => v) ?? "—",
        status: cellOf(row, statusCol) || "—",
        phone: phoneCol >= 0 ? last4(row[phoneCol]) : "—",
        referent: ref === "(blank)" ? "" : ref,
        ours: attributable,
        by: referentSaysYes ? "referent" : webInquiryMatch ? "lead" : null,
        // "—" has to mean we hold nothing for this person. A lead we typed in
        // from their own export is not a channel, but it is not nothing
        // either, and printing a dash for both hides the difference.
        lead: leadLine(verdict),
      });
    }
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
  if (admittedNoDate) {
    console.log(
      `${admittedNoDate} admitted row(s) have no Scheduled/Projected admission date and are in no month's count. ` +
      `Ask OCH to fill the admission date in — dating them from Inquiry Received would move their revenue into the month they enquired.`,
    );
  }
  reportUnrecognizedStatuses(unrecognizedStatuses);
  console.log(`Attributable via Referent text: ${attributedByReferent} · via web_inquiries phone/DOB match only (Referent said no/blank): ${attributedByWebInquiryOnly}`);
  // A path that quietly stops matching looks exactly like a month with nothing
  // to match. Say which it is: this rescue is the ONLY thing that catches an
  // admission intake labelled with a word och-attribution.ts does not know, so
  // a run where it fires zero times is worth a person's attention even when
  // nothing is broken.
  if (leadIndex.counts.attributing > 0 && rescuedByLead === 0) {
    console.log(
      `The captured-lead rescue matched nothing this run: ${leadIndex.counts.attributing} lead(s) carry channel evidence and none of them ` +
      `matched an admission by phone or surname+DOB within ${MATCH_WINDOW_DAYS} days. Either no lead of ours admitted, or the keys stopped lining up.`,
    );
  }

  // The month, row by row. The owner's question is always about THIS month:
  // how many admissions, how many of them ours, and — because the rule reads a
  // free-text cell somebody typed — what that cell actually says on each one.
  if (debugMonth) {
    const ours = debugRows.filter((d) => d.ours).length;
    const byReferent = debugRows.filter((d) => d.by === "referent").length;
    const byLead = debugRows.filter((d) => d.by === "lead").length;
    const leadHeld = debugRows.filter((d) => d.lead !== "—").length;
    const unknownRef = debugRows.filter((d) => referentVerdict(d.referent) === "unrecognised").length;
    const blankRef = debugRows.filter((d) => referentVerdict(d.referent) === "blank").length;
    console.log(`\n${debugMonth}: ${debugRows.length} admission(s) on the board.`);
    console.log(`  ours                                 ${ours} (${byReferent} by the Referent text, ${byLead} by a lead we captured)`);
    console.log(`  Referent the rule does not recognise ${unknownRef}`);
    console.log(`  Referent blank                       ${blankRef}`);
    console.log(`  we hold a lead for                   ${leadHeld} of them (a typed-in lead proves the enquiry, never the channel)`);
    console.log(`\n  Every admission dated in ${debugMonth}   (✓ ours · ? referent not recognised · – referent blank)`);
    if (!debugRows.length) console.log(`    (none)`);
    for (const d of debugRows.sort((a, b) => a.admitted.localeCompare(b.admitted))) {
      const mark = d.ours ? "✓" : referentVerdict(d.referent) === "unrecognised" ? "?" : "–";
      const path = d.by === "referent" ? "ours: referent" : d.by === "lead" ? "ours: lead" : "";
      console.log(
        `    ${mark} admitted ${d.admitted} · inquiry ${d.inquiry.padEnd(10)} · ${d.status.slice(0, 16).padEnd(16)} · ` +
        `${d.phone.padEnd(6)} · ${path.padEnd(14)} · ${d.lead.padEnd(21)} · referent: "${d.referent.slice(0, 120)}"`,
      );
    }
    if (unknownRef) {
      const tally = new Map<string, number>();
      for (const d of debugRows) if (referentVerdict(d.referent) === "unrecognised") tally.set(d.referent, (tally.get(d.referent) ?? 0) + 1);
      console.log(`\n  Referent values the rule does not recognise (verbatim):`);
      for (const [ref, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`    ${n} × "${ref}"`);
    }
    if (debugNotAdmitted) console.log(`\n  ${debugNotAdmitted} further row(s) are dated in ${debugMonth} but their status is not an admission.`);
    console.log(`\n  What this does not tell you`);
    console.log(`    ${unknownRef} row(s) carry a Referent nobody here recognises. That number is the size of the doubt:`);
    console.log(`    any of them could be a lead of ours under a label intake made up, and only intake can say.`);
    console.log(`    A lead of ours captured against the row proves it was ours; nothing here proves the reverse,`);
    console.log(`    and OCH's form capture went quiet on 2026-09-10, so a lead we sent may not have been captured.`);
    if (debugMonth === currentYm) console.log(`    ${debugMonth} is still open — these are the admissions so far, not the month's final count.`);
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

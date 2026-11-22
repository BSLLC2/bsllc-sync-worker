#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { GoogleAdsApi } from "google-ads-api";
import pg from "pg";
import { phone10, lastDobKey, lastNameOf, parseSheetDate, ymd, isAdmittedStatus, reportUnrecognizedStatuses } from "./lead-keys.js";
// One resolver, two callers: this job and import-och read the same tab and
// must agree about who a row is about. It resolves each column from the
// heading and, when the client has renamed one, from the data underneath.
import { findHeaderRow, resolveAdmissionColumns, describeColumns, contentResolvedNote } from "./och-sheet-columns.js";
import { ochSheetId, pickAdmissionTab, boardRange, rowsCapped, ROW_LIMIT } from "./och-sheet-target.js";
import { accessToken, sheetsBase } from "./och-google.js";
import { getAccessToken as dmToken, buildIngestBody, chunk, ingest, requestStatus, validationAllows, actionFault, type DmRow } from "./ads/data-manager.js";
// Enhanced conversions for leads (R25): hashed phone / email ride with each conversion when the gate allows.
// Raw values and hashes stay in memory; only counts are logged or recorded.
import { hashedIdentifiers, identifierGate, identifierCounts, identifierSummary, identifierRecord, identifierRecordKey } from "./ads/user-identifiers.js";

/**
 * CLOSE-THE-LOOP: real admissions → Google Ads offline conversions.
 *
 * The recursive learning loop. Google Ads only knows which clicks turned into
 * FORM FILLS. It doesn't know which of those became actual patients — that lives
 * in OCH's admissions sheet. This job closes that gap:
 *
 *   1. Read web inquiries (each carries the gclid of the ad click that produced
 *      it) from the dashboard DB.
 *   2. Read the admissions sheet (real conversions).
 *   3. Match an admission to an inquiry by phone, else name+DOB.
 *   4. Upload the matched gclid to Google Ads as an "Admission (offline)"
 *      conversion, valued at the client's per-admission value.
 *
 * Now Google's bidding optimizes toward clicks that become PATIENTS, not just
 * form fills — the loop compounds.
 *
 * Everything self-heals so it can run unattended (per "work around roadblocks"):
 *   - OCH Ads customer id: OCH_ADS_CUSTOMER_ID env, else auto-discovered under
 *     the MCC by account name.
 *   - Conversion action: found by name, else CREATED automatically.
 *   - No inquiries yet (gclids not flowing): logs and exits 0 — nothing to do.
 *   - Idempotent: one upload per (client, gclid) — a click converts once,
 *     whichever admission-date column intake happened to fill in first.
 *   - Only conversions Google actually ACCEPTED are recorded; a rejected row
 *     (click outside the window, unknown gclid, time before the click) is
 *     logged and retried on the next run instead of being marked done.
 *
 * Usage:
 *   npm run import-offline-conversions
 *   npm run import-offline-conversions -- --dry-run
 *   npm run import-offline-conversions -- --customer=1234567890 --lookback=120
 */

const DEFAULT_SHEET_ID = ochSheetId();
const DEFAULT_CLIENT_SLUG = "ohio-community-health-och";
const CONVERSION_ACTION_NAME = "Admission (offline)";
// Google only accepts a click conversion inside the conversion action's own
// click-through window — its default for a new action is 30 days, which is
// shorter than the inquiry→admission lag we routinely see. The action is
// created with (and raised to) this window so a 6-week-old click still counts.
const CLICK_LOOKBACK_DAYS = 90;
const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_VALUE_CENTS = 800000; // fallback if the client's Customer value is unset
// The account's reporting timezone. Conversion times are stamped end-of-day
// here so they can never land before the click that produced them.
const ACCOUNT_TZ = "America/New_York";

/** "+HH:MM"/"-HH:MM" UTC offset of ACCOUNT_TZ on a given day (DST-aware). */
function tzOffsetOn(day: Date): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: ACCOUNT_TZ, timeZoneName: "shortOffset" })
    .formatToParts(day).find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return m ? `${m[1]}${m[2]!.padStart(2, "0")}:${m[3] ?? "00"}` : "-05:00";
}

interface Args { dryRun: boolean; customerId: string | null; lookbackDays: number; sheetId: string; clientSlug: string; csvPath: string | null; markUploaded: boolean; api: "validate" | "send"; }
function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, customerId: null, lookbackDays: DEFAULT_LOOKBACK_DAYS, sheetId: DEFAULT_SHEET_ID, clientSlug: DEFAULT_CLIENT_SLUG, csvPath: null, markUploaded: false, api: "validate" };
  for (const x of argv) {
    if (x === "--dry-run") a.dryRun = true;
    else if (x.startsWith("--customer=")) a.customerId = x.slice(11).replace(/[^0-9]/g, "");
    else if (x.startsWith("--lookback=")) a.lookbackDays = Number(x.slice(11)) || DEFAULT_LOOKBACK_DAYS;
    else if (x.startsWith("--sheet=")) a.sheetId = x.slice(8);
    else if (x.startsWith("--client=")) a.clientSlug = x.slice(9);
    else if (x.startsWith("--csv=")) a.csvPath = x.slice(6);
    else if (x === "--mark-uploaded") a.markUploaded = true;
    else if (x === "--api=send") a.api = "send";
    else if (x === "--api=validate") a.api = "validate";
  }
  return a;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var ${name}.`);
  return v.trim();
}
const digits = (s: string) => (s ?? "").replace(/[^0-9]/g, "");
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ── Google Sheets (service account, read-only) ──
function serviceAccount(): { client_email: string; private_key: string } {
  const raw = env("GOOGLE_SERVICE_ACCOUNT_JSON");
  const json = JSON.parse(raw);
  if (!json.client_email || !json.private_key) throw new Error("Service-account JSON missing client_email / private_key.");
  return json;
}
async function sheetsToken(): Promise<string> {
  const token = await accessToken(serviceAccount(), "https://www.googleapis.com/auth/spreadsheets.readonly");
  if (!token) throw new Error("Failed to mint a Sheets access token.");
  return token;
}
async function sheetsGet(token: string, path: string): Promise<any> {
  // The scheduled run fails intermittently (8 of the last ~22) with no code
  // change in between — the shape of a transient upstream error. Retry the
  // retryable statuses with backoff before giving up; a 403/404 is still
  // immediate.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${sheetsBase()}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) return res.json();
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      console.warn(`Sheets GET ${path.slice(0, 60)}… → ${res.status}; retrying in ${5 * (attempt + 1)}s`);
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    throw new Error(`Sheets GET ${path} → ${res.status} ${body.slice(0, 300)}`);
  }
}
/** Statuses isAdmittedStatus couldn't classify this run — printed once after the scan. */
const unrecognizedStatuses = new Set<string>();
function isAdmitted(cell: string | undefined): boolean {
  return isAdmittedStatus(cell, unrecognizedStatuses); // shared with import-och
}

interface Inquiry { gclid: string; phone10: string | null; email: string | null; lastDob: string | null; firstName: string | null; submittedAt: Date; }
interface Admission { name: string; phone10: string | null; lastDob: string | null; date: Date; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Offline conversions — client ${args.clientSlug}${args.dryRun ? " (dry-run)" : ""}`);

  const databaseUrl = env("DATABASE_URL");
  const pgc = new pg.Client({ connectionString: databaseUrl });
  await pgc.connect();

  try {
    // Per-admission value (dollars) from the dashboard's editable Customer value.
    const { rows: clientRows } = await pgc.query<{ id: string; name: string; customer_value_cents: number | null }>(
      "SELECT id, name, customer_value_cents FROM clients",
    );
    const matchClient = clientRows.find((r) => slugify(r.name) === args.clientSlug);
    const valueCents = matchClient?.customer_value_cents ?? DEFAULT_VALUE_CENTS;
    const valueDollars = valueCents / 100;
    console.log(`Per-admission value: $${valueDollars.toLocaleString()} (${matchClient?.customer_value_cents != null ? "dashboard Customer value" : "default"})`);

    // 1. Web inquiries with a gclid.
    const { rows: inqRows } = await pgc.query<{ gclid: string | null; phone: string | null; email: string | null; dob: string | null; last_name: string | null; first_name: string | null; submitted_at: Date }>(
      `SELECT gclid, phone, email, dob, last_name, first_name, submitted_at FROM web_inquiries
        WHERE client_slug = $1 AND gclid IS NOT NULL AND gclid <> ''
        ORDER BY submitted_at DESC`,
      [args.clientSlug],
    );
    const inquiries: Inquiry[] = inqRows.map((r) => ({
      gclid: r.gclid!.trim(),
      phone10: phone10(r.phone),
      email: r.email,
      lastDob: lastDobKey(r.last_name, r.dob),
      firstName: r.first_name,
      submittedAt: new Date(r.submitted_at),
    }));
    console.log(`Web inquiries with a gclid: ${inquiries.length}`);
    if (inquiries.length === 0) {
      console.log("No gclids captured yet — nothing to match. (Confirm the website form is feeding Web Inquiries.) Exiting cleanly.");
      return;
    }
    // Newest-first lists per key (the query is ordered), so a person who
    // clicked twice resolves deterministically: the latest click that
    // happened BEFORE the admission, else the newest overall.
    const byPhone = new Map<string, Inquiry[]>();
    const byNameDob = new Map<string, Inquiry[]>();
    for (const i of inquiries) {
      if (i.phone10) byPhone.set(i.phone10, [...(byPhone.get(i.phone10) ?? []), i]);
      if (i.lastDob) byNameDob.set(i.lastDob, [...(byNameDob.get(i.lastDob) ?? []), i]);
    }
    const pickFor = (list: Inquiry[] | undefined, admitted: Date): Inquiry | undefined => {
      if (!list?.length) return undefined;
      const dayAfter = admitted.getTime() + 86_400_000;
      return list.find((i) => i.submittedAt.getTime() <= dayAfter) ?? list[0];
    };

    // 2. Admissions from the sheet (Admission Board tab).
    const token = await sheetsToken();
    const meta = await sheetsGet(token, `${args.sheetId}?fields=sheets.properties.title`);
    const tabs: string[] = (meta.sheets ?? []).map((s: any) => s.properties?.title).filter(Boolean);
    const named = process.env.OCH_ADMISSIONS_TAB?.trim() ?? null;
    const pick = pickAdmissionTab(tabs, named);
    if (pick.how === "override_missing") throw new Error(`The tab "${named}" is not in the sheet. Tabs now: ${tabs.join(", ") || "none"}.`);
    const tab = pick.tab;
    if (!tab) throw new Error("No sheets found in the spreadsheet.");
    const range = encodeURIComponent(boardRange(tab));
    const values = await sheetsGet(token, `${args.sheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`);
    const rows: string[][] = values.values ?? [];
    if (rowsCapped(rows.length)) throw new Error(`The board has ${rows.length.toLocaleString("en-US")} rows, the most we read (${ROW_LIMIT.toLocaleString("en-US")}). Raise ROW_LIMIT in och-sheet-target.ts.`);
    const hIdx = findHeaderRow(rows);
    const header = rows[hIdx] ?? [];
    // Columns come from the shared resolver: headings where the client's
    // wording still says what a column holds, the column's own data where it
    // does not. A name here goes into a conversion upload to Google, so a
    // board no signal can read still stops the run with the same message it
    // always printed — but a retitled or truncated heading no longer does.
    // This job needs no Referent column; attribution is not its question.
    const cols = resolveAdmissionColumns(rows, { tab, headerRowIndex: hIdx });
    const { dateCols, statusCol, hasStatusCol, phoneCol, dobCol, nameCol } = cols;
    console.log(`Columns → ${describeColumns(header, cols)}`);
    const resolvedNote = contentResolvedNote(cols);
    if (resolvedNote) console.log(resolvedNote);

    const cutoff = Date.now() - args.lookbackDays * 86_400_000;
    const admissions: Admission[] = [];
    let admittedNoDate = 0;
    for (let r = hIdx + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      if (hasStatusCol && !isAdmitted(row[statusCol])) continue;
      let date: Date | null = null;
      for (const dc of dateCols) { date = parseSheetDate(row[dc]); if (date) break; }
      if (!date) { admittedNoDate++; continue; }
      if (date.getTime() < cutoff || date.getTime() > Date.now()) continue; // recent, non-future only
      const name = (row[nameCol] ?? "").toString().trim();
      admissions.push({
        name,
        phone10: phoneCol >= 0 ? phone10(row[phoneCol]) : null,
        lastDob: dobCol >= 0 ? lastDobKey(lastNameOf(name), row[dobCol]) : null,
        date,
      });
    }
    console.log(`Admissions in the last ${args.lookbackDays}d: ${admissions.length}${admittedNoDate ? ` (${admittedNoDate} admitted row(s) skipped — no admission date filled in)` : ""}`);
    reportUnrecognizedStatuses(unrecognizedStatuses);

    // 3. Match.
    // contactPhone / contactEmail: in memory only, hashed at send time and then dropped (never logged or stored).
    interface Match { gclid: string; date: Date; matchedBy: "phone" | "name_dob"; name: string; contactPhone: string | null; contactEmail: string | null; }
    const matches: Match[] = [];
    for (const a of admissions) {
      let inq: Inquiry | undefined;
      let by: "phone" | "name_dob" | null = null;
      if (a.phone10 && byPhone.has(a.phone10)) { inq = pickFor(byPhone.get(a.phone10), a.date); by = "phone"; }
      else if (a.lastDob && byNameDob.has(a.lastDob)) { inq = pickFor(byNameDob.get(a.lastDob), a.date); by = "name_dob"; }
      if (inq && by) matches.push({ gclid: inq.gclid, date: a.date, matchedBy: by, name: a.name, contactPhone: a.phone10 ?? inq.phone10, contactEmail: inq.email });
    }
    console.log(`Matched admissions ↔ ad clicks: ${matches.length}`);
    if (matches.length === 0) {
      console.log("No admissions matched a gclid inquiry in the window. Exiting cleanly.");
      return;
    }

    // 4. Drop clicks we've already converted (idempotent): one admission per
    // click, regardless of which admission-date column intake filled in when.
    const fresh: Match[] = [];
    for (const m of matches) {
      const { rows: seen } = await pgc.query(
        "SELECT 1 FROM offline_conversion_uploads WHERE client_slug=$1 AND gclid=$2",
        [args.clientSlug, m.gclid],
      );
      if (seen.length === 0) fresh.push(m);
    }
    console.log(`New (not yet uploaded): ${fresh.length}`);
    if (fresh.length === 0) { console.log("All matches already uploaded. Exiting cleanly."); return; }

    if (args.dryRun) {
      for (const m of fresh.slice(0, 25)) console.log(`  ${ymd(m.date)} · ${m.name} · gclid=${m.gclid.slice(0, 12)}… · via ${m.matchedBy} · $${valueDollars.toLocaleString()}`);
      console.log("Dry run — no upload, nothing recorded.");
      return;
    }

    // ── CSV stopgap: Google closed UploadClickConversions to new integrations
    // (the Data Manager API replaces it). A person uploads this file in Google
    // Ads, Goals, Conversions, Uploads. Nothing is sent from here. The file holds
    // click ids and times only: no name, phone or date of birth. ──
    if (args.csvPath) {
      const { writeFileSync } = await import("node:fs");
      // Data Manager maps columns by name, so the file is plain named columns with
      // the time zone carried on each time. Column names and the event source value
      // are our best reading of its field list and are unverified: check them
      // against the mapping step's dropdowns before uploading.
      const lines = ["gclid,conversion_time,transaction_id,event_source,conversion_value,currency_code"];
      for (const m of fresh) {
        const day = ymd(m.date);
        lines.push(`${m.gclid},${day} 23:59:59${tzOffsetOn(new Date(`${day}T12:00:00Z`))},och-${m.gclid.slice(0, 20)}-${day},OTHER,${valueDollars},USD`);
      }
      writeFileSync(args.csvPath, lines.join("\n") + "\n");
      console.log(`Wrote ${fresh.length} conversion row(s) to the upload file. Nothing was sent to Google.`);
      if (args.markUploaded) {
        for (const m of fresh) {
          await pgc.query(
            `INSERT INTO offline_conversion_uploads (id, client_slug, gclid, conversion_action, admission_date, value_cents, matched_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            [randomUUID(), args.clientSlug, m.gclid, CONVERSION_ACTION_NAME, ymd(m.date), valueCents, `${m.matchedBy}+manual_csv`],
          );
        }
        console.log(`Recorded ${fresh.length} as uploaded by hand, so the daily run will not try them again.`);
      } else {
        console.log("Not recorded as uploaded. After a person uploads the file, run again with --mark-uploaded.");
      }
      return;
    }

    // ── Google Ads: resolve account + conversion action, then upload ──
    const cfg = {
      clientId: env("GOOGLE_ADS_CLIENT_ID"),
      clientSecret: env("GOOGLE_ADS_CLIENT_SECRET"),
      developerToken: env("GOOGLE_ADS_DEVELOPER_TOKEN"),
      refreshToken: env("GOOGLE_ADS_REFRESH_TOKEN"),
      loginCustomerId: digits(env("GOOGLE_ADS_LOGIN_CUSTOMER_ID")),
    };
    const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });

    // Resolve OCH's Ads customer id — prefer the exact account the daily sync
    // already uses (Admin → Connectors); accessing it through the MCC login
    // header works, whereas querying the MCC itself for discovery does not.
    let customerId = args.customerId ?? (process.env.OCH_ADS_CUSTOMER_ID ? digits(process.env.OCH_ADS_CUSTOMER_ID) : null);
    if (!customerId && matchClient?.id) {
      const { rows: cm } = await pgc.query<{ external_id: string | null }>(
        "SELECT external_id FROM connector_mappings WHERE client_id=$1 AND source='google_ads' AND enabled=true AND external_id IS NOT NULL LIMIT 1",
        [matchClient.id],
      );
      if (cm[0]?.external_id) { customerId = digits(String(cm[0].external_id)); console.log(`OCH Ads account from Admin → Connectors: ${customerId}`); }
    }
    if (!customerId) {
      console.log("No customer id given/mapped — discovering under the MCC by name…");
      const mcc = api.Customer({ customer_id: cfg.loginCustomerId, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
      const clients = await mcc.query(`SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager FROM customer_client`);
      const hit = clients.find((c: any) => !c.customer_client?.manager && /ohio community|och/i.test(c.customer_client?.descriptive_name ?? ""));
      customerId = hit?.customer_client?.id ? digits(String(hit.customer_client.id)) : null;
      if (!customerId) {
        console.error(`Could not auto-find OCH's Ads account under MCC ${cfg.loginCustomerId}. Available: ${clients.map((c: any) => `${c.customer_client?.descriptive_name} (${c.customer_client?.id})`).join(", ")}`);
        console.error("Re-run with --customer=<id> or set OCH_ADS_CUSTOMER_ID.");
        process.exit(1);
      }
      console.log(`Discovered OCH Ads account: ${customerId}`);
    }

    const customer = api.Customer({ customer_id: customerId, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });

    // Look up the "Admission (offline)" action. READ ONLY: this job never creates or edits
    // a conversion action (a new one can default to primary and change bidding).
    const existing = await customer.query(
      `SELECT conversion_action.resource_name, conversion_action.id, conversion_action.type, conversion_action.status, conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.name = '${CONVERSION_ACTION_NAME}'`,
    );
    const ca: any = (existing[0] as any)?.conversion_action ?? null;
    const fault = actionFault(ca, CONVERSION_ACTION_NAME);
    if (fault) { console.error(fault); process.exit(1); }
    const actionId = String(ca.id);
    console.log(`Conversion action ${CONVERSION_ACTION_NAME}: enabled, upload from clicks, secondary.`);

    // Send through the Data Manager API. The first pass is validate-only and sends nothing
    // to the account; a real send needs a validate pass on record within 14 days.
    const sending = args.api === "send";
    // Identifiers: an OCH upload (send or validate) carries them only when
    // OCH_ENHANCED_IDENTIFIERS=send. Without the switch the admissions still go, by click id alone.
    const gate = identifierGate(args.clientSlug, sending, process.env);
    const candidates = fresh.map((m) => hashedIdentifiers({ phone: m.contactPhone, email: m.contactEmail }));
    const idCounts = identifierCounts(candidates.map((userIdentifiers) => ({ userIdentifiers })));
    console.log(identifierSummary(idCounts, gate));
    const dmRows: DmRow[] = fresh.map((m, i) => ({
      gclid: m.gclid, closed: ymd(m.date), valueDollars, transactionId: `och-${m.gclid.slice(0, 20)}-${ymd(m.date)}`,
      ...(gate.include && candidates[i]!.length ? { userIdentifiers: candidates[i] } : {}),
    }));
    const dest = { accountId: customerId, loginAccountId: cfg.loginCustomerId || null, actionId };
    const vKey = `dm_validated:${args.clientSlug}`;
    if (sending) {
      const { rows: vr } = await pgc.query<{ value: string }>("SELECT value FROM app_settings WHERE key=$1", [vKey]);
      if (!validationAllows(vr[0]?.value, new Date())) {
        console.error("Not sending: no validate-only pass on record in the last 14 days. Run this job with --api=validate first and read the result.");
        process.exit(1);
      }
    }
    let dmTok: string;
    try { dmTok = await dmToken(process.env); } catch (e: any) { console.error(e?.message ?? String(e)); process.exit(1); }
    let accepted = 0, failedBatches = 0, firstReason: string | null = null;
    for (const part of chunk(dmRows)) {
      const ans = await ingest(dmTok, buildIngestBody(dest, part, !sending));
      if (!ans.ok) { failedBatches++; firstReason ??= ans.reason; console.error(`Data Manager refused ${part.length} row(s) (HTTP ${ans.status}): ${ans.reason}${ans.scopeProblem ? " The credential needs the Data Manager scope and the account must be linked as a destination." : ""}`); continue; }
      accepted += part.length;
      if (ans.requestId) {
        const st = await requestStatus(dmTok, ans.requestId);
        console.log(`Request ${ans.requestId}: ${st ? `received ${st.received ?? "?"}, failed ${st.failed ?? "?"}` : "status not readable yet"}.`);
      }
    }
    if (failedBatches > 0) { console.error(`Data Manager did not take ${failedBatches} batch(es). First reason: ${firstReason ?? "not stated"}.`); process.exit(1); }
    // Counts only, for the app's Setup row ("Matching by phone or email: on / off"). No hash, no raw value.
    await pgc.query("INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [identifierRecordKey(args.clientSlug), identifierRecord(idCounts, gate, args.api, new Date())]);
    if (!sending) {
      await pgc.query("INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [vKey, new Date().toISOString()]);
      console.log(`Validate-only pass OK for ${accepted} conversion(s). Nothing was sent to the account. Run again with --api=send to send.`);
      return;
    }
    // Accepted by the API (the request status above says how many Google then processed).
    for (const m of fresh) {
      await pgc.query(
        `INSERT INTO offline_conversion_uploads (id, client_slug, gclid, conversion_action, admission_date, value_cents, matched_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [randomUUID(), args.clientSlug, m.gclid, ca.resource_name, ymd(m.date), valueCents, `${m.matchedBy}+data_manager`],
      );
    }
    console.log(`Sent ${accepted} conversion(s) through the Data Manager API and recorded them. Google may take hours to show them in the conversion action.`);
  } finally {
    await pgc.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { JWT } from "google-auth-library";
import { GoogleAdsApi } from "google-ads-api";
import pg from "pg";
import { phone10, lastDobKey, lastNameOf, parseSheetDate, ymd, isAdmittedStatus, reportUnrecognizedStatuses } from "./lead-keys.js";

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

const DEFAULT_SHEET_ID = "1Ls-zDrNemixH2LiMYj9Hh7VumupNufYnRD6HEWL4u-8";
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

interface Args { dryRun: boolean; customerId: string | null; lookbackDays: number; sheetId: string; clientSlug: string; }
function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, customerId: null, lookbackDays: DEFAULT_LOOKBACK_DAYS, sheetId: DEFAULT_SHEET_ID, clientSlug: DEFAULT_CLIENT_SLUG };
  for (const x of argv) {
    if (x === "--dry-run") a.dryRun = true;
    else if (x.startsWith("--customer=")) a.customerId = x.slice(11).replace(/[^0-9]/g, "");
    else if (x.startsWith("--lookback=")) a.lookbackDays = Number(x.slice(11)) || DEFAULT_LOOKBACK_DAYS;
    else if (x.startsWith("--sheet=")) a.sheetId = x.slice(8);
    else if (x.startsWith("--client=")) a.clientSlug = x.slice(9);
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
  const sa = serviceAccount();
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Failed to mint a Sheets access token.");
  return token;
}
async function sheetsGet(token: string, path: string): Promise<any> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}
function findCol(header: string[], needles: string[]): number {
  const norm = header.map((h) => (h ?? "").toString().trim().toLowerCase());
  for (let i = 0; i < norm.length; i++) if (needles.some((n) => norm[i]!.includes(n))) return i;
  return -1;
}
function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    if ((rows[i] ?? []).filter((c) => c && c.toString().trim()).length >= 3) return i;
  }
  return 0;
}
/** Statuses isAdmittedStatus couldn't classify this run — printed once after the scan. */
const unrecognizedStatuses = new Set<string>();
function isAdmitted(cell: string | undefined): boolean {
  return isAdmittedStatus(cell, unrecognizedStatuses); // shared with import-och
}

interface Inquiry { gclid: string; phone10: string | null; lastDob: string | null; firstName: string | null; submittedAt: Date; }
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
    const { rows: inqRows } = await pgc.query<{ gclid: string | null; phone: string | null; dob: string | null; last_name: string | null; first_name: string | null; submitted_at: Date }>(
      `SELECT gclid, phone, dob, last_name, first_name, submitted_at FROM web_inquiries
        WHERE client_slug = $1 AND gclid IS NOT NULL AND gclid <> ''
        ORDER BY submitted_at DESC`,
      [args.clientSlug],
    );
    const inquiries: Inquiry[] = inqRows.map((r) => ({
      gclid: r.gclid!.trim(),
      phone10: phone10(r.phone),
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
    const tab = tabs.find((t) => /admission/i.test(t)) ?? tabs[0];
    const range = encodeURIComponent(`${tab}!A1:Z5000`);
    const values = await sheetsGet(token, `${args.sheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`);
    const rows: string[][] = values.values ?? [];
    const hIdx = findHeaderRow(rows);
    const header = rows[hIdx] ?? [];
    const nameCol = findCol(header, ["name"]);
    const phoneCol = findCol(header, ["phone"]);
    const dobCol = findCol(header, ["dob", "birth"]);
    const statusCol = findCol(header, ["status", "admitted", "disposition"]);
    // Admission-date columns only, per row (intake fills whichever they have).
    // Never the inquiry-received date: that can precede the ad click, and
    // Google rejects a conversion timed before its click.
    const dateCols = [
      findCol(header, ["scheduled admission"]),
      findCol(header, ["projected admission"]),
      findCol(header, ["admission date", "admit date"]),
    ].filter((c) => c >= 0).filter((v, i, a) => a.indexOf(v) === i);
    if (!dateCols.length || nameCol < 0 || (phoneCol < 0 && dobCol < 0)) {
      throw new Error(`Admission Board header not recognized (header row ${hIdx + 1}: ${header.join(" | ").slice(0, 200)}). Need an admission-date column, a name column and a phone or DOB column.`);
    }
    console.log(`Columns → date:${dateCols.map((c) => header[c]).join(" / ")} · name:${header[nameCol]} · phone:${phoneCol >= 0 ? header[phoneCol] : "-"} · dob:${dobCol >= 0 ? header[dobCol] : "-"} · status:${statusCol >= 0 ? header[statusCol] : "(none)"}`);

    const cutoff = Date.now() - args.lookbackDays * 86_400_000;
    const admissions: Admission[] = [];
    let admittedNoDate = 0;
    for (let r = hIdx + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      if (statusCol >= 0 && !isAdmitted(row[statusCol])) continue;
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
    interface Match { gclid: string; date: Date; matchedBy: "phone" | "name_dob"; name: string; }
    const matches: Match[] = [];
    for (const a of admissions) {
      let inq: Inquiry | undefined;
      let by: "phone" | "name_dob" | null = null;
      if (a.phone10 && byPhone.has(a.phone10)) { inq = pickFor(byPhone.get(a.phone10), a.date); by = "phone"; }
      else if (a.lastDob && byNameDob.has(a.lastDob)) { inq = pickFor(byNameDob.get(a.lastDob), a.date); by = "name_dob"; }
      if (inq && by) matches.push({ gclid: inq.gclid, date: a.date, matchedBy: by, name: a.name });
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

    // Find or create the "Admission (offline)" conversion action.
    let actionResource: string | null = null;
    const existing = await customer.query(
      `SELECT conversion_action.resource_name, conversion_action.name, conversion_action.click_through_lookback_window_days FROM conversion_action WHERE conversion_action.name = '${CONVERSION_ACTION_NAME}'`,
    );
    if (existing.length > 0) {
      actionResource = (existing[0] as any)?.conversion_action?.resource_name ?? null;
      const windowDays = Number((existing[0] as any)?.conversion_action?.click_through_lookback_window_days ?? 0);
      console.log(`Using existing conversion action: ${actionResource} (click-through window ${windowDays || "default/unknown"}d)`);
      // A window shorter than our lookback silently rejects every conversion
      // whose click is older than it — raise it, or say loudly that we couldn't.
      if (actionResource && windowDays > 0 && windowDays < CLICK_LOOKBACK_DAYS) {
        try {
          await customer.conversionActions.update([{ resource_name: actionResource, click_through_lookback_window_days: CLICK_LOOKBACK_DAYS } as any]);
          console.log(`Raised click-through window ${windowDays}d → ${CLICK_LOOKBACK_DAYS}d.`);
        } catch (e: any) {
          console.warn(`Could not raise the click-through window (${windowDays}d < ${CLICK_LOOKBACK_DAYS}d): ${e?.errors?.map((x: any) => x.message).join("; ") || e?.message || e}. Raise it by hand in Google Ads → Conversions → "${CONVERSION_ACTION_NAME}" or clicks older than ${windowDays}d will keep being rejected.`);
        }
      }
    } else {
      console.log(`Creating conversion action "${CONVERSION_ACTION_NAME}"…`);
      const created = await customer.conversionActions.create([
        {
          name: CONVERSION_ACTION_NAME,
          type: "UPLOAD_CLICKS" as any,
          category: "DEFAULT" as any,
          status: "ENABLED" as any,
          value_settings: { default_value: valueDollars, always_use_default_value: false },
          counting_type: "ONE_PER_CLICK" as any,
          click_through_lookback_window_days: CLICK_LOOKBACK_DAYS,
        } as any,
      ]);
      actionResource = (created as any).results?.[0]?.resource_name ?? null;
      if (!actionResource) throw new Error("Conversion action creation returned no resource name.");
      console.log(`Created conversion action: ${actionResource}`);
    }

    // Build + upload click conversions. Timed end-of-day in the account's
    // timezone on the admission date, so the conversion is always after the
    // click that produced it.
    const conversions = fresh.map((m) => ({
      gclid: m.gclid,
      conversion_action: actionResource!,
      conversion_date_time: `${ymd(m.date)} 23:59:59${tzOffsetOn(new Date(`${ymd(m.date)}T12:00:00Z`))}`,
      conversion_value: valueDollars,
      currency_code: "USD",
      order_id: `och-${m.gclid.slice(0, 20)}-${ymd(m.date)}`,
    }));

    const resp: any = await customer.conversionUploads.uploadClickConversions({
      customer_id: customerId,
      conversions: conversions as any,
      partial_failure: true,
      validate_only: false,
    } as any);

    // Record ONLY what Google accepted. With partial_failure, results[] is
    // index-aligned with the request and a rejected row comes back empty; the
    // error details name the rejected indexes too. Anything rejected stays
    // unrecorded so the next run retries it (and the log says why).
    const failureMsg: string | undefined = resp?.partial_failure_error?.message;
    const results: any[] = Array.isArray(resp?.results) ? resp.results : [];
    const rejected = new Map<number, string>();
    for (const d of resp?.partial_failure_error?.details ?? []) {
      for (const err of d?.errors ?? []) {
        for (const p of err?.location?.field_path_elements ?? []) {
          if (p?.field_name === "conversions" && typeof p?.index === "number") rejected.set(p.index, err?.message ?? "rejected");
        }
      }
    }
    const accepted = (i: number): boolean => {
      if (rejected.has(i)) return false;
      if (results.length) return Boolean(results[i]?.gclid || results[i]?.conversion_action);
      return !failureMsg;
    };
    if (failureMsg) console.warn(`Google Ads reported partial failures: ${failureMsg}`);
    let recorded = 0;
    fresh.forEach((m, i) => {
      if (!accepted(i)) { console.warn(`  ✗ ${ymd(m.date)} · ${m.name} · gclid=${m.gclid.slice(0, 12)}… — ${rejected.get(i) ?? "not accepted"} (will retry next run)`); return; }
      recorded++;
    });
    for (let i = 0; i < fresh.length; i++) {
      if (!accepted(i)) continue;
      const m = fresh[i]!;
      await pgc.query(
        `INSERT INTO offline_conversion_uploads (id, client_slug, gclid, conversion_action, admission_date, value_cents, matched_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [randomUUID(), args.clientSlug, m.gclid, actionResource, ymd(m.date), valueCents, m.matchedBy],
      );
    }
    console.log(`Sent ${conversions.length} conversion(s) to Google Ads (${customerId}); accepted + recorded ${recorded}, rejected ${conversions.length - recorded}.${recorded ? " The loop is closed — Google now optimizes toward admissions." : ""}`);
  } finally {
    await pgc.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

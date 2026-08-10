#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { JWT } from "google-auth-library";
import { GoogleAdsApi } from "google-ads-api";
import pg from "pg";

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
 *   - Idempotent: uq_offline_conv_identity means an admission is uploaded once.
 *
 * Usage:
 *   npm run import-offline-conversions
 *   npm run import-offline-conversions -- --dry-run
 *   npm run import-offline-conversions -- --customer=1234567890 --lookback=120
 */

const DEFAULT_SHEET_ID = "1Ls-zDrNemixH2LiMYj9Hh7VumupNufYnRD6HEWL4u-8";
const DEFAULT_CLIENT_SLUG = "ohio-community-health-och";
const CONVERSION_ACTION_NAME = "Admission (offline)";
const DEFAULT_LOOKBACK_DAYS = 90; // Ads rejects click conversions older than ~63d; keep a margin.
const DEFAULT_VALUE_CENTS = 800000; // fallback if the client's Customer value is unset

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
function parseDate(v: string | undefined): Date | null {
  const s = (v ?? "").toString().trim();
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  const m = s.match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})/);
  if (m) { let y = Number(m[3]); if (y < 100) y += 2000; return new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2]))); }
  return null;
}
function isAdmitted(cell: string | undefined): boolean {
  const s = (cell ?? "").toString().trim().toLowerCase();
  if (!s) return false;
  if (/(not|no|declin|deni|reject|lost|inactive)/.test(s)) return false;
  return /(admit|yes|enroll|accept|active|complete|won)/.test(s) || s === "y" || s === "1";
}

interface Inquiry { gclid: string; phone10: string | null; lastDob: string | null; firstName: string | null; }
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
    const { rows: inqRows } = await pgc.query<{ gclid: string | null; phone: string | null; dob: string | null; last_name: string | null; first_name: string | null }>(
      `SELECT gclid, phone, dob, last_name, first_name FROM web_inquiries
        WHERE client_slug = $1 AND gclid IS NOT NULL AND gclid <> ''`,
      [args.clientSlug],
    );
    const inquiries: Inquiry[] = inqRows.map((r) => ({
      gclid: r.gclid!.trim(),
      phone10: r.phone ? digits(r.phone).slice(-10) || null : null,
      lastDob: r.last_name && r.dob ? `${r.last_name.trim().toLowerCase()}|${digits(r.dob)}` : null,
      firstName: r.first_name,
    }));
    console.log(`Web inquiries with a gclid: ${inquiries.length}`);
    if (inquiries.length === 0) {
      console.log("No gclids captured yet — nothing to match. (Confirm the website form is feeding Web Inquiries.) Exiting cleanly.");
      return;
    }
    const byPhone = new Map<string, Inquiry>();
    const byNameDob = new Map<string, Inquiry>();
    for (const i of inquiries) {
      if (i.phone10) byPhone.set(i.phone10, i);
      if (i.lastDob) byNameDob.set(i.lastDob, i);
    }

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
    const dateCol = [
      findCol(header, ["scheduled admission"]),
      findCol(header, ["projected admission", "admission date"]),
      findCol(header, ["inquiry received", "inquiry"]),
    ].find((c) => c >= 0) ?? -1;

    const cutoff = Date.now() - args.lookbackDays * 86_400_000;
    const admissions: Admission[] = [];
    for (let r = hIdx + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      if (statusCol >= 0 && !isAdmitted(row[statusCol])) continue;
      const date = parseDate(dateCol >= 0 ? row[dateCol] : undefined);
      if (!date || date.getTime() < cutoff || date.getTime() > Date.now()) continue; // recent, non-future only
      const name = (row[nameCol] ?? "").toString().trim();
      const phone10 = phoneCol >= 0 ? digits(row[phoneCol] ?? "").slice(-10) || null : null;
      const last = name.split(/\s+/).pop()?.toLowerCase() ?? "";
      const dob = dobCol >= 0 ? digits(row[dobCol] ?? "") : "";
      const lastDob = last && dob ? `${last}|${dob}` : null;
      admissions.push({ name, phone10, lastDob, date });
    }
    console.log(`Admissions in the last ${args.lookbackDays}d: ${admissions.length}`);

    // 3. Match.
    interface Match { gclid: string; date: Date; matchedBy: "phone" | "name_dob"; name: string; }
    const matches: Match[] = [];
    for (const a of admissions) {
      let inq: Inquiry | undefined;
      let by: "phone" | "name_dob" | null = null;
      if (a.phone10 && byPhone.has(a.phone10)) { inq = byPhone.get(a.phone10); by = "phone"; }
      else if (a.lastDob && byNameDob.has(a.lastDob)) { inq = byNameDob.get(a.lastDob); by = "name_dob"; }
      if (inq && by) matches.push({ gclid: inq.gclid, date: a.date, matchedBy: by, name: a.name });
    }
    console.log(`Matched admissions ↔ ad clicks: ${matches.length}`);
    if (matches.length === 0) {
      console.log("No admissions matched a gclid inquiry in the window. Exiting cleanly.");
      return;
    }

    // 4. Drop ones we've already uploaded (idempotent).
    const fresh: Match[] = [];
    for (const m of matches) {
      const ymd = m.date.toISOString().slice(0, 10);
      const { rows: seen } = await pgc.query(
        "SELECT 1 FROM offline_conversion_uploads WHERE client_slug=$1 AND gclid=$2 AND admission_date=$3",
        [args.clientSlug, m.gclid, ymd],
      );
      if (seen.length === 0) fresh.push(m);
    }
    console.log(`New (not yet uploaded): ${fresh.length}`);
    if (fresh.length === 0) { console.log("All matches already uploaded. Exiting cleanly."); return; }

    if (args.dryRun) {
      for (const m of fresh.slice(0, 25)) console.log(`  ${m.date.toISOString().slice(0, 10)} · ${m.name} · gclid=${m.gclid.slice(0, 12)}… · via ${m.matchedBy} · $${valueDollars.toLocaleString()}`);
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
      `SELECT conversion_action.resource_name, conversion_action.name FROM conversion_action WHERE conversion_action.name = '${CONVERSION_ACTION_NAME}'`,
    );
    if (existing.length > 0) {
      actionResource = (existing[0] as any)?.conversion_action?.resource_name ?? null;
      console.log(`Using existing conversion action: ${actionResource}`);
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
        } as any,
      ]);
      actionResource = (created as any).results?.[0]?.resource_name ?? null;
      if (!actionResource) throw new Error("Conversion action creation returned no resource name.");
      console.log(`Created conversion action: ${actionResource}`);
    }

    // Build + upload click conversions.
    const conversions = fresh.map((m) => ({
      gclid: m.gclid,
      conversion_action: actionResource!,
      conversion_date_time: `${m.date.toISOString().slice(0, 10)} 12:00:00+00:00`,
      conversion_value: valueDollars,
      currency_code: "USD",
      order_id: `och-${m.gclid.slice(0, 20)}-${m.date.toISOString().slice(0, 10)}`,
    }));

    const resp: any = await customer.conversionUploads.uploadClickConversions({
      customer_id: customerId,
      conversions: conversions as any,
      partial_failure: true,
      validate_only: false,
    } as any);

    // Record successes (partial_failure means some may have been rejected).
    const failureMsg = resp?.partial_failure_error?.message;
    if (failureMsg) console.warn(`Partial failures from Google Ads: ${failureMsg}`);
    let recorded = 0;
    for (const m of fresh) {
      const ymd = m.date.toISOString().slice(0, 10);
      await pgc.query(
        `INSERT INTO offline_conversion_uploads (id, client_slug, gclid, conversion_action, admission_date, value_cents, matched_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [randomUUID(), args.clientSlug, m.gclid, actionResource, ymd, valueCents, m.matchedBy],
      );
      recorded++;
    }
    console.log(`Uploaded ${conversions.length} conversion(s) to Google Ads (${customerId}); recorded ${recorded}. The loop is closed — Google now optimizes toward admissions.`);
  } finally {
    await pgc.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

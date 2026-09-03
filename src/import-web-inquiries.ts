#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { JWT } from "google-auth-library";
import pg from "pg";
import { normalizeDob, phone10 } from "./lead-keys.js";

/**
 * Web inquiries (paid/organic form fills) → dashboard `web_inquiries` table.
 *
 * OCH's Elementor form logs every submission to the "Web Inquiries" tab of the
 * same Google Sheet we already read for admissions, one row per submission with
 * the gclid + UTM tags the landing page captured. This importer reads that tab
 * and lands each row in Postgres so the dashboard's Marketing → Web Inquiries
 * view shows real leads, and so close-the-loop can later match a gclid here to
 * an admission on the Admission Board tab and upload it to Google Ads as an
 * offline conversion.
 *
 * Architecture note: the worker owns the write (CLAUDE.md — the deployed app
 * only reads Postgres; a separate sync process writes). Ingestion is idempotent
 * — a person already captured by the live /api/webform webhook (same email, or
 * same phone when there's no email, with the same gclid) is not inserted again
 * — so this is safe to re-run and safe to run alongside the webhook. (The old
 * uq_web_inquiries_identity index this used to lean on was dropped in the
 * dashboard's schema v117: it keyed on email+dob+gclid and collapsed every
 * phone-only organic lead into one row.)
 *
 * Prereqs (one-time):
 *   1. Share the sheet (Viewer) with the service account's client_email.
 *   2. The tab must have a header row with First Name / Last Name / Email /
 *      Phone / DOB / gclid / utm_* / Submitted At columns (already set up).
 *
 * Usage:
 *   npm run import-web-inquiries
 *   npm run import-web-inquiries -- --dry-run
 *   npm run import-web-inquiries -- --sheet=<id> --tab='Web Inquiries' --client=<slug>
 */

const DEFAULT_SHEET_ID = "1Ls-zDrNemixH2LiMYj9Hh7VumupNufYnRD6HEWL4u-8";
const DEFAULT_TAB = "Web Inquiries";
const DEFAULT_CLIENT = "ohio-community-health-och";

interface Args {
  sheetId: string;
  tab: string;
  client: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let sheetId = DEFAULT_SHEET_ID;
  let tab = DEFAULT_TAB;
  let client = DEFAULT_CLIENT;
  let dryRun = false;
  for (const a of argv) {
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

/** First column index whose header contains any needle (case-insensitive). */
function findCol(header: string[], needles: string[]): number {
  const norm = header.map((h) => (h ?? "").toString().trim().toLowerCase());
  for (let i = 0; i < norm.length; i++) if (needles.some((n) => norm[i]!.includes(n))) return i;
  return -1;
}

/** First row (within the first few) with ≥3 non-empty cells is the header. */
function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const filled = (rows[i] ?? []).filter((c) => c && c.toString().trim()).length;
    if (filled >= 3) return i;
  }
  return 0;
}

function parseSubmittedAt(v: string | undefined): Date | null {
  const s = (v ?? "").toString().trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function cell(row: string[], idx: number): string | null {
  if (idx < 0) return null;
  const v = (row[idx] ?? "").toString().trim();
  return v || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Web inquiries import — sheet ${args.sheetId}${args.dryRun ? " (dry-run)" : ""}`);

  const token = await sheetsToken();

  // Confirm the tab exists (helpful error if it was renamed).
  const meta = await sheetsGet(token, `${args.sheetId}?fields=sheets.properties.title`);
  const tabs: string[] = (meta.sheets ?? []).map((s: any) => s.properties?.title).filter(Boolean);
  if (!tabs.includes(args.tab)) {
    const guess = tabs.find((t) => t.toLowerCase().includes("inquir"));
    if (guess) {
      console.log(`Tab "${args.tab}" not found — using closest match "${guess}". (available: ${tabs.join(", ")})`);
      args.tab = guess;
    } else {
      throw new Error(`Tab "${args.tab}" not found. Available: ${tabs.join(", ") || "none"}`);
    }
  }

  const range = encodeURIComponent(`${args.tab}!A1:Z10000`);
  const values = await sheetsGet(token, `${args.sheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`);
  const rows: string[][] = values.values ?? [];
  if (!rows.length) {
    console.log("The Web Inquiries tab is empty — nothing to import (no submissions logged yet).");
    return;
  }

  const hIdx = findHeaderRow(rows);
  const header = rows[hIdx]!;
  const cols = {
    firstName: findCol(header, ["first name", "first"]),
    lastName: findCol(header, ["last name", "last"]),
    email: findCol(header, ["email"]),
    phone: findCol(header, ["phone"]),
    dob: findCol(header, ["dob", "birth"]),
    gclid: findCol(header, ["gclid"]),
    utmSource: findCol(header, ["utm_source", "utm source"]),
    utmMedium: findCol(header, ["utm_medium", "utm medium"]),
    utmCampaign: findCol(header, ["utm_campaign", "utm campaign"]),
    utmContent: findCol(header, ["utm_content", "utm content"]),
    utmTerm: findCol(header, ["utm_term", "utm term"]),
    submittedAt: findCol(header, ["submitted", "timestamp", "date"]),
  };
  console.log(
    `Columns → email:${cols.email >= 0 ? header[cols.email] : "?"} · gclid:${cols.gclid >= 0 ? header[cols.gclid] : "?"} · submitted:${cols.submittedAt >= 0 ? header[cols.submittedAt] : "?"}`,
  );

  interface InquiryRow {
    firstName: string | null; lastName: string | null; email: string | null;
    phone: string | null; dob: string | null; gclid: string | null;
    utmSource: string | null; utmMedium: string | null; utmCampaign: string | null;
    utmContent: string | null; utmTerm: string | null; submittedAt: Date | null;
  }
  const parsed: InquiryRow[] = [];
  for (let r = hIdx + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const email = cell(row, cols.email);
    const gclid = cell(row, cols.gclid);
    const firstName = cell(row, cols.firstName);
    // Skip blank rows — need at least an identity to store a lead.
    if (!email && !gclid && !firstName) continue;
    parsed.push({
      firstName,
      lastName: cell(row, cols.lastName),
      email,
      phone: cell(row, cols.phone),
      dob: normalizeDob(cell(row, cols.dob)),
      gclid,
      utmSource: cell(row, cols.utmSource),
      utmMedium: cell(row, cols.utmMedium),
      utmCampaign: cell(row, cols.utmCampaign),
      utmContent: cell(row, cols.utmContent),
      utmTerm: cell(row, cols.utmTerm),
      submittedAt: parseSubmittedAt(cell(row, cols.submittedAt) ?? undefined),
    });
  }
  console.log(`Parsed ${parsed.length} inquiry row(s) from "${args.tab}".`);

  if (args.dryRun) {
    for (const p of parsed.slice(0, 20)) {
      console.log(`  ${p.submittedAt?.toISOString().slice(0, 10) ?? "?"} · ${p.email ?? "(no email)"} · gclid=${p.gclid ? "yes" : "no"} · ${p.utmSource ?? "-"}/${p.utmCampaign ?? "-"}`);
    }
    if (parsed.length > 20) console.log(`  … and ${parsed.length - 20} more`);
    console.log("Dry run — no rows written.");
    return;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Missing DATABASE_URL.");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let inserted = 0;
  let skipped = 0;
  try {
    for (const p of parsed) {
      // Skip anyone the webhook (or an earlier run) already stored: same
      // email — or same phone when the row has no email — with the same gclid.
      const emailKey = p.email?.trim().toLowerCase() || null;
      const phoneKey = phone10(p.phone);
      const res = await client.query(
        `INSERT INTO web_inquiries
           (id, client_slug, first_name, last_name, email, phone, dob, gclid,
            utm_source, utm_medium, utm_campaign, utm_content, utm_term, raw_json, submitted_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, COALESCE($15, now())
          WHERE NOT EXISTS (
            SELECT 1 FROM web_inquiries w
             WHERE w.client_slug = $2
               AND coalesce(w.gclid, '') = coalesce($8, '')
               AND (
                 ($16::text IS NOT NULL AND lower(coalesce(w.email, '')) = $16::text)
                 OR ($16::text IS NULL AND $17::text IS NOT NULL
                     AND right(regexp_replace(coalesce(w.phone, ''), '[^0-9]', '', 'g'), 10) = $17::text)
               )
          )`,
        [
          randomUUID(), args.client, p.firstName, p.lastName, p.email, p.phone, p.dob, p.gclid,
          p.utmSource, p.utmMedium, p.utmCampaign, p.utmContent, p.utmTerm,
          JSON.stringify({ source: "sheet:Web Inquiries" }), p.submittedAt,
          emailKey, phoneKey,
        ],
      );
      if (res.rowCount && res.rowCount > 0) inserted++;
      else skipped++;
    }
  } finally {
    await client.end();
  }
  console.log(`Done — ${inserted} new inquir${inserted === 1 ? "y" : "ies"} inserted, ${skipped} already present.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

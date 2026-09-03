#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import pg from "pg";
import { phone10 } from "./lead-keys.js";

/**
 * Writes OCH's website leads into a tab WE own inside their intake sheet —
 * "BS LLC — Web Leads" — so the intake team sees every lead our side has
 * (webhook form fills, tracked calls, and the backfilled form log) next to
 * whether it's on their Admission Board yet, without anyone touching their
 * own tabs. The Admission Board and every other tab are read-only to this
 * script; only our tab is (re)written, fully, on each run.
 *
 * Approved 2026-09-03 as the one outbound sheet write (see CLAUDE.md, Data
 * architecture). Needs the shared service account shared on the sheet as
 * EDITOR (it has been Viewer); a 403 on write prints exactly that.
 *
 *   npm run publish-och-web-leads -- --dry-run     # print, write nothing
 *   npm run publish-och-web-leads
 */
const SHEET_ID = "1Ls-zDrNemixH2LiMYj9Hh7VumupNufYnRD6HEWL4u-8";
const BOARD_TAB = "Admission Board";
const OUR_TAB = "BS LLC — Web Leads";
const CLIENT = "ohio-community-health-och";
const INTERNAL_TEST_EMAILS = ["sebastienhue@gmail.com", "test-inquiry@bsllc.biz"];
const dryRun = process.argv.includes("--dry-run");

function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const et = (d: Date, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", ...opts }).format(d);
const fmtWhen = (d: Date) => et(d, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

let jwt: JWT | null = null;
let saEmail = "";
async function token(): Promise<string> {
  if (!jwt) {
    const sa = JSON.parse(env("GOOGLE_SERVICE_ACCOUNT_JSON"));
    saEmail = sa.client_email;
    jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  }
  const { token: t } = await jwt.getAccessToken();
  if (!t) throw new Error("Could not mint a Sheets token.");
  return t;
}
async function sheets(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 403 && method !== "GET") {
    throw new Error(`Sheets refused the write (403). Share the intake sheet with ${saEmail} as EDITOR (it's currently Viewer), then re-run. Nothing was changed.`);
  }
  if (!res.ok) throw new Error(`Sheets ${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
const findCol = (header: string[], needles: string[]) => header.map((h) => String(h ?? "").trim().toLowerCase()).findIndex((h) => needles.some((n) => h.includes(n)));

interface Inq {
  submitted_at: Date; first_name: string | null; last_name: string | null; email: string | null; phone: string | null;
  gclid: string | null; utm_source: string | null; utm_medium: string | null; utm_campaign: string | null;
  form_name: string | null; page_url: string | null; raw_json: string | null;
}
interface Board { status: string; referent: string; received: string; admit: string }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  let inquiries: Inq[];
  try {
    inquiries = (await c.query<Inq>(
      `SELECT submitted_at, first_name, last_name, email, phone, gclid, utm_source, utm_medium, utm_campaign,
              form_name, page_url, raw_json
         FROM web_inquiries
        WHERE client_slug = $1
          AND (email IS NULL OR (email NOT ILIKE '%@bsllc.biz' AND email <> ALL($2::text[])))
        ORDER BY submitted_at DESC`,
      [CLIENT, INTERNAL_TEST_EMAILS],
    )).rows;
  } catch (e: any) {
    if (/form_name|page_url/.test(String(e?.message))) {
      // Columns arrive with the dashboard's schema v117 (or the backfill one-off).
      inquiries = (await c.query<Inq>(
        `SELECT submitted_at, first_name, last_name, email, phone, gclid, utm_source, utm_medium, utm_campaign,
                NULL::text AS form_name, NULL::text AS page_url, raw_json
           FROM web_inquiries WHERE client_slug = $1
            AND (email IS NULL OR (email NOT ILIKE '%@bsllc.biz' AND email <> ALL($2::text[])))
          ORDER BY submitted_at DESC`,
        [CLIENT, INTERNAL_TEST_EMAILS],
      )).rows;
    } else throw e;
  } finally {
    await c.end();
  }
  console.log(`${inquiries.length} OCH leads on our side.`);

  // Admission Board, read-only, indexed by phone.
  const board = new Map<string, Board>();
  {
    const range = encodeURIComponent(`${BOARD_TAB}!A1:Z10000`);
    const rows: string[][] = (await sheets("GET", `/values/${range}?valueRenderOption=FORMATTED_VALUE`)).values ?? [];
    let h = 0;
    for (let i = 0; i < Math.min(rows.length, 8); i++) if ((rows[i] ?? []).filter((x) => x && String(x).trim()).length >= 3) { h = i; break; }
    const header = rows[h] ?? [];
    const col = {
      phone: findCol(header, ["phone"]), status: findCol(header, ["status"]), referent: findCol(header, ["referent"]),
      received: findCol(header, ["inquiry received", "received"]), admit: findCol(header, ["scheduled admission", "admission date", "admit"]),
    };
    if (col.phone < 0) throw new Error(`"${BOARD_TAB}" has no phone column in its header (${header.join(" | ").slice(0, 160)}).`);
    const cell = (r: string[], i: number) => (i >= 0 ? String(r[i] ?? "").trim() : "");
    for (const r of rows.slice(h + 1)) {
      const p = phone10(r[col.phone]);
      if (p && !board.has(p)) board.set(p, { status: cell(r, col.status), referent: cell(r, col.referent), received: cell(r, col.received), admit: cell(r, col.admit) });
    }
    console.log(`${board.size} phone numbers on "${BOARD_TAB}".`);
  }

  const sourceOf = (i: Inq): string => {
    if (i.raw_json?.includes('"elementor-log-export"')) return "Website form (from form log)";
    if (i.form_name) return "Website form";
    if (!i.email && !i.form_name) return "Tracked call / unnamed form";
    return "Website form";
  };
  const values: (string | number)[][] = [
    [`Generated by BS LLC OS on ${fmtWhen(new Date())} ET. Read-only: this tab is rewritten daily; your other tabs are never touched. "On board" matches by phone number against the Admission Board.`],
    ["Captured (ET)", "Source", "Form", "Name", "Phone", "Email", "Ad click", "Campaign", "Landing page", "On board", "Board status", "Board referent", "Inquiry received", "Admission date"],
  ];
  let onBoard = 0;
  for (const i of inquiries) {
    const p = phone10(i.phone);
    const b = p ? board.get(p) : undefined;
    if (b) onBoard++;
    values.push([
      fmtWhen(new Date(i.submitted_at)),
      sourceOf(i),
      i.form_name ?? "",
      [i.first_name, i.last_name].filter(Boolean).join(" "),
      i.phone ?? "",
      i.email ?? "",
      i.gclid ? "yes" : "",
      i.utm_campaign ?? (i.utm_source ? `${i.utm_source}${i.utm_medium ? `/${i.utm_medium}` : ""}` : ""),
      i.page_url ?? "",
      b ? "yes" : "NO",
      b?.status ?? "",
      b?.referent ?? "",
      b?.received ?? "",
      b?.admit ?? "",
    ]);
  }
  console.log(`${onBoard} of ${inquiries.length} are on the board; ${inquiries.length - onBoard} are not.`);
  if (dryRun) {
    for (const v of values.slice(0, 12)) console.log("  " + v.map((x) => String(x).slice(0, 22)).join(" | "));
    if (values.length > 12) console.log(`  … ${values.length - 12} more rows`);
    console.log(`Dry run — "${OUR_TAB}" not written.`);
    return;
  }

  // Our tab: create if missing (never touches any other tab), then replace its contents.
  const meta = await sheets("GET", `?fields=sheets.properties(sheetId,title)`);
  const ours = (meta.sheets ?? []).map((s: any) => s.properties).find((p: any) => p?.title === OUR_TAB);
  let sheetId: number;
  if (!ours) {
    const created = await sheets("POST", `:batchUpdate`, { requests: [{ addSheet: { properties: { title: OUR_TAB, gridProperties: { frozenRowCount: 2 } } } }] });
    sheetId = created.replies?.[0]?.addSheet?.properties?.sheetId;
    console.log(`Created tab "${OUR_TAB}".`);
  } else {
    sheetId = ours.sheetId;
  }
  const tabRef = `'${OUR_TAB.replace(/'/g, "''")}'`;
  await sheets("POST", `/values/${encodeURIComponent(`${tabRef}!A:Z`)}:clear`, {});
  await sheets("PUT", `/values/${encodeURIComponent(`${tabRef}!A1`)}?valueInputOption=RAW`, { range: `${tabRef}!A1`, majorDimension: "ROWS", values });
  await sheets("POST", `:batchUpdate`, { requests: [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2 } }, fields: "gridProperties.frozenRowCount" } },
    { repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: 2 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
  ] });
  console.log(`Wrote ${values.length - 2} lead row(s) to "${OUR_TAB}".`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

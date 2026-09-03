#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import pg from "pg";

/**
 * READ-ONLY. Reconciles OCH's website form log against every downstream step.
 *
 * Input: a manual export straight from the site's form tool (Elementor's own
 * submission log — 36 real submissions, Jul 1–Aug 24 2026, each tagged with the
 * form it came through). For each one, answers:
 *   1. Did it reach OUR capture (web_inquiries, fed by /api/webform)?
 *   2. Did it reach the intake team's Admission Board sheet?
 *   3. If so, what did intake write in Referent / Status / dates?
 *
 * Also dumps the SHAPE of what the webhook has actually been storing (raw_json
 * key patterns, literal-field-id values, form names) so a parser bug shows up
 * as data, not a theory. Names/phones are the same ones already on the sheet;
 * phones print as last-4 only.
 *
 *   npm run debug-och-form-submissions-gap
 */
const SHEET_ID = "1Ls-zDrNemixH2LiMYj9Hh7VumupNufYnRD6HEWL4u-8";
const TAB = "Admission Board";
const CLIENT = "ohio-community-health-och";
const WEBHOOK_LIVE_FROM = "2026-08-07"; // ac0f74c — /api/webform did not exist before this.

function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const digits = (s: unknown) => String(s ?? "").replace(/[^0-9]/g, "");
const p10 = (s: unknown) => digits(s).slice(-10);
const last4 = (s: unknown) => { const d = digits(s); return d ? `…${d.slice(-4)}` : "—"; };

const SUBMISSIONS: Array<{ name: string; phone: string; date: string; via: string }> = [
  { name: "Katherine Johnson", phone: "513-520-1345", date: "2026-07-01", via: "Verify Insurance" },
  { name: "Austin Grimes", phone: "513-923-0611", date: "2026-07-02", via: "Ads Landing Page" },
  { name: "Emmily Upper", phone: "937-307-9063", date: "2026-07-02", via: "Contact Page" },
  { name: "William Schroer", phone: "513-975-7533", date: "2026-07-02", via: "Verify Insurance" },
  { name: "Osmany Colindres", phone: "513-288-8276", date: "2026-07-04", via: "Ads Landing Page" },
  { name: "Marlene Scoenmann", phone: "602-920-4881", date: "2026-07-05", via: "Ads Landing Page" },
  { name: "Verline Dotson", phone: "513-509-4162", date: "2026-07-06", via: "Ads Landing Page" },
  { name: "William Jurgens", phone: "513-889-6692", date: "2026-07-06", via: "Contact Page" },
  { name: "Brad Seitz", phone: "513-407-8808", date: "2026-07-07", via: "Ads Landing Page" },
  { name: "Aaron Willen", phone: "283-222-6760", date: "2026-07-09", via: "Verify Insurance" },
  { name: "Jose Zertuche", phone: "956-351-2384", date: "2026-07-09", via: "Home Page" },
  { name: "William Townsend", phone: "937-212-1718", date: "2026-07-11", via: "Verify Insurance" },
  { name: "Keith Fitzpatrick", phone: "216-408-3390", date: "2026-07-14", via: "Ads Landing Page" },
  { name: "Bethany Copas", phone: "740-804-5458", date: "2026-07-14", via: "Ads Landing Page" },
  { name: "Joshua Gross", phone: "513-226-5109", date: "2026-07-16", via: "Ads Landing Page + Verify Insurance" },
  { name: "Crystal Kolb", phone: "513-709-1691", date: "2026-07-17", via: "PHP Page" },
  { name: "Sara Johnson", phone: "513-416-0975", date: "2026-07-23", via: "IOP Page" },
  { name: "Thomas Collins", phone: "336-520-8815", date: "2026-07-24", via: "Verify Insurance" },
  { name: "Melody Davis", phone: "513-680-1612", date: "2026-07-26", via: "Ads Landing Page" },
  { name: "Sammy Doss", phone: "330-322-7519", date: "2026-07-26", via: "Ads Landing Page" },
  { name: "Yahdah Hargrove", phone: "513-883-7234", date: "2026-07-27", via: "Ads Landing Page" },
  { name: "Heather Wilson", phone: "513-954-9080", date: "2026-07-27", via: "Verify Insurance" },
  { name: "Karie Leonard", phone: "513-857-6194", date: "2026-07-27", via: "Ads Landing Page" },
  { name: "Dexter Norman", phone: "513-834-1587", date: "2026-08-01", via: "Ads Landing Page" },
  { name: "Alexandrea Anglin", phone: "513-413-9335", date: "2026-08-03", via: "Ads Landing Page" },
  { name: "Layne Nyland", phone: "513-277-9687", date: "2026-08-06", via: "OCH East Page" },
  { name: "Jermaine Powell", phone: "283-223-2891", date: "2026-08-07", via: "Ads Landing Page" },
  { name: "George Clarke", phone: "740-963-5101", date: "2026-08-08", via: "Ads Landing Page" },
  { name: "John Leopold", phone: "513-903-9847", date: "2026-08-10", via: "Verify Insurance" },
  { name: "Kelly Harris", phone: "283-225-2661", date: "2026-08-10", via: "PHP Page" },
  { name: "Daneil Hill", phone: "513-233-1258", date: "2026-08-10", via: "Ads Landing Page" },
  { name: "Amy Nevil", phone: "513-255-6651", date: "2026-08-12", via: "Contact Page" },
  { name: "Josh Meyer", phone: "513-923-0239", date: "2026-08-14", via: "Verify Insurance" },
  { name: "patrick hollin", phone: "513-344-7228", date: "2026-08-18", via: "Verify Insurance" },
  { name: "Julie Adkins", phone: "", date: "2026-08-22", via: "Ads Landing Page" },
  { name: "Ryan Gibson", phone: "513-254-7672", date: "2026-08-23", via: "Verify Insurance" },
  { name: "Chloey Bynum", phone: "937-601-6791", date: "2026-08-24", via: "Ads Landing Page" },
];

interface Inq {
  id: string; submitted_at: Date; first_name: string | null; last_name: string | null; email: string | null;
  phone: string | null; dob: string | null; gclid: string | null; utm_source: string | null; utm_medium: string | null;
  utm_campaign: string | null; raw_json: string | null;
}

/** What form did this row come through, per whatever the payload carried. */
function formNameFrom(raw: string | null): string | null {
  if (!raw) return null;
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const direct = o["form[name]"] ?? o["form_name"] ?? (o["form"] && typeof o["form"] === "object" ? (o["form"] as Record<string, unknown>)["name"] : undefined);
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const src = o["source"];
  return typeof src === "string" ? src : null;
}

/** Key-shape fingerprint: how the form tool named things (advanced vs simple). */
function keyShape(raw: string | null): string {
  if (!raw) return "(none)";
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return "(unparseable)"; }
  if (!obj || typeof obj !== "object") return "(non-object)";
  const keys = Object.keys(obj as object);
  if (keys.some((k) => /^fields\[/.test(k) || k === "fields")) return "advanced fields[id][part]";
  if (keys.some((k) => /^form_fields\[/.test(k) || k === "form_fields")) return "form_fields[id]";
  if (keys.includes("source")) return "sheet import";
  return `flat (${keys.slice(0, 4).join(",")}${keys.length > 4 ? ",…" : ""})`;
}

async function sheetRows(): Promise<string[][]> {
  const sa = JSON.parse(env("GOOGLE_SERVICE_ACCOUNT_JSON"));
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const { token } = await jwt.getAccessToken();
  const range = encodeURIComponent(`${TAB}!A1:Z10000`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueRenderOption=FORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()).values ?? []) as string[][];
}
const findCol = (header: string[], needles: string[]) => {
  const norm = header.map((h) => String(h ?? "").trim().toLowerCase());
  return norm.findIndex((h) => needles.some((n) => h.includes(n)));
};

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: inquiries } = await c.query<Inq>(
      `SELECT id, submitted_at, first_name, last_name, email, phone, dob, gclid, utm_source, utm_medium, utm_campaign, raw_json
         FROM web_inquiries WHERE client_slug = $1 ORDER BY submitted_at`,
      [CLIENT],
    );

    // ── 1. What has the webhook actually been storing? ──────────────────────
    console.log(`=== 1. web_inquiries for OCH: ${inquiries.length} rows ===`);
    if (inquiries.length) {
      console.log(`  first: ${inquiries[0]!.submitted_at.toISOString().slice(0, 10)} · last: ${inquiries[inquiries.length - 1]!.submitted_at.toISOString().slice(0, 10)}`);
    }
    const withGclid = inquiries.filter((i) => i.gclid && i.gclid.trim()).length;
    const noPhone = inquiries.filter((i) => p10(i.phone).length !== 10).length;
    const noEmail = inquiries.filter((i) => !i.email?.trim()).length;
    const literalIds = inquiries.filter((i) => ["email", "gclid", "phone", "first_name", "last_name", "name"].includes(String(i.email ?? "").toLowerCase()) || String(i.gclid ?? "").toLowerCase() === "gclid" || String(i.phone ?? "").toLowerCase() === "phone");
    console.log(`  with gclid: ${withGclid} · no usable phone: ${noPhone} · no email: ${noEmail} · DOB present: ${inquiries.filter((i) => i.dob).length}`);
    console.log(`  rows where a field's literal ID got stored as its value (parser bug signature): ${literalIds.length}`);
    const shapes = new Map<string, number>();
    const forms = new Map<string, number>();
    for (const i of inquiries) {
      shapes.set(keyShape(i.raw_json), (shapes.get(keyShape(i.raw_json)) ?? 0) + 1);
      const f = formNameFrom(i.raw_json) ?? "(no form name in payload)";
      forms.set(f, (forms.get(f) ?? 0) + 1);
    }
    console.log(`  payload shapes: ${[...shapes].map(([k, v]) => `${k}=${v}`).join(" · ")}`);
    console.log(`  forms seen: ${[...forms].map(([k, v]) => `${k}=${v}`).join(" · ")}`);
    if (inquiries[inquiries.length - 1]?.raw_json) {
      const raw = inquiries[inquiries.length - 1]!.raw_json!;
      // Keys only — enough to see the exact shape without printing PII.
      try { console.log(`  latest payload keys: ${Object.keys(JSON.parse(raw)).join(", ").slice(0, 600)}`); } catch { /* ignore */ }
    }
    console.log(`\n  every row (date · name · phone · email? · gclid? · utm · form):`);
    for (const i of inquiries) {
      const nm = [i.first_name, i.last_name].filter(Boolean).join(" ") || "(no name)";
      console.log(`   ${i.submitted_at.toISOString().slice(0, 16).replace("T", " ")} · ${nm.padEnd(24)} · ${last4(i.phone).padEnd(6)} · ${i.email ? "email" : "no-email"} · ${i.gclid ? "gclid" : "  -  "} · ${(i.utm_source ?? "-")}/${(i.utm_medium ?? "-")}/${(i.utm_campaign ?? "-")} · ${formNameFrom(i.raw_json) ?? "?"}`);
    }

    // ── 2. Admission Board by phone ─────────────────────────────────────────
    const rows = await sheetRows();
    let hIdx = 0;
    for (let i = 0; i < Math.min(rows.length, 8); i++) if ((rows[i] ?? []).filter((x) => x && String(x).trim()).length >= 3) { hIdx = i; break; }
    const header = rows[hIdx] ?? [];
    const col = {
      phone: findCol(header, ["phone"]), name: findCol(header, ["name"]), status: findCol(header, ["status"]),
      referent: findCol(header, ["referent"]), received: findCol(header, ["inquiry received", "received"]),
      admit: findCol(header, ["scheduled admission", "admission date", "admit"]),
    };
    console.log(`\n=== 2. Admission Board: ${rows.length - hIdx - 1} rows · phone col "${header[col.phone] ?? "?"}" · status "${header[col.status] ?? "?"}" · referent "${header[col.referent] ?? "?"}" ===`);
    interface Board { name: string; status: string; referent: string; received: string; admit: string }
    const board = new Map<string, Board[]>();
    for (const r of rows.slice(hIdx + 1)) {
      const ph = col.phone >= 0 ? p10(r[col.phone]) : "";
      if (ph.length !== 10) continue;
      const cellv = (i: number) => (i >= 0 ? String(r[i] ?? "").trim() : "");
      const b: Board = { name: cellv(col.name), status: cellv(col.status), referent: cellv(col.referent), received: cellv(col.received), admit: cellv(col.admit) };
      board.set(ph, [...(board.get(ph) ?? []), b]);
    }
    console.log(`  ${board.size} distinct phone numbers on the board.`);

    // ── 3. The 36 form submissions, end to end ──────────────────────────────
    const byPhone = new Map<string, Inq>();
    for (const i of inquiries) { const k = p10(i.phone); if (k.length === 10 && !byPhone.has(k)) byPhone.set(k, i); }

    console.log(`\n=== 3. Form log → our capture → intake board ===`);
    console.log(`  (webhook live from ${WEBHOOK_LIVE_FROM}; anything earlier could not have been captured by us)`);
    const tally = { pre: 0, postFound: 0, postMissing: 0, noPhone: 0, onBoard: 0, admitted: 0, onBoardMarketingReferent: 0 };
    const MARKETING = /google|web ?form|online|website|internet|facebook|ads?|ppc|seo|search/i;
    for (const s of SUBMISSIONS) {
      const k = p10(s.phone);
      const post = s.date >= WEBHOOK_LIVE_FROM;
      let capture: string;
      if (k.length !== 10) { capture = "no phone → can't check"; tally.noPhone++; }
      else if (!post) { capture = "pre-launch"; tally.pre++; }
      else if (byPhone.has(k)) { const i = byPhone.get(k)!; capture = `CAPTURED ${i.submitted_at.toISOString().slice(0, 10)}${i.gclid ? " +gclid" : ""}`; tally.postFound++; }
      else { capture = "MISSING"; tally.postMissing++; }
      const b = k.length === 10 ? board.get(k) : undefined;
      let intake = "not on board";
      if (b?.length) {
        tally.onBoard++;
        const x = b[0]!;
        const adm = /admit|active|complete|discharg/i.test(x.status);
        if (adm) tally.admitted++;
        if (MARKETING.test(x.referent)) tally.onBoardMarketingReferent++;
        intake = `ON BOARD status="${x.status || "-"}" referent="${x.referent || "-"}" received=${x.received || "-"} admit=${x.admit || "-"}${b.length > 1 ? ` (+${b.length - 1} more rows)` : ""}`;
      }
      console.log(`  ${s.date} · ${s.name.padEnd(20)} · ${s.via.padEnd(34)} · ${capture.padEnd(24)} · ${intake}`);
    }
    console.log(`\n  Summary: ${SUBMISSIONS.length} submissions · pre-launch ${tally.pre} · post-launch captured ${tally.postFound} / missing ${tally.postMissing} · no phone ${tally.noPhone}`);
    console.log(`           on Admission Board ${tally.onBoard} · admitted ${tally.admitted} · of those on board, Referent names a marketing channel: ${tally.onBoardMarketingReferent}`);

    // ── 4. The reverse: leads we captured that never reached the board ──────
    let captNotBoard = 0;
    for (const [k] of byPhone) if (!board.has(k)) captNotBoard++;
    console.log(`\n=== 4. Captured by us but not on the board: ${captNotBoard} of ${byPhone.size} distinct captured phones ===`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

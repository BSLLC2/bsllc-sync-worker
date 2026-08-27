#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig } from "./config.js";

/**
 * READ-ONLY. Does Google Ads' lead count survive contact with the business?
 *
 * Google reports 54 "Calls from Ads" in 30 days. The team says only a handful of
 * real inquiries arrived. Both can be true: "Calls from Ads" counts any call
 * longer than a configured threshold, and a low threshold turns misdials, IVR
 * hang-ups and wrong numbers into conversions. This reconciles Google's number
 * against call durations, the web-inquiry sheet, and the admissions sheet.
 *
 *   npm run reconcile-och-leads
 */

const CUSTOMER_ID = "8350689003";
const SHEET_ID = "1Ls-zDrNemixH2LiMYj9Hh7VumupNufYnRD6HEWL4u-8";
const CLIENT = "ohio-community-health-och";
const W = { from: "2026-07-29", to: "2026-08-27" };

const n1 = (v: unknown) => Number(v ?? 0).toFixed(1);
const WANT = (() => {
  const raw = String(process.env.ONLY ?? "").toUpperCase().replace(/[^A-E]/g, "");
  return raw ? new Set(raw.split("")) : null;
})();
const realLog = console.log.bind(console);
let SEC = "";
console.log = ((...a: unknown[]) => { if (!WANT || SEC === "" || WANT.has(SEC)) realLog(...a); }) as typeof console.log;
const hr = (t: string) => {
  const m = /^\s*([A-E])\./.exec(t);
  if (m) SEC = m[1]!;
  console.log(`\n${"=".repeat(92)}\n${t}\n${"=".repeat(92)}`);
};
const CALLSTATUS: Record<string,string> = {"2":"MISSED","3":"RECEIVED"};
const CALLTYPE: Record<string,string> = {"2":"MANUALLY_DIALED","3":"HIGH_END_MOBILE_SEARCH"};
const nm = (m: Record<string,string>, v: unknown) => m[String(v ?? "")] ?? String(v ?? "—");

function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function sheetsGet(path: string): Promise<any | null> {
  const sa = JSON.parse(env("GOOGLE_SERVICE_ACCOUNT_JSON"));
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const { token } = await jwt.getAccessToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) { console.log(`   [SHEET UNAVAILABLE] ${res.status} ${(await res.text()).slice(0,200)}`); return null; }
  return res.json();
}

async function main() {
  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });
  let c: any;
  try {
    c = api.Customer({ customer_id: CUSTOMER_ID, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
    await c.query(`SELECT customer.id FROM customer LIMIT 1`);
  } catch { c = api.Customer({ customer_id: CUSTOMER_ID, refresh_token: cfg.refreshToken }); }
  const q = async (g: string) => { try { return await c.query(g); } catch (e: any) {
    console.log(`   [UNAVAILABLE] ${(e?.errors?.map((x:any)=>x.message).join("; ") || e?.message || String(e)).slice(0,220)}`); return null; } };

  console.log(`\nOHC LEAD RECONCILIATION — READ ONLY · ${W.from}..${W.to}`);

  // ── A. What does Google actually count as a "call lead"? ──────────────────
  hr("A. THE THRESHOLD — what counts as a call conversion");
  const acts = await q(`SELECT conversion_action.name, conversion_action.category,
      conversion_action.phone_call_duration_seconds, conversion_action.counting_type,
      conversion_action.status, conversion_action.primary_for_goal, conversion_action.origin
      FROM conversion_action WHERE conversion_action.status = 'ENABLED'`);
  if (acts) for (const r of acts) {
    const a = r.conversion_action ?? {};
    const d = a.phone_call_duration_seconds;
    if (d === undefined || d === null) continue;
    console.log(`  ${String(a.name).padEnd(38)} min call duration = ${d}s   primary=${a.primary_for_goal === true ? "YES" : "no"}`);
    if (Number(d) <= 30) console.log(`     ^^ ${d}s is short. A misdial or an IVR hang-up clears this bar and books as a lead.`);
  }

  // ── B. The calls themselves ───────────────────────────────────────────────
  hr("B. EVERY CALL GOOGLE LOGGED, BY DURATION");
  const calls = await q(`SELECT call_view.call_duration_seconds, call_view.call_status,
      call_view.type, call_view.start_call_date_time, campaign.name
      FROM call_view WHERE segments.date BETWEEN '${W.from}' AND '${W.to}'`);
  if (calls) {
    if (!calls.length) console.log(`  call_view returned 0 rows. Call detail may not be retained for this account.`);
    const buckets: Record<string, number> = { "0-9s": 0, "10-29s": 0, "30-59s": 0, "60-119s": 0, "120s+": 0 };
    let missed = 0, received = 0;
    for (const r of calls) {
      const d = Number(r.call_view?.call_duration_seconds ?? 0);
      const k = d < 10 ? "0-9s" : d < 30 ? "10-29s" : d < 60 ? "30-59s" : d < 120 ? "60-119s" : "120s+";
      buckets[k] = (buckets[k] ?? 0) + 1;
      if (nm(CALLSTATUS, r.call_view?.call_status) === "MISSED") missed++; else received++;
    }
    console.log(`  ${calls.length} calls logged.   received ${received}   missed ${missed}`);
    console.log(`\n  duration bucket      calls`);
    for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)}`);
    const real = calls.filter((r: any) => Number(r.call_view?.call_duration_seconds ?? 0) >= 60).length;
    console.log(`\n  Calls lasting 60s or more (a plausible real conversation): ${real}`);
    console.log(`  A 60s floor is a judgement, not a Google definition — it is stated so it can be argued with.`);
  }

  // ── C. Form fills the business actually received ──────────────────────────
  hr("C. WEB INQUIRIES ACTUALLY LOGGED (Postgres web_inquiries)");
  const pool = new pg.Client({ connectionString: env("DATABASE_URL") });
  try {
    await pool.connect();
    const rows = await pool.query(
      `SELECT date_trunc('day', submitted_at) AS d, count(*)::int AS n
         FROM web_inquiries WHERE client_slug = $1 AND submitted_at >= $2::date AND submitted_at < ($3::date + 1)
        GROUP BY 1 ORDER BY 1`, [CLIENT, W.from, W.to]);
    const tot = rows.rows.reduce((a: number, r: any) => a + Number(r.n), 0);
    console.log(`  ${tot} web inquiries recorded ${W.from}..${W.to}`);
    for (const r of rows.rows) console.log(`    ${String(r.d).slice(0,10)}  ${r.n}`);
    const gclid = await pool.query(
      `SELECT count(*) FILTER (WHERE gclid IS NOT NULL AND gclid <> '')::int AS with_gclid, count(*)::int AS total
         FROM web_inquiries WHERE client_slug = $1 AND submitted_at >= $2::date`, [CLIENT, W.from]);
    console.log(`  of those, ${gclid.rows[0].with_gclid} carry a gclid (i.e. traceable to a Google Ads click).`);
  } catch (e: any) {
    console.log(`   [DB UNAVAILABLE] ${String(e?.message ?? e).slice(0, 200)}`);
  } finally { try { await pool.end(); } catch {} }

  // ── D. The sheet the team keeps by hand ───────────────────────────────────
  hr("D. THE SHEET — what the team wrote down");
  const meta = await sheetsGet(`${SHEET_ID}?fields=sheets.properties.title`);
  if (meta) {
    const tabs = (meta.sheets ?? []).map((s: any) => s.properties?.title).filter(Boolean);
    console.log(`  tabs: ${tabs.join(" · ")}`);
    for (const tab of tabs) {
      const vals = await sheetsGet(`${SHEET_ID}/values/${encodeURIComponent(tab)}`);
      const rows = vals?.values ?? [];
      if (!rows.length) { console.log(`\n  "${tab}": empty`); continue; }
      const header = rows[0].map((h: string) => String(h ?? "").trim());
      console.log(`\n  "${tab}" — ${rows.length - 1} data rows`);
      console.log(`    columns: ${header.join(" | ")}`);
      // Find any date-ish column and count rows landing inside the window, so the
      // sheet is compared on the same 30 days as Google rather than in total.
      const di = header.findIndex((h: string) => /date|submitted|admit|intake|timestamp/i.test(h));
      if (di >= 0) {
        let inWindow = 0;
        for (const r of rows.slice(1)) {
          const d = new Date(String(r[di] ?? ""));
          if (!isNaN(d.getTime()) && d >= new Date(W.from) && d <= new Date(W.to + "T23:59:59")) inWindow++;
        }
        console.log(`    rows dated inside ${W.from}..${W.to} (by "${header[di]}"): ${inWindow}`);
      }
      for (const r of rows.slice(-4)) console.log(`    last: ${r.slice(0, 8).join(" | ").slice(0, 150)}`);
    }
  }

  // ── E. Put it side by side ────────────────────────────────────────────────
  hr("E. SIDE BY SIDE");
  const byAct = await q(`SELECT segments.conversion_action_name, metrics.all_conversions
      FROM customer WHERE segments.date BETWEEN '${W.from}' AND '${W.to}'`);
  if (byAct) {
    const agg: Record<string, number> = {};
    for (const r of byAct) {
      const k = r.segments?.conversion_action_name ?? "(unnamed)";
      agg[k] = (agg[k] ?? 0) + Number(r.metrics?.all_conversions ?? 0);
    }
    for (const [k, v] of Object.entries(agg).sort((a, b) => b[1] - a[1]))
      console.log(`  Google Ads "${k}": ${n1(v)}`);
  }
  console.log(`\n  Compare that against section B (how long those calls lasted), section C`);
  console.log(`  (form fills the site actually logged) and section D (what the team wrote down).`);
  console.log(`  Where Google is high and the others are low, Google is counting call EVENTS,`);
  console.log(`  not qualified inquiries.`);

  console.log(`\nDONE — read only, no changes made.\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });

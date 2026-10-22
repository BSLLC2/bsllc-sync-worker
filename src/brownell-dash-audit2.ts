#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import fs from "node:fs";

/** READ-ONLY follow-up to brownell-dash-audit: a few more GA4 and Search Console reads. Writes nothing. */
const DATA = "https://analyticsdata.googleapis.com/v1beta";
const GSC = "https://searchconsole.googleapis.com/webmasters/v3";
const arg = (n: string) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const out: Record<string, any> = { ranAt: new Date().toISOString(), errors: [] as string[] };
const fail = (label: string, e: unknown) => { const m = `${label}: ${e instanceof Error ? e.message : String(e)}`; out.errors.push(m); console.log(`!! ${m}`); };
async function token(scopes: string[]) { const sa = JSON.parse(env("GOOGLE_SERVICE_ACCOUNT_JSON")); const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes }); const { token } = await jwt.getAccessToken(); if (!token) throw new Error("no token"); return token; }
async function postJson(tok: string, url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text || "{}");
}
async function report(tok: string, prop: string, body: any, label: string): Promise<any[]> {
  try {
    const r = await postJson(tok, `${DATA}/properties/${prop}:runReport`, { limit: 10000, ...body });
    const dims = (r.dimensionHeaders ?? []).map((d: any) => d.name); const mets = (r.metricHeaders ?? []).map((m: any) => m.name);
    const rows = (r.rows ?? []).map((row: any) => { const o: any = {}; dims.forEach((d: string, i: number) => { o[d] = row.dimensionValues[i].value; }); mets.forEach((m: string, i: number) => { o[m] = Number(row.metricValues[i].value); }); return o; });
    console.log(`  ${label}: ${rows.length} rows (rowCount ${r.rowCount ?? "?"})`);
    return rows;
  } catch (e) { fail(label, e); return []; }
}
const notIn = (field: string, values: string[]) => ({ notExpression: { filter: { fieldName: field, inListFilter: { values } } } });
const eq = (field: string, value: string) => ({ filter: { fieldName: field, stringFilter: { matchType: "EXACT", value } } });
const and = (...xs: any[]) => ({ andGroup: { expressions: xs } });

async function main() {
  const prop = arg("property") ?? "341428693";
  const start = arg("start") ?? "2026-01-01", end = arg("end") ?? "2026-10-22", trendStart = "2025-01-01";
  const gscSite = arg("gsc") ?? "sc-domain:brownelltravel.com";
  const ga = await token(["https://www.googleapis.com/auth/analytics.readonly"]);
  const ytd = [{ startDate: start, endDate: end }];
  const noBot = notIn("sessionDefaultChannelGroup", ["Direct", "Unassigned"]);
  out.isKeyEvent = await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "eventName" }, { name: "isKeyEvent" }], metrics: [{ name: "eventCount" }, { name: "keyEvents" }] }, "eventName x isKeyEvent");
  out.earliest = await report(ga, prop, { dateRanges: [{ startDate: "2015-08-14", endDate: end }], dimensions: [{ name: "yearMonth" }], metrics: [{ name: "sessions" }, { name: "eventCount" }], orderBys: [{ dimension: { dimensionName: "yearMonth" } }] }, "earliest months");
  out.totalsNoBot = await report(ga, prop, { dateRanges: ytd, metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "engagementRate" }, { name: "totalUsers" }, { name: "keyEvents" }], dimensionFilter: noBot }, "totals excl Direct+Unassigned");
  out.landingNoBot = await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "landingPage" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "engagementRate" }, { name: "keyEvents" }], dimensionFilter: noBot, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 5000 }, "landing pages excl Direct+Unassigned");
  out.formPageNoBot = await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "eventName" }, { name: "pagePath" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: and(eq("eventName", "form_submit"), noBot), orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 5000 }, "form_submit by page excl Direct+Unassigned");
  out.formMonthNoBot = await report(ga, prop, { dateRanges: [{ startDate: trendStart, endDate: end }], dimensions: [{ name: "yearMonth" }], metrics: [{ name: "eventCount" }, { name: "sessions" }], dimensionFilter: and(eq("eventName", "form_submit"), noBot), orderBys: [{ dimension: { dimensionName: "yearMonth" } }] }, "form_submit by month excl Direct+Unassigned");
  out.searchByPage = await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "eventName" }, { name: "pagePath" }], metrics: [{ name: "eventCount" }], dimensionFilter: eq("eventName", "view_search_results"), orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 200 }, "view_search_results by page");
  out.homeEventsByDate = await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "date" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: and(eq("pagePath", "/"), { filter: { fieldName: "eventName", inListFilter: { values: ["form_submit", "form_start", "view_search_results"] } } }), orderBys: [{ dimension: { dimensionName: "date" } }], limit: 5000 }, "homepage form/search events by date");
  out.dailyOrganic = await report(ga, prop, { dateRanges: [{ startDate: "2026-05-01", endDate: end }], dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }], dimensionFilter: eq("sessionDefaultChannelGroup", "Organic Search"), orderBys: [{ dimension: { dimensionName: "date" } }] }, "daily organic");
  out.dailyNoBot = await report(ga, prop, { dateRanges: [{ startDate: "2026-05-01", endDate: end }], dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }], dimensionFilter: noBot, orderBys: [{ dimension: { dimensionName: "date" } }] }, "daily excl Direct+Unassigned");
  out.directLandingFamilies = await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "landingPage" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }], dimensionFilter: eq("sessionDefaultChannelGroup", "Direct"), orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 300 }, "direct landing pages");
  out.formSubmitByDeviceBrowser = await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "deviceCategory" }, { name: "browser" }], metrics: [{ name: "eventCount" }], dimensionFilter: eq("eventName", "form_submit"), orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 50 }, "form_submit by device/browser");
  out.homeFormSubmitBySource = await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "sessionDefaultChannelGroup" }, { name: "country" }], metrics: [{ name: "eventCount" }], dimensionFilter: and(eq("eventName", "form_submit"), eq("pagePath", "/")), orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 100 }, "homepage form_submit by channel/country");
  // Same-window Search Console comparison (the domain property only holds data from 2025-06-09).
  try {
    const gt = await token(["https://www.googleapis.com/auth/webmasters.readonly"]);
    const q = async (body: any, label: string) => { try { const r = await postJson(gt, `${GSC}/sites/${encodeURIComponent(gscSite)}/searchAnalytics/query`, body); console.log(`  GSC ${label}: ${(r.rows ?? []).length} rows`); return r.rows ?? []; } catch (e) { fail(`GSC ${label}`, e); return []; } };
    out.gscSame = {};
    for (const [k, p] of Object.entries({ y2025: { startDate: "2025-06-09", endDate: "2025-10-22" }, y2026: { startDate: "2026-06-09", endDate: "2026-10-22" } })) {
      out.gscSame[k] = { totals: await q({ ...p, rowLimit: 1 }, `totals ${k}`), queries: await q({ ...p, dimensions: ["query"], rowLimit: 5000 }, `queries ${k}`), pages: await q({ ...p, dimensions: ["page"], rowLimit: 5000 }, `pages ${k}`), device: await q({ ...p, dimensions: ["device"], rowLimit: 10 }, `device ${k}`), country: await q({ ...p, dimensions: ["country"], rowLimit: 10 }, `country ${k}`) };
    }
    out.gscByDateAndPageFamilyNote = "page x date is capped by the API at 25k rows; families are built from the per-period page reports instead.";
    out.gscMonthlyPages = {};
    for (let d = new Date("2025-06-01T00:00:00Z"); d <= new Date(end + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 1)) {
      const m = d.toISOString().slice(0, 7); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      out.gscMonthlyPages[m] = await q({ startDate: `${m}-01`, endDate: last < end ? last : end, dimensions: ["page"], rowLimit: 5000 }, `pages ${m}`);
    }
  } catch (e) { fail("gsc", e); }
  fs.writeFileSync("brownell-dash-audit2.json", JSON.stringify(out, null, 1));
  console.log(`DONE. errors: ${out.errors.length}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); try { fs.writeFileSync("brownell-dash-audit2.json", JSON.stringify(out, null, 1)); } catch {} process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import pg from "pg";
import fs from "node:fs";

/**
 * READ-ONLY audit of one client's GA4 property and Search Console property,
 * written to answer a specific set of dashboard questions (key events, form
 * events by page, engagement, source/medium, monthly trend, GSC by month and
 * query, duplicate-submission readability). It writes nothing anywhere: no
 * database write, no Google write. Output is one JSON file plus a text log.
 *
 *   npm run brownell-dash-audit -- --client=Brownell --property=341428693 --start=2026-01-01 --end=2026-10-22
 */

const DATA = "https://analyticsdata.googleapis.com/v1beta";
const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const GSC = "https://searchconsole.googleapis.com/webmasters/v3";
const arg = (n: string) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const out: Record<string, any> = { ranAt: new Date().toISOString(), errors: [] as string[] };
const note = (s: string) => { console.log(s); };
const fail = (label: string, e: unknown) => { const m = `${label}: ${e instanceof Error ? e.message : String(e)}`; out.errors.push(m); console.log(`!! ${m}`); };

async function token(scopes: string[]): Promise<{ tok: string; email: string }> {
  const sa = JSON.parse(env("GOOGLE_SERVICE_ACCOUNT_JSON"));
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("no token");
  return { tok: token, email: String(sa.client_email) };
}
async function getJson(tok: string, url: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url.replace(/https?:\/\/[^/]+/, "")}: ${body.slice(0, 400)}`);
  return JSON.parse(body || "{}");
}
async function postJson(tok: string, url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url.replace(/https?:\/\/[^/]+/, "")}: ${text.slice(0, 400)}`);
  return JSON.parse(text || "{}");
}

/** GA4 Data API runReport, flattened to plain rows. */
async function report(tok: string, prop: string, body: any, label: string): Promise<{ rows: any[]; meta: any } | null> {
  try {
    const r = await postJson(tok, `${DATA}/properties/${prop}:runReport`, { limit: 10000, ...body });
    const dims = (r.dimensionHeaders ?? []).map((d: any) => d.name);
    const mets = (r.metricHeaders ?? []).map((m: any) => m.name);
    const rows = (r.rows ?? []).map((row: any) => {
      const o: any = {};
      dims.forEach((d: string, i: number) => { o[d] = row.dimensionValues[i].value; });
      mets.forEach((m: string, i: number) => { o[m] = Number(row.metricValues[i].value); });
      return o;
    });
    const meta = { rowCount: r.rowCount, metadata: r.metadata, totals: r.totals, samplingMetadatas: r.metadata?.samplingMetadatas };
    note(`  ${label}: ${rows.length} rows (rowCount ${r.rowCount ?? "?"})${r.metadata?.dataLossFromOtherRow ? " DATA LOSS FROM OTHER ROW" : ""}${r.metadata?.subjectToThresholding ? " THRESHOLDED" : ""}`);
    return { rows, meta };
  } catch (e) { fail(label, e); return null; }
}
const eqFilter = (field: string, value: string) => ({ filter: { fieldName: field, stringFilter: { matchType: "EXACT", value } } });
const inFilter = (field: string, values: string[]) => ({ filter: { fieldName: field, inListFilter: { values } } });

async function gscQuery(tok: string, site: string, body: any): Promise<any[]> {
  const r = await postJson(tok, `${GSC}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, body);
  return r.rows ?? [];
}

async function main() {
  const clientName = arg("client") ?? "Brownell";
  const start = arg("start") ?? "2026-01-01";
  const end = arg("end") ?? "2026-10-22";
  const trendStart = arg("trendStart") ?? "2025-01-01";
  const brandTerms = (arg("brand") ?? "brownell").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  let prop = arg("property") ?? "";
  let gscSite = arg("gsc") ?? "";
  out.args = { clientName, start, end, trendStart, brandTerms };

  // Mappings from the dashboard database, read only.
  if (process.env.DATABASE_URL) {
    const pgc = new pg.Client({ connectionString: env("DATABASE_URL") });
    try {
      await pgc.connect();
      const { rows } = await pgc.query(
        `SELECT c.name, c.seo_domain, cm.source, cm.external_id, cm.enabled FROM clients c
           JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source IN ('ga4','gsc')
          WHERE lower(trim(c.name)) LIKE lower(trim($1)) || '%'`, [clientName]);
      out.mappings = rows;
      note(`DB mappings: ${JSON.stringify(rows)}`);
      for (const r of rows) {
        if (r.source === "ga4" && r.enabled && r.external_id && !prop) prop = String(r.external_id).replace(/^properties\//i, "").trim();
        if (r.source === "gsc" && r.enabled && r.external_id && !gscSite) gscSite = String(r.external_id).trim();
      }
    } catch (e) { fail("db", e); } finally { try { await pgc.end(); } catch {} }
  }

  const { tok: ga, email } = await token(["https://www.googleapis.com/auth/analytics.readonly"]);
  out.serviceAccount = email;

  // ---- Admin: which properties, key events, streams, retention, custom dims ----
  try {
    const sums = await getJson(ga, `${ADMIN}/accountSummaries?pageSize=200`);
    out.properties = [];
    for (const a of sums.accountSummaries ?? []) for (const p of a.propertySummaries ?? []) out.properties.push({ account: a.displayName, property: p.property, name: p.displayName });
    note(`Properties visible: ${JSON.stringify(out.properties)}`);
    if (!prop) {
      const hit = out.properties.find((p: any) => /brownell/i.test(p.name));
      if (hit) prop = String(hit.property).replace(/^properties\//, "");
    }
  } catch (e) { fail("accountSummaries", e); }
  if (!prop) throw new Error("No GA4 property id resolved.");
  out.property = prop;
  note(`GA4 property: ${prop}`);
  try { out.propertyMeta = await getJson(ga, `${ADMIN}/properties/${prop}`); } catch (e) { fail("property", e); }
  try { out.keyEvents = (await getJson(ga, `${ADMIN}/properties/${prop}/keyEvents?pageSize=200`)).keyEvents ?? []; note(`Key events: ${JSON.stringify(out.keyEvents)}`); } catch (e) { fail("keyEvents", e); }
  try { out.dataRetention = await getJson(ga, `${ADMIN}/properties/${prop}/dataRetentionSettings`); note(`Retention: ${JSON.stringify(out.dataRetention)}`); } catch (e) { fail("dataRetention", e); }
  try {
    const streams = (await getJson(ga, `${ADMIN}/properties/${prop}/dataStreams?pageSize=50`)).dataStreams ?? [];
    out.dataStreams = streams;
    note(`Streams: ${JSON.stringify(streams)}`);
    out.enhancedMeasurement = [];
    for (const s of streams) {
      if (s.type !== "WEB_DATA_STREAM") continue;
      try { out.enhancedMeasurement.push({ stream: s.name, settings: await getJson(ga, `${ADMIN}/${s.name}/enhancedMeasurementSettings`) }); } catch (e) { fail(`enhancedMeasurement ${s.name}`, e); }
    }
    note(`Enhanced measurement: ${JSON.stringify(out.enhancedMeasurement)}`);
  } catch (e) { fail("dataStreams", e); }
  try { out.customDimensions = (await getJson(ga, `${ADMIN}/properties/${prop}/customDimensions?pageSize=200`)).customDimensions ?? []; note(`Custom dimensions: ${JSON.stringify(out.customDimensions)}`); } catch (e) { fail("customDimensions", e); }
  try { out.customMetrics = (await getJson(ga, `${ADMIN}/properties/${prop}/customMetrics?pageSize=200`)).customMetrics ?? []; } catch (e) { fail("customMetrics", e); }
  try { out.attribution = await getJson(ga, `${ADMIN}/properties/${prop}/attributionSettings`); } catch (e) { fail("attribution", e); }
  try { out.googleSignals = await getJson(ga, `${ADMIN}/properties/${prop}/googleSignalsSettings`); } catch (e) { fail("googleSignals", e); }
  // Data API metadata: tells us whether keyEvents metric and custom dims exist.
  try {
    const md = await getJson(ga, `${DATA}/properties/${prop}/metadata`);
    out.metadataCustom = { dimensions: (md.dimensions ?? []).filter((d: any) => d.customDefinition).map((d: any) => d.apiName), metrics: (md.metrics ?? []).filter((m: any) => m.customDefinition).map((m: any) => m.apiName) };
    note(`Custom API fields: ${JSON.stringify(out.metadataCustom)}`);
  } catch (e) { fail("metadata", e); }

  const ytd = [{ startDate: start, endDate: end }];
  const keyNames: string[] = (out.keyEvents ?? []).map((k: any) => k.eventName);

  // ---- Q1: every event YTD with eventCount and keyEvents (counting-method aware) ----
  const allEvents = await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "keyEvents" }, { name: "sessions" }, { name: "totalUsers" }], orderBys: [{ metric: { metricName: "eventCount" }, desc: true }] }, "events YTD");
  out.eventsYtd = allEvents?.rows ?? [];
  const formLike = (n: string) => /form|submit|contact|lead|success|inquir|enquir|wpforms|gform|gravity|hsform|hubspot|ninja|elementor|generate_lead|sign_up|subscribe|request/i.test(n);
  const formEvents = Array.from(new Set([...keyNames, ...out.eventsYtd.map((r: any) => r.eventName).filter(formLike)]));
  out.formEvents = formEvents;
  note(`Form-like and key events: ${formEvents.join(", ")}`);

  // ---- Q2: form events by hostName + pagePath ----
  if (formEvents.length) {
    out.formByPage = (await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "eventName" }, { name: "hostName" }, { name: "pagePath" }], metrics: [{ name: "eventCount" }, { name: "keyEvents" }, { name: "totalUsers" }, { name: "sessions" }], dimensionFilter: inFilter("eventName", formEvents), orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 10000 }, "form events by host+page"))?.rows ?? [];
    out.formByPageLocation = (await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "eventName" }, { name: "pageLocation" }], metrics: [{ name: "eventCount" }], dimensionFilter: inFilter("eventName", formEvents), orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 3000 }, "form events by pageLocation"))?.rows ?? [];
    out.formByDate = (await report(ga, prop, { dateRanges: [{ startDate: trendStart, endDate: end }], dimensions: [{ name: "date" }, { name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "keyEvents" }], dimensionFilter: inFilter("eventName", formEvents), orderBys: [{ dimension: { dimensionName: "date" } }], limit: 20000 }, "form events by date"))?.rows ?? [];
    // Event parameters registered as custom dimensions, if any: list which params each form event carries.
    const custom: string[] = out.metadataCustom?.dimensions ?? [];
    out.formParams = {};
    for (const d of custom.filter((d) => d.startsWith("customEvent:"))) {
      out.formParams[d] = (await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "eventName" }, { name: d }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: inFilter("eventName", formEvents), orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 5000 }, `form events by ${d}`))?.rows ?? [];
    }
    // Did the dashboard's filters cut anything? Report form events with no page filter at all, by session default channel.
    out.formByChannel = (await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "eventName" }, { name: "sessionDefaultChannelGroup" }], metrics: [{ name: "eventCount" }, { name: "keyEvents" }], dimensionFilter: inFilter("eventName", formEvents), orderBys: [{ metric: { metricName: "eventCount" }, desc: true }] }, "form events by channel"))?.rows ?? [];
  }
  out.sessionsByHost = (await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "hostName" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "totalUsers" }, { name: "screenPageViews" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }] }, "sessions by hostName"))?.rows ?? [];

  // ---- Q3: engagement ----
  out.siteTotals = (await report(ga, prop, { dateRanges: ytd, metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "engagementRate" }, { name: "totalUsers" }, { name: "activeUsers" }, { name: "screenPageViews" }, { name: "keyEvents" }, { name: "averageSessionDuration" }, { name: "screenPageViewsPerSession" }] }, "site totals YTD"))?.rows ?? [];
  out.landingPages = (await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "landingPage" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "engagementRate" }, { name: "keyEvents" }, { name: "totalUsers" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 5000 }, "landing pages YTD"))?.rows ?? [];
  out.landingPagesByHost = (await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "hostName" }, { name: "landingPage" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "engagementRate" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 5000 }, "landing pages by host YTD"))?.rows ?? [];
  // Pages (not landing) too, since the dashboard may use pagePath.
  out.pagesYtd = (await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "pagePath" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "screenPageViews" }, { name: "keyEvents" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 5000 }, "pages YTD"))?.rows ?? [];

  // ---- Q4: source / medium ----
  out.sourceMedium = (await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }, { name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 2000 }, "source/medium YTD"))?.rows ?? [];
  out.channels = (await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }] }, "channels YTD"))?.rows ?? [];
  out.socialSources = (await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }, { name: "sessionDefaultChannelGroup" }, { name: "sessionCampaignName" }], metrics: [{ name: "sessions" }], dimensionFilter: { filter: { fieldName: "sessionSource", stringFilter: { matchType: "PARTIAL_REGEXP", value: "(?i)instagram|facebook|^ig$|^fb$|meta|l\\.instagram|lm\\.facebook" } } }, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 500 }, "social sources YTD"))?.rows ?? [];
  out.firstUserSocial = (await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "firstUserSource" }, { name: "firstUserMedium" }], metrics: [{ name: "totalUsers" }, { name: "sessions" }], dimensionFilter: { filter: { fieldName: "firstUserSource", stringFilter: { matchType: "PARTIAL_REGEXP", value: "(?i)instagram|facebook|^ig$|^fb$|meta" } } }, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 200 }, "first-user social YTD"))?.rows ?? [];

  // ---- Q5: monthly trend ----
  const trend = [{ startDate: trendStart, endDate: end }];
  out.monthly = (await report(ga, prop, { dateRanges: trend, dimensions: [{ name: "yearMonth" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "totalUsers" }, { name: "keyEvents" }, { name: "screenPageViews" }], orderBys: [{ dimension: { dimensionName: "yearMonth" } }] }, "monthly totals"))?.rows ?? [];
  out.monthlyOrganic = (await report(ga, prop, { dateRanges: trend, dimensions: [{ name: "yearMonth" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }], dimensionFilter: eqFilter("sessionDefaultChannelGroup", "Organic Search"), orderBys: [{ dimension: { dimensionName: "yearMonth" } }] }, "monthly organic"))?.rows ?? [];
  out.monthlyByChannel = (await report(ga, prop, { dateRanges: trend, dimensions: [{ name: "yearMonth" }, { name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }], orderBys: [{ dimension: { dimensionName: "yearMonth" } }], limit: 5000 }, "monthly by channel"))?.rows ?? [];
  if (formEvents.length) {
    out.monthlyForm = (await report(ga, prop, { dateRanges: trend, dimensions: [{ name: "yearMonth" }, { name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "keyEvents" }, { name: "sessions" }], dimensionFilter: inFilter("eventName", formEvents), orderBys: [{ dimension: { dimensionName: "yearMonth" } }], limit: 5000 }, "monthly form events"))?.rows ?? [];
  }
  out.monthlyAllEvents = (await report(ga, prop, { dateRanges: trend, dimensions: [{ name: "yearMonth" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], orderBys: [{ dimension: { dimensionName: "yearMonth" } }], limit: 10000 }, "monthly all events"))?.rows ?? [];
  out.earliest = (await report(ga, prop, { dateRanges: [{ startDate: "2015-01-01", endDate: end }], dimensions: [{ name: "yearMonth" }], metrics: [{ name: "sessions" }, { name: "eventCount" }], orderBys: [{ dimension: { dimensionName: "yearMonth" } }] }, "earliest months"))?.rows ?? [];
  // Daily sessions around the two dates named (July 30 throttle, August WP update).
  out.dailyJulSep = (await report(ga, prop, { dateRanges: [{ startDate: "2026-06-15", endDate: end }], dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }, { name: "totalUsers" }], orderBys: [{ dimension: { dimensionName: "date" } }] }, "daily Jun 15 onward"))?.rows ?? [];
  // Unassigned / direct / bot-shaped traffic by month: sessions with zero engagement.
  out.monthlyUnassigned = (await report(ga, prop, { dateRanges: trend, dimensions: [{ name: "yearMonth" }], metrics: [{ name: "sessions" }], dimensionFilter: eqFilter("sessionDefaultChannelGroup", "Unassigned"), orderBys: [{ dimension: { dimensionName: "yearMonth" } }] }, "monthly unassigned"))?.rows ?? [];
  out.monthlyDirect = (await report(ga, prop, { dateRanges: trend, dimensions: [{ name: "yearMonth" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }], dimensionFilter: eqFilter("sessionDefaultChannelGroup", "Direct"), orderBys: [{ dimension: { dimensionName: "yearMonth" } }] }, "monthly direct"))?.rows ?? [];
  out.monthlyByCountry = (await report(ga, prop, { dateRanges: trend, dimensions: [{ name: "yearMonth" }, { name: "country" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }], orderBys: [{ dimension: { dimensionName: "yearMonth" } }, { metric: { metricName: "sessions" }, desc: true }], limit: 10000 }, "monthly by country"))?.rows ?? [];

  // ---- Q7: can GA4 tell repeat submitters apart? Users with form events on >1 page. ----
  if (formEvents.length) {
    out.formUsersByPage = (await report(ga, prop, { dateRanges: ytd, dimensions: [{ name: "pagePath" }], metrics: [{ name: "totalUsers" }, { name: "eventCount" }], dimensionFilter: inFilter("eventName", formEvents), orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 5000 }, "form users by page"))?.rows ?? [];
    out.formUsersTotal = (await report(ga, prop, { dateRanges: ytd, metrics: [{ name: "totalUsers" }, { name: "eventCount" }, { name: "sessions" }], dimensionFilter: inFilter("eventName", formEvents) }, "form users total"))?.rows ?? [];
  }

  // ---- Q6: Search Console ----
  try {
    const { tok: gt } = await token(["https://www.googleapis.com/auth/webmasters.readonly"]);
    const sites = (await getJson(gt, `${GSC}/sites`)).siteEntry ?? [];
    out.gscSites = sites;
    note(`GSC sites: ${JSON.stringify(sites)}`);
    if (!gscSite || !sites.some((s: any) => s.siteUrl === gscSite)) {
      const hit = sites.find((s: any) => /brownell/i.test(s.siteUrl) && s.permissionLevel !== "siteUnverifiedUser");
      if (hit) { note(`GSC: using ${hit.siteUrl} (mapped was "${gscSite}")`); gscSite = hit.siteUrl; }
    }
    out.gscSite = gscSite;
    if (gscSite) {
      const q = (body: any, label: string) => gscQuery(gt, gscSite, body).then((r) => { note(`  GSC ${label}: ${r.length} rows`); return r; }).catch((e) => { fail(`GSC ${label}`, e); return []; });
      out.gscDaily = await q({ startDate: trendStart, endDate: end, dimensions: ["date"], rowLimit: 25000 }, "daily");
      out.gscDailyNoFilter = out.gscDaily.length;
      const periods = { thisYear: { startDate: start, endDate: end }, lastYear: { startDate: start.replace(/^\d{4}/, (y) => String(Number(y) - 1)), endDate: end.replace(/^\d{4}/, (y) => String(Number(y) - 1)) } };
      out.gscPeriods = periods;
      out.gscQueries = {}; out.gscPages = {}; out.gscTotals = {};
      for (const [k, p] of Object.entries(periods)) {
        out.gscTotals[k] = await q({ ...p, rowLimit: 1 }, `totals ${k}`);
        out.gscQueries[k] = await q({ ...p, dimensions: ["query"], rowLimit: 5000 }, `queries ${k}`);
        out.gscPages[k] = await q({ ...p, dimensions: ["page"], rowLimit: 5000 }, `pages ${k}`);
      }
      // Top 10 queries per month, Jan 2025 onward.
      out.gscMonthlyQueries = {};
      const months: string[] = [];
      for (let d = new Date(trendStart + "T00:00:00Z"); d <= new Date(end + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
      for (const m of months) {
        const s = `${m}-01`; const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
        out.gscMonthlyQueries[m] = await q({ startDate: s, endDate: last < end ? last : end, dimensions: ["query"], rowLimit: 15 }, `queries ${m}`);
      }
      // Branded vs non-branded by month via a query regex filter (both directions).
      const brandRe = brandTerms.join("|");
      out.gscMonthlyBranded = await q({ startDate: trendStart, endDate: end, dimensions: ["date"], dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "includingRegex", expression: brandRe }] }], rowLimit: 25000 }, "daily branded");
      out.gscMonthlyNonBranded = await q({ startDate: trendStart, endDate: end, dimensions: ["date"], dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "excludingRegex", expression: brandRe }] }], rowLimit: 25000 }, "daily non-branded");
      // Pages by month (for microsite / destination breakouts), both years, top 2000 per period.
      out.gscPagesByMonth = await q({ startDate: trendStart, endDate: end, dimensions: ["page", "date"], rowLimit: 25000 }, "page x date (capped)");
    } else {
      fail("gsc", "no site resolved");
    }
  } catch (e) { fail("gsc", e); }

  fs.writeFileSync("brownell-dash-audit.json", JSON.stringify(out, null, 1));
  note(`\nDONE. errors: ${out.errors.length}`);
  for (const e of out.errors) note(`  - ${e}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); try { fs.writeFileSync("brownell-dash-audit.json", JSON.stringify(out, null, 1)); } catch {} process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, type DfsCreds } from "./dataforseo.js";
import { JWT } from "google-auth-library";

/**
 * READ-ONLY organic growth probe through DataForSEO. Writes nothing anywhere. A cost cap
 * stops new calls. PHASE is a comma list:
 *   ranked       every keyword the target ranks for (Labs ranked_keywords), with volume, difficulty, intent, url
 *   overview     domain rank overview (organic traffic estimate, position buckets) for the target and PARAMS.compare
 *   competitors  organic competitors (Labs competitors_domain)
 *   gap          keywords PARAMS.competitors rank for that the target does not (top 20 or absent)
 *   backlinks    backlink summary, referring domains and anchors for the target and PARAMS.compare
 *   keywords     keyword overview for PARAMS.seeds plus suggestions for PARAMS.expand
 *   serp         live Google top 10 for PARAMS.serps from PARAMS.serpLocation
 *   gsctrend     weekly Search Console history for the homepage, tagged links, brand and city queries
 *   local        live Business Profile record for PARAMS.biz and Google Maps results for PARAMS.maps near PARAMS.coord
 * PARAMS (JSON): target, compare[], competitors[], seeds[], expand[], serps[], serpLocation, location (code), limit.
 */
const PHASES = (process.env.PHASE || "ranked").toLowerCase().split(",").map((s) => s.trim());
const CAP = Number(process.env.COST_CAP || 5);
const PARAMS: any = (() => { try { return JSON.parse(process.env.PARAMS || "{}"); } catch { return {}; } })();
const TARGET: string = PARAMS.target || "bsllc.biz";
const LOC = Number(PARAMS.location || 2840);

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
let spent = 0; let calls = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const J = (v: unknown) => JSON.stringify(v);

async function post(creds: DfsCreds, path: string, body: unknown): Promise<any> {
  if (spent > CAP) throw new Error(`cost cap $${CAP} reached`);
  for (let a = 0; ; a++) {
    try {
      const res = await fetch(`https://api.dataforseo.com/v3${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${txt.slice(0, 200)}`);
      const j: any = JSON.parse(txt); calls++; spent += n(j?.cost) ?? 0;
      const t = j?.tasks?.[0];
      console.log(`# call ${calls} ${path} cost ${n(j?.cost)} total $${spent.toFixed(4)} status ${t?.status_code} ${t?.status_message ?? ""}`);
      if (!t || t.status_code !== 20000) throw new Error(`${t?.status_code} ${t?.status_message ?? "no task"}`);
      return t.result?.[0];
    } catch (e) {
      if (!/HTTP 5|50000|40101|timeout|aborted/i.test(String(e)) || a >= 2) throw e;
      await sleep(3000 * (a + 1));
    }
  }
}
const trim = (s: unknown, k = 120) => String(s ?? "").replace(/\s+/g, " ").slice(0, k);

function rankRow(it: any) {
  const kd = it?.keyword_data; const info = kd?.keyword_info; const se = it?.ranked_serp_element?.serp_item;
  return {
    k: kd?.keyword, vol: n(info?.search_volume), cpc: n(info?.cpc), kd: n(kd?.keyword_properties?.keyword_difficulty),
    intent: kd?.search_intent_info?.main_intent ?? null, pos: n(se?.rank_group), abs: n(se?.rank_absolute), etv: n(se?.etv),
    url: trim(se?.url, 110), feat: se?.type ?? null,
  };
}

async function rankedFor(creds: DfsCreds, target: string, limit: number) {
  const r = await post(creds, "/dataforseo_labs/google/ranked_keywords/live", [{
    target, location_code: LOC, language_code: "en", limit,
    order_by: ["keyword_data.keyword_info.search_volume,desc"],
    filters: [["ranked_serp_element.serp_item.type", "=", "organic"]],
  }]);
  return { total: n(r?.total_count), items: (r?.items ?? []).map(rankRow), metrics: r?.metrics };
}

async function main() {
  const creds = credsFromEnv();
  console.log(`RUN ${new Date().toISOString()} · SEO growth probe · PHASE=${PHASES.join(",")} · target ${TARGET} · read-only`);
  const bal = await fetch("https://api.dataforseo.com/v3/appendix/user_data", { headers: { authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") } }).then((r) => r.json()).catch(() => null) as any;
  console.log(`# balance before: $${bal?.tasks?.[0]?.result?.[0]?.money?.balance ?? "?"} · cap $${CAP}`);
  const compare: string[] = PARAMS.compare || [];

  for (const ph of PHASES) {
    try {
      if (ph === "ranked") {
        const r = await rankedFor(creds, TARGET, Number(PARAMS.limit || 1000));
        console.log(`### RANKEDMETA ${J({ target: TARGET, total: r.total, organic: r.metrics?.organic })}`);
        for (const row of r.items) console.log(`### RANKED ${J(row)}`);
      }
      if (ph === "overview") {
        for (const t of [TARGET, ...compare]) {
          const r = await post(creds, "/dataforseo_labs/google/domain_rank_overview/live", [{ target: t, location_code: LOC, language_code: "en" }]);
          console.log(`### OVERVIEW ${J({ target: t, organic: r?.items?.[0]?.metrics?.organic, paid: r?.items?.[0]?.metrics?.paid ? { etv: r.items[0].metrics.paid.etv, count: r.items[0].metrics.paid.count } : null })}`);
        }
      }
      if (ph === "competitors") {
        const r = await post(creds, "/dataforseo_labs/google/competitors_domain/live", [{ target: TARGET, location_code: LOC, language_code: "en", limit: Number(PARAMS.limit || 40), exclude_top_domains: true, order_by: ["intersections,desc"] }]);
        for (const it of r?.items ?? []) console.log(`### COMP ${J({ d: it.domain, avgPos: n(it.avg_position), shared: n(it.intersections), theirKw: n(it.full_domain_metrics?.organic?.count), theirEtv: n(it.full_domain_metrics?.organic?.etv), top3: n(it.full_domain_metrics?.organic?.pos_1) })}`);
      }
      if (ph === "gap") {
        const mine = await rankedFor(creds, TARGET, 1000);
        const have = new Map(mine.items.map((x: any) => [x.k, x.pos]));
        for (const c of PARAMS.competitors || []) {
          const r = await rankedFor(creds, c, Number(PARAMS.gapLimit || 400));
          const gaps = r.items.filter((x: any) => { const mp = have.get(x.k); return (mp == null || mp > 20) && (x.pos ?? 100) <= 20; });
          console.log(`### GAPMETA ${J({ competitor: c, theirTotal: r.total, fetched: r.items.length, gaps: gaps.length })}`);
          for (const g of gaps.slice(0, 60)) console.log(`### GAP ${J({ comp: c, ...g, mine: have.get(g.k) ?? null })}`);
        }
      }
      if (ph === "backlinks") {
        for (const t of [TARGET, ...compare]) {
          try {
            const s = await post(creds, "/backlinks/summary/live", [{ target: t, include_subdomains: true, internal_list_limit: 0, backlinks_status_type: "live" }]);
            console.log(`### BLSUM ${J({ target: t, rank: n(s?.rank), backlinks: n(s?.backlinks), refDomains: n(s?.referring_domains), refDomainsNofollow: n(s?.referring_domains_nofollow), refIps: n(s?.referring_ips), spam: n(s?.backlinks_spam_score), brokenBacklinks: n(s?.broken_backlinks), firstSeen: s?.first_seen ?? null, tlds: s?.referring_links_tld ? Object.entries(s.referring_links_tld).slice(0, 6) : null })}`);
            if (t === TARGET) {
              const rd = await post(creds, "/backlinks/referring_domains/live", [{ target: t, limit: 100, order_by: ["rank,desc"], include_subdomains: true }]);
              for (const it of rd?.items ?? []) console.log(`### BLREF ${J({ d: it.domain, rank: n(it.rank), backlinks: n(it.backlinks), first: it.first_seen ?? null, nofollow: n(it.referring_links_attributes?.nofollow) })}`);
              const an = await post(creds, "/backlinks/anchors/live", [{ target: t, limit: 40, order_by: ["backlinks,desc"], include_subdomains: true }]);
              for (const it of an?.items ?? []) console.log(`### BLANCHOR ${J({ a: trim(it.anchor, 60), backlinks: n(it.backlinks), domains: n(it.referring_domains) })}`);
            }
          } catch (e) { console.log(`### BLERR ${J({ target: t, err: trim(String(e), 220) })}`); }
        }
      }
      if (ph === "keywords") {
        const seeds: string[] = PARAMS.seeds || [];
        for (let i = 0; i < seeds.length; i += 200) {
          const r = await post(creds, "/dataforseo_labs/google/keyword_overview/live", [{ keywords: seeds.slice(i, i + 200), location_code: LOC, language_code: "en" }]);
          for (const it of r?.items ?? []) console.log(`### KWO ${J({ k: it.keyword, vol: n(it.keyword_info?.search_volume), cpc: n(it.keyword_info?.cpc), kd: n(it.keyword_properties?.keyword_difficulty), intent: it.search_intent_info?.main_intent ?? null, trend: it.keyword_info?.monthly_searches ? it.keyword_info.monthly_searches.slice(0, 12).map((m: any) => m.search_volume) : null })}`);
        }
        for (const s of PARAMS.expand || []) {
          try {
            const r = await post(creds, "/dataforseo_labs/google/keyword_suggestions/live", [{ keyword: s, location_code: LOC, language_code: "en", limit: Number(PARAMS.expandLimit || 60), order_by: ["keyword_info.search_volume,desc"], filters: [["keyword_info.search_volume", ">=", 20]] }]);
            for (const it of r?.items ?? []) console.log(`### KWS ${J({ seed: s, k: it.keyword, vol: n(it.keyword_info?.search_volume), cpc: n(it.keyword_info?.cpc), kd: n(it.keyword_properties?.keyword_difficulty), intent: it.search_intent_info?.main_intent ?? null })}`);
          } catch (e) { console.log(`### PHASEERR ${J({ phase: "expand", seed: s, err: trim(String(e), 200) })}`); }
        }
      }
      if (ph === "gsc") {
        // Read-only Search Console: which properties the service account can read, then
        // per-query and per-page clicks for the last 90 days and the 90 before.
        try {
          const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
          const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/webmasters.readonly"] });
          const { token } = await jwt.getAccessToken();
          const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
          const sl: any = await (await fetch("https://searchconsole.googleapis.com/webmasters/v3/sites", { headers: H })).json();
          const sites: string[] = (sl.siteEntry ?? []).map((e: any) => e.siteUrl);
          console.log(`### GSCSITES ${J(sites.filter((u) => /bsllc/i.test(u)).concat(sites.length ? [`(total readable: ${sites.length})`] : []))}`);
          const hit = sites.find((u) => u === "sc-domain:bsllc.biz") || sites.find((u) => /bsllc\.biz/i.test(u));
          if (!hit) { console.log(`### PHASEERR ${J({ phase: "gsc", err: "no readable bsllc.biz property for this service account" })}`); }
          else {
            const day = (d: number) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
            const q = async (dimensions: string[], start: string, end: string, rowLimit = 250) => {
              const r = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(hit)}/searchAnalytics/query`, { method: "POST", headers: H, body: JSON.stringify({ startDate: start, endDate: end, dimensions, rowLimit }) });
              if (!r.ok) throw new Error(`GSC ${r.status} ${trim(await r.text(), 160)}`);
              return ((await r.json()) as any).rows ?? [];
            };
            const cur: [string, string] = [day(93), day(3)], prev: [string, string] = [day(186), day(94)];
            const tot = async (a: [string, string]) => { const r = await q([], a[0], a[1], 1); return r[0] ? { c: r[0].clicks, i: r[0].impressions, ctr: r[0].ctr, pos: r[0].position } : null; };
            console.log(`### GSCTOT ${J({ site: hit, cur, prev, now: await tot(cur), before: await tot(prev) })}`);
            for (const [lab, rng] of [["cur", cur], ["prev", prev]] as const) {
              for (const row of await q(["page"], rng[0], rng[1], 100)) console.log(`### GSCPAGE ${J({ w: lab, u: trim(row.keys[0], 110), c: row.clicks, i: row.impressions, p: Math.round(row.position * 10) / 10 })}`);
            }
            for (const row of await q(["query"], cur[0], cur[1], 250)) console.log(`### GSCQ ${J({ k: trim(row.keys[0], 80), c: row.clicks, i: row.impressions, p: Math.round(row.position * 10) / 10 })}`);
          }
        } catch (e) { console.log(`### PHASEERR ${J({ phase: "gsc", err: trim(String(e), 220) })}`); }
      }
      if (ph === "ga4") {
        // Read-only analytics: find the BS LLC property, then organic vs other sessions and key events by landing page.
        try {
          const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
          const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/analytics.readonly"] });
          const { token } = await jwt.getAccessToken();
          const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
          const props: { id: string; name: string; acct: string }[] = [];
          const given = String((PARAMS as any).property || "").replace(/\D/g, "");
          if (given) props.push({ id: given, name: "bsllc (given)", acct: "" });
          else {
            const sr = await fetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200", { headers: H });
            if (!sr.ok) throw new Error(`admin ${sr.status} ${trim(await sr.text(), 120)} (pass params {"property":"<GA4 property id>"} to skip the listing)`);
            const sums: any[] = ((await sr.json()) as any).accountSummaries ?? [];
            for (const a of sums) for (const pr of a.propertySummaries ?? []) props.push({ id: String(pr.property).replace("properties/", ""), name: pr.displayName, acct: a.displayName });
            console.log(`### GA4PROPS ${J(props.slice(0, 40))}`);
          }
          const hit = given ? props[0] : (props.find((x) => /bs\s*llc|bsllc/i.test(x.name)) || props.find((x) => /bsllc/i.test(x.acct)));
          if (!hit) { console.log(`### PHASEERR ${J({ phase: "ga4", err: "no property named like BS LLC readable by this service account" })}`); }
          else {
            const day = (d: number) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
            const run = async (body: any) => {
              const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${hit.id}:runReport`, { method: "POST", headers: H, body: JSON.stringify(body) });
              if (!r.ok) throw new Error(`data ${r.status} ${trim(await r.text(), 200)}`);
              return ((await r.json()) as any).rows ?? [];
            };
            const dr = [{ startDate: day(90), endDate: day(1) }];
            const chan = await run({ dateRanges: dr, dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }], limit: 20 });
            console.log(`### GA4CHAN ${J({ prop: hit.id, name: hit.name, rows: chan.map((r: any) => ({ ch: r.dimensionValues[0].value, s: +r.metricValues[0].value, e: +r.metricValues[1].value, k: +r.metricValues[2].value })) })}`);
            const land = await run({ dateRanges: dr, dimensions: [{ name: "landingPage" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }], dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } }, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 40 });
            for (const r of land) console.log(`### GA4LAND ${J({ u: trim(r.dimensionValues[0].value, 90), s: +r.metricValues[0].value, e: +r.metricValues[1].value, k: +r.metricValues[2].value })}`);
            const ev = await run({ dateRanges: dr, dimensions: [{ name: "eventName" }], metrics: [{ name: "keyEvents" }, { name: "eventCount" }], orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 25 });
            console.log(`### GA4EVENTS ${J(ev.map((r: any) => ({ n: r.dimensionValues[0].value, k: +r.metricValues[0].value, c: +r.metricValues[1].value })))}`);
            // Form funnel by page and by week, and organic homepage sessions by week.
            const formF = { filter: { fieldName: "eventName", inListFilter: { values: ["form_start", "form_submit", "form_success", "generate_lead"] } } };
            const fp = await run({ dateRanges: dr, dimensions: [{ name: "eventName" }, { name: "pagePath" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: formF, orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 60 });
            console.log(`### GA4FORMPAGE ${J(fp.map((r: any) => [r.dimensionValues[0].value, trim(r.dimensionValues[1].value, 60), +r.metricValues[0].value, +r.metricValues[1].value]))}`);
            const fc = await run({ dateRanges: dr, dimensions: [{ name: "eventName" }, { name: "sessionDefaultChannelGroup" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: formF, limit: 60 });
            console.log(`### GA4FORMCHAN ${J(fc.map((r: any) => [r.dimensionValues[0].value, r.dimensionValues[1].value, +r.metricValues[0].value, +r.metricValues[1].value]))}`);
            const long = [{ startDate: day(420), endDate: day(1) }];
            const hw = await run({ dateRanges: long, dimensions: [{ name: "yearMonth" }, { name: "sessionSourceMedium" }], metrics: [{ name: "sessions" }, { name: "keyEvents" }], dimensionFilter: { filter: { fieldName: "sessionSourceMedium", stringFilter: { matchType: "PARTIAL_REGEXP", value: "google / organic|gmb|bing / organic" } } }, orderBys: [{ dimension: { dimensionName: "yearMonth" } }], limit: 200 });
            console.log(`### GA4MONTHLY ${J(hw.map((r: any) => [r.dimensionValues[0].value, r.dimensionValues[1].value, +r.metricValues[0].value, +r.metricValues[1].value]))}`);
            const camp = await run({ dateRanges: long, dimensions: [{ name: "yearMonth" }, { name: "sessionCampaignName" }], metrics: [{ name: "sessions" }, { name: "keyEvents" }], dimensionFilter: { filter: { fieldName: "sessionCampaignName", stringFilter: { matchType: "CONTAINS", value: "local_listing" } } }, orderBys: [{ dimension: { dimensionName: "yearMonth" } }], limit: 60 });
            console.log(`### GA4GMBCAMP ${J(camp.map((r: any) => [r.dimensionValues[0].value, r.dimensionValues[1].value, +r.metricValues[0].value, +r.metricValues[1].value]))}`);
          }
        } catch (e) { console.log(`### PHASEERR ${J({ phase: "ga4", err: trim(String(e), 260) })}`); }
      }
      if (ph === "gsctrend") {
        // Read-only Search Console history: weekly clicks and impressions for the homepage, the
        // Business Profile tagged link, brand and Cincinnati queries, plus homepage queries for two windows.
        try {
          const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
          const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/webmasters.readonly"] });
          const { token } = await jwt.getAccessToken();
          const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
          const site = "sc-domain:bsllc.biz";
          const day = (d: number) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
          const q = async (body: any) => {
            const r = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, { method: "POST", headers: H, body: JSON.stringify(body) });
            if (!r.ok) throw new Error(`GSC ${r.status} ${trim(await r.text(), 160)}`);
            return ((await r.json()) as any).rows ?? [];
          };
          const f = (dimension: string, operator: string, expression: string) => ({ dimensionFilterGroups: [{ filters: [{ dimension, operator, expression }] }] });
          const start = day(485), end = day(3);
          const series: [string, any][] = [
            ["site", {}],
            ["home", f("page", "equals", "https://bsllc.biz/")],
            ["gmbtag", f("page", "contains", "utm_source=gmb")],
            ["anytag", f("page", "contains", "utm_")],
            ["brand", f("query", "includingRegex", "bs ?llc|bsllc|b\\.s\\. ?llc")],
            ["cincy", f("query", "contains", "cincinnati")],
            ["nearme", f("query", "contains", "near me")],
          ];
          for (const [name, flt] of series) {
            const rows = await q({ startDate: start, endDate: end, dimensions: ["date"], rowLimit: 600, ...flt });
            const wk = new Map<string, { c: number; i: number; ps: number }>();
            for (const r of rows) {
              const d = new Date(r.keys[0] + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
              const k = d.toISOString().slice(0, 10); const w = wk.get(k) ?? { c: 0, i: 0, ps: 0 };
              w.c += r.clicks; w.i += r.impressions; w.ps += r.position * r.impressions; wk.set(k, w);
            }
            console.log(`### GSCWK ${J({ s: name, w: [...wk.entries()].sort().map(([k, v]) => [k.slice(2), v.c, v.i, v.i ? Math.round((v.ps / v.i) * 10) / 10 : null]) })}`);
          }
          const wins: [string, string, string][] = [["cur", day(93), day(3)], ["prev", day(186), day(94)], ["yago", day(458), day(368)]];
          for (const [lab, a, b] of wins) {
            for (const [pn, flt] of [["home", f("page", "equals", "https://bsllc.biz/")], ["gmbtag", f("page", "contains", "utm_source=gmb")]] as [string, any][]) {
              const rows = await q({ startDate: a, endDate: b, dimensions: ["query"], rowLimit: 60, ...flt });
              console.log(`### GSCPQ ${J({ w: lab, pg: pn, rows: rows.map((r: any) => [trim(r.keys[0], 60), r.clicks, r.impressions, Math.round(r.position * 10) / 10]) })}`);
              const dv = await q({ startDate: a, endDate: b, dimensions: ["device"], rowLimit: 5, ...flt });
              console.log(`### GSCPDEV ${J({ w: lab, pg: pn, rows: dv.map((r: any) => [r.keys[0], r.clicks, r.impressions, Math.round(r.position * 10) / 10]) })}`);
            }
            const tot = await q({ startDate: a, endDate: b, dimensions: [], rowLimit: 1 });
            console.log(`### GSCWIN ${J({ w: lab, a, b, c: tot[0]?.clicks, i: tot[0]?.impressions, p: tot[0]?.position })}`);
            for (const [qn, flt] of [["brand", f("query", "includingRegex", "bs ?llc|bsllc|b\\.s\\. ?llc")], ["cincy", f("query", "contains", "cincinnati")]] as [string, any][]) {
              const rows = await q({ startDate: a, endDate: b, dimensions: ["query"], rowLimit: 40, ...flt });
              console.log(`### GSCQSET ${J({ w: lab, set: qn, rows: rows.map((r: any) => [trim(r.keys[0], 60), r.clicks, r.impressions, Math.round(r.position * 10) / 10]) })}`);
            }
          }
        } catch (e) { console.log(`### PHASEERR ${J({ phase: "gsctrend", err: trim(String(e), 220) })}`); }
      }
      if (ph === "local") {
        // Read-only: the live Google Business Profile record and Google Maps results around PARAMS.coord.
        for (const kw of PARAMS.biz || []) {
          try {
            const r: any = await post(creds, "/business_data/google/my_business_info/live", [{ keyword: kw, location_name: PARAMS.serpLocation || "Cincinnati,Ohio,United States", language_code: "en" }]);
            for (const it of (r?.items ?? []).slice(0, 3)) console.log(`### GBP ${J({ kw, title: it.title, cat: it.category, more: it.additional_categories, addr: it.address, url: it.url, domain: it.domain, phone: it.phone, claimed: it.is_claimed, rating: it.rating?.value, votes: it.rating?.votes_count, cid: it.cid, place: it.place_id, lat: it.latitude, lng: it.longitude, photos: it.total_photos, desc: trim(it.description, 300), status: it.work_time?.work_hours?.current_status })}`);
            if (!(r?.items ?? []).length) console.log(`### GBP ${J({ kw, none: true })}`);
          } catch (e) { console.log(`### PHASEERR ${J({ phase: "local-gbp", kw, err: trim(String(e), 200) })}`); }
        }
        for (const q of PARAMS.maps || []) {
          try {
            const r: any = await post(creds, "/serp/google/maps/live/advanced", [{ keyword: q, location_coordinate: PARAMS.coord || "39.1031,-84.5120,13z", language_code: "en", depth: Number(PARAMS.mapDepth || 40) }]);
            const items = (r?.items ?? []).filter((x: any) => x.type === "maps_search");
            const me = items.find((x: any) => /bsllc\.biz/i.test(String(x.domain || x.url || "")) || /^bs\s*llc/i.test(String(x.title || "")));
            console.log(`### MAPS ${J({ q, n: items.length, me: me ? { p: me.rank_group, title: me.title, url: me.url, cat: me.category, r: me.rating?.value, v: me.rating?.votes_count } : null, top: items.slice(0, 12).map((x: any) => [x.rank_group, trim(x.title, 40), x.domain, x.rating?.value, x.rating?.votes_count, trim(x.category, 30)]) })}`);
          } catch (e) { console.log(`### PHASEERR ${J({ phase: "local-maps", q, err: trim(String(e), 200) })}`); }
        }
      }
      if (ph === "serp") {
        for (const q of PARAMS.serps || []) {
          try {
            const body: any = { keyword: q, language_code: "en", device: "desktop", os: "windows", depth: 20 };
            if (PARAMS.serpLocation) body.location_name = PARAMS.serpLocation; else body.location_code = LOC;
            let r: any = null;
            for (let a = 0; a < 3 && !r; a++) { try { r = await post(creds, "/serp/google/organic/live/advanced", [body]); } catch (e) { if (a === 2) throw e; await sleep(4000); } }
            const items = (r?.items ?? []);
            console.log(`### SERP ${J({ q, loc: PARAMS.serpLocation || LOC, types: [...new Set(items.map((x: any) => x.type))], org: items.filter((x: any) => x.type === "organic").slice(0, 20).map((x: any) => ({ p: x.rank_group, d: x.domain, w: x.website_name, b: trim(x.breadcrumb, 70), u: trim(x.url, 100), t: trim(x.title, 70) })), paa: items.filter((x: any) => x.type === "people_also_ask").flatMap((x: any) => (x.items || []).map((i: any) => trim(i.title, 90))).slice(0, 6), pack: items.filter((x: any) => x.type === "local_pack").map((x: any) => [trim(x.title, 50), x.domain, x.rating?.value]).slice(0, 5), aio: items.some((x: any) => x.type === "ai_overview") })}`);
          } catch (e) { console.log(`### PHASEERR ${J({ phase: "serp", q, err: trim(String(e), 200) })}`); }
        }
      }
    } catch (e) { console.log(`### PHASEERR ${J({ phase: ph, err: trim(String(e), 300) })}`); }
  }
  const after = await fetch("https://api.dataforseo.com/v3/appendix/user_data", { headers: { authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") } }).then((r) => r.json()).catch(() => null) as any;
  console.log(`# balance after: $${after?.tasks?.[0]?.result?.[0]?.money?.balance ?? "?"}`);
  console.log(`### JSON summary\n${J({ phases: PHASES, calls, spent: +spent.toFixed(4) })}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

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
      if (ph === "serp") {
        for (const q of PARAMS.serps || []) {
          try {
            const body: any = { keyword: q, language_code: "en", device: "desktop", os: "windows", depth: 20 };
            if (PARAMS.serpLocation) body.location_name = PARAMS.serpLocation; else body.location_code = LOC;
            let r: any = null;
            for (let a = 0; a < 3 && !r; a++) { try { r = await post(creds, "/serp/google/organic/live/advanced", [body]); } catch (e) { if (a === 2) throw e; await sleep(4000); } }
            const items = (r?.items ?? []);
            console.log(`### SERP ${J({ q, loc: PARAMS.serpLocation || LOC, types: [...new Set(items.map((x: any) => x.type))], org: items.filter((x: any) => x.type === "organic").slice(0, 20).map((x: any) => ({ p: x.rank_group, d: x.domain, u: trim(x.url, 100), t: trim(x.title, 70) })), paa: items.filter((x: any) => x.type === "people_also_ask").flatMap((x: any) => (x.items || []).map((i: any) => trim(i.title, 90))).slice(0, 6), pack: items.filter((x: any) => x.type === "local_pack").flatMap((x: any) => (x.items || []).map((i: any) => trim(i.title, 50))).slice(0, 5), aio: items.some((x: any) => x.type === "ai_overview") })}`);
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

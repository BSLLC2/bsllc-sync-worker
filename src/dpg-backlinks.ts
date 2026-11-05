#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, type DfsCreds } from "./dataforseo.js";

/**
 * READ-ONLY. Backlink research for dieselpowergroup.com, DataForSEO only. Nothing is written anywhere.
 * A: who ranks for the target searches (SERP top 20, US desktop) -> competitor set
 * B: backlink summary for DPG and each competitor
 * C: DPG referring domains (and whether AERA, BBB, Caterpillar, Truckers Network link)
 * D: domains linking to two or more competitors but not DPG (domain intersection, partial mode)
 * E: DPG anchors
 * REFERENCE_COST (USD) is a reference, not a stop.
 */
const REFERENCE_COST = Number(process.env.REFERENCE_COST || "5");
const OURS = "dieselpowergroup.com";
const QUERIES = [
  "reman engines", "remanufactured diesel engines", "remanufactured diesel engine", "remanufactured cat c15 engine", "cat c15 reman engine",
  "remanufactured cummins n14 engine", "remanufactured cummins isx engine", "remanufactured detroit series 60 engine", "remanufactured diesel engine cost",
  "diesel engine rebuilders", "reman diesel engines for sale", "remanufactured semi truck engine", "cat 3406e remanufactured engine", "remanufactured detroit dd15 engine",
];
const SEED_COMPETITORS = ["reviva.com", "blackwaterengines.com", "srcreman.com", "jasperengines.com", "capitalremanexchange.com", "dieselpowerusa.com"];
const NOT_COMPETITORS = /(^|\.)(amazon|ebay|walmart|youtube|facebook|reddit|quora|pinterest|wikipedia|alibaba|aliexpress|yelp|linkedin|instagram|tiktok|indeed|glassdoor|mckinsey|forbes|nytimes|truckersreport|ritchiespecs|machinerytrader|truckpaper|cargurus|autotrader|craigslist|offerup|carparts|partsgeek|rockauto|jdpower|kbb)\./;
const MEMBERSHIP = [
  { name: "AERA (engine rebuilders association)", rx: /(^|\.)aera\.(net|org)$|aeraonline|enginebuilder/ },
  { name: "BBB", rx: /(^|\.)bbb\.org$/ },
  { name: "Caterpillar", rx: /(^|\.)cat\.com$|caterpillar\.com$/ },
  { name: "Truckers Network", rx: /truckersnetwork|truckers-network/ },
];
const KINDS: Array<[string, RegExp]> = [
  ["trade association or membership", /(^|\.)aera\.|aeraonline|trucking\.org|ata\.|nada\.|truckload|owner-?operator|ooida\.com|nastc|nationalpowertrain|apra|rma\.org|remanufactur/],
  ["business directory or citation", /(^|\.)(bbb|yelp|yellowpages|manta|bing|mapquest|chamberofcommerce|foursquare|dnb|hotfrog|superpages|buzzfile|cylex|local|citysearch|merchantcircle|alignable|nextdoor)\./],
  ["trucking or diesel media", /(truckinginfo|ccjdigital|ccjtruckdriver|truckingnews|fleetowner|overdriveonline|tdtmagazine|truckdriver|trucknews|equipmentworld|dieselworld|dieselnet|dieselhub|truckandbus|truckpartsnews|aftermarketnews|hdaftermarket|truckerpath|truckstop|dat\.com|landline|roadkingmagazine|10-4|truck)/],
  ["forum or community", /(forum|community|reddit|quora|discussion|boards|thetruckersreport|peterbilt|kenworth|dieseltruckresource|cumminsforum|dieselstop)/],
  ["supplier or manufacturer", /(cat\.com|caterpillar|cummins|detroitdiesel|detroit|paccar|volvotrucks|daimler|freightliner|navistar|international|mack|eaton|allison|fleetguard|donaldson|bosch)/],
  ["dealer or competitor", /(engine|diesel|reman|powertrain|truck|parts|motor)/],
];
const kindOf = (d: string) => { for (const [k, rx] of KINDS) if (rx.test(d)) return k; return "other"; };
const SPAMMY = /(^|\.)(semrush|ahrefs|moz|majestic|similarweb|alexa|siteprice|websiteoutlook|statshow|urlscan|builtwith|wappalyzer|whois|w3snoop|domaintools|sitelike|hypestat|trustpilot|scamadviser|siterankdata|siteoverview|woorank|backlinko|spyfu|sistrix|pagespeed|webwiki|xranks|similarsites|hosting|seo|rank|stats|checker|analyz|link)/;

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const csv = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const row = (...c: unknown[]) => console.log(c.map(csv).join(","));
const block = (name: string, header: string[]) => { console.log(`\n### CSV ${name}`); row(...header); };
const end = () => console.log("### END");
const dom = (s: string) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let spent = 0; let calls = 0;
const parts: Record<string, { spent: number; calls: number }> = {};
let cur = "";
function part(name: string) { cur = name; parts[name] = { spent: 0, calls: 0 }; }
async function dfs(creds: DfsCreds, method: "POST" | "GET", path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, { method, headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(100000) });
  console.error(`[${new Date().toISOString().slice(11,19)}] ${method} ${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const j: any = await res.json(); const c = n(j?.cost) ?? 0; calls++; spent += c;
  if (parts[cur]) { parts[cur]!.spent += c; parts[cur]!.calls++; }
  return j;
}
async function task(creds: DfsCreds, path: string, body: unknown, retries = 2): Promise<any> {
  for (let a = 0; ; a++) {
    try {
      const j = await dfs(creds, "POST", path, body); const t = j?.tasks?.[0];
      if (!t || t.status_code !== 20000) throw new Error(`${path}: ${t?.status_code} ${t?.status_message ?? "no task"}`);
      return t.result;
    } catch (e) { if (!/40101|50000|HTTP 5/.test(String(e)) || a >= retries) throw e; await sleep(3000 * (a + 1)); }
  }
}
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}
const bal = async (creds: DfsCreds) => dfs(creds, "GET", "/appendix/user_data").then((j) => n(j?.tasks?.[0]?.result?.[0]?.money?.balance)).catch(() => null);

(async () => {
  const creds = credsFromEnv();
  if (!creds) { console.error("DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set"); process.exit(2); }
  console.log(`RUN ${new Date().toISOString().slice(0, 10)} · DPG backlink research · read-only · reference cost $${REFERENCE_COST}`);
  part("balance");
  const before = await bal(creds);
  console.log(`# balance before: ${before == null ? "unreadable" : "$" + before.toFixed(4)}`);
  if (before != null && before < 1) { console.log("!! balance under $1, stopping before any call"); process.exit(4); }

  // A: SERP competitors
  part("A_serp");
  type S = { q: string; err: string | null; items: Array<{ rank: number; domain: string; url: string }> };
  const serps = await pool(QUERIES, 3, async (q): Promise<S> => {
    try {
      const res = await task(creds, "/serp/google/organic/live/advanced", [{ keyword: q, location_code: 2840, language_name: "English", device: "desktop", depth: 30 }], 3);
      const rawOrg = (res?.[0]?.items ?? []).filter((i: any) => i?.type === "organic");
      if (q === QUERIES[0]) { const f = rawOrg[0] ?? {}; console.log(`# DEBUG keys ${Object.keys(f).join(",")}`); console.log(`# DEBUG sample ${JSON.stringify({ domain: f.domain, url: f.url, breadcrumb: f.breadcrumb, website_name: f.website_name, cache_url: f.cache_url, title: f.title }).slice(0, 400)}`); }
      const hostish = (c: string) => c.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[\/\s›]/)[0]!.toLowerCase();
      const pick = (i: any) => { const cands = [i.url, i.domain, i.breadcrumb, i.website_name, i.cache_url].map((x: any) => String(x ?? "")).filter(Boolean); return cands.find((c) => hostish(c) !== "google.com" && /\./.test(hostish(c))) ?? cands[0] ?? ""; };
      const items = rawOrg.map((i: any) => ({ rank: n(i.rank_absolute) ?? 0, domain: hostish(pick(i)), url: String(i.url ?? "") }));
      return { q, err: null, items };
    } catch (e) { return { q, err: String(e).slice(0, 160), items: [] }; }
  });
  for (const s of serps.slice(0, 2)) { console.log(`# DEBUG serp "${s.q}" err=${s.err} items=${s.items.length}`); for (const it of s.items.slice(0, 12)) console.log(`# DEBUG ${it.rank} ${it.domain} ${it.url.slice(0, 90)}`); }
  const tally = new Map<string, { n: number; best: number; qs: Set<string> }>();
  for (const s of serps) for (const it of s.items) {
    if (it.rank > 20 || !it.domain) continue;
    const e = tally.get(it.domain) ?? { n: 0, best: 999, qs: new Set<string>() };
    e.n++; e.best = Math.min(e.best, it.rank); e.qs.add(s.q); tally.set(it.domain, e);
  }
  block("A_serp_domains_top20", ["domain", "appearances_in_top20", "queries_present", "best_position", "counted_as_competitor", "source", "date"]);
  const ranked = [...tally.entries()].sort((a, b) => b[1].qs.size - a[1].qs.size || a[1].best - b[1].best);
  for (const [d, e] of ranked.slice(0, 40)) row(d, e.n, e.qs.size, e.best, d === OURS ? "this is DPG" : NOT_COMPETITORS.test(d + ".") ? "no (marketplace, directory or media)" : "yes", "serp/google/organic/live/advanced (US desktop, top 20)", "");
  for (const s of serps) if (s.err) row(`# serp failed for "${s.q}": ${s.err}`);
  end();
  const dpgRanks = serps.map((s) => ({ q: s.q, best: s.items.filter((i) => i.domain === OURS).map((i) => i.rank).sort((a, b) => a - b)[0] ?? null }));
  block("A_dpg_positions_in_top30", ["query", "dpg_best_position_in_top30", "note"]);
  for (const r of dpgRanks) row(r.q, r.best ?? "not in top 30", "");
  end();
  const serpComps = ranked.filter(([d, e]) => d !== OURS && !NOT_COMPETITORS.test(d + ".") && e.qs.size >= 3).map(([d]) => d);
  const comps = [...new Set([...SEED_COMPETITORS, ...serpComps])].filter((c) => !/google\./.test(c)).slice(0, 12);
  console.log(`# competitor set (${comps.length}): ${comps.join(", ")}`);

  // B: summaries
  part("B_summary");
  type Sum = { d: string; rank: number | null; backlinks: number | null; refDomains: number | null; dofollow: number | null; err: string };
  const sums = await pool([OURS, ...comps], 4, async (d): Promise<Sum> => {
    try {
      const res = await task(creds, "/backlinks/summary/live", [{ target: d, include_subdomains: true, internal_list_limit: 0, backlinks_status_type: "live" }]);
      const r = res?.[0] ?? {};
      return { d, rank: n(r.rank), backlinks: n(r.backlinks), refDomains: n(r.referring_domains), dofollow: n(r?.referring_links_attributes?.nofollow) == null ? null : (n(r.backlinks) ?? 0) - (n(r?.referring_links_attributes?.nofollow) ?? 0), err: "" };
    } catch (e) { return { d, rank: null, backlinks: null, refDomains: null, dofollow: null, err: String(e).slice(0, 140) }; }
  });
  block("B_backlink_summary", ["domain", "domain_rank", "backlinks", "referring_domains", "dofollow_backlinks_est", "note", "source"]);
  for (const s of sums) row(s.d, s.rank ?? "no data", s.backlinks ?? "no data", s.refDomains ?? "no data", s.dofollow ?? "no data", s.err || (s.d === OURS ? "DPG" : "competitor"), "backlinks/summary/live");
  end();
  const usable = comps.filter((c) => (sums.find((s) => s.d === c)?.refDomains ?? 0) > 0);

  // C: DPG referring domains
  part("C_dpg_refdomains");
  type RD = { d: string; rank: number | null; backlinks: number | null; first: string };
  const mine: RD[] = [];
  try {
    const res = await task(creds, "/backlinks/referring_domains/live", [{ target: OURS, include_subdomains: true, limit: 1000, order_by: ["rank,desc"], backlinks_status_type: "live" }]);
    for (const it of res?.[0]?.items ?? []) mine.push({ d: dom(String(it?.domain ?? "")), rank: n(it?.rank), backlinks: n(it?.backlinks), first: String(it?.first_seen ?? "").slice(0, 10) });
  } catch (e) { console.log(`# referring_domains failed: ${String(e).slice(0, 160)}`); }
  block("C_dpg_referring_domains_top60", ["referring_domain", "domain_rank", "backlinks_to_dpg", "first_seen", "kind", "source"]);
  if (!mine.length) row("no data", "", "", "", "", "backlinks/referring_domains/live");
  for (const r of mine.slice(0, 60)) row(r.d, r.rank ?? "", r.backlinks ?? "", r.first, kindOf(r.d), "backlinks/referring_domains/live");
  end();
  block("C_memberships_linking_to_dpg", ["membership", "links_to_dpg", "domain_found", "note"]);
  for (const m of MEMBERSHIP) {
    const hit = mine.find((r) => m.rx.test(r.d));
    row(m.name, hit ? "yes" : (mine.length ? "no (not in the first 1000 referring domains)" : "no data"), hit?.d ?? "", hit ? `rank ${hit.rank ?? "?"}, ${hit.backlinks ?? "?"} links` : "");
  }
  end();

  // E: anchors
  part("E_anchors");
  block("E_dpg_anchor_text_top30", ["anchor", "backlinks", "referring_domains", "source"]);
  try {
    const res = await task(creds, "/backlinks/anchors/live", [{ target: OURS, include_subdomains: true, limit: 30, order_by: ["backlinks,desc"], backlinks_status_type: "live" }]);
    const items: any[] = res?.[0]?.items ?? [];
    if (!items.length) row("no data", "", "", "backlinks/anchors/live");
    for (const it of items) row(String(it?.anchor ?? "(empty)").slice(0, 80), n(it?.backlinks) ?? "", n(it?.referring_domains) ?? "", "backlinks/anchors/live");
  } catch (e) { row("no data", "", "", `call failed: ${String(e).slice(0, 140)}`); }
  end();

  // D: intersection
  part("D_intersection");
  const mineSet = new Set(mine.map((r) => r.d));
  type T = { d: string; rank: number; links: string[]; kind: string };
  const targets: T[] = [];
  const runInt = async (cs: string[]) => {
    const targetsObj: Record<string, string> = {}; cs.forEach((c, i) => { targetsObj[String(i + 1)] = c; });
    const res = await task(creds, "/backlinks/domain_intersection/live", [{ targets: targetsObj, exclude_targets: [OURS], intersection_mode: "partial", include_subdomains: true, exclude_internal_backlinks: true, limit: 1000, order_by: ["1.rank,desc"] }]);
    for (const it of res?.[0]?.items ?? []) {
      const di = it?.domain_intersection ?? {}; const keys = Object.keys(di);
      if (keys.length < 2) continue;
      const d = dom(String(di[keys[0]!]?.target ?? "")); if (!d) continue;
      const rank = Math.max(...keys.map((k) => n(di[k]?.rank) ?? 0));
      targets.push({ d, rank, links: keys.map((k) => cs[Number(k) - 1]!).filter(Boolean), kind: kindOf(d) });
    }
  };
  let intErr = "";
  if (usable.length >= 2) { try { await runInt(usable.slice(0, 10)); } catch (e) { intErr = String(e).slice(0, 160); } } else intErr = "fewer than two competitors had backlink data";
  const seen = new Set<string>();
  const filtered = targets.filter((t) => { if (seen.has(t.d)) return false; seen.add(t.d); return true; })
    .filter((t) => !mineSet.has(t.d) && !SPAMMY.test(t.d) && !NOT_COMPETITORS.test(t.d + ".") && !usable.includes(t.d))
    .sort((a, b) => b.links.length - a.links.length || b.rank - a.rank);
  block("D_link_gap_domains_top80", ["referring_domain", "domain_rank", "links_to_n_competitors", "links_to", "kind", "already_links_to_dpg", "source"]);
  if (!filtered.length) row(intErr ? `no data (${intErr})` : "no data", "", "", "", "", "", "backlinks/domain_intersection/live");
  for (const t of filtered.slice(0, 80)) row(t.d, t.rank, t.links.length, t.links.join(" | "), t.kind, "no", `backlinks/domain_intersection/live (partial mode; competitors: ${usable.slice(0, 10).join(", ")}; DPG excluded; analytics, SEO-tool and marketplace domains dropped)`);
  end();
  console.log(`# gap domains before filtering: ${targets.length}; after: ${filtered.length}`);

  // F: per-competitor referring domains, then our own overlap count (robust fallback for the intersection endpoint)
  part("F_comp_refdomains");
  const compLists = new Map<string, Array<{ d: string; rank: number }>>();
  await pool(usable.slice(0, 8), 3, async (c) => {
    try {
      const res = await task(creds, "/backlinks/referring_domains/live", [{ target: c, include_subdomains: true, limit: 400, order_by: ["rank,desc"], backlinks_status_type: "live" }]);
      compLists.set(c, (res?.[0]?.items ?? []).map((it: any) => ({ d: dom(String(it?.domain ?? "")), rank: n(it?.rank) ?? 0 })).filter((x: any) => x.d && x.rank >= 10 && !SPAMMY.test(x.d) && !NOT_COMPETITORS.test(x.d + ".") && !/^\d+\.\d+\.\d+\.\d+$/.test(x.d)));
    } catch (e) { console.log(`# refdomains failed for ${c}: ${String(e).slice(0, 120)}`); }
  });
  block("F_top_competitor_referring_domains", ["competitor", "referring_domain", "domain_rank", "kind", "links_to_dpg", "source"]);
  for (const [c, list] of compLists) for (const x of list.slice(0, 30)) row(c, x.d, x.rank, kindOf(x.d), mineSet.has(x.d) ? "yes" : "no", "backlinks/referring_domains/live (rank 10 or higher, analytics and SEO-tool domains dropped)");
  end();
  const overlap = new Map<string, { rank: number; cs: string[] }>();
  for (const [c, list] of compLists) for (const x of list) { const e = overlap.get(x.d) ?? { rank: x.rank, cs: [] }; e.cs.push(c); e.rank = Math.max(e.rank, x.rank); overlap.set(x.d, e); }
  block("F_overlap_links_to_2plus_competitors_not_dpg", ["referring_domain", "domain_rank", "links_to_n_competitors", "links_to", "kind", "source"]);
  const ov = [...overlap.entries()].filter(([d, e]) => e.cs.length >= 2 && !mineSet.has(d)).sort((a, b) => b[1].cs.length - a[1].cs.length || b[1].rank - a[1].rank);
  if (!ov.length) row("no data: no domain linked to two or more competitors", "", "", "", "", "own overlap of the referring-domain lists");
  for (const [d, e] of ov.slice(0, 60)) row(d, e.rank, e.cs.length, e.cs.join(" | "), kindOf(d), `own overlap of referring domains (rank 10 or higher) for: ${[...compLists.keys()].join(", ")}`);
  end();

  part("balance_after");
  const after = await bal(creds);
  console.log(`\n# balance after: ${after == null ? "unreadable" : "$" + after.toFixed(4)}`);
  console.log(`### JSON summary`);
  console.log(JSON.stringify({ calls, spent: Number(spent.toFixed(4)), reference: REFERENCE_COST, before, after, parts, competitors: comps, usable }));
})().catch((e) => { console.error(e); process.exit(1); });

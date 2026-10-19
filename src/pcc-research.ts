#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, type DfsCreds } from "./dataforseo.js";

/**
 * READ-ONLY keyword + SERP research for the Pink Cash Cow (pinkcashcow.com)
 * website redesign. DataForSEO only. Every block names its endpoint and the
 * run date; nothing is estimated here — a missing figure prints blank.
 *
 *   PART=all (default): seeds → metrics → SERPs → auto competitor pass
 *   PART=b: hand-listed competitors (COMPETITORS / NATIONAL env), full local top-10s, DMA volumes
 *
 * Output: CSV blocks between "### CSV name" / "### END" so the sections split
 * into sheet tabs without re-typing. Spend is summed from each task's `cost`.
 */

const DOMAIN = "pinkcashcow.com";
const RUN = new Date().toISOString().slice(0, 10);
const US = 2840;

// ── Seeds (Step 1) ────────────────────────────────────────────────────────
const SEEDS: Record<string, string[]> = {
  "A Cincinnati STR management": ["short term rental management cincinnati", "airbnb management cincinnati", "vacation rental property manager cincinnati", "furnished rental management cincinnati", "mid term rental management cincinnati", "airbnb property management cincinnati ohio", "str management company cincinnati"],
  "B Out-of-state investor": ["out of state airbnb investor", "how to invest in airbnb out of state", "remote short term rental investing", "hands off airbnb investing", "turnkey airbnb cincinnati", "airbnb investment property cincinnati", "buy airbnb investment property", "short term rental investing for beginners", "passive airbnb investing"],
  "C Tax / returns": ["short term rental tax benefits", "short term rental loophole", "cost segregation short term rental", "str cash flow cincinnati", "airbnb roi cincinnati", "is cincinnati a good airbnb market", "short term rental tax loophole bonus depreciation", "airbnb cash flow", "material participation short term rental"],
  "D Market and regulation": ["cincinnati short term rental regulations", "cincinnati airbnb permit", "cincinnati str laws", "best neighborhoods for airbnb cincinnati", "over the rhine airbnb investment", "hyde park cincinnati airbnb", "mt adams cincinnati airbnb", "northside cincinnati airbnb", "covington ky airbnb regulations", "newport ky airbnb regulations", "kings island airbnb investment", "cincinnati airbnb market"],
  "E Services": ["airbnb furnishing service", "str interior design", "design and furnish short term rental", "airbnb co-host cincinnati", "airbnb revenue estimate", "rental income calculator airbnb", "airbnb setup service", "furnished rental design service"],
  "F Brand": ["pink cash cow", "pink cash cow property management", "pink cash cow cincinnati", "yiwei cheng"],
  "G Question / AI-search": ["who manages airbnbs in cincinnati", "how much does airbnb management cost", "what percent do airbnb managers charge", "should i use a property manager for airbnb", "how to find an airbnb property manager", "airbnb management fees", "what does an airbnb property manager do", "is airbnb management worth it"],
};
const RELEVANT = /rental|airbnb|vrbo|\bstr\b|\bmtr\b|short[- ]?term|mid[- ]?term|furnish|property manag|co-?host|invest|cash ?flow|loophole|cost seg|depreciation|cincinnati|cincy|ohio|\botr\b|over[- ]the[- ]rhine|hyde park|mt\.? ?adams|northside|covington|newport|kings island|turnkey|\bhost|bnb|vacation|passive income|real estate|rental property|landlord|roi|revenue|income calc|regulation|permit|license|ordinance|zoning|neighborhood|pink cash cow|material participation/i;
const JUNK = /\bjob|salary|login|lawsuit|porta|car rental|truck|equipment|dumpster|tool rental|wedding|costume|tuxedo|boat|\brv\b|bounce house|party rental|tent rental|storage|uhaul|apartment finder|craigslist|zillow|mortgage calculator|crypto|stock|forex|insurance quote|university|hiring|careers|salary|reddit|lawyer|attorney|eviction|section 8|hud\b/i;
const QUESTION = /^(who|what|how|why|when|where|which|is|are|can|should|do|does|did|will)\b/i;
const GUEST = /\b(to stay|stay in|stays?|places? to|where to stay|cabins?|downtown cincinnati|near (me|downtown|uc|university|kings island|the stadium|paycor|great american)|cheap|pet[- ]friendly|with (a )?(pool|hot tub|jacuzzi)|for rent|apartments?|weekend|getaway|romantic|luxury (airbnb|rental)s?|treehouse|lake|book|night|rooms?|hotel|wedding|bachelorette|condo for rent|house for rent|monthly rental|month to month)\b/i;
const INVEST = /invest|investor|roi|cash ?flow|tax|loophole|cost seg|depreciation|turnkey|hands[- ]off|remote|out of state|passive|buy|purchase|underwrit|analy|profit|return|revenue|income|market|material participation|1031|llc|loan|financ/i;
const MANAGE = /manag|co-?host|property manager|host(ing)? service|furnish|design|setup|set up|interior|turnover|cleaning service|concierge/i;
const LOCAL = /cincinnati|cincy|ohio|\botr\b|over[- ]the[- ]rhine|hyde park|mt\.? ?adams|northside|covington|newport|kings island|oakley|norwood|mason|west chester|blue ash|clifton|walnut hills|east walnut/i;
const BLOCK_DOMAINS = /^(airbnb|vrbo|booking|expedia|tripadvisor|hotels|yelp|bbb|facebook|instagram|linkedin|youtube|reddit|biggerpockets|google|wikipedia|zillow|realtor|redfin|apartments|furnishedfinder|craigslist|indeed|glassdoor|evolve|vacasa|awning|airdna|mashvisor|hostaway|guesty|lodgify|hospitable|turno|pricelabs|rabbu|hostfully|nerdwallet|forbes|investopedia|irs|cincinnati-oh|cincinnati|ohio|hamiltoncountyohio|quora|medium|thumbtack|angi|homeadvisor|yiwei)\./i;

// ── helpers ───────────────────────────────────────────────────────────────
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const csv = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const row = (...cells: unknown[]) => console.log(cells.map(csv).join(","));
const block = (name: string, header: string[]) => { console.log(`\n### CSV ${name}`); row(...header); };
const end = () => console.log("### END");
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const spend: Record<string, { calls: number; cost: number; errors: number }> = {};
const tally = (path: string, cost: number, err = false) => { const s = (spend[path] ??= { calls: 0, cost: 0, errors: 0 }); s.calls++; s.cost += cost; if (err) s.errors++; };

async function dfs(creds: DfsCreds, method: "POST" | "GET", path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, { method, headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) { tally(path, 0, true); throw new Error(`HTTP ${res.status} ${path}: ${(await res.text().catch(() => "")).slice(0, 160)}`); }
  const j: any = await res.json();
  const t = j?.tasks?.[0];
  tally(path.replace(/\/[a-z]{2}$/, ""), n(t?.cost) ?? n(j?.cost) ?? 0, !t || t.status_code !== 20000);
  if (!t || t.status_code !== 20000) throw new Error(`${path}: ${t?.status_message ?? "no task"}`);
  return t.result;
}
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}
const trend = (ms: any): string => Array.isArray(ms) ? ms.slice(0, 12).reverse().map((m: any) => `${m.year}-${String(m.month).padStart(2, "0")}:${n(m.search_volume) ?? ""}`).join("|") : "";
const trendDelta = (ms: any): string => { if (!Array.isArray(ms) || ms.length < 12) return ""; const a = n(ms[0]?.search_volume), b = n(ms[11]?.search_volume); return a == null || b == null || b === 0 ? "" : String(Math.round(((a - b) / b) * 100)); };

type Kw = { keyword: string; clusters: Set<string>; seeds: Set<string>; via: Set<string>; volume: number | null; cpc: number | null; comp: number | null; kd: number | null; intent: string; intentP: number | null; features: string[]; aio: boolean; trend: string; delta: string; lowTop: string };
const kws = new Map<string, Kw>();
const get = (k: string) => { const key = norm(k); let e = kws.get(key); if (!e) { e = { keyword: key, clusters: new Set(), seeds: new Set(), via: new Set(), volume: null, cpc: null, comp: null, kd: null, intent: "", intentP: null, features: [], aio: false, trend: "", delta: "", lowTop: "" }; kws.set(key, e); } return e; };
function absorb(e: Kw, it: any) {
  const kd = it?.keyword_data ?? it ?? {};
  const info = kd?.keyword_info ?? {}; const props = kd?.keyword_properties ?? {}; const si = kd?.search_intent_info ?? {}; const serp = kd?.serp_info ?? {};
  if (e.volume == null) e.volume = n(info.search_volume);
  if (e.cpc == null) e.cpc = n(info.cpc);
  if (e.comp == null) e.comp = n(info.competition_index) ?? (n(info.competition) == null ? null : Math.round(info.competition * 100));
  if (e.kd == null) e.kd = n(props.keyword_difficulty);
  if (!e.intent && si?.main_intent) { e.intent = String(si.main_intent); e.intentP = n(si?.foreign_intent?.[0]?.probability) ?? null; }
  if (!e.features.length && Array.isArray(serp?.serp_item_types)) { e.features = serp.serp_item_types.map(String); e.aio = e.features.includes("ai_overview"); }
  if (!e.trend) { e.trend = trend(info.monthly_searches); e.delta = trendDelta(info.monthly_searches); }
  if (!e.lowTop && info.low_top_of_page_bid != null) e.lowTop = `${info.low_top_of_page_bid}-${info.high_top_of_page_bid ?? ""}`;
}
function label(k: string): string {
  if (/pink cash cow|yiwei/i.test(k)) return "Brand";
  const local = LOCAL.test(k);
  if (MANAGE.test(k) || INVEST.test(k)) {
    if (local) return "Local-investor";
    return QUESTION.test(k) && !/invest|out of state|remote|turnkey|passive|tax|loophole|cost seg/i.test(k) ? "Informational" : "Investor";
  }
  if (GUEST.test(k) || (local && /airbnb|rental|vrbo|bnb|stay/i.test(k) && !MANAGE.test(k))) return "Guest (exclude)";
  if (QUESTION.test(k) || /regulation|permit|law|ordinance|license|zoning|neighborhood|market/i.test(k)) return local ? "Local-investor" : "Informational";
  return "Informational";
}

async function main() {
  const creds = credsFromEnv();
  console.log(`\nRUN ${RUN} · PCC research · DataForSEO · read-only`);

  // ── 0. Locations ────────────────────────────────────────────────────────
  block("0_locations", ["use", "location_name", "location_code", "location_type", "source", "date"]);
  const locs: any[] = await dfs(creds, "GET", "/keywords_data/google_ads/locations/us").catch((e) => { console.log(`# locations error: ${e}`); return []; });
  const city = locs.find((l) => /^Cincinnati,Ohio,United States$/i.test(String(l.location_name)) && /city/i.test(String(l.location_type)));
  const dma = locs.find((l) => /^Cincinnati OH,United States$/i.test(String(l.location_name)) && /dma/i.test(String(l.location_type)));
  const cityCode: number | null = n(city?.location_code); const dmaCode: number | null = n(dma?.location_code);
  row("national", "United States", US, "Country", "keywords_data/google_ads/locations", RUN);
  row("local city", city?.location_name ?? "NOT FOUND", cityCode ?? "", city?.location_type ?? "", "keywords_data/google_ads/locations", RUN);
  row("local DMA", dma?.location_name ?? "NOT FOUND", dmaCode ?? "", dma?.location_type ?? "", "keywords_data/google_ads/locations", RUN);
  end();

  // ── 1. Seeds + Labs expansion (national) ────────────────────────────────
  block("1_seeds", ["cluster", "seed", "date"]);
  for (const [c, list] of Object.entries(SEEDS)) for (const s of list) { row(c, s, RUN); const e = get(s); e.clusters.add(c); e.seeds.add(s); e.via.add("seed"); }
  end();
  const allSeeds = Object.entries(SEEDS).filter(([c]) => !c.startsWith("F")).flatMap(([c, l]) => l.map((s) => ({ c, s })));
  console.log(`# est cost: keyword_ideas ${Object.keys(SEEDS).length - 1} calls + related_keywords ${allSeeds.length} + keyword_suggestions ${allSeeds.length} ≈ $${((Object.keys(SEEDS).length - 1 + allSeeds.length * 2) * 0.012).toFixed(2)} (Labs ≈ $0.01/task + rows)`);
  const expansions: Array<{ cluster: string; seed: string; via: string; items: any[] }> = [];
  for (const [c, list] of Object.entries(SEEDS)) {
    if (c.startsWith("F")) continue;
    const r = await dfs(creds, "POST", "/dataforseo_labs/google/keyword_ideas/live", [{ keywords: list, location_code: US, language_code: "en", limit: 300, include_serp_info: true, order_by: ["keyword_info.search_volume,desc"] }]).catch((e) => { console.log(`# keyword_ideas ${c}: ${e}`); return null; });
    expansions.push({ cluster: c, seed: list.join(" + "), via: "keyword_ideas", items: r?.[0]?.items ?? [] });
  }
  const rel = await pool(allSeeds, 4, async ({ c, s }) => ({ cluster: c, seed: s, via: "related_keywords", items: (await dfs(creds, "POST", "/dataforseo_labs/google/related_keywords/live", [{ keyword: s, location_code: US, language_code: "en", depth: 2, limit: 150, include_serp_info: true }]).catch((e) => { console.log(`# related ${s}: ${e}`); return null; }))?.[0]?.items ?? [] }));
  const sug = await pool(allSeeds, 4, async ({ c, s }) => ({ cluster: c, seed: s, via: "keyword_suggestions", items: (await dfs(creds, "POST", "/dataforseo_labs/google/keyword_suggestions/live", [{ keyword: s, location_code: US, language_code: "en", limit: 150, include_serp_info: true, order_by: ["keyword_info.search_volume,desc"] }]).catch((e) => { console.log(`# suggestions ${s}: ${e}`); return null; }))?.[0]?.items ?? [] }));
  let raw = 0, kept = 0, dropJunk = 0, dropIrrelevant = 0;
  for (const x of [...expansions, ...rel, ...sug]) for (const it of x.items) {
    const k = norm(String(it?.keyword_data?.keyword ?? it?.keyword ?? "")); if (!k) continue; raw++;
    if (JUNK.test(k)) { dropJunk++; continue; }
    if (!RELEVANT.test(k)) { dropIrrelevant++; continue; }
    const e = get(k); e.clusters.add(x.cluster); e.seeds.add(x.seed.slice(0, 60)); e.via.add(x.via); absorb(e, it); kept++;
  }
  console.log(`# expansion: ${raw} raw rows, ${dropJunk} junk, ${dropIrrelevant} off-topic, ${kept} kept → ${kws.size} unique keywords`);

  // ── 2. Metrics: keyword_overview (national) for everything, Google Ads for local ──
  const list = [...kws.keys()];
  const top = list.filter((k) => kws.get(k)!.via.has("seed") || (kws.get(k)!.volume ?? 0) >= 10 || QUESTION.test(k)).slice(0, 1400);
  console.log(`# keyword_overview: ${top.length} keywords in ${Math.ceil(top.length / 700)} call(s) ≈ $${(Math.ceil(top.length / 700) * 0.01 + top.length * 0.0001).toFixed(2)}`);
  for (let i = 0; i < top.length; i += 700) {
    const r = await dfs(creds, "POST", "/dataforseo_labs/google/keyword_overview/live", [{ keywords: top.slice(i, i + 700), location_code: US, language_code: "en", include_serp_info: true }]).catch((e) => { console.log(`# keyword_overview: ${e}`); return null; });
    for (const it of r?.[0]?.items ?? []) { const e = kws.get(norm(String(it?.keyword ?? ""))); if (e) { e.volume = null; e.kd = null; e.intent = ""; e.features = []; e.trend = ""; absorb(e, it); } }
  }
  // Search intent for anything keyword_overview left blank
  const noIntent = top.filter((k) => !kws.get(k)!.intent);
  if (noIntent.length) {
    for (let i = 0; i < noIntent.length; i += 1000) {
      const r = await dfs(creds, "POST", "/dataforseo_labs/google/search_intent/live", [{ keywords: noIntent.slice(i, i + 1000), language_code: "en" }]).catch((e) => { console.log(`# search_intent: ${e}`); return null; });
      for (const it of r?.[0]?.items ?? []) { const e = kws.get(norm(String(it?.keyword ?? ""))); if (e) { e.intent = String(it?.keyword_intent?.label ?? ""); e.intentP = n(it?.keyword_intent?.probability); } }
    }
  }
  // Local volumes (Google Ads, city + DMA)
  const localVol = new Map<string, { city: number | null; cityCpc: number | null; cityComp: number | null; cityTrend: string; dma: number | null; dmaTrend: string }>();
  for (const [code, key] of [[cityCode, "city"], [dmaCode, "dma"]] as const) {
    if (code == null) { console.log(`# local ${key}: location not found, skipped`); continue; }
    console.log(`# google_ads search_volume (${key} ${code}): ${top.length} keywords ≈ $${(Math.ceil(top.length / 1000) * 0.05).toFixed(2)}`);
    for (let i = 0; i < top.length; i += 1000) {
      const r = await dfs(creds, "POST", "/keywords_data/google_ads/search_volume/live", [{ keywords: top.slice(i, i + 1000), location_code: code, language_code: "en" }]).catch((e) => { console.log(`# google_ads ${key}: ${e}`); return null; });
      for (const v of r ?? []) {
        const k = norm(String(v?.keyword ?? "")); const e = localVol.get(k) ?? { city: null, cityCpc: null, cityComp: null, cityTrend: "", dma: null, dmaTrend: "" };
        if (key === "city") { e.city = n(v.search_volume); e.cityCpc = n(v.cpc); e.cityComp = n(v.competition_index); e.cityTrend = trend(v.monthly_searches); } else { e.dma = n(v.search_volume); e.dmaTrend = trend(v.monthly_searches); }
        localVol.set(k, e);
      }
    }
  }

  block("2_keywords", ["keyword", "label", "clusters", "found_via", "seeds", "volume_us", "trend_12m_us", "yoy_change_pct", "cpc_us", "competition_us_0_100", "top_of_page_bid_range", "kd", "intent", "intent_probability", "serp_features", "ai_overview", "volume_cincinnati_city", "cpc_cincinnati_city", "competition_cincinnati_city", "trend_12m_cincinnati_city", "volume_cincinnati_dma", "trend_12m_cincinnati_dma", "source", "date"]);
  const sorted = [...kws.values()].sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));
  for (const e of sorted) {
    const lv = localVol.get(e.keyword);
    row(e.keyword, label(e.keyword), [...e.clusters].join(" | "), [...e.via].join(" | "), [...e.seeds].slice(0, 3).join(" | "), e.volume, e.trend, e.delta, e.cpc, e.comp, e.lowTop, e.kd, e.intent, e.intentP, e.features.join("|"), e.aio ? "yes" : (e.features.length ? "no" : ""), lv?.city, lv?.cityCpc, lv?.cityComp, lv?.cityTrend, lv?.dma, lv?.dmaTrend, "labs/keyword_ideas+related_keywords+keyword_suggestions → labs/keyword_overview (US) · keywords_data/google_ads/search_volume (Cincinnati city, DMA)", RUN);
  }
  end();

  // ── 3. SERPs for the priority set, both locations ───────────────────────
  const fit = (k: string) => ({ Investor: 1, "Local-investor": 0.95, Informational: 0.5, Brand: 0.2, "Guest (exclude)": 0 } as Record<string, number>)[label(k)] ?? 0.3;
  const score = (e: Kw) => ((e.volume ?? 0) * fit(e.keyword)) / ((e.kd ?? 50) + 10);
  const prio = [...kws.values()].filter((e) => label(e.keyword) !== "Guest (exclude)").sort((a, b) => score(b) - score(a));
  const national = [...new Set([...Object.values(SEEDS).flat().map(norm), ...prio.slice(0, 70).map((e) => e.keyword)])].filter((k) => label(k) !== "Guest (exclude)").slice(0, 90);
  const localSet = [...new Set([...SEEDS["A Cincinnati STR management"]!, ...SEEDS["D Market and regulation"]!, ...SEEDS["G Question / AI-search"]!, ...SEEDS["F Brand"]!].map(norm).concat(prio.filter((e) => LOCAL.test(e.keyword) || MANAGE.test(e.keyword)).slice(0, 40).map((e) => e.keyword)))].slice(0, 70);
  console.log(`# live SERP advanced: ${national.length} national + ${localSet.length} Cincinnati ≈ $${((national.length + localSet.length) * 0.003).toFixed(2)}`);
  const serpLoc = cityCode ? { location_code: cityCode } : { location_name: "Cincinnati,Ohio,United States" };
  type SerpOut = { keyword: string; loc: string; features: string[]; organic: Array<{ domain: string; url: string; title: string }>; paa: string[]; aiRefs: string[]; err: string };
  async function serp(keyword: string, loc: "US" | "Cincinnati"): Promise<SerpOut> {
    const r = await dfs(creds, "POST", "/serp/google/organic/live/advanced", [{ keyword, ...(loc === "US" ? { location_code: US } : serpLoc), language_code: "en", device: "desktop", depth: 10, people_also_ask_click_depth: 1 }]).catch((e) => ({ _err: String(e) }));
    if (r?._err) return { keyword, loc, features: [], organic: [], paa: [], aiRefs: [], err: r._err };
    const items: any[] = r?.[0]?.items ?? [];
    const organic = items.filter((i) => i?.type === "organic").map((i) => ({ domain: String(i.domain ?? "").replace(/^www\./, ""), url: String(i.url ?? ""), title: String(i.title ?? "") }));
    const paa: string[] = []; for (const i of items) if (i?.type === "people_also_ask") for (const it of i.items ?? []) if (it?.title) paa.push(String(it.title));
    const ai = items.find((i) => i?.type === "ai_overview");
    const aiRefs = ai ? [...new Set((ai.references ?? ai.items?.flatMap((x: any) => x.references ?? []) ?? []).map((x: any) => hostOf(String(x?.url ?? ""))).filter(Boolean))] as string[] : [];
    return { keyword, loc, features: [...new Set(items.map((i) => String(i?.type)))].filter((t) => t !== "organic"), organic, paa, aiRefs, err: "" };
  }
  const serpN = await pool(national, 4, (k) => serp(k, "US"));
  const serpL = await pool(localSet, 4, (k) => serp(k, "Cincinnati"));
  block("3_serp", ["keyword", "location", "label", "volume_us", "volume_cincinnati_city", "kd", "local_pack", "people_also_ask", "ai_overview", "featured_snippet", "video", "paid_ads", "all_features", "top1", "top2", "top3", "top1_url", "ai_overview_cited_domains", "paa_questions", "pcc_position_top10", "source", "date"]);
  const domCount = new Map<string, { us: number; cin: number; titles: Set<string>; mgmt: number }>();
  const paaAll = new Map<string, Set<string>>();
  for (const s of [...serpN, ...serpL]) {
    const e = kws.get(s.keyword); const lv = localVol.get(s.keyword);
    const f = (t: string) => (s.features.includes(t) ? "yes" : s.err ? "" : "no");
    const pcc = s.organic.findIndex((o) => o.domain.endsWith(DOMAIN));
    row(s.keyword, s.loc, label(s.keyword), e?.volume, lv?.city, e?.kd, f("local_pack") === "yes" || s.features.includes("map") ? "yes" : f("local_pack"), f("people_also_ask"), f("ai_overview"), f("featured_snippet"), f("video"), f("paid"), s.features.join("|"), s.organic[0]?.domain, s.organic[1]?.domain, s.organic[2]?.domain, s.organic[0]?.url, s.aiRefs.join("|"), s.paa.join(" | "), pcc >= 0 ? pcc + 1 : "", s.err ? `serp/google/organic/live/advanced — ERROR ${s.err.slice(0, 80)}` : "serp/google/organic/live/advanced (desktop, depth 10)", RUN);
    s.organic.slice(0, 10).forEach((o, i) => { const d = domCount.get(o.domain) ?? { us: 0, cin: 0, titles: new Set(), mgmt: 0 }; if (s.loc === "US") d.us++; else d.cin++; if (i < 5) d.titles.add(o.title); if (MANAGE.test(s.keyword) && i < 10) d.mgmt++; domCount.set(o.domain, d); });
    for (const q of s.paa) { const set = paaAll.get(q) ?? new Set(); set.add(`${s.keyword} (${s.loc})`); paaAll.set(q, set); }
  }
  end();

  block("3b_recurring_domains", ["domain", "top10_appearances_us", "top10_appearances_cincinnati", "appearances_on_management_terms", "type", "example_title", "source", "date"]);
  const recurring = [...domCount.entries()].sort((a, b) => (b[1].us + b[1].cin) - (a[1].us + a[1].cin));
  const typeOf = (d: string) => /^(airbnb|vrbo|booking|expedia|tripadvisor|hotels|furnishedfinder)\./.test(d) ? "booking platform (guest)" : /biggerpockets|nerdwallet|forbes|investopedia|mashvisor|airdna|rabbu|reddit|quora|youtube|medium/.test(d) ? "investor education / data" : /evolve|vacasa|awning|hostaway|guesty|lodgify|hospitable|turno|pricelabs|hostfully/.test(d) ? "national STR manager / software" : /\.gov$|cincinnati-oh|hamiltoncounty|ohio\.gov|covingtonky|newportky/.test(d) ? "government" : /yelp|bbb|facebook|thumbtack|angi|google/.test(d) ? "directory / social" : /zillow|realtor|redfin|apartments/.test(d) ? "real estate portal" : "candidate local / niche site";
  for (const [d, c] of recurring.slice(0, 60)) row(d, c.us, c.cin, c.mgmt, typeOf(d), [...c.titles][0] ?? "", "derived from 3_serp top-10 organic", RUN);
  end();

  // Direct competitors: local/niche sites appearing on Cincinnati management terms
  const direct = recurring.filter(([d, c]) => !BLOCK_DOMAINS.test(d) && !d.endsWith(DOMAIN) && typeOf(d) === "candidate local / niche site" && c.cin >= 1 && (c.mgmt >= 1 || c.cin >= 3)).slice(0, 5).map(([d]) => d);
  console.log(`# direct competitors (auto): ${direct.join(", ") || "none found"}`);

  // ── 3c. Competitor + PCC domain metrics ─────────────────────────────────
  block("3c_domains", ["domain", "role", "organic_keywords_us", "est_organic_visits_mo", "keywords_top3", "keywords_top10", "backlink_rank_0_1000", "backlinks", "referring_domains", "source", "date", "note"]);
  for (const d of [DOMAIN, ...direct]) {
    const [ov, bl] = await Promise.all([
      dfs(creds, "POST", "/dataforseo_labs/google/domain_rank_overview/live", [{ target: d, location_code: US, language_code: "en" }]).then((r: any) => r?.[0]?.items?.[0]?.metrics?.organic).catch((e) => ({ _err: String(e) })),
      dfs(creds, "POST", "/backlinks/summary/live", [{ target: d, internal_list_limit: 10, backlinks_status_type: "live" }]).then((r: any) => r?.[0]).catch((e) => ({ _err: String(e) })),
    ]);
    row(d, d === DOMAIN ? "client" : "direct competitor", n(ov?.count), n(ov?.etv), n(ov?.pos_1) == null ? "" : (ov.pos_1 ?? 0) + (ov.pos_2_3 ?? 0), n(ov?.pos_1) == null ? "" : (ov.pos_1 ?? 0) + (ov.pos_2_3 ?? 0) + (ov.pos_4_10 ?? 0), n(bl?.rank), n(bl?.backlinks), n(bl?.referring_domains), "labs/domain_rank_overview (US) · backlinks/summary", RUN, [ov?._err, bl?._err].filter(Boolean).join(" ; ") || (ov == null ? "no organic data returned (domain not in Labs index)" : ""));
  }
  end();

  block("3d_ranked_keywords", ["domain", "keyword", "position", "volume_us", "kd", "intent", "url", "label", "source", "date"]);
  const pccSet = new Set<string>();
  for (const d of [DOMAIN, ...direct]) {
    const r = await dfs(creds, "POST", "/dataforseo_labs/google/ranked_keywords/live", [{ target: d, location_code: US, language_code: "en", limit: d === DOMAIN ? 500 : 200, order_by: ["keyword_data.keyword_info.search_volume,desc"] }]).catch((e) => { console.log(`# ranked_keywords ${d}: ${e}`); return null; });
    const items: any[] = r?.[0]?.items ?? [];
    if (!items.length) row(d, "(no ranked keywords returned)", "", "", "", "", "", "", "labs/ranked_keywords (US)", RUN);
    for (const it of items) { const k = norm(String(it?.keyword_data?.keyword ?? "")); if (d === DOMAIN) pccSet.add(k); row(d, k, n(it?.ranked_serp_element?.serp_item?.rank_absolute), n(it?.keyword_data?.keyword_info?.search_volume), n(it?.keyword_data?.keyword_properties?.keyword_difficulty), it?.keyword_data?.search_intent_info?.main_intent ?? "", it?.ranked_serp_element?.serp_item?.url ?? "", label(k), "labs/ranked_keywords (US)", RUN); }
  }
  end();

  block("3e_gap", ["competitor", "keyword", "competitor_position", "competitor_url", "pcc_position", "volume_us", "kd", "intent", "label", "source", "date"]);
  for (const d of direct) {
    const r = await dfs(creds, "POST", "/dataforseo_labs/google/domain_intersection/live", [{ target1: d, target2: DOMAIN, location_code: US, language_code: "en", intersections: false, limit: 150, order_by: ["keyword_data.keyword_info.search_volume,desc"] }]).catch((e) => { console.log(`# domain_intersection ${d}: ${e}`); return null; });
    const items: any[] = r?.[0]?.items ?? [];
    if (!items.length) row(d, "(no gap rows returned)", "", "", "", "", "", "", "", "labs/domain_intersection (target1=competitor, target2=pinkcashcow.com, intersections=false, US)", RUN);
    for (const it of items) { const k = norm(String(it?.keyword_data?.keyword ?? "")); row(d, k, n(it?.first_domain_serp_element?.rank_absolute), it?.first_domain_serp_element?.url ?? "", n(it?.second_domain_serp_element?.rank_absolute) ?? "", n(it?.keyword_data?.keyword_info?.search_volume), n(it?.keyword_data?.keyword_properties?.keyword_difficulty), it?.keyword_data?.search_intent_info?.main_intent ?? "", label(k), "labs/domain_intersection (US)", RUN); }
  }
  end();

  // ── 4. PAA questions ────────────────────────────────────────────────────
  block("4_paa", ["question", "appears_on_keywords", "count", "source", "date"]);
  for (const [q, set] of [...paaAll.entries()].sort((a, b) => b[1].size - a[1].size)) row(q, [...set].slice(0, 4).join(" | "), set.size, "serp/google/organic/live/advanced people_also_ask", RUN);
  end();

  // ── 5. Brand cluster incl. competitor names ─────────────────────────────
  const brandTerms = [...SEEDS["F Brand"]!];
  for (const d of direct) { const stem = d.replace(/\.(com|net|co|org|io|us)$/, ""); brandTerms.push(stem); const t = [...(domCount.get(d)?.titles ?? [])][0] ?? ""; const name = t.split(/[|\-–—:]/)[0]!.trim().toLowerCase(); if (name && name.length < 40 && name !== stem) brandTerms.push(name); }
  block("5_brand", ["keyword", "volume_us", "cpc_us", "kd", "intent", "serp_features", "volume_cincinnati_city", "source", "date"]);
  const bo = await dfs(creds, "POST", "/dataforseo_labs/google/keyword_overview/live", [{ keywords: brandTerms, location_code: US, language_code: "en", include_serp_info: true }]).catch((e) => { console.log(`# brand overview: ${e}`); return null; });
  const bl = cityCode ? await dfs(creds, "POST", "/keywords_data/google_ads/search_volume/live", [{ keywords: brandTerms, location_code: cityCode, language_code: "en" }]).catch((e) => { console.log(`# brand local: ${e}`); return null; }) : null;
  const bmap = new Map<string, any>(); for (const it of bo?.[0]?.items ?? []) bmap.set(norm(String(it.keyword)), it);
  const blmap = new Map<string, any>(); for (const it of bl ?? []) blmap.set(norm(String(it.keyword)), it);
  for (const t of [...new Set(brandTerms.map(norm))]) { const it = bmap.get(t); row(t, n(it?.keyword_info?.search_volume), n(it?.keyword_info?.cpc), n(it?.keyword_properties?.keyword_difficulty), it?.search_intent_info?.main_intent ?? "", (it?.serp_info?.serp_item_types ?? []).join("|"), n(blmap.get(t)?.search_volume), "labs/keyword_overview (US) · google_ads/search_volume (Cincinnati city)", RUN); }
  end();

  // ── 9. Spend ────────────────────────────────────────────────────────────
  block("9_spend", ["endpoint", "calls", "errors", "cost_usd", "date"]);
  let total = 0; for (const [p, s] of Object.entries(spend)) { row(p, s.calls, s.errors, s.cost.toFixed(4), RUN); total += s.cost; }
  row("TOTAL", Object.values(spend).reduce((a, s) => a + s.calls, 0), Object.values(spend).reduce((a, s) => a + s.errors, 0), total.toFixed(4), RUN);
  end();
  console.log(`\nPCC RESEARCH DONE · total DataForSEO spend $${total.toFixed(4)}`);
}

// ── PART B: competitor pass with a hand-checked list, full local top-10s, DMA volumes ──
const BRAND_SAFE = (t: string) => t.replace(/[^a-z0-9 ]/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
async function partB(creds: DfsCreds) {
  console.log(`\nRUN ${RUN} · PCC research · PART B · DataForSEO · read-only`);
  const handList = (process.env.COMPETITORS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const national = (process.env.NATIONAL ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

  block("0b_locations_matching_cincinnati", ["location_name", "location_code", "location_type", "source", "date"]);
  const locs: any[] = await dfs(creds, "GET", "/keywords_data/google_ads/locations/us").catch((e) => { console.log(`# locations error: ${e}`); return []; });
  const matches = locs.filter((l) => /cincinnati/i.test(String(l.location_name)));
  for (const l of matches) row(l.location_name, l.location_code, l.location_type, "keywords_data/google_ads/locations/us", RUN);
  end();
  const dma = matches.find((l) => /dma/i.test(String(l.location_type)));
  const city = matches.find((l) => /^Cincinnati,Ohio,United States$/i.test(String(l.location_name)) && /city/i.test(String(l.location_type)));
  const cityCode = n(city?.location_code) ?? 1023626;

  // DMA volumes for the filtered keyword list
  const fs = await import("node:fs");
  const kwList = fs.existsSync("data/pcc-keywords.txt") ? fs.readFileSync("data/pcc-keywords.txt", "utf8").split("\n").map(norm).filter(Boolean) : [];
  block("2c_dma_volumes", ["keyword", "volume_cincinnati_dma", "cpc_cincinnati_dma", "competition_cincinnati_dma", "trend_12m_cincinnati_dma", "dma_location", "source", "date"]);
  if (!dma) { row("(no DMA-type location containing 'Cincinnati' in DataForSEO's Google Ads location list — DMA volumes not available)", "", "", "", "", "", "keywords_data/google_ads/locations/us", RUN); }
  else {
    console.log(`# google_ads search_volume (DMA ${dma.location_code}): ${kwList.length} keywords ≈ $${(Math.ceil(kwList.length / 1000) * 0.05).toFixed(2)}`);
    for (let i = 0; i < kwList.length; i += 1000) {
      const r = await dfs(creds, "POST", "/keywords_data/google_ads/search_volume/live", [{ keywords: kwList.slice(i, i + 1000), location_code: dma.location_code, language_code: "en" }]).catch((e) => { console.log(`# google_ads dma: ${e}`); return null; });
      for (const v of r ?? []) row(norm(String(v?.keyword ?? "")), n(v.search_volume), n(v.cpc), n(v.competition_index), trend(v.monthly_searches), dma.location_name, "keywords_data/google_ads/search_volume (DMA)", RUN);
    }
  }
  end();

  // Full top-10 SERPs, Cincinnati + national, for the management / question terms
  const localTerms = ["short term rental management cincinnati", "airbnb management cincinnati", "airbnb property management cincinnati", "vacation rental property manager cincinnati", "furnished rental management cincinnati", "mid term rental management cincinnati", "str management company cincinnati", "airbnb co-host cincinnati", "airbnb property manager cincinnati ohio", "short term rental property management cincinnati ohio", "vacation rental management cincinnati", "who manages airbnbs in cincinnati", "cincinnati short term rental regulations", "cincinnati airbnb permit", "best neighborhoods for airbnb cincinnati", "is cincinnati a good airbnb market", "airbnb investment property cincinnati", "turnkey airbnb cincinnati"];
  const natTerms = ["airbnb management company", "short term rental management company", "airbnb property management", "how to invest in airbnb out of state", "out of state airbnb investor", "short term rental tax loophole", "airbnb management fees", "design and furnish short term rental", "airbnb furnishing service"];
  console.log(`# live SERP advanced: ${localTerms.length} Cincinnati + ${natTerms.length} national ≈ $${((localTerms.length + natTerms.length) * 0.003).toFixed(2)}`);
  block("3g_serp_top10", ["keyword", "location", "position", "domain", "url", "title", "serp_features", "paa_questions", "ai_overview_cited_domains", "source", "date"]);
  const domCount = new Map<string, { local: number; nat: number; titles: string[]; bestPos: number }>();
  const BLOCK = /^(airbnb|vrbo|booking|expedia|tripadvisor|hotels|yelp|m\.yelp|bbb|facebook|instagram|linkedin|youtube|reddit|biggerpockets|google|wikipedia|zillow|realtor|redfin|trulia|apartments|furnishedfinder|craigslist|indeed|glassdoor|nerdwallet|forbes|investopedia|irs|quora|medium|thumbtack|angi|homeadvisor|mapquest|yellowpages|marriott|hilton|hyatt|scholar\.google|play\.google|cincinnati-oh|hamiltoncountyohio|wvxu|wcpo|local12|cincinnati\.com|bizjournals|fox19|wlwt|airdna|mashvisor|rabbu|hostaway|guesty|lodgify|hospitable|turno|pricelabs|hello\.pricelabs|hostfully|awning|evolve|vacasa|redawning|airbtics|onefinebnb|guestable|homeguide|cincinnatireia|revenuebase|staywithdave|hosttools|avantstay|furnishgreen|homeriver|allpropertymanagement|therealdeal|ownerdirect|greystar|pinkcashcow)\./i;
  const MGMT_TITLE = /airbnb|short[- ]term|vacation rental|\bstr\b|host|bnb|rental management|property management|furnished|co-?host/i;
  async function serp10(keyword: string, loc: "US" | "Cincinnati") {
    const r = await dfs(creds, "POST", "/serp/google/organic/live/advanced", [{ keyword, ...(loc === "US" ? { location_code: US } : { location_code: cityCode }), language_code: "en", device: "desktop", depth: 10, people_also_ask_click_depth: 1 }]).catch((e) => ({ _err: String(e) }));
    if (r?._err) { row(keyword, loc, "", "", "", "", `ERROR ${r._err.slice(0, 100)}`, "", "", "serp/google/organic/live/advanced", RUN); return; }
    const items: any[] = r?.[0]?.items ?? [];
    const feats = [...new Set(items.map((i) => String(i?.type)))].filter((t) => t !== "organic").join("|");
    const paa: string[] = []; for (const i of items) if (i?.type === "people_also_ask") for (const it of i.items ?? []) if (it?.title) paa.push(String(it.title));
    const ai = items.find((i) => i?.type === "ai_overview");
    const aiRefs = ai ? [...new Set((ai.references ?? ai.items?.flatMap((x: any) => x.references ?? []) ?? []).map((x: any) => hostOf(String(x?.url ?? ""))).filter(Boolean))] as string[] : [];
    const organic = items.filter((i) => i?.type === "organic").slice(0, 10);
    organic.forEach((i, idx) => {
      const d = String(i.domain ?? "").replace(/^www\./, ""); const t = String(i.title ?? "");
      row(keyword, loc, idx + 1, d, i.url ?? "", t, idx === 0 ? feats : "", idx === 0 ? paa.join(" | ") : "", idx === 0 ? aiRefs.join("|") : "", "serp/google/organic/live/advanced (desktop, depth 10)", RUN);
      const c = domCount.get(d) ?? { local: 0, nat: 0, titles: [], bestPos: 99 };
      if (loc === "Cincinnati") c.local++; else c.nat++; c.titles.push(t); c.bestPos = Math.min(c.bestPos, idx + 1); domCount.set(d, c);
    });
    if (!organic.length) row(keyword, loc, "", "(no organic results returned)", "", "", feats, paa.join(" | "), aiRefs.join("|"), "serp/google/organic/live/advanced", RUN);
  }
  for (const k of localTerms) await serp10(k, "Cincinnati");
  for (const k of natTerms) await serp10(k, "US");
  end();

  block("3h_competitor_candidates", ["domain", "cincinnati_top10_appearances", "national_top10_appearances", "best_position", "management_title", "example_title", "picked", "source", "date"]);
  const cands = [...domCount.entries()].filter(([d, c]) => !BLOCK.test(d) && !d.endsWith(DOMAIN)).map(([d, c]) => ({ d, c, mgmt: c.titles.some((t) => MGMT_TITLE.test(t)) })).sort((a, b) => (b.c.local - a.c.local) || (a.c.bestPos - b.c.bestPos));
  const auto = cands.filter((x) => x.mgmt && x.c.local >= 1).map((x) => x.d);
  const direct = [...new Set([...handList, ...auto])].slice(0, 6);
  for (const x of cands.slice(0, 40)) row(x.d, x.c.local, x.c.nat, x.c.bestPos, x.mgmt ? "yes" : "no", x.c.titles[0]?.slice(0, 90) ?? "", direct.includes(x.d) ? "yes" : "", "derived from 3g_serp_top10", RUN);
  for (const d of handList) if (!cands.some((x) => x.d === d)) row(d, 0, 0, "", "", "(hand-listed; not in these top-10s)", "yes", "COMPETITORS env", RUN);
  end();
  console.log(`# direct competitors: ${direct.join(", ")} · national comparison: ${national.join(", ")}`);

  block("3c_domains", ["domain", "role", "organic_keywords_us", "est_organic_visits_mo", "keywords_top3", "keywords_top10", "backlink_rank_0_1000", "backlinks", "referring_domains", "source", "date", "note"]);
  for (const d of [DOMAIN, ...direct, ...national]) {
    const [ov, bl] = await Promise.all([
      dfs(creds, "POST", "/dataforseo_labs/google/domain_rank_overview/live", [{ target: d, location_code: US, language_code: "en" }]).then((r: any) => r?.[0]?.items?.[0]?.metrics?.organic).catch((e) => ({ _err: String(e) })),
      dfs(creds, "POST", "/backlinks/summary/live", [{ target: d, internal_list_limit: 10, backlinks_status_type: "live" }]).then((r: any) => r?.[0]).catch((e) => ({ _err: String(e) })),
    ]);
    row(d, d === DOMAIN ? "client" : national.includes(d) ? "national STR manager (comparison)" : "direct competitor", n(ov?.count), n(ov?.etv), n(ov?.pos_1) == null ? "" : (ov.pos_1 ?? 0) + (ov.pos_2_3 ?? 0), n(ov?.pos_1) == null ? "" : (ov.pos_1 ?? 0) + (ov.pos_2_3 ?? 0) + (ov.pos_4_10 ?? 0), n(bl?.rank), n(bl?.backlinks), n(bl?.referring_domains), "labs/domain_rank_overview (US) · backlinks/summary", RUN, [ov?._err, bl?._err].filter(Boolean).join(" ; ") || (ov == null ? "no organic data returned (domain not in Labs index)" : ""));
  }
  end();

  block("3d_ranked_keywords", ["domain", "keyword", "position", "volume_us", "kd", "intent", "url", "label", "source", "date"]);
  for (const d of [DOMAIN, ...direct]) {
    const r = await dfs(creds, "POST", "/dataforseo_labs/google/ranked_keywords/live", [{ target: d, location_code: US, language_code: "en", limit: d === DOMAIN ? 500 : 300, order_by: ["keyword_data.keyword_info.search_volume,desc"] }]).catch((e) => { console.log(`# ranked_keywords ${d}: ${e}`); return null; });
    const items: any[] = r?.[0]?.items ?? [];
    if (!items.length) row(d, "(no ranked keywords returned)", "", "", "", "", "", "", "labs/ranked_keywords (US)", RUN);
    for (const it of items) { const k = norm(String(it?.keyword_data?.keyword ?? "")); row(d, k, n(it?.ranked_serp_element?.serp_item?.rank_absolute), n(it?.keyword_data?.keyword_info?.search_volume), n(it?.keyword_data?.keyword_properties?.keyword_difficulty), it?.keyword_data?.search_intent_info?.main_intent ?? "", it?.ranked_serp_element?.serp_item?.url ?? "", label(k), "labs/ranked_keywords (US)", RUN); }
  }
  end();

  block("3e_gap", ["competitor", "keyword", "competitor_position", "competitor_url", "pcc_position", "volume_us", "kd", "intent", "label", "source", "date"]);
  for (const d of [...direct, ...national]) {
    const r = await dfs(creds, "POST", "/dataforseo_labs/google/domain_intersection/live", [{ target1: d, target2: DOMAIN, location_code: US, language_code: "en", intersections: false, limit: 200, order_by: ["keyword_data.keyword_info.search_volume,desc"] }]).catch((e) => { console.log(`# domain_intersection ${d}: ${e}`); return null; });
    const items: any[] = r?.[0]?.items ?? [];
    if (!items.length) row(d, "(no gap rows returned)", "", "", "", "", "", "", "", "labs/domain_intersection (target1=competitor, target2=pinkcashcow.com, intersections=false, US)", RUN);
    for (const it of items) { const k = norm(String(it?.keyword_data?.keyword ?? "")); row(d, k, n(it?.first_domain_serp_element?.rank_absolute), it?.first_domain_serp_element?.url ?? "", n(it?.second_domain_serp_element?.rank_absolute) ?? "", n(it?.keyword_data?.keyword_info?.search_volume), n(it?.keyword_data?.keyword_properties?.keyword_difficulty), it?.keyword_data?.search_intent_info?.main_intent ?? "", label(k), "labs/domain_intersection (US)", RUN); }
  }
  end();

  const brandTerms = [...SEEDS["F Brand"]!];
  for (const d of direct) { const stem = d.replace(/\.(com|net|co|org|io|us)$/, ""); brandTerms.push(stem); const t = domCount.get(d)?.titles[0] ?? ""; const name = BRAND_SAFE(t.split(/[|\-–—:]/)[0] ?? ""); if (name && name.length < 40 && name !== stem) brandTerms.push(name); }
  const bt = [...new Set(brandTerms.map(BRAND_SAFE).filter(Boolean))];
  block("5_brand", ["keyword", "volume_us", "cpc_us", "kd", "intent", "serp_features", "volume_cincinnati_city", "source", "date"]);
  const bo = await dfs(creds, "POST", "/dataforseo_labs/google/keyword_overview/live", [{ keywords: bt, location_code: US, language_code: "en", include_serp_info: true }]).catch((e) => { console.log(`# brand overview: ${e}`); return null; });
  const bl = await dfs(creds, "POST", "/keywords_data/google_ads/search_volume/live", [{ keywords: bt, location_code: cityCode, language_code: "en" }]).catch((e) => { console.log(`# brand local: ${e}`); return null; });
  const bmap = new Map<string, any>(); for (const it of bo?.[0]?.items ?? []) bmap.set(norm(String(it.keyword)), it);
  const blmap = new Map<string, any>(); for (const it of bl ?? []) blmap.set(norm(String(it.keyword)), it);
  for (const t of bt) { const it = bmap.get(t); row(t, n(it?.keyword_info?.search_volume), n(it?.keyword_info?.cpc), n(it?.keyword_properties?.keyword_difficulty), it?.search_intent_info?.main_intent ?? "", (it?.serp_info?.serp_item_types ?? []).join("|"), n(blmap.get(t)?.search_volume), "labs/keyword_overview (US) · google_ads/search_volume (Cincinnati city)", RUN); }
  end();

  block("9_spend", ["endpoint", "calls", "errors", "cost_usd", "date"]);
  let total = 0; for (const [p, s] of Object.entries(spend)) { row(p, s.calls, s.errors, s.cost.toFixed(4), RUN); total += s.cost; }
  row("TOTAL (part B)", Object.values(spend).reduce((a, s) => a + s.calls, 0), Object.values(spend).reduce((a, s) => a + s.errors, 0), total.toFixed(4), RUN);
  end();
  console.log(`\nPCC RESEARCH PART B DONE · spend $${total.toFixed(4)}`);
}

// ── PART C: Google Ads (Keyword Planner) data — US volumes for the filtered list, and Google's own
// geo-aware idea expansion for the core seeds at US and Cincinnati. Labs' database misses long-tail
// local phrases; this is the honest second source before calling a term "no volume".
async function partC(creds: DfsCreds) {
  console.log(`\nRUN ${RUN} · PCC research · PART C · DataForSEO Google Ads · read-only`);
  const fs = await import("node:fs");
  const kwList = [...new Set([...(fs.existsSync("data/pcc-keywords.txt") ? fs.readFileSync("data/pcc-keywords.txt", "utf8").split("\n") : []), ...Object.values(SEEDS).flat()].map(norm).filter(Boolean))];
  const cityCode = 1023626;
  block("2d_google_ads_us", ["keyword", "volume_us_google_ads", "cpc_us_google_ads", "competition_us_google_ads", "low_top_of_page_bid", "high_top_of_page_bid", "trend_12m_us_google_ads", "source", "date"]);
  console.log(`# google_ads search_volume (US): ${kwList.length} keywords ≈ $${(Math.ceil(kwList.length / 1000) * 0.05).toFixed(2)}`);
  for (let i = 0; i < kwList.length; i += 1000) {
    const r = await dfs(creds, "POST", "/keywords_data/google_ads/search_volume/live", [{ keywords: kwList.slice(i, i + 1000), location_code: US, language_code: "en" }]).catch((e) => { console.log(`# google_ads us: ${e}`); return null; });
    for (const v of r ?? []) row(norm(String(v?.keyword ?? "")), n(v.search_volume), n(v.cpc), n(v.competition_index), n(v.low_top_of_page_bid), n(v.high_top_of_page_bid), trend(v.monthly_searches), "keywords_data/google_ads/search_volume (US 2840)", RUN);
  }
  end();
  const groups: Array<[string, string[]]> = [
    ["A Cincinnati STR management", SEEDS["A Cincinnati STR management"]!],
    ["B Out-of-state investor", SEEDS["B Out-of-state investor"]!],
    ["D Market and regulation", SEEDS["D Market and regulation"]!.slice(0, 20)],
    ["E Services", SEEDS["E Services"]!],
    ["G Question / AI-search", SEEDS["G Question / AI-search"]!],
  ];
  block("2e_keyword_planner_ideas", ["seed_cluster", "location", "keyword", "volume", "cpc", "competition", "trend_12m", "label", "source", "date"]);
  console.log(`# google_ads keywords_for_keywords: ${groups.length} clusters × 2 locations ≈ $${(groups.length * 2 * 0.05).toFixed(2)}`);
  for (const [c, seeds] of groups) for (const [loc, code] of [["US", US], ["Cincinnati", cityCode]] as const) {
    const r = await dfs(creds, "POST", "/keywords_data/google_ads/keywords_for_keywords/live", [{ keywords: seeds.slice(0, 20), location_code: code, language_code: "en", sort_by: "search_volume", include_adult_keywords: false }]).catch((e) => { console.log(`# keywords_for_keywords ${c} ${loc}: ${e}`); return null; });
    let kept = 0;
    for (const v of r ?? []) {
      const k = norm(String(v?.keyword ?? "")); if (!k || JUNK.test(k)) continue;
      if (!/airbnb|vrbo|short[- ]?term|\bstr\b|mid[- ]?term|vacation rental|furnish|co-?host|bnb|property manag|rental propert|investment propert|cost seg|loophole|cash ?flow|turnkey|out of state|remote|passive|cincinnati|ohio|host|regulation|permit|ordinance|license|neighborhood|invest/i.test(k)) continue;
      row(c, loc, k, n(v.search_volume), n(v.cpc), n(v.competition_index), trend(v.monthly_searches), label(k), "keywords_data/google_ads/keywords_for_keywords", RUN); kept++;
    }
    console.log(`# ${c} ${loc}: ${(r ?? []).length} ideas, ${kept} relevant`);
  }
  end();
  block("9_spend", ["endpoint", "calls", "errors", "cost_usd", "date"]);
  let total = 0; for (const [p, s] of Object.entries(spend)) { row(p, s.calls, s.errors, s.cost.toFixed(4), RUN); total += s.cost; }
  row("TOTAL (part C)", Object.values(spend).reduce((a, s) => a + s.calls, 0), Object.values(spend).reduce((a, s) => a + s.errors, 0), total.toFixed(4), RUN);
  end();
  console.log(`\nPCC RESEARCH PART C DONE · spend $${total.toFixed(4)}`);
}

const PART = (process.env.PART ?? "all").toLowerCase();
(PART === "b" ? partB(credsFromEnv()) : PART === "c" ? partC(credsFromEnv()) : main()).catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

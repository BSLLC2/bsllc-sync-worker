#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, type DfsCreds } from "./dataforseo.js";

/**
 * READ-ONLY research pull for the Integrus Partners strategy deck.
 * DataForSEO only (Semrush is out of units). Every number printed carries its
 * endpoint and the run date; nothing is estimated here — gaps print as "n/a".
 *
 * PART=a → 1 baseline · 2 keyword clusters · 3 competitor gap · 6 referral map
 * PART=b → 4 AI answers (AEO) · 5 backlinks & listings
 *
 * Output is CSV blocks between "### CSV name" / "### END" markers so the
 * sections can be split into sheet tabs without re-typing anything.
 */

const DOMAIN = "integruspartners.com";
const RUN = new Date().toISOString().slice(0, 10);
const COMPETITORS = ["physiciangrowthpartners.com", "providenthp.com", "skytale.com", "skytalegroup.com", "practicetransitionsgroup.com", "agendahealth.com", "largepracticesales.com", "ackerman-group.com", "transitionselite.com", "forgedadvisor.com"];
const SELLER_RX = /sell|selling|sale|valuation|worth|multiple|ebitda|broker|advisor|advisory|private equity|\bpe\b|dso|consolidat|acqui|buyer|offer|rollover|earnout|\bloi\b|diligence|exit|transition|partner/i;
const JUNK_RX = /job|career|salary|login|near me hiring|resume|school|course|student/i;

// ── 2. Keyword clusters ───────────────────────────────────────────────────
type KwDef = { vertical: string; cluster: string; keyword: string };
const K: KwDef[] = [];
const add = (vertical: string, cluster: string, list: string[]) => list.forEach((keyword) => K.push({ vertical, cluster, keyword }));
add("Veterinary", "Offer review", ["corporate offer for my veterinary practice", "selling veterinary practice to corporate group", "should i sell my vet practice to a corporate", "selling veterinary practice to private equity", "veterinary consolidator offer", "letter of intent veterinary practice sale", "rollover equity veterinary practice", "earnout veterinary practice sale"]);
add("Veterinary", "Value", ["what is my vet practice worth", "what is my veterinary practice worth", "veterinary practice valuation", "vet practice valuation", "veterinary practice ebitda multiples", "veterinary practice valuation calculator", "how much is a veterinary practice worth"]);
add("Veterinary", "Process", ["how to sell a veterinary practice", "how long does it take to sell a veterinary practice", "preparing veterinary practice for sale", "selling a veterinary practice checklist", "veterinary practice exit strategy", "selling a veterinary practice"]);
add("Veterinary", "Sell / for sale", ["sell my veterinary practice", "sell veterinary practice", "sell vet practice", "veterinary practice for sale", "veterinary practice broker", "veterinary practice sales"]);
add("Dental", "Offer review", ["dso offer", "dso offer review", "should i accept a dso offer", "dso letter of intent", "selling to a dso", "dso vs private buyer", "selling dental practice to private equity", "rollover equity dental practice", "earnout dental practice sale", "dso offer for my practice"]);
add("Dental", "Value", ["what is my dental practice worth", "dental practice valuation", "dental practice ebitda multiples", "dental practice valuation calculator", "how much is my dental practice worth", "dental practice appraisal"]);
add("Dental", "Process", ["how to sell a dental practice", "how long does it take to sell a dental practice", "preparing dental practice for sale", "selling a dental practice checklist", "selling a dental practice"]);
add("Dental", "Sell / for sale", ["sell my dental practice", "sell dental practice", "dental practice for sale", "dental practice broker", "dental practice transitions", "dental practice brokers near me"]);
add("HVAC", "Offer review", ["offer to buy my hvac business", "selling hvac business to private equity", "private equity hvac", "private equity buying hvac companies", "rollover equity hvac", "hvac business letter of intent"]);
add("HVAC", "Value", ["hvac business valuation", "how much is my hvac business worth", "hvac ebitda multiples", "hvac business valuation calculator", "hvac company valuation", "hvac business valuation multiples"]);
add("HVAC", "Process", ["how to sell an hvac business", "preparing hvac business for sale", "how long does it take to sell an hvac business", "selling an hvac business"]);
add("HVAC", "Sell / for sale", ["sell my hvac business", "sell hvac company", "hvac business broker", "hvac company for sale", "sell hvac business"]);
add("Cross-vertical", "Offer review", ["rollover equity", "what is rollover equity", "earnout", "letter of intent to sell a business", "selling to private equity", "should i accept an offer for my business", "private equity offer for my business", "unsolicited offer to buy my business", "selling my practice to private equity"]);

// ── 6. Referral map seed queries ──────────────────────────────────────────
const REFERRAL_QUERIES = ["dental cpa selling practice tax", "selling a dental practice tax implications", "veterinary cpa selling practice", "dental practice sale attorney", "veterinary practice sale attorney", "evaluating a dso offer", "selling your veterinary practice to a corporate buyer", "dso offer what to look for", "dental practice sale consultant", "veterinary practice sale consultant"];
const BROKER_HINT = /transition|broker|practicesales|practice-sales|forsale|for-sale|bizbuysell|listings|appraisal|valuations?\b/i;

// ── 4. AEO ────────────────────────────────────────────────────────────────
const AEO_QUESTIONS = ["How do I sell my veterinary practice?", "Should I accept a DSO offer for my dental practice?", "What is my vet practice worth?", "Best sell-side M&A advisor for veterinary practices", "Best M&A advisors in Dallas for healthcare practices", "Who is Integrus Partners?"];
const AEO_PROVIDERS = ["chat_gpt", "perplexity", "gemini", "claude"];
// ── 5. Directories to check for a listing (site: search) ──────────────────
const DIRECTORIES = ["axial.net", "privateequityinfo.com", "findexitadvisors.com", "pitchbook.com", "crunchbase.com", "ibba.org", "amaaonline.com", "mergersandacquisitions.net", "clutch.co", "expertise.com"];
// ── 5c. Trade publications / associations — authority only; programs must be verified by a person ──
const TRADE = ["vetpartners.org", "vhma.org", "avma.org", "dvm360.com", "todaysveterinarybusiness.com", "aaha.org", "veterinarypracticenews.com", "dentaleconomics.com", "adcpa.org", "ada.org", "dentistrytoday.com", "dentaltown.com", "beckersdental.com", "groupdentistrynow.com", "thedentalceo.com", "achrnews.com", "contractingbusiness.com", "hvacrbusiness.com", "acca.org", "phcppros.com"];

// ── helpers ───────────────────────────────────────────────────────────────
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const csv = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const row = (...cells: unknown[]) => console.log(cells.map(csv).join(","));
const block = (name: string, header: string[]) => { console.log(`\n### CSV ${name}`); row(...header); };
const end = () => console.log("### END");
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const clean = (d: string) => d.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };

async function dfs(creds: DfsCreds, method: "POST" | "GET", path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, { method, headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const j: any = await res.json();
  const t = j?.tasks?.[0];
  if (!t || t.status_code !== 20000) throw new Error(`${path}: ${t?.status_message ?? "no task"}`);
  return t.result;
}
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}
function urlsIn(x: any, acc = new Set<string>()): Set<string> {
  if (typeof x === "string") { for (const m of x.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) acc.add(m[0].replace(/[.,;]+$/, "")); }
  else if (Array.isArray(x)) x.forEach((y) => urlsIn(y, acc));
  else if (x && typeof x === "object") Object.values(x).forEach((y) => urlsIn(y, acc));
  return acc;
}
function textIn(x: any, acc: string[] = []): string[] {
  if (typeof x === "string") { if (x.length > 40 && !/^https?:/.test(x)) acc.push(x); }
  else if (Array.isArray(x)) x.forEach((y) => textIn(y, acc));
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) if (!/url|link|domain|source/i.test(k)) textIn(v, acc);
  return acc;
}

async function authority(creds: DfsCreds, domain: string) {
  const [bl, ov] = await Promise.all([
    dfs(creds, "POST", "/backlinks/summary/live", [{ target: domain, internal_list_limit: 10, backlinks_status_type: "live" }]).then((r: any) => r?.[0]).catch((e) => ({ _err: String(e) })),
    dfs(creds, "POST", "/dataforseo_labs/google/domain_rank_overview/live", [{ target: domain, location_name: "United States", language_name: "English" }]).then((r: any) => r?.[0]?.items?.[0]?.metrics?.organic).catch((e) => ({ _err: String(e) })),
  ]);
  return { rank: n(bl?.rank), backlinks: n(bl?.backlinks), refdoms: n(bl?.referring_domains), kw: n(ov?.count), etv: n(ov?.etv), top10: n(ov?.pos_1) == null ? null : (n(ov?.pos_1) ?? 0) + (n(ov?.pos_2_3) ?? 0) + (n(ov?.pos_4_10) ?? 0), err: bl?._err || ov?._err || "" };
}
type RankedRow = { keyword: string; volume: number | null; kd: number | null; rank: number | null; url: string };
async function ranked(creds: DfsCreds, domain: string, limit: number): Promise<RankedRow[]> {
  const r = await dfs(creds, "POST", "/dataforseo_labs/google/ranked_keywords/live", [{ target: domain, location_name: "United States", language_name: "English", limit, order_by: ["keyword_data.keyword_info.search_volume,desc"] }]);
  return (r?.[0]?.items ?? []).map((it: any) => ({ keyword: String(it?.keyword_data?.keyword ?? ""), volume: n(it?.keyword_data?.keyword_info?.search_volume), kd: n(it?.keyword_data?.keyword_properties?.keyword_difficulty), rank: n(it?.ranked_serp_element?.serp_item?.rank_absolute), url: String(it?.ranked_serp_element?.serp_item?.url ?? "") }));
}
async function serp(creds: DfsCreds, keyword: string, depth = 10) {
  const r = await dfs(creds, "POST", "/serp/google/organic/live/advanced", [{ keyword, location_name: "United States", language_name: "English", device: "desktop", depth }]);
  const items: any[] = r?.[0]?.items ?? [];
  const organic = items.filter((i) => i?.type === "organic").map((i) => ({ domain: String(i.domain ?? "").replace(/^www\./, ""), url: String(i.url ?? ""), title: String(i.title ?? "") }));
  const ai = items.find((i) => i?.type === "ai_overview");
  const aiRefs = ai ? [...urlsIn(ai)].filter((u) => !/google\.com/.test(u)) : [];
  const aiText = ai ? textIn(ai).join(" ").slice(0, 1200) : "";
  return { organic, hasAi: !!ai, aiRefs, aiText, paid: items.filter((i) => i?.type === "paid").map((i) => String(i.domain ?? "")), features: [...new Set(items.map((i) => String(i?.type)))] };
}
async function metrics(creds: DfsCreds, keywords: string[]) {
  const list = [...new Set(keywords.map(norm))];
  const [vol, kd, intent] = await Promise.all([
    dfs(creds, "POST", "/keywords_data/google_ads/search_volume/live", [{ keywords: list, location_name: "United States", language_name: "English" }]).catch((e) => { console.log(`# volume error: ${e}`); return []; }),
    dfs(creds, "POST", "/dataforseo_labs/google/bulk_keyword_difficulty/live", [{ keywords: list, location_name: "United States", language_name: "English" }]).then((r: any) => r?.[0]?.items ?? []).catch((e) => { console.log(`# kd error: ${e}`); return []; }),
    dfs(creds, "POST", "/dataforseo_labs/google/search_intent/live", [{ keywords: list, language_name: "English" }]).then((r: any) => r?.[0]?.items ?? []).catch((e) => { console.log(`# intent error: ${e}`); return []; }),
  ]);
  const m = new Map<string, { volume: number | null; cpc: number | null; comp: number | null; kd: number | null; intent: string; intentP: number | null }>();
  for (const k of list) m.set(k, { volume: null, cpc: null, comp: null, kd: null, intent: "", intentP: null });
  for (const v of vol ?? []) { const e = m.get(norm(String(v?.keyword ?? ""))); if (e) { e.volume = n(v.search_volume); e.cpc = n(v.cpc); e.comp = n(v.competition_index) ?? n(v.competition); } }
  for (const k of kd) { const e = m.get(norm(String(k?.keyword ?? ""))); if (e) e.kd = n(k.keyword_difficulty); }
  for (const it of intent) { const e = m.get(norm(String(it?.keyword ?? ""))); if (e) { e.intent = String(it?.keyword_intent?.label ?? ""); e.intentP = n(it?.keyword_intent?.probability); } }
  return m;
}
const TYPE_RULES: Array<[RegExp, string]> = [
  [/cpa|accounting|tax|advisors?cpa|wealth|financial|bank\b|capital|\bllp\b/i, "CPA / financial"],
  [/law|legal|attorney|\bllp\b|esq|counsel/i, "law firm"],
  [/podcast|\.fm$|spotify|apple\.com|buzzsprout|libsyn|podbean/i, "podcast"],
  [/directory|listing|yellowpages|yelp|clutch|expertise\.com|findexit|axial|pitchbook|crunchbase|dealstream|bizbuysell|zoominfo|manta|bbb\.org|chamber/i, "directory"],
  [/association|assoc|\.org$|society|academy|council|institute|avma|aaha|vhma|vetpartners|ada\.org|adcpa|acca/i, "association"],
  [/news|magazine|journal|times|post|review|economics|today|press|media|publication|becker|dvm360|dentaltown|insider/i, "publication"],
  [/transition|broker|practicesales|for-?sale|appraisal|valuation/i, "broker / transitions"],
];
const typeOf = (d: string, title = "") => TYPE_RULES.find(([rx]) => rx.test(d) || rx.test(title))?.[1] ?? "other";

async function partA(creds: DfsCreds) {
  console.log(`\nRUN ${RUN} · PART A · DataForSEO · US / English · read-only`);

  // 1. Baseline
  block("1a_baseline", ["domain", "backlink_rank_0_1000", "backlinks", "referring_domains", "organic_keywords", "est_organic_visits_mo", "keywords_top10", "source", "date", "note"]);
  const a = await authority(creds, DOMAIN);
  row(DOMAIN, a.rank, a.backlinks, a.refdoms, a.kw, a.etv, a.top10, "DataForSEO backlinks/summary + labs/domain_rank_overview", RUN, "backlink_rank is DataForSEO's 0-1000 scale, not Semrush Authority Score; est_organic_visits = Labs ETV (model)");
  end();
  block("1b_top_keywords", ["keyword", "position", "volume", "kd", "url", "seller_intent", "source", "date"]);
  const rk = await ranked(creds, DOMAIN, 100);
  for (const r of rk.slice(0, 20)) row(r.keyword, r.rank, r.volume, r.kd, r.url, SELLER_RX.test(r.keyword) && !/integrus|integris/i.test(r.keyword) ? "yes" : "no", "labs/ranked_keywords", RUN);
  end();
  const brandKws = ["integrus partners", "integris partners", "integrus", "integrus partners dallas", "integrus partners m&a", "integris partners denver"];
  const bm = await metrics(creds, brandKws);
  block("1c_brand", ["keyword", "volume", "cpc", "kd", "intent", "serp_pos", "domain", "title", "source", "date"]);
  for (const kw of brandKws.slice(0, 4)) {
    const m = bm.get(norm(kw))!;
    try { const s = await serp(creds, kw); s.organic.slice(0, 8).forEach((o, i) => row(kw, m.volume, m.cpc, m.kd, m.intent, i + 1, o.domain, o.title.slice(0, 80), "google_ads/search_volume + serp/live", RUN)); if (!s.organic.length) row(kw, m.volume, m.cpc, m.kd, m.intent, "", "", "(no organic results returned)", "serp/live", RUN); }
    catch (e) { row(kw, m.volume, m.cpc, m.kd, m.intent, "", "", `error: ${e}`, "", RUN); }
  }
  end();

  // 2. Keyword clusters
  const km = await metrics(creds, K.map((k) => k.keyword));
  const serps = await pool(K, 6, async (k) => { try { return await serp(creds, k.keyword); } catch (e) { return { organic: [], hasAi: false, aiRefs: [], aiText: "", paid: [], features: [`error:${String(e).slice(0, 60)}`] }; } });
  const integrusRank = new Map(rk.map((r) => [norm(r.keyword), r.rank]));
  block("2_keywords", ["vertical", "cluster", "keyword", "volume", "kd", "cpc", "competition", "intent", "intent_prob", "top1", "top2", "top3", "ai_overview", "ads", "integrus_pos", "source", "date"]);
  const scored: Array<{ k: KwDef; score: number; volume: number; kd: number; intent: string }> = [];
  K.forEach((k, i) => {
    const m = km.get(norm(k.keyword))!; const s = serps[i]!;
    const top = s.organic.slice(0, 3).map((o) => o.domain);
    row(k.vertical, k.cluster, k.keyword, m.volume, m.kd, m.cpc, m.comp, m.intent, m.intentP, top[0] ?? "", top[1] ?? "", top[2] ?? "", s.hasAi ? "yes" : "no", s.paid.length ? [...new Set(s.paid)].join("|") : "none", integrusRank.get(norm(k.keyword)) ?? "", "google_ads/search_volume + labs/bulk_keyword_difficulty + labs/search_intent + serp/live", RUN);
    const w = m.intent === "transactional" ? 1.0 : m.intent === "commercial" ? 0.9 : m.intent === "informational" ? 0.5 : 0.3;
    if ((m.volume ?? 0) > 0) scored.push({ k, score: (w * (m.volume ?? 0)) / ((m.kd ?? 50) + 10), volume: m.volume ?? 0, kd: m.kd ?? 50, intent: m.intent });
  });
  end();
  block("2b_best15", ["rank", "vertical", "cluster", "keyword", "volume", "kd", "intent", "score_intentweight_x_vol_over_kd+10", "note"]);
  scored.filter((s) => s.kd <= 35).sort((a, b) => b.score - a.score).slice(0, 15).forEach((s, i) => row(i + 1, s.k.vertical, s.k.cluster, s.k.keyword, s.volume, s.kd, s.intent, s.score.toFixed(1), "KD<=35 filter applied for a low-authority site; score is a ranking heuristic, not a forecast"));
  end();

  // 3. Competitor gap
  block("3a_competitors", ["domain", "backlink_rank_0_1000", "backlinks", "referring_domains", "organic_keywords", "est_organic_visits_mo", "keywords_top10", "source", "date", "note"]);
  const comps = await pool(COMPETITORS, 3, async (d) => ({ d, a: await authority(creds, d) }));
  for (const c of comps) row(c.d, c.a.rank, c.a.backlinks, c.a.refdoms, c.a.kw, c.a.etv, c.a.top10, "backlinks/summary + labs/domain_rank_overview", RUN, c.a.err ? `error: ${c.a.err.slice(0, 80)}` : "");
  end();
  const integrusSet = new Set((await ranked(creds, DOMAIN, 1000)).map((r) => norm(r.keyword)));
  block("3b_gap_keywords", ["competitor", "keyword", "competitor_pos", "volume", "kd", "competitor_url", "source", "date"]);
  for (const d of COMPETITORS) {
    try {
      const rs = (await ranked(creds, d, 400)).filter((r) => r.keyword && !integrusSet.has(norm(r.keyword)) && (r.rank ?? 999) <= 30 && SELLER_RX.test(r.keyword) && !JUNK_RX.test(r.keyword) && !new RegExp(d.split(".")[0]!.replace(/-/g, "\\s?"), "i").test(r.keyword));
      if (!rs.length) row(d, "(no seller-intent top-30 keywords returned)", "", "", "", "", "labs/ranked_keywords", RUN);
      rs.slice(0, 10).forEach((r) => row(d, r.keyword, r.rank, r.volume, r.kd, r.url, "labs/ranked_keywords", RUN));
    } catch (e) { row(d, `error: ${String(e).slice(0, 80)}`, "", "", "", "", "labs/ranked_keywords", RUN); }
  }
  end();

  // 6. Referral partner map
  const brokerDomains = new Set<string>();
  K.forEach((k, i) => { if (/Sell \/ for sale|Value/.test(k.cluster)) serps[i]!.organic.slice(0, 10).forEach((o) => brokerDomains.add(o.domain)); });
  const seen = new Map<string, { count: number; titles: string[]; urls: string[]; queries: string[] }>();
  const rs = await pool(REFERRAL_QUERIES, 4, async (q) => { try { return { q, s: await serp(creds, q, 20) }; } catch { return { q, s: null }; } });
  for (const { q, s } of rs) for (const o of s?.organic ?? []) { const e = seen.get(o.domain) ?? { count: 0, titles: [] as string[], urls: [] as string[], queries: [] as string[] }; e.count++; if (e.titles.length < 2) e.titles.push(o.title); if (e.urls.length < 1) e.urls.push(o.url); e.queries.push(q); seen.set(o.domain, e); }
  const cands = [...seen.entries()].filter(([d]) => !/reddit|youtube|facebook|linkedin|quora|instagram|tiktok|google\./.test(d)).sort((a, b) => b[1].count - a[1].count).slice(0, 40);
  const auths = await pool(cands, 4, async ([d]) => { try { const r = (await dfs(creds, "POST", "/backlinks/summary/live", [{ target: d, internal_list_limit: 10, backlinks_status_type: "live" }]))?.[0]; return { d, rank: n(r?.rank), refdoms: n(r?.referring_domains) }; } catch { return { d, rank: null, refdoms: null }; } });
  const authMap = new Map(auths.map((x) => [x.d, x]));
  block("6_referral_map", ["domain", "type_auto", "serp_appearances_in_10_queries", "backlink_rank_0_1000", "referring_domains", "example_url", "example_title", "possible_conflict", "queries", "source", "date"]);
  for (const [d, e] of cands) {
    const t = typeOf(d, e.titles.join(" "));
    const conflict = brokerDomains.has(d) || BROKER_HINT.test(d) || /valuation|appraisal|broker|for sale|transition/i.test(e.titles.join(" "));
    row(d, t, e.count, authMap.get(d)?.rank, authMap.get(d)?.refdoms, e.urls[0], e.titles[0]?.slice(0, 90), conflict ? "yes — also ranks for broker/valuation/for-sale terms or name suggests it" : "", [...new Set(e.queries)].join(" | "), "serp/live + backlinks/summary", RUN);
  }
  end();
  console.log(`\nPART A DONE`);
}

async function partB(creds: DfsCreds) {
  console.log(`\nRUN ${RUN} · PART B · DataForSEO · read-only`);

  // 4. AEO
  const models: Record<string, string> = {};
  for (const p of AEO_PROVIDERS) {
    try { const r = await dfs(creds, "GET", `/ai_optimization/${p}/llm_responses/models`); const list: any[] = Array.isArray(r) ? r : []; const names = list.map((m) => String(m?.model_name ?? m?.name ?? "")).filter(Boolean); models[p] = names.find((x) => /gpt-4\.1|gpt-4o|sonar|gemini-2\.5-flash|gemini-2\.5|claude-sonnet-4|claude-3-7|claude-3-5/.test(x)) ?? names[0] ?? ""; console.log(`# ${p} models: ${names.slice(0, 6).join(", ")}${names.length > 6 ? " …" : ""} → using ${models[p] || "n/a"}`); }
    catch (e) { console.log(`# ${p} models unavailable: ${String(e).slice(0, 120)}`); models[p] = ""; }
  }
  block("4_aeo", ["question", "engine", "model", "urls_cited", "domains_cited", "integrus_mentioned", "answer_excerpt", "source", "date"]);
  for (const q of AEO_QUESTIONS) {
    for (const p of AEO_PROVIDERS) {
      if (!models[p]) { row(q, p, "", "", "", "n/a", "provider/model not available in DataForSEO account", "ai_optimization/llm_responses", RUN); continue; }
      let result: any = null; let err = "";
      for (const body of [{ user_prompt: q, model_name: models[p], web_search: true }, { user_prompt: q, model_name: models[p] }]) {
        try { result = await dfs(creds, "POST", `/ai_optimization/${p}/llm_responses/live`, [body]); break; } catch (e) { err = String(e).slice(0, 120); }
      }
      if (!result) { row(q, p, models[p], "", "", "n/a", `error: ${err}`, "ai_optimization/llm_responses", RUN); continue; }
      const urls = [...urlsIn(result)].filter((u) => !/dataforseo/.test(u));
      const text = textIn(result).join(" ").replace(/\s+/g, " ");
      row(q, p, models[p], urls.join(" | "), [...new Set(urls.map(hostOf).filter(Boolean))].join(" | "), /integrus/i.test(text + urls.join(" ")) ? "yes" : "no", text.slice(0, 700), "ai_optimization/llm_responses/live" + (/web_search/.test(JSON.stringify(result)) ? "" : ""), RUN);
    }
    try {
      const s = await serp(creds, q);
      row(q, "google_ai_overview", "serp/live", s.aiRefs.join(" | "), [...new Set(s.aiRefs.map(hostOf).filter(Boolean))].join(" | "), s.hasAi ? (/integrus/i.test(s.aiText + s.aiRefs.join(" ")) ? "yes" : "no") : "n/a", s.hasAi ? s.aiText.slice(0, 700) : "(no AI Overview shown for this query, US desktop)", "serp/google/organic/live/advanced", RUN);
    } catch (e) { row(q, "google_ai_overview", "", "", "", "n/a", `error: ${String(e).slice(0, 100)}`, "serp/live", RUN); }
  }
  end();

  // 5a. Referring-domain intersection
  async function refdoms(d: string) {
    try { const r = await dfs(creds, "POST", "/backlinks/referring_domains/live", [{ target: d, limit: 600, order_by: ["rank,desc"], backlinks_status_type: "live", exclude_internal_backlinks: true }]); return (r?.[0]?.items ?? []).map((it: any) => ({ domain: String(it?.domain ?? ""), rank: n(it?.rank), backlinks: n(it?.backlinks) })); }
    catch (e) { console.log(`# referring_domains ${d}: ${String(e).slice(0, 100)}`); return []; }
  }
  const integrusRef = new Set((await refdoms(DOMAIN)).map((x: any) => x.domain));
  console.log(`# ${DOMAIN} referring domains pulled: ${integrusRef.size}`);
  const compRefs = await pool(COMPETITORS, 3, async (d) => ({ d, list: await refdoms(d) }));
  const agg = new Map<string, { rank: number | null; links_to: string[] }>();
  for (const { d, list } of compRefs) for (const it of list) { const e = agg.get(it.domain) ?? { rank: it.rank, links_to: [] as string[] }; if (!e.links_to.includes(d)) e.links_to.push(d); e.rank = Math.max(e.rank ?? 0, it.rank ?? 0); agg.set(it.domain, e); }
  block("5a_backlink_targets", ["referring_domain", "backlink_rank_0_1000", "links_to_n_competitors", "competitors", "links_to_integrus", "type_auto", "source", "date"]);
  const targets = [...agg.entries()].filter(([d, e]) => e.links_to.length >= 2 && !integrusRef.has(d) && !/google|facebook|linkedin|twitter|youtube|instagram|wikipedia|blogspot|wordpress\.com|\.gov$/.test(d)).sort((a, b) => (b[1].rank ?? 0) - (a[1].rank ?? 0)).slice(0, 30);
  for (const [d, e] of targets) row(d, e.rank, e.links_to.length, e.links_to.join("|"), "no", typeOf(d), "backlinks/referring_domains (top 600 by rank per competitor; 'no' = not in Integrus's live referring domains)", RUN);
  if (!targets.length) row("(none found — see # lines above for per-domain errors)", "", "", "", "", "", "", RUN);
  end();

  // 5b. Directories: is Integrus listed (indexed)?
  block("5b_directories", ["directory", "site_search_hits_for_integrus", "example_url", "integrus_has_backlink_from_it", "source", "date", "note"]);
  for (const d of DIRECTORIES) {
    try { const s = await serp(creds, `site:${d} "integrus partners"`); const hits = s.organic.filter((o) => o.domain.endsWith(d)); row(d, hits.length, hits[0]?.url ?? "", integrusRef.has(d) ? "yes" : "no", "serp/live site: search + backlinks/referring_domains", RUN, hits.length ? "" : "0 indexed pages mentioning Integrus — not listed, or listed but not indexed"); }
    catch (e) { row(d, "", "", integrusRef.has(d) ? "yes" : "no", "serp/live", RUN, `error: ${String(e).slice(0, 80)}`); }
  }
  end();

  // 5c. Trade publications / associations — authority only
  block("5c_trade_outlets", ["domain", "backlink_rank_0_1000", "referring_domains", "integrus_has_backlink", "contributor_program", "source", "date"]);
  const tr = await pool(TRADE, 4, async (d) => { try { const r = (await dfs(creds, "POST", "/backlinks/summary/live", [{ target: d, internal_list_limit: 10, backlinks_status_type: "live" }]))?.[0]; return { d, rank: n(r?.rank), refdoms: n(r?.referring_domains) }; } catch { return { d, rank: null, refdoms: null }; } });
  for (const t of tr) row(t.d, t.rank, t.refdoms, integrusRef.has(t.d) ? "yes" : "no", "NOT CHECKED BY TOOL — verify by hand", "backlinks/summary", RUN);
  end();
  console.log(`\nPART B DONE`);
}

async function main() {
  const creds = credsFromEnv();
  const part = (process.env.PART || "a").toLowerCase();
  if (part === "a") await partA(creds); else await partB(creds);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

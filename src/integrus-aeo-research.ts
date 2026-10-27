#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, type DfsCreds } from "./dataforseo.js";

/**
 * READ-ONLY research: which AI-answer questions Integrus Partners could be
 * cited for. DataForSEO AI Optimization API only. Nothing is written anywhere.
 *
 * PART=a  → steps 1-3: account balance, candidate questions (AI Keyword Data +
 *           LLM Mentions discovery), who holds each answer now (LLM Mentions),
 *           the named competitors, and a cost estimate for step 4.
 * PART=b  → step 4 over SHORTLIST (JSON array of questions): LLM Responses on
 *           ChatGPT and Claude (standard queue), Gemini and Perplexity (live,
 *           no standard queue exists for them), and Google AI Mode (standard).
 *
 * Every API response's own `cost` is summed and printed. CEILING (USD) stops
 * the run before the next paid call once the sum passes it.
 *
 * Output is CSV blocks between "### CSV name" / "### END" and JSON blocks
 * between "### JSON name" / "### END", so nothing has to be retyped.
 */

const RUN = new Date().toISOString().slice(0, 10);
const PART = (process.env.PART || "a").trim().toLowerCase();
const CEILING = Number(process.env.CEILING || "40");
const DOMAIN = "integruspartners.com";
const BRAND = "Integrus";

// ── candidates (step 2 hand list; the discovery call adds what people really ask) ──
type Cand = { q: string; tag: string; probe: string; vertical: "vet" | "general" | "dental" | "oral" | "medspa"; seeded?: boolean };
const C: Cand[] = [];
const add = (vertical: Cand["vertical"], tag: string, rows: Array<[string, string] | [string, string, true]>) =>
  rows.forEach(([q, probe, seeded]) => C.push({ q, tag, probe, vertical, seeded: seeded === true }));

add("vet", "process", [
  ["how to sell a veterinary practice", "sell veterinary practice", true],
  ["how long does it take to sell a practice", "long sell practice", true],
  ["what happens during due diligence when selling a veterinary practice", "due diligence selling practice"],
  ["what documents do I need to sell my veterinary practice", "documents sell practice"],
  ["how do I get multiple offers for my veterinary practice", "multiple offers practice"],
  ["I got an unsolicited offer for my veterinary practice, what should I do", "unsolicited offer practice"],
  ["how to negotiate a corporate offer for my veterinary practice", "negotiate offer veterinary practice"],
  ["what is a letter of intent when selling a practice", "letter of intent selling practice"],
  ["what is a working capital adjustment in a practice sale", "working capital practice sale"],
  ["what is a quality of earnings report when selling a practice", "quality of earnings practice"],
  ["should I sell my veterinary practice to an associate or a corporate group", "associate corporate veterinary"],
  ["what is a confidential information memorandum", "confidential information memorandum"],
]);
add("vet", "valuation", [
  ["how much is my veterinary practice worth", "veterinary practice worth", true],
  ["what multiple do veterinary practices sell for", "multiple veterinary practices sell"],
  ["how is a veterinary practice valued", "veterinary practice valued"],
  ["what is a good EBITDA multiple for a veterinary clinic", "ebitda multiple veterinary"],
  ["how do corporate groups value a veterinary practice", "corporate value veterinary practice"],
  ["does owning the real estate increase the value of my veterinary practice", "real estate veterinary practice value"],
  ["how do I calculate EBITDA for my veterinary practice", "ebitda veterinary practice"],
  ["are veterinary practice valuations going down", "veterinary practice valuations"],
  ["what is a veterinary practice worth per dollar of revenue", "veterinary practice revenue multiple"],
]);
add("vet", "buyers", [
  ["when should a veterinarian consider selling to private equity", "veterinarian selling private equity", true],
  ["how do I know if my practice is marketable to a private equity buyer", "marketable private equity buyer", true],
  ["what should I do before talking to a private equity buyer", "before talking private equity buyer", true],
  ["what do buyers look for in a healthcare services business", "buyers look healthcare services", true],
  ["who are the corporate buyers of veterinary practices", "corporate buyers veterinary practices"],
  ["what happens when private equity buys a veterinary practice", "private equity buys veterinary practice"],
  ["is selling to a corporate veterinary group a bad idea", "selling corporate veterinary group"],
  ["which veterinary consolidators are still buying practices", "veterinary consolidators buying"],
  ["how do private equity backed veterinary groups make money", "private equity veterinary groups"],
  ["what is the difference between selling to a corporate group and a private buyer", "corporate group private buyer"],
  ["what do corporate buyers look for in a veterinary practice", "buyers look veterinary practice"],
  ["can I keep working at my veterinary practice after I sell it", "keep working after sell practice"],
]);
add("vet", "staff", [
  ["what happens to staff when a veterinary practice is sold", "staff veterinary practice sold"],
  ["do employees keep their jobs when a veterinary practice is acquired", "employees jobs practice acquired"],
  ["how do I tell my staff I am selling the practice", "tell staff selling practice"],
  ["do staff get retention bonuses when a practice sells", "retention bonuses practice sells"],
  ["what happens to the practice name after a corporate sale", "practice name corporate sale"],
  ["will a corporate buyer change how I practice medicine", "corporate buyer practice medicine"],
  ["what happens to associate veterinarians when the practice is sold to private equity", "associate veterinarians sold private equity"],
]);
add("vet", "terms", [
  ["what is rollover equity in a veterinary practice sale", "rollover equity veterinary"],
  ["what is an earnout in a practice sale", "earnout practice sale"],
  ["is rollover equity worth it when selling a practice", "rollover equity worth"],
  ["what is a joint venture buy-in with a corporate veterinary group", "joint venture corporate veterinary"],
  ["what does a non-compete look like when selling a veterinary practice", "non-compete selling veterinary practice"],
  ["how is the sale of a veterinary practice taxed", "veterinary practice sale taxed"],
  ["asset sale vs stock sale for a veterinary practice", "asset sale stock sale practice"],
  ["what is a holdback in a practice sale", "holdback practice sale"],
  ["what is a second bite of the apple in a practice sale", "second bite apple practice"],
]);
add("vet", "category", [
  ["what does a sell-side M&A advisor do", "sell-side advisor", true],
  ["do I need a broker to sell my veterinary practice", "broker sell veterinary practice"],
  ["what is the difference between a practice broker and an M&A advisor", "broker advisor difference"],
  ["how much does a sell-side advisor charge to sell a practice", "advisor charge sell practice"],
  ["should I hire an advisor if I already have an offer for my practice", "hire advisor already offer"],
  ["how to choose an advisor to sell a veterinary practice", "choose advisor sell veterinary"],
  ["what questions should I ask an M&A advisor before hiring them", "questions ask advisor"],
  ["what is a success fee when selling a business", "success fee selling business"],
  ["best veterinary practice brokers", "veterinary practice brokers"],
]);
add("vet", "timing", [
  ["is now a good time to sell a veterinary practice", "good time sell veterinary practice"],
  ["how far ahead should I plan to sell my veterinary practice", "plan sell veterinary practice"],
  ["should I sell my veterinary practice before I retire", "sell veterinary practice retire"],
  ["how do interest rates affect veterinary practice values", "interest rates veterinary practice"],
  ["what is the veterinary practice sale market like in 2026", "veterinary practice sale market"],
]);
add("general", "category", [
  ["what is a sell-side advisor", "sell-side advisor"],
  ["how to sell a medical practice to private equity", "sell medical practice private equity"],
  ["what is a healthcare M&A advisor", "healthcare advisor"],
]);
add("dental", "adjacent", [
  ["how to sell a dental practice", "sell dental practice"],
  ["how much is my dental practice worth", "dental practice worth"],
  ["what is a DSO offer and should I accept it", "dso offer"],
  ["what happens to staff when a dental practice is sold to a DSO", "staff dental practice dso"],
]);
add("oral", "adjacent", [
  ["should I sell my oral surgery practice to private equity", "oral surgery practice private equity"],
  ["how much is an oral surgery practice worth", "oral surgery practice worth"],
]);
add("medspa", "adjacent", [
  ["how to sell a med spa", "sell med spa"],
]);

// seeds for discovery (what people actually ask assistants, from the LLM Mentions store)
const SEEDS: Array<[string, string]> = [
  ["sell veterinary practice", "process"], ["veterinary practice worth", "valuation"], ["veterinary practice valuation", "valuation"],
  ["veterinary private equity", "buyers"], ["corporate veterinary practice sale", "buyers"], ["veterinary practice staff sale", "staff"],
  ["rollover equity practice", "terms"], ["earnout practice sale", "terms"], ["practice sale advisor", "category"],
  ["veterinary practice broker", "category"], ["when to sell veterinary practice", "timing"], ["veterinary practice due diligence", "process"],
  ["sell dental practice", "adjacent"], ["oral surgery practice sale", "adjacent"],
];

// competitors to test (brand → domain is resolved from a Google result so a guessed domain cannot read as "no mentions")
const COMPETITORS: Array<[string, string]> = [
  ["Transitions Elite", "transitionselite.com"], ["Ackerman Group", "ackerman-group.com"], ["Total Practice Solutions Group", "tpsgsales.com"],
  ["Omni Practice Group", "omni-pg.com"], ["Simmons & Associates veterinary", "simmonsinc.com"], ["VetValue", "vetvalue.pet"],
  ["Synergy Veterinary Practice Transitions", ""], ["Legacy Veterinary Advisors", ""], ["Integrus Partners", DOMAIN],
];

// ── helpers ───────────────────────────────────────────────────────────────
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const csv = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const row = (...cells: unknown[]) => console.log(cells.map(csv).join(","));
const block = (name: string, header: string[]) => { console.log(`\n### CSV ${name}`); row(...header); };
const end = () => console.log("### END");
const json = (name: string, v: unknown) => { console.log(`\n### JSON ${name}`); console.log(JSON.stringify(v)); console.log("### END"); };
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
let spent = 0; let calls = 0;
function stopIfOver(next: string) { if (spent > CEILING) { console.log(`\n!! CEILING $${CEILING} passed: spent $${spent.toFixed(3)} after ${calls} calls, before ${next}. Stopping.`); json("stopped", { spent, calls, before: next }); process.exit(3); } }
async function dfs(creds: DfsCreds, method: "POST" | "GET", path: string, body?: unknown, label = path): Promise<any> {
  stopIfOver(label);
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, { method, headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const j: any = await res.json();
  calls++; spent += n(j?.cost) ?? 0;
  return j;
}
/** One-task live call: returns tasks[0].result or throws with the task's own message. */
async function one(creds: DfsCreds, path: string, body: unknown): Promise<any> {
  const j = await dfs(creds, "POST", path, body);
  const t = j?.tasks?.[0];
  if (!t || t.status_code !== 20000) throw new Error(`${path}: ${t?.status_code} ${t?.status_message ?? "no task"}`);
  return t.result;
}
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function balance(creds: DfsCreds): Promise<number | null> {
  try { const j = await dfs(creds, "GET", "/appendix/user_data"); return n(j?.tasks?.[0]?.result?.[0]?.money?.balance); } catch (e) { console.log(`# balance unreadable: ${String(e).slice(0, 120)}`); return null; }
}

// ── LLM Mentions readers ───────────────────────────────────────────────────
type Mention = { platform: string; question: string; volume: number | null; sources: string[]; sourceUrls: string[]; webBased: boolean | null; last: string };
function mentionsOf(result: any): { total: number | null; items: Mention[] } {
  const r = result?.[0];
  const items: Mention[] = (r?.items ?? []).map((it: any) => ({
    platform: String(it?.platform ?? ""), question: String(it?.question ?? ""), volume: n(it?.ai_search_volume),
    sources: [...new Set(((it?.sources ?? []) as any[]).map((s) => String(s?.domain ?? hostOf(String(s?.url ?? ""))).replace(/^www\./, "").toLowerCase()).filter(Boolean))],
    sourceUrls: ((it?.sources ?? []) as any[]).map((s) => String(s?.url ?? "")).filter(Boolean),
    webBased: typeof it?.is_web_search_based === "boolean" ? it.is_web_search_based : null, last: String(it?.last_response_at ?? ""),
  }));
  return { total: n(r?.total_count), items };
}
async function searchMentions(creds: DfsCreds, probe: string, limit: number, platform?: string) {
  const body: any = { location_code: 2840, language_code: "en", target: [{ keyword: probe, search_scope: ["question"], match_type: "word_match" }], order_by: ["ai_search_volume,desc"], limit };
  if (platform) body.platform = platform;
  return mentionsOf(await one(creds, "/ai_optimization/llm_mentions/search_mentions/live", [body]));
}
type Agg = { key: string; mentions: number | null; volume: number | null };
const aggOf = (arr: any): Agg[] => ((arr ?? []) as any[]).map((x) => ({ key: String(x?.key ?? ""), mentions: n(x?.mentions), volume: n(x?.ai_search_volume) }));
async function topDomains(creds: DfsCreds, target: any[], limit: number) {
  const r = (await one(creds, "/ai_optimization/llm_mentions/top_mentioned_domains/live", [{ location_code: 2840, language_code: "en", target, limit, internal_list_limit: 3 }]))?.[0];
  return { total: n(r?.total_count), totalMentions: n(r?.aggregated_metrics?.total?.mentions), items: ((r?.items ?? []) as any[]).map((it) => ({ key: String(it?.domain ?? ""), mentions: n(it?.total?.mentions), volume: n(it?.total?.ai_search_volume), platforms: aggOf(it?.platform) })) };
}
async function topPages(creds: DfsCreds, target: any[], limit: number) {
  const r = (await one(creds, "/ai_optimization/llm_mentions/top_mentioned_pages/live", [{ location_code: 2840, language_code: "en", target, limit, internal_list_limit: 3 }]))?.[0];
  return { total: n(r?.total_count), totalMentions: n(r?.aggregated_metrics?.total?.mentions), items: ((r?.items ?? []) as any[]).map((it) => ({ key: String(it?.page ?? ""), mentions: n(it?.total?.mentions), volume: n(it?.total?.ai_search_volume), platforms: aggOf(it?.platform) })) };
}
async function targetMetrics(creds: DfsCreds, target: any[]) {
  const r = (await one(creds, "/ai_optimization/llm_mentions/target_metrics/live", [{ location_code: 2840, language_code: "en", target, internal_list_limit: 10 }]))?.[0];
  const m = r?.aggregated_metrics;
  return { mentions: n(m?.total?.mentions), volume: n(m?.total?.ai_search_volume), platforms: aggOf(m?.platform), sourcesDomain: aggOf(m?.sources_domain) };
}

// ── PART A ────────────────────────────────────────────────────────────────
async function partA(creds: DfsCreds) {
  console.log(`\nRUN ${RUN} · PART A · DataForSEO AI Optimization · US / English · read-only · ceiling $${CEILING}`);
  const bal0 = await balance(creds);
  console.log(`# balance before: ${bal0 == null ? "n/a" : "$" + bal0.toFixed(2)}`);

  // 2a. AI search volume for every hand-written candidate (one call, all keywords)
  const vol = new Map<string, { volume: number | null; months: Array<{ year: number; month: number; v: number | null }> }>();
  try {
    const r = await one(creds, "/ai_optimization/ai_keyword_data/keywords_search_volume/live", [{ keywords: C.map((c) => c.q), location_code: 2840, language_code: "en" }]);
    for (const it of r?.[0]?.items ?? []) vol.set(norm(String(it?.keyword ?? "")), { volume: n(it?.ai_search_volume), months: ((it?.ai_monthly_searches ?? []) as any[]).map((m) => ({ year: Number(m?.year), month: Number(m?.month), v: n(m?.ai_search_volume) })) });
  } catch (e) { console.log(`# ai_keyword_data error: ${String(e).slice(0, 160)}`); }
  block("2a_candidates_ai_volume", ["question", "tag", "vertical", "seeded", "ai_search_volume", "months_with_data", "last3_months", "source", "date"]);
  for (const c of C) { const v = vol.get(norm(c.q)); const last3 = (v?.months ?? []).slice(-3).map((m) => `${m.year}-${String(m.month).padStart(2, "0")}:${m.v ?? "na"}`).join(" "); row(c.q, c.tag, c.vertical, c.seeded ? "yes" : "", v ? (v.volume ?? "no data") : "no data", v ? v.months.filter((m) => m.v != null).length : "", last3, "ai_optimization/ai_keyword_data/keywords_search_volume/live", RUN); }
  end();

  // 2b. Discovery: what the LLM Mentions store holds for each seed phrase (real asked questions, both platforms)
  const seen = new Map<string, { q: string; tag: string; volume: number | null; platforms: Set<string>; sources: Set<string>; seeds: Set<string> }>();
  block("2b_discovered_questions", ["seed", "tag", "platform", "question", "ai_search_volume", "web_search_based", "n_sources", "sources", "last_response_at", "source", "date"]);
  const disc = await pool(SEEDS, 4, async ([seed, tag]) => { try { return { seed, tag, r: await searchMentions(creds, seed, 40) }; } catch (e) { return { seed, tag, r: null as any, err: String(e).slice(0, 140) }; } });
  for (const d of disc) {
    if (!d.r) { row(d.seed, d.tag, "", `error: ${(d as any).err}`, "", "", "", "", "", "llm_mentions/search_mentions", RUN); continue; }
    console.log(`# seed "${d.seed}": ${d.r.total ?? "n/a"} stored questions match, showing ${d.r.items.length}`);
    for (const m of d.r.items) {
      row(d.seed, d.tag, m.platform, m.question, m.volume ?? "no data", m.webBased ?? "", m.sources.length, m.sources.join(" | "), m.last, "llm_mentions/search_mentions/live", RUN);
      const k = norm(m.question); const e = seen.get(k) ?? { q: m.question, tag: d.tag, volume: m.volume, platforms: new Set<string>(), sources: new Set<string>(), seeds: new Set<string>() };
      e.platforms.add(m.platform); m.sources.forEach((s) => e.sources.add(s)); e.seeds.add(d.seed); if ((m.volume ?? 0) > (e.volume ?? 0)) e.volume = m.volume; seen.set(k, e);
    }
  }
  end();

  // 3a. Who holds each candidate's answer now: stored prompts matching the probe, their sources, concentration
  block("3a_candidate_holders", ["question", "tag", "vertical", "seeded", "probe", "stored_prompts_matching", "shown", "chatgpt_prompts", "google_prompts", "distinct_source_domains", "top_domain", "top_domain_share_of_citations", "top5_domains", "integrus_cited", "competitor_domains_cited", "example_prompts", "source", "date"]);
  const compDomains = new Set(COMPETITORS.map(([, d]) => d).filter(Boolean));
  const holders = await pool(C, 4, async (c) => { try { return { c, r: await searchMentions(creds, c.probe, 30) }; } catch (e) { return { c, r: null as any, err: String(e).slice(0, 140) }; } });
  const holderMap = new Map<string, any>();
  for (const h of holders) {
    if (!h.r) { row(h.c.q, h.c.tag, h.c.vertical, h.c.seeded ? "yes" : "", h.c.probe, `error: ${(h as any).err}`, "", "", "", "", "", "", "", "", "", "", "llm_mentions/search_mentions", RUN); continue; }
    const cites = new Map<string, number>(); let totalCites = 0;
    for (const m of h.r.items) for (const s of m.sources) { cites.set(s, (cites.get(s) ?? 0) + 1); totalCites++; }
    const ranked = [...cites.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    const rec = { total: h.r.total, shown: h.r.items.length, chatgpt: h.r.items.filter((m) => m.platform === "chat_gpt").length, google: h.r.items.filter((m) => m.platform === "google").length, distinct: cites.size, top: top?.[0] ?? "", topShare: top && totalCites ? Math.round((top[1] / totalCites) * 100) : null, top5: ranked.slice(0, 5).map(([d, k]) => `${d}:${k}`), integrus: ranked.some(([d]) => d.endsWith(DOMAIN)), comps: ranked.filter(([d]) => compDomains.has(d)).map(([d, k]) => `${d}:${k}`), examples: h.r.items.slice(0, 3).map((m) => m.question), volumes: h.r.items.map((m) => m.volume ?? 0) };
    holderMap.set(h.c.q, rec);
    row(h.c.q, h.c.tag, h.c.vertical, h.c.seeded ? "yes" : "", h.c.probe, rec.total ?? "n/a", rec.shown, rec.chatgpt, rec.google, rec.distinct, rec.top, rec.topShare ?? "", rec.top5.join(" | "), rec.integrus ? "yes" : "no", rec.comps.join(" | "), rec.examples.join(" || "), "llm_mentions/search_mentions/live (top 30 by ai_search_volume)", RUN);
  }
  end();

  // 3b. Topic-level: who is cited across the whole veterinary sale topic, on each platform
  block("3b_topic_domains", ["topic", "platform_split_of_all_mentions", "total_mentions", "domain", "mentions", "ai_search_volume", "source", "date"]);
  block("3b_topic_pages", ["topic", "page", "mentions", "ai_search_volume", "source", "date"]);
  console.log("### END");
  const TOPICS: Array<[string, any[]]> = [
    ["veterinary practice (sell/sale/worth)", [{ keyword: "veterinary practice", search_scope: ["question"] }]],
    ["sell + veterinary", [{ keyword: "sell veterinary", search_scope: ["question"] }]],
    ["practice + private equity", [{ keyword: "practice private equity", search_scope: ["question"] }]],
  ];
  const topicOut: any[] = [];
  for (const [topic, target] of TOPICS) {
    try {
      const d = await topDomains(creds, target, 25);
      const p = await topPages(creds, target, 25);
      topicOut.push({ topic, domains: d, pages: p });
      console.log(`\n### CSV 3b_topic_domains_${topic.replace(/[^a-z]+/gi, "_")}`); row("topic", "total_mentions_in_topic", "domain", "mentions", "ai_search_volume", "platforms", "source", "date");
      for (const it of d.items) row(topic, d.totalMentions ?? "", it.key, it.mentions ?? "", it.volume ?? "", it.platforms.map((x) => `${x.key}:${x.mentions}`).join(" "), "llm_mentions/top_mentioned_domains/live", RUN);
      end();
      console.log(`\n### CSV 3b_topic_pages_${topic.replace(/[^a-z]+/gi, "_")}`); row("topic", "page", "mentions", "ai_search_volume", "platforms", "source", "date");
      for (const it of p.items) row(topic, it.key, it.mentions ?? "", it.volume ?? "", it.platforms.map((x) => `${x.key}:${x.mentions}`).join(" "), "llm_mentions/top_mentioned_pages/live", RUN);
      end();
    } catch (e) { console.log(`# topic ${topic}: ${String(e).slice(0, 160)}`); }
  }

  // 3c. The named competitors: resolve the domain from a Google result, then count their AI citations
  block("3c_competitors", ["brand", "domain_used", "domain_source", "ai_mentions_total", "ai_search_volume_of_mentioning_prompts", "chatgpt_mentions", "google_mentions", "top_cited_pages", "source", "date"]);
  const compOut: any[] = [];
  for (const [brand, guess] of COMPETITORS) {
    let domain = guess; let src = "given";
    if (!domain) {
      try { const s = await one(creds, "/serp/google/organic/live/advanced", [{ keyword: brand, location_name: "United States", language_name: "English", depth: 10 }]); const org = (s?.[0]?.items ?? []).find((i: any) => i?.type === "organic" && !/linkedin|facebook|yelp|indeed|bbb\.org|google/.test(String(i?.domain ?? ""))); domain = String(org?.domain ?? "").replace(/^www\./, ""); src = `google organic #1 for "${brand}"`; } catch (e) { src = `serp error ${String(e).slice(0, 60)}`; }
    }
    if (!domain) { row(brand, "", src, "no data", "", "", "", "", "serp/google/organic/live", RUN); continue; }
    try {
      const t = await targetMetrics(creds, [{ domain, include_subdomains: true }]);
      let pages: any = null; try { pages = await topPages(creds, [{ domain, include_subdomains: true }], 10); } catch (e) { console.log(`# pages ${domain}: ${String(e).slice(0, 100)}`); }
      compOut.push({ brand, domain, t, pages });
      row(brand, domain, src, t.mentions ?? "no data", t.volume ?? "", t.platforms.find((p) => p.key === "chat_gpt")?.mentions ?? 0, t.platforms.find((p) => p.key === "google")?.mentions ?? 0, (pages?.items ?? []).slice(0, 6).map((p: any) => `${p.key} (${p.mentions})`).join(" | "), "llm_mentions/target_metrics + top_mentioned_pages (domain target, subdomains included)", RUN);
    } catch (e) { row(brand, domain, src, `error: ${String(e).slice(0, 100)}`, "", "", "", "", "llm_mentions/target_metrics", RUN); }
  }
  end();

  json("partA", { candidates: C, volumes: [...vol.entries()], discovered: [...seen.values()].map((e) => ({ ...e, platforms: [...e.platforms], sources: [...e.sources], seeds: [...e.seeds] })), holders: [...holderMap.entries()], topics: topicOut, competitors: compOut });

  const bal1 = await balance(creds);
  const est = { shortlist: 20, chatgpt_claude_standard: 2 * 20 * (0.0002 + 0.03), gemini_perplexity_live: 2 * 20 * (0.0006 + 0.02), ai_mode_standard: 20 * 0.0012, top_domains_per_shortlist: 20 * (0.10 + 0.015) };
  const estTotal = est.chatgpt_claude_standard + est.gemini_perplexity_live + est.ai_mode_standard + est.top_domains_per_shortlist;
  console.log(`\nPART A DONE · ${calls} calls · spent (sum of response cost fields) $${spent.toFixed(3)} · balance before ${bal0 == null ? "n/a" : "$" + bal0.toFixed(2)} · after ${bal1 == null ? "n/a" : "$" + bal1.toFixed(2)}`);
  console.log(`# step 4 estimate for a 20-question shortlist: ~$${estTotal.toFixed(2)} (token charges assumed at $0.02-0.03 a response with web search; the model's real charge comes back in money_spent)`);
  json("cost", { calls, spent, balanceBefore: bal0, balanceAfter: bal1, step4Estimate: est, step4EstimateTotal: estTotal });
}

// ── PART B ────────────────────────────────────────────────────────────────
type Shot = { q: string; provider: string; model: string; text: string; urls: string[]; domains: string[]; integrus: boolean; cost: number | null; tokens: string; err: string | null; method: string };
function answerOf(result: any): { text: string; urls: string[] } {
  const r = Array.isArray(result) ? result[0] : result;
  let text = ""; const urls: string[] = [];
  for (const it of r?.items ?? []) {
    if (it?.type === "reasoning") continue;
    for (const s of it?.sections ?? []) { if (typeof s?.text === "string") text += " " + s.text; for (const a of s?.annotations ?? []) if (typeof a?.url === "string") urls.push(a.url); }
  }
  return { text: text.replace(/\s+/g, " ").trim(), urls: [...new Set(urls)] };
}
function aiModeOf(result: any): { text: string; urls: string[]; present: boolean } {
  const r = Array.isArray(result) ? result[0] : result;
  const items: any[] = r?.items ?? [];
  const ai = items.find((i) => i?.type === "ai_overview");
  if (!ai) return { text: "", urls: [], present: false };
  const urls: string[] = [];
  for (const ref of ai?.references ?? []) if (typeof ref?.url === "string") urls.push(ref.url);
  for (const el of ai?.items ?? []) for (const ref of el?.references ?? []) if (typeof ref?.url === "string") urls.push(ref.url);
  for (const el of ai?.items ?? []) for (const l of el?.links ?? []) if (typeof l?.url === "string") urls.push(l.url);
  const text = String(ai?.text ?? (ai?.items ?? []).map((e: any) => e?.text ?? "").join(" ")).replace(/\s+/g, " ").trim();
  return { text, urls: [...new Set(urls)], present: true };
}
async function pickModel(creds: DfsCreds, seg: string, prefer: RegExp[]): Promise<{ name: string; taskPost: boolean }> {
  const j = await dfs(creds, "GET", `/ai_optimization/${seg}/llm_responses/models`);
  const list: any[] = j?.tasks?.[0]?.result ?? [];
  const names = list.map((m) => ({ name: String(m?.model_name ?? ""), taskPost: m?.task_post_supported === true, web: m?.web_search_supported }));
  console.log(`# ${seg} models: ${names.map((m) => `${m.name}${m.taskPost ? "(std)" : ""}${m.web === false ? "(no web)" : ""}`).join(", ")}`);
  for (const rx of prefer) { const hit = names.find((m) => rx.test(m.name) && m.web !== false); if (hit) return hit; }
  return names[0] ?? { name: "", taskPost: false };
}
async function partB(creds: DfsCreds) {
  const shortlist: string[] = JSON.parse(process.env.SHORTLIST || "[]");
  if (!shortlist.length) throw new Error("SHORTLIST is empty: pass a JSON array of questions");
  console.log(`\nRUN ${RUN} · PART B · ${shortlist.length} questions · ceiling $${CEILING} · read-only`);
  const bal0 = await balance(creds);
  console.log(`# balance before: ${bal0 == null ? "n/a" : "$" + bal0.toFixed(2)}`);
  const models = {
    chat_gpt: await pickModel(creds, "chat_gpt", [/^gpt-4\.1$/, /^gpt-5$/, /^gpt-4o$/, /gpt-4\.1/]),
    claude: await pickModel(creds, "claude", [/^claude-sonnet-4-5$/, /^claude-sonnet-5$/, /claude-sonnet/, /claude/]),
    gemini: await pickModel(creds, "gemini", [/^gemini-2\.5-flash$/, /^gemini-2\.5-pro$/, /gemini-2/]),
    perplexity: await pickModel(creds, "perplexity", [/^sonar$/, /sonar/]),
  };
  json("models", models);
  const shots: Shot[] = [];
  const push = (s: Shot) => shots.push(s);

  // standard queue where it exists (ChatGPT, Claude): post everything, then poll
  const posted: Array<{ id: string; seg: string; q: string; model: string }> = [];
  for (const seg of ["chat_gpt", "claude"] as const) {
    const m = models[seg];
    if (!m.name) { shortlist.forEach((q) => push({ q, provider: seg, model: "", text: "", urls: [], domains: [], integrus: false, cost: null, tokens: "", err: "no model available", method: "" })); continue; }
    if (!m.taskPost) { console.log(`# ${seg}: ${m.name} has no standard queue, using live`); continue; }
    const tasks = shortlist.map((q, i) => ({ user_prompt: q, model_name: m.name, web_search: true, web_search_country_iso_code: "US", max_output_tokens: 1024, tag: `${seg}:${i}` }));
    try {
      const j = await dfs(creds, "POST", `/ai_optimization/${seg}/llm_responses/task_post`, tasks);
      for (const t of j?.tasks ?? []) { const i = Number(String(t?.data?.tag ?? "").split(":")[1]); if (t?.status_code === 20100 || t?.status_code === 20000) posted.push({ id: String(t.id), seg, q: shortlist[i]!, model: m.name }); else push({ q: shortlist[i] ?? "?", provider: seg, model: m.name, text: "", urls: [], domains: [], integrus: false, cost: null, tokens: "", err: `post ${t?.status_code} ${t?.status_message}`, method: "standard" }); }
      console.log(`# ${seg}: posted ${posted.filter((p) => p.seg === seg).length} tasks to the standard queue`);
    } catch (e) { console.log(`# ${seg} task_post failed: ${String(e).slice(0, 160)}; falling back to live`); models[seg] = { ...m, taskPost: false }; }
  }
  // AI Mode: standard queue, priority 1
  const aiPosted: Array<{ id: string; q: string }> = [];
  try {
    const j = await dfs(creds, "POST", "/serp/google/ai_mode/task_post", shortlist.map((q, i) => ({ keyword: q, location_code: 2840, language_code: "en", device: "desktop", priority: 1, tag: `aimode:${i}` })));
    for (const t of j?.tasks ?? []) { const i = Number(String(t?.data?.tag ?? "").split(":")[1]); if (t?.status_code === 20100 || t?.status_code === 20000) aiPosted.push({ id: String(t.id), q: shortlist[i]! }); else push({ q: shortlist[i] ?? "?", provider: "google_ai_mode", model: "", text: "", urls: [], domains: [], integrus: false, cost: null, tokens: "", err: `post ${t?.status_code} ${t?.status_message}`, method: "standard" }); }
    console.log(`# ai_mode: posted ${aiPosted.length} tasks (standard priority)`);
  } catch (e) { console.log(`# ai_mode task_post failed: ${String(e).slice(0, 160)}`); shortlist.forEach((q) => push({ q, provider: "google_ai_mode", model: "", text: "", urls: [], domains: [], integrus: false, cost: null, tokens: "", err: String(e).slice(0, 120), method: "standard" })); }

  // live where there is no queue (Gemini, Perplexity, and any provider whose post failed)
  const liveSegs = (["gemini", "perplexity", "chat_gpt", "claude"] as const).filter((s) => models[s].name && !models[s].taskPost);
  for (const seg of liveSegs) {
    const m = models[seg];
    const out = await pool(shortlist, 3, async (q): Promise<Shot> => {
      const body: any = { user_prompt: q, model_name: m.name, max_output_tokens: 1024, tag: seg };
      if (seg !== "perplexity") { body.web_search = true; body.web_search_country_iso_code = "US"; } else body.web_search_country_iso_code = "US";
      try {
        const j = await dfs(creds, "POST", `/ai_optimization/${seg}/llm_responses/live`, [body]);
        const t = j?.tasks?.[0]; if (!t || t.status_code !== 20000) throw new Error(`${t?.status_code} ${t?.status_message}`);
        const r = t.result?.[0]; const a = answerOf(t.result);
        return { q, provider: seg, model: String(r?.model_name ?? m.name), text: a.text, urls: a.urls, domains: [...new Set(a.urls.map(hostOf).filter(Boolean))], integrus: new RegExp(BRAND, "i").test(a.text) || a.urls.some((u) => hostOf(u).endsWith(DOMAIN)), cost: n(t.cost), tokens: `${r?.input_tokens ?? ""}/${r?.output_tokens ?? ""}`, err: null, method: "live" };
      } catch (e) { return { q, provider: seg, model: m.name, text: "", urls: [], domains: [], integrus: false, cost: null, tokens: "", err: String(e).slice(0, 140), method: "live" }; }
    });
    out.forEach(push);
    console.log(`# ${seg}: ${out.filter((s) => !s.err).length}/${out.length} answered live`);
  }

  // poll the standard queues (up to ~25 minutes), then fetch each task
  const deadline = Date.now() + 25 * 60_000;
  const want = new Map(posted.map((p) => [p.id, p])); const aiWant = new Map(aiPosted.map((p) => [p.id, p]));
  while ((want.size || aiWant.size) && Date.now() < deadline) {
    await sleep(20_000);
    for (const seg of ["chat_gpt", "claude"] as const) {
      if (![...want.values()].some((p) => p.seg === seg)) continue;
      try {
        const j = await dfs(creds, "GET", `/ai_optimization/${seg}/llm_responses/tasks_ready`);
        for (const r of j?.tasks?.[0]?.result ?? []) {
          const p = want.get(String(r?.id)); if (!p) continue;
          const g = await dfs(creds, "GET", `/ai_optimization/${seg}/llm_responses/task_get/${p.id}`);
          const t = g?.tasks?.[0]; want.delete(p.id);
          if (!t || t.status_code !== 20000) { push({ q: p.q, provider: seg, model: p.model, text: "", urls: [], domains: [], integrus: false, cost: n(t?.cost), tokens: "", err: `get ${t?.status_code} ${t?.status_message}`, method: "standard" }); continue; }
          const rr = t.result?.[0]; const a = answerOf(t.result);
          push({ q: p.q, provider: seg, model: String(rr?.model_name ?? p.model), text: a.text, urls: a.urls, domains: [...new Set(a.urls.map(hostOf).filter(Boolean))], integrus: new RegExp(BRAND, "i").test(a.text) || a.urls.some((u) => hostOf(u).endsWith(DOMAIN)), cost: n(t.cost), tokens: `${rr?.input_tokens ?? ""}/${rr?.output_tokens ?? ""}`, err: null, method: "standard" });
        }
      } catch (e) { console.log(`# ${seg} poll: ${String(e).slice(0, 120)}`); }
    }
    if (aiWant.size) {
      try {
        const j = await dfs(creds, "GET", "/serp/google/ai_mode/tasks_ready");
        for (const r of j?.tasks?.[0]?.result ?? []) {
          const p = aiWant.get(String(r?.id)); if (!p) continue;
          const g = await dfs(creds, "GET", `/serp/google/ai_mode/task_get/advanced/${p.id}`);
          const t = g?.tasks?.[0]; aiWant.delete(p.id);
          if (!t || t.status_code !== 20000) { push({ q: p.q, provider: "google_ai_mode", model: "", text: "", urls: [], domains: [], integrus: false, cost: n(t?.cost), tokens: "", err: `get ${t?.status_code} ${t?.status_message}`, method: "standard" }); continue; }
          const a = aiModeOf(t.result);
          push({ q: p.q, provider: "google_ai_mode", model: a.present ? "ai_mode" : "(no AI answer shown)", text: a.text, urls: a.urls, domains: [...new Set(a.urls.map(hostOf).filter(Boolean))], integrus: new RegExp(BRAND, "i").test(a.text) || a.urls.some((u) => hostOf(u).endsWith(DOMAIN)), cost: n(t.cost), tokens: "", err: a.present ? null : "no ai_overview item in the AI Mode result", method: "standard" });
        }
      } catch (e) { console.log(`# ai_mode poll: ${String(e).slice(0, 120)}`); }
    }
    console.log(`# waiting: ${want.size} llm tasks, ${aiWant.size} ai mode tasks (${Math.round((deadline - Date.now()) / 60000)} min left)`);
  }
  for (const p of want.values()) push({ q: p.q, provider: p.seg, model: p.model, text: "", urls: [], domains: [], integrus: false, cost: null, tokens: "", err: `not ready after 25 min (task ${p.id}; the $0.01 advance is refunded if it never completes)`, method: "standard" });
  for (const p of aiWant.values()) push({ q: p.q, provider: "google_ai_mode", model: "", text: "", urls: [], domains: [], integrus: false, cost: null, tokens: "", err: `not ready after 25 min (task ${p.id})`, method: "standard" });

  // concentration per shortlisted question across the whole LLM Mentions store (aggregated domains)
  block("4b_shortlist_top_domains", ["question", "probe_used", "total_mentions_matching", "distinct_domains_returned", "top_domain", "top_mentions", "top_share", "top8", "source", "date"]);
  const probes = new Map<string, string>(JSON.parse(process.env.PROBES || "{}"));
  const conc = await pool(shortlist, 3, async (q) => { const probe = probes.get(q) || norm(q).split(" ").filter((w) => !/^(how|what|when|is|do|i|my|a|an|the|to|of|in|for|should|does|it|be|if|me|am|are|can|and|or)$/.test(w)).slice(0, 4).join(" "); try { return { q, probe, d: await topDomains(creds, [{ keyword: probe, search_scope: ["question"] }], 40) }; } catch (e) { return { q, probe, d: null as any, err: String(e).slice(0, 120) }; } });
  for (const c of conc) {
    if (!c.d) { row(c.q, c.probe, `error: ${(c as any).err}`, "", "", "", "", "", "llm_mentions/top_mentioned_domains", RUN); continue; }
    const top = c.d.items[0]; const tot = c.d.totalMentions;
    row(c.q, c.probe, tot ?? "", c.d.total ?? c.d.items.length, top?.key ?? "", top?.mentions ?? "", top && tot ? Math.round(((top.mentions ?? 0) / tot) * 100) + "%" : "", c.d.items.slice(0, 8).map((x) => `${x.key}:${x.mentions}`).join(" | "), "llm_mentions/top_mentioned_domains/live", RUN);
  }
  end();

  block("4a_answers", ["question", "provider", "method", "model", "integrus_mentioned_or_cited", "n_citations", "domains_cited", "urls_cited", "tokens_in/out", "task_cost_usd", "answer_excerpt", "error", "date"]);
  const order = ["chat_gpt", "claude", "gemini", "perplexity", "google_ai_mode"];
  for (const q of shortlist) for (const prov of order) for (const s of shots.filter((x) => x.q === q && x.provider === prov)) row(s.q, s.provider, s.method, s.model, s.integrus ? "yes" : "no", s.urls.length, s.domains.join(" | "), s.urls.slice(0, 12).join(" | "), s.tokens, s.cost ?? "", s.text.slice(0, 900), s.err ?? "", RUN);
  end();
  json("partB", { shortlist, models, shots: shots.map((s) => ({ ...s, text: s.text.slice(0, 3000) })), concentration: conc });

  const bal1 = await balance(creds);
  console.log(`\nPART B DONE · ${calls} calls · spent (sum of response cost fields) $${spent.toFixed(3)} · balance before ${bal0 == null ? "n/a" : "$" + bal0.toFixed(2)} · after ${bal1 == null ? "n/a" : "$" + bal1.toFixed(2)}`);
  json("cost", { calls, spent, balanceBefore: bal0, balanceAfter: bal1 });
}

(async () => {
  const creds = credsFromEnv();
  if (PART === "b") await partB(creds); else await partA(creds);
})().catch((e) => { console.error(`\nFAILED after ${calls} calls, $${spent.toFixed(3)}: ${e instanceof Error ? e.stack || e.message : String(e)}`); process.exit(1); });

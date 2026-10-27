#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, type DfsCreds } from "./dataforseo.js";

/**
 * READ-ONLY pull for the Integrus veterinary hub: People Also Ask by query, how the
 * ranking pages are built, our own two pages, and who links to the competitors but not
 * to Integrus. DataForSEO only. Nothing is written anywhere. No page text is printed:
 * only counts, titles, headings, schema type names and yes/no facts.
 * CEILING (USD) stops the run before the next paid call once the API's own cost
 * fields add up past it. A negative or low balance stops the run before any call.
 */
const RUN = new Date().toISOString().slice(0, 10);
const CEILING = Number(process.env.CEILING || "8");
const OURS = "integruspartners.com";
const QUERIES = [
  "sell my veterinary practice", "how to sell a veterinary practice", "veterinary practice valuation",
  "how much is my veterinary practice worth", "selling a veterinary practice to private equity",
  "how long does it take to sell a veterinary practice", "is now a good time to sell a veterinary practice",
  "veterinary practice broker", "veterinary practice sale process", "what do corporate buyers look for in a veterinary practice",
  "what happens to staff when a veterinary practice is sold", "should I sell my veterinary practice to a corporate group or a private buyer",
  "can a non veterinarian own a veterinary practice", "veterinary practice broker Dallas",
];
const OWN_PAGES = ["https://integruspartners.com/", "https://integruspartners.com/healthcareadvisors"];
// Sites that are not competitors and carry no link-building meaning. Step 4 skips them when choosing the five
// domains and says so; the raw tally is printed too.
const PLATFORMS = /^(youtube|reddit|google|facebook|linkedin|wikipedia|yelp|indeed|ziprecruiter|quora|instagram|twitter|x|pinterest|amazon|walmart|bing|apple)\./;
const SECTIONS: Array<[string, RegExp]> = [
  ["how to sell", /\b(how (do|to|can) (i )?sell|selling|steps|process|prepare|checklist)\b/i],
  ["how long it takes", /\b(how long|take to sell|timeline|months|years)\b/i],
  ["is now a good time", /\b(good time|right time|when (should|to)|market|interest rate|2025|2026)\b/i],
  ["what a sell-side advisor does", /\b(broker|advisor|adviser|consultant|agent|fee|commission|hire)\b/i],
  ["corporate group versus private buyer", /\b(corporate|private equity|\bpe\b|consolidator|nva|mars|banfield|associate|private buyer|dso)\b/i],
  ["what happens to staff", /\b(staff|employee|team|associate vet|technician|job|keep working|stay)\b/i],
  ["what the practice is worth", /\b(worth|value|valuation|multiple|ebitda|price|how much)\b/i],
];

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const csv = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const row = (...c: unknown[]) => console.log(c.map(csv).join(","));
const block = (name: string, header: string[]) => { console.log(`\n### CSV ${name}`); row(...header); };
const end = () => console.log("### END");
const json = (name: string, v: unknown) => { console.log(`\n### JSON ${name}`); console.log(JSON.stringify(v)); console.log("### END"); };
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const dom = (d: string) => d.replace(/^www\./, "").toLowerCase();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
let spent = 0; let calls = 0;
const stage: string[] = [];
function checkpoint(label: string) { const line = `STEP ${label}: spent so far $${spent.toFixed(4)} over ${calls} calls`; stage.push(line); console.log(`\n${line}`); }
function stopIfOver(next: string) { if (spent > CEILING) { console.log(`\n!! CEILING $${CEILING} passed ($${spent.toFixed(4)}) before ${next}. Stopping and reporting.`); process.exit(3); } }
async function dfs(creds: DfsCreds, method: "POST" | "GET", path: string, body?: unknown): Promise<any> {
  stopIfOver(path);
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, { method, headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const j: any = await res.json(); calls++; spent += n(j?.cost) ?? 0; return j;
}
async function task(creds: DfsCreds, path: string, body: unknown): Promise<{ result: any; id: string }> {
  const j = await dfs(creds, "POST", path, body); const t = j?.tasks?.[0];
  if (!t || t.status_code !== 20000) throw new Error(`${path}: ${t?.status_code} ${t?.status_message ?? "no task"}`);
  return { result: t.result, id: String(t.id) };
}
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}

type Paa = { q: string; domain: string; url: string };
type Serp = { query: string; organic: Array<{ rank: number; url: string; domain: string; title: string }>; aiPresent: boolean; aiRefs: Array<{ url: string; domain: string }>; paa: Paa[]; err: string | null };
async function serp(creds: DfsCreds, query: string): Promise<Serp> {
  try {
    const { result } = await task(creds, "/serp/google/organic/live/advanced", [{
      keyword: query, location_name: "United States", language_name: "English", device: "desktop", depth: 10,
      people_also_ask_click_depth: 2, load_async_ai_overview: true,
    }]);
    const items: any[] = result?.[0]?.items ?? [];
    const organic = items.filter((i) => i?.type === "organic").slice(0, 10).map((i) => ({ rank: n(i.rank_group) ?? n(i.rank_absolute) ?? 0, url: String(i.url ?? ""), domain: dom(String(i.domain ?? hostOf(String(i.url ?? "")))), title: String(i.title ?? "").slice(0, 160) }));
    const ai = items.find((i) => i?.type === "ai_overview");
    const aiRefs: Array<{ url: string; domain: string }> = [];
    if (ai) {
      const pushRef = (r: any) => { if (typeof r?.url === "string" && !/google\.com/.test(r.url)) aiRefs.push({ url: r.url, domain: dom(String(r.domain ?? hostOf(r.url))) }); };
      (ai.references ?? []).forEach(pushRef);
      (ai.items ?? []).forEach((e: any) => (e?.references ?? []).forEach(pushRef));
    }
    const paa: Paa[] = [];
    const walk = (el: any) => {
      if (!el) return;
      if (el.type === "people_also_ask_element") {
        const ex = Array.isArray(el.expanded_element) ? el.expanded_element[0] : null;
        paa.push({ q: String(el.title ?? "").trim(), domain: dom(String(ex?.domain ?? hostOf(String(ex?.url ?? "")))), url: String(ex?.url ?? "") });
      }
      for (const sub of el.items ?? []) walk(sub);
    };
    for (const it of items) if (it?.type === "people_also_ask") walk(it);
    const seen = new Set<string>(); const uniq = paa.filter((p) => p.q && !seen.has(norm(p.q)) && seen.add(norm(p.q)));
    return { query, organic, aiPresent: !!ai, aiRefs: aiRefs.filter((r, i, a) => a.findIndex((x) => x.url === r.url) === i), paa: uniq, err: null };
  } catch (e) { return { query, organic: [], aiPresent: false, aiRefs: [], paa: [], err: String(e).slice(0, 160) }; }
}

type Page = { url: string; words: number | null; title: string; h1: string; h2: number | null; schema: string[] | null; internal: number | null; external: number | null; author: string; date: string; err: string | null };
const TYPE_RX = /"@type"\s*:\s*(\[[^\]]*\]|"[^"]+")/g;
function schemaTypes(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) for (const t of m[1]!.matchAll(TYPE_RX)) for (const x of String(t[1]).replace(/[\[\]"\s]/g, "").split(",")) if (x) out.add(x);
  return [...out].sort();
}
async function page(creds: DfsCreds, url: string): Promise<Page> {
  const base: Page = { url, words: null, title: "", h1: "", h2: null, schema: null, internal: null, external: null, author: "no data", date: "no data", err: null };
  try {
    const { result, id } = await task(creds, "/on_page/instant_pages", [{ url, store_raw_html: true, enable_javascript: false }]);
    const it = result?.[0]?.items?.[0]; if (!it) return { ...base, err: "no item returned" };
    const meta = it.meta ?? {};
    const h = meta.htags ?? {};
    base.words = n(meta.content?.plain_text_word_count); base.title = String(meta.title ?? "").slice(0, 160);
    base.h1 = String((h.h1 ?? [])[0] ?? "").slice(0, 160); base.h2 = Array.isArray(h.h2) ? h.h2.length : null;
    base.internal = n(meta.internal_links_count); base.external = n(meta.external_links_count);
    // Schema, author and date are not fields of the on-page response, so read them from the raw page DataForSEO stored for this task.
    try {
      const raw = await dfs(creds, "GET", `/on_page/raw_html?id=${id}&url=${encodeURIComponent(url)}`);
      const html: string = raw?.tasks?.[0]?.result?.[0]?.items?.html ?? raw?.tasks?.[0]?.result?.[0]?.items?.raw_html ?? "";
      if (html) {
        base.schema = schemaTypes(html);
        const hasAuthor = /"author"\s*:|<meta[^>]+name=["']author["']|rel=["']author["']|itemprop=["']author["']|class=["'][^"']*\bauthor\b/i.test(html);
        const hasDate = /"(datePublished|dateModified)"\s*:|<meta[^>]+(article:(published|modified)_time|name=["']date["'])|<time[^>]+datetime=|itemprop=["']date(Published|Modified)["']/i.test(html);
        base.author = hasAuthor ? "yes" : "no"; base.date = hasDate ? "yes" : "no";
      }
    } catch (e) { base.err = `raw page unavailable: ${String(e).slice(0, 90)}`; }
    return base;
  } catch (e) { return { ...base, err: String(e).slice(0, 160) }; }
}
const TYPE_RULES: Array<[RegExp, string]> = [
  [/vma\b|vet(erinary)?(medical)?(assoc|society)|avma|aaha|vhma|vetpartners|\.org$/i, "veterinary association / nonprofit"],
  [/dvm360|todaysveterinarybusiness|veterinarypracticenews|vetmed|bizjournals|businessinsider|forbes|news|magazine|journal|times|post|press/i, "trade publication / press"],
  [/directory|listing|bizbuysell|bizquest|clutch|expertise|axial|pitchbook|crunchbase|yellowpages|manta|bbb\.org|zoominfo|chamber/i, "adviser / listing directory"],
  [/law|legal|attorney|cpa|account|wealth|financial|capital|advisors?\b/i, "professional services"],
];
const typeOf = (d: string) => TYPE_RULES.find(([rx]) => rx.test(d))?.[1] ?? "other";

(async () => {
  const creds = credsFromEnv();
  console.log(`RUN ${RUN} · Integrus hub pull · DataForSEO · US / English / desktop · read-only · ceiling $${CEILING}`);
  // Balance gate: a negative or tiny balance makes the API withhold results; do not start.
  const ud = await dfs(creds, "GET", "/appendix/user_data");
  const bal = n(ud?.tasks?.[0]?.result?.[0]?.money?.balance);
  console.log(`# balance before: ${bal == null ? "unreadable" : "$" + bal.toFixed(2)}`);
  if (bal == null || bal < 1) { console.log(`!! Balance is ${bal == null ? "unreadable" : "$" + bal.toFixed(2)}. Top up the DataForSEO account, then run again. Nothing was spent.`); process.exit(4); }

  // Step 1
  const serps = await pool(QUERIES, 4, (q) => serp(creds, q));
  block("1a_serp_top10", ["query", "rank", "domain", "url", "title", "source", "date"]);
  for (const s of serps) { if (s.err) row(s.query, "", "", "", `error: ${s.err}`, "serp/google/organic/live/advanced", RUN); else if (!s.organic.length) row(s.query, "", "", "", "no data", "serp/google/organic/live/advanced", RUN); for (const o of s.organic) row(s.query, o.rank, o.domain, o.url, o.title, "serp/google/organic/live/advanced", RUN); }
  end();
  block("1b_ai_overview_sources", ["query", "ai_overview_shown", "domain", "url", "source", "date"]);
  for (const s of serps) { if (!s.aiPresent) row(s.query, "no", "", "", "serp/live (load_async_ai_overview on)", RUN); for (const r of s.aiRefs) row(s.query, "yes", r.domain, r.url, "serp/live (load_async_ai_overview on)", RUN); if (s.aiPresent && !s.aiRefs.length) row(s.query, "yes", "", "", "AI Overview shown, no sources returned", RUN); }
  end();
  block("1c_people_also_ask", ["query", "question", "answering_domain", "answering_url", "source", "date"]);
  for (const s of serps) { if (!s.paa.length) row(s.query, "no data", "", "", "serp/live (people_also_ask_click_depth 2)", RUN); for (const p of s.paa) row(s.query, p.q, p.domain, p.url, "serp/live (people_also_ask_click_depth 2)", RUN); }
  end();
  checkpoint("1 (Google results, People Also Ask)");

  // Step 2
  const first6 = serps.slice(0, 6); const urls: string[] = [];
  for (const s of first6) for (const o of s.organic.slice(0, 5)) if (o.url && !urls.includes(o.url)) urls.push(o.url);
  const pages = await pool(urls, 4, (u) => page(creds, u));
  const cols = ["url", "domain", "word_count", "title", "main_heading", "h2_count", "schema_types", "internal_links", "external_links", "author_shown", "date_shown", "note", "source", "date"];
  block("2_ranking_pages", cols);
  for (const p of pages) row(p.url, hostOf(p.url), p.words ?? "no data", p.title, p.h1, p.h2 ?? "no data", p.schema == null ? "no data" : (p.schema.join(" | ") || "none found"), p.internal ?? "no data", p.external ?? "no data", p.author, p.date, p.err ?? "", "on_page/instant_pages + on_page/raw_html (types, author, date read from the stored page, nothing copied)", RUN);
  end();
  checkpoint("2 (ranking pages)");

  // Step 3
  const own = await pool(OWN_PAGES, 2, (u) => page(creds, u));
  block("3_own_pages", cols);
  for (const p of own) row(p.url, hostOf(p.url), p.words ?? "no data", p.title, p.h1, p.h2 ?? "no data", p.schema == null ? "no data" : (p.schema.join(" | ") || "none found"), p.internal ?? "no data", p.external ?? "no data", p.author, p.date, p.err ?? "", "on_page/instant_pages + on_page/raw_html", RUN);
  end();
  checkpoint("3 (our pages)");

  // Step 4
  const tally = new Map<string, number>();
  for (const s of serps) for (const d of new Set([...s.organic.map((o) => o.domain), ...s.aiRefs.map((r) => r.domain), ...s.paa.map((p) => p.domain)].filter(Boolean))) if (!d.endsWith(OURS)) tally.set(d, (tally.get(d) ?? 0) + 1);
  const rawTop = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const top5 = rawTop.filter(([d]) => !PLATFORMS.test(d + ".")).slice(0, 5).map(([d]) => d);
  block("4a_domain_tally", ["domain", "queries_it_appears_in", "used_for_links", "note"]);
  for (const [d, c] of rawTop.slice(0, 20)) row(d, c, top5.includes(d) ? "yes" : "no", PLATFORMS.test(d + ".") ? "platform, not a competitor: skipped for the link check" : "");
  end();
  const targets = [...top5, OURS];
  const sums = await pool(targets, 3, async (d) => { try { const { result } = await task(creds, "/backlinks/summary/live", [{ target: d, internal_list_limit: 5, backlinks_status_type: "live" }]); const r = result?.[0]; return { d, rank: n(r?.rank), backlinks: n(r?.backlinks), refdoms: n(r?.referring_domains), err: "" }; } catch (e) { return { d, rank: null, backlinks: null, refdoms: null, err: String(e).slice(0, 100) }; } });
  block("4b_backlink_summary", ["domain", "referring_domains", "total_backlinks", "domain_rank_0_1000", "error", "source", "date"]);
  for (const s of sums) row(s.d, s.refdoms ?? "no data", s.backlinks ?? "no data", s.rank ?? "no data", s.err, "backlinks/summary/live (live links)", RUN);
  end();
  const comps = sums.filter((s) => s.d !== OURS && s.refdoms != null).sort((a, b) => (b.refdoms ?? 0) - (a.refdoms ?? 0)).slice(0, 3).map((s) => s.d);
  const linkTargets: Array<{ d: string; rank: number | null; links: string[]; kind: string }> = [];
  if (comps.length >= 2) {
    try {
      const targetsObj: Record<string, string> = {}; comps.forEach((c, i) => { targetsObj[String(i + 1)] = c; });
      const { result } = await task(creds, "/backlinks/domain_intersection/live", [{ targets: targetsObj, exclude_targets: [OURS], intersection_mode: "partial", include_subdomains: true, exclude_internal_backlinks: true, limit: 1000, order_by: ["1.rank,desc"] }]);
      for (const it of result?.[0]?.items ?? []) {
        const di = it?.domain_intersection ?? {}; const keys = Object.keys(di);
        if (keys.length < 2) continue;
        const d = dom(String(di[keys[0]!]?.target ?? "")); if (!d) continue;
        const rank = Math.max(...keys.map((k) => n(di[k]?.rank) ?? 0));
        linkTargets.push({ d, rank, links: keys.map((k) => comps[Number(k) - 1]!).filter(Boolean), kind: typeOf(d) });
      }
      linkTargets.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
    } catch (e) { console.log(`# domain_intersection failed: ${String(e).slice(0, 160)}`); }
  } else console.log("# fewer than two competitor domains had backlink data, so no intersection was run");
  block("4c_link_targets", ["referring_domain", "domain_rank", "links_to_n_of_3", "links_to", "kind", "links_to_integrus", "source", "date"]);
  if (!linkTargets.length) row("no data", "", "", "", "", "", "backlinks/domain_intersection/live", RUN);
  for (const t of linkTargets.slice(0, 40)) row(t.d, t.rank ?? "", t.links.length, t.links.join(" | "), t.kind, "no", `backlinks/domain_intersection/live (partial mode, competitors: ${comps.join(", ")}; Integrus excluded)`, RUN);
  end();
  checkpoint("4 (links)");

  // Step 5
  const byQ = new Map<string, { qs: Set<string>; text: string; doms: string[] }>();
  for (const s of serps) for (const p of s.paa) { const k = norm(p.q); const e = byQ.get(k) ?? { qs: new Set<string>(), text: p.q, doms: [] }; e.qs.add(s.query); if (p.domain) e.doms.push(p.domain); byQ.set(k, e); }
  block("5a_paa_in_3_or_more_queries", ["question", "n_queries", "queries", "domains_answering", "source", "date"]);
  const repeated = [...byQ.values()].filter((e) => e.qs.size >= 3).sort((a, b) => b.qs.size - a.qs.size);
  if (!repeated.length) row("no data: no question appeared under three or more queries", "", "", "", "serp/live people_also_ask", RUN);
  for (const e of repeated) row(e.text, e.qs.size, [...e.qs].join(" | "), [...new Set(e.doms)].join(" | "), "serp/live people_also_ask", RUN);
  end();
  block("5b_hub_sections", ["section", "n_questions", "questions", "best_answering_domain", "answers_by_that_domain", "source", "date"]);
  for (const [name, rx] of SECTIONS) {
    const qs = [...byQ.values()].filter((e) => rx.test(e.text));
    const dc = new Map<string, number>(); qs.forEach((e) => e.doms.forEach((d) => dc.set(d, (dc.get(d) ?? 0) + 1)));
    const best = [...dc.entries()].sort((a, b) => b[1] - a[1])[0];
    row(name, qs.length, qs.slice(0, 12).map((e) => e.text).join(" || "), best?.[0] ?? "no data", best?.[1] ?? "", "serp/live people_also_ask (sections matched by wording, a question can sit in two)", RUN);
  }
  end();
  const ok = pages.filter((p) => p.words != null);
  block("5c_top_page_medians", ["pages_read", "median_word_count", "median_h2_count", "median_internal_links", "median_external_links", "pages_with_author", "pages_with_date", "pages_with_schema", "source", "date"]);
  row(ok.length, median(ok.map((p) => p.words!)) ?? "no data", median(ok.filter((p) => p.h2 != null).map((p) => p.h2!)) ?? "no data", median(ok.filter((p) => p.internal != null).map((p) => p.internal!)) ?? "no data", median(ok.filter((p) => p.external != null).map((p) => p.external!)) ?? "no data", ok.filter((p) => p.author === "yes").length, ok.filter((p) => p.date === "yes").length, ok.filter((p) => (p.schema ?? []).length).length, "on_page/instant_pages", RUN);
  end();
  const st = new Map<string, number>(); ok.forEach((p) => (p.schema ?? []).forEach((t) => st.set(t, (st.get(t) ?? 0) + 1)));
  block("5d_schema_types", ["schema_type", "pages_using_it", "of_pages_read", "source", "date"]);
  if (!st.size) row("no data", "", ok.length, "on_page/raw_html", RUN);
  for (const [t, c] of [...st.entries()].sort((a, b) => b[1] - a[1])) row(t, c, ok.length, "on_page/raw_html (ld+json types)", RUN);
  end();
  const nodata: string[] = [];
  serps.forEach((s) => { if (s.err) nodata.push(`SERP failed for "${s.query}": ${s.err}`); else { if (!s.paa.length) nodata.push(`no People Also Ask for "${s.query}"`); if (!s.aiPresent) nodata.push(`no AI Overview for "${s.query}"`); } });
  [...pages, ...own].forEach((p) => { if (p.err || p.words == null) nodata.push(`${p.url}: ${p.err ?? "no word count"}`); else if (p.schema == null) nodata.push(`${p.url}: schema, author and date not readable`); });
  sums.forEach((s) => { if (s.refdoms == null) nodata.push(`backlink summary for ${s.d}: ${s.err || "no data"}`); });
  if (!linkTargets.length) nodata.push("domain intersection returned no referring domains");
  json("summary", { spent, calls, steps: stage, ceiling: CEILING, balanceBefore: bal, top5, competitorsForIntersection: comps, queriesRun: QUERIES.length, pagesAnalysed: pages.length + own.length, noData: nodata });
  const bal1 = await dfs(creds, "GET", "/appendix/user_data").then((j) => n(j?.tasks?.[0]?.result?.[0]?.money?.balance)).catch(() => null);
  console.log(`\nDONE · ${calls} calls · spent (sum of response cost fields) $${spent.toFixed(4)} · balance before $${bal.toFixed(2)} · after ${bal1 == null ? "n/a" : "$" + bal1.toFixed(2)}`);
  console.log("# returned no data:\n" + (nodata.length ? nodata.map((x) => "#  - " + x).join("\n") : "#  - nothing"));
})().catch((e) => { console.error(`\nFAILED after ${calls} calls, $${spent.toFixed(4)}: ${e instanceof Error ? e.stack || e.message : String(e)}`); process.exit(1); });

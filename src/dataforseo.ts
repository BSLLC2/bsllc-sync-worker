import "dotenv/config";

/**
 * Thin DataForSEO API client. Two surfaces we use:
 *   • SERP API (Google organic, live/advanced) — for keyword rank tracking.
 *   • AI Optimization API (LLM responses, live) — for AEO / AI-answer visibility.
 *
 * Auth is HTTP Basic with the API login + password (NOT the account email/pass).
 * Pay-as-you-go; the SERP standard queue is ~$0.60/1000 and LLM responses are
 * base + tokens per request. Credentials come from repo secrets:
 *   DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
 */

const BASE = "https://api.dataforseo.com/v3";

export interface DfsCreds {
  login: string;
  password: string;
}

export function credsFromEnv(): DfsCreds {
  const login = (process.env.DATAFORSEO_LOGIN || "").trim();
  const password = (process.env.DATAFORSEO_PASSWORD || "").trim();
  if (!login || !password) {
    throw new Error("Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD. Add them as repo secrets.");
  }
  return { login, password };
}

function authHeader(c: DfsCreds): string {
  return "Basic " + Buffer.from(`${c.login}:${c.password}`).toString("base64");
}

async function post<T = any>(creds: DfsCreds, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: authHeader(creds) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DataForSEO ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// ── SERP rank tracking ────────────────────────────────────────────────────

export interface SerpTask {
  keyword: string;
  /** DataForSEO location spec, e.g. "United States" or "Chicago,Illinois,United States". */
  locationName: string;
  /** e.g. "English" (DataForSEO language_name). */
  languageName?: string;
  device?: "desktop" | "mobile";
}

export interface SerpResult {
  keyword: string;
  /** 1-based absolute rank of the tracked domain, or null if not found in the pulled depth. */
  rank: number | null;
  /** Whether the SERP showed an AI Overview block (a signal the query is AEO-relevant). */
  aiOverview: boolean;
  error: string | null;
}

/** Does an organic result's domain/url belong to the tracked domain? */
function domainMatches(target: string, itemDomain?: string, itemUrl?: string): boolean {
  const t = target.toLowerCase().replace(/^www\./, "");
  const d = (itemDomain || "").toLowerCase().replace(/^www\./, "");
  if (d && (d === t || d.endsWith(`.${t}`))) return true;
  try {
    if (itemUrl) {
      const host = new URL(itemUrl).hostname.toLowerCase().replace(/^www\./, "");
      return host === t || host.endsWith(`.${t}`);
    }
  } catch {
    /* ignore malformed url */
  }
  return false;
}

/**
 * Look up organic rank for a batch of keywords in one call (live/advanced accepts
 * up to 100 tasks). Returns one SerpResult per input task, aligned by keyword.
 * `domain` is the tracked domain (bare host). Depth 100 = first ten pages.
 */
export async function serpRanks(
  creds: DfsCreds,
  domain: string,
  tasks: SerpTask[],
): Promise<SerpResult[]> {
  if (!tasks.length) return [];
  const payload = tasks.map((t) => ({
    keyword: t.keyword,
    location_name: t.locationName,
    language_name: t.languageName || "English",
    device: t.device || "desktop",
    depth: 100,
  }));
  const resp = await post(creds, "/serp/google/organic/live/advanced", payload);
  const out: SerpResult[] = [];
  const respTasks: any[] = Array.isArray(resp?.tasks) ? resp.tasks : [];
  tasks.forEach((t, i) => {
    const rt = respTasks[i];
    if (!rt || rt.status_code !== 20000) {
      out.push({ keyword: t.keyword, rank: null, aiOverview: false, error: rt?.status_message || "no task result" });
      return;
    }
    const result = Array.isArray(rt.result) ? rt.result[0] : null;
    const items: any[] = Array.isArray(result?.items) ? result.items : [];
    let rank: number | null = null;
    let aiOverview = false;
    for (const it of items) {
      if (it?.type === "ai_overview") aiOverview = true;
      if (it?.type === "organic" && rank == null && domainMatches(domain, it.domain, it.url)) {
        rank = typeof it.rank_absolute === "number" ? it.rank_absolute : (typeof it.rank_group === "number" ? it.rank_group : null);
      }
    }
    out.push({ keyword: t.keyword, rank, aiOverview, error: null });
  });
  return out;
}

// ── AEO / AI-answer visibility ───────────────────────────────────────────

/** DataForSEO AI Optimization providers we query, mapped to their path segment. */
export const AEO_PROVIDERS: Record<string, string> = {
  chatgpt: "chat_gpt",
  gemini: "gemini",
  perplexity: "perplexity",
};

export interface AeoResult {
  prompt: string;
  provider: string;
  /** Brand name appeared anywhere in the answer text. */
  mentioned: boolean;
  /** The tracked domain was cited (link/annotation) in the answer. */
  cited: boolean;
  error: string | null;
}

/** Pull raw answer text + any citation urls from an LLM-responses result item. */
function extractAnswer(result: any): { text: string; urls: string[] } {
  const items: any[] = Array.isArray(result?.items) ? result.items : [];
  let text = "";
  const urls: string[] = [];
  for (const it of items) {
    if (typeof it?.text === "string") text += " " + it.text;
    if (typeof it?.content === "string") text += " " + it.content;
    // Annotations / citations carry source urls under a few possible shapes.
    for (const key of ["annotations", "citations", "sources", "references"]) {
      const arr = it?.[key];
      if (Array.isArray(arr)) {
        for (const a of arr) {
          const u = a?.url || a?.link || a?.source || (typeof a === "string" ? a : null);
          if (typeof u === "string") urls.push(u);
        }
      }
    }
  }
  return { text: text.trim(), urls };
}

function hostMatches(target: string, url: string): boolean {
  const t = target.toLowerCase().replace(/^www\./, "");
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host === t || host.endsWith(`.${t}`);
  } catch {
    return url.toLowerCase().includes(t);
  }
}

/**
 * Ask one provider a single prompt and detect whether the brand is mentioned /
 * the domain cited. Errors are captured per-call, never thrown, so one bad
 * provider doesn't sink the whole run.
 */
export async function aeoCheck(
  creds: DfsCreds,
  provider: string,
  prompt: string,
  brand: string,
  domain: string | null,
): Promise<AeoResult> {
  const seg = AEO_PROVIDERS[provider] || provider;
  try {
    const payload = [{ user_prompt: prompt, web_search: true }];
    const resp = await post(creds, `/ai_optimization/${seg}/llm_responses/live`, payload);
    const rt = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
    if (!rt || rt.status_code !== 20000) {
      return { prompt, provider, mentioned: false, cited: false, error: rt?.status_message || "no task result" };
    }
    const result = Array.isArray(rt.result) ? rt.result[0] : null;
    const { text, urls } = extractAnswer(result);
    const mentioned = brand.trim().length > 0 && text.toLowerCase().includes(brand.trim().toLowerCase());
    const cited = Boolean(domain && urls.some((u) => hostMatches(domain, u)));
    return { prompt, provider, mentioned, cited, error: null };
  } catch (e) {
    return { prompt, provider, mentioned: false, cited: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Keyword research (DataForSEO Labs) ──────────────────────────────────────

/** Main search intent, normalized to the four buckets the app understands. */
export type SearchIntent = "informational" | "commercial" | "transactional" | "navigational";

/**
 * A single keyword idea, matching the exact shape the app expects inside a
 * research_requests.result_json array. Every field is defensively nullable —
 * DataForSEO may omit any of the underlying sub-objects.
 */
export interface KeywordIdea {
  keyword: string;
  volume: number | null;
  cpc: number | null;
  competition: number | null;
  /** SEO keyword difficulty, 0–100 (KD). */
  difficulty: number | null;
  intent: SearchIntent | null;
  /** SERP feature / item types present, e.g. ["local_pack","people_also_ask"]. */
  serpFeatures: string[] | null;
}

/** Coerce a value to a finite number or null. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Normalize DataForSEO's main_intent string to one of our four buckets, else null. */
function normIntent(v: unknown): SearchIntent | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "informational" || s === "commercial" || s === "transactional" || s === "navigational") return s;
  return null;
}

/** Pull a clean string[] of SERP feature/item types, or null when absent. */
function serpTypes(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return out.length ? out : null;
}

/**
 * Map one Labs item (keyword_ideas / ranked_keywords share the same nested
 * sub-objects, sometimes under `keyword_data`) to the full KeywordIdea contract.
 */
function toKeywordIdea(it: any): KeywordIdea {
  const kd = it?.keyword_data ?? it ?? {};
  const info = kd?.keyword_info ?? {};
  const props = kd?.keyword_properties ?? {};
  const intentInfo = kd?.search_intent_info ?? {};
  const serpInfo = kd?.serp_info ?? {};
  return {
    keyword: kd?.keyword ?? it?.keyword ?? "",
    volume: num(info.search_volume),
    cpc: num(info.cpc),
    competition: num(info.competition),
    difficulty: num(props.keyword_difficulty),
    intent: normIntent(intentInfo.main_intent),
    serpFeatures: serpTypes(serpInfo.serp_item_types),
  };
}

/**
 * Keyword ideas for a seed term — the SEMrush "keyword magic" replacement.
 * Uses DataForSEO Labs keyword_ideas (Google). Returns related keywords with
 * monthly search volume, CPC, competition (0–1), keyword difficulty, main
 * search intent, and the SERP features present — sorted by volume desc.
 *
 * Endpoint: POST /v3/dataforseo_labs/google/keyword_ideas/live
 */
export async function keywordResearch(
  creds: DfsCreds,
  seed: string,
  locationName = "United States",
  languageName = "English",
  limit = 100,
): Promise<KeywordIdea[]> {
  const payload = [{ keywords: [seed], location_name: locationName, language_name: languageName, limit, order_by: ["keyword_info.search_volume,desc"] }];
  const resp = await post(creds, "/dataforseo_labs/google/keyword_ideas/live", payload);
  const rt = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
  if (!rt || rt.status_code !== 20000) throw new Error(rt?.status_message || "DataForSEO returned no result");
  const result = Array.isArray(rt.result) ? rt.result[0] : null;
  const items: any[] = Array.isArray(result?.items) ? result.items : [];
  return items.map(toKeywordIdea).filter((k) => k.keyword);
}

/** One keyword a domain already ranks for — powers the "current rankings" view. */
export interface RankedKeyword {
  keyword: string;
  /** Absolute SERP rank (ranked_serp_element.rank_absolute), or null. */
  rank: number | null;
  volume: number | null;
  difficulty: number | null;
  intent: SearchIntent | null;
  /** The ranking URL on the target domain, or null. */
  url: string | null;
}

/**
 * Keywords a domain already ranks for, with each keyword's live SERP position.
 * Uses DataForSEO Labs ranked_keywords (Google). Sorted by search volume desc.
 *
 * Endpoint: POST /v3/dataforseo_labs/google/ranked_keywords/live
 */
export async function rankedKeywords(
  creds: DfsCreds,
  domain: string,
  locationName = "United States",
  languageName = "English",
  limit = 100,
): Promise<RankedKeyword[]> {
  const target = domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const payload = [{ target, location_name: locationName, language_name: languageName, limit, order_by: ["keyword_data.keyword_info.search_volume,desc"] }];
  const resp = await post(creds, "/dataforseo_labs/google/ranked_keywords/live", payload);
  const rt = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
  if (!rt || rt.status_code !== 20000) throw new Error(rt?.status_message || "DataForSEO returned no result");
  const result = Array.isArray(rt.result) ? rt.result[0] : null;
  const items: any[] = Array.isArray(result?.items) ? result.items : [];
  return items.map((it) => {
    const base = toKeywordIdea(it);
    const rse = it?.ranked_serp_element ?? {};
    const serpItem = rse?.serp_item ?? {};
    return {
      keyword: base.keyword,
      rank: num(serpItem.rank_absolute) ?? num(rse.rank_absolute),
      volume: base.volume,
      difficulty: base.difficulty,
      intent: base.intent,
      url: typeof serpItem.url === "string" ? serpItem.url : null,
    } as RankedKeyword;
  }).filter((k) => k.keyword);
}

/** A gap keyword: one a competitor ranks for that the client does not. */
export interface GapKeyword extends KeywordIdea {
  /** The competitor's absolute SERP position for this keyword. */
  competitorRank: number | null;
}

/** Bare, lowercased keyword for set membership (so "Foo Bar" == "foo  bar"). */
function normKw(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Competitor keyword gap: keywords the competitor domain ranks for (top of the
 * SERP) that the CLIENT domain does not rank for at all. This is the "are we
 * even targeting the right terms?" tool — it surfaces demand the client is
 * missing rather than mirroring whatever they happen to rank for today.
 *
 * Two Labs ranked_keywords pulls (competitor + client), diffed in memory. The
 * competitor rows come back as full KeywordIdea (volume/cpc/difficulty/intent)
 * plus the competitor's position, sorted by search volume desc.
 *
 * Endpoint: POST /v3/dataforseo_labs/google/ranked_keywords/live (×2)
 */
export async function keywordGap(
  creds: DfsCreds,
  clientDomain: string,
  competitorDomain: string,
  locationName = "United States",
  languageName = "English",
  competitorTopN = 50,
  limit = 150,
): Promise<GapKeyword[]> {
  const clean = (d: string) => d.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const client = clean(clientDomain);
  const competitor = clean(competitorDomain);

  async function ranked(target: string, take: number): Promise<any[]> {
    const payload = [{ target, location_name: locationName, language_name: languageName, limit: take, order_by: ["keyword_data.keyword_info.search_volume,desc"] }];
    const resp = await post(creds, "/dataforseo_labs/google/ranked_keywords/live", payload);
    const rt = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
    if (!rt || rt.status_code !== 20000) throw new Error(rt?.status_message || "DataForSEO returned no ranked keywords");
    const result = Array.isArray(rt.result) ? rt.result[0] : null;
    return Array.isArray(result?.items) ? result.items : [];
  }

  // Pull the client's footprint wide so the "does the client rank?" test is
  // fair, and the competitor's top terms as the candidate pool.
  const [competitorItems, clientItems] = await Promise.all([
    ranked(competitor, 700),
    ranked(client, 1000),
  ]);

  const clientKws = new Set(clientItems.map((it) => normKw(toKeywordIdea(it).keyword)).filter(Boolean));

  const gaps: GapKeyword[] = [];
  for (const it of competitorItems) {
    const idea = toKeywordIdea(it);
    if (!idea.keyword) continue;
    if (clientKws.has(normKw(idea.keyword))) continue; // client already ranks — not a gap
    const rse = it?.ranked_serp_element ?? {};
    const serpItem = rse?.serp_item ?? {};
    const rank = num(serpItem.rank_absolute) ?? num(rse.rank_absolute);
    if (rank != null && rank > competitorTopN) continue; // only real competitor wins
    gaps.push({ ...idea, competitorRank: rank });
  }
  // Sort by search volume desc (the app re-sorts by Opportunity by default).
  gaps.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  return gaps.slice(0, limit);
}

// ── Domain authority / backlinks (Backlinks + Labs) ─────────────────────────

/** Aggregate authority signals for a domain — the SEMrush overview replacement. */
export interface DomainAuthority {
  /** Domain rank / authority score, 0–1000 (DataForSEO's backlink `rank`). */
  authorityScore: number | null;
  backlinks: number | null;
  referringDomains: number | null;
  /** Estimated monthly organic traffic (Labs organic `etv`). */
  organicTraffic: number | null;
  /** Number of organic keywords the domain ranks for. */
  keywordCount: number | null;
}

/**
 * Backlink summary for a domain: authority `rank`, total backlinks, and
 * referring domains. Endpoint: POST /v3/backlinks/summary/live
 */
export async function backlinksSummary(
  creds: DfsCreds,
  domain: string,
): Promise<{ authorityScore: number | null; backlinks: number | null; referringDomains: number | null }> {
  const target = domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const payload = [{ target, internal_list_limit: 10, backlinks_status_type: "live" }];
  const resp = await post(creds, "/backlinks/summary/live", payload);
  const rt = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
  if (!rt || rt.status_code !== 20000) throw new Error(rt?.status_message || "DataForSEO returned no backlink summary");
  const r = Array.isArray(rt.result) ? rt.result[0] : null;
  return {
    authorityScore: num(r?.rank),
    backlinks: num(r?.backlinks),
    referringDomains: num(r?.referring_domains),
  };
}

/**
 * Organic traffic + keyword-count estimate for a domain.
 * Endpoint: POST /v3/dataforseo_labs/google/domain_rank_overview/live
 */
export async function domainRankOverview(
  creds: DfsCreds,
  domain: string,
  locationName = "United States",
  languageName = "English",
): Promise<{ organicTraffic: number | null; keywordCount: number | null }> {
  const target = domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const payload = [{ target, location_name: locationName, language_name: languageName }];
  const resp = await post(creds, "/dataforseo_labs/google/domain_rank_overview/live", payload);
  const rt = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
  if (!rt || rt.status_code !== 20000) throw new Error(rt?.status_message || "DataForSEO returned no domain overview");
  const result = Array.isArray(rt.result) ? rt.result[0] : null;
  const item = Array.isArray(result?.items) ? result.items[0] : null;
  const organic = item?.metrics?.organic ?? {};
  return {
    organicTraffic: num(organic.etv),
    keywordCount: num(organic.count),
  };
}

/** Convenience: pull the full DomainAuthority bundle in one call. */
export async function domainAuthority(
  creds: DfsCreds,
  domain: string,
  locationName = "United States",
  languageName = "English",
): Promise<DomainAuthority> {
  const [bl, ov] = await Promise.all([
    backlinksSummary(creds, domain),
    domainRankOverview(creds, domain, locationName, languageName),
  ]);
  return { ...bl, organicTraffic: ov.organicTraffic, keywordCount: ov.keywordCount };
}

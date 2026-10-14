import "dotenv/config";
import { judgeIdeas, type IdeaJudgement } from "./ads/idea-relevance.js";
import { isNational, placeLabel, UNITED_STATES } from "./research-location.js";
import { containAndCap, containsAllWords, judgingInputs, perSeedLimit, providerSeeds } from "./ads/idea-seeds.js";

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
  /** The address the engine returned for the tracked domain at `rank`. Null where the domain was not found
   *  or the check failed. Optional so a result built elsewhere (a test, an older caller) need not carry it. */
  url?: string | null;
  error: string | null;
}

/** An address worth keeping: http(s), no credentials, no longer than a database should hold. */
export function cleanRankingUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
    u.hash = "";
    const out = u.toString();
    return out.length <= 500 ? out : null;
  } catch { return null; }
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

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Look up organic rank for one keyword at a time — the live/advanced endpoint
 * only processes a SINGLE task per call despite accepting an array (multi-task
 * batching is a standard-queue/task_post feature, not live). Sending N tasks in
 * one call silently resolves only tasks[0]; every other keyword comes back with
 * a non-20000 status and rank: null, which then renders in the client report as
 * "Not ranked" for keywords we never actually checked. Run with bounded
 * concurrency instead (DataForSEO allows 2,000 calls/min, so even 100 keywords
 * is nothing). `domain` is the tracked domain (bare host). Depth 100 = first
 * ten pages.
 */
export async function serpRanks(
  creds: DfsCreds,
  domain: string,
  tasks: SerpTask[],
): Promise<SerpResult[]> {
  if (!tasks.length) return [];
  return mapWithConcurrency(tasks, 8, async (t): Promise<SerpResult> => {
    try {
      const resp = await post(creds, "/serp/google/organic/live/advanced", [{
        keyword: t.keyword,
        location_name: t.locationName,
        language_name: t.languageName || "English",
        device: t.device || "desktop",
        depth: 100,
      }]);
      const rt = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
      if (!rt || rt.status_code !== 20000) {
        return { keyword: t.keyword, rank: null, aiOverview: false, error: rt?.status_message || "no task result" };
      }
      const result = Array.isArray(rt.result) ? rt.result[0] : null;
      const items: any[] = Array.isArray(result?.items) ? result.items : [];
      let rank: number | null = null;
      let rankingUrl: string | null = null;
      let aiOverview = false;
      for (const it of items) {
        if (it?.type === "ai_overview") aiOverview = true;
        if (it?.type === "organic" && rank == null && domainMatches(domain, it.domain, it.url)) {
          rank = typeof it.rank_absolute === "number" ? it.rank_absolute : (typeof it.rank_group === "number" ? it.rank_group : null);
          // The same result that gave the position gave the address. It used to be
          // thrown away; it is the page that should be improved.
          rankingUrl = cleanRankingUrl(it.url);
        }
      }
      return { keyword: t.keyword, rank, aiOverview, url: rankingUrl, error: null };
    } catch (e) {
      return { keyword: t.keyword, rank: null, aiOverview: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

// ── AEO / AI-answer visibility ───────────────────────────────────────────

/** DataForSEO AI Optimization providers we query, mapped to their path segment. */
export const AEO_PROVIDERS: Record<string, string> = {
  chatgpt: "chat_gpt",
  gemini: "gemini",
  perplexity: "perplexity",
};

/**
 * model_name is required by the llm_responses/live endpoint — DataForSEO
 * resolves a family name (e.g. "gpt-4.1-mini") to its latest version, so
 * these don't need updating every time a provider ships a new snapshot.
 * Overridable per provider via env var in case DataForSEO retires one.
 */
const AEO_MODEL_NAME: Record<string, string> = {
  chatgpt: process.env.AEO_MODEL_CHATGPT || "gpt-4.1-mini",
  gemini: process.env.AEO_MODEL_GEMINI || "gemini-2.5-pro",
  perplexity: process.env.AEO_MODEL_PERPLEXITY || "sonar",
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
    const payload = [{ user_prompt: prompt, model_name: AEO_MODEL_NAME[provider] || AEO_MODEL_NAME.chatgpt, web_search: true }];
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

/**
 * Exact-phrase keyword metrics — search volume, CPC, competition (Keywords
 * Data API) merged with keyword difficulty (Labs bulk_keyword_difficulty).
 *
 * This is deliberately NOT keywordResearch(). That endpoint expands a seed
 * topically (Google's "related ideas"), so a location-qualified seed like
 * "property management cincinnati" comes back full of nationally-popular,
 * geography-blind noise ("rental cars", "porta potty rental") with the local
 * intent stripped out. Use this instead whenever the caller already has the
 * exact phrases to check — a curated list, a client's existing sheet, a
 * competitor's ranked terms — and wants real volume/difficulty for THOSE
 * phrases, not Google's idea of a related topic.
 *
 * Endpoints: POST /v3/keywords_data/google_ads/search_volume/live
 *            POST /v3/dataforseo_labs/google/bulk_keyword_difficulty/live
 * Both accept up to 1000 keywords per call; intent/serpFeatures are not
 * returned by either endpoint and come back null (honest gap, not guessed).
 */
export async function bulkKeywordMetrics(
  creds: DfsCreds,
  keywords: string[],
  locationName = "United States",
  languageName = "English",
): Promise<KeywordIdea[]> {
  const list = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))];
  if (!list.length) return [];

  const [volResp, kdResp] = await Promise.all([
    post(creds, "/keywords_data/google_ads/search_volume/live", [
      { keywords: list, location_name: locationName, language_name: languageName },
    ]),
    post(creds, "/dataforseo_labs/google/bulk_keyword_difficulty/live", [
      { keywords: list, location_name: locationName, language_name: languageName },
    ]),
  ]);

  const volTask = Array.isArray(volResp?.tasks) ? volResp.tasks[0] : null;
  if (!volTask || volTask.status_code !== 20000) {
    throw new Error(volTask?.status_message || "DataForSEO returned no search volume result");
  }
  const volItems: any[] = Array.isArray(volTask.result) ? volTask.result : [];

  const kdTask = Array.isArray(kdResp?.tasks) ? kdResp.tasks[0] : null;
  const kdResult = kdTask?.status_code === 20000 && Array.isArray(kdTask.result) ? kdTask.result[0] : null;
  const kdItems: any[] = Array.isArray(kdResult?.items) ? kdResult.items : [];
  const kdByKeyword = new Map<string, number | null>(kdItems.map((it) => [normKw(it?.keyword ?? ""), num(it?.keyword_difficulty)]));

  return volItems
    .filter((it) => it && typeof it.keyword === "string")
    .map((it) => ({
      keyword: it.keyword,
      volume: num(it.search_volume),
      cpc: num(it.cpc),
      competition: num(it.competition),
      difficulty: kdByKeyword.get(normKw(it.keyword)) ?? null,
      intent: null,
      serpFeatures: null,
    }));
}

// ── In-client keyword discovery (kind='discovery') ──────────────────────────

/** Inputs stored by the app in research_requests.params_json. */
export interface DiscoveryParams {
  seeds: string[];
  /** The first competitor. A run stored before 2026-10-14 has only this. */
  competitor: string | null;
  /** Every competitor, first one included. Present only when there is more than one. */
  competitors?: string[];
  limit: number;
}

/** Most competitors one run compares against (the app refuses more, and so do we). */
export const MAX_COMPETITORS = 3;

/** The competitors a run was given, first one first, bare hosts, deduped. */
export function competitorsOfParams(p: Pick<DiscoveryParams, "competitor" | "competitors">): string[] {
  const clean = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const raw = Array.isArray(p.competitors) && p.competitors.length ? p.competitors : p.competitor ? [p.competitor] : [];
  const out: string[] = [];
  for (const r of raw) {
    const h = typeof r === "string" ? clean(r) : "";
    if (h && !out.includes(h)) out.push(h);
  }
  return out.slice(0, MAX_COMPETITORS);
}

/** One result row — matches the app's DiscoveryKeyword type. */
export interface DiscoveryKeyword extends KeywordIdea {
  clientRank: number | null;
  competitorRank: number | null;
  /** Which competitors rank for this idea. Written from 2026-10-14. */
  competitorsRanking?: string[];
  sources: Array<"seed" | "gap">;
  /** The place this row's volume was measured in, in the provider's own form.
   *  A volume belongs to this place and is never compared with one measured
   *  somewhere else. */
  measuredIn: string | null;
  /** What the relevance gate said when the run was stored. Informational: the
   *  app judges again at read, against today's services and a person's answers. */
  relevance: {
    kept: boolean;
    via: string | null;
    source: "seed" | "service" | "tracked" | null;
    why: "no_anchor" | "blank" | null;
  };
}

/** What a run is judged against besides its own seeds. Null is unanswered:
 *  `services: null` means nobody has signed a list off, and the seeds alone are
 *  then used and the run says so. */
export interface DiscoveryGate {
  services: readonly string[] | null;
  tracked: readonly string[] | null;
  /** Words a person said to count ideas by (shared/idea-seeds.ts). */
  declaredWords?: readonly string[] | null;
}

export interface DiscoveryResult {
  rows: DiscoveryKeyword[];
  /** Sum of every task's `cost` as returned by DataForSEO (USD). */
  costUsd: number;
  /** Non-fatal problems (e.g. the competitor pull failed) — surfaced in the log. */
  warnings: string[];
  /** The place the volumes were measured in. */
  place: string;
  /** Which provider call produced the ideas. */
  source: "labs_national" | "google_ads_local";
  /** The searches the provider was asked for, one call each in a national run. */
  asked: string[];
  /** What the relevance gate did, in the words the run prints. */
  judgement: IdeaJudgement;
}

/** DataForSEO reports what each task cost in the response; read it defensively. */
function taskCost(resp: any): number {
  const t = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
  const c = typeof t?.cost === "number" ? t.cost : typeof resp?.cost === "number" ? resp.cost : 0;
  return Number.isFinite(c) ? c : 0;
}

async function getJson<T = any>(creds: DfsCreds, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: { authorization: authHeader(creds) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`DataForSEO ${path} HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The location names in a provider locations answer. Pure; exported for the guard. */
export function locationNamesFrom(resp: any): string[] | null {
  const t = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
  if (!t || t.status_code !== 20000 || !Array.isArray(t.result)) return null;
  const names = t.result
    .map((x: any) => (typeof x?.location_name === "string" ? x.location_name : null))
    .filter((n: string | null): n is string => n != null && n.length > 0);
  return names.length ? names : null;
}

/**
 * The places Google's ad tools can target, for checking a run's place before it
 * is paid for. Free to call. NULL MEANS WE COULD NOT READ THE LIST, which is
 * not the same as the place being missing from it: the run then goes ahead
 * unverified and the provider's own refusal, if there is one, becomes the
 * run's error.
 */
export async function googleAdsLocationNames(creds: DfsCreds): Promise<string[] | null> {
  for (const path of ["/keywords_data/google_ads/locations/us", "/keywords_data/google_ads/locations"]) {
    try {
      const names = locationNamesFrom(await getJson(creds, path));
      if (names) return names;
    } catch {
      // Try the next form; a failure here costs the verification and nothing else.
    }
  }
  return null;
}

/**
 * Searches that CONTAIN one seed, for the whole country: DataForSEO Labs
 * keyword_suggestions. This replaced one `keyword_ideas` call that took every
 * seed at once. That call is a semantic expansion ordered by volume, so with ten
 * seeds and a limit of 200 the 200 slots went to the biggest national head terms
 * near the seeds' words ("pvc pipe", "first american home warranty") before any
 * test of relevance ran. Here each seed is its own task and its own share of the
 * limit, and the provider returns only searches that contain the phrase.
 *
 * Endpoint: POST /v3/dataforseo_labs/google/keyword_suggestions/live
 * ONE seed a task (`keyword` is a string). Parameters used: keyword,
 * location_name, language_name, limit, include_seed_keyword, order_by. NOT
 * VERIFIED AGAINST A LIVE CALL from this repository (nothing here called the
 * endpoint before); `npm run verify-dataforseo -- --probe` fires one. No
 * provider-side `filters` are sent: nothing in this repository shows their
 * syntax, so containment is the endpoint's own and is checked again below.
 */
export async function keywordSuggestions(
  creds: DfsCreds,
  seed: string,
  locationName: string,
  languageName: string,
  limit: number,
): Promise<{ ideas: KeywordIdea[]; costUsd: number; notContained: number }> {
  const resp = await post(creds, "/dataforseo_labs/google/keyword_suggestions/live", [
    { keyword: seed, location_name: locationName, language_name: languageName, limit, include_seed_keyword: true, order_by: ["keyword_info.search_volume,desc"] },
  ]);
  const costUsd = taskCost(resp);
  const task = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
  if (!task || task.status_code !== 20000) throw new Error(task?.status_message || "DataForSEO returned no result");
  const result = Array.isArray(task.result) ? task.result[0] : null;
  const items: any[] = Array.isArray(result?.items) ? result.items : [];
  const all = items.map(toKeywordIdea).filter((k) => k.keyword);
  // The endpoint promises phrases that contain the seed. Check it: an idea that
  // does not is not stored, and the count is reported so a change in what the
  // provider returns is seen rather than absorbed.
  const ideas = all.filter((k) => containsAllWords(k.keyword, seed));
  return { ideas, costUsd, notContained: all.length - ideas.length };
}

/**
 * Ideas for a place below the country: Google Keyword Planner's own related
 * ideas, through the Keywords Data API, which takes a city. The Labs
 * `keyword_ideas` call used for the whole country measures nationally, and a
 * national volume is not what people near the client search.
 *
 * Endpoint: POST /v3/keywords_data/google_ads/keywords_for_keywords/live (up to
 * 20 seeds a task). It returns volume, CPC and competition; it returns no
 * keyword difficulty and no intent, which are left null here (a gap, never a
 * guess) and difficulty is filled for the ideas that are KEPT only.
 */
export async function keywordIdeasLocal(
  creds: DfsCreds,
  seeds: string[],
  locationName: string,
  languageName: string,
): Promise<{ ideas: KeywordIdea[]; costUsd: number }> {
  const resp = await post(creds, "/keywords_data/google_ads/keywords_for_keywords/live", [
    { keywords: seeds.slice(0, 20), location_name: locationName, language_name: languageName, sort_by: "search_volume" },
  ]);
  const costUsd = taskCost(resp);
  const task = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
  if (!task || task.status_code !== 20000) throw new Error(task?.status_message || "DataForSEO returned no result");
  const items: any[] = Array.isArray(task.result) ? task.result : [];
  const ideas = items
    .filter((it) => it && typeof it.keyword === "string" && it.keyword.trim().length > 0)
    .map((it): KeywordIdea => ({
      keyword: it.keyword,
      volume: num(it.search_volume),
      cpc: num(it.cpc),
      competition: num(it.competition_index) != null ? (num(it.competition_index) as number) / 100 : null,
      difficulty: null,
      intent: null,
      serpFeatures: null,
    }));
  return { ideas, costUsd };
}

/** Monthly searches and CPC for exact phrases in one place. Pure parse is the
 *  loop below; the call is one task. A phrase the provider returns nothing for
 *  comes back absent, and absent is unanswered. */
async function localVolumes(
  creds: DfsCreds,
  keywords: string[],
  locationName: string,
  languageName: string,
): Promise<{ byKeyword: Map<string, { volume: number | null; cpc: number | null }>; costUsd: number }> {
  const list = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].slice(0, 1000);
  const byKeyword = new Map<string, { volume: number | null; cpc: number | null }>();
  if (!list.length) return { byKeyword, costUsd: 0 };
  const resp = await post(creds, "/keywords_data/google_ads/search_volume/live", [
    { keywords: list, location_name: locationName, language_name: languageName },
  ]);
  const task = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
  if (!task || task.status_code !== 20000) throw new Error(task?.status_message || "DataForSEO returned no search volume result");
  const items: any[] = Array.isArray(task.result) ? task.result : [];
  for (const it of items) {
    if (typeof it?.keyword === "string") byKeyword.set(normKw(it.keyword), { volume: num(it.search_volume), cpc: num(it.cpc) });
  }
  return { byKeyword, costUsd: taskCost(resp) };
}

/** Keyword difficulty for exact phrases. It is a country-level measure, so it
 *  is always asked for the whole country. */
async function difficultyFor(
  creds: DfsCreds,
  keywords: string[],
  languageName: string,
): Promise<{ byKeyword: Map<string, number | null>; costUsd: number }> {
  const list = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].slice(0, 1000);
  const byKeyword = new Map<string, number | null>();
  if (!list.length) return { byKeyword, costUsd: 0 };
  const resp = await post(creds, "/dataforseo_labs/google/bulk_keyword_difficulty/live", [
    { keywords: list, location_name: UNITED_STATES, language_name: languageName },
  ]);
  const task = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
  const result = task?.status_code === 20000 && Array.isArray(task.result) ? task.result[0] : null;
  const items: any[] = Array.isArray(result?.items) ? result.items : [];
  for (const it of items) byKeyword.set(normKw(it?.keyword ?? ""), num(it?.keyword_difficulty));
  return { byKeyword, costUsd: taskCost(resp) };
}

/**
 * The SEO tab's "Keyword research" run.
 *
 * ── WHERE IT SEARCHES, AND WHY THERE ARE TWO PATHS ─────────────────────────
 *
 * `locationName` arrives already resolved to the provider's own form (see
 * src/research-provider-location.ts). For the WHOLE COUNTRY it is the original
 * three Labs calls. For any smaller place it is the Keywords Data call that
 * accepts a city, because the Labs ideas call measures at country level and a
 * national volume was what priced a Cincinnati provider's research. In that path
 * the client's footprint and the competitor's are still read from Labs, whose
 * ranking data is country-level, so a position is the national one and the run
 * says so; every VOLUME in the run is for the place the run names, and a row
 * whose volume came from anywhere else is re-measured in that place or has its
 * volume left blank. A run never mixes two places in one column.
 *
 * ── WHAT IT KEEPS ──────────────────────────────────────────────────────────
 *
 * Every idea is judged by src/ads/idea-relevance.ts against the seeds, the
 * client's signed-off services and its tracked searches. NOTHING IS DELETED:
 * every idea is stored and flagged, so a person can keep one the rule set
 * aside. What the flag changes is cost and trust. In the local path keyword
 * difficulty is bought for the kept ideas only, and no reading treats a
 * set-aside idea as demand the client sells into.
 *
 * Cost is the sum of what DataForSEO says each task cost, so the UI can show
 * estimate vs actual. The client/competitor pulls are best-effort: if one fails
 * the run still returns the ideas, with the failure recorded in `warnings`.
 *
 * Endpoints (country): POST /v3/dataforseo_labs/google/keyword_ideas/live
 *                      POST /v3/dataforseo_labs/google/ranked_keywords/live (×0–2)
 * Endpoints (place):   POST /v3/keywords_data/google_ads/keywords_for_keywords/live
 *                      POST /v3/keywords_data/google_ads/search_volume/live (gap rows)
 *                      POST /v3/dataforseo_labs/google/bulk_keyword_difficulty/live
 *                      POST /v3/dataforseo_labs/google/ranked_keywords/live (×0–2)
 */
export async function keywordDiscovery(
  creds: DfsCreds,
  params: DiscoveryParams,
  clientDomain: string | null,
  locationName = UNITED_STATES,
  languageName = "English",
  gate: DiscoveryGate = { services: null, tracked: null },
): Promise<DiscoveryResult> {
  const seeds = [...new Set(params.seeds.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean))].slice(0, 200);
  if (!seeds.length) throw new Error("no seed keywords");
  const limit = Math.max(1, Math.min(1000, Math.round(params.limit || 200)));
  const clean = (d: string) => d.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const client = clientDomain ? clean(clientDomain) : null;
  const competitors = competitorsOfParams(params).map(clean);
  const national = isNational(locationName);
  // The ranking calls are Labs, and Labs is country-level.
  const rankLocation = UNITED_STATES;
  let costUsd = 0;
  const warnings: string[] = [];
  if (!national && (client || competitors.length)) {
    warnings.push(`positions are the national ones: the ranking data is country-level, so "you rank #N" is not a position in ${placeLabel(locationName)}. Every volume is for ${placeLabel(locationName)}.`);
  }

  async function ranked(target: string, take: number): Promise<any[]> {
    const payload = [{ target, location_name: rankLocation, language_name: languageName, limit: take, order_by: ["keyword_data.keyword_info.search_volume,desc"] }];
    const resp = await post(creds, "/dataforseo_labs/google/ranked_keywords/live", payload);
    costUsd += taskCost(resp);
    const rt = Array.isArray(resp?.tasks) ? resp.tasks[0] : null;
    if (!rt || rt.status_code !== 20000) throw new Error(rt?.status_message || "DataForSEO returned no ranked keywords");
    const result = Array.isArray(rt.result) ? rt.result[0] : null;
    return Array.isArray(result?.items) ? result.items : [];
  }
  const rankOf = (it: any): number | null => {
    const rse = it?.ranked_serp_element ?? {};
    const serpItem = rse?.serp_item ?? {};
    return num(serpItem.rank_absolute) ?? num(rse.rank_absolute);
  };

  // 1. Ideas — the calls that must succeed.
  type Row = Omit<DiscoveryKeyword, "relevance" | "measuredIn"> & { measuredIn: string };
  const rows = new Map<string, Row>();
  const place = national ? UNITED_STATES : locationName;
  // ONE SEARCH PER SEED, with a trailing generic word taken off ("brazing
  // services" asks for "brazing"), each with its share of the limit.
  const searches = providerSeeds(seeds);
  const perSeed = perSeedLimit(limit, searches.length);
  const asked: string[] = [];
  const addIdeas = (ideas: KeywordIdea[]) => {
    const top = ideas.slice().sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
    for (const idea of top) {
      const key = normKw(idea.keyword);
      if (rows.has(key)) continue;
      rows.set(key, { ...idea, clientRank: null, competitorRank: null, sources: ["seed"], measuredIn: place });
    }
  };
  if (national) {
    const settled = await mapWithConcurrency(searches, 4, async (search) => {
      try {
        const r = await keywordSuggestions(creds, search, locationName, languageName, perSeed);
        return { search, ok: true as const, ...r };
      } catch (e) {
        return { search, ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    });
    const good = settled.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
    // A seed whose call failed costs that seed and is named. Every call failing is a failed run.
    if (!good.length) throw new Error((settled[0] as { error?: string } | undefined)?.error || "DataForSEO returned no result");
    for (const r of settled) {
      if (!r.ok) { warnings.push(`suggestions for "${r.search}": ${r.error}`); continue; }
      asked.push(r.search);
      costUsd += r.costUsd;
      if (r.notContained > 0) warnings.push(`${r.notContained} idea(s) the provider returned for "${r.search}" did not contain it and were not stored`);
    }
    // Merge in the order asked, then keep the biggest up to the limit.
    const merged: KeywordIdea[] = [];
    for (const r of good) merged.push(...r.ideas);
    addIdeas(merged);
    if (rows.size > limit) {
      const keep = [...rows.entries()].sort((a, b) => (b[1].volume ?? 0) - (a[1].volume ?? 0)).slice(0, limit);
      rows.clear();
      for (const [k, v] of keep) rows.set(k, v);
    }
  } else {
    // The Keywords Data call has no phrase filter, so containment is applied here
    // BEFORE the volume order picks what to keep: head terms nobody asked about
    // can never fill the cap. Each search keeps its own share.
    const local = await keywordIdeasLocal(creds, searches, locationName, languageName);
    costUsd += local.costUsd;
    asked.push(...searches.slice(0, 20));
    const contained = containAndCap(local.ideas, searches, perSeed);
    const dropped = local.ideas.length - local.ideas.filter((i) => searches.some((s) => containsAllWords(i.keyword, s))).length;
    if (dropped > 0) warnings.push(`${dropped} of the ${local.ideas.length} ideas the provider returned contained none of the searches asked for and were not stored`);
    addIdeas(contained);
    if (rows.size > limit) {
      const keep = [...rows.entries()].sort((a, b) => (b[1].volume ?? 0) - (a[1].volume ?? 0)).slice(0, limit);
      rows.clear();
      for (const [k, v] of keep) rows.set(k, v);
    }
  }

  // 2. Client's own footprint (best-effort).
  const clientRank = new Map<string, number | null>();
  if (client) {
    try {
      for (const it of await ranked(client, 1000)) {
        const kw = normKw(toKeywordIdea(it).keyword);
        if (kw && !clientRank.has(kw)) clientRank.set(kw, rankOf(it));
      }
      for (const [key, row] of rows) if (clientRank.has(key)) row.clientRank = clientRank.get(key) ?? null;
    } catch (e) {
      warnings.push(`client rankings (${client}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3. Competitor gap (best-effort, only meaningful with a client footprint).
  // Each competitor is its own rankings call. A row more than one of them ranks
  // for lists them all and carries the best position among them.
  if (client) {
    for (const comp of competitors) {
      try {
        for (const it of await ranked(comp, 700)) {
          const idea = toKeywordIdea(it);
          if (!idea.keyword) continue;
          const key = normKw(idea.keyword);
          const compRank = rankOf(it);
          if (compRank != null && compRank > 50) continue;      // only real competitor wins
          if (clientRank.has(key)) continue;                     // client already ranks — not a gap
          const existing = rows.get(key);
          if (existing) {
            if (compRank != null && (existing.competitorRank == null || compRank < existing.competitorRank)) existing.competitorRank = compRank;
            else if (existing.competitorRank == null) existing.competitorRank = compRank;
            if (!existing.sources.includes("gap")) existing.sources.push("gap");
            if (!existing.competitorsRanking) existing.competitorsRanking = [];
            if (!existing.competitorsRanking.includes(comp)) existing.competitorsRanking.push(comp);
          } else {
            // Its volume is the national one (Labs). In a place run it is
            // re-measured below or left blank, never kept as is.
            rows.set(key, { ...idea, clientRank: null, competitorRank: compRank, competitorsRanking: [comp], sources: ["gap"], measuredIn: UNITED_STATES });
          }
        }
      } catch (e) {
        warnings.push(`competitor rankings (${comp}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 4. Judge every idea. Nothing is dropped.
  const all = [...rows.values()];
  // Seeds and services gain their cores ("furnace brazing services" also counts
  // as "furnace brazing") and a person's declared words join the seeds.
  const inputs = judgingInputs({ seeds, services: gate.services, declaredWords: gate.declaredWords ?? null });
  const judgement = judgeIdeas(all.map((r) => r.keyword), { seeds: inputs.seeds, services: inputs.services, tracked: gate.tracked });
  const verdictByKey = new Map(judgement.verdicts.map((v) => [normKw(v.keyword), v] as const));
  const kept = (r: Row): boolean => verdictByKey.get(normKw(r.keyword))?.kept !== false;

  // 5. A place run: every volume must be for that place.
  if (!national) {
    const foreign = all.filter((r) => r.measuredIn !== place);
    const wanted = foreign.filter(kept);
    if (wanted.length) {
      try {
        const v = await localVolumes(creds, wanted.map((r) => r.keyword), locationName, languageName);
        costUsd += v.costUsd;
        for (const r of wanted) {
          const hit = v.byKeyword.get(normKw(r.keyword));
          r.volume = hit?.volume ?? null;
          r.cpc = hit?.cpc ?? null;
          r.measuredIn = place;
        }
      } catch (e) {
        warnings.push(`volumes for ${wanted.length} competitor-gap ideas in ${placeLabel(place)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Whatever is still measured elsewhere carries no volume: a number from
    // another place beside local ones would be read as one market.
    for (const r of foreign) {
      if (r.measuredIn !== place) { r.volume = null; r.cpc = null; r.competition = null; }
    }
    // Keyword difficulty, for the ideas that are kept and have none.
    const needKd = all.filter((r) => kept(r) && r.difficulty == null);
    if (needKd.length) {
      try {
        const d = await difficultyFor(creds, needKd.map((r) => r.keyword), languageName);
        costUsd += d.costUsd;
        for (const r of needKd) r.difficulty = d.byKeyword.get(normKw(r.keyword)) ?? null;
      } catch (e) {
        warnings.push(`keyword difficulty for ${needKd.length} kept ideas: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const out: DiscoveryKeyword[] = all
    .map((r): DiscoveryKeyword => {
      const v = verdictByKey.get(normKw(r.keyword));
      return {
        ...r,
        measuredIn: r.volume == null && r.measuredIn !== place ? null : r.measuredIn,
        relevance: {
          kept: v?.kept !== false,
          via: v?.via?.phrase ?? null,
          source: v?.via?.source ?? null,
          why: v?.why === "no_anchor" || v?.why === "blank" ? v.why : null,
        },
      };
    })
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  return {
    rows: out,
    costUsd: Math.round(costUsd * 10000) / 10000,
    warnings,
    place,
    source: national ? "labs_national" : "google_ads_local",
    asked,
    judgement,
  };
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

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

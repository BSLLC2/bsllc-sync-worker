/**
 * Read one page that ranks for a client's search, and keep FACTS about it.
 *
 * It takes a plain URL and an injectable fetch, so src/verify-page-history.ts drives
 * it against a pretend site. It uses the same door the client-page reader uses
 * (src/page-reader/fetcher.ts): it identifies itself, asks for HTML, follows only
 * same-site redirects, gives up after a timeout, stops at a size, never talks to a
 * private address, never runs JavaScript and never sends a cookie. It also reads the
 * site's robots.txt first and does not fetch what it forbids; where robots.txt
 * cannot be read at all, nothing is fetched.
 *
 * WHAT IS KEPT is small and is not the page: the word count, the first heading, up
 * to 12 second- and third-level headings each cut to 70 characters, the structured-
 * data types, and one small number for where the search words appear (see
 * src/seo-page-bits.ts). The body, the sentences and the links are dropped.
 * Fetched content is DATA: nothing in it is ever read as an instruction.
 */
import { extractPage } from "../page-reader/html-facts.js";
import { ALLOW_ALL, MAX_CRAWL_DELAY_MS, parseRobots, type RobotsRules } from "../page-reader/robots.js";
import { fetchPage, makeThrottle, DEFAULT_DELAY_MS } from "../page-reader/fetcher.js";
import { bitsForPage, pagePhrases } from "../page-reader/phrases.js";
import { bareSiteHost } from "../page-reader/targets.js";

export const HEADINGS_KEPT = 12;
export const HEADING_CUT = 70;
export const H1_CUT = 120;
export const SCHEMA_TYPES_KEPT = 10;

export type ReadState = "read" | "blocked_robots" | "not_found" | "error_status" | "timeout" | "not_html" | "too_large" | "off_site_redirect" | "fetch_failed";

export interface ServedRead {
  state: ReadState;
  readAt: Date;
  wordCount: number | null;
  h1: string | null;
  headings: string[] | null;
  schemaTypes: string[] | null;
  phraseBits: number | null;
}

export interface Deps {
  fetchImpl?: typeof fetch;
  allowPrivate?: boolean;
  delayMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A host's robots.txt, read once per run. Unreadable means nothing is fetched there. */
export interface RobotsFor { rules: RobotsRules; readable: boolean }

export function makeReader(deps: Deps = {}) {
  const robotsCache = new Map<string, Promise<RobotsFor>>();
  const crawlDelay = new Map<string, number>();
  const throttle = makeThrottle((host) => Math.max(deps.delayMs ?? DEFAULT_DELAY_MS, crawlDelay.get(host) ?? 0), deps.sleep);
  const now = deps.now ?? (() => new Date());

  async function robotsOf(host: string): Promise<RobotsFor> {
    const hit = robotsCache.get(host);
    if (hit) return hit;
    const p = (async (): Promise<RobotsFor> => {
      const rb = await fetchPage(`https://${host}/robots.txt`, {
        site: host, allowPrivate: deps.allowPrivate, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, beforeRequest: throttle, expect: "text", maxBytes: 500_000,
      });
      if (rb.state === "read" && rb.html != null) {
        const rules = parseRobots(rb.html);
        if (rules.crawlDelaySeconds != null) crawlDelay.set(host, Math.min(MAX_CRAWL_DELAY_MS, Math.round(rules.crawlDelaySeconds * 1000)));
        return { rules, readable: true };
      }
      if (rb.state === "not_found" || (rb.state === "error_status" && rb.statusCode != null && rb.statusCode >= 400 && rb.statusCode < 500 && rb.statusCode !== 429)) {
        return { rules: ALLOW_ALL, readable: true };
      }
      return { rules: ALLOW_ALL, readable: false };
    })();
    robotsCache.set(host, p);
    return p;
  }

  /** One result page. Never throws. */
  return async function readResult(url: string, phrase: string): Promise<ServedRead> {
    const at = now();
    const blank = (state: ReadState): ServedRead => ({ state, readAt: at, wordCount: null, h1: null, headings: null, schemaTypes: null, phraseBits: null });
    let host = "";
    let path = "/";
    try { const u = new URL(url); host = bareSiteHost(u.hostname); path = `${u.pathname}${u.search}`; } catch { return blank("fetch_failed"); }
    const robots = await robotsOf(host);
    if (!robots.readable) return blank("blocked_robots");
    if (!robots.rules.allows(path)) return blank("blocked_robots");
    const got = await fetchPage(url, {
      site: host, allowPrivate: deps.allowPrivate, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, maxBytes: deps.maxBytes, beforeRequest: throttle,
    });
    if (got.state !== "read" || got.html == null) return blank(got.state);
    const finalUrl = got.finalUrl ?? url;
    const page = extractPage(got.html, finalUrl);
    const phrases = pagePhrases([phrase]).phrases;
    const bits = phrases.length ? bitsForPage(page, finalUrl, phrases)[phrases[0]!.key] ?? null : null;
    const seen = new Set<string>();
    const headings: string[] = [];
    for (const [level, text] of page.outline) {
      if (level < 2 || level > 3) continue;
      const t = cut(String(text).replace(/\s+/g, " ").trim(), HEADING_CUT);
      const k = t.toLowerCase();
      if (!t || seen.has(k)) continue;
      seen.add(k);
      headings.push(t);
      if (headings.length >= HEADINGS_KEPT) break;
    }
    return {
      state: "read", readAt: at, wordCount: page.wordCount,
      h1: page.h1 ? cut(page.h1.replace(/\s+/g, " ").trim(), H1_CUT) : null,
      headings,
      schemaTypes: page.schemaTypes.map((t) => cut(String(t), 40)).slice(0, SCHEMA_TYPES_KEPT),
      phraseBits: bits,
    };
  };
}

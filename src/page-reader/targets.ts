/**
 * Which of a client's own pages to read, in what order, and how many.
 *
 * PURE. Facts in, an ordered list out.
 *
 *  · SAME SITE ONLY. An address is kept only when its host is the client's own
 *    domain, with or without "www.". A link out, a CDN, a partner's page and a
 *    sub-domain nobody recorded are all left alone.
 *  · THE ORDER IS THE REASON. The addresses Google actually returned for the
 *    client's tracked searches come first (those are the pages being improved),
 *    then the home page, then the pages enquiries came from, then the rest of the
 *    sitemap, with pages whose address already carries words of a tracked search
 *    ahead of the others, because "is there already a page for this search" is the
 *    question this exists to answer.
 *  · BOUNDED. `cap` addresses in all, whatever the sitemap holds. Reading less is
 *    the safe direction; the run says how many it left out.
 *  · NO TRACKING PARAMETERS. utm_*, gclid, fbclid and the like are removed, so one
 *    page is not read once for every campaign that linked to it.
 */
import type { SeoPageFoundByName } from "./types.js";

export const DEFAULT_PAGE_CAP = 60;

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|ref|ref_src|yclid|igshid)$/i;
const NOT_A_PAGE = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|json|xml|zip|gz|mp4|mov|mp3|wav|docx?|xlsx?|pptx?|txt|woff2?|ttf|eot|rss|atom)$/i;

/** The client's host as typed ("https://www.x.com/page" is "x.com"). */
export function bareSiteHost(input: string): string {
  return String(input ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^www\./, "");
}

/** True where `host` is the client's domain or its www form, and nothing else. */
export function isSameSite(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return h !== "" && h === bareSiteHost(site);
}

/** A normalised address, or null where it is not a web page on this site. */
export function normaliseUrl(raw: string, site: string, base?: string): string | null {
  let u: URL;
  try { u = new URL(String(raw ?? "").trim(), base ?? `https://${bareSiteHost(site)}/`); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (!isSameSite(u.hostname, site)) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  u.hash = "";
  u.port = "";
  const keep: Array<[string, string]> = [];
  u.searchParams.forEach((v, k) => { if (!TRACKING_PARAM.test(k)) keep.push([k, v]); });
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if (NOT_A_PAGE.test(u.pathname)) return null;
  if (u.pathname === "") u.pathname = "/";
  // One scheme and one host form for the table's key: https, and the bare host.
  // If the site only answers on "www." the first request is redirected there (a
  // same-site redirect is followed) and the page row records where it ended up.
  u.protocol = "https:";
  u.hostname = bareSiteHost(site);
  return u.toString();
}

export interface TargetInput {
  site: string;
  /** What the latest weekly check returned per tracked search. */
  rankingUrls: readonly string[];
  /** `host/path` or a full address, as the enquiry forms recorded them. */
  enquiryPages: readonly string[];
  /** Every address the sitemap lists, in its own order. */
  sitemapUrls: readonly string[];
  /** The folded words of each tracked search (src/ads/idea-relevance.ts ideaWords). */
  phraseWords: ReadonlyArray<readonly string[]>;
  cap?: number;
}

export interface Target { url: string; foundBy: SeoPageFoundByName }

export interface TargetPlan {
  targets: Target[];
  /** Addresses that were eligible and did not fit under the cap. */
  leftOut: number;
}

const slugWords = (url: string): Set<string> => {
  let path = "";
  try { path = decodeURIComponent(new URL(url).pathname); } catch { path = url; }
  return new Set(path.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
};

/** How many tracked searches have every word in this address. The higher, the more
 *  likely the page is already about one of them. */
function slugScore(url: string, phraseWords: ReadonlyArray<readonly string[]>): number {
  const words = slugWords(url);
  const folded = new Set<string>();
  words.forEach((w) => { folded.add(w); if (w.endsWith("s") && w.length > 3) folded.add(w.slice(0, -1)); });
  let score = 0;
  for (const p of phraseWords) if (p.length && p.every((w) => folded.has(w))) score += 1;
  return score;
}

export function chooseTargets(input: TargetInput): TargetPlan {
  const cap = Math.max(1, input.cap ?? DEFAULT_PAGE_CAP);
  const seen = new Set<string>();
  const ordered: Target[] = [];
  const add = (raw: string, foundBy: SeoPageFoundByName) => {
    const url = normaliseUrl(raw, input.site);
    if (!url || seen.has(url)) return;
    seen.add(url);
    ordered.push({ url, foundBy });
  };
  for (const u of input.rankingUrls) add(u, "ranking");
  add(`https://${bareSiteHost(input.site)}/`, "home");
  for (const p of input.enquiryPages) add(/^[a-z]+:\/\//i.test(p) ? p : `https://${p}`, "enquiry");

  const rest: Array<{ url: string; score: number; order: number }> = [];
  input.sitemapUrls.forEach((raw, order) => {
    const url = normaliseUrl(raw, input.site);
    if (!url || seen.has(url)) return;
    seen.add(url);
    rest.push({ url, score: slugScore(url, input.phraseWords), order });
  });
  rest.sort((a, b) => b.score - a.score || a.order - b.order);
  for (const r of rest) ordered.push({ url: r.url, foundBy: "sitemap" });

  return { targets: ordered.slice(0, cap), leftOut: Math.max(0, ordered.length - cap) };
}

/** Addresses listed in a sitemap or a sitemap index. */
export function parseSitemap(xml: string): { urls: string[]; children: string[]; index: boolean } {
  const text = String(xml ?? "").slice(0, 2_000_000);
  const index = /<sitemapindex[\s>]/i.test(text);
  const locs: string[] = [];
  for (const m of text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi)) {
    locs.push(m[1]!.replace(/&amp;/g, "&"));
    if (locs.length >= 5000) break;
  }
  return index ? { urls: [], children: locs, index } : { urls: locs, children: [], index };
}

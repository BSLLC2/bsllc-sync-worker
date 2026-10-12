/**
 * Read one client's site: robots.txt, the sitemap, then a bounded set of pages,
 * and turn each into one row of facts.
 *
 * No database in here. The CLI (src/read-pages.ts) gathers what to read and writes
 * the rows; this takes plain inputs and an injectable `fetch`, which is how
 * src/verify-page-reader.ts runs the whole thing against a pretend site.
 *
 * ── WHAT EACH OUTCOME MEANS ────────────────────────────────────────────────
 *
 *  · robots.txt answers, or does not exist (404, 410, or any other 4xx that is
 *    not 429): everything it does not forbid is read.
 *  · robots.txt cannot be read at all (5xx, 429, no answer): NOTHING is read, and
 *    every address is recorded as blocked with the reason. Guessing that a file
 *    nobody could read says "come in" is the one direction that is not polite.
 *  · An address robots.txt forbids is NOT fetched. It is recorded, so the app can
 *    say "the site asks not to be read here" and not "no title".
 *  · A page that cannot be read is a row with a state and no facts.
 */
import { extractPage } from "./html-facts.js";
import { ALLOW_ALL, MAX_CRAWL_DELAY_MS, parseRobots, type RobotsRules } from "./robots.js";
import { chooseTargets, isSameSite, normaliseUrl, bareSiteHost, parseSitemap, DEFAULT_PAGE_CAP } from "./targets.js";
import { fetchPage, makeThrottle, DEFAULT_DELAY_MS, type FetchOutcome } from "./fetcher.js";
import { bitsForPage, pagePhrases } from "./phrases.js";
import type { PageRow, PageState } from "./types.js";

export interface ReadInput {
  /** The client's domain as recorded. */
  site: string;
  rankingUrls: readonly string[];
  enquiryPages: readonly string[];
  /** Tracked searches, then questions, then researched ideas: cut from the end. */
  phrases: readonly string[];
  cap?: number;
}

export interface ReadDeps {
  fetchImpl?: typeof fetch;
  allowPrivate?: boolean;
  delayMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReadSummary {
  site: string;
  attempted: number;
  read: number;
  blocked: number;
  failed: number;
  leftOut: number;
  phrasesChecked: number;
  phrasesLeftOut: number;
  /** "open" (no robots.txt), "followed", or "unreadable" (so nothing was read). */
  robots: "open" | "followed" | "unreadable";
  sitemapUrls: number;
}

export interface ReadResult { rows: PageRow[]; summary: ReadSummary }

const SITEMAP_FILES_MAX = 5;
const SITEMAP_URLS_MAX = 2000;

const emptyRow = (url: string, foundBy: PageRow["foundBy"], state: PageState, statusCode: number | null, error: string | null, finalUrl: string | null): PageRow => ({
  url, finalUrl, foundBy, state, statusCode, error,
  title: null, metaDescription: null, h1: null, h1Count: null, outlineJson: null, wordCount: null,
  canonical: null, noindex: null, schemaTypesJson: null, inLinks: null, outLinks: null, pagesRead: null,
  phrasesJson: null, phrasesChecked: null,
});

export async function readSite(input: ReadInput, deps: ReadDeps = {}): Promise<ReadResult> {
  const site = bareSiteHost(input.site);
  const home = `https://${site}/`;
  let robots: RobotsRules = ALLOW_ALL;
  let robotsState: ReadSummary["robots"] = "open";
  let crawlDelayMs = 0;
  const throttle = makeThrottle(() => Math.max(deps.delayMs ?? DEFAULT_DELAY_MS, crawlDelayMs), deps.sleep);
  const base = { site, allowPrivate: deps.allowPrivate, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, beforeRequest: throttle };

  // robots.txt first, always.
  const rb: FetchOutcome = await fetchPage(`${home}robots.txt`, { ...base, expect: "text", maxBytes: 500_000 });
  if (rb.state === "read" && rb.html != null) {
    robots = parseRobots(rb.html);
    robotsState = "followed";
  } else if (rb.state === "not_found" || (rb.state === "error_status" && rb.statusCode != null && rb.statusCode >= 400 && rb.statusCode < 500 && rb.statusCode !== 429)) {
    robots = ALLOW_ALL;
    robotsState = "open";
  } else {
    robotsState = "unreadable";
  }
  if (robots.crawlDelaySeconds != null) crawlDelayMs = Math.min(MAX_CRAWL_DELAY_MS, Math.round(robots.crawlDelaySeconds * 1000));

  const pathOf = (url: string): string => { try { const u = new URL(url); return `${u.pathname}${u.search}`; } catch { return "/"; } };

  // The sitemap: the files robots.txt names, else the two usual places.
  const { phrases, leftOut: phrasesLeftOut } = pagePhrases(input.phrases);
  let sitemapUrls: string[] = [];
  if (robotsState !== "unreadable") {
    const candidates = [...robots.sitemaps, `${home}sitemap.xml`, `${home}sitemap_index.xml`];
    const queue: string[] = [];
    for (const c of candidates) {
      const n = normaliseSitemapUrl(c, site);
      if (n && !queue.includes(n)) queue.push(n);
    }
    let files = 0;
    while (queue.length && files < SITEMAP_FILES_MAX && sitemapUrls.length < SITEMAP_URLS_MAX) {
      const addr = queue.shift()!;
      if (!robots.allows(pathOf(addr))) continue;
      files += 1;
      const out = await fetchPage(addr, { ...base, expect: "text", maxBytes: 2_000_000 });
      if (out.state !== "read" || out.html == null) continue;
      const parsed = parseSitemap(out.html);
      for (const child of parsed.children) {
        const n = normaliseSitemapUrl(child, site);
        if (n && !queue.includes(n)) queue.push(n);
      }
      sitemapUrls = sitemapUrls.concat(parsed.urls).slice(0, SITEMAP_URLS_MAX);
    }
  }

  const phraseWords = phrases.map((p) => p.words);
  const plan = chooseTargets({
    site, rankingUrls: input.rankingUrls, enquiryPages: input.enquiryPages,
    sitemapUrls, phraseWords, cap: input.cap ?? DEFAULT_PAGE_CAP,
  });

  const rows: PageRow[] = [];
  const links = new Map<string, string[]>();
  for (const t of plan.targets) {
    if (robotsState === "unreadable") {
      rows.push(emptyRow(t.url, t.foundBy, "blocked_robots", null, "the site's robots.txt could not be read, so nothing was fetched", null));
      continue;
    }
    if (!robots.allows(pathOf(t.url))) {
      rows.push(emptyRow(t.url, t.foundBy, "blocked_robots", null, "the site's robots.txt asks not to be read here", null));
      continue;
    }
    const got = await fetchPage(t.url, { ...base, maxBytes: deps.maxBytes });
    if (got.state !== "read" || got.html == null) {
      rows.push(emptyRow(t.url, t.foundBy, got.state, got.statusCode, got.error, got.finalUrl));
      continue;
    }
    const finalUrl = got.finalUrl ?? t.url;
    const page = extractPage(got.html, finalUrl);
    const bits = bitsForPage(page, finalUrl, phrases);
    const row: PageRow = {
      ...emptyRow(t.url, t.foundBy, "read", got.statusCode, null, finalUrl),
      title: page.title,
      metaDescription: page.metaDescription,
      h1: page.h1,
      h1Count: page.h1Count,
      outlineJson: JSON.stringify(page.outline),
      wordCount: page.wordCount,
      canonical: page.canonical,
      noindex: page.noindex || got.headerNoindex,
      schemaTypesJson: JSON.stringify(page.schemaTypes),
      phrasesJson: JSON.stringify(bits),
      phrasesChecked: phrases.length,
    };
    rows.push(row);
    links.set(t.url, page.links);
  }

  // Links among the pages that were read. Counted inside this run's own set, and
  // the count of pages read is stored beside them, so a number is never read as
  // the whole site's.
  const readRows = rows.filter((r) => r.state === "read");
  const known = new Set(readRows.map((r) => r.url));
  const inbound = new Map<string, Set<string>>();
  for (const [from, hrefs] of Array.from(links.entries())) {
    const targets = new Set<string>();
    for (const h of hrefs) {
      const n = normaliseUrl(h, site);
      if (n && n !== from) targets.add(n);
    }
    const row = readRows.find((r) => r.url === from);
    if (row) row.outLinks = targets.size;
    targets.forEach((t) => {
      if (!known.has(t)) return;
      const set = inbound.get(t) ?? new Set<string>();
      set.add(from);
      inbound.set(t, set);
    });
  }
  for (const r of readRows) {
    r.inLinks = inbound.get(r.url)?.size ?? 0;
    r.pagesRead = readRows.length;
  }

  const count = (f: (r: PageRow) => boolean) => rows.filter(f).length;
  return {
    rows,
    summary: {
      site,
      attempted: rows.length,
      read: readRows.length,
      blocked: count((r) => r.state === "blocked_robots"),
      failed: count((r) => r.state !== "read" && r.state !== "blocked_robots"),
      leftOut: plan.leftOut,
      phrasesChecked: phrases.length,
      phrasesLeftOut,
      robots: robotsState,
      sitemapUrls: sitemapUrls.length,
    },
  };
}

function normaliseSitemapUrl(raw: string, site: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!isSameSite(u.hostname, site)) return null;
    u.hash = "";
    u.protocol = "https:";
    u.hostname = bareSiteHost(site);
    return u.toString();
  } catch { return null; }
}

/** The one line a run prints for a client. */
export function summaryLine(s: ReadSummary): string {
  const bits = [`${s.read} read`];
  if (s.blocked) bits.push(`${s.blocked} blocked by robots.txt`);
  if (s.failed) bits.push(`${s.failed} could not be read`);
  if (s.leftOut) bits.push(`${s.leftOut} left out over the cap`);
  return `${s.site}: ${bits.join(", ")}`;
}

/**
 * What a WordPress site's PUBLIC REST API says was published or edited, and when.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * A change on a client's own site (a page rewritten, a post published) sits
 * beside a change in the ad account in the dashboard's change record, so a
 * before-and-after reading can name BOTH dated entries and claim a cause for
 * neither. Nothing recorded site edits. This is the read.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 *
 *  · READ-ONLY, PUBLIC, NO LOGIN. Only the endpoints an anonymous visitor can
 *    call (`/wp-json/`, `/wp-json/wp/v2/posts`, `/wp-json/wp/v2/pages`). Nothing
 *    is sent but a GET. A site that answers 401/403 is simply not readable.
 *  · NO CONTENT, NO TITLES. The request asks for `id`, `link`, `date_gmt`,
 *    `modified_gmt` and `status` only (`_fields`), and the parser keeps a path
 *    and two dates. A title or a body in the answer is dropped on the floor,
 *    because a title can name a person.
 *  · A SITE WITH NO REST API IS "NOT READABLE", NEVER "NO EDITS". The discovery
 *    answer must be JSON naming the `wp/v2` namespace; a 404, an HTML page with
 *    a 200, a login wall or a disabled endpoint all read `no_rest`. Silence about
 *    edits is never inferred from a site that could not be asked.
 *  · PLUGINS, THEMES AND CORE ARE NOT VISIBLE WITHOUT A LOGIN. The table allows
 *    those kinds so a later authenticated source can fill them; this job writes
 *    only `post` and `page`.
 *  · A DATE IS WHAT THE SITE SAYS. WordPress sets `modified_gmt` equal to
 *    `date_gmt` at publication, so an "edited" event exists only where the
 *    modified time is more than `EDIT_GAP_MINUTES` after the published time.
 *    Several saves between two reads collapse to the last one. The first read
 *    can only see each item's LAST edit.
 *  · ROBOTS: the same politeness as the page reader (robots.txt first, one
 *    request a second, same-site redirects only, a robots.txt that cannot be
 *    read means nothing is fetched).
 *
 * Pure except where it takes an injectable fetch (the same one the page reader
 * uses). No database in here.
 */
import { ALLOW_ALL, MAX_CRAWL_DELAY_MS, parseRobots, type RobotsRules } from "../page-reader/robots.js";
import { bareSiteHost, isSameSite } from "../page-reader/targets.js";
import { fetchPage, makeThrottle, DEFAULT_DELAY_MS, type FetchOutcome } from "../page-reader/fetcher.js";

export const SOURCE = "wordpress";
export const KINDS = ["post", "page", "plugin", "theme", "core"] as const;
export type SiteChangeKind = (typeof KINDS)[number];
/** The kinds this job can read without a login. */
export const READABLE_KINDS = ["post", "page"] as const;
export const EVENTS = ["published", "edited"] as const;
export type SiteChangeEvent = (typeof EVENTS)[number];
export const STATES = ["read", "no_rest", "blocked_robots", "robots_unreadable", "unreachable", "no_site"] as const;
export type WpState = (typeof STATES)[number];

export const PER_PAGE = 100;
export const MAX_PAGES = 5;
export const LOOKBACK_DAYS = 120;
export const EDIT_GAP_MINUTES = 60;
export const FIELDS = "id,link,date_gmt,modified_gmt,status";

export interface WpChange {
  kind: SiteChangeKind;
  event: SiteChangeEvent;
  /** ISO instant, UTC. */
  at: string;
  /** Path only: no host, no query, no fragment. */
  urlPath: string;
  externalId: string;
}

const gmt = (v: unknown): number | null => {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}Z`);
  return Number.isFinite(t) ? t : null;
};

/** Path of a same-site link, or null. */
export function pathOfLink(link: unknown, site: string): string | null {
  let u: URL;
  try { u = new URL(String(link ?? "")); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!isSameSite(u.hostname, site)) return null;
  return u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") || "/" : "/";
}

export interface ParsedList {
  changes: WpChange[];
  /** Items in the list that were usable. */
  items: number;
  /** Newest-first lists end once an item is older than the cutoff. */
  reachedCutoff: boolean;
  /** Items dropped because they were not a published item on this site. */
  dropped: number;
}

/** Turn one page of a WP REST list into changes. Only id, link and the two dates are read; anything else in an item is ignored. */
export function parseWpList(json: unknown, kind: "post" | "page", site: string, cutoffMs: number): ParsedList | null {
  if (!Array.isArray(json)) return null;
  const changes: WpChange[] = [];
  let items = 0, dropped = 0, reachedCutoff = false;
  for (const raw of json) {
    const it = raw as { id?: unknown; link?: unknown; date_gmt?: unknown; modified_gmt?: unknown; status?: unknown };
    const id = Number(it?.id);
    const published = gmt(it?.date_gmt);
    const modified = gmt(it?.modified_gmt);
    const path = pathOfLink(it?.link, site);
    if (!Number.isInteger(id) || id <= 0 || published == null || modified == null || !path || (it.status != null && it.status !== "publish")) { dropped += 1; continue; }
    items += 1;
    const externalId = `${kind}:${id}`;
    if (published >= cutoffMs) changes.push({ kind, event: "published", at: new Date(published).toISOString(), urlPath: path, externalId });
    if (modified - published > EDIT_GAP_MINUTES * 60_000 && modified >= cutoffMs) {
      changes.push({ kind, event: "edited", at: new Date(modified).toISOString(), urlPath: path, externalId });
    }
    if (modified < cutoffMs) reachedCutoff = true;
  }
  return { changes, items, reachedCutoff, dropped };
}

export interface WpSiteResult {
  site: string;
  state: WpState;
  changes: WpChange[];
  /** Items read across all lists. */
  items: number;
  /** True where a list had more newer items than MAX_PAGES holds. */
  capped: boolean;
  note: string;
}

export interface WpDeps {
  fetchImpl?: typeof fetch;
  allowPrivate?: boolean;
  delayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const NOTE: Record<WpState, string> = {
  read: "",
  no_rest: "the site's public WordPress API did not answer, so edits cannot be read",
  blocked_robots: "the site's robots.txt asks not to be read at /wp-json/",
  robots_unreadable: "the site's robots.txt could not be read, so nothing was fetched",
  unreachable: "the site could not be reached",
  no_site: "no site address is recorded",
};

const result = (site: string, state: WpState, changes: WpChange[] = [], items = 0, capped = false, extra = ""): WpSiteResult =>
  ({ site, state, changes, items, capped, note: [NOTE[state], extra].filter(Boolean).join(": ") });

export async function readWpSite(siteInput: string, deps: WpDeps = {}): Promise<WpSiteResult> {
  const site = bareSiteHost(siteInput);
  if (!site) return result("", "no_site");
  const home = `https://${site}/`;
  const throttle0 = (crawl: number) => makeThrottle(() => Math.max(deps.delayMs ?? DEFAULT_DELAY_MS, crawl), deps.sleep);
  let throttle = throttle0(0);
  const base = () => ({ site, allowPrivate: deps.allowPrivate, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, beforeRequest: throttle, expect: "text" as const });
  const now = deps.now ? deps.now() : Date.now();
  const cutoffMs = now - LOOKBACK_DAYS * 86_400_000;

  const rb: FetchOutcome = await fetchPage(`${home}robots.txt`, { ...base(), maxBytes: 500_000 });
  let robots: RobotsRules = ALLOW_ALL;
  if (rb.state === "read" && rb.html != null) robots = parseRobots(rb.html);
  else if (rb.state === "not_found" || (rb.state === "error_status" && rb.statusCode != null && rb.statusCode >= 400 && rb.statusCode < 500 && rb.statusCode !== 429)) robots = ALLOW_ALL;
  else return result(site, rb.state === "fetch_failed" || rb.state === "timeout" ? "unreachable" : "robots_unreadable");
  if (robots.crawlDelaySeconds != null) throttle = throttle0(Math.min(MAX_CRAWL_DELAY_MS, Math.round(robots.crawlDelaySeconds * 1000)));

  const allowed = (path: string) => robots.allows(path);
  if (!allowed("/wp-json/")) return result(site, "blocked_robots");

  // Discovery: JSON that names the wp/v2 namespace. Anything else is "not readable".
  const disc = await fetchPage(`${home}wp-json/`, { ...base(), maxBytes: 500_000 });
  if (disc.state === "fetch_failed" || disc.state === "timeout") return result(site, "unreachable");
  if (disc.state !== "read" || disc.html == null) return result(site, "no_rest", [], 0, false, disc.statusCode != null ? `status ${disc.statusCode}` : "");
  let namespaces: unknown;
  try { namespaces = (JSON.parse(disc.html) as { namespaces?: unknown })?.namespaces; } catch { return result(site, "no_rest", [], 0, false, "the answer was not JSON"); }
  if (!Array.isArray(namespaces) || !namespaces.includes("wp/v2")) return result(site, "no_rest", [], 0, false, "no wp/v2 namespace");

  const changes: WpChange[] = [];
  let items = 0, capped = false;
  for (const kind of READABLE_KINDS) {
    const route = kind === "post" ? "posts" : "pages";
    for (let page = 1; page <= MAX_PAGES; page++) {
      const path = `/wp-json/wp/v2/${route}?per_page=${PER_PAGE}&page=${page}&orderby=modified&order=desc&_fields=${FIELDS}`;
      if (!allowed(path)) return result(site, "blocked_robots", [], 0, false, "at the posts list");
      const out = await fetchPage(`https://${site}${path}`, { ...base(), maxBytes: 3_000_000 });
      if (out.state === "fetch_failed" || out.state === "timeout") return result(site, "unreachable");
      // A page past the end answers 400; the first page refusing is the site closing the API to visitors.
      if (out.state !== "read" || out.html == null) {
        if (page === 1) return result(site, "no_rest", [], 0, false, out.statusCode != null ? `status ${out.statusCode} on /${route}` : "");
        break;
      }
      let json: unknown;
      try { json = JSON.parse(out.html); } catch { return result(site, "no_rest", [], 0, false, "the list was not JSON"); }
      const parsed = parseWpList(json, kind, site, cutoffMs);
      if (!parsed) return result(site, "no_rest", [], 0, false, "the list was not a list");
      changes.push(...parsed.changes);
      items += parsed.items + parsed.dropped;
      if (parsed.reachedCutoff || (Array.isArray(json) && json.length < PER_PAGE)) break;
      if (page === MAX_PAGES) capped = true;
    }
  }
  return result(site, "read", changes, items, capped, capped ? `more than ${MAX_PAGES * PER_PAGE} items changed inside ${LOOKBACK_DAYS} days, so the oldest are not listed` : "");
}

export function summaryLine(rs: readonly WpSiteResult[]): string {
  const read = rs.filter((r) => r.state === "read").length;
  const events = rs.reduce((s, r) => s + r.changes.length, 0);
  const notReadable = rs.filter((r) => r.state === "no_rest" || r.state === "blocked_robots").length;
  const failed = rs.filter((r) => r.state === "unreachable" || r.state === "robots_unreadable").length;
  return `${rs.length} site${rs.length === 1 ? "" : "s"}: ${read} read, ${events} change${events === 1 ? "" : "s"} listed, ${notReadable} not readable, ${failed} could not be reached`;
}

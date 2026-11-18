/**
 * The pure half of the link audit read: the requests it asks the provider for and how it turns the answers into the rows the dashboard
 * stores. No network and no database here. UNVERIFIED LIVE means "from memory of the published reference, never run against the
 * account"; the first dry run of the workflow is how each is settled.
 *
 * WHAT IS NEVER ASKED FOR: anchors of a competitor, a person, an email address. Anchors are requested for the client's own site only
 * and every stored anchor goes through cleanAnchor (120 characters, contact details replaced).
 */
import { ANCHOR_MAX_CHARS, SPAM_ANCHOR_TEMPLATES, cleanAnchor, pathOf, tldOf } from "./rules.js";
import type { AnchorOut, DomainOut, GapOut, SummaryOut, TargetOut } from "./types.js";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const day = (v: unknown): string | null => { const s = typeof v === "string" ? v.slice(0, 10) : ""; return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const host = (v: unknown): string => String(v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? "";

export const PAGE = 1000;
/** A hard ceiling on one part's rows, OURS. */
export const DOMAIN_ROW_CAP = 5000;
export const LOST_ROW_CAP = 1000;
export const TARGET_ROW_CAP = 1000;
export const TARGET_PATHS_MAX = 60;
export const ANCHOR_LIMIT = 100;
export const GAP_LIMIT = 1000;
export const SPAM_CHUNK = 5;

/* ── requests ── */

/** backlinks/summary/live: the long-used shape from src/dpg-backlinks.ts. */
export const summaryRequest = (target: string) => [{ target, include_subdomains: true, internal_list_limit: 0, backlinks_status_type: "live" }];
/** backlinks/referring_domains/live: the long-used shape from src/dpg-backlinks.ts plus an offset. */
export const domainsRequest = (target: string, offset: number) => [{ target, include_subdomains: true, limit: PAGE, offset, order_by: ["rank,desc"], backlinks_status_type: "live" }];
/** Lost sites. `backlinks_status_type: "lost"` and `order_by lost_date` are UNVERIFIED LIVE. */
export const lostRequest = (target: string) => [{ target, include_subdomains: true, limit: LOST_ROW_CAP, order_by: ["lost_date,desc"], backlinks_status_type: "lost" }];
/** backlinks/anchors/live, the own site only. */
export const anchorsRequest = (target: string) => [{ target, include_subdomains: true, limit: ANCHOR_LIMIT, order_by: ["backlinks,desc"], backlinks_status_type: "live" }];
/** Sites using a declared spam wording. The `like` filter on `anchor` with `%` and `or` between conditions is UNVERIFIED LIVE. */
export function spamAnchorRequest(target: string, templates: readonly string[]) {
  const filters: unknown[] = [];
  templates.forEach((t, i) => { if (i) filters.push("or"); filters.push(["anchor", "like", `%${t}%`]); });
  return [{ target, include_subdomains: true, mode: "one_per_domain", limit: PAGE, filters, backlinks_status_type: "live" }];
}
/** Links to pages that are dead. `is_broken` as a filter field and `url_to_status_code` are UNVERIFIED LIVE. */
export const brokenRequest = (target: string) => [{ target, include_subdomains: true, mode: "as_is", limit: TARGET_ROW_CAP, filters: [["is_broken", "=", true]], backlinks_status_type: "live" }];
/** domain_intersection/live, the long-used shape from src/dpg-backlinks.ts. */
export function gapRequest(own: string, competitors: readonly string[]) {
  const targets: Record<string, string> = {};
  competitors.forEach((c, i) => { targets[String(i + 1)] = c; });
  return [{ targets, exclude_targets: [own], intersection_mode: "partial", include_subdomains: true, exclude_internal_backlinks: true, limit: GAP_LIMIT, order_by: ["1.rank,desc"] }];
}
export const chunks = <T,>(xs: readonly T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
export const SPAM_CHUNKS: readonly (readonly string[])[] = chunks(SPAM_ANCHOR_TEMPLATES, SPAM_CHUNK);

/* ── parsers ── */

export function parseSummary(r: any, domain: string, role: "own" | "competitor", costUsd: number | null): SummaryOut | null {
  const x = Array.isArray(r) ? r[0] : r;
  if (!x || typeof x !== "object") return null;
  const t = x.referring_links_types ?? {};
  return {
    domain, role, backlinks: num(x.backlinks), referringDomains: num(x.referring_domains), referringMainDomains: num(x.referring_main_domains),
    brokenBacklinks: num(x.broken_backlinks), anchorLinks: num(t.anchor), imageLinks: num(t.image), otherLinks: null, costUsd,
  };
}

/** One referring site. Rank is the provider's own 0 to 1,000 score. The spam field name `backlinks_spam_score` is UNVERIFIED LIVE. */
export function parseDomain(it: any, lost: boolean): DomainOut | null {
  const refDomain = host(it?.domain);
  if (!refDomain || !refDomain.includes(".")) return null;
  const backlinks = num(it?.backlinks);
  const nofollow = num(it?.referring_links_attributes?.nofollow);
  const spam = num(it?.backlinks_spam_score);
  return {
    refDomain, tld: tldOf(refDomain), rank: num(it?.rank), spamScore: spam == null ? null : Math.max(0, Math.min(100, Math.round(spam))),
    backlinks, dofollowBacklinks: backlinks != null && nofollow != null ? Math.max(0, backlinks - nofollow) : null,
    firstSeen: day(it?.first_seen), lastSeen: day(it?.last_visited ?? it?.last_seen), lostDate: lost ? day(it?.lost_date) : null, spamAnchor: null,
  };
}

/** Anchors of the client's own site: cleaned and capped, an empty one dropped, equal ones summed. */
export function parseAnchors(items: any[]): AnchorOut[] {
  const by = new Map<string, AnchorOut>();
  for (const it of items) {
    const anchor = cleanAnchor(it?.anchor);
    if (!anchor) continue;
    const cur = by.get(anchor);
    const rd = num(it?.referring_domains), bl = num(it?.backlinks);
    if (cur) { cur.referringDomains = (cur.referringDomains ?? 0) + (rd ?? 0); cur.backlinks = (cur.backlinks ?? 0) + (bl ?? 0); continue; }
    by.set(anchor, { anchor, referringDomains: rd, backlinks: bl, firstSeen: day(it?.first_seen), lastSeen: day(it?.last_visited ?? it?.last_seen) });
  }
  return Array.from(by.values()).filter((a) => a.anchor.length <= ANCHOR_MAX_CHARS);
}

/** The own-site pages links land on that are dead, from the broken-link list: paths only, a redirect to the same page dropped. */
export function parseTargets(items: any[], ownHost: string): TargetOut[] {
  const by = new Map<string, { status: number | null; redirect: string | null; backlinks: number; from: Set<string> }>();
  for (const it of items) {
    const toHost = host(it?.url_to);
    if (toHost && toHost !== ownHost && !toHost.endsWith(`.${ownHost}`)) continue;
    const path = pathOf(it?.url_to);
    if (!path) continue;
    const status = num(it?.url_to_status_code);
    const redirect = pathOf(it?.url_to_redirect_target) ?? null;
    const e = by.get(path) ?? { status, redirect, backlinks: 0, from: new Set<string>() };
    e.backlinks += 1;
    const from = host(it?.domain_from);
    if (from) e.from.add(from);
    by.set(path, e);
  }
  const rows: TargetOut[] = [];
  for (const [pagePath, e] of by) {
    const redirect = e.status != null && e.status >= 300 && e.status < 400;
    if (redirect && (e.redirect == null || e.redirect === pagePath)) continue;
    rows.push({ pagePath, kind: redirect ? "redirect" : "broken", statusCode: e.status, redirectPath: redirect ? e.redirect : null, backlinks: e.backlinks, referringDomains: e.from.size });
  }
  return rows.sort((a, b) => (b.backlinks ?? 0) - (a.backlinks ?? 0)).slice(0, TARGET_PATHS_MAX);
}

export function parseGap(items: any[], competitors: readonly string[], ownHost: string): GapOut[] {
  const out: GapOut[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const di = it?.domain_intersection ?? {};
    const keys = Object.keys(di);
    if (keys.length < 2) continue;
    const refDomain = host(di[keys[0]!]?.target);
    if (!refDomain || seen.has(refDomain) || refDomain === ownHost || competitors.includes(refDomain)) continue;
    seen.add(refDomain);
    const rank = Math.max(0, ...keys.map((k) => num(di[k]?.rank) ?? 0));
    const names = keys.map((k) => competitors[Number(k) - 1]).filter((c): c is string => !!c);
    out.push({ refDomain, rank: rank || null, spamScore: null, competitors: names });
  }
  return out;
}

/** Reasonable guess at what a whole read costs, for the line printed before any money is spent. OURS and UNVERIFIED LIVE. */
export function estimateRead(o: { domainCap: number; competitors: number }): { calls: number; rows: number } {
  const domainPages = Math.ceil(o.domainCap / PAGE);
  const calls = 1 + o.competitors + domainPages + 1 + 1 + SPAM_CHUNKS.length + 1 + (o.competitors >= 2 ? 1 : 0);
  const rows = o.domainCap + LOST_ROW_CAP + ANCHOR_LIMIT + SPAM_CHUNKS.length * PAGE + TARGET_ROW_CAP + (o.competitors >= 2 ? GAP_LIMIT : 0);
  return { calls, rows };
}

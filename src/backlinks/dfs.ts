/**
 * What is read for one domain: the backlink summary, the new and lost counts over 30 days and the ten referring
 * domains with the most links. Three calls. A call that fails leaves its part null (unanswered, never a nought) and
 * is named; the other parts are still kept.
 *
 * REQUEST SHAPES UNVERIFIED LIVE (docs/BACKLINKS.md lists them): /backlinks/summary/live,
 * /backlinks/timeseries_new_lost_summary/live and /backlinks/referring_domains/live, and the field names read from
 * their answers. Nothing here keeps an anchor text, a page address or a person.
 */
import { safeMessage } from "../page-behaviour/http.js";
import { normaliseDomain } from "./competitors.js";
import { NEW_LOST_DAYS, TOP_REFERRING_DOMAINS, type BacklinkRole, type DfsAnswer, type DfsCall, type DomainRead } from "./types.js";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

export const addDaysYmd = (ymd: string, n: number): string => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const SUMMARY_PATH = "/backlinks/summary/live";
export const NEW_LOST_PATH = "/backlinks/timeseries_new_lost_summary/live";
export const REFERRING_PATH = "/backlinks/referring_domains/live";

export const summaryBody = (target: string) => [{ target, include_subdomains: true, internal_list_limit: 0, backlinks_status_type: "live" }];
export const newLostBody = (target: string, today: string) => [{ target, date_from: addDaysYmd(today, -NEW_LOST_DAYS), date_to: today, group_range: "month", include_subdomains: true }];
export const referringBody = (target: string) => [{ target, include_subdomains: true, limit: TOP_REFERRING_DOMAINS, order_by: ["backlinks,desc"], backlinks_status_type: "live" }];

export function parseSummary(result: any): DomainRead["summary"] {
  const r = Array.isArray(result) ? result[0] : null;
  if (!r || typeof r !== "object") return null;
  const types = r.referring_links_types && typeof r.referring_links_types === "object" ? (r.referring_links_types as Record<string, unknown>) : null;
  const anchor = types ? num(types.anchor) : null;
  const image = types ? num(types.image) : null;
  const other = types ? Object.entries(types).filter(([k]) => k !== "anchor" && k !== "image").reduce((n, [, v]) => n + (num(v) ?? 0), 0) : null;
  return {
    backlinks: num(r.backlinks), referringDomains: num(r.referring_domains), referringMainDomains: num(r.referring_main_domains),
    brokenBacklinks: num(r.broken_backlinks), anchorLinks: anchor, imageLinks: image, otherLinks: other,
  };
}

export function parseNewLost(result: any): DomainRead["newLost"] {
  const items = Array.isArray(result) && Array.isArray(result[0]?.items) ? (result[0].items as any[]) : [];
  if (items.length === 0) return null;
  const sum = (k: string): number | null => { let any = false, t = 0; for (const it of items) { const v = num(it?.[k]); if (v != null) { any = true; t += v; } } return any ? t : null; };
  return { newBacklinks: sum("new_backlinks"), lostBacklinks: sum("lost_backlinks"), newDomains: sum("new_referring_domains"), lostDomains: sum("lost_referring_domains") };
}

export function parseReferring(result: any): DomainRead["topDomains"] {
  const items = Array.isArray(result) && Array.isArray(result[0]?.items) ? (result[0].items as any[]) : null;
  if (!items) return null;
  const out: NonNullable<DomainRead["topDomains"]> = [];
  for (const it of items) {
    const d = normaliseDomain(it?.domain);
    if (!d) continue;
    const fs = typeof it?.first_seen === "string" && /^\d{4}-\d{2}-\d{2}/.test(it.first_seen) ? it.first_seen.slice(0, 10) : null;
    out.push({ domain: d, backlinks: num(it?.backlinks), firstSeen: fs });
    if (out.length >= TOP_REFERRING_DOMAINS) break;
  }
  return out;
}

export async function readDomain(call: DfsCall, domain: string, role: BacklinkRole, today: string, secrets: readonly string[] = []): Promise<DomainRead> {
  const read: DomainRead = { domain, role, summary: null, newLost: null, topDomains: null, costUsd: 0, failed: [] };
  const part = async (name: string, path: string, body: unknown[], into: (r: any) => void) => {
    let a: DfsAnswer;
    try { a = await call(path, body); } catch (e) { read.failed.push(`${name}: ${safeMessage(e, secrets)}`); return; }
    read.costUsd += typeof a.cost === "number" && Number.isFinite(a.cost) ? a.cost : 0;
    into(a.result);
  };
  await part("summary", SUMMARY_PATH, summaryBody(domain), (r) => { read.summary = parseSummary(r); });
  await part("new and lost", NEW_LOST_PATH, newLostBody(domain, today), (r) => { read.newLost = parseNewLost(r); });
  await part("referring domains", REFERRING_PATH, referringBody(domain), (r) => { read.topDomains = parseReferring(r); });
  read.costUsd = Math.round(read.costUsd * 10000) / 10000;
  return read;
}

/** A domain DataForSEO has no links for at all: the summary answered with no backlinks and no referring domains. */
export const hasNothing = (r: DomainRead): boolean =>
  r.summary != null && (r.summary.backlinks ?? 0) === 0 && (r.summary.referringDomains ?? 0) === 0;

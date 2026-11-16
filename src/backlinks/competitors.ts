import { MAX_COMPETITORS } from "./types.js";

/** A bare hostname from anything a person might type: scheme, www, path and port are dropped. Null when it is not a hostname. */
export function normaliseDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0]!.replace(/:\d+$/, "");
  if (d.length < 4 || d.length > 120) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  if (/^\d+(\.\d+){3}$/.test(d)) return null;
  return d;
}

export const competitorsKey = (clientId: string) => `backlink_competitors:${clientId}`;

/**
 * The competitors a person typed for a client, from `app_settings backlink_competitors:<clientId>`
 * (`{ domains: string[], by, at }`). Unreadable, unsigned or empty reads as none. Never more than MAX_COMPETITORS,
 * never the client's own domain, never a repeat. This job never picks a competitor.
 */
export function parseCompetitors(value: string | null | undefined, ownDomain: string | null): string[] {
  if (!value) return [];
  let o: any;
  try { o = JSON.parse(value); } catch { return []; }
  if (!o || typeof o !== "object" || !Array.isArray(o.domains)) return [];
  if (typeof o.by !== "string" || !o.by.trim()) return [];
  const out: string[] = [];
  for (const d of o.domains) {
    const n = normaliseDomain(d);
    if (n && n !== ownDomain && !out.includes(n)) out.push(n);
    if (out.length >= MAX_COMPETITORS) break;
  }
  return out;
}

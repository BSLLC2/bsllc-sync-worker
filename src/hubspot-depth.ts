/**
 * R24 (2026-11-22): the two HubSpot reads that imported empty before, kept pure so the guard can drive them.
 *
 *  - A deal's associated contacts: every id on the first page of HubSpot's association list for the deal.
 *    HubSpot may page a long list; whether the v3 list endpoint inlines more than one page is UNVERIFIED,
 *    so a deal with very many contacts may arrive with only the first ones.
 *  - `hs_analytics_source_data_1/_2`: HubSpot's drill-down under the original source (a campaign, a
 *    keyword, a referring site). Free text: an email or a phone-looking run in it is replaced, never kept.
 */
import { cleanText } from "./ctm/map.js";

export interface HasAssociations { associations?: Record<string, { results?: Array<{ id: string }> }> }

export function assocAll(o: HasAssociations, type: string): string[] {
  const r = o.associations?.[type]?.results ?? [];
  return Array.from(new Set(r.map((x) => String(x?.id ?? "").trim()).filter(Boolean)));
}

export function sourceDetail(v: unknown): string | null {
  return cleanText(v, 160);
}

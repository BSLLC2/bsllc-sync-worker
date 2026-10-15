/**
 * One inspection: the request, and the answer read defensively.
 *
 * THE RESPONSE SHAPE IS WRITTEN FROM THE URL INSPECTION API REFERENCE AND HAS NOT
 * BEEN RUN AGAINST A LIVE PROPERTY. The parser reads every field by name, treats a
 * missing one as null (never as a value), and refuses an answer with no index
 * result at all, because an answer with nothing in it must never read as "indexed".
 * `docs/INTEGRATIONS-SETUP.md` in the dashboard repository lists what is unverified.
 */
import { postJson } from "../page-behaviour/http.js";
import { serviceUrl, text } from "../signals/common.js";
import type { FetchLike } from "../page-behaviour/types.js";
import { INSPECT_ENDPOINT } from "./types.js";

export function inspectionBody(inspectionUrl: string, siteUrl: string) {
  return { inspectionUrl, siteUrl, languageCode: "en-US" };
}

export interface InspectionFacts {
  verdict: string | null;
  coverageState: string | null;
  indexingState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlAt: Date | null;
  pageFetchState: string | null;
  robotsTxtState: string | null;
  mobileVerdict: string | null;
  richResultsJson: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A time from the answer, or null. Google sends RFC 3339. */
function when(v: unknown): Date | null {
  const t = text(v, 40);
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Rich results kept SMALL: the overall verdict, and per type how many items and how many problems. */
export function richResultsSmall(rr: Obj | null): string | null {
  if (!rr) return null;
  const types = arr(rr.detectedItems).map((d) => {
    const item = obj(d) ?? {};
    const type = text(item.richResultType, 60);
    if (!type) return null;
    const items = arr(item.items).map(obj).filter((x): x is Obj => Boolean(x));
    let issues = 0, errors = 0;
    let first: string | null = null;
    for (const it of items) {
      for (const iss of arr(it.issues)) {
        const o = obj(iss) ?? {};
        issues += 1;
        if (String(o.severity ?? "").toUpperCase() === "ERROR") errors += 1;
        if (!first) first = text(o.issueMessage, 120);
      }
    }
    return { type, items: items.length, issues, errors, first };
  }).filter((x): x is NonNullable<typeof x> => Boolean(x)).slice(0, 8);
  const verdict = text(rr.verdict, 40);
  if (!verdict && !types.length) return null;
  const json = JSON.stringify({ verdict, types });
  // "Small" is a promise the app relies on. A pathological answer is cut to the verdict alone.
  return json.length <= 1800 ? json : JSON.stringify({ verdict, types: [] });
}

/**
 * The answer to facts. Throws where the answer carries no index result, so the
 * caller records "could not look" and never an empty set of facts.
 */
export function parseInspection(json: unknown): InspectionFacts {
  const result = obj(obj(json)?.inspectionResult);
  const idx = obj(result?.indexStatusResult);
  if (!result || !idx) throw new Error("Search Console answered with no index result for this page.");
  const mobile = obj(result.mobileUsabilityResult);
  return {
    verdict: text(idx.verdict, 40),
    coverageState: text(idx.coverageState, 200),
    indexingState: text(idx.indexingState, 60),
    googleCanonical: text(idx.googleCanonical, 500),
    userCanonical: text(idx.userCanonical, 500),
    lastCrawlAt: when(idx.lastCrawlTime),
    pageFetchState: text(idx.pageFetchState, 60),
    robotsTxtState: text(idx.robotsTxtState, 60),
    mobileVerdict: text(mobile?.verdict, 40),
    richResultsJson: richResultsSmall(obj(result.richResultsResult)),
  };
}

export async function inspectUrl(f: FetchLike, token: string, url: string, siteUrl: string): Promise<InspectionFacts> {
  const json = await postJson(f, serviceUrl("gsc", INSPECT_ENDPOINT), { Authorization: `Bearer ${token}` }, inspectionBody(url, siteUrl), "Search Console URL inspection");
  return parseInspection(json);
}

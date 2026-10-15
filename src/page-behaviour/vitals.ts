/**
 * Chrome's field data (the Chrome UX Report API) per page and form factor, and an
 * optional lab test (PageSpeed Insights) of the busiest few pages.
 *
 * FIELD DATA IS REAL VISITORS; A LAB TEST IS NOT. They land in the same table under
 * different `source` values (`crux_url`, `crux_origin`, `psi_lab`) so a reader can
 * never mistake one for the other, and the dashboard says "a test, not real
 * visitors" wherever a lab figure is shown.
 *
 * A page with too few visitors for Chrome gets NO row of figures: the API answers
 * not-found, which is stored as `state = no_data` with null figures. Never a pass.
 *
 * None of the request or response shapes below has been run against the live APIs.
 * They are written from the published reference and listed as unverified in
 * docs/SEO-PAGE-BEHAVIOUR.md. The one Google key (`CRUX_API_KEY`) is read from the
 * environment by the caller; it is never stored, logged or put in a stored message.
 */
import { HttpError, getJson, postJson } from "./http.js";
import type { FetchLike, FormFactor, VitalRowOut } from "./types.js";

export const CRUX_URL = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
export const PSI_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
export const CRUX_METRICS = ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift"] as const;

export function cruxRequest(target: { url: string } | { origin: string }, formFactor: FormFactor) {
  return { ...target, formFactor, metrics: [...CRUX_METRICS] };
}

interface CruxDate { year?: number; month?: number; day?: number }
const pad = (n: number) => String(n).padStart(2, "0");
const dateStr = (d: CruxDate | undefined): string | null => (d && d.year && d.month && d.day ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : null);

/** The 75th percentile arrives as a number for time and as a string for layout shift. */
const p75 = (m: unknown): number | null => {
  const v = (m as { percentiles?: { p75?: unknown } } | undefined)?.percentiles?.p75;
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface CruxParsed { lcpMs: number | null; inpMs: number | null; cls: number | null; first: string | null; last: string | null }

export function parseCrux(json: unknown): CruxParsed | null {
  const rec = (json as { record?: { metrics?: Record<string, unknown>; collectionPeriod?: { firstDate?: CruxDate; lastDate?: CruxDate } } } | null)?.record;
  if (!rec || !rec.metrics) return null;
  const m = rec.metrics;
  return {
    lcpMs: p75(m.largest_contentful_paint), inpMs: p75(m.interaction_to_next_paint), cls: p75(m.cumulative_layout_shift),
    first: dateStr(rec.collectionPeriod?.firstDate), last: dateStr(rec.collectionPeriod?.lastDate),
  };
}

/** The API's "no data for this page" answer: not found, with a message about the record. */
export function isCruxNoData(e: unknown): boolean {
  if (!(e instanceof HttpError) || e.status !== 404) return false;
  return /not\s*found|no data|chrome ux report data/i.test(e.body);
}

export async function readCrux(f: FetchLike, key: string, target: { url: string } | { origin: string }, formFactor: FormFactor): Promise<CruxParsed | "no_data"> {
  try {
    const json = await postJson(f, `${CRUX_URL}?key=${encodeURIComponent(key)}`, {}, cruxRequest(target, formFactor), "Chrome UX Report");
    const parsed = parseCrux(json);
    // A record with none of the three measures is the same as no record.
    if (!parsed || (parsed.lcpMs == null && parsed.inpMs == null && parsed.cls == null)) return "no_data";
    return parsed;
  } catch (e) {
    if (isCruxNoData(e)) return "no_data";
    throw e;
  }
}

export function vitalRow(path: string, source: "crux_url" | "crux_origin", formFactor: FormFactor, r: CruxParsed | "no_data" | { error: string }): VitalRowOut {
  if (r === "no_data") return { pagePath: path, formFactor, source, lcpMs: null, inpMs: null, cls: null, collectionFirst: null, collectionLast: null, state: "no_data", detail: "Chrome has too few visitors on this page to report." };
  if ("error" in r) return { pagePath: path, formFactor, source, lcpMs: null, inpMs: null, cls: null, collectionFirst: null, collectionLast: null, state: "error", detail: r.error };
  return { pagePath: path, formFactor, source, lcpMs: r.lcpMs, inpMs: r.inpMs, cls: r.cls, collectionFirst: r.first, collectionLast: r.last, state: "ok", detail: null };
}

/* ───────────────────────── the lab test ───────────────────────── */

export interface PsiParsed { lcpMs: number | null; cls: number | null }

export function psiUrl(pageUrl: string, key: string): string {
  return `${PSI_URL}?url=${encodeURIComponent(pageUrl)}&strategy=mobile&category=performance&key=${encodeURIComponent(key)}`;
}

export function parsePsi(json: unknown): PsiParsed | null {
  const audits = (json as { lighthouseResult?: { audits?: Record<string, { numericValue?: unknown }> } } | null)?.lighthouseResult?.audits;
  if (!audits) return null;
  const n = (id: string): number | null => {
    const v = audits[id]?.numericValue;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const out = { lcpMs: n("largest-contentful-paint"), cls: n("cumulative-layout-shift") };
  return out.lcpMs == null && out.cls == null ? null : out;
}

export async function readPsi(f: FetchLike, key: string, pageUrl: string): Promise<PsiParsed | null> {
  return parsePsi(await getJson(f, psiUrl(pageUrl, key), {}, "PageSpeed Insights"));
}

export function psiRow(path: string, r: PsiParsed | null | { error: string }): VitalRowOut {
  if (r && "error" in r) return { pagePath: path, formFactor: "PHONE", source: "psi_lab", lcpMs: null, inpMs: null, cls: null, collectionFirst: null, collectionLast: null, state: "error", detail: r.error };
  if (!r) return { pagePath: path, formFactor: "PHONE", source: "psi_lab", lcpMs: null, inpMs: null, cls: null, collectionFirst: null, collectionLast: null, state: "no_data", detail: "The lab test returned no timing." };
  // A lab test has no interaction measure, so it is null here and not nought.
  return { pagePath: path, formFactor: "PHONE", source: "psi_lab", lcpMs: r.lcpMs, inpMs: null, cls: r.cls, collectionFirst: null, collectionLast: null, state: "ok", detail: null };
}

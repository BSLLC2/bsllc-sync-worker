/**
 * One client's URL inspection run, with the status it ends as.
 *
 * Takes a fetch and a token, so the guard drives the real orchestration against a
 * pretend Google with no database. Returns rows and ONE status; writing them is
 * `store.ts`'s job.
 *
 * WHAT STOPS A RUN, EACH ITS OWN STATUS:
 *   - no property on the account: `off`.
 *   - the day's allowance (ours, below Google's published figure) is used: `capped`.
 *   - Google answers 429: `capped`, and it says Google's limit, not ours.
 *   - Google answers 401 or 403 on the first call: `error`, naming the likely cause
 *     (the service account is not a full user on the property). The remaining pages
 *     are not tried; every one would fail the same way and spend quota doing it.
 *   - three failures in a row of any other kind: `error`, and the run stops.
 *   - a single page Google will not inspect (a 400, a bad address): that page is an
 *     `error` row ("could not look") and the run goes on.
 */
import { HttpError, safeMessage } from "../page-behaviour/http.js";
import { normPath, siteOrigin } from "../page-behaviour/paths.js";
import type { FetchLike } from "../page-behaviour/types.js";
import { signalRun, sleep, type SignalRunOut } from "../signals/common.js";
import { inspectUrl } from "./inspect.js";
import { allowance, dueOnly, pickPages, type PageStat, type Picked } from "./pick.js";
import { INSPECT_RUN_MAX, STOP_AFTER_FAILURES, type InspectionRowOut } from "./types.js";

export interface InspectCtx {
  id: string;
  name: string;
  /** The Search Console property exactly as the connector row holds it. */
  property: string | null;
  /** The site's domain on the client record. */
  domain: string | null;
  /** Addresses the page reader reached, which show whether the site uses www. */
  observedUrls: string[];
  /** Real addresses by normalised path, from the page reader. */
  knownUrls: ReadonlyMap<string, string>;
  stats: PageStat[];
  /** Good inspections already made, by path. */
  lastOk: ReadonlyMap<string, Date>;
  /** Inspections already made for this property today, any outcome. */
  usedToday: number;
}

export interface InspectDeps {
  fetch: FetchLike;
  token: () => Promise<string>;
  now: Date;
  pauseMs?: number;
  /** Plan only: no call to Google's inspection endpoint. */
  dryRun?: boolean;
  secrets?: readonly (string | undefined)[];
  /** The most to inspect in one run. Defaults to our own run limit. */
  runMax?: number;
}

export interface InspectResult {
  rows: InspectionRowOut[];
  run: SignalRunOut;
  /** The pages it would inspect, for a dry run to print. */
  plan: Array<{ url: string; pickedFor: string }>;
}

/** The address to inspect for a path: the one the page reader saw, else the property's own site. */
export function addressFor(path: string, ctx: Pick<InspectCtx, "property" | "domain" | "observedUrls" | "knownUrls">): string | null {
  const known = ctx.knownUrls.get(path);
  if (known) return known;
  const prefix = ctx.property && /^https?:\/\//i.test(ctx.property) ? ctx.property.replace(/\/+$/, "") : null;
  const origin = prefix ?? siteOrigin(ctx.domain, ctx.observedUrls);
  return origin ? `${origin}${path === "/" ? "/" : path}` : null;
}

export async function inspectClient(ctx: InspectCtx, deps: InspectDeps): Promise<InspectResult> {
  const out: InspectResult = { rows: [], run: signalRun("gsc_inspect", "ok", null), plan: [] };
  if (!ctx.property) {
    out.run = signalRun("gsc_inspect", "off", "No Search Console property is connected for this account.");
    return out;
  }
  const property = ctx.property;
  const say = (e: unknown) => safeMessage(e, deps.secrets ?? []);
  const left = allowance(ctx.usedToday);
  if (left <= 0) {
    out.run = signalRun("gsc_inspect", "capped", "Today's allowance of inspections for this property is used. Our own limit is lower than Google's.", { capped: true });
    return out;
  }
  const picked = dueOnly(pickPages(ctx.stats, deps.runMax ?? INSPECT_RUN_MAX), ctx.lastOk, deps.now).slice(0, left);
  const targets: Array<{ p: Picked; url: string }> = [];
  for (const p of picked) {
    const url = addressFor(p.path, ctx);
    if (url) targets.push({ p, url });
  }
  out.plan = targets.map((t) => ({ url: t.url, pickedFor: t.p.pickedFor }));
  if (!targets.length) {
    out.run = signalRun("gsc_inspect", "no_data", picked.length ? "No address could be built for the pages chosen; the account has no website on record." : "Every page of interest was inspected recently.");
    return out;
  }
  if (deps.dryRun) {
    // A dry run proves the key works (a token is not an inspection) and spends none.
    try { await deps.token(); } catch (e) { out.run = signalRun("gsc_inspect", "error", say(e)); return out; }
    out.run = signalRun("gsc_inspect", "ok", `Dry run: would inspect ${targets.length} page${targets.length === 1 ? "" : "s"}.`, { rows: 0, totalFound: targets.length });
    return out;
  }
  let token: string;
  try { token = await deps.token(); } catch (e) {
    out.run = signalRun("gsc_inspect", "error", say(e));
    return out;
  }
  let failures = 0, ok = 0, stoppedBy: "quota" | "access" | "failures" | null = null;
  let lastError: string | null = null;
  for (let i = 0; i < targets.length; i++) {
    const { p, url } = targets[i]!;
    const base = { url, pagePath: normPath(p.path), siteUrl: property, pickedFor: p.pickedFor, inspectedAt: new Date(deps.now.getTime() + i) };
    try {
      const facts = await inspectUrl(deps.fetch, token, url, property);
      out.rows.push({ ...base, state: "ok", detail: null, ...facts });
      ok += 1; failures = 0;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : null;
      lastError = say(e);
      if (status === 429) { stoppedBy = "quota"; break; }
      if ((status === 401 || status === 403) && ok === 0) { stoppedBy = "access"; break; }
      out.rows.push({
        ...base, state: "error", detail: status === 400 ? "Google would not inspect this address for the property." : lastError,
        verdict: null, coverageState: null, indexingState: null, googleCanonical: null, userCanonical: null, lastCrawlAt: null,
        pageFetchState: null, robotsTxtState: null, mobileVerdict: null, richResultsJson: null,
      });
      failures += 1;
      if (failures >= STOP_AFTER_FAILURES) { stoppedBy = "failures"; break; }
    }
    if (deps.pauseMs && i < targets.length - 1) await sleep(deps.pauseMs);
  }
  const stats = { rows: ok, totalFound: targets.length };
  if (stoppedBy === "quota") out.run = signalRun("gsc_inspect", "capped", `Google's own daily limit for this property was reached after ${ok} page${ok === 1 ? "" : "s"}.`, { ...stats, capped: true });
  else if (stoppedBy === "access") out.run = signalRun("gsc_inspect", "error", `Search Console refused the first inspection. The service account may not be a full user on this property. ${lastError ?? ""}`.trim());
  else if (stoppedBy === "failures") out.run = signalRun("gsc_inspect", "error", `Stopped after ${STOP_AFTER_FAILURES} failures in a row. The last: ${lastError ?? "unknown"}`, stats);
  else if (ok === 0) out.run = signalRun("gsc_inspect", "error", lastError ?? "No page could be inspected.", stats);
  else if (out.rows.some((r) => r.state === "error")) out.run = signalRun("gsc_inspect", "ok", `${out.rows.filter((r) => r.state === "error").length} page(s) could not be inspected.`, stats);
  else out.run = signalRun("gsc_inspect", "ok", null, stats);
  return out;
}

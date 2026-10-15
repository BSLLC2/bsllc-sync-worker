/**
 * One client's Bing read, as a function of injected dependencies so a guard can drive
 * it against a pretend Bing.
 *
 * Every ending is a status the dashboard can say in a sentence (src/signals/common.ts).
 * Nothing here throws to the caller. The site comes from the connector row a person
 * filled in (Admin, Connectors, Bing) and is checked against the list of sites Bing
 * says the key can read; it is never derived from the client's website.
 */
import { HttpError, safeMessage } from "../page-behaviour/http.js";
import type { FetchLike } from "../page-behaviour/types.js";
import { SECRET_NAMES } from "../signals/secrets.js";
import { signalRun, sleep, type SignalRunOut } from "../signals/common.js";
import {
  callMethod, capByTotal, classifyMethodAnswer, isKeyRefusal, joinSiteDays, parseCrawl, parseIssues, parsePages, parseQueries, parseSites, parseTraffic, siteKey, unwrap,
} from "./api.js";
import {
  AI_CITATION_PROBE_METHOD, BING_ISSUE_CAP, BING_METHODS, BING_PAGE_ROW_CAP, BING_QUERY_ROW_CAP,
  type BingAiStatus, type BingIssueRow, type BingPageRow, type BingQueryRow, type BingSiteDayRow,
} from "./types.js";

export interface BingCtx { name: string; slug: string; /** The site exactly as a person typed it in Admin, Connectors, or null. */ site: string | null }
export interface BingDeps { fetch: FetchLike; apiKey: string | null; now: Date; pauseMs?: number; dryRun?: boolean; secrets?: readonly string[] }
export interface BingResult {
  siteUrl: string | null;
  verified: boolean | null;
  queries: BingQueryRow[];
  pages: BingPageRow[];
  siteDays: BingSiteDayRow[];
  issues: BingIssueRow[];
  ai: BingAiStatus;
  run: SignalRunOut;
  /** The parts of the read that failed, by name. */
  failed: string[];
}

const KEY_REFUSED = "Bing did not accept the API key. Create a new key in Bing Webmaster Tools (Settings, API access) and replace the BING_WEBMASTER_API_KEY secret.";

export async function readBingClient(ctx: BingCtx, deps: BingDeps): Promise<BingResult> {
  const out: BingResult = { siteUrl: null, verified: null, queries: [], pages: [], siteDays: [], issues: [], ai: "unknown", run: signalRun("bing", "ok", null), failed: [] };
  const say = (e: unknown) => safeMessage(e, deps.secrets ?? []);
  if (!ctx.site || !ctx.site.trim()) {
    out.run = signalRun("bing", "off", "No Bing site is recorded for this account.");
    return out;
  }
  if (!/^https?:\/\/[^\s/]+/i.test(ctx.site.trim())) {
    out.run = signalRun("bing", "error", "The Bing site recorded for this account is not a web address. It should be the address exactly as it is listed in Bing Webmaster Tools, starting with https://.");
    return out;
  }
  if (!deps.apiKey) {
    out.run = signalRun("bing", "no_key", `${SECRET_NAMES.bing} is not set on the worker, so no Bing figure was read. Create the key in Bing Webmaster Tools and add it as a repository secret by that name.`);
    return out;
  }
  const key = deps.apiKey;
  const pause = () => (deps.pauseMs ? sleep(deps.pauseMs) : Promise.resolve());

  // Which sites can this key read? A site that is not on the list is a different problem from a failed read.
  let siteUrl = ctx.site.trim();
  try {
    const sites = parseSites(await callMethod(deps.fetch, BING_METHODS.sites, key, null));
    const hit = sites.find((s) => siteKey(s.url) === siteKey(siteUrl));
    if (!hit) {
      out.run = signalRun("bing", "error", `Bing does not list ${siteUrl} under this key's account. Add the site in Bing Webmaster Tools (importing it from Search Console works), or correct the address recorded for ${ctx.name}.`);
      return out;
    }
    siteUrl = hit.url;
    out.verified = hit.verified;
    if (hit.verified === false) {
      out.siteUrl = siteUrl;
      out.run = signalRun("bing", "error", `Bing lists ${siteUrl} but has not verified it, so it gives no figures. Verify the site in Bing Webmaster Tools.`);
      return out;
    }
  } catch (e) {
    out.run = isKeyRefusal(e) ? signalRun("bing", "no_key", KEY_REFUSED) : signalRun("bing", "error", `Could not ask Bing which sites this key can read: ${say(e)}`);
    return out;
  }
  out.siteUrl = siteUrl;
  if (deps.dryRun) {
    out.run = signalRun("bing", "ok", `Dry run: Bing accepts the key and lists ${siteUrl}. Would read searches, pages, crawl counts and crawl issues.`);
    return out;
  }

  // Each part on its own: a part that fails costs that part and is named.
  const attempt = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try { const v = await fn(); await pause(); return v; } catch (e) {
      if (isKeyRefusal(e)) throw e;
      out.failed.push(name);
      detail.push(`${name} could not be read: ${say(e)}`);
      await pause();
      return null;
    }
  };
  const detail: string[] = [];
  let cappedAny = false;
  try {
    const q = await attempt("Searches", async () => parseQueries(await callMethod(deps.fetch, BING_METHODS.queries, key, siteUrl)));
    if (q) {
      const c = capByTotal(q.rows, (r) => r.query, BING_QUERY_ROW_CAP);
      out.queries = c.rows;
      if (c.dropped) { cappedAny = true; detail.push(`Only the busiest searches were kept (${c.dropped} rows set aside)`); }
    }
    const p = await attempt("Pages", async () => parsePages(await callMethod(deps.fetch, BING_METHODS.pages, key, siteUrl)));
    if (p) {
      const c = capByTotal(p.rows, (r) => r.pageUrl, BING_PAGE_ROW_CAP);
      out.pages = c.rows;
      if (c.dropped) { cappedAny = true; detail.push(`Only the busiest pages were kept (${c.dropped} rows set aside)`); }
    }
    const t = await attempt("Traffic by day", async () => parseTraffic(await callMethod(deps.fetch, BING_METHODS.traffic, key, siteUrl)));
    const cr = await attempt("Crawl counts", async () => parseCrawl(await callMethod(deps.fetch, BING_METHODS.crawl, key, siteUrl)));
    out.siteDays = joinSiteDays(t?.days ?? null, cr?.days ?? null);
    const iss = await attempt("Crawl issues", async () => parseIssues(await callMethod(deps.fetch, BING_METHODS.issues, key, siteUrl)));
    if (iss) {
      out.issues = iss.rows.slice(0, BING_ISSUE_CAP);
      if (iss.rows.length > BING_ISSUE_CAP) { cappedAny = true; detail.push(`Only ${BING_ISSUE_CAP} of ${iss.rows.length} crawl issues were kept`); }
    }
    // AI and Copilot citations: probe by the documented not-found answer; never store what it says.
    try {
      const body = unwrap(await callMethod(deps.fetch, AI_CITATION_PROBE_METHOD, key, siteUrl));
      out.ai = "answered_not_mapped";
      detail.push(`Bing answers the AI citation method (${Array.isArray(body) ? body.length : "not a list"}); its shape is not mapped, so nothing from it is stored`);
    } catch (e) {
      if (isKeyRefusal(e)) throw e;
      out.ai = classifyMethodAnswer(e) === "absent" ? "unavailable" : "unknown";
    }
  } catch (e) {
    // A key refused part way through.
    out.run = signalRun("bing", "no_key", KEY_REFUSED);
    return out;
  }

  const rows = out.queries.length + out.pages.length + out.siteDays.length;
  const newest = out.siteDays.map((d) => d.day).sort().at(-1) ?? out.queries.map((d) => d.day).sort().at(-1) ?? null;
  const everythingFailed = out.failed.length >= 4;
  if (everythingFailed) {
    out.run = signalRun("bing", "error", `Bing accepted the key but none of the counts could be read. ${detail.slice(0, 2).join(". ")}.`);
    return out;
  }
  if (!rows && !out.issues.length && !out.failed.length) {
    out.run = signalRun("bing", "no_data", "Bing answered with no searches, pages or crawl counts for this site.", { windowEnd: newest });
    return out;
  }
  out.run = signalRun("bing", out.failed.length || cappedAny ? "capped" : "ok", detail.length ? `${detail.join(". ")}.` : null, { rows, capped: out.failed.length > 0 || cappedAny, totalFound: out.issues.length, windowEnd: newest });
  return out;
}
export { HttpError };

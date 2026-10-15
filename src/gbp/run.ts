/**
 * One client's Business Profile read, as a function of injected dependencies so a
 * guard can drive it against a pretend Google.
 *
 * Every ending is a status the dashboard can say in a sentence (see
 * `src/signals/common.ts`). Nothing here throws to the caller: a failed read is a
 * status with a message that carries no key and no token.
 */
import { HttpError, safeMessage } from "../page-behaviour/http.js";
import type { FetchLike } from "../page-behaviour/types.js";
import { SECRET_NAMES } from "../signals/secrets.js";
import type { GbpClient } from "../signals/secrets.js";
import { signalRun, sleep, ymd, type SignalRunOut } from "../signals/common.js";
import { TokenRefused, exchangeRefreshToken, fetchDaily, fetchKeywords, parseDaily, parseKeywords } from "./api.js";
import {
  GBP_END_LAG_DAYS, GBP_KEYWORDS_PER_MONTH, GBP_KEYWORD_MAX_PAGES, GBP_KEYWORD_MONTHS, GBP_LOCATION_ID_RE, GBP_WINDOW_DAYS,
  type GbpDayRow, type GbpKeywordRow,
} from "./types.js";

export interface GbpCtx {
  name: string;
  slug: string;
  /** The location id exactly as a person typed it in Admin, Connectors, or null. */
  location: string | null;
  /** Months of search terms already stored for this location. */
  storedMonths: Set<string>;
}
export interface GbpDeps {
  fetch: FetchLike;
  oauthClient: GbpClient | null;
  /** client slug to refresh token */
  refreshTokens: Map<string, string>;
  now: Date;
  pauseMs?: number;
  dryRun?: boolean;
  secrets?: readonly string[];
}
export interface GbpResult {
  locationId: string | null;
  daily: GbpDayRow[];
  keywords: GbpKeywordRow[];
  run: SignalRunOut;
  plan: { start: string; end: string; months: string[] } | null;
}

/** "locations/123" or "123" to the digits, or null where it is not a location id. */
export function locationIdOf(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim().replace(/^locations\//i, "");
  return GBP_LOCATION_ID_RE.test(t) ? t : null;
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** The complete months to read search terms for: the newest complete one always, older ones only when none is stored. */
export function keywordMonths(now: Date, stored: Set<string>): string[] {
  const months: string[] = [];
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  for (let i = 1; i <= GBP_KEYWORD_MONTHS; i++) {
    const d = new Date(Date.UTC(y, m - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (i === 1 || !stored.has(key)) months.push(key);
  }
  return months;
}

const API_PROSE = "Business Profile API access has to be approved by Google for the Google Cloud project before it works, and the Google account that authorised it has to manage this location.";

export async function readGbpClient(ctx: GbpCtx, deps: GbpDeps): Promise<GbpResult> {
  const out: GbpResult = { locationId: null, daily: [], keywords: [], run: signalRun("gbp", "ok", null), plan: null };
  const say = (e: unknown) => safeMessage(e, deps.secrets ?? []);
  if (!ctx.location || !ctx.location.trim()) {
    out.run = signalRun("gbp", "off", "No Business Profile location is recorded for this account.");
    return out;
  }
  const locationId = locationIdOf(ctx.location);
  if (!locationId) {
    out.run = signalRun("gbp", "error", "The Business Profile location recorded for this account is not a location id. It should be the number of digits that identifies the location, not its name or address.");
    return out;
  }
  out.locationId = locationId;
  if (!deps.oauthClient) {
    out.run = signalRun("gbp", "no_key", `${SECRET_NAMES.gbpClient} is not set on the worker, so no Business Profile count was read. Add the Google Cloud OAuth client as a repository secret by that name.`);
    return out;
  }
  const refresh = deps.refreshTokens.get(ctx.slug);
  if (!refresh) {
    out.run = signalRun("gbp", "no_token", `${SECRET_NAMES.gbpTokens} has no entry for "${ctx.slug}", so no Business Profile count was read for ${ctx.name}. Authorise the profile once and add its refresh token under that name.`);
    return out;
  }
  const end = ymd(addDays(deps.now, -GBP_END_LAG_DAYS));
  const start = ymd(addDays(deps.now, -GBP_END_LAG_DAYS - GBP_WINDOW_DAYS + 1));
  const months = keywordMonths(deps.now, ctx.storedMonths);
  out.plan = { start, end, months };

  let token: string;
  try { token = await exchangeRefreshToken(deps.fetch, deps.oauthClient, refresh); } catch (e) {
    if (e instanceof TokenRefused) out.run = signalRun("gbp", "no_token", `${e.message} Authorise ${ctx.name}'s profile again and replace its entry in ${SECRET_NAMES.gbpTokens}.`);
    else out.run = signalRun("gbp", "error", `Could not get a Google access token: ${say(e)}`);
    return out;
  }
  if (deps.dryRun) {
    out.run = signalRun("gbp", "ok", `Dry run: the authorisation works. Would read ${GBP_WINDOW_DAYS} days of counts and ${months.length} month${months.length === 1 ? "" : "s"} of search terms.`);
    return out;
  }

  // Daily counts: the part the dashboard reads first. A failure here is the run's failure.
  let unknownMetrics: string[] = [];
  try {
    const parsed = parseDaily(await fetchDaily(deps.fetch, token, locationId, start, end));
    out.daily = parsed.rows;
    unknownMetrics = parsed.unknownMetrics;
  } catch (e) {
    const status = e instanceof HttpError ? e.status : null;
    if (status === 403) out.run = signalRun("gbp", "error", `Google refused the read for this location. ${API_PROSE}`);
    else if (status === 404) out.run = signalRun("gbp", "error", "Google does not know this location id for the authorising account. Check the id recorded for the account.");
    else if (status === 429) out.run = signalRun("gbp", "capped", `Google's limit was reached before anything was read. A new Google Cloud project has a limit of zero until Business Profile access is approved. ${API_PROSE}`, { capped: true });
    else out.run = signalRun("gbp", "error", say(e));
    return out;
  }

  // Search terms: a failure here costs the terms and nothing else.
  let keywordNote: string | null = null;
  let cappedTerms = false;
  for (let i = 0; i < months.length; i++) {
    const month = months[i]!;
    let pageToken: string | null = null;
    const got: GbpKeywordRow[] = [];
    try {
      for (let page = 0; page < GBP_KEYWORD_MAX_PAGES; page++) {
        const parsed = parseKeywords(await fetchKeywords(deps.fetch, token, locationId, month, pageToken), month);
        got.push(...parsed.rows);
        pageToken = parsed.next;
        if (!pageToken) break;
        if (deps.pauseMs) await sleep(deps.pauseMs);
      }
      if (pageToken) cappedTerms = true;
    } catch (e) {
      keywordNote = `Search terms could not be read for ${month}: ${say(e)}`;
      break;
    }
    got.sort((a, b) => b.impressions - a.impressions);
    if (got.length > GBP_KEYWORDS_PER_MONTH) cappedTerms = true;
    out.keywords.push(...got.slice(0, GBP_KEYWORDS_PER_MONTH));
    if (deps.pauseMs && i < months.length - 1) await sleep(deps.pauseMs);
  }

  const days = new Set(out.daily.map((r) => r.day)).size;
  const newest = out.daily.map((r) => r.day).sort().at(-1) ?? null;
  const bits: string[] = [];
  if (unknownMetrics.length) bits.push(`${unknownMetrics.length} count${unknownMetrics.length === 1 ? "" : "s"} Google sent that this reader has no name for were set aside`);
  if (keywordNote) bits.push(keywordNote);
  if (cappedTerms) bits.push("Only the most-searched terms of a month were kept");
  if (!out.daily.length) {
    out.run = signalRun("gbp", "no_data", `Business Profile sent no counts for ${start} to ${end}.${bits.length ? ` ${bits.join(". ")}.` : ""}`, { windowEnd: end });
    return out;
  }
  const detail = bits.length ? `${bits.join(". ")}.` : null;
  out.run = signalRun("gbp", cappedTerms || keywordNote ? "capped" : "ok", detail, { rows: out.daily.length, capped: cappedTerms || Boolean(keywordNote), totalFound: days, windowEnd: newest });
  return out;
}

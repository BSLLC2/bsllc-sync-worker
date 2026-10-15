/**
 * One client's call-log read, as a function of injected dependencies so a guard can
 * drive it against a pretend CTM. Every ending is a status the dashboard can say in a
 * sentence. Nothing here throws to the caller.
 */
import { HttpError, safeMessage } from "../page-behaviour/http.js";
import type { FetchLike } from "../page-behaviour/types.js";
import { SECRET_NAMES, type CtmKeys } from "../signals/secrets.js";
import { signalRun, sleep, ymd, type SignalRunOut } from "../signals/common.js";
import { fetchCalls, isKeyRefusal, parseCallsPage } from "./api.js";
import { buildCall } from "./map.js";
import { CTM_MAX_DAYS, CTM_MAX_PAGES, CTM_PER_PAGE, CTM_WINDOW_DAYS, type CtmCallRow } from "./types.js";

export interface CtmCtx { name: string; slug: string; /** The CTM account id recorded in Admin, Connectors, or null. */ recorded: string | null }
export interface CtmDeps {
  fetch: FetchLike;
  keys: Map<string, CtmKeys>;
  /** The key callers' numbers are hashed with, or null. There is no fallback. */
  hashKey: string | null;
  now: Date;
  days?: number;
  pauseMs?: number;
  dryRun?: boolean;
  secrets?: readonly string[];
}
export interface CtmResult {
  calls: CtmCallRow[];
  skipped: { noId: number; noTime: number };
  run: SignalRunOut;
  window: { start: string; end: string } | null;
}

const digits = (s: string | null | undefined): string => (s ?? "").replace(/\D/g, "");
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

export async function readCtmClient(ctx: CtmCtx, deps: CtmDeps): Promise<CtmResult> {
  const out: CtmResult = { calls: [], skipped: { noId: 0, noTime: 0 }, run: signalRun("ctm", "ok", null), window: null };
  const say = (e: unknown) => safeMessage(e, deps.secrets ?? []);
  const keys = deps.keys.get(ctx.slug);
  // A client with no CallTrackingMetrics row switched on is off. The keys alone never switch a client on.
  if (ctx.recorded === null) {
    out.run = signalRun("ctm", "off", "No CallTrackingMetrics account is recorded for this account.");
    return out;
  }
  if (!deps.hashKey) {
    out.run = signalRun("ctm", "no_key", `${SECRET_NAMES.ctmHash} is not set on the worker (or is under 24 characters), so no call was read. A caller's number is stored only as a salted hash, and there is no fallback key. Add any long random string as a repository secret by that name, once, and keep it for good.`);
    return out;
  }
  if (!keys) {
    out.run = signalRun("ctm", "no_key", `${SECRET_NAMES.ctmKeys} has no entry for "${ctx.slug}", so no call was read for ${ctx.name}. Add that client's access key, secret key and account id under that name.`);
    return out;
  }
  const accountId = digits(keys.accountId) || digits(ctx.recorded);
  if (!accountId) {
    out.run = signalRun("ctm", "error", "No CallTrackingMetrics account number is recorded for this account. Put it in Admin, Connectors, or in the account id of the entry in CTM_ACCOUNT_KEYS_JSON.");
    return out;
  }
  if (keys.accountId && digits(ctx.recorded) && digits(keys.accountId) !== digits(ctx.recorded)) {
    out.run = signalRun("ctm", "error", `The CallTrackingMetrics account recorded for ${ctx.name} (${digits(ctx.recorded)}) is not the one in its entry in CTM_ACCOUNT_KEYS_JSON (${digits(keys.accountId)}). Nothing was read until they agree.`);
    return out;
  }
  const days = Math.min(Math.max(deps.days ?? CTM_WINDOW_DAYS, 1), CTM_MAX_DAYS);
  const end = ymd(deps.now);
  const start = ymd(addDays(deps.now, -(days - 1)));
  out.window = { start, end };

  let page = 1;
  let totalPages: number | null = null;
  let totalEntries: number | null = null;
  let pagesRead = 0;
  let capped = false;
  while (true) {
    let got;
    try {
      got = parseCallsPage(await fetchCalls(deps.fetch, keys, accountId, start, end, page, deps.dryRun ? 1 : CTM_PER_PAGE));
    } catch (e) {
      if (isKeyRefusal(e)) out.run = signalRun("ctm", "no_key", `CallTrackingMetrics did not accept the keys for ${ctx.name}. Make new keys in CallTrackingMetrics and replace its entry in ${SECRET_NAMES.ctmKeys}.`);
      else if (e instanceof HttpError && e.status === 404) out.run = signalRun("ctm", "error", `CallTrackingMetrics does not know account ${accountId}. Check the account number.`);
      else if (e instanceof HttpError && e.status === 429) out.run = signalRun("ctm", "capped", `CallTrackingMetrics' limit was reached after ${out.calls.length} calls. The rest is read on the next run.`, { capped: true, rows: out.calls.length });
      else out.run = signalRun("ctm", pagesRead ? "capped" : "error", `${pagesRead ? `Stopped after page ${pagesRead}: ` : ""}${say(e)}`, pagesRead ? { capped: true, rows: out.calls.length } : {});
      return out;
    }
    pagesRead += 1;
    totalPages = got.totalPages ?? totalPages;
    totalEntries = got.totalEntries ?? totalEntries;
    if (deps.dryRun) {
      out.run = signalRun("ctm", "ok", `Dry run: CallTrackingMetrics accepts the keys${totalEntries != null ? ` and has ${totalEntries} calls for ${start} to ${end}` : ""}. Nothing was read or written.`, { totalFound: totalEntries });
      return out;
    }
    for (const rec of got.calls) {
      const b = buildCall(rec, deps.hashKey);
      if ("skip" in b) { if (b.skip === "no_id") out.skipped.noId += 1; else out.skipped.noTime += 1; continue; }
      out.calls.push(b.row);
    }
    if (!got.calls.length || (totalPages != null && page >= totalPages)) break;
    if (page >= CTM_MAX_PAGES) { capped = true; break; }
    page += 1;
    if (deps.pauseMs) await sleep(deps.pauseMs);
  }

  const bits: string[] = [];
  const skippedAll = out.skipped.noId + out.skipped.noTime;
  if (skippedAll) bits.push(`${skippedAll} call${skippedAll === 1 ? "" : "s"} had no id or no readable time (with a zone) and ${skippedAll === 1 ? "was" : "were"} skipped`);
  if (capped) bits.push(`Only the first ${CTM_MAX_PAGES * CTM_PER_PAGE} calls of the window were read`);
  if (!out.calls.length && !skippedAll) {
    out.run = signalRun("ctm", "no_data", `CallTrackingMetrics answered with no calls for ${start} to ${end}.`, { windowEnd: end, totalFound: totalEntries });
    return out;
  }
  out.run = signalRun("ctm", capped ? "capped" : "ok", bits.length ? `${bits.join(". ")}.` : null, { rows: out.calls.length, capped, totalFound: totalEntries, windowEnd: end });
  return out;
}

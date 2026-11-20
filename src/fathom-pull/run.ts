/**
 * One pull of Fathom calls into the dashboard, with the network and the clock
 * handed in so the guard drives this exact code against a pretend Fathom and a
 * pretend dashboard.
 *
 * WHAT IT DOES. Pages through Fathom's meetings from a start day, drops the ones the
 * dashboard already holds, and posts the rest, oldest first within a page, to the
 * dashboard's own POST /api/fathom-webhook. That handler is idempotent on the
 * recording id and applies the 45 minute fold, so a second post of the same call
 * changes nothing; the known-call check only keeps the log's counts meaningful and
 * the run cheap.
 *
 * WHAT IT NEVER DOES. It writes no database row (the dashboard does), logs no title,
 * summary, transcript, name or address (counts only), and forwards nothing outside the
 * allowlist in `buildWebhookBody`.
 *
 * A FAILURE IS A NAMED CAUSE, never a quiet zero. Fatal ones stop the run at once;
 * a post that fails after retries is counted and the run goes on, then ends as
 * `posts_failed` so the heartbeat is red and the next run (which reads the same
 * window) tries it again.
 */
import {
  CAUSE_SENTENCE, FATHOM_API_BASE, FATHOM_KEY_HEADER, FATHOM_MIN_GAP_MS, MAX_PAGES, ShapeChanged,
  buildWebhookBody, causeForFathomStatus, listUrl, parseListPage, type FailCause, type ListedMeeting,
} from "./api.js";

export interface PullResponse { ok: boolean; status: number; text: () => Promise<string>; headers: { get(name: string): string | null } }
export type PullFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<PullResponse>;

export interface PullDeps {
  fetchFn: PullFetch;
  sleep: (ms: number) => Promise<void>;
  /** Which of these recording ids does the dashboard already hold? Throws when it cannot be asked. */
  known?: (ids: string[]) => Promise<Set<string>>;
  /** Pause between list calls and between posts. Defaults are the real pacing; the guard shortens them. */
  listGapMs?: number;
  postGapMs?: number;
}

export interface PullOpts {
  fathomKey: string | null;
  webhookKey: string | null;
  fathomBase?: string;
  appBase: string;
  /** YYYY-MM-DD. */
  since: string;
  dryRun: boolean;
  maxPages?: number;
  /** A one-client run: only calls this accepts are posted; the rest are counted and left. */
  matches?: (m: ListedMeeting) => boolean;
}

export interface PullResult {
  pages: number;
  /** Meetings Fathom listed in the window. */
  found: number;
  /** Already in the dashboard, left alone. */
  alreadyThere: number;
  /** Listed, but outside a one-client run's scope, so not posted. */
  outOfScope: number;
  /** Posted (or, on a dry run, the number that would be). */
  posted: number;
  failed: number;
  /** Listed items that carried no usable recording id. They count as failed too. */
  unreadable: number;
  /** How many different people recorded the calls found. A number only. */
  recorders: number;
  /** "used" when the dashboard's own records were asked, "unavailable" when they could not be. */
  knownCheck: "used" | "unavailable" | "off";
  dryRun: boolean;
  cause: FailCause | null;
}

const isRealYmd = (s: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(y, mo - 1, da));
  return d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1 && d.getUTCDate() === da;
};

const empty = (dryRun: boolean): PullResult => ({
  pages: 0, found: 0, alreadyThere: 0, outOfScope: 0, posted: 0, failed: 0, unreadable: 0, recorders: 0, knownCheck: "off", dryRun, cause: null,
});

class Stop extends Error {
  constructor(public cause: FailCause) { super(cause); }
}

const RETRIES = 5;

/** Seconds from a Retry-After header, bounded; null when absent or unreadable. */
function retryAfterMs(res: PullResponse): number | null {
  const v = res.headers.get("retry-after");
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(60, n) * 1000 : null;
}

export async function runPull(deps: PullDeps, opts: PullOpts): Promise<PullResult> {
  const out = empty(opts.dryRun);
  const fail = (cause: FailCause): PullResult => { out.cause = cause; return out; };
  if (!opts.fathomKey) return fail("no_fathom_key");
  if (!opts.webhookKey && !opts.dryRun) return fail("no_webhook_key");
  if (!isRealYmd(opts.since)) return fail("bad_since");
  if (!/^https?:\/\//i.test(opts.appBase)) return fail("bad_app_address");

  const fathomBase = opts.fathomBase ?? FATHOM_API_BASE;
  const appBase = opts.appBase.replace(/\/+$/, "");
  const listGap = deps.listGapMs ?? FATHOM_MIN_GAP_MS;
  const postGap = deps.postGapMs ?? 300;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const seen = new Set<string>();
  const recorders = new Set<string>();
  let knownCheck: PullResult["knownCheck"] = deps.known ? "used" : "off";

  /** One GET of the list, retried on 429, 5xx and network errors; any other refusal stops. */
  async function fetchPage(cursor: string | null): Promise<unknown> {
    const url = listUrl({ base: fathomBase, createdAfter: `${opts.since}T00:00:00Z`, cursor });
    let last: FailCause = "fathom_unreachable";
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      let res: PullResponse;
      try {
        res = await deps.fetchFn(url, { method: "GET", headers: { [FATHOM_KEY_HEADER]: opts.fathomKey!, Accept: "application/json" } });
      } catch {
        last = "fathom_unreachable";
        await deps.sleep(Math.min(32_000, 2 ** attempt * 1000));
        continue;
      }
      if (res.ok) {
        const text = await res.text();
        try { return JSON.parse(text); } catch { throw new Stop("shape_changed"); }
      }
      const cause = causeForFathomStatus(res.status);
      if (cause !== "fathom_429" && cause !== "fathom_5xx") throw new Stop(cause);
      last = cause;
      await deps.sleep(retryAfterMs(res) ?? Math.min(32_000, 2 ** attempt * 1000));
    }
    throw new Stop(last);
  }

  /** One POST to the dashboard. true = posted. Fatal refusals stop the run. */
  async function post(m: ListedMeeting): Promise<boolean> {
    const body = JSON.stringify(buildWebhookBody(m));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let res: PullResponse;
      try {
        res = await deps.fetchFn(`${appBase}/api/fathom-webhook`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-fathom-key": opts.webhookKey! }, body,
        });
      } catch {
        if (attempt === 2) return false;
        await deps.sleep(2 ** attempt * 1000);
        continue;
      }
      if (res.ok) return true;
      await res.text().catch(() => "");
      if (res.status === 401) throw new Stop("app_401");
      if (res.status === 503) throw new Stop("app_503");
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 2) return false;
        await deps.sleep(retryAfterMs(res) ?? 2 ** attempt * 1000);
        continue;
      }
      return false;
    }
    return false;
  }

  try {
    let cursor: string | null = null;
    let consecutiveUnreachable = 0;
    for (;;) {
      if (out.pages >= maxPages) throw new Stop("too_many_pages");
      if (out.pages > 0) await deps.sleep(listGap);
      let page;
      try { page = parseListPage(await fetchPage(cursor)); } catch (e) {
        if (e instanceof ShapeChanged) throw new Stop("shape_changed");
        throw e;
      }
      out.pages += 1;
      out.unreadable += page.unreadable;
      out.failed += page.unreadable;

      const fresh: ListedMeeting[] = [];
      for (const m of page.items) {
        if (seen.has(m.recordingId)) continue;
        seen.add(m.recordingId);
        out.found += 1;
        if (m.recordedByEmail) recorders.add(m.recordedByEmail);
        fresh.push(m);
      }

      let held = new Set<string>();
      if (deps.known && knownCheck === "used" && fresh.length) {
        try { held = await deps.known(fresh.map((m) => m.recordingId)); } catch { knownCheck = "unavailable"; }
      }
      const scoped = opts.matches ? fresh.filter((m) => opts.matches!(m)) : fresh;
      out.outOfScope += fresh.length - scoped.length;
      const todo = scoped.filter((m) => !held.has(m.recordingId));
      out.alreadyThere += scoped.length - todo.length;
      // Oldest first, so the dashboard's fold keeps the earlier recording as the call.
      todo.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));

      for (const m of todo) {
        if (opts.dryRun) { out.posted += 1; continue; }
        if (out.posted + out.failed > 0) await deps.sleep(postGap);
        if (await post(m)) { out.posted += 1; consecutiveUnreachable = 0; } else {
          out.failed += 1;
          consecutiveUnreachable += 1;
          if (consecutiveUnreachable >= 5) throw new Stop("app_unreachable");
        }
      }
      if (!page.nextCursor || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
  } catch (e) {
    out.recorders = recorders.size;
    out.knownCheck = knownCheck;
    if (e instanceof Stop) return fail(e.cause);
    throw e;
  }
  out.recorders = recorders.size;
  out.knownCheck = knownCheck;
  if (out.failed > 0) out.cause = "posts_failed";
  return out;
}

/** The counts-only line the log and the heartbeat carry. Nothing about any call. */
export function summaryLine(r: PullResult): string {
  const verb = r.dryRun ? "would post" : "posted";
  const check = r.knownCheck === "used" ? "" : r.knownCheck === "unavailable" ? " The dashboard's own records could not be asked, so known calls were re-sent and the dashboard ignored them." : " The dashboard's own records were not asked.";
  const scope = r.outOfScope ? `, outside this one client ${r.outOfScope}` : "";
  return `found ${r.found}, already there ${r.alreadyThere}${scope}, ${verb} ${r.posted}, failed ${r.failed}, recorders ${r.recorders}, pages ${r.pages}.${check}`;
}

export { CAUSE_SENTENCE };

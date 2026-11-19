/**
 * The one door to Meta's Graph API for the depth reads (ads_meta_days).
 *
 * READ-ONLY, BY CONSTRUCTION. There is exactly one `fetch` in this file, it is a
 * GET, it carries no body and no method, and nothing else in the depth code calls
 * `fetch` at all. A write to Meta would need a POST to a mutation edge; there is no
 * code path here that can make one, and `verify-meta-depth` fails if any of the
 * depth files names a method, a body or a write edge.
 *
 * THE TEST SEAM. `META_FAKE_BASE` replaces the Graph address with a pretend server
 * on the same machine. It is read in one place (`graphBase`) and no workflow may set
 * it (the guard reads every workflow). It exists so the guard can drive the whole
 * job, paging, rate limits and failures included, with no token and no network.
 *
 * A FAILURE NAMES ITSELF AND NEVER PRINTS THE TOKEN. The token travels in the query
 * string (Graph's own convention), so any error text that could carry a URL is
 * scrubbed before it leaves this file.
 */
import { META_GRAPH } from "./insights.js";

export function graphBase(): string {
  const fake = process.env.META_FAKE_BASE?.trim();
  return fake ? fake.replace(/\/+$/, "") : META_GRAPH;
}

/** Rate-limit and transient codes Meta documents for the Marketing API. UNVERIFIED live: the list is from the published error reference. */
const RETRY_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80000, 80003, 80004, 80006]);

export class GraphError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null) { super(message); this.name = "GraphError"; }
}

export const scrubToken = (s: string): string => s.replace(/access_token=[^&\s"']+/gi, "access_token=[token]").replace(/EAA[A-Za-z0-9]{20,}/g, "[token]");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const retryMs = (): number => {
  const v = Number(process.env.META_RETRY_MS);
  return Number.isFinite(v) && v >= 0 ? v : 2_000;
};

/** One GET, retried a few times on a rate limit or a 5xx. The URL may be a `paging.next` the server handed back. */
export async function graphGetUrl(url: string, attempts = 3): Promise<any> {
  let last: GraphError | null = null;
  for (let i = 0; i < attempts; i++) {
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (e) {
      last = new GraphError(`Meta could not be reached: ${scrubToken(e instanceof Error ? e.message : String(e))}`.slice(0, 300), 0, null);
      if (i < attempts - 1) { await sleep(retryMs() * (i + 1)); continue; }
      throw last;
    }
    const body = (await resp.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number }; [k: string]: unknown };
    if (resp.ok) return body;
    const code = typeof body?.error?.code === "number" ? body.error.code : null;
    const msg = scrubToken(`Meta API ${resp.status}${code != null ? ` (code ${code})` : ""}: ${body?.error?.message ?? "no message"}`).slice(0, 300);
    last = new GraphError(msg, resp.status, code);
    const transient = resp.status === 429 || resp.status >= 500 || (code != null && RETRY_CODES.has(code));
    if (transient && i < attempts - 1) { await sleep(retryMs() * (i + 1)); continue; }
    throw last;
  }
  throw last ?? new GraphError("Meta read failed", 0, null);
}

export function graphUrl(token: string, path: string, params: Record<string, string>): string {
  const qs = new URLSearchParams({ ...params, access_token: token });
  return `${graphBase()}/${path}?${qs}`;
}

export interface GraphList {
  rows: Record<string, unknown>[];
  /** True only when every page was read and the row ceiling was not reached. A partial list is a wrong list. */
  complete: boolean;
  /** Why it is not complete, in one clause, or null. */
  why: string | null;
  pages: number;
}

/**
 * A listing, paged to the end or to a ceiling. THE CEILING IS A REFUSAL: when the
 * list is cut by it, `complete` is false and the caller writes nothing for the part,
 * because a missing row in a cut list reads as a day nothing was spent.
 */
export async function graphList(
  token: string, path: string, params: Record<string, string>,
  opts: { rowCeiling: number; pageCeiling?: number },
): Promise<GraphList> {
  const pageCeiling = opts.pageCeiling ?? 400;
  let url: string | null = graphUrl(token, path, { limit: "500", ...params });
  const rows: Record<string, unknown>[] = [];
  let pages = 0;
  while (url) {
    if (pages >= pageCeiling) return { rows, complete: false, why: `the read stopped at ${pageCeiling} pages with more behind it`, pages };
    const body = await graphGetUrl(url);
    pages++;
    if (Array.isArray(body.data)) rows.push(...(body.data as Record<string, unknown>[]));
    const next = (body.paging as { next?: unknown } | undefined)?.next;
    url = typeof next === "string" && next ? next : null;
    if (rows.length >= opts.rowCeiling) {
      return { rows, complete: !url ? rows.length < opts.rowCeiling : false, why: `the read reached the ${opts.rowCeiling}-row ceiling`, pages };
    }
  }
  return { rows, complete: true, why: null, pages };
}

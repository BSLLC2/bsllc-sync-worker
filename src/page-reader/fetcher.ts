/**
 * The one door from the page reader to a client's website.
 *
 * Everything the reader will not do is decided here, in one place, so a page that
 * misbehaves can only ever cost one row in the table:
 *
 *  · It identifies itself, plainly, in the User-Agent. It does not pretend to be a
 *    browser or a search engine.
 *  · It asks for HTML, follows at most three redirects, and only SAME-SITE ones.
 *    A redirect to another site is an answer ("off_site_redirect") and not a thing
 *    to follow.
 *  · It gives up after `timeoutMs`, and it stops reading at `maxBytes`, so a page
 *    that never ends, or that is a gigabyte, costs a timeout and not the run.
 *  · It will not talk to a private, loopback or link-local address. A client's
 *    domain is typed by a person, and a domain that resolves into our own network
 *    is not a website we should be fetching from a build runner. `allowPrivate` is
 *    a parameter and not an environment variable on purpose: only the verify
 *    script, which runs a pretend site on 127.0.0.1, can ask for it.
 *  · It waits `delayMs` between two requests to one host (and longer if robots.txt
 *    asks for longer, up to ten seconds).
 *  · It never runs the page's JavaScript and never sends a cookie.
 *
 * What comes back is a state and, for a normal page, the HTML text. It never
 * returns a response body for any other state.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isSameSite } from "./targets.js";
import type { PageState } from "./types.js";

export const USER_AGENT = "BSLLC-PageReader/1.0 (+https://work.bsllc.biz; reads the client's own public pages for SEO recommendations)";
export const MAX_REDIRECTS = 3;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 1_500_000;
export const DEFAULT_DELAY_MS = 1_000;

export interface FetchOptions {
  site: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivate?: boolean;
  fetchImpl?: typeof fetch;
  /** Called before every request to a host, so the caller can wait. */
  beforeRequest?: (host: string) => Promise<void>;
  /** "html" (the default) refuses anything that is not a web page. "text" is for
   *  robots.txt and a sitemap, which are plain text or XML. */
  expect?: "html" | "text";
}

export interface FetchOutcome {
  state: PageState;
  statusCode: number | null;
  finalUrl: string | null;
  html: string | null;
  /** True where the X-Robots-Tag header said noindex. */
  headerNoindex: boolean;
  error: string | null;
}

export function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  if (isIP(a) === 4) {
    const [p, q] = a.split(".").map(Number) as [number, number];
    return p === 10 || p === 127 || p === 0 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224;
  }
  if (isIP(a) === 6) {
    if (a === "::1" || a === "::") return true;
    if (a.startsWith("fe80:") || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("ff")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  return false;
}

const resolved = new Map<string, boolean>();

/** True where it is safe to connect to `host`. A name is resolved and every
 *  address it resolves to must be public. A failure to resolve is "not safe". */
export async function hostIsPublic(host: string, allowPrivate = false): Promise<boolean> {
  if (allowPrivate) return true;
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return false;
  if (isIP(h)) return !isPrivateAddress(h);
  const cached = resolved.get(h);
  if (cached != null) return cached;
  let ok = false;
  try {
    const addrs = await lookup(h, { all: true });
    ok = addrs.length > 0 && addrs.every((x) => !isPrivateAddress(x.address));
  } catch { ok = false; }
  resolved.set(h, ok);
  return ok;
}

const short = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Read a response body up to `maxBytes`. Returns null where it was larger. */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) { try { await res.body?.cancel(); } catch { /* already closed */ } return null; }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* already closed */ } return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/** One address, redirects and all. Never throws. */
export async function fetchPage(url: string, opts: FetchOptions): Promise<FetchOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let current = url;
  const fail = (state: PageState, statusCode: number | null, error: string, finalUrl: string | null = null): FetchOutcome =>
    ({ state, statusCode, finalUrl, html: null, headerNoindex: false, error: short(error) });

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try { u = new URL(current); } catch { return fail("fetch_failed", null, "not a web address"); }
    if (u.protocol !== "http:" && u.protocol !== "https:") return fail("fetch_failed", null, "not a web address");
    if (!isSameSite(u.hostname, opts.site)) {
      return fail("off_site_redirect", null, "the address is not on the client's site");
    }
    if (!(await hostIsPublic(u.hostname, opts.allowPrivate))) return fail("fetch_failed", null, "the address is not a public web server");
    if (opts.beforeRequest) await opts.beforeRequest(u.hostname);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(u.toString(), {
        method: "GET",
        redirect: "manual",
        signal: ctl.signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", "accept-language": "en" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        try { await res.body?.cancel(); } catch { /* nothing to cancel */ }
        if (!loc) return fail("error_status", res.status, `status ${res.status} with nowhere to go`, current);
        let next: URL;
        try { next = new URL(loc, u); } catch { return fail("error_status", res.status, "a redirect to an address that is not valid", current); }
        if (!isSameSite(next.hostname, opts.site)) {
          return fail("off_site_redirect", res.status, `redirected to another site (${next.hostname})`, current);
        }
        current = next.toString();
        continue;
      }
      if (res.status === 404 || res.status === 410) { try { await res.body?.cancel(); } catch { /* */ } return fail("not_found", res.status, `status ${res.status}`, current); }
      if (res.status < 200 || res.status >= 300) { try { await res.body?.cancel(); } catch { /* */ } return fail("error_status", res.status, `status ${res.status}`, current); }
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (opts.expect !== "text" && type && !/(text\/html|application\/xhtml\+xml)/.test(type)) {
        try { await res.body?.cancel(); } catch { /* */ }
        return fail("not_html", res.status, `a ${short(type.split(";")[0] ?? "", 40)} file, not a web page`, current);
      }
      const headerNoindex = /(^|[\s,])(noindex|none)([\s,]|$)/i.test(res.headers.get("x-robots-tag") ?? "");
      const html = await readCapped(res, maxBytes);
      if (html == null) return fail("too_large", res.status, `more than ${Math.round(maxBytes / 1000)} KB`, current);
      return { state: "read", statusCode: res.status, finalUrl: current, html, headerNoindex, error: null };
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError" || ctl.signal.aborted;
      return aborted
        ? fail("timeout", null, `no answer in ${Math.round(timeoutMs / 1000)} seconds`, current)
        : fail("fetch_failed", null, e instanceof Error ? e.message : "the connection failed", current);
    } finally {
      clearTimeout(timer);
    }
  }
  return fail("error_status", null, "too many redirects", current);
}

/** A politeness gate: at most one request to a host every `delayMs`. */
export function makeThrottle(delayMsFor: (host: string) => number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const last = new Map<string, number>();
  return async (host: string): Promise<void> => {
    const gap = delayMsFor(host);
    const wait = (last.get(host) ?? 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    last.set(host, Date.now());
  };
}

/**
 * Public site check: one chain of GETs to the client's own home page, a robots.txt
 * read first, and one TLS handshake. Public only: no credential, no cookie, no
 * script run, no second page.
 *
 *  · robots.txt: if it forbids "/" to us, nothing else is read and the state says so.
 *    A robots.txt that cannot be read is NOT read as permission to skip the check; the
 *    home page of a site we look after is still a public address, so it is read.
 *  · The chain follows redirects by hand (up to 5), re-checking every hop is a public
 *    address, and stops at the first hop that leaves the site (recorded, not followed).
 *  · Time is from the first request to the final answer's headers.
 *  · Missing security headers are a list of NAMES from a fixed set; no value is kept.
 *  · The certificate is read from a handshake to the final host (injectable); only the
 *    expiry date and whether the platform trusts it are kept.
 *
 * Everything is injectable so the guard drives the real code against a pretend server.
 */
import { connect as tlsConnect } from "node:tls";
import { hostIsPublic } from "../page-reader/fetcher.js";
import { parseRobots } from "../page-reader/robots.js";
import { bareSiteHost } from "../page-reader/targets.js";
import { safeMessage } from "../page-behaviour/http.js";
import { SECURITY_HEADERS, SITE_BODY_BYTES, SITE_MAX_REDIRECTS, SITE_TIMEOUT_MS, SITE_USER_AGENT, type CanonicalState, type ReadingOut, type SiteFacts } from "./types.js";

export interface CertProbe { validTo: string | null; trusted: boolean | null }
export type CertProbeFn = (host: string, port: number) => Promise<CertProbe>;

export interface SiteDeps {
  fetchImpl?: typeof fetch;
  certProbe?: CertProbeFn;
  /** Guard only. The CLI never sets it. */
  allowPrivate?: boolean;
  now?: () => number;
}

/** "example.com", "https://www.example.com/x" → "https://example.com/" is NOT done: the www form is kept as typed. */
export function siteStartUrl(input: string): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
  return `${u.protocol}//${u.host}/`;
}

/** Real probe: a TLS handshake that accepts any certificate so the date can be read, and reports whether it was trusted. */
export const realCertProbe: CertProbeFn = (host, port) =>
  new Promise((resolve) => {
    const sock = tlsConnect({ host, port, servername: host, rejectUnauthorized: false, timeout: 10_000 }, () => {
      const cert = sock.getPeerCertificate();
      const validTo = cert && cert.valid_to ? new Date(cert.valid_to) : null;
      const out: CertProbe = {
        validTo: validTo && !Number.isNaN(validTo.getTime()) ? validTo.toISOString().slice(0, 10) : null,
        trusted: typeof sock.authorized === "boolean" ? sock.authorized : null,
      };
      sock.end();
      resolve(out);
    });
    sock.on("error", () => resolve({ validTo: null, trusted: null }));
    sock.on("timeout", () => { sock.destroy(); resolve({ validTo: null, trusted: null }); });
  });

/** First `maxBytes` of a body, never more. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
    if (total >= maxBytes) { try { await reader.cancel(); } catch { /* closed */ } break; }
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.byteLength; }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, maxBytes));
}

/** `<link rel="canonical" href>` against the final address. Never reads a page's words. */
export function canonicalStateOf(html: string, finalUrl: string): CanonicalState {
  const tag = /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/i.exec(html);
  if (!tag) return "none";
  const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag[0]);
  if (!href) return "none";
  let c: URL, f: URL;
  try { f = new URL(finalUrl); c = new URL(href[1]!, f); } catch { return "none"; }
  if (bareSiteHost(c.host) !== bareSiteHost(f.host)) return "other_host";
  const norm = (u: URL) => u.pathname.replace(/\/+$/, "") || "/";
  return norm(c) === norm(f) ? "same" : "other_path";
}

export function missingSecurityHeaders(h: Headers): string[] {
  const has = (n: string) => (h.get(n) ?? "").trim() !== "";
  const missing: string[] = [];
  for (const name of SECURITY_HEADERS) {
    if (name === "x-frame-options-or-frame-ancestors") {
      if (!has("x-frame-options") && !/frame-ancestors/i.test(h.get("content-security-policy") ?? "")) missing.push(name);
    } else if (!has(name)) missing.push(name);
  }
  return missing;
}

const failed = (subject: string, state: "could_not_check" | "blocked_by_robots", detail: string): ReadingOut =>
  ({ kind: "site", subject, state, detail, site: null, domain: null, wp: null });

export async function checkSite(siteInput: string, deps: SiteDeps = {}): Promise<ReadingOut> {
  const doFetch = deps.fetchImpl ?? fetch;
  const probe = deps.certProbe ?? realCertProbe;
  const clock = deps.now ?? Date.now;
  const start = siteStartUrl(siteInput);
  const subject = bareSiteHost(siteInput) || String(siteInput).slice(0, 80);
  if (!start) return failed(subject, "could_not_check", "The site address on the record is not a web address.");
  const first = new URL(start);
  if (!(await hostIsPublic(first.hostname, deps.allowPrivate))) return failed(subject, "could_not_check", "The address is not a public web server, so it was not checked.");

  const get = async (url: string, accept: string): Promise<Response> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SITE_TIMEOUT_MS);
    try {
      return await doFetch(url, { method: "GET", redirect: "manual", signal: ctl.signal, headers: { "user-agent": SITE_USER_AGENT, accept } });
    } finally { clearTimeout(timer); }
  };

  // robots.txt first. Unreadable is not a reason to skip; forbidden is.
  try {
    const r = await get(`${first.protocol}//${first.host}/robots.txt`, "text/plain");
    if (r.status === 200) {
      const rules = parseRobots(await readCapped(r, 100_000));
      if (!rules.allows("/")) return failed(subject, "blocked_by_robots", "The site's robots.txt does not allow this check to read the home page, so nothing was read.");
    } else { try { await r.body?.cancel(); } catch { /* closed */ } }
  } catch { /* an unreadable robots.txt does not stop the check */ }

  let current = start;
  let hops = 0;
  const t0 = clock();
  for (;;) {
    let u: URL;
    try { u = new URL(current); } catch { return failed(subject, "could_not_check", "A redirect led to an address that is not valid."); }
    if (!(await hostIsPublic(u.hostname, deps.allowPrivate))) return failed(subject, "could_not_check", "A redirect led to an address that is not a public web server.");
    let res: Response;
    try { res = await get(u.toString(), "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1"); }
    catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError";
      return failed(subject, "could_not_check", aborted ? `No answer in ${SITE_TIMEOUT_MS / 1000} seconds.` : safeMessage(e));
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      try { await res.body?.cancel(); } catch { /* closed */ }
      if (!loc) return failed(subject, "could_not_check", `The site answered ${res.status} with nowhere to go.`);
      let next: URL;
      try { next = new URL(loc, u); } catch { return failed(subject, "could_not_check", "A redirect led to an address that is not valid."); }
      hops += 1;
      if (next.protocol !== "http:" && next.protocol !== "https:") return failed(subject, "could_not_check", "A redirect led to an address that is not a web address.");
      if (hops > SITE_MAX_REDIRECTS) return failed(subject, "could_not_check", `More than ${SITE_MAX_REDIRECTS} redirects in a row.`);
      if (bareSiteHost(next.host) !== bareSiteHost(first.host)) { return finish(res, u, hops, true, true); } // leaves the site: recorded, never followed
      current = next.toString();
      continue;
    }
    return finish(res, u, hops, false, false);
  }

  async function finish(res: Response, u: URL, nHops: number, offSite: boolean, offSiteHop: boolean): Promise<ReadingOut> {
    const responseMs = Math.max(0, Math.round(clock() - t0));
    let html = "";
    if (!offSiteHop && res.status >= 200 && res.status < 300 && /html/i.test(res.headers.get("content-type") ?? "html")) {
      try { html = await readCapped(res, SITE_BODY_BYTES); } catch { html = ""; }
    } else { try { await res.body?.cancel(); } catch { /* closed */ } }
    const https = u.protocol === "https:";
    let cert: CertProbe = { validTo: null, trusted: null };
    if (https) { try { cert = await probe(u.hostname, u.port ? Number(u.port) : 443); } catch { cert = { validTo: null, trusted: null }; } }
    const site: SiteFacts = {
      httpStatus: res.status,
      responseMs,
      redirectHops: nHops,
      endedHttps: https,
      endsOffSite: offSite,
      canonicalState: html ? canonicalStateOf(html, u.toString()) : null,
      certExpiresOn: cert.validTo,
      certTrusted: cert.trusted,
      headersMissing: offSiteHop ? null : missingSecurityHeaders(res.headers),
    };
    return { kind: "site", subject, state: "read", detail: null, site, domain: null, wp: null };
  }
}

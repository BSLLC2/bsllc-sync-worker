/**
 * Domain expiry through RDAP: public, no key. `rdap.org` is the public bootstrap
 * redirector (it sends the request to the registry that holds the domain). One GET.
 *
 *  · The domain is the site's host without `www.`. If the registry has no record for
 *    it (a subdomain), one label is dropped and it is tried once more, never more
 *    than twice, and never down to a bare top-level name.
 *  · The expiry is the event whose action is "expiration". An answer with no such
 *    event is `read` with a null date, because some registries do not publish one:
 *    that is "not published", never a date and never "fine".
 *  · A country registry with no RDAP service answers 404: could_not_check, said so.
 *  · Only the date is kept. The registrant and registrar names are not read.
 */
import { safeMessage } from "../page-behaviour/http.js";
import { bareSiteHost } from "../page-reader/targets.js";
import { SITE_USER_AGENT, type ReadingOut } from "./types.js";

export const RDAP_BASE = "https://rdap.org";
export const RDAP_TIMEOUT_MS = 15_000;

export interface RdapDeps { fetchImpl?: typeof fetch; base?: string }

const out = (subject: string, state: "read" | "could_not_check", detail: string | null, expires: string | null): ReadingOut =>
  ({ kind: "domain", subject, state, detail, site: null, domain: state === "read" ? { domainExpiresOn: expires } : null, wp: null });

/** The expiry day from an RDAP answer, or null where none is published. Pure. */
export function expiryFromRdap(j: unknown): string | null {
  const events = (j && typeof j === "object" ? (j as { events?: unknown }).events : null);
  if (!Array.isArray(events)) return null;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const a = String((e as { eventAction?: unknown }).eventAction ?? "").toLowerCase();
    if (a !== "expiration") continue;
    const d = new Date(String((e as { eventDate?: unknown }).eventDate ?? ""));
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

export async function checkDomain(domainInput: string, deps: RdapDeps = {}): Promise<ReadingOut> {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = (deps.base ?? RDAP_BASE).replace(/\/+$/, "");
  const first = bareSiteHost(domainInput);
  if (!first || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(first)) return out(String(domainInput).slice(0, 80), "could_not_check", "The domain on the record is not a domain name.", null);
  const tried: string[] = [];
  let name = first;
  for (let attempt = 0; attempt < 2; attempt++) {
    tried.push(name);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), RDAP_TIMEOUT_MS);
    try {
      const res = await doFetch(`${base}/domain/${encodeURIComponent(name)}`, { headers: { accept: "application/rdap+json, application/json", "user-agent": SITE_USER_AGENT }, signal: ctl.signal });
      if (res.status === 404) {
        try { await res.body?.cancel(); } catch { /* closed */ }
        const parts = name.split(".");
        if (parts.length > 2 && attempt === 0) { name = parts.slice(1).join("."); continue; }
        return out(first, "could_not_check", "The registry has no RDAP record for this domain (some country registries do not offer RDAP).", null);
      }
      if (!res.ok) { try { await res.body?.cancel(); } catch { /* closed */ } return out(first, "could_not_check", `The registry service answered ${res.status}.`, null); }
      const text = await res.text();
      let j: unknown;
      try { j = JSON.parse(text); } catch { return out(first, "could_not_check", "The registry service did not answer in the expected form.", null); }
      const exp = expiryFromRdap(j);
      return out(name, "read", exp ? null : "The registry does not publish an expiry date for this domain.", exp);
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError";
      return out(first, "could_not_check", aborted ? `No answer in ${RDAP_TIMEOUT_MS / 1000} seconds.` : safeMessage(e), null);
    } finally { clearTimeout(timer); }
  }
  return out(first, "could_not_check", `No RDAP record for ${tried.join(" or ")}.`, null);
}

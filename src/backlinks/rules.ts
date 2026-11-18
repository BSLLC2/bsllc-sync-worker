/**
 * The link audit's lists and cleaners, THE WORKER'S COPY. Everything from "The declared lists." to "End of the copied rules." is
 * copied byte for byte from the dashboard's `shared/link-audit-rules.ts`, and the dashboard's `npm run verify:wiring` fails on drift.
 * Change it in both repos in one pass. The worker asks the provider for these wordings and tags these endings; the dashboard reads the
 * stored rows with the same lists.
 */

/** The declared lists. */
/** Endings (the last label of a site's name) that cost almost nothing to register and that the sites in a link wave tend to use. OURS. */
export const CHEAP_TLDS: readonly string[] = [
  "shop", "store", "site", "online", "space", "website", "xyz", "top", "click", "icu", "buzz", "cyou", "cfd", "sbs", "rest", "fun",
  "monster", "quest", "uno", "lol", "work", "live", "life", "world", "today", "tk", "ml", "ga", "cf", "gq",
];

/**
 * Wordings of a sold-link or link-wave anchor. Matched as plain lower-case substrings after whitespace is collapsed, so the worker can
 * ask the provider for them with a LIKE and this app can test a stored anchor with the same words. OURS.
 */
export const SPAM_ANCHOR_TEMPLATES: readonly string[] = [
  "tg @", "telegram", "seo links", "links dealer", "fast results", "niche edit", "i achieved a top", "buy backlinks",
  "guest post service", "link building service", "casino", "viagra", "payday loan",
];

/** The last label of a site's name, lower case. */
export function tldOf(domain: string): string {
  const parts = String(domain ?? "").trim().toLowerCase().replace(/\.$/, "").split(".");
  return parts.length > 1 ? parts[parts.length - 1]! : "";
}

export const isCheapTld = (domain: string): boolean => CHEAP_TLDS.includes(tldOf(domain));

const collapse = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** True when the anchor carries one of the declared wordings. */
export function isSpamAnchor(anchor: unknown): boolean {
  if (typeof anchor !== "string") return false;
  const t = collapse(anchor);
  return t !== "" && SPAM_ANCHOR_TEMPLATES.some((w) => t.includes(w));
}

export const ANCHOR_MAX_CHARS = 120;
const CONTACT_DETAIL = "[contact detail]";

/**
 * An anchor as it may be stored: control characters gone, runs of spaces made one, an email address or a phone number replaced by a
 * fixed placeholder, then cut to ANCHOR_MAX_CHARS. Null where nothing is left. A third party's words are kept only this far.
 */
export function cleanAnchor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let t = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, CONTACT_DETAIL);
  t = t.replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, CONTACT_DETAIL);
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > ANCHOR_MAX_CHARS ? `${t.slice(0, ANCHOR_MAX_CHARS - 1).trimEnd()}…` : t;
}

/** A path on the client's own site from a page address: no scheme, no host, no query, no fragment, one leading slash. Null where it is not one. */
export function pathOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let u = url.trim();
  if (!u) return null;
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  u = u.split(/[?#]/)[0] ?? "";
  if (!u.startsWith("/")) u = `/${u}`;
  u = u.replace(/\/{2,}/g, "/");
  if (u.length > 1) u = u.replace(/\/$/, "");
  return u.length > 200 ? null : u.toLowerCase();
}
/** End of the copied rules. */

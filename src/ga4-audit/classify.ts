/**
 * Where a page or a source belongs. Pure. Declared tables and exact rules, never a
 * guess from a keyword in free text.
 *
 * Page groups: the directory (/plan-your-trip/advisor/ itself) and an advisor's own
 * microsite (/plan-your-trip/advisor/<name>/...) share a prefix, which the dashboard's
 * page-group setting cannot express (a prefix cannot repeat). So the audit classifies a
 * path in code, with the directory and the homepage kept OUT of every advisor figure.
 */

export interface PageGroupDef { name: string; prefix: string }

export interface AuditConfig {
  /** Where advisor microsites live. The directory is this path with nothing after it. */
  advisorPrefix: string;
  homePath: string;
  /** Other named sections: destinations, contact. Longest prefix wins. */
  groups: PageGroupDef[];
  /** Words that make a search "branded" (Search Console). Lower case. */
  brandTerms: string[];
}

export const BROWNELL_DEFAULTS: AuditConfig = {
  advisorPrefix: "/plan-your-trip/advisor/",
  homePath: "/",
  groups: [
    { name: "Destinations", prefix: "/hotel-destinations/" },
    { name: "Contact", prefix: "/contact" },
  ],
  brandTerms: ["brownell"],
};

export type GroupKind = "advisor_microsite" | "directory" | "homepage" | "other_group" | "other";
export interface PageClass { kind: GroupKind; group: string; advisor: string | null }

const stripQuery = (p: string): string => p.split(/[?#]/)[0] ?? p;

/** "/plan-your-trip/advisor/jane-doe/about" -> "jane-doe", the first segment after the prefix, or null. */
export function advisorSlug(path: string, cfg: AuditConfig): string | null {
  const p = stripQuery(path);
  if (!p.startsWith(cfg.advisorPrefix)) return null;
  const rest = p.slice(cfg.advisorPrefix.length).replace(/^\/+/, "");
  const seg = rest.split("/")[0] ?? "";
  return seg ? seg.toLowerCase() : null;
}

export const advisorName = (slug: string): string => slug.split("-").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");

export function classifyPath(path: string, cfg: AuditConfig): PageClass {
  const p = stripQuery(path) || "/";
  if (p === cfg.homePath || p === "") return { kind: "homepage", group: "Homepage", advisor: null };
  const slug = advisorSlug(p, cfg);
  if (slug) return { kind: "advisor_microsite", group: "Advisor microsites", advisor: slug };
  const dir = cfg.advisorPrefix.replace(/\/+$/, "");
  if (p === cfg.advisorPrefix || p === dir) return { kind: "directory", group: "Advisor directory", advisor: null };
  let best: PageGroupDef | null = null;
  for (const g of cfg.groups) if (p.startsWith(g.prefix) && (!best || g.prefix.length > best.prefix.length)) best = g;
  if (best) return { kind: "other_group", group: best.name, advisor: null };
  return { kind: "other", group: "Everything else", advisor: null };
}

/** A form event on a directory search carries destination= in its address. It is a search, not a request to an advisor. */
export const isDirectorySearch = (pathPlusQuery: string, cfg: AuditConfig): boolean => {
  const p = stripQuery(pathPlusQuery);
  const dir = cfg.advisorPrefix.replace(/\/+$/, "");
  return (p === cfg.advisorPrefix || p === dir || p === cfg.homePath) && /[?&]destination=/i.test(pathPlusQuery);
};

/** Whether a form submit event belongs in an "enquiry-like" figure: not the homepage search and not the directory. */
export function formCountsAsRequest(pathPlusQuery: string, cfg: AuditConfig): boolean {
  const c = classifyPath(pathPlusQuery, cfg);
  if (c.kind === "homepage" || c.kind === "directory") return false;
  return true;
}

/* ───────────── sources ───────────── */

export type SourceClass = "search" | "facebook" | "instagram" | "other_social" | "ai_assistant" | "email" | "referral" | "direct" | "other";

const AI_HOSTS = ["chatgpt.com", "chat.openai.com", "openai.com", "perplexity.ai", "claude.ai", "gemini.google.com", "copilot.microsoft.com", "bard.google.com", "you.com", "poe.com", "meta.ai"];
const SEARCH_ENGINES = ["google", "bing", "duckduckgo", "yahoo", "ecosia", "baidu", "yandex", "brave", "startpage", "qwant"];
const FACEBOOK = ["facebook", "l.facebook.com", "m.facebook.com", "lm.facebook.com", "fb"];
const INSTAGRAM = ["instagram", "l.instagram.com", "ig"];
const OTHER_SOCIAL = ["pinterest", "linkedin", "twitter", "t.co", "x.com", "youtube", "tiktok", "reddit", "threads"];

const hostMatch = (source: string, list: readonly string[]) => list.some((h) => source === h || source.endsWith(`.${h}`) || source.startsWith(`${h}.`));

/** From a "source / medium" string as Analytics prints it. Exact host or exact medium, never a fragment. */
export function classifySource(sourceMedium: string): SourceClass {
  const [rawSource = "", rawMedium = ""] = sourceMedium.split(" / ");
  const source = rawSource.trim().toLowerCase();
  const medium = rawMedium.trim().toLowerCase();
  if (source === "(direct)" || (medium === "(none)" && source === "(direct)")) return "direct";
  if (hostMatch(source, AI_HOSTS)) return "ai_assistant";
  if (medium === "email" || source === "email") return "email";
  if (hostMatch(source, INSTAGRAM)) return "instagram";
  if (hostMatch(source, FACEBOOK)) return "facebook";
  if (hostMatch(source, OTHER_SOCIAL) || medium === "social" || medium === "organic social") return "other_social";
  if (medium === "organic" || SEARCH_ENGINES.includes(source)) return medium === "referral" ? "referral" : "search";
  if (medium === "referral") return "referral";
  return "other";
}

export const SOURCE_LABEL: Record<SourceClass, string> = {
  search: "Search engines", facebook: "Facebook", instagram: "Instagram", other_social: "Other social", ai_assistant: "AI assistants",
  email: "Email", referral: "Referral sites", direct: "Direct", other: "Other",
};

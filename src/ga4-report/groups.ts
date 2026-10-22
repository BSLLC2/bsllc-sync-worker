/**
 * How a typed address picks the pages of a page group. Pure.
 *
 * A group used to be an address prefix and nothing else, so an address could not be
 * used twice: the advisor directory (/plan-your-trip/advisor/) and the advisors' own
 * microsites (/plan-your-trip/advisor/<name>/) share a prefix and could not both be
 * groups. Each group now carries a MATCH MODE, and an address may repeat when the modes
 * differ.
 *
 * THE REGION BELOW THE MARKER IS COPIED BYTE FOR BYTE from the dashboard app's
 * `shared/website-report-groups.ts`, because the repositories cannot import from each
 * other. `npm run verify:wiring` in the app reads both and fails on drift. The request
 * filters that realise each mode are in ga4.ts; `npm run verify-ga4-report` here proves
 * the filter and `pathInGroup` agree on the same list of addresses.
 */

/** MATCH MODES. How a typed address picks the pages of a group. */
export const GROUP_MATCH_MODES = ["starts", "exact", "child"] as const;
export type GroupMatch = (typeof GROUP_MATCH_MODES)[number];
export interface GroupDef { name: string; prefix: string; match: GroupMatch }

/** A stored group with no mode, or one this build does not know, is the original behaviour: starts with. */
export function cleanMatch(v: unknown): GroupMatch {
  return v === "exact" || v === "child" ? v : "starts";
}

/** An address without its query or fragment, with one trailing slash on a page that is not a file. */
export function normalizePath(path: string): string {
  let p = String(path ?? "").split(/[?#]/)[0]!.trim();
  if (!p) return "/";
  if (!p.startsWith("/")) p = `/${p}`;
  const last = p.split("/").filter(Boolean).pop() ?? "";
  if (!p.endsWith("/") && !last.includes(".")) p += "/";
  return p;
}

/**
 * The key a group's rows are filed under. A "starts with" group keeps its plain prefix, so every row the
 * reader ever wrote for one still belongs to it. The other two modes carry a mark in front, so the same
 * address can be a directory group and a microsite group without their rows meeting.
 */
export function groupKey(g: { prefix: string; match?: unknown }): string {
  const m = cleanMatch(g.match);
  return m === "exact" ? `=${g.prefix}` : m === "child" ? `>${g.prefix}` : g.prefix;
}

/** A stored key back to its mode and address. A key with no mark is a "starts with" group. */
export function parseGroupKey(key: string): { match: GroupMatch; prefix: string } {
  if (key.startsWith("=")) return { match: "exact", prefix: key.slice(1) };
  if (key.startsWith(">")) return { match: "child", prefix: key.slice(1) };
  return { match: "starts", prefix: key };
}

/** The directory a "one level deeper" group hangs off: its address with one trailing slash. */
export const childBase = (prefix: string): string => normalizePath(prefix);

/**
 * Whether a page belongs to the group, by the same test the request filter makes.
 *
 * STARTS WITH is the original rule and stays a plain begins-with on the address as given, without regard to case,
 * so "/contact" takes "/contact-us" and "/advisor/" does not take "/advisor". EXACTLY and ONE LEVEL DEEPER ignore a
 * query, a fragment and a trailing slash, because they are about which page it is.
 */
export function pathInGroup(path: string, g: { prefix: string; match?: unknown }): boolean {
  const m = cleanMatch(g.match);
  if (m === "starts") return String(path ?? "").toLowerCase().startsWith(g.prefix.toLowerCase());
  const p = normalizePath(path).toLowerCase();
  if (m === "exact") return p === normalizePath(g.prefix).toLowerCase();
  const base = normalizePath(g.prefix).toLowerCase();
  return p.startsWith(base) && p !== base;
}

/**
 * The key two addresses share when they are one page. In every mode a trailing -2 or -3 on the first
 * segment under the group's address is dropped, because those are copies of the page. In "one level
 * deeper" mode a page deeper than the advisor's own is filed under the advisor: /advisor/jane/about
 * counts with /advisor/jane/, not as a group of its own. An "exactly" group is one address and folds nothing.
 */
export function mergeKey(path: string, g: { prefix: string; match?: unknown }): string {
  const p = normalizePath(path);
  const m = cleanMatch(g.match);
  if (m === "exact") return p;
  const pre = normalizePath(g.prefix);
  if (!p.startsWith(pre) || p === pre) return p;
  const rest = p.slice(pre.length).split("/");
  const first = rest[0]!;
  const stripped = first.replace(/-\d{1,2}$/, "");
  const head = !stripped || stripped === first ? first : stripped;
  if (m === "child") return `${pre}${head}/`;
  if (head === first) return p;
  return pre + [head, ...rest.slice(1)].join("/");
}

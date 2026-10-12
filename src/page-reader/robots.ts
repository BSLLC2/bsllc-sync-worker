/**
 * robots.txt, read the way a polite visitor reads it.
 *
 * PURE. Text in, a rule out. The fetcher decides what an unreachable file means
 * (src/page-reader/run.ts); this decides what a reachable one says.
 *
 *  · The group for our own name wins; otherwise the group for `*`.
 *  · Of the rules that match a path, the LONGEST pattern wins, and where an Allow
 *    and a Disallow are as long as each other the Allow wins. `*` matches any run
 *    of characters and a trailing `$` anchors the end of the path.
 *  · An empty Disallow allows everything.
 *  · A rule with more than six wildcards is ignored, so a hostile file cannot make
 *    a pattern that backtracks. It is ignored as a Disallow too, which is the
 *    direction that reads more pages; the size of the read stays capped either way.
 *  · Nothing here fetches a Sitemap. It only reports the addresses the file lists.
 */

export const OUR_AGENT = "bsllc-pagereader";
export const MAX_CRAWL_DELAY_MS = 10_000;

interface Rule { allow: boolean; pattern: string }
interface Group { agents: string[]; rules: Rule[]; crawlDelay: number | null }

export interface RobotsRules {
  /** True where nothing was read and everything is allowed. */
  open: boolean;
  allows(path: string): boolean;
  /** Seconds the file asks for between requests, for our group. Null where it asks nothing. */
  crawlDelaySeconds: number | null;
  sitemaps: string[];
}

export const ALLOW_ALL: RobotsRules = { open: true, allows: () => true, crawlDelaySeconds: null, sitemaps: [] };

function compile(pattern: string): RegExp | null {
  let p = pattern.trim();
  if (!p) return null;
  const anchored = p.endsWith("$");
  if (anchored) p = p.slice(0, -1);
  p = p.replace(/\*{2,}/g, "*");
  if ((p.match(/\*/g) ?? []).length > 6) return null;
  const re = p.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  try { return new RegExp(`^${re}${anchored ? "$" : ""}`); } catch { return null; }
}

export function parseRobots(text: string): RobotsRules {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  const lines = String(text ?? "").slice(0, 500_000).split(/\r?\n/);
  for (const raw of lines.slice(0, 20_000)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [], crawlDelay: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === "sitemap") { if (/^https?:\/\//i.test(value) && sitemaps.length < 20) sitemaps.push(value); continue; }
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      if (current.rules.length < 1000) current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay") {
      const d = Number(value);
      if (Number.isFinite(d) && d >= 0) current.crawlDelay = d;
    }
  }
  // A group names us when its agent is part of our name; `*` is the fallback.
  const ours = groups.filter((g) => g.agents.some((a) => a !== "*" && a.length > 0 && OUR_AGENT.includes(a)));
  const star = groups.filter((g) => g.agents.includes("*"));
  const chosen = ours.length ? ours : star;
  const rules: Array<Rule & { re: RegExp; len: number }> = [];
  let crawlDelay: number | null = null;
  for (const g of chosen) {
    if (g.crawlDelay != null) crawlDelay = crawlDelay == null ? g.crawlDelay : Math.max(crawlDelay, g.crawlDelay);
    for (const r of g.rules) {
      if (r.pattern === "") continue; // an empty Disallow allows everything; an empty Allow adds nothing
      const re = compile(r.pattern);
      if (re) rules.push({ ...r, re, len: r.pattern.replace(/\$$/, "").length });
    }
  }
  return {
    open: false,
    crawlDelaySeconds: crawlDelay,
    sitemaps,
    allows(path: string): boolean {
      let best: (typeof rules)[number] | null = null;
      for (const r of rules) {
        if (!r.re.test(path)) continue;
        if (!best || r.len > best.len || (r.len === best.len && r.allow && !best.allow)) best = r;
      }
      return best ? best.allow : true;
    },
  };
}

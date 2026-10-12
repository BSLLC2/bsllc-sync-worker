/**
 * What a page says about itself, read out of its HTML.
 *
 * PURE. A string in, facts out. No network, no clock, no database, so the page
 * reader's verify script can run it against hostile fixtures with nothing else
 * switched on.
 *
 * ── WHY A SCANNER AND NOT A REGULAR EXPRESSION OVER THE WHOLE PAGE ─────────
 *
 * The input is somebody else's HTML, up to the size cap, and a pattern with a
 * lazy `[\s\S]*?` that has to run to the end of the file whenever it fails is a
 * pattern a hostile page can make quadratic (a hundred thousand unclosed comment
 * openers). This walks the text once with `indexOf`, and every construct it
 * looks for either closes within a bounded distance or is treated as text.
 *
 * ── WHAT IT KEEPS, AND WHAT IT NEVER DOES ──────────────────────────────────
 *
 *  · It keeps short strings the recommendation quotes (title, description, the
 *    first heading, an outline), counts, flags, schema type names and the page's
 *    own links. Every string is cut to a fixed length.
 *  · The body text is returned to the caller for ONE purpose, working out which
 *    tracked searches the page carries (src/page-reader/phrases.ts), and the
 *    caller drops it. Nothing here writes anything.
 *  · NOTHING IN THE PAGE IS AN INSTRUCTION. A page that says "ignore previous
 *    instructions" is a page with that sentence in it.
 *  · No JavaScript is run. A page that builds its content in the browser reads
 *    as the thin page it is to a visitor who does not run scripts, and the
 *    reader says nothing about what a browser would show.
 */

export const TITLE_MAX = 300;
export const DESCRIPTION_MAX = 400;
export const HEADING_MAX = 160;
export const OUTLINE_MAX = 40;
export const SCHEMA_TYPES_MAX = 20;
export const LINKS_MAX = 500;
/** A tag longer than this is treated as text, not as a tag. */
const TAG_MAX = 8192;

export interface ExtractedPage {
  title: string | null;
  metaDescription: string | null;
  /** The first level 1 heading, in the page's own words. Null where there is none. */
  h1: string | null;
  h1Count: number;
  /** Level and text, document order, headings outside navigation only. */
  outline: Array<[number, string]>;
  wordCount: number;
  /** As written on the page, resolved against the page's address. */
  canonical: string | null;
  /** True where the page's own robots meta says noindex (or none). */
  noindex: boolean;
  schemaTypes: string[];
  /** Same-page anchors, resolved, fragment removed. The caller keeps the same-site ones. */
  links: string[];
  /** For the phrase pass ONLY. Never stored. */
  text: {
    title: string;
    h1s: string[];
    headings: string[];
    /** The first 100 words of the content. */
    first100: string;
    body: string;
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, g: string) => {
    if (g[0] === "#") {
      const n = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return " ";
      try { return String.fromCodePoint(n); } catch { return " "; }
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Attributes of one tag, names lowercased. A value-less attribute is "". */
export function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && /[\s/]/.test(raw[i]!)) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && !/[\s=/>]/.test(raw[j]!)) j++;
    const name = raw.slice(i, j).toLowerCase();
    i = j;
    while (i < n && /\s/.test(raw[i]!)) i++;
    let value = "";
    if (raw[i] === "=") {
      i++;
      while (i < n && /\s/.test(raw[i]!)) i++;
      const q = raw[i];
      if (q === '"' || q === "'") {
        const end = raw.indexOf(q, i + 1);
        value = end < 0 ? raw.slice(i + 1) : raw.slice(i + 1, end);
        i = end < 0 ? n : end + 1;
      } else {
        let k = i;
        while (k < n && !/\s/.test(raw[k]!)) k++;
        value = raw.slice(i, k);
        i = k;
      }
    }
    if (name && !(name in out)) out[name] = decodeEntities(value);
  }
  return out;
}

const RAW_TEXT = new Set(["script", "style", "template", "svg", "noscript", "iframe", "textarea"]);
const CHROME = new Set(["nav", "footer", "aside"]);
const BLOCK_BREAK = new Set(["p", "div", "br", "li", "ul", "ol", "tr", "td", "th", "table", "section", "article", "main", "header", "form", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);

function typesFromJsonLd(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 6 || value == null) return;
  if (Array.isArray(value)) { for (const v of value.slice(0, 200)) typesFromJsonLd(v, into, depth + 1); return; }
  if (typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  const t = o["@type"];
  const add = (x: unknown) => {
    if (typeof x !== "string") return;
    const name = x.replace(/^https?:\/\/schema\.org\//i, "").trim();
    if (/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name)) into.add(name);
  };
  if (Array.isArray(t)) t.slice(0, 10).forEach(add); else add(t);
  if (o["@graph"]) typesFromJsonLd(o["@graph"], into, depth + 1);
  for (const k of ["mainEntity", "hasPart", "itemListElement"]) if (o[k]) typesFromJsonLd(o[k], into, depth + 1);
}

function resolveHref(href: string, base: string): string | null {
  try {
    const u = new URL(href.trim(), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch { return null; }
}

/**
 * Read one page. `html` is already capped by the fetcher; `baseUrl` is the page's
 * final address, which relative links and the canonical are resolved against.
 */
export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const lower = html.toLowerCase();
  const n = html.length;
  let i = 0;

  let title: string | null = null;
  let metaDescription: string | null = null;
  let canonical: string | null = null;
  let noindex = false;
  const schema = new Set<string>();
  const links: string[] = [];
  const outline: Array<[number, string]> = [];
  const h1s: string[] = [];
  const headings: string[] = [];

  // Text buffers. `content` is the visible text outside navigation, a footer or a
  // sidebar; `all` is every visible word, used only when the first looks wrong.
  const content: string[] = [];
  // Running text only: no heading, no navigation. The opening words of a page are
  // what a searcher reads under its heading, so "the first 100 words" are these.
  const prose: string[] = [];
  const all: string[] = [];
  let chrome = 0;
  let inHead = true;
  let capture: null | { kind: "title" } | { kind: "heading"; level: number } = null;
  let captured = "";

  const pushText = (t: string) => {
    const txt = decodeEntities(t);
    if (capture) captured += txt;
    if (capture?.kind === "title") return;
    all.push(txt);
    if (!chrome) {
      content.push(txt);
      if (capture?.kind !== "heading") prose.push(txt);
    }
  };
  const endCapture = () => {
    if (!capture) return;
    const text = squash(captured);
    if (capture.kind === "title") {
      if (title == null && text) title = cut(text, TITLE_MAX);
    } else if (text && !chrome) {
      const level = capture.level;
      if (outline.length < OUTLINE_MAX) outline.push([level, cut(text, HEADING_MAX)]);
      if (level === 1) h1s.push(text);
      else if (level <= 4) headings.push(text);
    }
    capture = null;
    captured = "";
  };

  // A page can be built so that every "<" opens a quote that never closes, which
  // makes each one scan to the tag limit. A real page scans about its own length
  // once; this stops a hostile one at a few times that, and reads the rest as text.
  let scanBudget = n * 3 + 200_000;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { pushText(html.slice(i)); break; }
    if (lt > i) pushText(html.slice(i, lt));
    i = lt;

    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end < 0) break; // an unclosed comment swallows the rest, as a browser does
      i = end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    // A tag: find its closing ">", respecting quotes, within TAG_MAX.
    let j = i + 1;
    const closing = html[j] === "/";
    if (closing) j++;
    if (!/[a-zA-Z]/.test(html[j] ?? "")) { pushText("<"); i += 1; continue; }
    const nameStart = j;
    while (j < n && /[A-Za-z0-9:_-]/.test(html[j]!)) j++;
    const name = html.slice(nameStart, j).toLowerCase();
    let k = j;
    let quote: string | null = null;
    const limit = Math.min(n, j + TAG_MAX);
    if (scanBudget <= 0) { pushText(html.slice(i, Math.min(n, i + 200_000))); break; }
    while (k < limit) {
      const c = html[k]!;
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      k++;
    }
    scanBudget -= k - j;
    if (k >= limit || html[k] !== ">") { pushText("<"); i += 1; continue; }
    const rawAttrs = html.slice(j, k);
    i = k + 1;

    if (closing) {
      if (name === "title") endCapture();
      else if (/^h[1-6]$/.test(name)) endCapture();
      else if (CHROME.has(name)) chrome = Math.max(0, chrome - 1);
      else if (name === "head") inHead = false;
      else if (name === "body") chrome = 0;
      if (BLOCK_BREAK.has(name)) { all.push(" "); content.push(" "); prose.push(" "); }
      continue;
    }

    const attrs = parseAttrs(rawAttrs.replace(/\/\s*$/, ""));
    if (attrs.itemtype) {
      const m = /schema\.org\/([A-Za-z][A-Za-z0-9]{0,39})/.exec(attrs.itemtype);
      if (m) schema.add(m[1]!);
    }

    if (RAW_TEXT.has(name)) {
      const closeAt = lower.indexOf(`</${name}`, i);
      const bodyEnd = closeAt < 0 ? n : closeAt;
      if (name === "script" && /ld\+json/i.test(attrs.type ?? "") && bodyEnd - i < 400_000) {
        try { typesFromJsonLd(JSON.parse(html.slice(i, bodyEnd)), schema); } catch { /* unreadable markup is no markup */ }
      }
      if (closeAt < 0) break;
      const gt = html.indexOf(">", closeAt);
      i = gt < 0 ? n : gt + 1;
      continue;
    }

    switch (name) {
      case "title":
        if (inHead || title == null) { endCapture(); capture = { kind: "title" }; captured = ""; }
        break;
      case "meta": {
        const key = (attrs.name ?? attrs.property ?? "").toLowerCase();
        const content_ = attrs.content ?? "";
        if (key === "description" && metaDescription == null) {
          const d = squash(content_);
          if (d) metaDescription = cut(d, DESCRIPTION_MAX);
        } else if ((key === "robots" || key === "googlebot") && /(^|[\s,])(noindex|none)([\s,]|$)/i.test(content_)) {
          noindex = true;
        }
        break;
      }
      case "link":
        if (/(^|\s)canonical(\s|$)/i.test(attrs.rel ?? "") && attrs.href && canonical == null) canonical = resolveHref(attrs.href, baseUrl);
        break;
      case "a":
        if (attrs.href && links.length < LINKS_MAX) {
          const r = resolveHref(attrs.href, baseUrl);
          if (r) links.push(r);
        }
        break;
      case "body":
        inHead = false;
        break;
      default:
        if (/^h[1-6]$/.test(name)) { endCapture(); capture = { kind: "heading", level: Number(name[1]) }; captured = ""; }
        else if (CHROME.has(name)) chrome += 1;
        if (BLOCK_BREAK.has(name)) { all.push(" "); content.push(" "); prose.push(" "); }
    }
  }
  endCapture();

  const allText = squash(all.join(" "));
  let bodyText = squash(content.join(" "));
  // Navigation that never closed would leave nothing. Fall back to every visible
  // word rather than report a page of nought words that has a thousand.
  const wordsOf = (t: string): string[] => t.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w));
  let words = wordsOf(bodyText);
  if (words.length < 50) {
    const every = wordsOf(allText);
    if (every.length >= 50) { bodyText = allText; words = every; }
  }
  const proseWords = wordsOf(squash(prose.join(" ")));
  // With almost no running text (a page that is all headings and links) the first
  // 100 words are the content's own, so the field is never empty on a page that
  // has words.
  const first100 = (proseWords.length >= 20 ? proseWords : words).slice(0, 100).join(" ");

  return {
    title,
    metaDescription,
    h1: h1s[0] ? cut(h1s[0], HEADING_MAX) : null,
    h1Count: h1s.length,
    outline,
    wordCount: words.length,
    canonical,
    noindex,
    schemaTypes: Array.from(schema).slice(0, SCHEMA_TYPES_MAX),
    links,
    text: { title: title ?? "", h1s, headings, first100, body: bodyText },
  };
}

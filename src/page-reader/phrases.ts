/**
 * Which of a client's searches a page carries, and in which part.
 *
 * PURE. The page's text goes in and a small number per search comes out
 * (src/seo-page-bits.ts says what each bit means). The text is then dropped: the
 * table keeps the numbers, never the sentences.
 */
import { ideaKey, ideaWords } from "./../ads/idea-relevance.js";
import { MAX_PHRASES_PER_PAGE, phraseBits, type PageWordParts } from "../seo-page-bits.js";
import type { ExtractedPage } from "./html-facts.js";

export interface PagePhrase { key: string; words: string[] }

/**
 * The searches to check on every page: de-duplicated on the same key the app
 * stores them under, with no phrase that has no significant word, and capped.
 * Order is the caller's priority order and the cap cuts from the end.
 */
export function pagePhrases(phrases: readonly string[]): { phrases: PagePhrase[]; leftOut: number } {
  const seen = new Set<string>();
  const out: PagePhrase[] = [];
  let usable = 0;
  for (const raw of phrases) {
    const key = ideaKey(String(raw ?? ""));
    if (!key || seen.has(key)) continue;
    const words = ideaWords(String(raw));
    if (!words.length) continue;
    seen.add(key);
    usable += 1;
    if (out.length < MAX_PHRASES_PER_PAGE) out.push({ key, words });
  }
  return { phrases: out, leftOut: usable - out.length };
}

const wordSet = (s: string): Set<string> => new Set(ideaWords(s));

export function addressWords(url: string): Set<string> {
  let path = "";
  try { path = decodeURIComponent(new URL(url).pathname); } catch { path = url; }
  return wordSet(path.replace(/[-_/.]+/g, " "));
}

export function partsOf(page: ExtractedPage, url: string): PageWordParts {
  return {
    url: addressWords(url),
    title: wordSet(page.text.title),
    h1s: page.text.h1s.map(wordSet),
    headings: page.text.headings.map(wordSet),
    first100: wordSet(page.text.first100),
    body: wordSet([page.text.title, ...page.text.h1s, ...page.text.headings, page.text.body].join(" ")),
  };
}

/** `{ "<key>": bits }` for every phrase, zero included: a zero is an answer. */
export function bitsForPage(page: ExtractedPage, url: string, phrases: readonly PagePhrase[]): Record<string, number> {
  const parts = partsOf(page, url);
  const visible = ` ${ideaKey([page.text.title, ...page.text.h1s, ...page.text.headings, page.text.body].join(" "))} `;
  const out: Record<string, number> = {};
  for (const p of phrases) out[p.key] = phraseBits(p.words, parts, visible.includes(` ${p.key} `));
  return out;
}

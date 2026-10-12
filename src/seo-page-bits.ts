/** Which parts of a page carry a search phrase. */

/**
 * Pure. No imports, because this file is copied byte for byte into the worker
 * (bsllc-sync-worker/src/seo-page-bits.ts) and `npm run verify:wiring` fails on the
 * first line that differs. The worker WORKS OUT the bits while it reads a page;
 * this app only ever READS them back. If the two disagreed about what a bit means,
 * a page would be called "about" a search by one and not by the other.
 *
 *  · A PAGE'S TEXT IS NEVER STORED. What is stored is one small number per phrase
 *    that was checked, so the recommendation can say "the title does not contain
 *    it" without keeping the title's neighbours, the body or any visitor's words.
 *  · A BIT IS "EVERY SIGNIFICANT WORD OF THE PHRASE, IN THE SAME PART". Words are
 *    folded the way `shared/idea-relevance.ts` folds them (plurals, joining words
 *    dropped), in any order. "addiction treatment" is in a title that says
 *    "Treatment for Addiction". It is in a heading only if ONE heading holds every
 *    word, so two unrelated headings never add up to a match.
 *  · ZERO IS AN ANSWER: the phrase was checked and no part carries it. A phrase
 *    that was never checked is ABSENT from the page's list, and the app reads that
 *    as "not checked on this read", never as zero.
 */

/** The parts of a page, one bit each. */
export const PHRASE_BITS = {
  /** The address path carries every word. */
  url: 1,
  /** The page title. */
  title: 2,
  /** One heading level 1. */
  h1: 4,
  /** One heading of level 2 to 4. */
  headings: 8,
  /** The first 100 words of the body. */
  first100: 16,
  /** Anywhere in the page's visible text. */
  body: 32,
  /** The phrase itself, in order, in the visible text. */
  exact: 64,
} as const;

export type PhraseBitName = keyof typeof PHRASE_BITS;

export const PHRASE_BIT_NAMES = Object.keys(PHRASE_BITS) as PhraseBitName[];

/** The most phrases the worker checks on one page, so a row stays small. */
export const MAX_PHRASES_PER_PAGE = 300;

export function hasBit(bits: number, name: PhraseBitName): boolean {
  return (bits & PHRASE_BITS[name]) !== 0;
}

/** A part of a page reduced to its words, already folded by the caller. */
export interface PageWordParts {
  url: ReadonlySet<string>;
  title: ReadonlySet<string>;
  /** One set per level 1 heading. */
  h1s: ReadonlyArray<ReadonlySet<string>>;
  /** One set per heading of level 2 to 4. */
  headings: ReadonlyArray<ReadonlySet<string>>;
  first100: ReadonlySet<string>;
  body: ReadonlySet<string>;
}

const holdsAll = (set: ReadonlySet<string>, words: readonly string[]): boolean =>
  words.length > 0 && words.every((w) => set.has(w));

/**
 * The bits for one phrase. `words` are the phrase's folded significant words and
 * must not be empty; an empty phrase has nothing to check and the caller leaves it
 * out of the list. `exact` is true when the phrase appears in order in the text,
 * which only the caller can decide, since this file never sees a sentence.
 */
export function phraseBits(words: readonly string[], parts: PageWordParts, exact: boolean): number {
  if (words.length === 0) return 0;
  let bits = 0;
  if (holdsAll(parts.url, words)) bits |= PHRASE_BITS.url;
  if (holdsAll(parts.title, words)) bits |= PHRASE_BITS.title;
  if (parts.h1s.some((h) => holdsAll(h, words))) bits |= PHRASE_BITS.h1;
  if (parts.headings.some((h) => holdsAll(h, words))) bits |= PHRASE_BITS.headings;
  if (holdsAll(parts.first100, words)) bits |= PHRASE_BITS.first100;
  if (holdsAll(parts.body, words)) bits |= PHRASE_BITS.body;
  if (exact) bits |= PHRASE_BITS.exact;
  return bits;
}

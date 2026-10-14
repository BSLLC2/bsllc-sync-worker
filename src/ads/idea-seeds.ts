/** What a keyword research run asks the provider for, and what counts as the client's business. */

/**
 * Pure and import-free, because this file is copied byte for byte into the
 * worker (bsllc-sync-worker/src/ads/idea-seeds.ts) and `npm run verify:wiring`
 * fails when the two drift. The run decides which searches to ask the provider
 * for; the app judges the ideas that come back. Both have to read a seed the
 * same way or a card says "kept" beside a run that asked for something else.
 *
 * It sits BESIDE shared/idea-relevance.ts and changes nothing in it. That rule
 * says an idea is kept only if it holds every word of a seed or a signed-off
 * service. This file feeds it better anchors and decides what to ask for.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The owner, on a run for Franklin Brazing (a furnace brazing and heat
 * treating manufacturer): ten seeds taken from 105 recorded services, 200
 * ideas back, "0 kept of 200". Opened, the 200 were "pvc pipe", "furnace",
 * "first american home warranty", "mold remediation services", "coupe glass",
 * "handyman services". The set-aside was RIGHT. The ideas were junk, and the
 * cause was upstream of every filter:
 *
 *  1. ALL SEEDS WENT INTO ONE SEMANTIC CALL. The provider's `keyword_ideas` is
 *     an expansion ordered by volume. With ten seeds and a limit of 200, the
 *     200 slots were spent on the biggest national head terms near the words
 *     "furnace" and "services" before any test of relevance ran. The fix is to
 *     ask for searches that CONTAIN the seed, one seed at a time, with a share
 *     of the limit each (`providerSeeds`, `perSeedLimit`).
 *  2. A SERVICE NAME ENDS IN A GENERIC WORD. "furnace brazing services" is a
 *     service name; nobody searches for "services". The relevance rule needs
 *     every word of an anchor, so even a good idea like "vacuum brazing" held
 *     no anchor, and "brazing services" was refused outright as reduced to one
 *     word. `trailingCore` drops that one kind of word, from the END only.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 *
 *  · ONLY A TRAILING GENERIC BUSINESS WORD COMES OFF. A short declared list of
 *    plain English ("services", "company", "provider") and no industry word. A
 *    word that ends a phrase and names the trade ("treatment", "repair") is
 *    NEVER on it. A modifier is never dropped: "furnace" stays in "furnace
 *    brazing". "AC repair" has no generic word and is still refused by the
 *    relevance rule as reduced to one common word.
 *  · A ONE-WORD CORE IS ALLOWED ONLY WHEN IT CAME FROM DROPPING A TRAILING
 *    GENERIC WORD. "brazing services" gives "brazing" because the person typed
 *    the business word and then a generic one. A one-word core reached any
 *    other way (a short word stripped from the front) stays refused by
 *    idea-relevance.ts.
 *  · A PERSON'S DECLARED WORD IS A TYPED ANCHOR. One word, three to thirty
 *    letters, recorded with a name. It is passed as a seed typed as one word,
 *    which idea-relevance.ts already allows.
 *  · NOTHING IS GUESSED. No list of industries, brands or insurers. The words
 *    offered to a person as a choice are counted out of the ideas themselves.
 */

/**
 * Plain business words that follow the name of a trade and are not part of
 * what anyone types. Not a list of industries: "treatment", "repair",
 * "program" and "center" name or shape the trade and are NOT here.
 */
export const GENERIC_TRAILING_WORDS: readonly string[] = [
  "service", "solution", "company", "provider",
];

/** Joining words, the same ones idea-relevance.ts drops. Kept in step by a test. */
const JOINING_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "to", "with", "at", "on",
  "by", "my", "our", "your", "is", "are",
]);

export const MAX_DECLARED_WORDS = 20;
export const MIN_DECLARED_WORD_LETTERS = 3;
export const MAX_DECLARED_WORD_LETTERS = 30;
/** Most searches a run asks the provider for in one place. */
export const MAX_PROVIDER_SEARCHES = 20;
/** Fewest rows any one seed is given. */
export const MIN_ROWS_PER_SEED = 20;
/** How many distinctive words the panel offers. */
export const WORD_CHIPS_SHOWN = 8;

/** The fold idea-relevance.ts uses (`foldWord`). A test holds the two together. */
export function foldSeedWord(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

const NOT_A_WORD = new RegExp("[^\\p{L}\\p{N}]+", "gu");
/** Built at run time for the same reason: a `u` literal will not compile below ES2015. */
const ALL_LETTERS = new RegExp("^\\p{L}+$", "u");

function typedWords(s: string): string[] {
  return String(s ?? "").toLowerCase().replace(NOT_A_WORD, " ").trim().split(" ").filter((t) => t.length > 0);
}

const GENERIC_FOLDED = new Set(GENERIC_TRAILING_WORDS.map(foldSeedWord));

/** The significant words of a phrase: joining words off, plurals folded. */
function significant(s: string): string[] {
  return typedWords(s).filter((t) => !JOINING_WORDS.has(t)).map(foldSeedWord);
}

/**
 * The phrase with its trailing generic words taken off, or null where there is
 * nothing to take off or nothing would be left. "furnace brazing services" is
 * "furnace brazing". "services" alone is null. "AC repair" is null.
 */
export function trailingCore(phrase: string): string | null {
  const words = typedWords(phrase);
  let end = words.length;
  while (end > 0 && GENERIC_FOLDED.has(foldSeedWord(words[end - 1]!))) end -= 1;
  if (end === words.length || end === 0) return null;
  return words.slice(0, end).join(" ");
}

function dedupe(phrases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of phrases) {
    const key = typedWords(p).join(" ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p.trim());
  }
  return out;
}

/**
 * A core worth judging by. A one-word core stands: the person typed the business
 * word and then a generic one. A core of several words stands only if two of
 * them survive idea-relevance.ts's own rule (three letters or more), so
 * "AC repair services" does not offer "AC repair", which that rule would refuse
 * as one common word and then name in the line as a phrase nobody typed.
 */
function usableCore(core: string): boolean {
  const typed = typedWords(core);
  if (typed.length === 1) return significant(core).some((w) => w.length >= MIN_DECLARED_WORD_LETTERS);
  return significant(core).filter((w) => w.length >= MIN_DECLARED_WORD_LETTERS).length >= 2;
}

/** Each phrase and, after it, its core where it has a usable one. Order kept. */
export function withCores(phrases: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const p of phrases ?? []) {
    const s = String(p ?? "");
    out.push(s);
    const core = trailingCore(s);
    if (core && usableCore(core)) out.push(core);
  }
  return dedupe(out);
}

/** The words a person declared, as the seeds idea-relevance.ts takes. */
export interface JudgingInputs {
  seeds: string[];
  services: string[] | null;
}

/**
 * What to hand `judgeIdeas`. Seeds and services each gain their cores; the
 * person's declared words join the seeds. A null services list stays null: an
 * unsigned list is unanswered and the line says so.
 */
export function judgingInputs(input: {
  seeds?: readonly string[] | null;
  services?: readonly string[] | null;
  declaredWords?: readonly string[] | null;
}): JudgingInputs {
  return {
    seeds: dedupe([...withCores(input.seeds ?? []), ...(input.declaredWords ?? [])]),
    services: input.services == null ? null : withCores(input.services),
  };
}

/**
 * The searches to ask the provider for, one call each. A seed whose core is
 * shorter asks for the core ("brazing services" asks for "brazing"), so the
 * provider returns searches that contain the word the client sells. At most
 * MAX_PROVIDER_SEARCHES, in the order given.
 */
export function providerSeeds(seeds: readonly string[] | null | undefined): string[] {
  const asked = (seeds ?? []).map((s) => trailingCore(String(s ?? "")) ?? String(s ?? "").trim().replace(/\s+/g, " "));
  return dedupe(asked).slice(0, MAX_PROVIDER_SEARCHES);
}

/** A seed's share of the run's row limit. Never under MIN_ROWS_PER_SEED. */
export function perSeedLimit(limit: number, seedCount: number): number {
  const n = Math.max(1, Math.floor(seedCount));
  const l = Math.max(1, Math.floor(limit));
  return Math.max(MIN_ROWS_PER_SEED, Math.floor(l / n));
}

/** Does an idea hold every significant word of a search, in any order? */
export function containsAllWords(idea: string, search: string): boolean {
  const want = significant(search);
  if (want.length === 0) return false;
  const have = new Set(significant(idea));
  return want.every((w) => have.has(w));
}

/** Which of the asked searches an idea contains: the index of the first, or -1. */
export function containedBy(idea: string, searches: readonly string[]): number {
  for (let i = 0; i < searches.length; i++) if (containsAllWords(idea, searches[i]!)) return i;
  return -1;
}

/**
 * Keep the ideas that contain an asked search, at most `perSeed` for each, the
 * biggest first inside a search. A provider that has no filter for a place
 * returns a long list; this is how its volume order can never fill the cap with
 * head terms nobody asked about.
 */
export function containAndCap<T extends { keyword: string; volume: number | null }>(
  ideas: readonly T[],
  searches: readonly string[],
  perSeed: number,
): T[] {
  const buckets: T[][] = searches.map(() => []);
  for (const idea of ideas) {
    const at = containedBy(idea.keyword, searches);
    if (at >= 0) buckets[at]!.push(idea);
  }
  const out: T[] = [];
  for (const b of buckets) {
    b.sort((x, y) => (y.volume ?? 0) - (x.volume ?? 0));
    out.push(...b.slice(0, perSeed));
  }
  return out;
}

/* ───────────────────────── a person's declared words ───────────────────────── */

export interface DeclaredWord {
  word: string;
  by: string | null;
  at: string | null;
}

export type DeclaredWordFault = "empty" | "not_one_word" | "too_short" | "too_long" | "not_letters";

export type DeclaredWordCheck =
  | { ok: true; word: string }
  | { ok: false; code: DeclaredWordFault; message: string };

/** A word to count ideas by: one word, three to thirty letters. */
export function cleanDeclaredWord(raw: unknown): DeclaredWordCheck {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!text) return { ok: false, code: "empty", message: "Type a word." };
  if (/\s/.test(text)) return { ok: false, code: "not_one_word", message: "Use one word. For a phrase, add it as a seed." };
  if (!ALL_LETTERS.test(text)) return { ok: false, code: "not_letters", message: "Letters only, one word." };
  if (text.length < MIN_DECLARED_WORD_LETTERS) return { ok: false, code: "too_short", message: `A word needs at least ${MIN_DECLARED_WORD_LETTERS} letters.` };
  if (text.length > MAX_DECLARED_WORD_LETTERS) return { ok: false, code: "too_long", message: `A word is at most ${MAX_DECLARED_WORD_LETTERS} letters.` };
  return { ok: true, word: text };
}

export function declaredWordKey(word: string): string {
  return foldSeedWord(String(word ?? "").trim().toLowerCase());
}

export interface WordChip { word: string; count: number }

/**
 * The words most set-aside ideas share, so a person can say "count ideas with
 * this word". A word is offered unless it is a joining word, a generic
 * business word, already declared, or already counted on its own (a one-word
 * seed or a one-word core). Counted once per idea, shown folded.
 */
export function distinctiveWords(
  setAside: readonly string[],
  exclude: { declared?: readonly string[]; anchored?: readonly string[] },
): WordChip[] {
  const skip = new Set<string>();
  for (const w of exclude.declared ?? []) skip.add(declaredWordKey(w));
  for (const a of exclude.anchored ?? []) {
    const words = significant(a);
    if (words.length === 1) skip.add(words[0]!);
  }
  const counts = new Map<string, number>();
  for (const idea of setAside) {
    const seen = new Set<string>();
    for (const w of significant(idea)) {
      if (seen.has(w)) continue;
      seen.add(w);
      if (w.length < MIN_DECLARED_WORD_LETTERS || w.length > MAX_DECLARED_WORD_LETTERS) continue;
      if (!ALL_LETTERS.test(w)) continue;
      if (GENERIC_FOLDED.has(w) || skip.has(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, WORD_CHIPS_SHOWN);
}

/** The one-word cores that count on their own, for the panel to name. */
export function coreWordsOf(phrases: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const p of phrases ?? []) {
    const core = trailingCore(String(p ?? ""));
    if (core && typedWords(core).length === 1) out.push(core);
  }
  return dedupe(out);
}

/* ───────────────────────── the sentences ───────────────────────── */

function count(n: number): string { return n.toLocaleString("en-US"); }

/** Said when every idea in a run was set aside. */
export function noneKeptLine(total: number): string {
  return `None of the ${count(total)} ideas contain a word from what this client sells.`;
}

/** Said above the choice of words. */
export const WORD_CHOICE_LINE = "Tap one to keep what holds it";

/** The label in front of the words a person declared. */
export const DECLARED_WORDS_LABEL = "Counting ideas with";

/** Said under the declared words. */
export function declaredWordsLine(words: readonly string[]): string | null {
  if (words.length === 0) return null;
  return `${DECLARED_WORDS_LABEL}: ${words.join(", ")}`;
}

/** Said when the single words from service names are counted too. */
export function coreWordsLine(words: readonly string[]): string | null {
  if (words.length === 0) return null;
  return `Service names count by their main word too: ${words.join(", ")}.`;
}

/** Said when the provider call asks for each search on its own. */
export function askedSearchesLine(searches: readonly string[]): string {
  return `Asked for searches that contain: ${searches.join(", ")}.`;
}

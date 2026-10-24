/**
 * Which searches name the client: the brand test behind `seo_query_months`.
 *
 * PURE. No database, no network, no clock. `src/verify-query-months.ts` drives it on
 * invented terms and invented searches.
 *
 * THE RULE, in one place so the guard and the job cannot disagree:
 *  1. A search is BRANDED when the client's name, an alias or a recorded brand term
 *     appears in it as WHOLE WORDS. Case, punctuation, spacing and accents are set
 *     aside ("Bell Wood", "bell-wood", "BELLWOOD" and "Bellwood" are one thing), and
 *     the term run together matches the search spaced out and the other way round.
 *     A word that only CONTAINS the term does not match: "bellwoodfarm" is not "bellwood".
 *  2. A term under MIN_TERM_LETTERS letters or digits is refused.
 *  3. A single short word that is also an everyday word ("hope", "star", "love") is
 *     skipped and COUNTED, never matched: it would call half the web branded.
 *  4. A person typed the brand terms or the job derived them from the client's own
 *     name, aliases and domain; `terms_source` says which. Nothing is guessed beyond that.
 *
 * NOTHING HERE KEEPS A SEARCH. `matchesBrand` returns yes or no; the callers add up
 * clicks and impressions and drop the text on the floor.
 */
import { createHash } from "node:crypto";

export const MIN_TERM_LETTERS = 3;
/** A single word this short is checked against COMMON_WORDS. OURS. */
export const SHORT_WORD_MAX = 4;
/** The most spaced-out words one run-together term may be matched across. */
const MAX_RUN_WORDS = 6;

/**
 * Everyday words a business is often named after. Declared, small and ours: a
 * client whose name is one of them must add a longer term ("hope clinic") or type
 * the list, because "hope" alone is mostly people who are not looking for them.
 * Only words of SHORT_WORD_MAX letters or fewer are tested.
 */
export const COMMON_WORDS: readonly string[] = [
  "the", "and", "for", "new", "one", "all", "best", "home", "care", "good", "gold", "blue", "red", "green", "black", "white",
  "hope", "life", "love", "star", "sun", "moon", "sky", "sea", "bay", "oak", "pine", "rock", "stone", "wood", "peak", "edge",
  "core", "apex", "link", "wave", "hub", "app", "web", "shop", "store", "main", "city", "park", "club", "bank", "union",
  "first", "true", "bright", "smart", "prime", "pure", "next", "open", "free", "easy", "fast", "top", "pro", "plus", "max",
  "north", "south", "east", "west", "metro", "area", "team", "group", "plan", "path", "way", "bridge", "river", "lake",
  "farm", "land", "house", "town", "grand", "royal", "iron", "steel", "silver", "rose", "lily", "fox", "bear", "wolf",
  "eagle", "hawk", "lion", "tiger", "aim", "ace", "alpha", "omega", "delta", "echo", "zen", "joy", "wise", "warm", "cool",
].filter((w) => w.length <= SHORT_WORD_MAX);
const COMMON = new Set(COMMON_WORDS);

/** Words that end a company name and are never typed into a search. Used only on DERIVED terms. */
const LEGAL_SUFFIX = new Set(["llc", "inc", "ltd", "corp", "co", "pllc", "llp", "lp", "company", "incorporated", "limited"]);

/** Case, accents and punctuation set aside; the words that are left. An apostrophe closes up ("o'brien" is "obrien"). */
export function fold(input: unknown): string[] {
  const s = String(input ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return s ? s.split(" ") : [];
}

export interface PreparedTerm { words: string[]; compact: string }

export interface PreparedTerms {
  /** The terms that can be matched. */
  terms: PreparedTerm[];
  /** How many were refused for being under MIN_TERM_LETTERS. */
  refused: number;
  /** How many were skipped for being one everyday short word. */
  skipped: number;
  /** The accepted terms, folded, sorted, one string each. */
  list: string[];
  /** First 16 hex characters of sha256 over `list` joined by newlines. Says whether the list changed between runs. */
  fingerprint: string;
}

export function fingerprintOf(list: readonly string[]): string {
  return createHash("sha256").update(list.join("\n")).digest("hex").slice(0, 16);
}

export function prepareTerms(raw: readonly unknown[]): PreparedTerms {
  const seen = new Map<string, PreparedTerm>();
  let refused = 0, skipped = 0;
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const words = fold(r);
    const compact = words.join("");
    if (!compact) continue;
    if (compact.length < MIN_TERM_LETTERS) { refused += 1; continue; }
    if (words.length === 1 && compact.length <= SHORT_WORD_MAX && COMMON.has(compact)) { skipped += 1; continue; }
    const key = words.join(" ");
    if (!seen.has(key)) seen.set(key, { words, compact });
  }
  const list = Array.from(seen.keys()).sort();
  return { terms: list.map((k) => seen.get(k)!), refused, skipped, list, fingerprint: fingerprintOf(list) };
}

/**
 * Is this search a brand search? Returns a yes or no and keeps nothing.
 * A term matches when some run of the search's words, joined with no spaces, equals the
 * term joined with no spaces: whole words at both ends, spacing ignored inside.
 */
export function matchesBrand(query: unknown, terms: readonly PreparedTerm[]): boolean {
  if (!terms.length) return false;
  const qw = fold(query);
  if (!qw.length) return false;
  for (const t of terms) {
    for (let i = 0; i < qw.length; i++) {
      let acc = "";
      for (let j = i; j < qw.length && j < i + MAX_RUN_WORDS; j++) {
        acc += qw[j];
        if (acc.length > t.compact.length) break;
        if (acc === t.compact) return true;
      }
    }
  }
  return false;
}

/** A name without the words a company adds after it ("Bellwood Farms LLC" is searched as "bellwood farms"). */
export function stripLegalSuffix(name: string): string {
  const words = fold(name);
  while (words.length > 1 && LEGAL_SUFFIX.has(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}

/** Patterns the worker already derives (name, aliases, domain label), with company suffixes taken off. */
export function derivedTermList(patterns: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of patterns) {
    const t = stripLegalSuffix(p);
    if (t) out.add(t);
  }
  return Array.from(out);
}

export interface TypedTerms { terms: string[]; by: string; at: string }

/**
 * The list a person typed (`app_settings` key `brand_terms:<clientId>`):
 * `{"terms":[...],"by":"name","at":"iso"}`. A typed answer carries a name and a date
 * or it is not read; anything else (null, broken JSON, no terms, no name) is "nobody
 * has typed one" and the job derives the terms instead.
 */
export function parseTypedTerms(value: string | null | undefined): TypedTerms | null {
  if (!value || !value.trim()) return null;
  let j: unknown;
  try { j = JSON.parse(value); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const o = j as { terms?: unknown; by?: unknown; at?: unknown };
  if (!Array.isArray(o.terms)) return null;
  const terms = o.terms.filter((t): t is string => typeof t === "string" && t.trim() !== "");
  if (!terms.length) return null;
  if (typeof o.by !== "string" || !o.by.trim()) return null;
  if (typeof o.at !== "string" || Number.isNaN(Date.parse(o.at))) return null;
  return { terms, by: o.by.trim(), at: o.at };
}

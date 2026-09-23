/**
 * Is a term something this client actually provides?
 *
 * Pure. Facts in, one verdict out, in the style of `spendVisibility` and
 * `biddingReadiness` next door.
 *
 * ── THE QUESTION, VERBATIM ────────────────────────────────────────────────
 *
 * From the company owner: "how do we make sure that the SEO data pulls stuff
 * that's relevant to the core services of the company not things that they
 * don't actually provide."
 *
 * He is right that this is the crux. A keyword-gap list is a list of things
 * this client is not selling to people who want them, and ONE entry for a
 * service they do not offer discredits every other row on it. Keyword research
 * expands a seed into hundreds of neighbouring terms: seed "commercial
 * roofing" and DataForSEO will hand back gutter cleaning, roof inspection
 * training courses and roofing jobs near me. Two of those three are not this
 * client's business and nothing about the volume figure says so.
 *
 * ── WHAT THE RECORD SAYS TODAY, AND WHAT IT DOES NOT ──────────────────────
 *
 * Nothing on the `clients` record says what a client SELLS. The module flags
 * (moduleSeo / moduleAds / moduleAeo / webOpsAddOn) are what WE do for them.
 * `archetype` is how the account is shaped. `industry` sits on a CRM company,
 * not on the client. There has never been a services field anywhere.
 *
 * So one is recorded — `client_services` in the dashboard — and this module is
 * what reads it. It is SEEDED from three things already on the record (the
 * client's own SEO target keywords, the queries that already convert in their
 * ad account, and their campaign names) so confirming it is five minutes of
 * ticking rather than homework in an empty box. But a seed is not an answer:
 *
 *  1. ONLY A CONFIRMED SERVICE COUNTS. A candidate this system derived is not
 *     evidence of anything. If the seed were allowed to double as the answer
 *     nobody would ever confirm a list and the "recorded" services would be
 *     the guess wearing a better label.
 *  2. NO CONFIRMED LIST MEANS NO READING AT ALL. Not a volume-only fallback,
 *     not the seeds, not a partial list of the terms that look plausible. The
 *     reading says what is missing and where to answer it, and produces
 *     nothing. A believable list of services a client does not offer is worse
 *     than no list.
 *  3. EVERY ROW SAYS WHAT MAKES IT RELEVANT — which confirmed service it
 *     matches, and where the account's own converting queries already prove
 *     that service sells. A term that cannot say why it is relevant is
 *     dropped rather than shown with a hedge.
 *
 * Rules 1 and 2 are `shared/launch-unknowns.ts`'s discipline applied to a
 * list: a null is never an answer, only a named person with a date counts, and
 * it is never inferred from the blank beside it. That catalog itself is not
 * reused — every entry in it is a numeric column on `clients` with a launch
 * step and a consequence in the client's terms, and a list of services is
 * none of those. The same call `team_members.weekly_overhead_hours` made.
 */

/** One service a person confirmed this client provides. */
export interface ConfirmedService {
  /** As the person typed or ticked it. Rendered verbatim. */
  name: string;
  /** Their own note, where they left one. */
  note: string | null;
}

/**
 * What the record holds about what this client sells.
 *
 * `services: null` means NOBODY HAS CONFIRMED A LIST, which is a different
 * answer from `[]` (somebody looked and recorded none) and from a list of
 * seeds nobody has ticked. All three are kept apart here because only one of
 * them licenses a keyword-gap row.
 */
export interface ClientServiceFacts {
  services: ConfirmedService[] | null;
  /** Who confirmed the list, and when. Null where nobody has. */
  confirmedBy: string | null;
  confirmedAt: string | null;
  /** How many candidates were derived and are sitting unconfirmed. Counted so
   *  the refusal can say the work is half done rather than untouched. */
  candidatesWaiting: number;
}

/**
 * A service name shorter than this, once punctuation is stripped, is not used
 * to match anything.
 *
 * Ours. Two characters is an abbreviation ("AC", "IT") that appears inside
 * ordinary words the moment matching is done on tokens, and the cost of a
 * false match here is the one failure this module exists to prevent. An AM who
 * genuinely sells "AC repair" writes that, which is two tokens and matches.
 */
export const MIN_SERVICE_TOKEN_LENGTH = 3;

/**
 * Words dropped before a service is matched against a term.
 *
 * Deliberately short and grammatical. It holds articles, conjunctions and
 * prepositions — words that carry no subject — and nothing else. A longer list
 * would start dropping words that ARE the service ("near", "emergency",
 * "commercial"), and dropping one of those is how "commercial roofing" starts
 * matching "residential roofing".
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "to", "with", "at", "on",
  "by", "my", "our", "your", "is", "are",
]);

/**
 * Letters and digits only, lowercased, split on everything else.
 *
 * The same normalisation `normalizeQueryText` in query-promotion.ts applies,
 * tokenised. It folds case, punctuation and spacing, none of which changes
 * meaning, and it does NOT stem, fold plurals or reorder — so "roof" does not
 * match "roofing" and "roofing" does not match "roofs". That direction leaves
 * a real gap unmatched and shows nothing, which is the safe way to be wrong
 * here; the other direction puts a service on the list that nobody sells.
 */
export function serviceTokens(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/** Tokens long enough to be matched on. Empty means the service cannot match. */
function matchableTokens(s: string): string[] {
  return serviceTokens(s).filter((t) => t.length >= MIN_SERVICE_TOKEN_LENGTH);
}

/**
 * Does `term` cover every significant word of `service`?
 *
 * Containment in ONE direction only, and the direction matters. "Commercial
 * roofing" matches "emergency commercial roofing repair" because the term is
 * the service plus qualifiers — that is the same business, described more
 * precisely. It does NOT match "roofing repair", which is missing the word
 * that says which half of the market this client is in.
 */
export function termCoversService(term: string, service: string): boolean {
  const need = matchableTokens(service);
  if (need.length === 0) return false;
  const have = new Set(serviceTokens(term));
  return need.every((t) => have.has(t));
}

export type RelevanceVerdict =
  /** A confirmed service this client provides covers the term. */
  | "matched"
  /** Nothing confirmed covers it. The term is dropped. */
  | "unmatched"
  /** Nobody has confirmed a services list, so the question cannot be asked. */
  | "no_services_recorded";

export interface Relevance {
  verdict: RelevanceVerdict;
  /** The confirmed service that matched, verbatim. Null on every other verdict. */
  service: string | null;
  /**
   * A query that ALREADY CONVERTED on this ad account and is covered by the
   * same confirmed service. Where one exists it is the strongest evidence
   * there is: somebody searched it, clicked, and became a lead, which is proof
   * rather than inference that this client provides the thing. Null where the
   * account has no converting query under that service — which is not a mark
   * against the term, only a weaker sentence.
   */
  provenBy: string | null;
}

export const NO_SERVICES_RECORDED: Relevance =
  { verdict: "no_services_recorded", service: null, provenBy: null };

/**
 * A converting query on this account, for the proof half above.
 *
 * Only the primary conversion column, for `query-promotion.ts`'s reason: a
 * query converting on an action the account does not count is producing
 * something nobody here has decided is an outcome, and it proves nothing about
 * what the client sells.
 */
export interface ProvenQuery {
  term: string;
  conversions: number;
}

/**
 * Pure. One term, one verdict.
 *
 * The confirmed list is the GATE and the converting query is the
 * STRENGTHENER, never the other way round. A converting query on its own
 * cannot let a term through, because the whole list is refused when nothing is
 * confirmed (rule 2) and a single-term exception to that would be the
 * volume-only fallback under another name.
 */
export function relevanceOf(
  term: string,
  facts: ClientServiceFacts,
  proven: ProvenQuery[],
): Relevance {
  if (facts.services == null || facts.services.length === 0) return NO_SERVICES_RECORDED;
  const service = facts.services.find((s) => termCoversService(term, s.name));
  if (!service) return { verdict: "unmatched", service: null, provenBy: null };
  // The dearest proof first: the query with the most conversions under the
  // same service is the one worth naming.
  const hit = proven
    .filter((q) => termCoversService(q.term, service.name))
    .sort((a, b) => b.conversions - a.conversions)[0] ?? null;
  return { verdict: "matched", service: service.name, provenBy: hit ? hit.term : null };
}

/**
 * The sentence a gap row carries about why it is relevant.
 *
 * One clause, and it names the record rather than asserting relevance — "we
 * have this recorded as one of their services, confirmed by X" is checkable
 * and "this is relevant to their business" is not.
 */
export function relevanceLine(r: Relevance, facts: ClientServiceFacts): string {
  if (r.verdict !== "matched" || !r.service) return "";
  const who = facts.confirmedBy
    ? `confirmed by ${facts.confirmedBy}${facts.confirmedAt ? ` on ${facts.confirmedAt}` : ""}`
    : "confirmed on this account";
  const proof = r.provenBy
    ? ` The account already turns "${r.provenBy}" into enquiries, so this service sells here.`
    : "";
  return `Relevant because "${r.service}" is a recorded service for this client, ${who}.${proof}`;
}

/**
 * What the refusal says when nobody has confirmed a list.
 *
 * It names the figure that is missing and where to answer it, which is the
 * rule "a step that records a value has to offer somewhere to type it" read
 * the other way round: a reading that refuses for want of an answer has to say
 * where the answer goes.
 */
export function noServicesLine(facts: ClientServiceFacts): string {
  const waiting = facts.candidatesWaiting > 0
    ? ` ${facts.candidatesWaiting} candidate service(s) have been worked out from their own keyword targets, their converting queries and their campaign names, and are waiting to be ticked.`
    : "";
  return "Nothing on this client's record says what they actually sell, so there is no way to tell demand they are missing from demand they were never in. "
    + `Confirm their services on the client page and this reads on the next audit.${waiting}`;
}

/** Is this research idea something the client sells? */

/**
 * Pure. Facts in, one verdict per idea out. No imports, because this file is
 * copied byte for byte into the worker (bsllc-sync-worker/src/ads/
 * idea-relevance.ts) and `npm run verify:wiring` fails when the two drift. The
 * panel that shows which ideas were kept, the readings in this app and the
 * worker that stores a run have to judge an idea one way, or a card says
 * "27 kept" beside an audit that used 200.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The owner, on a run for Ohio Community Health: "Keyword research on OCH
 * (Oct 12, 10 service seeds) returned 200 ideas that are almost all off-topic
 * (sutter health, united health care, overactive bladder treatment, medicaid)
 * at national volumes. Keep only ideas that contain a seed or a signed-off
 * service term."
 *
 * The research provider's keyword ideas call is a SEMANTIC EXPANSION. Hand it
 * "mental health treatment" and it returns what people search around the topic,
 * ordered by volume, so the head of the list is the biggest names in the whole
 * health category: hospital systems, insurers, symptoms. It runs no test that
 * an idea has anything to do with the words it was given, and nothing here did
 * either. Every reader downstream then took the list as demand the client sells
 * into: an article for "overactive bladder treatment", a gap for "united health
 * care".
 *
 * ── THE RULE, IN ONE SENTENCE ──────────────────────────────────────────────
 *
 * AN IDEA IS KEPT ONLY IF IT CONTAINS EVERY WORD OF A SEED THE RUN WAS GIVEN OR
 * OF A SERVICE THE CLIENT'S OWN SIGNED-OFF LIST SAYS THEY OFFER.
 *
 * ── WHY THAT RULE, AND NOT A LOOSER OR A STRICTER ONE ──────────────────────
 *
 *  · EVERY WORD OF THE ANCHOR, in any order, with a plural folded. "drug and
 *    alcohol rehab" holds both words of "drug rehab", and "alcohol rehabs"
 *    holds "alcohol rehab". One word of a two-word anchor is not enough:
 *    "sutter health" shares "health" with "mental health treatment" and is
 *    nothing the client sells. This is the rule the worker's keyword-gap
 *    reading already applies to a service (`termCoversService`), widened by
 *    one plural fold, so the upstream gate can never be stricter than the
 *    reading after it.
 *  · A WORD OF THE ANCHOR, NOT A WORD OF THE IDEA, DECIDES. "Head noun plus one
 *    other word" was weighed and refused: the head noun of "mental health
 *    treatment" is "treatment", which every hospital's service line shares.
 *  · NO LIST OF INDUSTRY WORDS, BRANDS OR INSURERS ANYWHERE. A blocklist of
 *    "sutter" and "united" passes today and fails on the next client. The
 *    rule needs only what the account itself recorded.
 *  · A SINGLE-WORD ANCHOR STANDS ONLY IF IT WAS TYPED AS ONE WORD. "iop" and
 *    "detox" are real one-word seeds. "AC repair" reduces to "repair" once "AC"
 *    is too short to match on, and a lone "repair" would keep every repair in
 *    the country, so that anchor is unusable and is named.
 *  · MEDICAID-TYPE WORDS GET NO SPECIAL TREATMENT. "medicaid drug rehab" is
 *    kept because it holds "drug rehab". "Medicaid" on its own is not.
 *
 * ── WHAT IT NEVER DOES ─────────────────────────────────────────────────────
 *
 *  · NOTHING IS DELETED. An idea set aside is kept, flagged and counted, and a
 *    person can keep it. This only decides what a reading may treat as demand.
 *  · A NULL IS UNANSWERED. With no signed-off services the seeds alone are
 *    used, and the line says so. With neither, there is nothing to judge by,
 *    so every idea is kept and none is called checked.
 *  · NOTHING IS READ FROM A NAME, A TITLE OR A SENTENCE. The anchors are the
 *    seeds a person typed and the services a person signed off.
 *  · A PERSON'S ANSWER BEATS THE RULE, in both directions, for that idea.
 */

export const MIN_ANCHOR_WORD_LENGTH = 3;

/** Grammatical joining words and nothing else. A longer list would start
 *  dropping words that ARE the service ("near", "emergency"). */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "to", "with", "at", "on",
  "by", "my", "our", "your", "is", "are",
]);

/** Fold a plural. Conservative: "ies" becomes "y", a trailing "s" comes off
 *  unless the word ends "ss", "us" or "is", and nothing under four letters
 *  changes. No other stemming: "roof" and "roofing" stay different. */
export function foldWord(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Built at run time: a literal with the `u` flag is a compile error in a
 *  project that targets below ES2015, and this file is compiled by two. */
const NOT_A_WORD = new RegExp("[^\\p{L}\\p{N}]+", "gu");

/** Letters and digits, lowercased, split on everything else. */
function rawWords(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .replace(NOT_A_WORD, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);
}

/** An idea's words, plurals folded, joining words dropped. */
export function ideaWords(s: string): string[] {
  return rawWords(s).filter((t) => !STOP_WORDS.has(t)).map(foldWord);
}

/** The key a person's answer about an idea is stored under. Case, punctuation
 *  and spacing fold; nothing else does. */
export function ideaKey(s: string): string {
  return rawWords(s).join(" ");
}

export type AnchorSource = "seed" | "service" | "tracked";

export interface IdeaAnchor {
  phrase: string;
  source: AnchorSource;
  /** The significant words, folded. Never empty on a usable anchor. */
  words: string[];
}

export type AnchorFault = "no_words" | "too_short" | "reduced_to_one_word";

export interface UnusableAnchor {
  phrase: string;
  source: AnchorSource;
  fault: AnchorFault;
}

const ANCHOR_FAULT_LINE: Record<AnchorFault, string> = {
  no_words: "has no words in it",
  too_short: "is too short to match on",
  reduced_to_one_word: "reduces to one common word once its short words come off",
};

export interface AnchorSet {
  anchors: IdeaAnchor[];
  unusable: UnusableAnchor[];
  /** How many of each kind were given, before any were refused. */
  given: { seeds: number; services: number; tracked: number };
}

/**
 * The words an idea has to contain. `services` is the signed-off list of what
 * the client offers (null where nobody has signed one off). `tracked` is the
 * client's own tracking list, which only counts as an EXACT phrase: an idea
 * equal to a keyword a person chose to track is relevant on that record alone.
 */
export function buildAnchors(input: {
  seeds?: readonly string[] | null;
  services?: readonly string[] | null;
  tracked?: readonly string[] | null;
}): AnchorSet {
  const anchors: IdeaAnchor[] = [];
  const unusable: UnusableAnchor[] = [];
  const seen = new Set<string>();
  const add = (phrase: string, source: AnchorSource) => {
    const typed = rawWords(phrase);
    const key = `${source}:${typed.join(" ")}`;
    if (typed.length === 0) { unusable.push({ phrase, source, fault: "no_words" }); return; }
    if (seen.has(key)) return;
    seen.add(key);
    if (source === "tracked") {
      // An exact phrase: every typed word, so nothing is dropped from it.
      anchors.push({ phrase, source, words: typed.map(foldWord) });
      return;
    }
    const significant = ideaWords(phrase).filter((w) => w.length >= MIN_ANCHOR_WORD_LENGTH);
    if (significant.length === 0) { unusable.push({ phrase, source, fault: "too_short" }); return; }
    if (significant.length === 1 && typed.length > 1) { unusable.push({ phrase, source, fault: "reduced_to_one_word" }); return; }
    anchors.push({ phrase: phrase.trim(), source, words: Array.from(new Set(significant)) });
  };
  for (const s of input.seeds ?? []) add(String(s ?? ""), "seed");
  for (const s of input.services ?? []) add(String(s ?? ""), "service");
  for (const s of input.tracked ?? []) add(String(s ?? ""), "tracked");
  return {
    anchors,
    unusable,
    given: {
      seeds: (input.seeds ?? []).length,
      services: (input.services ?? []).length,
      tracked: (input.tracked ?? []).length,
    },
  };
}

export type IdeaFault =
  /** The idea contains no seed and no signed-off service. */
  | "no_anchor"
  /** The idea is empty. */
  | "blank"
  /** A person set it aside. */
  | "person";

export interface IdeaReview {
  decision: "keep" | "set_aside";
  by?: string | null;
  at?: string | null;
}

export interface IdeaVerdict {
  keyword: string;
  key: string;
  kept: boolean;
  /** The seed or service the idea contains, or null. */
  via: { phrase: string; source: AnchorSource } | null;
  why: IdeaFault | null;
  /** True when nothing could judge it, so it was kept unchecked. */
  unjudged: boolean;
  /** A person's answer, where there is one. */
  review: IdeaReview | null;
}

export type JudgingBasis =
  | "seeds_and_services"
  | "seeds_only"
  | "services_only"
  | "nothing_to_judge_by";

export interface IdeaCounts {
  total: number;
  kept: number;
  keptBySeed: number;
  keptByService: number;
  keptByTracked: number;
  keptByPerson: number;
  /** Kept with nothing to judge by. */
  keptUnchecked: number;
  setAside: number;
  noAnchor: number;
  byPerson: number;
  blank: number;
}

export interface IdeaJudgement {
  verdicts: IdeaVerdict[];
  counts: IdeaCounts;
  basis: JudgingBasis;
  anchors: AnchorSet;
  /** What was counted and what was used, in one sentence. */
  line: string;
  /** What the ideas were judged against, in one sentence. */
  basisLine: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** One idea against the anchors. The longest match leads, a service before a seed. */
function match(words: ReadonlySet<string>, key: string, anchors: readonly IdeaAnchor[]): IdeaAnchor | null {
  let best: IdeaAnchor | null = null;
  for (const a of anchors) {
    const hit = a.source === "tracked"
      ? ideaKey(a.phrase) === key
      : a.words.every((w) => words.has(w));
    if (!hit) continue;
    if (!best || a.words.length > best.words.length
      || (a.words.length === best.words.length && a.source === "service" && best.source !== "service")) {
      best = a;
    }
  }
  return best;
}

export function judgeIdeas(
  keywords: readonly string[],
  input: {
    seeds?: readonly string[] | null;
    services?: readonly string[] | null;
    tracked?: readonly string[] | null;
    /** A person's answers, by `ideaKey`. */
    reviews?: Readonly<Record<string, IdeaReview | undefined>> | null;
  },
): IdeaJudgement {
  const anchors = buildAnchors(input);
  const hasSeeds = anchors.anchors.some((a) => a.source === "seed");
  const hasServices = anchors.anchors.some((a) => a.source === "service");
  const usable = anchors.anchors.length > 0;
  const basis: JudgingBasis = hasSeeds && hasServices ? "seeds_and_services"
    : hasSeeds ? "seeds_only"
    : hasServices ? "services_only"
    : "nothing_to_judge_by";
  const unchecked = !usable;

  const counts: IdeaCounts = {
    total: keywords.length, kept: 0, keptBySeed: 0, keptByService: 0, keptByTracked: 0, keptByPerson: 0,
    keptUnchecked: 0, setAside: 0, noAnchor: 0, byPerson: 0, blank: 0,
  };
  const verdicts: IdeaVerdict[] = keywords.map((keyword) => {
    const key = ideaKey(keyword);
    const review = input.reviews?.[key] ?? null;
    const base = { keyword, key, review };
    if (!key) {
      counts.blank++; counts.setAside++;
      return { ...base, kept: false, via: null, why: "blank" as const, unjudged: false };
    }
    if (review?.decision === "set_aside") {
      counts.byPerson++; counts.setAside++;
      return { ...base, kept: false, via: null, why: "person" as const, unjudged: false };
    }
    if (review?.decision === "keep") {
      counts.kept++; counts.keptByPerson++;
      return { ...base, kept: true, via: null, why: null, unjudged: false };
    }
    if (unchecked) {
      counts.kept++; counts.keptUnchecked++;
      return { ...base, kept: true, via: null, why: null, unjudged: true };
    }
    const hit = match(new Set(ideaWords(keyword)), key, anchors.anchors);
    if (!hit) {
      counts.noAnchor++; counts.setAside++;
      return { ...base, kept: false, via: null, why: "no_anchor" as const, unjudged: false };
    }
    counts.kept++;
    if (hit.source === "seed") counts.keptBySeed++;
    else if (hit.source === "service") counts.keptByService++;
    else counts.keptByTracked++;
    return { ...base, kept: true, via: { phrase: hit.phrase, source: hit.source }, why: null, unjudged: false };
  });

  return { verdicts, counts, basis, anchors, line: ideaFilterLine(counts, basis), basisLine: judgingBasisLine(anchors, basis) };
}

/** "200 ideas read: 27 kept, 173 set aside. ..." */
export function ideaFilterLine(c: IdeaCounts, basis: JudgingBasis): string {
  if (c.total === 0) return "No ideas were stored for this run.";
  if (basis === "nothing_to_judge_by" && c.byPerson === 0 && c.keptByPerson === 0) {
    return `${plural(c.total, "idea")} read and none checked, because this run recorded no seeds and no services are signed off. All ${c.total.toLocaleString("en-US")} are kept.`;
  }
  const head = `${plural(c.total, "idea")} read: ${c.kept.toLocaleString("en-US")} kept, ${c.setAside.toLocaleString("en-US")} set aside.`;
  const kept: string[] = [];
  if (c.keptBySeed) kept.push(`${c.keptBySeed.toLocaleString("en-US")} contain a seed`);
  if (c.keptByService) kept.push(`${c.keptByService.toLocaleString("en-US")} contain a signed-off service`);
  if (c.keptByTracked) kept.push(`${c.keptByTracked.toLocaleString("en-US")} ${c.keptByTracked === 1 ? "is" : "are"} already tracked`);
  if (c.keptByPerson) kept.push(`${c.keptByPerson.toLocaleString("en-US")} ${c.keptByPerson === 1 ? "was" : "were"} kept by a person`);
  if (c.keptUnchecked) kept.push(`${c.keptUnchecked.toLocaleString("en-US")} could not be checked`);
  const aside: string[] = [];
  if (c.noAnchor) aside.push(`${c.noAnchor.toLocaleString("en-US")} contain no seed or signed-off service term`);
  if (c.byPerson) aside.push(`${c.byPerson.toLocaleString("en-US")} ${c.byPerson === 1 ? "was" : "were"} set aside by a person`);
  if (c.blank) aside.push(`${c.blank.toLocaleString("en-US")} ${c.blank === 1 ? "was" : "were"} blank`);
  return [
    head,
    kept.length ? `Kept: ${kept.join(", ")}.` : "",
    aside.length ? `Set aside: ${aside.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}

/** What the ideas were judged against. */
export function judgingBasisLine(a: AnchorSet, basis: JudgingBasis): string {
  const seeds = a.anchors.filter((x) => x.source === "seed").length;
  const services = a.anchors.filter((x) => x.source === "service").length;
  const refused = a.unusable.length
    ? ` ${plural(a.unusable.length, "phrase")} could not be used: ${a.unusable.slice(0, 3).map((u) => `"${u.phrase}" ${ANCHOR_FAULT_LINE[u.fault]}`).join("; ")}${a.unusable.length > 3 ? `; and ${a.unusable.length - 3} more` : ""}.`
    : "";
  switch (basis) {
    case "seeds_and_services":
      return `Judged against ${plural(seeds, "seed")} and ${plural(services, "signed-off service")}.${refused}`;
    case "seeds_only":
      return `No signed-off services list, so only the ${plural(seeds, "seed")} ${seeds === 1 ? "was" : "were"} used.${refused}`;
    case "services_only":
      return `This run recorded no seeds, so only the ${plural(services, "signed-off service")} ${services === 1 ? "was" : "were"} used.${refused}`;
    case "nothing_to_judge_by":
      return `Nothing to judge by: no usable seeds and no signed-off services.${refused}`;
  }
}

/** The one-line reason a set-aside idea carries in a list. */
export function ideaFaultLine(why: IdeaFault): string {
  switch (why) {
    case "no_anchor": return "Contains no seed or signed-off service term";
    case "person": return "Set aside by a person";
    case "blank": return "Blank";
  }
}

/** Where a kept idea came from, for its row. Null where it carries no reason. */
export function ideaViaLine(v: IdeaVerdict): string | null {
  if (v.review?.decision === "keep") return "Kept by a person";
  if (!v.via) return null;
  switch (v.via.source) {
    case "seed": return `Contains the seed "${v.via.phrase}"`;
    case "service": return `Contains the service "${v.via.phrase}"`;
    case "tracked": return "Already on the tracking list";
  }
}

/** What a reading says about the stored ideas it used. */
export function ideaUseLine(read: number, kept: number, checked = true): string | null {
  if (read <= 0) return null;
  if (!checked) return `${plural(read, "stored idea")} could not be checked, because no seeds or signed-off services were recorded, so all ${read === 1 ? "is" : "are"} used.`;
  if (kept === read) return `All ${plural(read, "stored idea")} contain a seed or signed-off service term.`;
  return `Used ${kept.toLocaleString("en-US")} of ${plural(read, "stored idea")}. ${(read - kept).toLocaleString("en-US")} contain no seed or signed-off service term and were set aside.`;
}

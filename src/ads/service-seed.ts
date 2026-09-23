/**
 * Whether a recorded service is any good as a keyword research seed.
 *
 * Pure. Facts in, one verdict and one sentence out.
 *
 * THE COPY LIVES IN THE APP at shared/service-seed.ts, and the app repo's
 * `npm run verify:wiring` fails when the two drift. The review where a person
 * ticks a service and the audit that researches from it have to agree about
 * which phrases are worth expanding, or a card marks a row weak while the
 * 06:30 Monday run seeds from it with nobody watching.
 *
 * The ask, verbatim, from the company owner: "I don't want to accept those
 * because keywords like day program won't do anything for our keywords when
 * not more tightly associated to the core services — in fact it will likely
 * burn spend, so that is not strategic, which is the whole goal of this tool."
 */

/** How much a recorded service can carry as a keyword research seed.
 *
 * ── THE DISTINCTION THIS WHOLE MODULE EXISTS TO HOLD ──────────────────────
 *
 * A SERVICE IS A FACT ABOUT THE CLIENT. A SEED IS A SEARCH SOMEBODY TYPES.
 * They are two different things and this system was treating them as one.
 * "Day program" is true about the client and useless as a seed, and recording
 * it is right while researching off it is what burns money.
 *
 * So nothing here refuses anything. A weak reading never stops a service being
 * recorded, never changes what a recorded service SUPPRESSES, and never marks
 * a row wrong. It decides one question and one only: may the keyword-gap rule
 * expand research from this phrase. A person can always tick it anyway, and the
 * row is kept with their name on it exactly as any other.
 *
 * ── THE FOUR THINGS IT LOOKS AT, AND WHY EACH ONE ─────────────────────────
 *
 *  1. STANDALONE MEANING. Does the phrase mean anything away from the line it
 *     was split out of. "Individual" and "day and evening" do not: the first
 *     is a word describing a noun the phrase never names, the second is two
 *     words joined for a sentence. This is decided on English alone — a
 *     coordination, an adjective suffix, a stranded connector — because those
 *     are facts about the language and hold on the next client as well as this
 *     one. It is the only dimension that needs nothing but the phrase.
 *
 *  2. A SUBJECT, NOT ONLY A SHAPE. A service phrase names the shape the work
 *     takes (a programme, a plan, a package) and what it is for (a condition,
 *     a product, a trade, a place). Research off the shape alone returns
 *     anybody's traffic. WHICH WORDS ARE SHAPE IS READ OFF THIS ACCOUNT'S OWN
 *     LIST and never off a list of industry words: a word this client uses
 *     across many of its own services is that client's container, whatever the
 *     trade. Below MIN_SIBLINGS_TO_READ_SHAPE recorded names there is nothing
 *     to measure and the dimension says so.
 *
 *  3. A BUYING SEARCH. Read only from keyword research already stored for this
 *     client, and only where the research carries this exact phrase. The
 *     research's own intent is the answer. Nothing is estimated, and where no
 *     research holds the phrase the dimension is unread and is named.
 *
 *  4. PROOF, WHICH ONLY EVER HELPS. A search the account already tracks or
 *     already turns into an enquiry, built on this phrase, is evidence somebody
 *     searches it. It can carry a phrase from unjudged to usable and it can
 *     never make one weak — the asymmetry every reading in this codebase uses.
 *
 * ── AND A PHRASE NOBODY CAN JUDGE IS NOT A BAD ONE ────────────────────────
 *
 * `unjudged` is a third answer and it seeds exactly as `usable` does. An
 * account with no research stored, a short list and no tracked terms produces
 * nothing but `unjudged`, which leaves the gap rule behaving as it did before
 * any of this existed. A null is unanswered. It is never a no.
 */

/** Where a phrase stands as a seed. `weak` is the only one that is skipped. */
export type SeedVerdict = "usable" | "weak" | "unjudged";

/** What is wrong with a phrase, in catalog order — strongest fault first. */
export type SeedFaultKey =
  /** Two services joined by a connector. */
  | "coordinated"
  /** One word that describes a thing the phrase never names. */
  | "bare_modifier"
  /** Opens or closes on a joining word, so it is part of a longer line. */
  | "dangling"
  /** Names the shape the work takes and nothing it is for. */
  | "no_subject"
  /** The client's own stored research reports it as a question. */
  | "asked_not_bought";

export interface SeedFault {
  key: SeedFaultKey;
  /** Two or three words, for the row. Differs per fault, so a list of rows
   *  never prints one mark down the whole column. */
  mark: string;
  /** One sentence, and it says what to DO. Read mid-review. */
  line: string;
  /** What the fault was measured from. A fault with no basis is not printed. */
  basis: string;
}

export interface SeedReading {
  verdict: SeedVerdict;
  /** Empty on every verdict but `weak`. */
  faults: SeedFault[];
  /** Phrases offered instead, built only out of words already on the record.
   *  Empty where nothing honest could be built. */
  better: string[];
  /** Where those phrases came from, or why none could be built. Null only
   *  where there is no fault to repair. */
  betterFrom: string | null;
  /** Why this one is usable. Null everywhere else. */
  proof: string | null;
  /** Dimensions that had nothing to read, named. Never a fault. */
  unread: string[];
}

export interface SeedResearchRow {
  keyword: string;
  /** informational / commercial / transactional / navigational, verbatim. */
  intent: string | null;
  /** Monthly searches. Null = not reported, never nought. */
  volume: number | null;
}

export interface SeedFacts {
  /** The service as somebody recorded it, case intact. */
  name: string;
  /** The line it was split out of, where a paste knows one. Null elsewhere. */
  from?: string | null;
  /** The other service names on this same account, as recorded. */
  siblings?: readonly string[];
  /** Searches this account already tracks or already wins enquiries on. */
  accountTerms?: readonly string[];
  /** Keyword research stored for this client. Null means none is stored. */
  research?: readonly SeedResearchRow[] | null;
}

/**
 * How many recorded names an account needs before one of its words can be
 * called a container. OURS. Under eight, one word appearing three times is an
 * accident of a short list, and calling it the account's shape would mark a
 * perfectly good phrase on a client whose list has barely started.
 */
export const MIN_SIBLINGS_TO_READ_SHAPE = 8;
/** …and how many of them a word has to appear in. OURS, and both floors apply:
 *  a count alone misreads a long list and a share alone misreads a short one. */
export const SHAPE_MIN_NAMES = 3;
export const SHAPE_MIN_SHARE = 0.15;

/**
 * Letters a word needs before it counts as naming a subject on its own.
 *
 * OURS, and it is a proxy rather than a measure: the commonest words in English
 * are the shortest, so a five-letter qualifier beside a container this account
 * uses everywhere is a word anybody could have written. It can only ever make a
 * phrase PASS, so where it is wrong it lets a broad phrase through, which is
 * the safe direction — a seed wrongly allowed costs one row somebody dismisses,
 * and a good service wrongly marked teaches people to tick past the marks.
 */
export const SUBJECT_MIN_LETTERS = 6;

/**
 * Said where the record holds nothing to build a phrase out of.
 *
 * ONE sentence for all three faults, because it is one fact: this system will
 * not invent a keyword and put it in the client's list. Three wordings of it
 * would print under each other on one card.
 */
export const SEED_NOTHING_TO_OFFER =
  "Nothing on the record gives a phrase to offer here, so it has to come from the client.";

/** Joining words. English, and the whole of the list. */
const CONNECTORS = new Set(["and", "or", "plus", "with", "including", "to", "of", "for", "in", "at", "by", "the", "a", "an"]);
/** The ones that join two things rather than hang off one. */
const COORDINATORS = new Set(["and", "or", "plus"]);
/**
 * Endings that make an English word describe something else.
 *
 * Morphology, not vocabulary. `-ing` is deliberately absent because it makes
 * nouns people really sell ("roofing", "welding", "landscaping"), and so are
 * `-ion`, `-ment`, `-ance` and `-ity` for the same reason.
 */
const MODIFIER_ENDINGS = ["ical", "ial", "ual", "able", "ible", "less", "ful", "ous", "ive", "ary", "ish", "al", "ic"];

/** Letters and digits, lowercased, split on everything else. */
function seedTokens(s: string): string[] {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

/** The phrase two names are compared on. */
function seedPhrase(s: string): string {
  return seedTokens(s).join(" ");
}

/** Does `haystack` carry `needle` as a whole run of words. */
function carriesRun(haystack: string, needle: string): boolean {
  const n = seedPhrase(needle);
  if (!n) return false;
  return ` ${seedPhrase(haystack)} `.includes(` ${n} `);
}

/** A word that describes, by its ending alone. */
function isModifierWord(w: string): boolean {
  if (w.length < 5) return false;
  return MODIFIER_ENDINGS.some((e) => w.endsWith(e));
}

/** The words this account uses across its own list. Empty where the list is
 *  too short for the question to mean anything. */
function shapeWordsOf(siblings: readonly string[], self: string): Set<string> | null {
  const out = new Set<string>();
  const mine = seedPhrase(self);
  const names = siblings.map(seedPhrase).filter((n) => n && n !== mine);
  if (names.length + 1 < MIN_SIBLINGS_TO_READ_SHAPE) return null;
  const counts = new Map<string, number>();
  for (const n of names) {
    for (const t of Array.from(new Set(n.split(" ")))) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  Array.from(counts.entries()).forEach(([t, n]) => {
    if (n >= SHAPE_MIN_NAMES && n / names.length >= SHAPE_MIN_SHARE) out.add(t);
  });
  return out;
}

/** A word the person capitalised inside a name they did not capitalise
 *  throughout. Their own orthography, and the one signal that tells a brand or
 *  a place from an ordinary word without a dictionary. Unavailable on a name
 *  this system title-cased, which is why it is one signal of several. */
function properNouns(name: string): Set<string> {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  if (words.length < 2) return out;
  const anyLower = words.some((w) => /^[a-z]/.test(w));
  if (!anyLower) return out;
  for (const w of words) {
    if (/^[A-Z]/.test(w)) for (const t of seedTokens(w)) out.add(t);
  }
  return out;
}

/** Split a phrase on a coordinator, at the top level. */
function splitOnCoordinator(tokens: readonly string[]): string[][] {
  const parts: string[][] = [[]];
  for (const t of tokens) {
    if (COORDINATORS.has(t)) { parts.push([]); continue; }
    parts[parts.length - 1]!.push(t);
  }
  return parts.filter((p) => p.length > 0);
}

/**
 * The pieces of the line this phrase was split out of.
 *
 * A bullet's leading marker and its own heading come off; what is left splits
 * on commas and semicolons, which is the same rule the paste itself used to
 * produce the pieces. It is only ever read to RECOVER the client's own words,
 * never to judge them.
 */
function bulletPieces(from: string | null | undefined): string[] {
  if (!from) return [];
  let line = String(from).trim().replace(/^\s*(?:[*•–—-]|\d+[.)])\s+/, "");
  const colon = line.indexOf(":");
  if (colon >= 0 && !line.slice(0, colon).includes("(")) line = line.slice(colon + 1);
  return line.split(/[,;]/).map((p) => p.replace(/\([^)]*\)/g, " ").trim()).filter(Boolean);
}

/** The head a list of pieces shares — the last word of the last piece that has
 *  more words than the piece being repaired. Null where no piece does. */
function sharedHead(pieces: readonly string[], selfTokens: readonly string[]): string | null {
  for (let i = pieces.length - 1; i >= 0; i--) {
    const t = seedTokens(pieces[i]!);
    if (t.length > selfTokens.length && t[t.length - 1]) return t[t.length - 1]!;
  }
  return null;
}

/** Title case on the words a person reads. The offered phrase sits in the
 *  same column as names somebody typed, so it is written the same way. */
function tidy(words: readonly string[]): string {
  return words.filter(Boolean)
    .map((w) => (w.length <= 2 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ").trim();
}

/**
 * Pure. One recorded service, and whatever the record holds about it.
 *
 * The faults are gathered in catalog order and the verdict is the worst of
 * them. Proof is read last and only reaches a phrase with no fault at all,
 * because a search somebody makes is not an argument that a fragment is a
 * phrase.
 */
export function seedReading(f: SeedFacts): SeedReading {
  const tokens = seedTokens(f.name);
  const none: SeedReading = {
    verdict: "unjudged", faults: [], better: [], betterFrom: null, proof: null, unread: [],
  };
  if (tokens.length === 0) return none;

  const faults: SeedFault[] = [];
  let better: string[] = [];
  let betterFrom: string | null = null;
  const unread: string[] = [];

  // ── 1. Does it mean anything on its own ────────────────────────────────
  const inner = tokens.slice(1, Math.max(1, tokens.length - 1));
  const coordinated = inner.some((t) => COORDINATORS.has(t));
  if (coordinated) {
    const parts = splitOnCoordinator(tokens);
    const head = parts.length > 1 ? parts[parts.length - 1]![parts[parts.length - 1]!.length - 1]! : null;
    const longest = Math.max(...parts.map((p) => p.length));
    if (head && parts.some((p) => p.length < longest)) {
      better = parts.map((p) => tidy(p[p.length - 1] === head ? p : [...p, head]));
      betterFrom = "Split out of the phrase you recorded.";
    } else {
      betterFrom = SEED_NOTHING_TO_OFFER;
    }
    faults.push({
      key: "coordinated",
      mark: "two in one",
      // ONE SENTENCE PER FAULT, whatever the row. A card with four coordinated
      // rows prints this once: the second and later rows carry only the mark.
      line: "Record these as separate services. Research treats the whole phrase as one search and finds nobody typing it.",
      basis: `Joined by "${inner.find((t) => COORDINATORS.has(t))}".`,
    });
  }

  if (!coordinated && tokens.length === 1 && isModifierWord(tokens[0]!)) {
    const head = sharedHead(bulletPieces(f.from), tokens);
    if (head) {
      better = [tidy([tokens[0]!, head])];
      betterFrom = "Taken from the rest of the line you pasted.";
    } else {
      betterFrom = SEED_NOTHING_TO_OFFER;
    }
    const ending = MODIFIER_ENDINGS.find((e) => tokens[0]!.endsWith(e))!;
    faults.push({
      key: "bare_modifier",
      mark: "no noun",
      line: "Add the noun it belongs to. On its own it matches any sentence carrying the word.",
      basis: `One word, ending "-${ending}".`,
    });
  }

  if (CONNECTORS.has(tokens[0]!) || CONNECTORS.has(tokens[tokens.length - 1]!)) {
    faults.push({
      key: "dangling",
      mark: "half a phrase",
      line: `Finish it. It opens or closes on a joining word, so part of the line it came from is missing.`,
      basis: `Starts or ends on "${CONNECTORS.has(tokens[0]!) ? tokens[0] : tokens[tokens.length - 1]}".`,
    });
  }

  // ── 2. A subject, read off this account's own list ─────────────────────
  const siblings = f.siblings ?? [];
  const shape = shapeWordsOf(siblings, f.name);
  const accountTerms = f.accountTerms ?? [];
  if (shape == null) {
    unread.push(`This account has ${siblings.length} other recorded service${siblings.length === 1 ? "" : "s"}, which is too few to say which words it uses for everything.`);
  } else if (!coordinated && tokens.length >= 2) {
    // ONE WORD IS EXEMPT, and deliberately. A single word that recurs through
    // the account's own list is that account's subject and not its container —
    // "Roofing" on a roofer is the answer, however many of their other services
    // carry it. The fault is a qualifier that says nothing beside a container,
    // and a phrase of one word has no qualifier to fault.
    const head = tokens[tokens.length - 1]!;
    const proper = properNouns(f.name);
    const subject = tokens.find((t) =>
      proper.has(t)
      || accountTerms.some((a) => seedTokens(a).includes(t))
      || (!shape.has(t) && t.length >= SUBJECT_MIN_LETTERS));
    if (shape.has(head) && !subject) {
      const pick = subjectWordFrom(accountTerms, tokens, shape);
      if (pick) {
        better = [tidy([pick, ...tokens])];
        betterFrom = "Built from a search this account already tracks.";
      } else if (!betterFrom) {
        betterFrom = SEED_NOTHING_TO_OFFER;
      }
      faults.push({
        key: "no_subject",
        mark: "shape only",
        line: "Say what the work treats or sells. Research off this returns whoever else runs one.",
        basis: `"${head}" runs through this account's own list, and nothing else here names a subject.`,
      });
    }
  }

  // ── 3. A buying search, from stored research only ──────────────────────
  const research = f.research;
  if (research == null) {
    unread.push("No keyword research is stored for this client, so nothing here says whether anybody searches this.");
  } else {
    const me = seedPhrase(f.name);
    const row = research.find((r) => seedPhrase(r.keyword) === me);
    const intent = (row?.intent ?? "").toLowerCase();
    if (!row) {
      unread.push("The stored research does not carry this phrase, so its intent was not read.");
    } else if (intent === "informational" || intent === "navigational") {
      faults.push({
        key: "asked_not_bought",
        mark: "a question",
        line: `Seed from what a buyer types instead. People search this to read about it.`,
        basis: `The stored research reports "${row.keyword}" as ${intent}${row.volume != null ? `, at ${row.volume.toLocaleString()} searches a month` : ""}.`,
      });
    }
  }

  if (faults.length) {
    return { verdict: "weak", faults, better, betterFrom, proof: null, unread };
  }

  // ── 4. Proof, which only ever helps ────────────────────────────────────
  const tracked = accountTerms.find((a) => carriesRun(a, f.name) && seedTokens(a).length > tokens.length);
  if (tracked) {
    return { ...none, verdict: "usable", unread, proof: `This account already tracks "${tracked}".` };
  }
  const bought = (research ?? []).find((r) => {
    const intent = (r.intent ?? "").toLowerCase();
    return (intent === "commercial" || intent === "transactional") && carriesRun(r.keyword, f.name);
  });
  if (bought) {
    return {
      ...none, verdict: "usable", unread,
      proof: `The stored research reports "${bought.keyword}" as a ${(bought.intent ?? "").toLowerCase()} search.`,
    };
  }
  return { ...none, unread };
}

/** The word offered to qualify a shape-only phrase: the one this account
 *  tracks most, long enough to name a subject, and not already in the phrase.
 *  Null where the account tracks nothing that would do — and then nothing is
 *  offered, because a keyword invented here would be presented as the
 *  client's own. */
function subjectWordFrom(
  accountTerms: readonly string[],
  tokens: readonly string[],
  shape: ReadonlySet<string>,
): string | null {
  const have = new Set(tokens);
  const counts = new Map<string, number>();
  for (const a of accountTerms) {
    for (const t of Array.from(new Set(seedTokens(a)))) {
      if (have.has(t) || shape.has(t) || t.length < SUBJECT_MIN_LETTERS) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestN = 0;
  Array.from(counts.entries()).forEach(([t, n]) => { if (n > bestN) { best = t; bestN = n; } });
  return best;
}

/** Said ONCE above the list, with each row carrying its own short mark. The
 *  same shape the too-long rule already uses: four rows each repeating one
 *  sentence is wallpaper. */
export function seedWeakLine(n: number): string {
  return n === 1
    ? "One of these is too broad to research from, and none is ticked."
    : `${n} of these are too broad to research from, and none is ticked.`;
}

/** What a mark means, said once under the count. It is the distinction the
 *  whole module holds: recording and researching are two different acts. */
export const SEED_RECORDED_ANYWAY =
  "Tick one and it is recorded as a service with your name on it. Keyword research is seeded from the rest.";

/** Worker-side wrapper — everything above is the copied rule ────────────────
 *
 * `npm run verify:wiring` in the app repo compares the region above against
 * shared/service-seed.ts and fails on the first line that differs.
 */

/** One service the gap rule will not research from, and why. */
export interface SkippedSeed {
  service: string;
  mark: string;
  line: string;
  basis: string;
}

/**
 * Which recorded services may seed keyword research.
 *
 * A `weak` phrase is skipped HERE and nowhere else: it stays a recorded
 * service, it still suppresses what a recorded service suppresses, and the
 * only thing it loses is the right to expand research. `unjudged` seeds
 * exactly as `usable` does, so an account with nothing to judge it on behaves
 * as it did before this existed.
 */
export function splitSeeds(
  services: ReadonlyArray<{ name: string }>,
  context: { accountTerms?: readonly string[]; research?: readonly SeedResearchRow[] | null },
): { seeds: string[]; skipped: SkippedSeed[] } {
  const names = services.map((s) => s.name);
  const seeds: string[] = [];
  const skipped: SkippedSeed[] = [];
  for (const s of services) {
    const r = seedReading({
      name: s.name,
      siblings: names.filter((n) => n !== s.name),
      accountTerms: context.accountTerms ?? [],
      research: context.research ?? null,
    });
    if (r.verdict !== "weak" || r.faults.length === 0) { seeds.push(s.name); continue; }
    const first = r.faults[0]!;
    skipped.push({ service: s.name, mark: first.mark, line: first.line, basis: first.basis });
  }
  return { seeds, skipped };
}

/** What the run prints, and what the queue says, about the ones it skipped.
 *  Each is named: a seed dropped silently is the failure this repo names
 *  everywhere else. */
export function skippedSeedsLine(skipped: readonly SkippedSeed[]): string | null {
  if (!skipped.length) return null;
  const named = skipped.slice(0, 4).map((s) => `"${s.service}" (${s.mark})`).join(", ");
  const rest = skipped.length - Math.min(4, skipped.length);
  return `${skipped.length} recorded service${skipped.length === 1 ? " is" : "s are"} too broad to research from, so nothing was expanded out of ${skipped.length === 1 ? "it" : "them"}: ${named}${rest > 0 ? `, and ${rest} more` : ""}.`;
}

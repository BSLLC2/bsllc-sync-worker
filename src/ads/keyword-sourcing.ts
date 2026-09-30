/**
 * Where a keyword comes from, and whether it is a search somebody buys on.
 *
 * Pure. Facts in, one reading out. No database, no clock, no network.
 *
 * ── THE COPY, AND WHICH WAY ROUND IT GOES ─────────────────────────────────
 *
 * The rule was written in the dashboard, where a person reads a seed box on a
 * client's research panel, and this repo holds the copy because the
 * keyword-gap rule seeds from it. The repos cannot import from each other, so
 * `npm run verify:wiring` in the app compares the region below against
 * shared/keyword-sourcing.ts and fails on the first line that differs — the
 * same arrangement `service-seed.ts` and `lead-cadence.ts` have.
 *
 * A panel ordering seeds one way beside a Monday-morning audit ordering them
 * another is worse than either being wrong on its own.
 *
 * The import below is the ONE line that differs between the two files (this
 * one needs a `.js` specifier), which is why it sits outside the region.
 *
 * THE ASK IT ANSWERS, and the two faults, are written out in full in the
 * dashboard's copy of this file.
 */
import { seedReading } from "./service-seed.js";

/** Where in the buying funnel a search sits.
 *
 * ── WHY FOUR AND NOT THREE ────────────────────────────────────────────────
 *
 * `unjudged` is the fourth, and it is the whole of rule 4 above. The research
 * does not label every row, and most phrases carry no modifier at all — so the
 * honest answer for those is that nobody can say, not that they are people
 * reading up on the subject. `funnelStage` in shared/schema.ts defaults an
 * unlabelled phrase to MOFU, which is a guess wearing the clothes of a
 * reading; this returns `unjudged` and keeps the term.
 *
 * ── NAVIGATIONAL ──────────────────────────────────────────────────────────
 *
 * A navigational search is somebody typing a brand name, which is not a rung
 * of the funnel at all. It lands in `tofu` because that is the band that gets
 * set aside and it is the right side of the line — but the BASIS says what it
 * actually is, so nobody reads "top of funnel" and thinks somebody was reading
 * an explainer. `service-seed.ts` already treats the two together for its own
 * `asked_not_bought` fault, and this follows that rather than inventing a
 * fifth band no other reader knows.
 */
export type FunnelBand = "bofu" | "mofu" | "tofu" | "unjudged";

/** Order a list is read in. Lower first. `unjudged` sits between what is known
 *  to convert and what is known not to — it is not evidence either way, so it
 *  is neither led with nor buried. */
export const BAND_RANK: Record<FunnelBand, number> = { bofu: 0, mofu: 1, unjudged: 2, tofu: 3 };

/** Two or three words, for a row. Differs per band, so a list never prints one
 *  mark down the whole column. */
export const BAND_LABEL: Record<FunnelBand, string> = {
  bofu: "ready to buy",
  mofu: "comparing",
  tofu: "reading up",
  unjudged: "not judged",
};

/** The bands whose terms are fed into a campaign. `unjudged` is here because a
 *  null is unanswered: setting aside everything nobody labelled would quietly
 *  make an unreported intent mean "informational". */
export const BANDS_KEPT: readonly FunnelBand[] = ["bofu", "mofu", "unjudged"];

export interface BandReading {
  band: FunnelBand;
  /** What decided it, in one clause. Never empty — a band with no basis is a
   *  verdict nobody can check. */
  basis: string;
}

/**
 * Buying language. Structural English about the ACT of buying — a price, a
 * place, a booking — and not one word of any trade's vocabulary.
 *
 * Matched as WHOLE RUNS OF WORDS, so "cost" does not fire inside "costume" and
 * "order" does not fire inside "disorder".
 */
const BUYING = [
  "near me", "nearby", "near by", "in my area",
  "cost", "costs", "how much", "price", "prices", "pricing",
  "quote", "quotes", "estimate", "estimates",
  "buy", "purchase", "order", "hire", "book", "booking", "appointment",
  "for sale", "cheap", "cheapest", "affordable", "discount", "deals",
];

/** Comparison language: somebody has a shortlist and has not chosen yet. */
const COMPARING = [
  "best", "top", "vs", "versus", "compare", "comparison", "comparing",
  "review", "reviews", "rated", "rating", "ratings",
  "alternative", "alternatives", "pros and cons", "which",
];

/**
 * Learning language.
 *
 * Every entry is a question word or a word for a document somebody reads.
 * "how much" is deliberately NOT here and IS in BUYING: it asks a price.
 */
const LEARNING = [
  "what is", "what are", "what does", "how to", "how do", "how does",
  "why", "why is", "why do", "when to", "when should",
  "guide", "guides", "tips", "ideas", "examples", "example",
  "meaning", "definition", "define", "learn", "learning", "explained",
  "checklist", "template", "templates", "statistics", "history", "types of",
];

/** Letters and digits, lowercased, split on everything else. The repo's own
 *  normalisation — it folds case, punctuation and spacing, none of which
 *  changes meaning. */
function words(s: string): string[] {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

/** The phrase two keywords are compared on. */
export function keywordPhrase(s: string): string {
  return words(s).join(" ");
}

/** Does `haystack` carry `needle` as a whole run of words. */
function carriesRun(haystack: string, needle: string): boolean {
  const n = keywordPhrase(needle);
  if (!n) return false;
  return ` ${keywordPhrase(haystack)} `.includes(` ${n} `);
}

/** The first entry of `list` the phrase carries, or null. */
function firstMarker(keyword: string, list: readonly string[]): string | null {
  for (const m of list) if (carriesRun(keyword, m)) return m;
  return null;
}

/**
 * Pure. One keyword and whatever the research said about it → where it sits.
 *
 * ── THE ORDER IS THE ASYMMETRY, AND IT IS THE POINT ───────────────────────
 *
 * A buying marker is read BEFORE any recorded intent, which means a modifier
 * can lift a phrase OUT of the band that gets set aside and can never push one
 * INTO it. That direction is deliberate, and it is the same trade
 * `SUBJECT_MIN_LETTERS` states in `service-seed.ts`: a term wrongly set aside
 * costs a real opportunity nobody ever sees again, and a term wrongly kept
 * costs one row somebody scrolls past. The research labels "x cost" and "how
 * much does x cost" informational often enough that reading its label first
 * would throw away the clearest buying searches on the pull.
 *
 * Everywhere else the recorded answer leads, because everywhere else it is the
 * only evidence there is.
 */
export function bandOf(keyword: string, intent: string | null | undefined): BandReading {
  const kw = String(keyword ?? "");
  const label = String(intent ?? "").trim().toLowerCase();

  const buying = firstMarker(kw, BUYING);
  if (buying) return { band: "bofu", basis: `"${buying}" is somebody asking what it costs or where to get it.` };

  if (label === "transactional") return { band: "bofu", basis: "The research reports it as a transactional search." };

  const comparing = firstMarker(kw, COMPARING);
  if (label === "commercial") {
    return comparing
      ? { band: "mofu", basis: `The research reports it as a commercial search, and "${comparing}" is somebody still choosing.` }
      : { band: "bofu", basis: "The research reports it as a commercial search." };
  }
  if (comparing) return { band: "mofu", basis: `"${comparing}" is somebody weighing up options.` };

  if (label === "informational") return { band: "tofu", basis: "The research reports it as an informational search." };
  if (label === "navigational") {
    return { band: "tofu", basis: "The research reports it as a navigational search — somebody typing a name to get somewhere, not to buy." };
  }

  const learning = firstMarker(kw, LEARNING);
  if (learning) return { band: "tofu", basis: `"${learning}" is somebody reading up on it.` };

  return {
    band: "unjudged",
    basis: "The research reported no intent for this and the phrase says nothing either way, so nothing here can place it.",
  };
}

/** Where a seed or a term came from. A person's recorded answer, or an
 *  expansion of one. */
export type KeywordSource = "target" | "service" | "research";

/** Rendered on a row so nobody has to guess. Each says what the RECORD holds,
 *  never how good it is. */
export const SOURCE_LABEL: Record<KeywordSource, string> = {
  target: "on their keyword list",
  service: "from a recorded service",
  research: "from the research",
};

/** Read first to last. A person's own list leads, a service name follows, and
 *  an expansion of either comes last — which is the whole of fault (a). */
export const SOURCE_RANK: Record<KeywordSource, number> = { target: 0, service: 1, research: 2 };

/** One keyword on the client's own tracked list, as recorded. */
export interface RecordedTarget {
  keyword: string;
  /** Somebody's grouping label. Free text, often null. Carried, never read. */
  tag?: string | null;
  /** 'core' counts toward the aggregate rank metrics; 'baseline' is tracked
   *  and held out of them. BOTH are a recorded target — the distinction is
   *  about what may be CLAIMED, not about whether somebody chose the term. */
  reportStatus?: string | null;
}

/** One seed, and where it came from. */
export interface PlannedSeed {
  phrase: string;
  source: Extract<KeywordSource, "target" | "service">;
  band: FunnelBand;
  bandBasis: string;
}

/** One recorded service the research will not be expanded from, and why. The
 *  shape `splitSeeds` already hands back — kept identical so one reader can
 *  print either. */
export interface HeldSeed {
  service: string;
  mark: string;
  line: string;
  basis: string;
}

export interface SeedPlanFacts {
  /** The client's own recorded keyword targets, in their recorded order.
   *  NULL MEANS NOBODY LOOKED — a client with an empty list and a client whose
   *  list was never read are two different answers and the plan says which. */
  targets: readonly RecordedTarget[] | null;
  /** Confirmed services, as recorded. Null where nobody has confirmed a list. */
  services: readonly { name: string }[] | null;
  /** Searches this account already turns into enquiries. Feeds
   *  `service-seed`'s proof half, which is otherwise unread. */
  accountTerms?: readonly string[];
  /** Stored keyword research, so a seed's own intent can be read. Null where
   *  none is stored. */
  research?: readonly { keyword: string; intent: string | null; volume: number | null }[] | null;
}

export interface SeedPlan {
  /** Recorded targets first, then services, each band-ordered within its
   *  source. Nothing here was invented. */
  seeds: PlannedSeed[];
  /** Services `service-seed.ts` marked too broad to research from. Untouched
   *  on the record, and named. */
  heldBack: HeldSeed[];
  targetSeeds: number;
  serviceSeeds: number;
  /** Services dropped because a recorded target already says the same phrase.
   *  Counted, so the two figures above add up on screen. */
  duplicateServices: number;
  /** Null where the target list was read. Set where it was not — and it is a
   *  different sentence from an empty list. */
  targetsUnread: string | null;
}

/**
 * Pure. What to research, in the order the record justifies.
 *
 * ── WHY A TARGET IS NOT PUT THROUGH `seedReading` ─────────────────────────
 *
 * That rule answers one question: is this SERVICE NAME any good as a SEARCH.
 * It exists because a service is a fact about the client and a seed is
 * something somebody types, and the two were being treated as one. A recorded
 * target is already the second thing — a person read a research pull, or their
 * own site, and put that phrase on a rank-tracking list. Marking it "shape
 * only" would be this system telling somebody their own answer is not a
 * search, which is the one thing rule 2 above forbids.
 */
export function planSeeds(f: SeedPlanFacts): SeedPlan {
  const research = f.research ?? null;
  const intentOf = (phrase: string): string | null => {
    if (!research) return null;
    const me = keywordPhrase(phrase);
    return research.find((r) => keywordPhrase(r.keyword) === me)?.intent ?? null;
  };

  const seen = new Set<string>();
  const targetSeeds: PlannedSeed[] = [];
  for (const t of f.targets ?? []) {
    const phrase = String(t.keyword ?? "").trim();
    const key = keywordPhrase(phrase);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const b = bandOf(phrase, intentOf(phrase));
    targetSeeds.push({ phrase, source: "target", band: b.band, bandBasis: b.basis });
  }

  const heldBack: HeldSeed[] = [];
  const serviceSeeds: PlannedSeed[] = [];
  let duplicateServices = 0;
  const names = (f.services ?? []).map((s) => s.name);
  for (const s of f.services ?? []) {
    const phrase = String(s.name ?? "").trim();
    const key = keywordPhrase(phrase);
    if (!key) continue;
    if (seen.has(key)) { duplicateServices += 1; continue; }
    const r = seedReading({
      name: phrase,
      siblings: names.filter((n) => n !== phrase),
      accountTerms: f.accountTerms ?? [],
      research: research ? research.map((x) => ({ keyword: x.keyword, intent: x.intent, volume: x.volume })) : null,
    });
    if (r.verdict === "weak" && r.faults.length > 0) {
      const first = r.faults[0]!;
      heldBack.push({ service: phrase, mark: first.mark, line: first.line, basis: first.basis });
      continue;
    }
    seen.add(key);
    const b = bandOf(phrase, intentOf(phrase));
    serviceSeeds.push({ phrase, source: "service", band: b.band, bandBasis: b.basis });
  }

  // BAND ORDER WITHIN A SOURCE, NEVER ACROSS ONE. A recorded target that reads
  // as top of funnel still comes before every service name, because the source
  // is the record and the band is this system's reading of it.
  const byBand = (a: PlannedSeed, b: PlannedSeed) => BAND_RANK[a.band] - BAND_RANK[b.band];
  targetSeeds.sort(byBand);
  serviceSeeds.sort(byBand);

  return {
    seeds: [...targetSeeds, ...serviceSeeds],
    heldBack,
    targetSeeds: targetSeeds.length,
    serviceSeeds: serviceSeeds.length,
    duplicateServices,
    targetsUnread: f.targets == null
      ? "This client's own keyword list was not read this run, so nothing here can say whether one exists."
      : null,
  };
}

/**
 * What the plan seeded from, in one sentence.
 *
 * It names the SOURCES and their counts and nothing else: which phrases were
 * used is the list itself, one line down, and saying it twice is the stacking
 * every copy guard in this repo exists to catch.
 */
export function seedSourceLine(p: SeedPlan): string | null {
  if (p.seeds.length === 0) return null;
  const bits: string[] = [];
  if (p.targetSeeds > 0) {
    bits.push(`${p.targetSeeds} from the keyword${p.targetSeeds === 1 ? "" : "s"} already on this client's own list`);
  }
  if (p.serviceSeeds > 0) {
    bits.push(`${p.serviceSeeds} from a service somebody recorded`);
  }
  const lead = p.targetSeeds > 0
    ? "Their own list came first and the research was expanded around it"
    : "Nothing is on their keyword list, so this started from what somebody recorded that they sell";
  return `${lead}: ${bits.join(", ")}.`;
}

/**
 * Said where a client's keyword list is empty.
 *
 * AN EMPTY LIST IS AN ANSWER AND AN UNREAD ONE IS NOT, which is why this is a
 * different sentence from `targetsUnread` and why neither is ever printed in
 * place of the other.
 */
export const NO_TARGETS_RECORDED =
  "Nobody has put a keyword on this client's tracking list, so there was no chosen list to start from and every phrase here came from what they sell.";

/**
 * What was set aside, and what it would have added.
 *
 * ONE sentence above a list, never a clause on every row — the rows carry
 * their own two-word mark. It gives the count AND the searches, because "we
 * left some out" with no size on it reads as either nothing or everything.
 */
export function tofuSetAsideLine(count: number, volume: number | null): string | null {
  if (count <= 0) return null;
  const size = volume != null && volume > 0
    ? ` They come to ${volume.toLocaleString()} searches a month between them`
    : " None of them carries a reported search volume";
  return `${count} term${count === 1 ? " is" : "s are"} people reading up rather than buying, so ${count === 1 ? "it is" : "they are"} left out of this.`
    + `${size} — still researched, still on the record, and worth a page rather than a bid.`;
}

/**
 * Said where a person's own recorded target reads as top of funnel and is kept
 * anyway.
 *
 * The count alone would look like an oversight. This says it was a decision
 * and whose.
 */
export function keptOwnTargetsLine(count: number): string | null {
  if (count <= 0) return null;
  return `${count} of these read as people reading up rather than buying, and ${count === 1 ? "it is" : "they are"} kept because somebody here put ${count === 1 ? "it" : "them"} on this client's list on purpose.`;
}

/** Worker-side wrapper — everything above is the copied rule ────────────────
 *
 * `npm run verify:wiring` in the app repo compares the region above against
 * shared/keyword-sourcing.ts and fails on the first line that differs.
 */

/** One term on a gap row, and where it came from.
 *
 * `source` is the whole of fault (a) made visible: a term the client's own
 * keyword list already holds reads differently from one the research turned
 * up, and a reader should never have to guess which they are looking at. */
export interface SourcedKeyword {
  keyword: string;
  source: KeywordSource;
  band: FunnelBand;
  bandBasis: string;
}

/**
 * Which of a client's recorded targets the account is not bidding on.
 *
 * This is a lookup, not a judgement: it takes the phrases and the set the
 * caller has already worked out is covered. It exists here so the gap rule and
 * anything else that asks the question agree about what "on their own list"
 * means, which is `keywordPhrase` and nothing else.
 */
export function uncoveredTargets(
  targets: readonly RecordedTarget[] | null | undefined,
  isCovered: (phrase: string) => boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of targets ?? []) {
    const phrase = String(t.keyword ?? "").trim();
    const key = keywordPhrase(phrase);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!isCovered(key)) out.push(phrase);
  }
  return out;
}

/**
 * What the run and the row say about a client's own list going unbid.
 *
 * NAMED, NEVER COUNTED ONLY. The count on its own is a number nobody can act
 * on; four phrases and a remainder is a list somebody can read down.
 */
export function uncoveredTargetsLine(phrases: readonly string[]): string | null {
  if (!phrases.length) return null;
  const named = phrases.slice(0, 4).map((p) => `"${p}"`).join(", ");
  const rest = phrases.length - Math.min(4, phrases.length);
  return `${phrases.length} keyword${phrases.length === 1 ? "" : "s"} already on this client's own tracking list ${phrases.length === 1 ? "is" : "are"} in no keyword this account can serve today: `
    + `${named}${rest > 0 ? `, and ${rest} more` : ""}. Somebody chose ${phrases.length === 1 ? "it" : "them"} for this client already, so ${phrases.length === 1 ? "it is" : "they are"} named whatever the research reports about ${phrases.length === 1 ? "it" : "them"}.`;
}

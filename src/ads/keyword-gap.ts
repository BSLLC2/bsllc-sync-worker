/**
 * Demand this client sells into that no campaign is bidding on at all.
 *
 * Pure. Facts in, one reading out.
 *
 * ── WHY THIS IS A DIFFERENT KIND OF RULE ──────────────────────────────────
 *
 * Every other rule in this engine reads what is ALREADY INSIDE the ad account.
 * A query only reaches the search-terms report because a keyword already bid
 * on something that matched it, so the engine is bounded by the account's
 * current shape: it can say spend more on what works, stop what does not, and
 * bid properly on what was discovered by accident, and it can never say "this
 * whole category is uncovered".
 *
 * This is the one reading that comes from outside. It is built on the keyword
 * research this agency already runs — DataForSEO Labs, through the worker's
 * own `run-research` job, written into `research_requests.result_json` as
 * DiscoveryKeyword rows. NOTHING HERE CALLS A THIRD PARTY: the research was
 * pulled by that job, on a person's instruction, and this reads what it
 * stored.
 *
 * ── WHAT IT REFUSES TO CLAIM ──────────────────────────────────────────────
 *
 *  1. RELEVANCE IS A RECORDED ANSWER, NEVER A GUESS. See
 *     `service-relevance.ts`. A term is in this reading because a confirmed
 *     service of this client's covers it, and for no other reason. Volume is
 *     not relevance: ten thousand searches for something they do not sell is
 *     ten thousand searches of noise.
 *  2. ABSENCE IS PROVED, NOT ASSUMED — as far as it can be, and the limit is
 *     stated. Three things are checked: the term is in no keyword the account
 *     can serve today; it has not appeared in ninety days of search terms; and
 *     it is not blocked by a negative somebody added on purpose. A keyword in
 *     a paused ad group does not count as covering the term, because nobody is
 *     bidding through it. What CANNOT be
 *     established is whether a broad-match keyword would match it, because
 *     Google's matching is semantic and unpublished. So the row says the term
 *     has not been SEEN rather than that it cannot be reached, and where the
 *     account's own search-term coverage is thin the row says the absence is
 *     weaker evidence — which is `spendVisibility` composed rather than a
 *     second opinion about the same thing.
 *  3. NO CAMPAIGN IS PROPOSED AND NO API CHANGE IS OFFERED. Building for
 *     uncovered demand means a campaign or an ad group, which is a judgement
 *     about structure, budget, copy and a landing page. None of that is
 *     mechanical, none of it is in the guarded operation list, and
 *     `src/apply-ads-changes.ts` is untouched. `applicability: "vendor"`.
 *  4. A NULL IS UNANSWERED. No research stored for a client is no reading,
 *     named — never an empty gap list, which on screen reads as "nothing
 *     missing" and is the opposite of the truth.
 *  5. A RECORDED SERVICE IS NOT AUTOMATICALLY A SEED (2026-09-23). The company
 *     owner, refusing a proposal built out of a real client's own list:
 *     "keywords like day program won't do anything for our keywords when not
 *     more tightly associated to the core services — in fact it will likely
 *     burn spend." A services list and a keyword strategy are two different
 *     things. `service-seed.ts` decides which phrases may be expanded from,
 *     every one it holds back is NAMED here and on the queue, and the service
 *     itself is untouched: still recorded, still suppressing exactly what it
 *     suppressed. Seeding and suppression are separate jobs, and a client who
 *     does not offer a broad category may rule it out broadly.
 *  6. THE CLIENT'S OWN KEYWORD LIST COMES FIRST (2026-09-30). The company
 *     owner: "many of these clients already had keywords lists in their seo
 *     targets associated with them so why wouldn't you pull that first then go
 *     to the research to pull best options for revenue based mofu bofu." He is
 *     right and this reading was doing the opposite — it seeded from service
 *     NAMES and never once read `seo_targets`, a list a person chose for this
 *     client and the weekly rank pull has tracked ever since.
 *
 *     SO A RECORDED TARGET IS A RECORDED ANSWER, AND THAT WIDENS RULE 1 IN THE
 *     ONE DIRECTION IT CAN BE WIDENED SAFELY. Rule 1 says a term is here
 *     because a confirmed service covers it and for no other reason; the
 *     reason it says that is that relevance must be somebody's answer rather
 *     than this engine's guess. A keyword on this client's own tracking list
 *     IS somebody's answer — a stronger one than a substring of a service
 *     name, because a person typed that exact search against this exact
 *     account. So a recorded target is relevant on its own record, it is
 *     carried whatever volume the research reports, and every term on every
 *     row now SAYS which of the two it came from.
 *  7. INTENT IS WEIGHED, AND WEIGHING IS NOT REFUSING. Nothing here read
 *     `intent` before: it was carried onto the row for a reader and never once
 *     filtered or sorted on, while the order ran on VOLUME — which leads with
 *     informational head terms, because those are the biggest numbers on any
 *     pull. `keyword-sourcing.ts` bands each term, the rows lead with the ones
 *     somebody buys on, and terms that read as people reading up are SET ASIDE
 *     AND NAMED with their count and their volume, never dropped in silence.
 *     A band nobody can place is `unjudged` and is KEPT — a null is unanswered.
 *     A recorded target is kept whatever band it reads as, because overruling
 *     a person's own list is the one thing this must not do.
 */

import { normalizeQueryText, keywordCanServe, type ExistingKeyword } from "./query-promotion.js";
import {
  relevanceOf, relevanceLine, noServicesLine,
  type ClientServiceFacts, type ProvenQuery, type Relevance,
} from "./service-relevance.js";
import { splitSeeds, skippedSeedsLine, type SkippedSeed } from "./service-seed.js";
import {
  planSeeds, bandOf, uncoveredTargets, uncoveredTargetsLine,
  seedSourceLine, tofuSetAsideLine, keptOwnTargetsLine, NO_TARGETS_RECORDED,
  keywordPhrase, BAND_RANK, BAND_LABEL, SOURCE_RANK, SOURCE_LABEL, BANDS_KEPT,
  type RecordedTarget, type KeywordSource, type FunnelBand,
} from "./keyword-sourcing.js";

/**
 * One keyword as the stored research gave it.
 *
 * This mirrors `DiscoveryKeyword` in the dashboard's shared/schema.ts, flattened
 * to the fields a gap reading uses. The caller reads the newest completed
 * research run for the client out of Postgres and maps it; nothing here parses
 * JSON or knows a column name.
 */
export interface ResearchKeyword {
  keyword: string;
  /** Monthly searches DataForSEO reports. Null = not reported, never nought. */
  volume: number | null;
  /** What a click costs, in the account's currency, as DataForSEO reports it.
   *  DOLLARS, not micros and not cents — this figure comes from the research
   *  API rather than from Google Ads, and converting it here is the one place
   *  the unit changes. Null = not reported. */
  cpcDollars: number | null;
  /** 0–100 as the research reports it. Carried for the row, never for a floor. */
  difficulty: number | null;
  /** informational / commercial / transactional / navigational, verbatim. */
  intent: string | null;
  /** Where the client's own site ranks organically, if at all. Null = it does
   *  not rank in the pulled footprint, or was not read. */
  clientRank: number | null;
  /** Where the competitor ranks, on rows that came from a gap pull. */
  competitorRank: number | null;
}

/**
 * The stored research, and how old it is.
 *
 * `keywords: null` means NO RESEARCH IS STORED FOR THIS CLIENT — a different
 * answer from an empty run, and the only one of the two that is this system's
 * fault rather than a finding about the market.
 */
export interface ResearchFacts {
  keywords: ResearchKeyword[] | null;
  /** YYYY-MM-DD the newest completed run finished. Null where none has. */
  ranAt: string | null;
  /** The location the research was run for, verbatim ("United States"). */
  location: string | null;
  /** The seeds a person typed for that run. Named on the row so somebody can
   *  see what the expansion came from. */
  seeds: string[];
}

/**
 * Monthly searches a single term must have before it is worth a line.
 *
 * OURS. A term at this volume, at an ordinary search CTR, is a handful of
 * clicks a month — enough to be measured over a quarter, and the smallest
 * thing anybody would build an ad group for. Below it the term belongs in a
 * broad keyword's tail rather than in a list somebody acts on, and a gap rule
 * that fires on every long-tail phrase is a rule people learn to scroll past.
 */
export const GAP_MIN_TERM_VOLUME = 100;

/**
 * …and the combined monthly searches a SERVICE's uncovered terms must reach
 * before that service is a finding.
 *
 * OURS, and it is the floor that matters: this reading is about a category
 * nobody is bidding on, not about one phrase. At roughly a twentieth of
 * searches becoming a click, three hundred a month is twenty or thirty clicks
 * — the point at which a new ad group produces enough to judge it inside a
 * quarter. One term at the term floor does not reach it, which is deliberate.
 */
export const GAP_MIN_SERVICE_VOLUME = 300;

/**
 * Searches that become a click on a paid result.
 *
 * OURS, and the only assumption in the figure this reading ranks on. Published
 * aggregate paid search CTRs sit in the low single digits and vary by position,
 * vertical and how many ads the page carries by more than the difference is
 * worth arguing about — so one round number is used, it is stated on every row
 * that leans on it, and the figure it produces is called what it is: the size
 * of the demand in money, not a forecast of what this client would earn.
 */
export const GAP_CLICK_RATE = 0.05;

/**
 * Below this share of a campaign's money showing up in the search-terms
 * report, "we have not seen this query" is weak evidence that the account is
 * not already reaching it.
 *
 * The same 60% `coverageChangesTheClaim` uses in spend-visibility.ts, read the
 * other way round, and composed from that module rather than re-decided.
 */
export const GAP_COVERAGE_TRUSTED = 0.6;

export type GapVerdict =
  /** At least one confirmed service has uncovered demand over the floors. */
  | "found"
  /** Looked, and every confirmed service is covered or under the floors. */
  | "covered"
  /** Nobody has confirmed what this client sells. */
  | "no_services_recorded"
  /** No keyword research is stored for this client. */
  | "no_research"
  /** The account's keyword list could not be read, so absence cannot be shown. */
  | "keywords_unread"
  /**
   * Every confirmed service is too broad to research from.
   *
   * A SEPARATE ANSWER FROM `no_services_recorded`, and the difference is the
   * whole point: somebody HAS done the work and the list they wrote cannot
   * carry a keyword strategy. "Day program" is a true statement about what a
   * client sells and a seed that expands into everybody's traffic, so
   * researching off it proposes head terms a person then spends money on.
   */
  | "no_usable_seeds";

/** One uncovered term, with everything the row says about it. */
export interface GapTerm {
  keyword: string;
  /**
   * WHERE THIS TERM CAME FROM, and the reason it is on the row at all.
   *
   * `target` — it is on this client's own tracking list. Somebody chose it for
   * this account, so it is carried whatever the research reports about it and
   * whatever band it reads as. `research` — the stored pull turned it up under
   * a service somebody confirmed. Nobody should have to guess which of the two
   * they are reading, which is the whole of the owner's first complaint.
   */
  source: KeywordSource;
  /** Where in the buying funnel it sits, and what decided that. */
  band: FunnelBand;
  bandBasis: string;
  /** Monthly searches. NULL ONLY ON A RECORDED TARGET the research does not
   *  carry — a term somebody chose is counted and never valued, and a null
   *  here is "not reported", never nought. */
  volume: number | null;
  cpcDollars: number | null;
  difficulty: number | null;
  intent: string | null;
  clientRank: number | null;
  competitorRank: number | null;
  /** volume × GAP_CLICK_RATE × cpc, in cents a month. Null where no cost per
   *  click was reported — an unpriced term is counted and never valued. */
  marketCostCents: number | null;
}

/** Every uncovered term under one confirmed service. */
export interface ServiceGap {
  service: string;
  /** What somebody buys on first, and their own list ahead of the research
   *  inside each band. Terms people read up on are not in here at all — see
   *  `setAsideTerms`. */
  terms: GapTerm[];
  /** Summed over the terms that reported one. A recorded target the research
   *  does not carry adds nothing here and is still on the row. */
  totalVolume: number;
  /** How many of the terms are on this client's own keyword list. */
  ownListTerms: number;
  /** …and how many of those reported no search volume, so are counted here and
   *  valued nowhere. */
  unmeasuredOwnListTerms: number;
  /** Terms under this service that read as somebody reading up rather than
   *  buying. Set aside from the row above, named under it, and untouched
   *  everywhere else. */
  setAsideTerms: GapTerm[];
  setAsideVolume: number;
  /** Sum of the priced terms only. Null where none of them carried a cost per
   *  click, which is a real state and is said rather than rendered as nought. */
  marketCostCents: number | null;
  /** How many of the terms carried no cost per click. */
  unpricedTerms: number;
  /** A converting query on this account under the same service, where one
   *  exists. Proof this service sells here rather than an inference. */
  provenBy: string | null;
  lines: string[];
  metrics: Record<string, number>;
}

export interface GapReading {
  verdict: GapVerdict;
  services: ServiceGap[];
  /** How many research terms were read, matched a confirmed service, and are
   *  already covered. Counted so a row can say the check ran. */
  alreadyCovered: number;
  /** …and how many were dropped because no confirmed service covers them.
   *  This is the number that says the relevance gate is doing work. */
  droppedAsIrrelevant: number;
  /** One clause naming why nothing was produced. Null where something was. */
  silence: string | null;
  /** True where the account's search-terms report accounts for enough of its
   *  spend that "not seen" is decent evidence. False weakens every row. */
  coverageTrusted: boolean;
  /**
   * Services that ARE recorded and were not researched from, each named.
   *
   * Nothing is dropped silently. The service stays on the record, it still
   * suppresses what a recorded service suppresses, and the only thing it loses
   * is the right to expand keyword research.
   */
  skippedSeeds: SkippedSeed[];
  /**
   * What this run seeded from, and in which order. The sentence names the
   * SOURCES and their counts; which phrases they were is the row list itself.
   */
  seedSource: string | null;
  /** Keywords on this client's own list that no keyword in this account can
   *  serve today, whether or not a confirmed service covers them. Named on the
   *  run and never valued. */
  uncoveredOwnList: string[];
  /** Null where the target list was read — including where it was read and is
   *  empty, which is a different answer and has its own sentence. */
  targetsUnread: string | null;
}

export interface GapInput {
  research: ResearchFacts | null | undefined;
  services: ClientServiceFacts;
  /**
   * Every keyword the account holds that has not been removed. NULL = the read
   * failed.
   *
   * This reading uses only the ones that CAN SERVE, and the distinction is the
   * whole claim: the row says nothing is bidding on this demand, and nobody is
   * bidding through a keyword sitting in a paused ad group. A keyword whose
   * status this run could not read counts as covering, which suppresses a gap
   * rather than inventing one — a list of demand for things the account already
   * runs discredits every other row on the page.
   */
  existingKeywords: ExistingKeyword[] | null | undefined;
  /** Every search term seen over the long window, whatever it cost. */
  seenTerms: string[];
  /** Negative keyword texts already in the account, lowercased. */
  existingNegatives: Set<string>;
  /** Queries that already convert here, for the proof half of relevance. */
  provenQueries: ProvenQuery[];
  /** Campaign names the client told us never to touch. */
  protectedPatterns: string[];
  /** Share of the account's spend the search-terms report accounts for, or
   *  null where it was not read. Composed from `spendVisibility`. */
  accountTermCoverage: number | null;
  /**
   * THIS CLIENT'S OWN RECORDED KEYWORD TARGETS (`seo_targets`), as a person
   * put them there.
   *
   * NULL MEANS NOBODY READ THE LIST — an older caller, or a read that failed.
   * It is never [] for that case: an empty array says somebody looked and this
   * client has chosen no keywords, which is a real and different answer with
   * its own sentence. A caller that leaves this out behaves exactly as this
   * reading did before any of it existed.
   */
  targets?: readonly RecordedTarget[] | null;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Every word of `blocker` appears in `term` — the conservative reading of a
 *  negative keyword blocking a query. Phrase and exact negatives are stricter
 *  than this, so it says "blocked" more often than the platform would, which
 *  is the direction that proposes less. */
function blockedBy(term: string, blocker: string): boolean {
  const need = normalizeQueryText(blocker).split(" ").filter(Boolean);
  if (!need.length) return false;
  const have = new Set(normalizeQueryText(term).split(" ").filter(Boolean));
  return need.every((t) => have.has(t));
}

/**
 * Pure. Research, an account, and what the client sells → the demand nobody
 * is bidding on.
 */
export function keywordGaps(i: GapInput): GapReading {
  const empty = (
    verdict: GapVerdict, silence: string, skippedSeeds: SkippedSeed[] = [],
    extra: Partial<GapReading> = {},
  ): GapReading => ({
    verdict, services: [], alreadyCovered: 0, droppedAsIrrelevant: 0,
    silence, coverageTrusted: false, skippedSeeds,
    seedSource: null, uncoveredOwnList: [],
    targetsUnread: i.targets === undefined || i.targets === null
      ? "This client's own keyword list was not read this run, so nothing here can say whether one exists."
      : null,
    ...extra,
  });

  // The relevance gate comes FIRST, before the research is even looked at.
  // Refusing here rather than after filtering is what makes the refusal say
  // "nobody has told us what they sell" instead of "no gaps found".
  if (i.services.services == null || i.services.services.length === 0) {
    return empty("no_services_recorded", noServicesLine(i.services));
  }
  if (i.research?.keywords == null) {
    return empty("no_research",
      "No keyword research is stored for this client, so there is nothing to compare their account against. "
      + "Run the keyword research on their SEO tab and this reads on the next audit.");
  }
  if (i.existingKeywords == null) {
    return empty("keywords_unread",
      "The account's keyword list could not be read this run, so nothing here can show a term is missing from it. "
      + "A term cannot be called a gap in a list nobody could see.");
  }

  // ── WHICH RECORDED SERVICES MAY SEED RESEARCH ────────────────────────────
  // A services list and a keyword strategy are different things, and this
  // reading is where the difference costs money: a broad seed expands into
  // neighbouring demand that has nothing to do with the client, and a person
  // acting on the row buys traffic that will not convert. The rule is
  // `service-seed.ts`, copied byte for byte into the app so the review a person
  // ticks and this run agree about which phrases are worth expanding.
  //
  // It changes SEEDING and nothing else. Every confirmed service still
  // suppresses exactly what it suppressed, because a client who genuinely does
  // not offer a broad category is entitled to say so broadly.
  // THE CLIENT'S OWN LIST COMES FIRST (rule 6). `planSeeds` puts every
  // recorded target ahead of every service name, bands each one so the buying
  // searches lead inside a source, and puts the services through the very same
  // `seedReading` `splitSeeds` used — so nothing that was held back before is
  // seeded now and nothing that seeded before is held back.
  const plan = planSeeds({
    targets: i.targets === undefined ? null : i.targets,
    services: i.services.services,
    // The account's own proof: a query it already turns into an enquiry, plus
    // the keywords somebody chose to track for this client. The search-terms
    // report as a whole is not used — it holds everything a broad keyword ever
    // matched, which is the opposite of the client's own words.
    accountTerms: [
      ...i.provenQueries.map((q) => q.term),
      ...(i.targets ?? []).map((t) => t.keyword),
    ],
    research: i.research.keywords.map((k) => ({ keyword: k.keyword, intent: k.intent, volume: k.volume })),
  });
  const seedSplit = { seeds: plan.seeds.filter((x) => x.source === "service").map((x) => x.phrase), skipped: plan.heldBack };
  const seedSource = seedSourceLine(plan);
  // A TARGET LIST THAT WAS READ AND IS EMPTY IS AN ANSWER, and it is a
  // different sentence from one nobody read. Neither ever stands in for the
  // other, which is the whole reason `targetsUnread` is its own field.
  const ownListNote = plan.targetsUnread ?? (plan.targetSeeds === 0 ? NO_TARGETS_RECORDED : null);

  // NOTHING IS BID ON A LIST NOBODY CAN SEED FROM. A client with no usable
  // service AND no recorded target has nothing to expand around, which is the
  // answer somebody has to act on rather than an empty gap list.
  if (plan.seeds.length === 0) {
    return empty(
      "no_usable_seeds",
      `${skippedSeedsLine(seedSplit.skipped) ?? "Every recorded service is too broad to research from."}`
      + " Each one is still recorded and still rules out what it ruled out. What none of them can do is say which searches to look at."
      + ` ${ownListNote ?? "Nothing on this client's own keyword list could be read either."}`
      + " Sharpen one on the client page — say what the work treats or sells — or put a keyword on their tracking list, and this reads on the next audit.",
      seedSplit.skipped,
      { seedSource: null },
    );
  }
  const seedable: ClientServiceFacts = {
    ...i.services,
    services: i.services.services.filter((s) => seedSplit.seeds.includes(s.name)),
  };

  const coverageTrusted = i.accountTermCoverage != null && i.accountTermCoverage >= GAP_COVERAGE_TRUSTED;
  const keywordSet = new Set(
    i.existingKeywords
      .filter((k) => keywordCanServe(k) !== "no")
      .map((k) => normalizeQueryText(k.text))
      .filter(Boolean),
  );
  const seenSet = new Set(i.seenTerms.map((t) => normalizeQueryText(t)).filter(Boolean));
  const negatives = Array.from(i.existingNegatives).map((n) => String(n)).filter(Boolean);
  const protectedLower = i.protectedPatterns.map((p) => p.toLowerCase()).filter(Boolean);

  let alreadyCovered = 0;
  let droppedAsIrrelevant = 0;
  const byService = new Map<string, { relevance: Relevance; terms: GapTerm[] }>();

  /**
   * Is this account already reaching the term. ONE closure, because the answer
   * has to be the same for a research row and for a keyword off the client's
   * own list — two copies of it is how a term lands in a gap row and in the
   * "already covered" count at once.
   *
   * A protected term is COVERED rather than uncovered: the client told us to
   * leave it alone, which is a decision and not a hole.
   */
  const isReached = (text: string): boolean => {
    const lower = text.toLowerCase();
    if (protectedLower.some((p) => lower.includes(p) || p.includes(lower))) return true;
    const norm = normalizeQueryText(text);
    if (!norm) return true;
    if (keywordSet.has(norm)) return true;
    if (seenSet.has(norm)) return true;
    return negatives.some((n) => blockedBy(text, n));
  };

  // The client's own list, normalised once, so a research row can say whether
  // it is a phrase somebody already chose.
  const ownList = new Map<string, RecordedTarget>();
  for (const t of i.targets ?? []) {
    const key = keywordPhrase(String(t.keyword ?? ""));
    if (key && !ownList.has(key)) ownList.set(key, t);
  }
  const sourceOf = (text: string): KeywordSource => (ownList.has(keywordPhrase(text)) ? "target" : "research");

  const addTerm = (service: string, rel: Relevance, term: GapTerm) => {
    const g = byService.get(service) ?? { relevance: rel, terms: [] };
    // The strongest proof across the service's terms is the one worth naming.
    if (rel.provenBy && !g.relevance.provenBy) g.relevance = rel;
    g.terms.push(term);
    byService.set(service, g);
  };

  const researchSeen = new Set<string>();
  for (const k of i.research.keywords) {
    const text = String(k.keyword ?? "").trim();
    if (!text) continue;
    const phrase = keywordPhrase(text);
    if (phrase) researchSeen.add(phrase);

    const source = sourceOf(text);
    // THE VOLUME FLOOR IS FOR THE RESEARCH AND NOT FOR THEIR OWN LIST. It
    // exists so a gap rule does not fire on every long-tail phrase an
    // expansion returns; a keyword somebody put on this client's tracking list
    // is not a long tail, it is a decision, and dropping it for a figure
    // DataForSEO did not report reads a null as a nought.
    if (source === "research" && (k.volume == null || k.volume < GAP_MIN_TERM_VOLUME)) continue;

    const rel = relevanceOf(text, seedable, i.provenQueries);
    if (rel.verdict !== "matched" || !rel.service) { droppedAsIrrelevant++; continue; }

    if (isReached(text)) { alreadyCovered++; continue; }
    if (!normalizeQueryText(text)) continue;

    const marketCostCents = k.volume != null && k.cpcDollars != null && k.cpcDollars > 0
      ? Math.round(k.volume * GAP_CLICK_RATE * k.cpcDollars * 100)
      : null;
    const b = bandOf(text, k.intent);
    addTerm(rel.service, rel, {
      keyword: text,
      source,
      band: b.band,
      bandBasis: b.basis,
      volume: k.volume,
      cpcDollars: k.cpcDollars,
      difficulty: k.difficulty,
      intent: k.intent,
      clientRank: k.clientRank,
      competitorRank: k.competitorRank,
      marketCostCents,
    });
  }

  // ── AND THE LIST'S OWN TERMS THE RESEARCH NEVER RETURNED ─────────────────
  // A pull is seeded and capped, so a client's own tracking list routinely
  // holds keywords no expansion happened to return. Those are the rows the
  // owner was asking for first, and dropping them because a research run did
  // not mention them would be exactly the order he objected to. They carry NO
  // volume, no cost per click and no difficulty — the record holds none — and
  // the row says so rather than printing a nought.
  for (const [phrase, t] of ownList) {
    if (researchSeen.has(phrase)) continue;
    const text = String(t.keyword ?? "").trim();
    if (!text) continue;
    const rel = relevanceOf(text, seedable, i.provenQueries);
    if (rel.verdict !== "matched" || !rel.service) continue;
    if (isReached(text)) { alreadyCovered++; continue; }
    const b = bandOf(text, null);
    addTerm(rel.service, rel, {
      keyword: text, source: "target", band: b.band, bandBasis: b.basis,
      volume: null, cpcDollars: null, difficulty: null, intent: null,
      clientRank: null, competitorRank: null, marketCostCents: null,
    });
  }

  // Every keyword on their own list this account cannot serve today, whether
  // or not a confirmed service covers it. Named on the run; valued nowhere.
  const uncoveredOwnList = uncoveredTargets(i.targets, (phrase) => isReached(phrase));

  /**
   * THE ORDER, AND IT IS THE WHOLE OF FAULT (b).
   *
   * This used to be `b.volume - a.volume` and nothing else, which leads every
   * row with the biggest number on the pull — and on any research pull the
   * biggest numbers are informational head terms. So: what somebody buys on
   * first, then their own list ahead of the research inside a band, then
   * volume. A term with no reported volume sorts last inside its own bracket
   * rather than first, because a null is not a large number either.
   */
  const readingOrder = (a: GapTerm, b: GapTerm) =>
    BAND_RANK[a.band] - BAND_RANK[b.band]
    || SOURCE_RANK[a.source] - SOURCE_RANK[b.source]
    || (b.volume ?? -1) - (a.volume ?? -1);

  const services: ServiceGap[] = [];
  for (const [service, g] of byService) {
    // SET ASIDE, NOT DROPPED. A term people read up on stays in the reading,
    // is named with its count and its volume under the row, and is untouched
    // on the record. The one exception is a keyword on the client's own list:
    // somebody here chose it, and a band worked out from a vendor's label and
    // some English does not overrule that.
    const keep = (t: GapTerm) => t.source === "target" || BANDS_KEPT.includes(t.band);
    const terms = g.terms.filter(keep).sort(readingOrder);
    const setAsideTerms = g.terms.filter((t) => !keep(t)).sort(readingOrder);
    const setAsideVolume = setAsideTerms.reduce((s, t) => s + (t.volume ?? 0), 0);
    const ownListTerms = terms.filter((t) => t.source === "target");
    const unmeasuredOwnListTerms = ownListTerms.filter((t) => t.volume == null).length;

    const totalVolume = terms.reduce((s, t) => s + (t.volume ?? 0), 0);
    // A SERVICE CARRYING A KEYWORD OFF THE CLIENT'S OWN LIST IS A FINDING
    // WHATEVER THE VOLUME. The floor exists so a handful of long-tail phrases
    // an expansion returned does not raise a row; it was never meant to
    // silence a term a person chose and this account is not bidding on.
    if (terms.length === 0) continue;
    if (ownListTerms.length === 0 && totalVolume < GAP_MIN_SERVICE_VOLUME) continue;

    const priced = terms.filter((t) => t.marketCostCents != null);
    const marketCostCents = priced.length
      ? priced.reduce((s, t) => s + (t.marketCostCents ?? 0), 0) : null;
    const unpricedTerms = terms.length - priced.length;

    const lines: string[] = [];
    lines.push(relevanceLine(g.relevance, i.services));
    if (seedSource) lines.push(seedSource);
    for (const t of terms.slice(0, 8)) {
      // WHERE IT CAME FROM AND WHAT IT IS, on every row, because a term off
      // the client's own list and one an expansion returned are two different
      // claims and a reader was being left to guess which.
      const bits = [SOURCE_LABEL[t.source], BAND_LABEL[t.band]];
      bits.push(t.volume != null
        ? `${t.volume.toLocaleString()} searches/mo`
        : "no search volume on record");
      if (t.cpcDollars != null) bits.push(`$${t.cpcDollars.toFixed(2)} a click`);
      if (t.difficulty != null) bits.push(`difficulty ${Math.round(t.difficulty)}/100`);
      if (t.clientRank != null) bits.push(`their site ranks #${t.clientRank} organically`);
      else if (t.competitorRank != null) bits.push(`a competitor ranks #${t.competitorRank}`);
      lines.push(`"${t.keyword}" — ${bits.join(" · ")}`);
    }
    if (terms.length > 8) lines.push(`…and ${terms.length - 8} more term(s) under the same service`);
    const setAsideLine = tofuSetAsideLine(setAsideTerms.length, setAsideVolume || null);
    if (setAsideLine) lines.push(setAsideLine);
    const keptOwn = keptOwnTargetsLine(ownListTerms.filter((t) => t.band === "tofu").length);
    if (keptOwn) lines.push(keptOwn);
    if (unmeasuredOwnListTerms > 0) {
      lines.push(`${unmeasuredOwnListTerms} of these came off their own tracking list and the stored research does not carry ${unmeasuredOwnListTerms === 1 ? "it" : "them"}, so ${unmeasuredOwnListTerms === 1 ? "it is" : "they are"} counted here and valued nowhere.`);
    }
    if (unpricedTerms > 0) {
      lines.push(`${unpricedTerms} of these term(s) carry no cost per click in the research, so they are counted and not valued.`);
    }
    lines.push(
      `Checked against every keyword the account holds that can serve today, ninety days of search terms and the negatives already in place — none of these has been seen. `
      + `A keyword sitting in a paused ad group or a paused campaign is not counted as covering the demand, because nobody is bidding through it.`
      + (coverageTrusted
        ? ""
        : " The search-terms report accounts for a minority of this account's spend, so 'not seen' is weaker evidence here than it looks: a broad keyword may already be reaching some of this."),
    );
    const skippedLine = skippedSeedsLine(seedSplit.skipped);
    if (skippedLine) lines.push(skippedLine);
    if (i.research?.ranAt) {
      lines.push(
        `Research run ${i.research.ranAt}${i.research.location ? ` for ${i.research.location}` : ""}`
        + `${i.research.seeds.length ? ` from the seed(s): ${i.research.seeds.slice(0, 6).join(", ")}` : ""}.`,
      );
    }

    services.push({
      service,
      terms,
      totalVolume,
      ownListTerms: ownListTerms.length,
      unmeasuredOwnListTerms,
      setAsideTerms,
      setAsideVolume,
      marketCostCents,
      unpricedTerms,
      provenBy: g.relevance.provenBy,
      lines,
      metrics: {
        uncoveredTerms: terms.length,
        uncoveredVolume: totalVolume,
        marketCostCents: marketCostCents ?? 0,
        unpricedTerms,
        ownListTerms: ownListTerms.length,
        setAsideTerms: setAsideTerms.length,
      },
    });
  }

  // A SERVICE HOLDING THEIR OWN CHOSEN KEYWORDS LEADS, whatever the money says
  // — the same precedence the terms inside it use, for the same reason. Money
  // then volume decides the rest, as it did.
  services.sort((a, b) =>
    (b.ownListTerms > 0 ? 1 : 0) - (a.ownListTerms > 0 ? 1 : 0)
    || (b.marketCostCents ?? 0) - (a.marketCostCents ?? 0)
    || b.totalVolume - a.totalVolume);

  const ownListLine = uncoveredTargetsLine(uncoveredOwnList);
  const tail = {
    seedSource, uncoveredOwnList,
    targetsUnread: plan.targetsUnread,
  };
  if (services.length === 0) {
    return {
      verdict: "covered", services: [], alreadyCovered, droppedAsIrrelevant,
      coverageTrusted, skippedSeeds: seedSplit.skipped, ...tail,
      silence: `Every recorded service this client sells is already covered by a keyword, a query the account has been seen on, or a negative somebody added on purpose`
        + ` — ${alreadyCovered} research term(s) matched a service and are already reached, and ${droppedAsIrrelevant} were dropped as nothing this client provides.`
        + (skippedSeedsLine(seedSplit.skipped) ? ` ${skippedSeedsLine(seedSplit.skipped)}` : "")
        // NOT A CONTRADICTION, AND WORTH SAYING IN THE SAME BREATH. A service
        // can be covered while a keyword somebody chose for this client is in
        // no keyword this account serves — the second is not grouped under a
        // confirmed service, and it is the thing the owner asked to see first.
        + (ownListLine ? ` ${ownListLine}` : ""),
    };
  }
  for (const g of services) {
    // ONE FACT ABOUT THE ACCOUNT, said once. It goes on the leading row only:
    // the same clause under every row is the wallpaper `hoistSharedSlot`
    // exists to stop.
    if (ownListLine) { g.lines.push(ownListLine); break; }
  }
  return {
    verdict: "found", services, alreadyCovered, droppedAsIrrelevant,
    silence: null, coverageTrusted, skippedSeeds: seedSplit.skipped, ...tail,
  };
}

/**
 * What the row claims, in one sentence.
 *
 * THE FIGURE IS THE SIZE OF THE DEMAND IN MONEY, NOT A GAIN. It is what the
 * market is charging for the clicks this demand produces, at one stated click
 * rate, and it says nothing about what share of it this client would win, what
 * those clicks would convert at, or what a conversion is worth to them.
 * Claiming a lead figure would need a conversion rate for a term nobody has
 * ever run, which is a number this engine does not have and will not invent.
 */
export function gapClaim(g: ServiceGap, coverageTrusted: boolean): string {
  const base = g.marketCostCents != null
    ? `${money(g.marketCostCents)} a month is what the market charges for the clicks this demand produces, at ${Math.round(GAP_CLICK_RATE * 100)}% of searches becoming a click and the cost per click the research reports.`
      + ` It is the size of what is uncovered. Nothing here knows what share of it this client would win, or what those clicks would convert at.`
    : g.totalVolume > 0
      ? `None of these terms carries a cost per click in the research, so there is no money figure — only ${g.totalVolume.toLocaleString()} searches a month nobody here is bidding on.`
      // NO FIGURE AT ALL IS A REAL STATE NOW: a service can reach a row on the
      // strength of keywords off the client's own list that the stored
      // research never returned. Counted, never valued, and never a nought.
      : `No figure at all. These came off this client's own tracking list and the stored research does not carry ${g.terms.length === 1 ? "it" : "them"}, so nothing here reports how often ${g.terms.length === 1 ? "it is" : "they are"} searched or what a click costs.`;
  return coverageTrusted ? base : `${base} The account's search-terms report covers a minority of its spend, so some of this may already be reached by a broad keyword.`;
}

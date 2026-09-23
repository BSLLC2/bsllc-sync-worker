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
 *     stated. Three things are checked: the term is in no enabled keyword in
 *     the account; it has not appeared in ninety days of search terms; and it
 *     is not blocked by a negative somebody added on purpose. What CANNOT be
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
 */

import { normalizeQueryText, type ExistingKeyword } from "./query-promotion.js";
import {
  relevanceOf, relevanceLine, noServicesLine,
  type ClientServiceFacts, type ProvenQuery, type Relevance,
} from "./service-relevance.js";
import { splitSeeds, skippedSeedsLine, type SkippedSeed } from "./service-seed.js";

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
  volume: number;
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
  /** Biggest volume first. */
  terms: GapTerm[];
  totalVolume: number;
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
}

export interface GapInput {
  research: ResearchFacts | null | undefined;
  services: ClientServiceFacts;
  /** Every enabled keyword in the account. NULL = the read failed. */
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
  const empty = (verdict: GapVerdict, silence: string, skippedSeeds: SkippedSeed[] = []): GapReading => ({
    verdict, services: [], alreadyCovered: 0, droppedAsIrrelevant: 0,
    silence, coverageTrusted: false, skippedSeeds,
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
  const seedSplit = splitSeeds(i.services.services, {
    // The account's own proof: a query it already turns into an enquiry. The
    // search-terms report as a whole is not used — it holds everything a broad
    // keyword ever matched, which is the opposite of the client's own words.
    accountTerms: i.provenQueries.map((q) => q.term),
    research: i.research.keywords.map((k) => ({ keyword: k.keyword, intent: k.intent, volume: k.volume })),
  });
  if (seedSplit.seeds.length === 0) {
    return empty(
      "no_usable_seeds",
      `${skippedSeedsLine(seedSplit.skipped) ?? "Every recorded service is too broad to research from."}`
      + " Each one is still recorded and still rules out what it ruled out. What none of them can do is say which searches to look at."
      + " Sharpen one on the client page — say what the work treats or sells — and this reads on the next audit.",
      seedSplit.skipped,
    );
  }
  const seedable: ClientServiceFacts = {
    ...i.services,
    services: i.services.services.filter((s) => seedSplit.seeds.includes(s.name)),
  };

  const coverageTrusted = i.accountTermCoverage != null && i.accountTermCoverage >= GAP_COVERAGE_TRUSTED;
  const keywordSet = new Set(i.existingKeywords.map((k) => normalizeQueryText(k.text)).filter(Boolean));
  const seenSet = new Set(i.seenTerms.map((t) => normalizeQueryText(t)).filter(Boolean));
  const negatives = Array.from(i.existingNegatives).map((n) => String(n)).filter(Boolean);
  const protectedLower = i.protectedPatterns.map((p) => p.toLowerCase()).filter(Boolean);

  let alreadyCovered = 0;
  let droppedAsIrrelevant = 0;
  const byService = new Map<string, { relevance: Relevance; terms: GapTerm[] }>();

  for (const k of i.research.keywords) {
    const text = String(k.keyword ?? "").trim();
    if (!text) continue;
    if (k.volume == null || k.volume < GAP_MIN_TERM_VOLUME) continue;

    const rel = relevanceOf(text, seedable, i.provenQueries);
    if (rel.verdict !== "matched" || !rel.service) { droppedAsIrrelevant++; continue; }

    // A term the client told us to leave alone is not a gap, it is a decision.
    const lower = text.toLowerCase();
    if (protectedLower.some((p) => lower.includes(p) || p.includes(lower))) { alreadyCovered++; continue; }

    const norm = normalizeQueryText(text);
    if (!norm) continue;
    if (keywordSet.has(norm)) { alreadyCovered++; continue; }
    if (seenSet.has(norm)) { alreadyCovered++; continue; }
    if (negatives.some((n) => blockedBy(text, n))) { alreadyCovered++; continue; }

    const marketCostCents = k.cpcDollars != null && k.cpcDollars > 0
      ? Math.round(k.volume * GAP_CLICK_RATE * k.cpcDollars * 100)
      : null;

    const g = byService.get(rel.service) ?? { relevance: rel, terms: [] };
    // The strongest proof across the service's terms is the one worth naming.
    if (rel.provenBy && !g.relevance.provenBy) g.relevance = rel;
    g.terms.push({
      keyword: text,
      volume: k.volume,
      cpcDollars: k.cpcDollars,
      difficulty: k.difficulty,
      intent: k.intent,
      clientRank: k.clientRank,
      competitorRank: k.competitorRank,
      marketCostCents,
    });
    byService.set(rel.service, g);
  }

  const services: ServiceGap[] = [];
  for (const [service, g] of byService) {
    const terms = [...g.terms].sort((a, b) => b.volume - a.volume);
    const totalVolume = terms.reduce((s, t) => s + t.volume, 0);
    if (totalVolume < GAP_MIN_SERVICE_VOLUME) continue;

    const priced = terms.filter((t) => t.marketCostCents != null);
    const marketCostCents = priced.length
      ? priced.reduce((s, t) => s + (t.marketCostCents ?? 0), 0) : null;
    const unpricedTerms = terms.length - priced.length;

    const lines: string[] = [];
    lines.push(relevanceLine(g.relevance, i.services));
    for (const t of terms.slice(0, 8)) {
      const bits = [`${t.volume.toLocaleString()} searches/mo`];
      if (t.cpcDollars != null) bits.push(`$${t.cpcDollars.toFixed(2)} a click`);
      if (t.difficulty != null) bits.push(`difficulty ${Math.round(t.difficulty)}/100`);
      if (t.intent) bits.push(t.intent);
      if (t.clientRank != null) bits.push(`their site ranks #${t.clientRank} organically`);
      else if (t.competitorRank != null) bits.push(`a competitor ranks #${t.competitorRank}`);
      lines.push(`"${t.keyword}" — ${bits.join(" · ")}`);
    }
    if (terms.length > 8) lines.push(`…and ${terms.length - 8} more term(s) under the same service`);
    if (unpricedTerms > 0) {
      lines.push(`${unpricedTerms} of these term(s) carry no cost per click in the research, so they are counted and not valued.`);
    }
    lines.push(
      `Checked against every enabled keyword in the account, ninety days of search terms and the negatives already in place — none of these has been seen.`
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
      marketCostCents,
      unpricedTerms,
      provenBy: g.relevance.provenBy,
      lines,
      metrics: {
        uncoveredTerms: terms.length,
        uncoveredVolume: totalVolume,
        marketCostCents: marketCostCents ?? 0,
        unpricedTerms,
      },
    });
  }

  services.sort((a, b) => (b.marketCostCents ?? 0) - (a.marketCostCents ?? 0) || b.totalVolume - a.totalVolume);

  if (services.length === 0) {
    return {
      verdict: "covered", services: [], alreadyCovered, droppedAsIrrelevant,
      coverageTrusted, skippedSeeds: seedSplit.skipped,
      silence: `Every recorded service this client sells is already covered by a keyword, a query the account has been seen on, or a negative somebody added on purpose`
        + ` — ${alreadyCovered} research term(s) matched a service and are already reached, and ${droppedAsIrrelevant} were dropped as nothing this client provides.`
        + (skippedSeedsLine(seedSplit.skipped) ? ` ${skippedSeedsLine(seedSplit.skipped)}` : ""),
    };
  }
  return {
    verdict: "found", services, alreadyCovered, droppedAsIrrelevant,
    silence: null, coverageTrusted, skippedSeeds: seedSplit.skipped,
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
    : `None of these terms carries a cost per click in the research, so there is no money figure — only ${g.totalVolume.toLocaleString()} searches a month nobody here is bidding on.`;
  return coverageTrusted ? base : `${base} The account's search-terms report covers a minority of its spend, so some of this may already be reached by a broad keyword.`;
}

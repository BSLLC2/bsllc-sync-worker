/**
 * Queries that already convert, and are not keywords yet.
 *
 * Pure. Facts in, one reading out, in the style of `spendVisibility` and
 * `biddingReadiness` next door.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Seven of the eight rules in `rules.ts` cut waste. The search-term rule opens
 * with `if (t.conversions > 0 || t.allConversions > 0) continue;` — so every
 * query that PRODUCED SOMETHING is read, discarded, and read again next week.
 * The engine fetches the clearest growth signal a search account has and throws
 * it away on every run.
 *
 * A query that converts and is not in the account as a keyword is being bought
 * through whatever looser keyword happens to match it, at that keyword's bid,
 * inside that keyword's ad group, against that ad group's ads. Making it a
 * keyword of its own is how it gets its own bid, its own match type, its own
 * copy and its own reporting line.
 *
 * ── THE LIMIT ON THE CLAIM, WHICH IS THE POINT ────────────────────────────
 *
 * The conversions are ALREADY HAPPENING. Promoting the query does not create
 * them — they are in the campaign's own totals, in its cost per conversion, and
 * in everything downstream that reads those. So NO DOLLAR FIGURE IS CLAIMED
 * HERE, and the reason is arithmetic rather than modesty: claiming the value of
 * those conversions as the benefit of the change counts the same conversion
 * twice, once where it already is and again as the gain from moving it. That is
 * the shape of the mistake `budget_limited` made until this week, when the extra
 * SPEND a budget rise buys was written into `est_impact_cents` as though
 * spending were a benefit.
 *
 * What promotion actually buys is bid control, match-type control and a
 * reporting line, and the size of each depends on what somebody sets the bid to
 * — a number nothing here can see. So the row states the money already flowing
 * through the query and the conversions it produced, and claims nothing beyond.
 *
 * ── IT IS A BRIEF, NOT A BUTTON ───────────────────────────────────────────
 *
 * Adding a keyword is not in the guarded API scope (budgets, campaign
 * negatives, keyword final URLs, asset removal, data exclusions) and this does
 * not add it. Creating one means choosing an ad group, a match type and a bid.
 * Those are three judgements, the first two change which ads a query is served
 * against, and none of them is mechanical. `applicability: "vendor"`.
 */

/** One query as the search-terms report gave it, over the long window. */
export interface PromotionQueryInput {
  term: string;
  campaignId: string;
  campaignName: string;
  adGroupName: string | null;
  costMicros: number;
  clicks: number;
  /** The PRIMARY conversion column — what the bidding optimises toward. */
  conversions: number;
  /** all_conversions. Carried for the evidence, never for the floor. */
  allConversions: number;
}

/**
 * A keyword already in the account, as the platform lists it.
 *
 * This is deliberately a SETTINGS read rather than the performance pull the
 * waste rules use: `keyword_view` is filtered to `cost_micros > 0` and capped
 * at 300 rows, so a keyword that took no clicks in the window is absent from
 * it — and "absent from a performance report" is not "not in the account".
 * Proposing a keyword that is already there is the one mistake this rule must
 * not make, so it checks against the whole list or it checks against nothing.
 *
 * ── WHAT THE LIST HOLDS, AND WHY IT IS WIDER THAN THE ONE THAT SERVES ─────
 *
 * A keyword sitting in a PAUSED ad group is still a keyword. On 2026-09-23 a
 * reviewer found this rule telling somebody to add "cooking classes near me"
 * to an account that already held it — enabled, broad, verbatim — inside an ad
 * group nobody had turned back on. The list was filtered to enabled ad groups
 * in enabled campaigns, so the duplicate was invisible to the one check whose
 * job is to see it.
 *
 * So the list now holds every keyword the account has not REMOVED, at every
 * level, and each row carries the three statuses that decide whether it can
 * serve. Removed is left out on purpose: a removed criterion cannot be turned
 * back on, so creating the keyword again is the right thing to do.
 *
 * A row reading its statuses gets three answers from `keywordCanServe`, and
 * the third one matters: an absent status is UNKNOWN, never ENABLED, so a
 * platform that stops reporting one makes this rule cautious rather than
 * confident.
 */
export interface ExistingKeyword {
  text: string;
  /** EXACT / PHRASE / BROAD, verbatim. Carried so the row can say where the
   *  query already lives rather than only that it does. */
  matchType: string | null;
  adGroupName: string | null;
  campaignName: string | null;
  /** The criterion's own resource name, so a performance row can be joined to
   *  the settings row it belongs to. Absent where the platform did not give
   *  one; nothing here guesses a join key from a keyword's text. */
  criterionResourceName?: string | null;
  /** The keyword's own status, verbatim. Absent or null = not reported. */
  criterionStatus?: string | null;
  /** Its ad group's status, verbatim. Absent or null = not reported. */
  adGroupStatus?: string | null;
  /** Its campaign's status, verbatim. Absent or null = not reported. */
  campaignStatus?: string | null;
  /**
   * Google's quality score for it, 1 to 10.
   *
   * NULL IS UNANSWERED AND IS NEVER A NOUGHT. Google reports no score until a
   * keyword has served enough exact-match traffic to earn one, so a keyword
   * nobody has run yet has no score rather than the worst score. A count of
   * keywords "below 5" that swept nulls in would be a count of keywords nobody
   * has measured.
   */
  qualityScore?: number | null;
}

/** Whether a keyword can be served today, read from the three statuses that
 *  decide it. `unknown` where any of them was not reported. */
export type KeywordServing = "yes" | "no" | "unknown";

/** ENABLED at the criterion, the ad group and the campaign, or it cannot
 *  serve. An unreported status is unknown, never taken as enabled. */
export function keywordCanServe(k: ExistingKeyword): KeywordServing {
  const parts = [k.criterionStatus, k.adGroupStatus, k.campaignStatus];
  if (parts.some((s) => s != null && String(s).toUpperCase() !== "ENABLED")) return "no";
  if (parts.some((s) => s == null)) return "unknown";
  return "yes";
}

/** Which level is switched off, in plain words. Null where it can serve or
 *  where the statuses were not reported. */
export function dormantBecause(k: ExistingKeyword): string | null {
  const off = (s: string | null | undefined) => s != null && String(s).toUpperCase() !== "ENABLED";
  if (off(k.criterionStatus)) return `the keyword itself is ${String(k.criterionStatus).toLowerCase()}`;
  if (off(k.adGroupStatus)) return `its ad group is ${String(k.adGroupStatus).toLowerCase()}`;
  if (off(k.campaignStatus)) return `its campaign is ${String(k.campaignStatus).toLowerCase()}`;
  return null;
}

/** Where a keyword sits, for a sentence a person reads. */
export function keywordWhere(k: ExistingKeyword): string {
  const bits: string[] = [];
  if (k.campaignName) bits.push(`"${k.campaignName}"`);
  if (k.adGroupName) bits.push(`"${k.adGroupName}"`);
  const place = bits.length ? bits.join(" › ") : "an ad group this run could not name";
  return k.matchType ? `${k.matchType.toLowerCase()} match in ${place}` : place;
}

/**
 * A query must have converted at least this many times before it is worth
 * anybody's attention as a keyword.
 *
 * Two, not one, and `conversions` being a FLOAT is the reason. Google splits
 * one conversion across the clicks it attributes it to, so a single figure
 * under one is a share of somebody else's conversion rather than an outcome
 * this query produced; and one whole conversion on one query over ninety days
 * is one event, which is not a pattern anybody would bid deliberately against.
 * Two is the smallest number that can repeat.
 */
export const PROMOTE_MIN_CONVERSIONS = 2;

/**
 * …and must have taken at least this much of the campaign's money.
 *
 * The SAME $25/90 days `THRESHOLDS.searchTermWasteMicros` uses to decide a
 * query is worth blocking, for the same reason read the other way round: below
 * it, the query is too small a share of the account for a separate bid on it to
 * change anything, and a rule that fires on every converting query is a rule
 * people learn to scroll past.
 */
export const PROMOTE_MIN_COST_MICROS = 25_000_000;

/**
 * Letters and digits only, lowercased, everything else a single space.
 *
 * The same normalisation `recogniseCrm` in the dashboard's
 * shared/outcome-source.ts applies, and for the same reason: it folds case,
 * punctuation and spacing, all of which Google itself ignores when it decides
 * which keyword a query matched, and it changes no meaning. It also strips the
 * decorations a keyword carries in an export — `[exact]`, `"phrase"` and the
 * broad-match modifier `+` — which are match-type notation rather than part of
 * the text.
 *
 * It does NOT stem, fold plurals or reorder words. Google treats close variants
 * as the same keyword and this does not, which means this check says "already
 * there" less often than Google would. That is the conservative direction: it
 * proposes a keyword the account arguably already covers, which costs somebody
 * a moment's reading, rather than swallowing a real find.
 */
export function normalizeQueryText(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Every keyword the account holds, keyed by its normalised text, serving or
 *  not — the dedupe asks whether one EXISTS. Null in means null out: an unread
 *  list is not an empty account. */
export function keywordIndex(rows: ExistingKeyword[] | null | undefined): Map<string, ExistingKeyword[]> | null {
  if (rows == null) return null;
  const out = new Map<string, ExistingKeyword[]>();
  for (const k of rows) {
    const key = normalizeQueryText(k.text);
    if (!key) continue;
    out.set(key, [...(out.get(key) ?? []), k]);
  }
  return out;
}

export type PromotionSkipReason =
  /** The query is already in the account as a keyword, anywhere. */
  | "already_a_keyword"
  /** Under the conversion floor, the spend floor, or both. */
  | "below_floor"
  /** A pattern the client told us to leave alone. */
  | "protected";

/**
 * A converting query whose keyword exists and cannot serve.
 *
 * This is the case the 2026-09-23 review found, and it has to be carried
 * rather than folded into the already-a-keyword count, because the two ask for
 * opposite work. A live duplicate means there is nothing to do. This means the
 * account already decided to bid on the query and then switched the decision
 * off, and the money is being spent through a looser keyword in the meantime.
 */
export interface DormantMatch {
  term: string;
  campaignName: string;
  conversions: number;
  costMicros: number;
  /** Where the existing keyword sits, in words. */
  where: string;
  /** Which level is switched off, in words. */
  because: string;
}

export interface PromotedQuery {
  term: string;
  campaignId: string;
  campaignName: string;
  adGroupName: string | null;
  costMicros: number;
  clicks: number;
  conversions: number;
  allConversions: number;
  /** Cost per conversion on THIS query, in cents. Never null here: the floor
   *  guarantees at least two conversions, so the denominator is safe. */
  costPerConversionCents: number;
}

export interface CampaignPromotions {
  campaignId: string;
  campaignName: string;
  /** Dearest first, so the first line of the row is the biggest one. */
  queries: PromotedQuery[];
  totalCostMicros: number;
  totalConversions: number;
  lines: string[];
  metrics: Record<string, number>;
}

export type PromotionVerdict =
  /** There is at least one query worth promoting. */
  | "found"
  /** Looked, found none over the floors. */
  | "none"
  /** The account's keyword list could not be read, so nothing was checked. */
  | "keywords_unread"
  /** The conversion column is not counting business outcomes, so "this query
   *  converted" does not mean what the rule needs it to mean. */
  | "column_not_outcomes";

export interface PromotionReading {
  verdict: PromotionVerdict;
  byCampaign: CampaignPromotions[];
  /** Queries that cleared the floors and are already in the account, live ones
   *  and switched-off ones together. Counted so the row can say the check ran
   *  rather than leaving it to be assumed. */
  alreadyKeywords: number;
  /** …of which these are keywords that can serve today. Nothing to do. */
  alreadyServing: number;
  /**
   * …and these are keywords that exist and cannot serve. Named one by one,
   * because each is a decision somebody already made and then turned off, and
   * the fix is to turn it back on or move it rather than create a second copy.
   */
  dormant: DormantMatch[];
  /**
   * Queries whose keyword exists and whose serving status this run could not
   * read. Refused like any other match — a keyword nobody could confirm is
   * off is not a keyword to duplicate — and counted apart so the row never
   * claims it knows which of the two it was.
   */
  alreadyStateUnread: number;
  /** One clause naming why nothing was produced. Null where something was. */
  silence: string | null;
}

/**
 * What to say about the switched-off matches. One clause, naming the work.
 *
 * It never proposes creating the keyword. That is the whole point of the
 * reading: the account holds it already, so a second copy would compete with
 * the first the day somebody turns the first back on.
 */
export function dormantLine(dormant: DormantMatch[]): string | null {
  if (!dormant.length) return null;
  const listed = dormant.slice(0, 6).map((d) =>
    `"${d.term}" — ${d.conversions.toFixed(1)} conversion(s) on ${usd(d.costMicros)}, already a keyword: ${d.where}, but ${d.because}`);
  const rest = dormant.length > 6 ? ` …and ${dormant.length - 6} more.` : "";
  return `${dormant.length} converting quer${dormant.length === 1 ? "y is" : "ies are"} already in the account as a keyword that cannot serve. `
    + `Turning the existing keyword back on, or moving it into a live ad group, is the work here. Adding a second copy of it would `
    + `compete with the first as soon as anybody turns the first back on. ${listed.join("; ")}.${rest}`;
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

export interface PromotionInput {
  terms: PromotionQueryInput[];
  /**
   * Every keyword the account holds that has not been removed, whether or not
   * it can serve. NULL = the read failed, and nothing is proposed.
   *
   * Serving status does not decide whether a keyword EXISTS, and existence is
   * the only question the dedupe asks. What the status decides is what gets
   * said about a match: a live one means there is nothing to do, a switched-off
   * one means somebody already made this decision and turned it off.
   */
  existingKeywords: ExistingKeyword[] | null | undefined;
  /** `trackingReading().countsOutcomes`, composed rather than re-decided. */
  columnCountsOutcomes: "yes" | "no" | "unknown";
  /** Lowercased patterns the client has told us never to touch. */
  protectedPatterns: string[];
}

/**
 * Pure. Every converting query the account is not bidding on deliberately.
 *
 * ── WHY THE PRIMARY COLUMN AND NOT `all_conversions` ──────────────────────
 *
 * The waste rule reads BOTH, and correctly: any conversion at all, on any
 * action, is a reason not to block a query, because blocking traffic that
 * produces business is the expensive direction to be wrong in.
 *
 * This rule reads the primary column only, and the asymmetry is deliberate. A
 * query converting only on an action the account does not count is producing
 * something nobody here has decided is an outcome and nothing the bidding
 * optimises toward — which is a reason to leave it alone, not a reason to bid
 * on it harder. The all-conversions figure is carried into the evidence so the
 * difference is visible on the row.
 */
export function queryPromotions(i: PromotionInput): PromotionReading {
  const empty = {
    byCampaign: [] as CampaignPromotions[],
    alreadyKeywords: 0, alreadyServing: 0, dormant: [] as DormantMatch[], alreadyStateUnread: 0,
  };

  // A conversion on a column that counts page views is a page view. Bidding
  // deliberately on the queries that produce the most of them is the finding
  // doing active harm, so it is refused rather than qualified.
  if (i.columnCountsOutcomes !== "yes") {
    return {
      ...empty, verdict: "column_not_outcomes",
      silence: i.columnCountsOutcomes === "no"
        ? "Nothing is proposed as a keyword here: what this account counts as a conversion is not an enquiry, so a query that converted did not necessarily produce anything."
        : "Nothing is proposed as a keyword here: nothing confirms what this account's conversion column is counting, and a query is only worth bidding on deliberately if what it produced is something the client would count.",
    };
  }
  const index = keywordIndex(i.existingKeywords);
  if (index == null) {
    return {
      ...empty, verdict: "keywords_unread",
      silence: "Nothing is proposed as a keyword here: the account's keyword list could not be read, and a query cannot be called a gap in it without seeing it.",
    };
  }

  const protectedLower = i.protectedPatterns.map((p) => p.toLowerCase()).filter(Boolean);
  const isProtected = (text: string) => {
    const t = text.toLowerCase();
    return protectedLower.some((p) => t.includes(p) || p.includes(t));
  };

  let alreadyKeywords = 0;
  let alreadyServing = 0;
  let alreadyStateUnread = 0;
  const dormant: DormantMatch[] = [];
  const byCampaign = new Map<string, PromotedQuery[]>();
  for (const t of i.terms) {
    if (t.conversions < PROMOTE_MIN_CONVERSIONS) continue;
    if (t.costMicros < PROMOTE_MIN_COST_MICROS) continue;
    // A protected pattern is the client's instruction to leave those queries
    // where they are. Promoting one is a change to how it is bid, which is
    // inside that instruction even though it is not the blocking the
    // protection was written against.
    if (isProtected(t.term)) continue;
    // The account already holds this text as a keyword. Refused, whatever its
    // statuses say — proposing a second copy is the one mistake this rule must
    // not make, and a keyword in a paused ad group is still a keyword. Which
    // KIND of match it is decides what gets said about it afterwards.
    const existing = index.get(normalizeQueryText(t.term));
    if (existing && existing.length) {
      alreadyKeywords++;
      // Best state wins: one live copy means the account is bidding on this
      // deliberately today, whatever else sits switched off beside it.
      const states = existing.map(keywordCanServe);
      if (states.includes("yes")) {
        alreadyServing++;
      } else if (states.includes("unknown")) {
        alreadyStateUnread++;
      } else {
        const first = existing[0]!;
        dormant.push({
          term: t.term,
          campaignName: t.campaignName,
          conversions: t.conversions,
          costMicros: t.costMicros,
          where: keywordWhere(first),
          because: dormantBecause(first) ?? "it is switched off",
        });
      }
      continue;
    }
    byCampaign.set(t.campaignId, [...(byCampaign.get(t.campaignId) ?? []), {
      term: t.term,
      campaignId: t.campaignId,
      campaignName: t.campaignName,
      adGroupName: t.adGroupName,
      costMicros: t.costMicros,
      clicks: t.clicks,
      conversions: t.conversions,
      allConversions: t.allConversions,
      costPerConversionCents: Math.round(t.costMicros / 10_000 / t.conversions),
    }]);
  }

  const out: CampaignPromotions[] = [];
  for (const [campaignId, queries] of byCampaign) {
    const sorted = [...queries].sort((a, b) => b.costMicros - a.costMicros);
    const first = sorted[0]!;
    const totalCostMicros = sorted.reduce((s, q) => s + q.costMicros, 0);
    const totalConversions = sorted.reduce((s, q) => s + q.conversions, 0);
    out.push({
      campaignId,
      campaignName: first.campaignName,
      queries: sorted,
      totalCostMicros,
      totalConversions,
      lines: sorted.slice(0, 12).map((q) =>
        `${q.conversions.toFixed(1)} conversion(s) · ${usd(q.costMicros)} · ${q.clicks} clicks · $${(q.costPerConversionCents / 100).toFixed(2)} each · "${q.term}"`
        + (q.adGroupName ? ` (matched in "${q.adGroupName}")` : ""))
        .concat(sorted.length > 12 ? [`…and ${sorted.length - 12} more`] : []),
      metrics: {
        queryCount: sorted.length,
        costMicros: totalCostMicros,
        conversions: totalConversions,
        clicks: sorted.reduce((s, q) => s + q.clicks, 0),
      },
    });
  }
  // Campaign order is by money, so the row a person reads first is the one
  // holding the most of it. Ties break on the campaign id, which is stable, so
  // two runs over one account produce the same order.
  out.sort((a, b) => b.totalCostMicros - a.totalCostMicros || a.campaignId.localeCompare(b.campaignId));

  // Dearest first, so the sentence leads on the biggest one.
  dormant.sort((a, b) => b.costMicros - a.costMicros || a.term.localeCompare(b.term));

  return {
    verdict: out.length ? "found" : "none",
    byCampaign: out,
    alreadyKeywords, alreadyServing, dormant, alreadyStateUnread,
    // "Nothing to add" was true of a live duplicate and false of a switched-off
    // one, and the old sentence said it of both. Where the only matches are
    // switched off there IS work, so the silence names it rather than closing
    // the reading.
    silence: out.length
      ? null
      : dormant.length
        ? `Nothing here is worth adding as a new keyword. ${dormantLine(dormant)}`
        : "Every query over the floors is already in the account as a keyword that can serve, so there is nothing to add.",
  };
}

/**
 * What the row may honestly say the change buys. One paragraph, used as the
 * `impactAssumption`, and it claims no dollar.
 */
export function promotionClaim(c: CampaignPromotions, r: Pick<PromotionReading, "alreadyServing" | "dormant">): string {
  const alreadyKeywords = r.alreadyServing;
  return `No dollar figure, and the reason is arithmetic. ${c.queries.length === 1 ? "This query is" : `These ${c.queries.length} queries are`} already converting — `
    + `${c.totalConversions.toFixed(1)} conversion(s) on ${usd(c.totalCostMicros)} over 90 days — and those conversions are already counted in this `
    + `campaign's own performance. Making ${c.queries.length === 1 ? "the query into a keyword" : "the queries into keywords"} does not produce them a second time, so claiming their `
    + `value as the gain from the change would count the same conversion twice. What it buys is a bid, a match type and an ad group chosen for `
    + `${c.queries.length === 1 ? "this query" : "these queries"} rather than inherited from whatever looser keyword currently matches ${c.queries.length === 1 ? "it" : "them"}, and a reporting line of `
    + `${c.queries.length === 1 ? "its" : "their"} own. How much that is worth depends on the bid somebody sets, which is not a number this reads.`
    + (alreadyKeywords > 0
        ? ` ${alreadyKeywords} other converting quer${alreadyKeywords === 1 ? "y was" : "ies were"} checked and ${alreadyKeywords === 1 ? "is" : "are"} already in the account as a keyword that can serve, so there is nothing to do about ${alreadyKeywords === 1 ? "it" : "them"}.`
        : "")
    // Kept out of the count above rather than folded into it. "Already in the
    // account" reads as "nothing to do", and on a switched-off keyword there is
    // something to do.
    + (r.dormant.length > 0
        ? ` A further ${r.dormant.length} ${r.dormant.length === 1 ? "is" : "are"} in the account as a keyword that cannot serve, which is work of its own and is listed on this row.`
        : "");
}

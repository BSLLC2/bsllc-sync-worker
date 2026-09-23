/**
 * Demand this account already targets, is already relevant to, and is losing.
 *
 * Pure. Facts in, one reading out, in the style of `headroom` and
 * `biddingReadiness` next door.
 *
 * ── WHY THIS EXISTS, VERBATIM ─────────────────────────────────────────────
 *
 * The company owner, three times: "yes, cutting waste is great, but really i
 * want to grow at same time"; "does it help it grow ie recommending where to
 * expand budget to get more revenue"; and, reading one client's queue of
 * fifteen live findings, "i still don't think we're seeing growth
 * opportunities just optimization".
 *
 * He was right about that queue. Every row on it was stop-doing-something or
 * fix-something-broken, and two of them — the two that between them describe
 * the single largest growth lever on the account — read like hygiene:
 *
 *    "Assembly" loses 87.0% of impressions to Ad Rank, not budget
 *    "Brazing"  loses 80.2% of impressions to Ad Rank, not budget
 *
 * That is `rank_limited`, and it is a correct and useful row: it says more
 * budget will not fix this, the work is bids, ad relevance and landing pages.
 * What it does not say, and was never written to say, is HOW BIG THE THING IS.
 * Four fifths of the searches this client is already bidding on, already
 * relevant to, and already paying to compete for, are going to somebody else,
 * and nothing anywhere put a size on that.
 *
 * ── WHY NOT JUST PUT A FIGURE ON `rank_limited` ───────────────────────────
 *
 * Because they are two different claims with two different bases and this
 * codebase does not let one row carry both. `rank_limited` claims nothing and
 * says so (`estImpactCents: 0`, "recovering Ad Rank share depends on bid and
 * quality changes whose effect can't be modelled from impression share
 * alone"). That refusal is about the FIX — nothing here can say what a bid
 * change will do. This row is about the SIZE OF THE MARKET, which is a
 * different question and is answerable from the account's own numbers.
 *
 * So the two co-exist, and this one defers to that one for the fix, exactly as
 * `headroom` already defers to it (`rankRuleAlsoFired`). Nothing is duplicated:
 * this row never tells anybody how to raise Ad Rank.
 *
 * ── THREE TIERS OF CLAIM, AND EACH ONE NAMES WHAT IT NEEDS ────────────────
 *
 * The chain from a lost impression to a dollar has three links and this client
 * has only the first:
 *
 *   clicks — impressions, impression share and this campaign's own
 *            click-through rate. All three are platform facts and need no
 *            conversion column at all, so this tier is answerable on an
 *            account whose tracking is broken. It is the tier that fires here.
 *   leads  — needs the conversion column to be counting ENQUIRIES, and needs a
 *            denominator of at least one whole conversion. On the account
 *            above, one conversion action counts page views, so this tier is
 *            refused and says so.
 *   money  — needs a leads figure AND what a lead is worth to this client.
 *
 * A tier that cannot be reached is not estimated with a stand-in, is not
 * quietly dropped, and does not silence the tiers below it. It is NAMED —
 * `unpricedBecause` carries one sentence per missing input, and the finding
 * prints them. That is `budget_limited`'s own discipline, which already says
 * "nothing on this client's record says what one is worth, so there is nothing
 * to price them against. Record a customer value and a close rate and this
 * becomes a number."
 *
 * ── A PROJECTION, AND THE WORD IS PART OF THE FIGURE ──────────────────────
 *
 * A waste row claims money that is going out of the account right now, and
 * stopping it keeps it. This claims money that does not exist yet and may
 * never. The two must never be printed in the same voice, so this row's
 * `RANK_BASIS` is `projected` — the basis word `impact-rank.ts` already
 * carries for exactly this, and `rankedAmount` prints it beside every figure.
 * Nothing here borrows `recoverable`.
 *
 * ── NEVER MORE MONEY INTO SOMETHING THAT IS NOT WORKING ───────────────────
 *
 * The precondition is a refusal, not a caveat. A campaign whose conversions
 * already cost more than this client said one may cost gets NO row here at
 * all: more impressions on it buy more conversions at a price that is already
 * losing money, and `cpa_above_target` owns that campaign's conversation. Same
 * call `headroom` makes about `budget_rule_owns_it`, and the same call
 * `budget_limited` makes when it refuses to propose a rise on an over-target
 * campaign.
 *
 * Where the conversion column cannot be read, we do not KNOW whether the
 * campaign is working — which is a different answer from knowing it is. The
 * row is still raised, because the demand is real and measurable in clicks,
 * and it carries the precondition as its loudest line: settle what a
 * conversion is before buying more of these.
 *
 * ── NO API CHANGE, EVER ───────────────────────────────────────────────────
 *
 * Ad Rank is bid, expected click-through and landing-page experience. Bids
 * have no guarded path here by design and the quality half is ad copy and
 * landing pages. `applicability: "vendor"`.
 */

/** What `trackingReading()` said about the conversion column. Composed, never
 *  re-decided here — two answers to one question is how a screen starts
 *  disagreeing with itself. */
export type ColumnCountsOutcomes = "yes" | "no" | "unknown";

/**
 * Share of impressions lost to Ad Rank below which there is no row.
 *
 * It is DELIBERATELY the same figure as `THRESHOLDS.rankLostShare` (0.40) and
 * is passed in rather than imported, so this module has no runtime import back
 * into rules.ts and the two rules can never draw the line in different places.
 * Below it, a campaign is taking most of what it is bidding for and the growth
 * on this account is in new queries or new services, not in this campaign.
 */
export interface DemandCaptureInput {
  campaignId: string;
  campaignName: string;
  /** Decoded channel type, or null where the adapter did not read one. NULL IS
   *  NOT "not search": impression share is a search metric and a null channel
   *  is an unanswered question, so it is the presence of the share figures
   *  that decides, not a guess from a blank. */
  channelType: string | null;
  costMicros: number;
  clicks: number;
  impressions: number;
  conversions: number;
  impressionShare: number | null;
  rankLostShare: number | null;
  budgetLostShare: number | null;
  /** `trackingReading().countsOutcomes`. */
  columnCountsOutcomes: ColumnCountsOutcomes;
  /** The governing cost target and how it was arrived at, or null where the
   *  client has recorded neither a ceiling nor the figures a modelled one
   *  needs. Never invented here. */
  targetCents: number | null;
  targetBasis: "stated" | "modelled" | null;
  /** What one lead is worth, from the `modelled` cost target. Null where
   *  nobody has recorded a customer value or a close rate. */
  leadValueCents: number | null;
  /** Cost per conversion in cents, or null where the caller refused to work
   *  one out — an unreadable column, or a denominator under one. NEVER
   *  recomputed here. */
  costPerConversionCents: number | null;
  /** The share of the lost impressions we assume could actually be bought.
   *  The same haircut the budget rule applies, passed in so no two rules can
   *  print two different sizes for one campaign. */
  captureRate: number;
  /** The floor above which `rank_limited` raises its own row. */
  rankRuleFloor: number;
  /** Campaign spend floor, so a dormant campaign raises nothing. */
  minSpendMicros: number;
}

export type DemandCaptureVerdict =
  /** There is demand here, it is measurable, and the row is raised. */
  | "demand"
  /** Most of what it gives up is the daily cap, not Ad Rank. A different rule. */
  | "not_rank_limited"
  /** Its conversions already cost more than this client said one may cost.
   *  Buying more of them is buying more of a loss. SILENT. */
  | "over_target"
  /** Enough clicks to know, and none of them converted. `no_conversions` owns
   *  this campaign and nothing here proposes buying more of the same. SILENT. */
  | "converting_nothing"
  /** Too little spend or too few impressions to measure anything from. */
  | "too_small"
  /** A figure this needs was not reported. */
  | "cant_tell";

/** How far the chain got. Each step names what stopped it. */
export type DemandTier = "clicks" | "leads" | "money";

export interface DemandCaptureReading {
  campaignId: string;
  campaignName: string;
  verdict: DemandCaptureVerdict;
  /** The furthest tier this reading could honestly reach. Null when silent. */
  tier: DemandTier | null;
  rankLostShare: number | null;
  /** Impressions a month the account is losing to Ad Rank, before the haircut. */
  lostImpressions: number | null;
  /** …and the clicks that is worth at this campaign's own click-through rate,
   *  after the haircut. */
  extraClicks: number | null;
  /** Extra leads a month, only where the conversion column counts enquiries
   *  and there is at least one whole conversion to divide by. */
  extraLeads: number | null;
  /** What those leads are worth LESS what the clicks would cost, in cents.
   *  Null at every tier below `money`, and null where the arithmetic comes out
   *  at or under nought — a projection that loses money is not a growth
   *  finding and is never printed as one. */
  netValueCents: number | null;
  /** What buying those clicks would cost a month at today's cost per click. */
  extraSpendCents: number | null;
  /** One sentence per input that stopped the chain going further. Empty at
   *  `money`. */
  unpricedBecause: string[];
  /** What has to be true before anybody acts on this. Never empty on `demand`. */
  preconditions: string[];
  lines: string[];
  metrics: Record<string, number>;
  /** Why no row was raised, in one clause. Null on `demand`. */
  silence: string | null;
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Pure. One campaign's answer.
 *
 * Every verdict but `demand` is SILENT. A campaign taking most of what it
 * bids for is not a finding, and a row on every campaign saying whether it has
 * demand left is a row people learn to scroll past.
 */
export function demandCaptureReading(i: DemandCaptureInput): DemandCaptureReading {
  const base = {
    campaignId: i.campaignId, campaignName: i.campaignName,
    tier: null, rankLostShare: i.rankLostShare,
    lostImpressions: null, extraClicks: null, extraLeads: null,
    netValueCents: null, extraSpendCents: null,
    unpricedBecause: [] as string[], preconditions: [] as string[],
    lines: [] as string[], metrics: {} as Record<string, number>,
  };

  if (i.costMicros < i.minSpendMicros) {
    return { ...base, verdict: "too_small",
      silence: `No reading: ${usd(i.costMicros)} over the window is under the floor at which a campaign-level row is worth raising at all.` };
  }
  // A null is not a nought. Where the platform reported no share lost to Ad
  // Rank there is nothing to size, and 1 minus the impression share is lost to
  // SOMETHING — which of the two it is decides the entire recommendation.
  if (i.rankLostShare == null) {
    return { ...base, verdict: "cant_tell",
      silence: "No reading: the platform reported no share of impressions lost to Ad Rank for this campaign. Impression share is a search metric, so a campaign that is not a search campaign reports none and there is nothing here to size." };
  }
  if (i.impressionShare == null || i.impressionShare <= 0) {
    return { ...base, verdict: "cant_tell",
      silence: "No reading: the platform reported no impression share for this campaign, so there is no way to work out how many searches there were in total and nothing here invents one." };
  }
  if (i.impressions <= 0 || i.clicks <= 0) {
    return { ...base, verdict: "too_small",
      silence: "No reading: this campaign took no impressions or no clicks in the window, so it has no click-through rate of its own to project anything through." };
  }
  if (i.rankLostShare < i.rankRuleFloor) {
    return { ...base, verdict: "not_rank_limited",
      silence: `No reading: ${pct(i.rankLostShare)} of impressions go to Ad Rank, which is under the floor at which this is the campaign's biggest lever. What it gives up is mostly its daily cap or nothing at all, and the growth on this account is in queries and services it does not bid on yet rather than in this campaign.` };
  }

  // ── THE REFUSAL THAT MATTERS ────────────────────────────────────────────
  // A campaign whose conversions already cost more than this client said one
  // may cost gets nothing here. Buying more impressions on it buys more
  // conversions at a price that is already losing money, and `cpa_above_target`
  // owns that campaign's conversation with the evidence on it. There is no
  // flag that releases this and no tier that survives it.
  if (i.costPerConversionCents != null && i.targetCents != null
      && i.costPerConversionCents > i.targetCents) {
    return { ...base, verdict: "over_target",
      silence: `No reading: each conversion on this campaign costs ${money(i.costPerConversionCents)} against a ${money(i.targetCents)} `
        + `${i.targetBasis === "stated" ? "ceiling this client stated" : "figure modelled from this client's customer value and close rate"}. `
        + `There is demand here and it is not worth buying at that price — more impressions buy more conversions at a cost that already loses money on every one. `
        + `Bringing the cost per conversion under the target comes first, and the row that carries that is the one on this campaign's cost.` };
  }
  // Enough clicks to know, and nothing came back. `no_conversions` owns it and
  // nothing here proposes buying more of the same traffic.
  if (i.columnCountsOutcomes === "yes" && i.conversions === 0) {
    return { ...base, verdict: "converting_nothing",
      silence: `No reading: this campaign took ${i.clicks} clicks and converted none of them on a column that does count enquiries. Demand it is not capturing is not worth buying until the traffic it already buys produces something.` };
  }

  // ── TIER 1: CLICKS. Platform facts only — no conversion column needed. ──
  const availableImpressions = i.impressions / i.impressionShare;
  const lostImpressions = availableImpressions * i.rankLostShare;
  const ctr = i.clicks / i.impressions;
  const extraClicks = lostImpressions * i.captureRate * ctr;
  const cpcCents = Math.round(i.costMicros / 10_000 / i.clicks);
  const extraSpendCents = Math.round(extraClicks * cpcCents);

  let tier: DemandTier = "clicks";
  const unpricedBecause: string[] = [];
  const preconditions: string[] = [];

  // ── TIER 2: LEADS. Needs a column that counts enquiries, and a denominator
  // of at least one WHOLE conversion. `conversions` is a float and the
  // platform splits one conversion across the clicks it attributes it to, so a
  // denominator under one is refused rather than divided by — that exact
  // division is what turned a real account's cost per conversion into millions
  // of dollars.
  let extraLeads: number | null = null;
  if (i.columnCountsOutcomes !== "yes") {
    unpricedBecause.push(i.columnCountsOutcomes === "no"
      ? "No leads figure: what this account counts as a conversion is not an enquiry, so the rate it converts clicks at is the rate it produces page views at. Settle what a conversion is and this becomes a leads figure on the next audit."
      : "No leads figure: nothing confirms what this account's conversion column is counting, so nothing here can say what share of a click becomes an enquiry. Confirm the conversion actions and this becomes a leads figure on the next audit.");
  } else if (i.conversions < 1) {
    unpricedBecause.push(`No leads figure: ${round1(i.conversions)} conversions in the window is under one whole conversion, and a share of somebody else's conversion is not a rate anything may be divided by.`);
  } else {
    extraLeads = extraClicks * (i.conversions / i.clicks);
    tier = "leads";
  }

  // ── TIER 3: MONEY. Needs the leads figure AND what a lead is worth here.
  let netValueCents: number | null = null;
  if (extraLeads == null) {
    // Named once, at the tier that stopped. Repeating the conversion-column
    // sentence as a money refusal as well is the same finding said twice.
    unpricedBecause.push("No money figure either: it is the leads figure multiplied by what a lead is worth, and there is no leads figure to multiply.");
  } else if (i.leadValueCents == null || i.leadValueCents <= 0) {
    unpricedBecause.push("No money figure: nothing on this client's record says what one customer is worth or what share of leads become one, so extra leads cannot be turned into money. Record a customer value and a close rate and this becomes a figure.");
  } else {
    const gross = extraLeads * i.leadValueCents;
    const net = Math.round(gross - extraSpendCents);
    // A projection that loses money is not a growth finding. It is reported as
    // the arithmetic coming out against the change rather than printed as a
    // gain of nought, which would read as "no benefit" instead of "this costs
    // more than it returns".
    if (net > 0) { netValueCents = net; tier = "money"; }
    else {
      unpricedBecause.push(`No money figure: at ${money(cpcCents)} a click and ${money(i.leadValueCents)} a lead, buying this demand costs about ${money(extraSpendCents)} a month to return about ${money(Math.round(gross))}. The arithmetic comes out against it at today's prices, so nothing here claims a gain.`);
    }
  }

  // ── PRECONDITIONS. Never empty, and never a caveat in small print. ──────
  if (i.targetCents == null) {
    preconditions.push("Nothing on this client's record says what a conversion may cost, so nothing here has checked this campaign against a ceiling. Record a cost-per-lead ceiling, or a customer value and a close rate, before acting on the size of this.");
  }
  if (i.columnCountsOutcomes !== "yes") {
    preconditions.push("Settle the conversion column first. Until a conversion on this account is an enquiry, nothing can say these clicks are worth buying — only that they exist.");
  }
  preconditions.push("Ad Rank is bid, expected click-through and landing-page experience. Ad relevance and the landing page buy the same impressions without paying more for them, so they come first; the bid is the last lever, not the first.");
  if ((i.budgetLostShare ?? 0) > 0) {
    preconditions.push(`This campaign also gives up ${pct(i.budgetLostShare ?? 0)} of its impressions to its daily cap. Raising Ad Rank without the budget to serve the extra impressions buys nothing.`);
  }

  const lines: string[] = [
    `${usd(i.costMicros)} · ${i.impressions.toLocaleString()} impressions · ${i.clicks} clicks · ${pct(ctr)} click-through · ${money(cpcCents)} a click`,
    `Impression share ${pct(i.impressionShare)} — ${pct(i.rankLostShare)} lost to Ad Rank, ${pct(i.budgetLostShare ?? 0)} to the daily cap`,
    `About ${Math.round(lostImpressions).toLocaleString()} impressions a month go to somebody else on searches this campaign already bids on`,
    `At ${pct(i.captureRate)} of those and this campaign's own click-through rate, that is about ${round1(extraClicks)} more clicks a month, costing about ${money(extraSpendCents)} at today's cost per click`,
  ];
  if (extraLeads != null) {
    lines.push(`At the ${pct(i.conversions / i.clicks)} of clicks this campaign converts, that is about ${round1(extraLeads)} more enquiries a month`);
  }
  if (netValueCents != null && i.leadValueCents != null) {
    lines.push(`At ${money(i.leadValueCents)} a lead, less the ${money(extraSpendCents)} it costs to buy them, that is about ${money(netValueCents)} a month — projected, not recovered`);
  }

  return {
    campaignId: i.campaignId,
    campaignName: i.campaignName,
    verdict: "demand",
    tier,
    rankLostShare: i.rankLostShare,
    lostImpressions,
    extraClicks,
    extraLeads,
    netValueCents,
    extraSpendCents,
    unpricedBecause,
    preconditions,
    lines,
    metrics: {
      costMicros: i.costMicros,
      clicks: i.clicks,
      impressions: i.impressions,
      impressionShare: i.impressionShare,
      rankLostShare: i.rankLostShare,
      budgetLostShare: i.budgetLostShare ?? 0,
      clickThroughRate: ctr,
      costPerClickCents: cpcCents,
      lostImpressionsPerMonth: Math.round(lostImpressions),
      projectedExtraClicks: round1(extraClicks),
      projectedExtraSpendCents: extraSpendCents,
      ...(extraLeads != null ? { projectedExtraLeads: round1(extraLeads) } : {}),
      ...(netValueCents != null ? { projectedNetValueCents: netValueCents } : {}),
    },
    silence: null,
  };
}

/**
 * What the projection assumes, and every reason it is the optimistic end.
 * Used as the finding's `impactAssumption`, so the basis travels with the
 * figure wherever the figure is printed.
 */
export function demandCaptureClaim(r: DemandCaptureReading, captureRate: number): string {
  if (r.verdict !== "demand") return r.silence ?? "No figure claimed.";

  const head = `A PROJECTION, not money on the record and not a saving. It is worked out from this campaign's own numbers: `
    + `total searches from its impressions and its impression share, ${pct(captureRate)} of what it loses to Ad Rank as the share `
    + `anybody could realistically buy back, and its own click-through rate`
    + (r.extraLeads != null ? ` and its own conversion rate` : "")
    + `. Nothing has been changed and nothing is promised.`;

  const optimism = ` Both ends of it are optimistic. Impressions lost to Ad Rank are not demand handed over — they are auctions this campaign `
    + `is being outranked in, so they cost more per click than the ones it wins, and nothing says a searcher it is currently too cheap `
    + `or too slow to reach behaves like one it already gets. Read the figure as the size of the room, not as leads anybody has been promised.`;

  const tail = r.unpricedBecause.length ? ` ${r.unpricedBecause.join(" ")}` : "";

  return head + optimism + tail;
}

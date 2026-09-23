/**
 * Deterministic ads findings engine.
 *
 * THIS IS THE ONLY PLACE A FINDING IS DECIDED. Every threshold, waste floor and
 * impact calculation lives here as code, and the whole module is a pure
 * function of its inputs: given the same rows, two runs a week apart produce
 * byte-identical findings. That is the point. The complaint this whole feature
 * exists to fix was "the answer one day switches the next" — an LLM asked to
 * eyeball a data dump will genuinely produce a different answer each time, so
 * the numbers are not allowed anywhere near one.
 *
 * The LLM seam is `src/ads/narrative.ts`, which may rank, group and rewrite the
 * human-readable `title`/`summary` AFTER this module has decided what is true.
 * It never sees a threshold and never returns a number.
 *
 * VERSIONING: bump ADS_RULESET_VERSION whenever a threshold or an impact
 * formula changes, and bump the mirror in the dashboard's
 * shared/ads-findings.ts in the same change. Every finding records the version
 * that produced it, so a row can be read back against the rules of its day
 * rather than today's.
 */

import { createHash } from "node:crypto";
import {
  biddingReadiness, TARGET_STRATEGY_MIN_CONVERSIONS_30D,
  type BiddingReadiness, type ConversionLagRow,
} from "./bidding-readiness.js";
import { spendVisibility, coverageChangesTheClaim, type SpendVisibility } from "./spend-visibility.js";
import type { DailyConversionRow } from "./tracking-outage.js";
import { readinessFindings } from "./readiness-findings.js";
import {
  queryPromotions, promotionClaim,
  PROMOTE_MIN_CONVERSIONS, PROMOTE_MIN_COST_MICROS,
  type ExistingKeyword,
} from "./query-promotion.js";
import { headroomReading, headroomClaim } from "./headroom.js";
import { demandCaptureReading, demandCaptureClaim, type DemandCaptureReading } from "./demand-capture.js";
import { growthSilenceReading, growthSilenceClaim, type GrowthSilenceFact } from "./growth-silence.js";
import { sequenceFindings } from "./sequence.js";
import { keywordGaps, gapClaim, GAP_MIN_TERM_VOLUME, GAP_MIN_SERVICE_VOLUME, type ResearchFacts } from "./keyword-gap.js";
import type { ClientServiceFacts } from "./service-relevance.js";
import { trafficReadiness, CALL_TRACKING_PHONE_SHARE, type AdDestination, type PhoneDemandFacts } from "./traffic-readiness.js";
import { rankImpact, leadValueCents, type RankReading } from "./impact-rank.js";

/**
 * Bump on ANY threshold or impact-formula change. Mirror: shared/ads-findings.ts.
 *
 * 5: the growth half. Two new rules (a converting query that is not a keyword,
 * and a campaign converting under target with impressions still to buy) and a
 * pass that orders a campaign's findings rather than ranking them by size
 * alone. A finding records the version that produced it so a row can be read
 * back against the rules of its day, which is why this moves even though no
 * existing threshold changed.
 *
 * 6: the two readings that come from OUTSIDE the account — demand this client
 * sells into that nothing is bidding on (`keyword_gap`, gated on a confirmed
 * services list), and what has to exist before traffic is worth sending
 * (`generic_landing_page`, `call_tracking_absent`) — plus one measure every
 * finding is ranked on. `est_impact_cents` carried three units after version 5
 * and a single-column sort over it ordered nothing honestly; `rankImpact` puts
 * every row that can reach one into cents a month with the KIND of claim
 * attached, and `sequenceFindings` orders groups on that instead of on size.
 * No existing threshold moved and no existing figure changed.
 */
export const ADS_RULESET_VERSION = 6;

// ── Thresholds ───────────────────────────────────────────────────────────────
// Deliberately explicit and boring. Each one carries why it is where it is;
// a number nobody can justify is a number the next person will quietly change.
export const THRESHOLDS = {
  /** A search term must have burned this much over 90d, converting nothing,
   *  before it is worth a human's attention. Matches ads-audit.ts's original
   *  WASTE_FLOOR so existing findings don't shift under the new engine. */
  searchTermWasteMicros: 25_000_000,        // $25 / 90 days
  /** Keywords get a higher floor than search terms: a keyword is a deliberate
   *  choice someone made, so the bar to call it dead is higher. */
  keywordWasteMicros: 50_000_000,           // $50 / 90 days
  /** Below this, Google is charging a relevance premium on every click. */
  qualityScoreFloor: 5,
  /** Impression share lost to budget, above which a campaign is budget-capped. */
  budgetLostShare: 0.10,
  /** …and above which it is severe rather than worth watching. */
  budgetLostShareHigh: 0.25,
  /** Impression share lost to Ad Rank — a bid/quality problem, not a budget one. */
  rankLostShare: 0.40,
  /** Clicks a campaign must take in 30d before "zero conversions" means anything
   *  rather than being small-sample noise. */
  noConversionClicks: 100,
  /** Ad groups with fewer than this many enabled ads give Google nothing to test. */
  minAdsPerGroup: 2,
  /** Spend floor before a campaign-level finding is worth raising at all. */
  campaignMinSpendMicros: 10_000_000,       // $10 / 30 days
  /**
   * Account spend over the 90-day window before an ACCOUNT-level finding is
   * worth a row. Three of these rules (quality score, thin ad groups, weak ad
   * strength) had no floor at all, so a dormant account carrying $40 of
   * historical spend produced the same three rows as one spending $4,000 —
   * and a rule that fires on every account is a rule people learn to scroll
   * past. Set at $250/90d, which is under any account anybody is actively
   * managing and over every parked one.
   */
  accountMinSpendMicros: 250_000_000,       // $250 / 90 days
  /**
   * Account spend over the window before SILENCE in the conversion column is
   * read as a broken tag rather than as a quiet account. Below this, zero
   * conversions is what a small account looks like and asserting a defect
   * would be inventing one.
   */
  trackingSilenceMinSpendMicros: 100_000_000, // $100 / 90 days
  /**
   * Clicks before the conversions-per-click ratio is worth reading at all.
   * Two clicks and three conversions is arithmetic noise, not a mis-configured
   * conversion action.
   */
  trackingRatioMinClicks: 200,
  /**
   * Conversions per click at or above which the column is not counting
   * business outcomes. One is the ceiling for anything a person does once per
   * visit; above it the account is counting engagement, and Google's own
   * many-per-click counting on a page-view action is how it gets there. Set at
   * 1 rather than something lower because a genuine 40% call-conversion rate
   * exists and a 110% lead rate does not.
   */
  trackingImplausibleConvPerClick: 1.0,
  /**
   * An ad set's spend over the window before its learning state is worth a
   * row. A platform will happily report LEARNING_LIMITED on an ad set carrying
   * $6, which is true and is not a finding: it says the budget is small, which
   * the person who set the budget already knows.
   */
  learningAdSetMinSpendMicros: 50_000_000,   // $50 / 90 days
  /**
   * How far over the target a conversion has to cost before it is a finding.
   * A cost target is a round number somebody typed; a campaign within a
   * quarter of it is inside the noise of how that number was picked, and
   * raising a row against it teaches people the rule cries wolf.
   */
  cpaOverTargetRatio: 1.25,
} as const;

/**
 * How much of a wasted-spend finding we claim is actually recoverable.
 *
 * Not 100%. Some share of the spend on a zero-conversion term would have
 * converted eventually, some of it is brand defence, and some terms are
 * genuinely relevant and just need a better landing page. Claiming the full
 * number is how an agency ends up promising a saving it cannot deliver, so the
 * estimate is haircut here, once, in the open, and the haircut is stated on
 * every finding via `impactAssumption`.
 */
export const RECOVERY_RATE = 0.7;

/** Budget-limited campaigns: what share of the lost impressions we assume we
 *  would actually capture by raising budget. Impression share lost is not
 *  demand gained — the auction does not hand it over one-for-one. */
export const BUDGET_CAPTURE_RATE = 0.5;

// ── Inputs ───────────────────────────────────────────────────────────────────
// Platform-neutral shapes. Each adapter normalizes its own API into these, so
// the rules never contain a Google-shaped or Meta-shaped field name and a new
// platform costs an adapter, not a second rules engine.
export interface CampaignRow {
  id: string;
  name: string;
  channelType: string | null;
  dailyBudgetMicros: number;
  budgetResourceName: string | null;
  costMicros: number;
  clicks: number;
  impressions: number;
  conversions: number;
  /** Search impression share metrics. Null where the platform has no analogue. */
  impressionShare: number | null;
  budgetLostShare: number | null;
  rankLostShare: number | null;
  /**
   * Restricted-advertising categories the campaign runs under, verbatim
   * (Meta: HOUSING, EMPLOYMENT, CREDIT, ISSUES_ELECTIONS_POLITICS). NULL means
   * the adapter did not read it; [] means it read it and there are none.
   *
   * It is here because it changes what advice is HONEST rather than what is
   * possible: a campaign under one of these has age, gender and detailed
   * targeting stripped, so "broaden the audience" is not an option that exists
   * on it, and a row that says it anyway is a row somebody wastes an afternoon
   * on. Nothing here proposes a targeting change either way.
   *
   * Absent (like `tracking` below) means the adapter does not read it at all.
   */
  specialAdCategories?: string[] | null;
  /**
   * The platform's own resource name for the campaign. Only a data exclusion
   * needs it (it is scoped by resource name, not by id), so it is optional and
   * absent means the exclusion is not offered rather than guessed at.
   */
  resourceName?: string | null;
  /**
   * The bidding strategy the platform reports this campaign is on, already
   * decoded. NULL MEANS NOT REPORTED and is never read as manual: "we did not
   * read it" and "it needs no conversion volume" are opposite answers and only
   * one of them licenses a change.
   */
  bidStrategyType?: string | null;
  /** Does that strategy carry an actual target figure? Null = not reported.
   *  Maximize Conversions with no target is the recommended low-volume
   *  strategy; with one it carries the same volume floor as Target CPA. */
  hasBidTarget?: boolean | null;
}

/**
 * An ad set, and what the platform says about its own delivery model.
 *
 * Google has no analogue anybody can read: its learning phase is described in
 * support documentation and reported nowhere in the API, so a Google adapter
 * leaves this empty and every rule below simply produces nothing. Meta reports
 * it directly on the ad set (`learning_stage_info`), which is why this shape
 * exists at all — the reading it feeds is a reading of the PLATFORM'S OWN
 * verdict rather than one this engine works out from a convention.
 *
 * NULL EVERYWHERE MEANS "NOT READ", NEVER NOUGHT. An unread event count that
 * arrived as a nought would report every healthy ad set as starved.
 */
export interface AdSetRow {
  id: string;
  name: string;
  campaignId: string | null;
  campaignName: string | null;
  /** What the ad set is told to optimise for, verbatim. Null = not read. */
  optimizationGoal: string | null;
  /** The platform's own word for where this ad set is in its learning, verbatim
   *  (Meta: LEARNING / SUCCESS / LEARNING_LIMITED). Null = not read. */
  learningStatus: string | null;
  /** Optimisation events the platform counted toward its OWN threshold over its
   *  own window. Null = not read. */
  learningEvents: number | null;
  /**
   * The threshold the PLATFORM says this ad set has to clear, where it reports
   * one (Meta: `dynamic_lp_conversions_threshold`). Null means it did not, and
   * the reading falls back to the published convention and says which of the
   * two it used — a number we chose and a number the platform chose must never
   * render identically.
   */
  learningThreshold: number | null;
  costMicros: number;
  /** Delivery status, verbatim. Null = not read. */
  effectiveStatus: string | null;
}

export interface SearchTermRow {
  term: string;
  campaignId: string;
  campaignName: string;
  adGroupName: string | null;
  costMicros: number;
  clicks: number;
  conversions: number;
  /** all_conversions as well as conversions — a conversion action that is not
   *  marked primary counts in one and not the other, and calling a term dead on
   *  the narrower column alone proposes negatives for terms that are actually
   *  producing business. */
  allConversions: number;
}

export interface KeywordRow {
  criterionResourceName: string;
  text: string;
  matchType: string;
  qualityScore: number | null;
  campaignId: string;
  campaignName: string;
  adGroupName: string | null;
  costMicros: number;
  clicks: number;
  conversions: number;
  finalUrls: string[];
}

export interface AdGroupAdRow {
  adGroupId: string;
  adGroupName: string;
  campaignName: string;
  adId: string;
  adType: string | null;
  adStrength: string | null;
  /** The campaign this ad runs in. Null where the adapter does not report it;
   *  the landing-page reading is then silent for that ad rather than guessing
   *  which campaign it belongs to from a name. */
  campaignId?: string | null;
  /** Where a click on this ad lands, verbatim. NULL MEANS NOT READ — never
   *  "no landing page". An adapter that does not pull final URLs leaves it
   *  null and `trafficReadiness` answers `cant_tell`. */
  finalUrl?: string | null;
}

/**
 * A conversion action as the platform records it.
 *
 * Nothing here is inferred from a name. `category` is the platform's OWN
 * classification of what the action represents, which is the only recorded
 * field that answers "is a conversion on this account a business outcome or a
 * page view", and it is what the tracking reading below keys on.
 */
export interface ConversionActionRow {
  id: string;
  name: string;
  /** ENABLED / REMOVED / HIDDEN, verbatim. */
  status: string | null;
  /** LEAD, SUBMIT_LEAD_FORM, PAGE_VIEW, ENGAGEMENT, PURCHASE… verbatim. */
  category: string | null;
  /** WEBPAGE, GOOGLE_ANALYTICS_4_CUSTOM, UPLOAD_CLICKS… verbatim. */
  actionType: string | null;
  /** Is this action marked as counting toward the account's goal? Null where
   *  the platform does not report it — never read as false. */
  primaryForGoal: boolean | null;
  /**
   * Does this action actually count into the headline `conversions` column?
   * Google reports this directly (`conversion_action.include_in_conversions_metric`)
   * and it is the better answer: an action can be marked primary and still be
   * excluded, and the goals model can exclude one that nothing on the action
   * itself says anything about. Preferred over `primaryForGoal` where both are
   * reported. Null = not reported, never false.
   */
  countsIntoConversionsColumn: boolean | null;
  /**
   * Conversions attributed to this action over the evidence window.
   * NULL MEANS THE COUNT WAS NOT READ, never nought. The whole `primary_silent`
   * defect below is an argument from a nought, so an unread count that arrived
   * as one would invent a broken tag on a working account.
   */
  conversionsInWindow: number | null;
  /**
   * The default value set on the action, in the account's own currency. Null
   * where none is set OR where the field was not read — the two are the same
   * answer for this purpose, because both mean nothing here may claim a value
   * is already on the account.
   */
  defaultValue?: number | null;
  /** Does the action always use that default rather than a value the page
   *  sends? Null = not reported, never read as false. */
  alwaysUseDefaultValue?: boolean | null;
}

/**
 * What the account itself says about its conversion tracking.
 *
 * NULL EVERYWHERE MEANS "WE DID NOT READ IT", NEVER "THERE IS NONE". The two
 * are the same empty array otherwise, and the difference decides whether this
 * engine is allowed to propose blocking traffic — so `actions: null` (the read
 * failed) and `actions: []` (we read it and the account has none) are kept
 * apart all the way through.
 */
export interface TrackingFacts {
  /** The platform's own conversion-tracking status string. Null = not read. */
  status: string | null;
  /** Enabled conversion actions. Null = the read failed. [] = there are none. */
  actions: ConversionActionRow[] | null;
}

/**
 * What the CLIENT has recorded about what a customer is worth to them.
 *
 * Every field is nullable and a null is an unanswered question. The one trap
 * is `cplCeilingCents`: `client_targets.cpl_ceiling_cents` is `DEFAULT 0` and
 * the dialog that writes it says "leave a field at 0 to skip it", so a nought
 * there is a blank wearing a figure's clothes. It is resolved to null before
 * it reaches here — see `clientEconomicsFor` in src/ads/store.ts — and nothing
 * in this file may read a nought as a ceiling of nothing.
 */
export interface ClientEconomics {
  /** What one customer is worth. Null = nobody has answered. */
  customerValueCents: number | null;
  /** True only where the CLIENT supplied that value rather than us assuming
   *  it (clients.customer_value_source is set). It changes the sentence, not
   *  the arithmetic. */
  customerValueFromClient: boolean;
  /** Lead → customer rate, 0–100. Null = nobody has answered. */
  closeRatePct: number | null;
  /** The client's own cost-per-lead ceiling, above nought. Null = unanswered. */
  cplCeilingCents: number | null;
  /** The month that ceiling was typed for, so a stale one says how old it is. */
  cplCeilingMonth: string | null;
}

// ── The conversion column, and whether anything may be read off it ──────────
/**
 * Google's own categories for an action that is a business outcome.
 *
 * A purchase is not a lead, and for an ecommerce account it is the outcome
 * that matters — so this set is "something the client would count", not
 * "lead". Anything absent from BOTH this set and the one below is AMBIGUOUS
 * and is read as unknown rather than guessed either way: DOWNLOAD is a
 * whitepaper for one client and a brochure nobody reads for another, and
 * DEFAULT is Google's word for "the advertiser did not say".
 */
const OUTCOME_CATEGORIES = new Set([
  "LEAD", "SUBMIT_LEAD_FORM", "PHONE_CALL_LEAD", "IMPORTED_LEAD",
  "QUALIFIED_LEAD", "CONVERTED_LEAD", "BOOK_APPOINTMENT", "REQUEST_QUOTE",
  "CONTACT", "SIGNUP", "PURCHASE", "SUBSCRIBE_PAID",
]);

/**
 * Categories that are unarguably NOT a business outcome.
 *
 * Deliberately three. Each is Google's own word for somebody looking at a page,
 * doing something on a page, or leaving for another site — none of which any
 * client would call an enquiry. A longer list would start making judgements
 * about categories that are genuinely a real outcome for somebody (a store
 * visit for a retailer, directions for a restaurant), and this set is used to
 * REFUSE to compute money, so being wrong here is expensive.
 */
const NON_OUTCOME_CATEGORIES = new Set(["PAGE_VIEW", "ENGAGEMENT", "OUTBOUND_CLICK"]);

/** A defect the tracking reading found. Each one is its own finding row,
 *  because each has a different fix and a different person who does it. */
export type TrackingDefectKey =
  | "not_tracked" | "no_primary" | "primary_silent" | "primary_not_an_outcome" | "implausible_rate";

export interface TrackingDefect {
  key: TrackingDefectKey;
  title: string;
  summary: string;
  lines: string[];
  metrics: Record<string, number>;
}

/**
 * Two questions, and keeping them apart is the point.
 *
 *  countsAnything — does a nought in the conversion column mean a real nought?
 *                   This governs every waste rule, because "this term converted
 *                   nothing" and "nothing on this account is recorded" produce
 *                   the identical row and only one of them is a reason to block
 *                   traffic.
 *  countsOutcomes — is a conversion in that column something the client would
 *                   count? This governs every money claim, because a cost per
 *                   conversion computed over page views is the price of a page
 *                   view.
 *
 * "unknown" is a real answer for both and is never collapsed into either side.
 */
export interface TrackingReading {
  countsAnything: "yes" | "no" | "unknown";
  countsOutcomes: "yes" | "no" | "unknown";
  defects: TrackingDefect[];
  /** What could not be read, in words. Empty where everything was read. */
  unread: string[];
}

const fixed1 = (v: number) => v.toFixed(1);

/**
 * Pure. Facts in, one reading out.
 *
 * Nothing here looks at a campaign name, an action name or a title. It reads
 * the status the platform reports, the categories the platform assigned, what
 * those actions recorded, and the account's own click and conversion totals.
 */
export function trackingReading(
  facts: TrackingFacts | null | undefined,
  account: { costMicros: number; clicks: number; conversions: number },
): TrackingReading {
  const defects: TrackingDefect[] = [];
  const unread: string[] = [];
  const f = facts ?? { status: null, actions: null };

  const spentEnoughToJudgeSilence = account.costMicros >= THRESHOLDS.trackingSilenceMinSpendMicros;

  // The account-level switch. Google reports NOT_CONVERSION_TRACKED when no
  // conversion tracking is configured at all, by itself or by a manager.
  if (String(f.status ?? "").toUpperCase() === "NOT_CONVERSION_TRACKED") {
    defects.push({
      key: "not_tracked",
      title: "This account has no conversion tracking at all",
      summary: "The platform reports no conversion tracking configured. Every number anywhere that says this account "
        + "converts, or does not convert, is reading an empty column — including every campaign judgement in this audit.",
      lines: [
        `Conversion tracking status: ${f.status}`,
        `${usd(account.costMicros)} spent over the window with nowhere for a conversion to land`,
      ],
      metrics: { costMicros: account.costMicros, clicks: account.clicks, conversionActions: 0 },
    });
    return { countsAnything: "no", countsOutcomes: "no", defects, unread };
  }

  if (f.actions == null) {
    unread.push("the account's conversion actions could not be read, so nothing here can say whether its conversion column is trustworthy");
    return { countsAnything: "unknown", countsOutcomes: "unknown", defects, unread };
  }

  const enabled = f.actions.filter((a) => String(a.status ?? "ENABLED").toUpperCase() === "ENABLED");
  if (enabled.length === 0) {
    defects.push({
      key: "not_tracked",
      title: "No conversion action is switched on in this account",
      summary: "The account has no enabled conversion action, so there is nothing for a conversion to be recorded against. "
        + "Every campaign here will read as converting nothing however well it is working.",
      lines: [
        `${f.actions.length} conversion action(s) exist, none enabled`,
        `${usd(account.costMicros)} spent over the window`,
      ],
      metrics: { costMicros: account.costMicros, clicks: account.clicks, conversionActions: f.actions.length },
    });
    return { countsAnything: "no", countsOutcomes: "no", defects, unread };
  }

  // `primary_for_goal` is what decides whether an action counts into the
  // headline `conversions` column. Null means the platform did not report it,
  // which is not the same as false — so an account where nothing reports it is
  // unknown rather than broken.
  /** The platform's direct answer wherever it gave one, the goal flag otherwise.
   *  `include_in_conversions_metric` is what actually decides the column; an
   *  action can be primary and still excluded from it. */
  const counts = (a: ConversionActionRow): boolean | null =>
    a.countsIntoConversionsColumn != null ? a.countsIntoConversionsColumn : a.primaryForGoal;
  const reported = enabled.filter((a) => counts(a) != null);
  if (reported.length === 0) {
    unread.push("the platform did not say which conversion actions count toward the headline conversion column, so nothing here can check that one does");
  }
  const primary = enabled.filter((a) => counts(a) === true);

  if (reported.length > 0 && primary.length === 0) {
    defects.push({
      key: "no_primary",
      title: `${enabled.length} conversion actions are switched on and none of them counts`,
      summary: "Every enabled action on this account is marked secondary, so the conversion column stays at nought whatever "
        + "the site records. Campaigns read as converting nothing, bidding has nothing to optimise toward, and this audit "
        + "cannot tell a campaign that is working from one that is not.",
      lines: enabled.slice(0, 8).map((a) => `secondary · ${a.conversionsInWindow == null ? "count unread" : `${fixed1(a.conversionsInWindow)} recorded`} · "${a.name}"`),
      metrics: { costMicros: account.costMicros, enabledActions: enabled.length, primaryActions: 0 },
    });
    return { countsAnything: "no", countsOutcomes: "no", defects, unread };
  }

  const primarySet = primary.length > 0 ? primary : enabled;
  const countsRead = primarySet.filter((a) => a.conversionsInWindow != null);
  const primaryRecorded = countsRead.reduce((s2, a) => s2 + (a.conversionsInWindow ?? 0), 0);

  if (countsRead.length < primarySet.length) {
    unread.push("what each conversion action has actually recorded could not be read, so nothing here can tell a configured action from one nothing reaches");
    return { countsAnything: "unknown", countsOutcomes: "unknown", defects, unread };
  }

  if (primaryRecorded === 0) {
    if (!spentEnoughToJudgeSilence) {
      unread.push(`nothing has been recorded against this account's conversion actions, but only ${usd(account.costMicros)} has been spent over the window — too little to tell a broken tag from a quiet account`);
      return { countsAnything: "unknown", countsOutcomes: "unknown", defects, unread };
    }
    defects.push({
      key: "primary_silent",
      title: `${usd(account.costMicros)} spent and not one conversion has been recorded against any counting action`,
      summary: "The actions are configured and switched on, and nothing has reached them. That is what a tag removed from the "
        + "site, a form that changed, or a consent banner blocking the tag looks like. Check the tag fires end to end before "
        + "anybody reads a single conversion number on this account.",
      lines: primarySet.slice(0, 8).map((a) => `0 recorded · "${a.name}"${a.actionType ? ` (${a.actionType})` : ""}`)
        .concat([`${usd(account.costMicros)} · ${account.clicks} clicks over the window`]),
      metrics: { costMicros: account.costMicros, clicks: account.clicks, primaryActions: primarySet.length, recorded: 0 },
    });
    return { countsAnything: "no", countsOutcomes: "no", defects, unread };
  }

  // Something is being recorded. The remaining question is whether it is a
  // business outcome, which decides every money figure below.
  const outcome = primarySet.filter((a) => OUTCOME_CATEGORIES.has(String(a.category ?? "").toUpperCase()));
  const nonOutcome = primarySet.filter((a) => NON_OUTCOME_CATEGORIES.has(String(a.category ?? "").toUpperCase()));

  if (nonOutcome.length > 0) {
    const share = primaryRecorded > 0
      ? nonOutcome.reduce((s2, a) => s2 + (a.conversionsInWindow ?? 0), 0) / primaryRecorded : 0;
    defects.push({
      key: "primary_not_an_outcome",
      title: nonOutcome.length === primarySet.length
        ? "Everything this account counts as a conversion is a page view or an on-page action"
        : `${nonOutcome.length} of the actions counting into this account's conversions are page views, not enquiries`,
      summary: "The platform's own category on these actions is a page view, an engagement or a click away to another site. "
        + "None of those is an enquiry, so the conversion column is a count of browsing. Any cost per conversion read off it "
        + "is the price of a page view, and every campaign here looks like it is working.",
      lines: nonOutcome.slice(0, 8).map((a) => `${a.category} · ${fixed1(a.conversionsInWindow ?? 0)} recorded · "${a.name}"`)
        .concat(outcome.length ? [`${outcome.length} action(s) on this account do record an enquiry — the column mixes both`] : []),
      metrics: {
        costMicros: account.costMicros, primaryActions: primarySet.length,
        nonOutcomeActions: nonOutcome.length, nonOutcomeShare: share,
      },
    });
    return { countsAnything: "yes", countsOutcomes: "no", defects, unread };
  }

  // The categories did not settle it. The ratio is the fallback signal, and it
  // is only consulted here — where the category evidence is silent — because
  // the category is the better answer wherever it exists.
  const ratio = account.clicks > 0 ? account.conversions / account.clicks : 0;
  if (account.clicks >= THRESHOLDS.trackingRatioMinClicks && ratio >= THRESHOLDS.trackingImplausibleConvPerClick) {
    defects.push({
      key: "implausible_rate",
      title: `This account records ${fixed1(ratio)} conversions for every click`,
      summary: "More conversions than clicks is not a conversion rate, it is a column counting something that happens several "
        + "times a visit. An analytics property imported with every event switched on does exactly this. Until the counting is "
        + "settled, every cost per conversion on this account is the price of an event.",
      lines: [
        `${account.clicks} clicks · ${fixed1(account.conversions)} conversions over the window`,
        ...primarySet.slice(0, 6).map((a) => `${a.category ?? "uncategorised"} · ${fixed1(a.conversionsInWindow ?? 0)} recorded · "${a.name}"`),
      ],
      metrics: { clicks: account.clicks, conversions: account.conversions, convPerClick: ratio, costMicros: account.costMicros },
    });
    return { countsAnything: "yes", countsOutcomes: "no", defects, unread };
  }

  if (outcome.length === 0) {
    unread.push("none of the actions counting into this account's conversions carries a category that says what it is, so nothing here can confirm a conversion is an enquiry rather than a page view");
    return { countsAnything: "yes", countsOutcomes: "unknown", defects, unread };
  }

  return { countsAnything: "yes", countsOutcomes: "yes", defects, unread };
}

/**
 * One clause naming why a conversion figure was not worked out. Printed inside
 * a sentence, so it starts lower case and carries no full stop — a reading that
 * could not be taken has to say which part was missing, and "we could not look"
 * is a different answer from "there is nothing wrong".
 */
export function trackingCaveat(t: TrackingReading): string {
  if (t.countsAnything === "no") return "this account's conversion tracking is not recording anything";
  if (t.countsOutcomes === "no") return "what this account counts as a conversion is not an enquiry";
  if (t.unread.length) return t.unread[0]!;
  return "the conversion column could not be checked";
}


// ── What each platform's adapter actually supplies ──────────────────────────
/**
 * The rules are platform-neutral and must stay that way: a rule may not contain
 * a Google-shaped or Meta-shaped field name, and a new platform must cost an
 * adapter rather than a second engine. That principle has a hole in it, and
 * this table is the patch.
 *
 * TWO OF THE ACCOUNT-LEVEL RULES MADE A CLAIM THAT ONLY HELD ON GOOGLE.
 *
 *  - The conversion-tracking reading ends with "part of this could not be read"
 *    whenever an adapter supplies no `tracking`. On Google that is a real
 *    finding somebody closes by reading the account's settings. On Meta the
 *    adapter supplies none because META HAS NO SUCH OBJECT TO READ — its
 *    equivalent is a dataset, its pixel/CAPI events and their match quality,
 *    which is a different shape entirely. So the row would have appeared on
 *    every Meta account, every week, forever, saying a piece could not be read
 *    and naming a fix that would never produce it again.
 *  - The closed-outcome reading counts `web_inquiries.gclid`, and calls it "a
 *    Google click id" in the sentence a person reads. No lead row in this
 *    system carries Meta's click id (`fbclid`) — there is no column for one —
 *    so on a Meta account that reading is not thin, it is NOT A READING: it
 *    would report `no_click_ids` on every Meta account and tell somebody to go
 *    and fix Google auto-tagging.
 *
 * So each platform DECLARES what its adapter supplies, the rules ask, and a
 * rule that cannot be answered for a platform says nothing at all rather than
 * saying the Google answer. Silence here is not the same as the silence a
 * finding-free account produces: nothing was ever asked.
 *
 * DEFAULT-DENY for a platform nobody has declared, the same call
 * `shared/deal-pipeline.ts` makes about an unknown pipeline. A blocklist's
 * failure is a new platform quietly producing claims nobody checked; an
 * allowlist's failure is a platform producing nothing until somebody writes a
 * line here, which is visible the first time anybody looks at the screen.
 */
export interface PlatformSignals {
  /**
   * Does the adapter report a conversion-tracking CONFIGURATION this engine can
   * check — the actions, the platform's own category on each, and what each one
   * recorded? False is "there is no such thing to read here", not "the read
   * failed".
   */
  conversionConfig: boolean;
  /**
   * What a lead row in THIS SYSTEM carries for this platform's click
   * identifier, in the words a person would use. NULL means nothing here
   * captures one, so no reading of the click → customer chain can be taken at
   * all and none is attempted.
   */
  clickIdOnLead: string | null;
  /** Does the platform report impression share? */
  impressionShare: boolean;
  /** Does the platform report its own learning verdict per ad set? */
  learningState: boolean;
}

export const PLATFORM_SIGNALS: Record<string, PlatformSignals> = {
  google_ads: {
    conversionConfig: true,
    clickIdOnLead: "Google click id",
    impressionShare: true,
    // Google's learning period is documented in support pages and reported in
    // no API field. Asserting it would mean this engine inventing a verdict.
    learningState: false,
  },
  meta: {
    // Meta has conversion tracking; it does not have Google's conversion-action
    // object, and this adapter reads no equivalent. When somebody builds the
    // dataset/event-match reading, this flips and the row starts meaning
    // something.
    conversionConfig: false,
    // There is no fbclid column on web_inquiries. Not "it is usually empty" —
    // the column does not exist. See docs/agent-reports/meta-paid-media.md.
    clickIdOnLead: null,
    // Meta has no impression-share metric of any kind.
    impressionShare: false,
    // `learning_stage_info` on the ad set, which is the platform's own verdict.
    learningState: true,
  },
  microsoft: {
    // The adapter is a declared seam that throws on every verb.
    conversionConfig: false,
    clickIdOnLead: null,
    impressionShare: false,
    learningState: false,
  },
};

/** Nothing is claimed for a platform nobody has declared. */
const NO_SIGNALS: PlatformSignals = {
  conversionConfig: false, clickIdOnLead: null, impressionShare: false, learningState: false,
};

export function platformSignals(platform: string): PlatformSignals {
  return PLATFORM_SIGNALS[platform] ?? NO_SIGNALS;
}

// ── Can the platform's own delivery model learn on this ad set at all? ──────
/**
 * The published convention, used ONLY where the platform reported no threshold
 * of its own.
 *
 * It is widely quoted as ~50 optimisation events per ad set per rolling 7 days
 * on Meta, and it is a convention rather than something verified here — every
 * sentence built on it says so, the same discipline `MIN_MONTHLY_OUTCOMES_FOR_BIDDING`
 * already carries. Where Meta reports `dynamic_lp_conversions_threshold` that
 * figure is used instead and the sentence says it came from the platform.
 */
export const LEARNING_EVENTS_CONVENTION = 50;

export type LearningVerdict = "limited" | "learning" | "settled" | "unreadable";

export interface LearningReading {
  verdict: LearningVerdict;
  /** The platform's own word, verbatim, or null where it reported none. */
  status: string | null;
  events: number | null;
  /** Always resolved: the platform's own figure where it gave one, the
   *  convention otherwise. `thresholdFromPlatform` is what says which. */
  threshold: number;
  /** True where the threshold is the platform's own rather than the convention. */
  thresholdFromPlatform: boolean;
  /** How many more events a week it would take, where both figures are real. */
  shortBy: number | null;
  lines: string[];
}

/**
 * Pure. One ad set's facts in, one reading out.
 *
 * It reads the PLATFORM'S OWN verdict and never second-guesses it. A platform
 * that says SUCCESS is settled even where the event count looks thin to us, and
 * a platform that says LEARNING_LIMITED is limited even where the count looks
 * fine — it knows what its own model did with the events and this engine does
 * not. What the counts are for is saying HOW FAR SHORT, which is the part a
 * person can act on.
 */
export function learningReading(row: AdSetRow): LearningReading {
  const status = row.learningStatus == null ? null : String(row.learningStatus).toUpperCase();
  const thresholdFromPlatform = row.learningThreshold != null && row.learningThreshold > 0;
  const threshold = thresholdFromPlatform ? row.learningThreshold! : LEARNING_EVENTS_CONVENTION;
  const events = row.learningEvents;
  const shortBy = events != null ? Math.max(0, threshold - events) : null;

  const lines: string[] = [];
  lines.push(events != null
    ? `${events} optimisation event(s) counted against ${threshold}`
      + (thresholdFromPlatform
        ? ", which is the threshold the platform reports for this ad set"
        : `, which is the widely quoted convention and not a figure the platform gave us`)
    : "The platform reported no event count for this ad set, so how far short it is cannot be said");
  lines.push(row.optimizationGoal
    ? `Optimising for ${row.optimizationGoal} — only that event counts toward the threshold; everything else the ad set produces counts toward nothing`
    : "What this ad set optimises for was not read, and it is the only event that counts toward the threshold");
  lines.push(`${usd(row.costMicros)} spent over the window`);

  if (status == null) return { verdict: "unreadable", status, events, threshold, thresholdFromPlatform, shortBy, lines };
  if (status.includes("LIMITED")) return { verdict: "limited", status: row.learningStatus, events, threshold, thresholdFromPlatform, shortBy, lines };
  if (status === "SUCCESS") return { verdict: "settled", status: row.learningStatus, events, threshold, thresholdFromPlatform, shortBy, lines };
  return { verdict: "learning", status: row.learningStatus, events, threshold, thresholdFromPlatform, shortBy, lines };
}

// ── Can this account learn from its own closed outcomes at all? ─────────────
/**
 * What the record already holds about leads becoming customers.
 *
 * All of it is in Postgres and none of it is the ad platform's: web leads and
 * their click ids (`web_inquiries`), what the client's CRM did with them
 * (`lead_attributions`, written by match-web-leads-to-crm), and what has
 * already been sent back to a platform (`offline_conversion_uploads`).
 *
 * Every count is over a stated window and a null is "not read", never nought.
 */
export interface OutcomeFeedFacts {
  /** Leads captured in the window, and how many carry a Google click id. */
  leadsInWindow: number;
  gclidLeadsInWindow: number;
  /** The newest lead carrying a click id, YYYY-MM-DD. Null = there is none. */
  newestGclidLeadOn: string | null;
  /** Does anything tie this client's CRM records to leads we captured? */
  crmRowsInWindow: number;
  /** Of those, how many the CRM has closed as won, and over how many months. */
  wonInWindow: number;
  wonWindowMonths: number;
  /**
   * The average value of those won records, from the CRM's own amounts.
   * MEASURED. Null where the CRM recorded no amount — and it is never filled in
   * from `clients.customer_value_cents`, which on at least one account here is
   * explicitly our assumption rather than the client's figure.
   */
  measuredWonValueCents: number | null;
  /** Have we ever sent an outcome back to a platform for this client? */
  uploadsEver: number;
  newestUploadOn: string | null;
}

/**
 * THE VOLUME BAR, AND IT IS THE WHOLE ARGUMENT.
 *
 * Google's Smart Bidding learns from a conversion action's own volume. The
 * figure quoted everywhere for a target-cost strategy is about 30 conversions
 * in 30 days, and about 50 for a target-return one. **This is a widely cited
 * convention and not something verified here**, which is why it is named on
 * every sentence that leans on it rather than presented as a fact about the
 * platform.
 *
 * It matters because a CLOSED OUTCOME is a small number on this book. An
 * account closing a handful a month cannot hand a bidding strategy enough to
 * learn from, and pointing one at a sparse, months-lagging signal retrains it
 * on almost nothing. That is not a per-client quirk; it is arithmetic, and it
 * is the reason this reading exists.
 */
export const MIN_MONTHLY_OUTCOMES_FOR_BIDDING = 30;

export type OutcomeReadinessVerdict =
  /** The click id is not being captured, so nothing can be tied back at all. */
  | "no_click_ids"
  /** No CRM outcome reaches this client's record, so there is nothing to send. */
  | "no_outcomes"
  /** Both exist, and there are far too few closed outcomes to bid on. */
  | "too_thin_to_bid"
  /** Both exist at volume. Still a decision, never a recommendation. */
  | "enough_to_consider";

export interface OutcomeReadiness {
  verdict: OutcomeReadinessVerdict;
  /** Closed outcomes a month, from the CRM's own rows. Null where none. */
  outcomesPerMonth: number | null;
  /** What one is worth, measured from the CRM. Null = nobody has measured one. */
  measuredValueCents: number | null;
  /** What is missing, in order, each one a thing somebody can act on. */
  blockers: string[];
  lines: string[];
  metrics: Record<string, number>;
}

/**
 * Pure. Facts in, one reading out.
 *
 * It answers "could this account feed its closed outcomes back to the
 * platform", and it deliberately does NOT answer "should it". Nothing here
 * recommends changing what a bidding strategy optimises toward: that has been
 * tried on the one account that had the data and was rolled back, and a rule
 * that proposed it across a book of low-volume accounts would repeat that at
 * scale.
 */
export function outcomeReadiness(
  facts: OutcomeFeedFacts | null | undefined,
  economics: ClientEconomics | null | undefined,
): OutcomeReadiness | null {
  if (!facts) return null;
  const f = facts;
  const months = Math.max(1, f.wonWindowMonths);
  const perMonth = f.wonInWindow > 0 ? f.wonInWindow / months : null;
  const blockers: string[] = [];
  const lines: string[] = [];

  const clickShare = f.leadsInWindow > 0 ? f.gclidLeadsInWindow / f.leadsInWindow : 0;
  lines.push(f.gclidLeadsInWindow > 0
    ? `${f.gclidLeadsInWindow} of ${f.leadsInWindow} leads in the window carry a Google click id${f.newestGclidLeadOn ? `, the newest on ${f.newestGclidLeadOn}` : ""}`
    : `Not one of the ${f.leadsInWindow} leads in the window carries a Google click id`);
  lines.push(f.crmRowsInWindow > 0
    ? `${f.crmRowsInWindow} of them reached the client's CRM, and ${f.wonInWindow} closed as won over ${months} month(s)`
    : "None of them reaches a CRM record we can read");
  lines.push(f.measuredWonValueCents != null
    ? `Those wins average $${(f.measuredWonValueCents / 100).toFixed(2)} on the CRM's own amounts`
    : "The CRM records no amount on those wins, so nothing here has measured what one is worth");
  if (f.uploadsEver > 0) {
    lines.push(`${f.uploadsEver} outcome(s) have already been sent back to a platform for this client${f.newestUploadOn ? `, the newest on ${f.newestUploadOn}` : ""}`);
  }

  if (f.gclidLeadsInWindow === 0) {
    blockers.push("Auto-tagging or the form is not passing the Google click id through to the lead. Nothing can tie a customer back to a click until it does, and a click id not captured today cannot be recovered later.");
    return {
      verdict: "no_click_ids", outcomesPerMonth: perMonth, measuredValueCents: f.measuredWonValueCents,
      blockers, lines,
      metrics: { leads: f.leadsInWindow, gclidLeads: 0, crmRows: f.crmRowsInWindow, won: f.wonInWindow },
    };
  }
  if (clickShare < 0.25) {
    blockers.push(`Only ${Math.round(clickShare * 100)}% of leads carry a click id, so at best that share of outcomes could ever be tied back.`);
  }

  if (f.crmRowsInWindow === 0 || f.wonInWindow === 0) {
    blockers.push(f.crmRowsInWindow === 0
      ? "No CRM record on this client is tied to a lead we captured, so there is no closed outcome to send back. Either the CRM is not connected, or the matcher is finding nothing."
      : "The CRM holds matched leads and has closed none of them as won in the window, so there is nothing to send back yet.");
    return {
      verdict: "no_outcomes", outcomesPerMonth: perMonth, measuredValueCents: f.measuredWonValueCents,
      blockers, lines,
      metrics: { leads: f.leadsInWindow, gclidLeads: f.gclidLeadsInWindow, crmRows: f.crmRowsInWindow, won: f.wonInWindow },
    };
  }

  if (f.measuredWonValueCents == null) {
    blockers.push("Nothing has measured what one of these outcomes is worth. A figure on the client record is not a measurement unless the client supplied it"
      + `${economics && economics.customerValueCents != null && !economics.customerValueFromClient ? " — and the one recorded here is ours, not theirs" : ""}`
      + ", and sending an assumed value teaches the platform a preference nobody measured.");
  }

  const thin = (perMonth ?? 0) < MIN_MONTHLY_OUTCOMES_FOR_BIDDING;
  return {
    verdict: thin ? "too_thin_to_bid" : "enough_to_consider",
    outcomesPerMonth: perMonth,
    measuredValueCents: f.measuredWonValueCents,
    blockers,
    lines,
    metrics: {
      leads: f.leadsInWindow, gclidLeads: f.gclidLeadsInWindow,
      crmRows: f.crmRowsInWindow, won: f.wonInWindow,
      outcomesPerMonth: perMonth ?? 0,
    },
  };
}

// ── What a conversion is allowed to cost ────────────────────────────────────
/**
 * Two kinds of target, never blended and never summed.
 *
 *  stated   — the client's own cost-per-lead ceiling. Their instruction.
 *  modelled — what a lead is worth to them: customer value x close rate. Not an
 *             instruction, arithmetic, and the word "estimated" is part of the
 *             number rather than a caveat somewhere else.
 *
 * Where both exist the STATED one decides the verdict, because it is what
 * somebody asked for, and the modelled figure is carried beside it as its own
 * line. There is no average of the two and no fallback from one to the other:
 * substituting an assumed figure for a missing stated one produces a number
 * that renders identically to the client's own answer.
 */
export type CostTargetBasis = "stated" | "modelled";

export interface CostTarget {
  cents: number;
  basis: CostTargetBasis;
  /** The whole sentence the figure is printed with. Never a bare number. */
  line: string;
}

export function costTargets(e: ClientEconomics | null | undefined): CostTarget[] {
  const out: CostTarget[] = [];
  if (!e) return out;
  if (e.cplCeilingCents != null && e.cplCeilingCents > 0) {
    out.push({
      cents: e.cplCeilingCents,
      basis: "stated",
      line: `$${(e.cplCeilingCents / 100).toFixed(2)} is the cost-per-lead ceiling recorded for this client`
        + `${e.cplCeilingMonth ? ` (typed for ${e.cplCeilingMonth})` : ""}.`,
    });
  }
  if (e.customerValueCents != null && e.customerValueCents > 0 && e.closeRatePct != null && e.closeRatePct > 0) {
    const cents = Math.round(e.customerValueCents * (e.closeRatePct / 100));
    out.push({
      cents,
      basis: "modelled",
      line: `Estimated: a lead is worth about $${(cents / 100).toFixed(2)} — $${(e.customerValueCents / 100).toFixed(2)} a customer `
        + `at the ${e.closeRatePct}% close rate on record, ${e.customerValueFromClient ? "on a customer value the client gave us" : "on a customer value we assumed"}. `
        + `Spending more than that on a lead loses money on every one.`,
    });
  }
  return out;
}

/** Which target decides a verdict: the client's own instruction wherever they
 *  gave one, never an estimate standing in for it. */
export function governingTarget(targets: CostTarget[]): CostTarget | null {
  return targets.find((t) => t.basis === "stated") ?? targets.find((t) => t.basis === "modelled") ?? null;
}

/**
 * Is this search term already blocked by a negative we hold?
 *
 * Exact matching is not enough and was a real bug: a PHRASE negative
 * "service jobs" already blocks the query "service jobs hiring", so proposing
 * that query as a fresh negative is a duplicate — it clutters the account and,
 * worse, puts an item in front of a human that does nothing when approved.
 * `ads-audit.ts` had this problem from the start; the verification harness is
 * what surfaced it.
 *
 * We do not know each negative's match type here (the account-wide negatives
 * pull is a flat list of texts), so this deliberately uses the CONSERVATIVE
 * reading: a term is treated as covered when a negative appears in it as a
 * contiguous run of whole words. Being conservative only ever means proposing
 * FEWER negatives — it can never cause us to block traffic we wanted, which is
 * the expensive direction to be wrong in.
 */
export function alreadyNegated(term: string, negatives: Set<string>): boolean {
  const t = ` ${term.toLowerCase().replace(/\s+/g, " ").trim()} `;
  for (const n of negatives) {
    const neg = n.toLowerCase().replace(/\s+/g, " ").trim();
    if (!neg) continue;
    if (t.includes(` ${neg} `)) return true;
  }
  return false;
}

export interface AuditInput {
  platform: "google_ads" | "meta" | "microsoft";
  accountId: string;
  /** Inclusive YYYY-MM-DD bounds of the long (90-day) evidence window. */
  windowStart: string;
  windowEnd: string;
  campaigns: CampaignRow[];
  /**
   * Ad sets and the platform's own learning verdict. ABSENT MEANS THE ADAPTER
   * DOES NOT READ THEM — Google reports no learning state anywhere in its API,
   * so its adapter leaves this out and the learning rule produces nothing.
   */
  adSets?: AdSetRow[];
  searchTerms: SearchTermRow[];
  keywords: KeywordRow[];
  ads: AdGroupAdRow[];
  /** Lowercased negative keyword texts already in the account. */
  existingNegatives: Set<string>;
  /** Campaign names we must never touch (client-protected brand/partner terms). */
  protectedPatterns: string[];
  /**
   * What the account says about its own conversion tracking. ABSENT MEANS THE
   * ADAPTER DID NOT READ IT, which is a different answer from "there is none"
   * and is treated as such everywhere below — an adapter that has no analogue
   * (Meta here) simply leaves it out and every conversion-dependent proposal
   * is held back rather than made on a column nobody checked.
   */
  tracking?: TrackingFacts | null;
  /**
   * What the record holds about this client's leads becoming customers. Read
   * from Postgres by the caller, not from the ad platform. Absent means it was
   * not gathered, never that there are none.
   */
  outcomes?: OutcomeFeedFacts | null;
  /**
   * What the client has recorded about what a customer is worth. Absent means
   * nobody has answered; it is never filled in with an assumption.
   */
  economics?: ClientEconomics | null;
  /**
   * The platform's own segmentation of how long after a click its conversions
   * arrive, per campaign. ABSENT MEANS NOT READ — an adapter with no analogue
   * (Meta here) simply leaves it out, and every reading that leans on lag says
   * it could not be taken rather than calling the account fast.
   */
  conversionLag?: ConversionLagRow[] | null;
  /**
   * Day by day, what the account took and what it recorded. Read only so the
   * conversion column's silence can be given a START AND AN END: without those
   * two dates there is nothing to tell the platform to ignore. Absent = not read.
   */
  dailyConversions?: DailyConversionRow[] | null;
  /**
   * Spend the search-terms report accounts for, per campaign id, over the SAME
   * window as the campaign figures above. That sameness is the whole point — a
   * 90-day term total against a 30-day campaign total is not a coverage share,
   * it is two numbers divided. Absent = the report was not read.
   */
  searchTermSpendByCampaign?: Record<string, number> | null;
  /**
   * EVERY enabled keyword in the account, as a settings read rather than a
   * performance one. ABSENT OR NULL MEANS THE READ FAILED, and the promotion
   * rule then proposes nothing at all: a query cannot be called a gap in a
   * keyword list nobody could see.
   *
   * It is a separate input from `keywords` above deliberately. That pull is
   * filtered to `cost_micros > 0` and capped at 300 rows, so a keyword that
   * took no clicks in the window is missing from it — and proposing a keyword
   * the account already holds is the one mistake this rule must not make.
   */
  existingKeywords?: ExistingKeyword[] | null;
  /**
   * What a named person confirmed this client actually sells. Read from
   * Postgres by the caller, not from the ad platform — it is not the platform's
   * to know. ABSENT means it was not gathered; `services: null` inside it means
   * nobody has confirmed a list, and the keyword-gap reading refuses on both.
   */
  services?: ClientServiceFacts | null;
  /**
   * The keyword research already stored for this client (the worker's own
   * `run-research` job, DataForSEO Labs, written into
   * `research_requests.result_json`). NOTHING HERE CALLS DATAFORSEO: this is a
   * Postgres read of what that job stored on somebody's instruction. Absent or
   * null keywords = no research on record, which is a named silence rather
   * than an empty gap list.
   */
  research?: ResearchFacts | null;
  /**
   * How this client's enquiries actually arrive, from their own lead feed.
   * Postgres again, and absent means it was not read. It exists for one
   * question — can this account count a phone call at all — and is never read
   * as nought.
   */
  phone?: PhoneDemandFacts | null;
}

// ── Output ───────────────────────────────────────────────────────────────────
export interface DerivedFinding {
  entityType: "campaign" | "ad_group" | "keyword" | "search_term" | "ad" | "asset" | "account";
  /** Stable identity. A platform resource id where one exists; otherwise a
   *  normalized natural key scoped to its parent, because a search term has no
   *  id and we still need the same term next week to land on the same row. */
  entityId: string;
  entityName: string;
  /**
   * Which campaign this finding is about, where it is about one. Null on an
   * account-level row, and never parsed back out of `entityId` — several rules
   * suffix that (`:cost_target`, `:wasted_terms`) so it is not a campaign id.
   *
   * It exists for `sequenceFindings`, which has to read one campaign's findings
   * together and cannot do it from a name: two accounts can run campaigns with
   * the same name and an id cannot collide.
   */
  campaignId?: string | null;
  findingType: string;
  severity: "high" | "medium" | "low";
  riskLevel: "low" | "medium" | "high";
  applicability: "api" | "vendor";
  title: string;
  summary: string;
  evidence: { metrics: Record<string, number>; windowStart: string; windowEnd: string; lines: string[] };
  /** Monthly impact in CENTS (or leads × 100 when impactUnit is leads_month). */
  estImpactCents: number;
  impactUnit: "usd_month" | "leads_month";
  impactAssumption: string;
  changePayload: { op: string; body: unknown; plainEnglish: string; guard: string } | null;
  guardNote: string;
  /**
   * Money a month already riding on the thing this row is about, in cents.
   *
   * Set ONLY by the rules whose `RANK_BASIS` is `at_stake`, and set explicitly
   * rather than inferred from `estImpactCents` — on a `converting_search_term`
   * that column is deliberately nought, and reading a nought as the size is
   * exactly the defect the ranking exists to fix.
   */
  atStakeCents?: number | null;
  /**
   * Where this row sits in one order, and what kind of claim its figure is.
   * Filled by the rank pass at the end of `evaluate`; absent on a finding that
   * has not been through it.
   */
  rank?: RankReading;
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
/** Micros → cents, the unit the findings table stores impact in. */
const microsToCents = (micros: number) => Math.round(micros / 10_000);

// ── Evidence hashing ─────────────────────────────────────────────────────────
/**
 * A stable fingerprint of the numbers behind a finding, BUCKETED before
 * hashing. Bucketing is the whole trick: spend drifting from $312.40 to $314.90
 * is the same finding and must not look like new evidence, or a dismissed
 * finding would resurrect itself every single week and we would be right back
 * to the flip-flopping this feature exists to stop. Money is bucketed to $10,
 * rates to 5 points, counts to 10.
 */
export function evidenceHash(metrics: Record<string, number>): string {
  const bucketed = Object.keys(metrics).sort().map((k) => {
    const v = metrics[k] ?? 0;
    if (k.endsWith("Micros")) return `${k}:${Math.round(v / 10_000_000)}`;   // $10 buckets
    if (k.endsWith("Share") || k.endsWith("Rate")) return `${k}:${Math.round(v * 20)}`; // 5pt buckets
    return `${k}:${Math.round(v / 10)}`;                                      // 10-unit buckets
  });
  return createHash("sha1").update(bucketed.join("|")).digest("hex").slice(0, 16);
}

/**
 * Has the evidence moved enough to justify re-raising something a human already
 * dismissed? Only the bucketed hash is consulted — so "we looked at this and
 * said no" survives ordinary week-to-week noise, and is overridden only when
 * the facts genuinely changed.
 */
export function materiallyChanged(previousHash: string | null, nextHash: string): boolean {
  return Boolean(previousHash) && previousHash !== nextHash;
}

// ── The rules ────────────────────────────────────────────────────────────────
/**
 * Pure. No I/O, no clock, no randomness. Everything it needs is in `input`,
 * which is why the same input always yields the same findings.
 */
export function evaluate(input: AuditInput): DerivedFinding[] {
  const out: DerivedFinding[] = [];
  const { windowStart, windowEnd } = input;
  const win = { windowStart, windowEnd };
  const protectedLower = input.protectedPatterns.map((p) => p.toLowerCase()).filter(Boolean);
  const isProtected = (text: string) => {
    const t = text.toLowerCase();
    return protectedLower.some((p) => t.includes(p) || p.includes(t));
  };

  // ── 0. Can anything be read off the conversion column at all? ─────────────
  // Every rule below judges a campaign, a term or a keyword on "converted" or
  // "converted nothing". Where the column is broken those two are the same
  // row, so this reading runs FIRST and the rules that would act on a nought
  // ask it before they do.
  const accountTotals = input.campaigns.reduce(
    (t, c) => ({
      costMicros: t.costMicros + c.costMicros,
      clicks: t.clicks + c.clicks,
      conversions: t.conversions + c.conversions,
    }),
    { costMicros: 0, clicks: 0, conversions: 0 },
  );
  const signals = platformSignals(input.platform);
  const tracking = trackingReading(input.tracking, accountTotals);
  /** A nought in the conversion column means a real nought. */
  const zeroMeansZero = tracking.countsAnything === "yes";
  /** A conversion in that column is something the client would count, so money
   *  may be divided by it. */
  const costPerOutcomeReadable = tracking.countsOutcomes === "yes";
  /**
   * CAN EACH CAMPAIGN'S BIDDING LEARN FROM WHAT IT GETS?
   *
   * Every published threshold for a target-based strategy is a conversion
   * count PER CAMPAIGN PER 30 DAYS, and nothing in this engine computed it
   * until now. The reading is built once here and consulted by the rules
   * below rather than re-decided in each of them, for the same reason the
   * tracking reading is: two answers to one question is how a screen starts
   * disagreeing with itself.
   */
  const biddingByCampaign = new Map<string, BiddingReadiness>();
  for (const c of input.campaigns) {
    biddingByCampaign.set(c.id, biddingReadiness(
      {
        campaignId: c.id, campaignName: c.name,
        strategyType: c.bidStrategyType ?? null,
        hasTarget: c.hasBidTarget ?? null,
        conversions30d: tracking.countsAnything === "unknown" ? null : c.conversions,
        costMicros30d: c.costMicros,
      },
      input.conversionLag,
      tracking.countsAnything,
    ));
  }

  /**
   * HOW MUCH OF EACH CAMPAIGN'S MONEY THE SEARCH-TERMS REPORT SHOWS.
   *
   * Every query-based figure below is worked out over the terms the platform
   * chose to show, and it has never said what share of the spend that was.
   */
  const visibility = new Map<string, SpendVisibility>();
  for (const c of input.campaigns) {
    visibility.set(c.id, spendVisibility({
      campaignId: c.id, campaignName: c.name, channelType: c.channelType,
      reportedTermCostMicros: input.searchTermSpendByCampaign
        ? (input.searchTermSpendByCampaign[c.id] ?? 0)
        : null,
      campaignCostMicros: c.costMicros,
    }));
  }

  const targets = costTargets(input.economics);
  const target = governingTarget(targets);
  /** Printed under every figure that leaned on a target, and under every one
   *  that could not lean on one. A missing target is named, never passed over. */
  const targetLines = targets.length
    ? targets.map((t) => t.line)
    : ["No cost-per-lead ceiling and no customer value are recorded for this client, so nothing here can say whether what a conversion costs is acceptable — only what it costs."];

  /** What a lead is worth here, off the `modelled` cost target rather than
   *  recomputed, so a lead is worth the same in a growth projection as it is in
   *  every cost target this engine prints. Null where nobody has recorded one. */
  const perLeadCents = leadValueCents(targets);
  /** Every campaign's demand reading, kept so the growth-silence row at the
   *  end can say which of them refused and why. */
  const demandReadings: DemandCaptureReading[] = [];
  /** …and every campaign's headroom reading, for the same reason. Both are
   *  collected rather than re-run: a second pass would be a second answer. */
  const headroomReadings: { verdict: string; silence: string | null }[] = [];

  // ── 1. Campaign-level: budget-limited, rank-limited, converting nothing ────
  for (const c of input.campaigns) {
    if (c.costMicros < THRESHOLDS.campaignMinSpendMicros) continue;

    /** Cost per conversion, in cents, or null where it may not be computed.
     *  `conversions` is a float and the platform splits one conversion across
     *  clicks, so a denominator under one is refused rather than divided by —
     *  it turns a $400 campaign into a $40,000 cost per conversion. */
    const cpaCents = costPerOutcomeReadable && c.conversions >= 1
      ? Math.round(microsToCents(c.costMicros) / c.conversions)
      : null;
    /** Over target by enough to be a finding rather than rounding. */
    const overTarget = cpaCents != null && target != null
      && cpaCents > Math.round(target.cents * THRESHOLDS.cpaOverTargetRatio);
    const underTarget = cpaCents != null && target != null && cpaCents <= target.cents;

    const budgetLost = c.budgetLostShare ?? 0;
    if (budgetLost > THRESHOLDS.budgetLostShare) {
      const converting = zeroMeansZero && c.conversions > 0;
      // Extra spend the campaign could take at today's cost per click if the
      // budget stopped capping it. THIS IS SPEND, NOT A BENEFIT — see below.
      const upliftMicros = Math.round(c.costMicros * budgetLost * BUDGET_CAPTURE_RATE);
      const upliftSpendCents = microsToCents(upliftMicros);
      const newDailyUsd = Math.round((c.dailyBudgetMicros / 1_000_000) * 1.25 * 100) / 100;

      // ── What the extra budget is actually worth ──────────────────────────
      // Until this version the impact on a budget-capped campaign WAS the
      // extra spend: `cost x share lost x capture rate`, written into
      // est_impact_cents and ranked against real savings. Spending more money
      // is not a benefit, and a queue ordered by how much more we could spend
      // puts the biggest budget at the top whatever it returns.
      //
      // A dollar figure is claimed here only where the arithmetic exists to
      // reach one: extra spend, divided by what a conversion costs, times what
      // a lead is worth to this client, less the spend. Every one of those is
      // a recorded number or the figure is not claimed at all.
      const modelled = targets.find((t) => t.basis === "modelled") ?? null;
      const extraConversions = cpaCents != null && cpaCents > 0 ? upliftSpendCents / cpaCents : null;
      const netCents = modelled && extraConversions != null
        ? Math.round(extraConversions * modelled.cents - upliftSpendCents)
        : null;
      const claimCents = netCents != null && netCents > 0 ? netCents : 0;

      // A campaign whose conversions cost more than the client's own ceiling
      // gets NO proposal to spend more. This is the whole point of reading the
      // goal: at identical impression-share numbers, a campaign hitting the
      // target and one running at three times it are opposite recommendations.
      // THE BIDDING GATE. A budget step of a quarter is over the size at which
      // a target-based strategy re-enters its learning period, and a campaign
      // that is already under the published conversion minimum has nothing to
      // come out of it with. So the step is held back there — and ONLY there:
      // a campaign on no target strategy is not learning from anything, and
      // budget is the ordinary way a small account reaches the minimum in the
      // first place. Gating that would be a rule firing on every small account
      // while stopping the work that would fix it.
      const campaignReadiness = biddingByCampaign.get(c.id) ?? null;
      const biddingAllowsBudget = campaignReadiness == null || campaignReadiness.mayProposeBudgetStep;
      const propose = converting && !overTarget && biddingAllowsBudget && Boolean(c.budgetResourceName);

      const headline = !zeroMeansZero
        ? `"${c.name}" is budget-capped, and nothing here can tell whether it is working`
        : !converting
          ? `"${c.name}" is budget-capped but converting nothing — fix relevance before adding budget`
          : overTarget
            ? `"${c.name}" is budget-capped, and each conversion costs $${((cpaCents ?? 0) / 100).toFixed(2)} against a $${((target?.cents ?? 0) / 100).toFixed(2)} target`
            : !biddingAllowsBudget
              ? `"${c.name}" is budget-capped, and its bidding does not have the conversions to survive being moved`
            : underTarget
              ? `"${c.name}" is budget-capped and converting under target — it loses ${pct(budgetLost)} of impressions to budget`
              : `"${c.name}" is budget-capped and converting — it loses ${pct(budgetLost)} of impressions to budget`;

      const body = !zeroMeansZero
        ? `The campaign gave up ${pct(budgetLost)} of its available impressions because the daily budget ran out. Whether that `
          + `matters depends on whether it converts, and this account's conversion column cannot be read — so no budget change is `
          + `proposed here. Settle the tracking finding on this account first.`
        : !converting
          ? `The campaign gave up ${pct(budgetLost)} of its impressions to budget and recorded no conversions on ${usd(c.costMicros)}, `
            + `on an account whose conversion tracking is recording normally. More budget would buy more of what is not working. `
            + `Fix targeting or the landing page first.`
          : overTarget
            ? `It is capped, and it is converting, and each conversion costs more than this client asked to pay. More budget buys `
              + `more conversions at the same price. Bring the cost down — search terms, landing page, bids — and the cap becomes `
              + `worth lifting.`
            : !biddingAllowsBudget
              ? `The campaign is capped and converting, and it runs a bidding strategy with a target to hit on ${(campaignReadiness?.conversions30d ?? 0).toFixed(1)} conversions `
                + `a month — under the ${TARGET_STRATEGY_MIN_CONVERSIONS_30D} per campaign per 30 days the platform publishes as the minimum for one. A budget move of this size `
                + `restarts that strategy's learning period, and this campaign has nothing to come out of it with. Get the conversions up, or move it to a `
                + `strategy with no target, and then the cap is worth lifting.`
            : `The campaign gave up ${pct(budgetLost)} of its available impressions because the daily budget ran out, while producing `
              + `${c.conversions.toFixed(1)} conversions on ${usd(c.costMicros)}${cpaCents != null ? ` at $${(cpaCents / 100).toFixed(2)} each` : ""}. `
              + `Raising budget buys more of what already works.`;

      out.push({
        entityType: "campaign", entityId: c.id, entityName: c.name, campaignId: c.id,
        findingType: "budget_limited",
        severity: budgetLost > THRESHOLDS.budgetLostShareHigh ? "high" : "medium",
        riskLevel: propose ? "low" : "high",
        applicability: propose ? "api" : "vendor",
        title: headline,
        summary: body,
        evidence: {
          metrics: {
            costMicros: c.costMicros, clicks: c.clicks, conversions: c.conversions,
            budgetLostShare: budgetLost, impressionShare: c.impressionShare ?? 0,
            dailyBudgetMicros: c.dailyBudgetMicros,
            ...(cpaCents != null ? { costPerConversionCents: cpaCents } : {}),
          },
          ...win,
          lines: [
            `${usd(c.costMicros)} spent · ${c.clicks} clicks · ${c.conversions.toFixed(1)} conversions (30 days)`,
            `Impression share ${pct(c.impressionShare ?? 0)} · lost to budget ${pct(budgetLost)}`,
            `Daily budget ${usd(c.dailyBudgetMicros)}`,
            cpaCents != null
              ? `Each conversion costs $${(cpaCents / 100).toFixed(2)}`
              : costPerOutcomeReadable
                ? `Under one conversion in the window, so no cost per conversion is worked out — dividing by a fraction turns a small spend into an enormous unit price`
                : `No cost per conversion is worked out: ${trackingCaveat(tracking)}`,
            ...targetLines,
          ],
        },
        estImpactCents: propose ? claimCents : 0,
        impactUnit: "usd_month",
        impactAssumption: !propose
          ? (!zeroMeansZero
              ? `No figure claimed: the conversion column on this account cannot be read, so there is nothing to work a return out of.`
              : !converting
                ? `No impact claimed: this campaign converts nothing, so extra budget has no modelled return.`
                : overTarget
                  ? `No impact claimed: each conversion already costs more than the target, so buying more of them at the same price is not a gain.`
                  : `No impact claimed: the change this would make is held back because it restarts a bidding strategy that has too little to learn from. `
                    + `What the extra budget might have bought is beside the point while the strategy cannot use it.`)
          : claimCents > 0
            ? `Estimated, not measured. Assumes we capture ${pct(BUDGET_CAPTURE_RATE)} of the impression share lost to budget at today's cost `
              + `per click — about ${usd(upliftMicros)} a month of extra spend — buying ${(extraConversions ?? 0).toFixed(1)} more conversions at `
              + `$${((cpaCents ?? 0) / 100).toFixed(2)} each, each worth about $${((modelled?.cents ?? 0) / 100).toFixed(2)} on the customer value and close `
              + `rate recorded for this client. The figure is that value less the extra spend. Impression share lost is not demand gained.`
            : `No dollar figure: ${usd(upliftMicros)} a month of extra spend would buy about ${(extraConversions ?? 0).toFixed(1)} more conversions, `
              + `and nothing on this client's record says what one is worth, so there is nothing to price them against. `
              + `Record a customer value and a close rate and this becomes a number.`,
        changePayload: propose
          ? {
              op: "budgets",
              // `fromDailyMicros` is the budget this proposal was COMPUTED
              // FROM. `newDailyUsd` is a frozen dollar figure, not a delta, so
              // without the starting point the apply path cannot tell whether
              // it is still the +25% step this claims to be. See the staleness
              // guard in apply-ads-changes.ts.
              body: [{ campaign: c.name, newDailyUsd, fromDailyMicros: c.dailyBudgetMicros, reason: `Budget-capped: losing ${pct(budgetLost)} of impressions to budget while converting${underTarget ? " under target" : ""}.` }],
              plainEnglish: `Raise "${c.name}" from ${usd(c.dailyBudgetMicros)}/day to $${newDailyUsd.toFixed(2)}/day (+25%).`,
              guard: `Budget guard: refuses any move above 2× the current budget or more than $100/day in one run. A 25% step is well inside both. It also refuses outright if the budget has changed since this was worked out — if somebody has already moved it, this figure is out of date.`,
            }
          : null,
        guardNote: propose
          ? "Budget guard: max 2× and max $100/day movement per run, and refused entirely if the budget has moved since this was worked out."
          : !zeroMeansZero
            ? "No API change proposed — this engine does not spend more on an account whose conversion column it cannot read."
            : overTarget
              ? "No API change proposed — more budget on a campaign already over its cost target is refused by rule, not by the API."
              : !biddingAllowsBudget
                ? "No API change proposed — a budget move of this size restarts the learning period on a target-based bidding strategy, and this campaign is under the published conversion minimum for one. Refused by rule, not by the API."
                : "No API change proposed — adding budget to a non-converting campaign is refused by rule, not by the API.",
      });
    }

    const rankLost = c.rankLostShare ?? 0;
    if (rankLost > THRESHOLDS.rankLostShare) {
      out.push({
        entityType: "campaign", entityId: c.id, entityName: c.name, campaignId: c.id,
        findingType: "rank_limited", severity: "medium", riskLevel: "low",
        // Ad Rank is bid + quality + relevance. We do not hold a guarded bid
        // path, and the quality half is ad copy and landing pages — both
        // people-work. This is a brief, not a button.
        applicability: "vendor",
        title: `"${c.name}" loses ${pct(rankLost)} of impressions to Ad Rank, not budget`,
        summary: `More budget will not fix this. Ad Rank is bid, expected click-through and landing-page experience — `
          + `the campaign is being outranked or held back on quality, so the work is bids, ad relevance and landing pages.`,
        evidence: {
          metrics: { costMicros: c.costMicros, rankLostShare: rankLost, impressionShare: c.impressionShare ?? 0, clicks: c.clicks },
          ...win,
          lines: [
            `Impression share ${pct(c.impressionShare ?? 0)} · lost to Ad Rank ${pct(rankLost)}`,
            `${usd(c.costMicros)} spent · ${c.clicks} clicks (30 days)`,
          ],
        },
        estImpactCents: 0,
        impactUnit: "usd_month",
        impactAssumption: "No dollar estimate: recovering Ad Rank share depends on bid and quality changes whose effect can't be modelled from impression share alone.",
        changePayload: null,
        guardNote: "Bid strategy changes are deliberately out of our guarded API scope — see the vendor brief.",
      });
    }

    // Held back where the conversion column is broken or unread. The sentence
    // this finding exists to say is "check tracking first", and where tracking
    // has ALREADY been checked and found broken, the tracking finding says it
    // with the evidence — two rows saying one thing is how a queue fills with
    // advice nobody reads. Where the column reads normally, a zero is a real
    // zero and this is the strongest row on the account.
    if (zeroMeansZero && c.clicks >= THRESHOLDS.noConversionClicks && c.conversions === 0) {
      out.push({
        entityType: "campaign", entityId: c.id, entityName: c.name, campaignId: c.id,
        findingType: "no_conversions", severity: "high", riskLevel: "medium",
        applicability: "vendor",
        title: `"${c.name}" took ${c.clicks} clicks and ${usd(c.costMicros)} with zero conversions`,
        summary: `At this click volume, zero conversions is almost always one of two things: conversion tracking is broken, `
          + `or the traffic is wrong. This account's conversion actions were checked and are recording, so start with the traffic — `
          + `but confirm the tag fires on THIS campaign's landing pages before pausing anything.`,
        evidence: {
          metrics: { costMicros: c.costMicros, clicks: c.clicks, conversions: 0, impressions: c.impressions },
          ...win,
          lines: [
            `${usd(c.costMicros)} · ${c.clicks} clicks · ${c.impressions} impressions · 0 conversions (30 days)`,
          ],
        },
        estImpactCents: microsToCents(c.costMicros),
        impactUnit: "usd_month",
        // The module's own sentence below says this is the size of the
        // question rather than a saving, so the rank reads it as `at_stake`
        // and is handed the same figure explicitly rather than inferring it.
        atStakeCents: microsToCents(c.costMicros),
        impactAssumption: `The full 30-day spend is at risk, not saved. If tracking is broken the true impact is zero and the fix is tracking; `
          + `if the traffic is genuinely wrong the spend is recoverable. The number is the size of the question, not a promised saving.`,
        changePayload: null,
        guardNote: "No automatic pause. Pausing a campaign is out of the guarded API scope precisely because broken tracking looks identical to bad traffic.",
      });
    }

    // ── The campaign that converts, and loses money doing it ───────────────
    // The rule the engine did not have. A campaign at 40% impression share
    // with a healthy conversion count reads as a success on every metric here,
    // and if each of those conversions costs more than the client can pay for
    // one, the account is buying customers at a loss and doing it faster every
    // month. This fires only where the cost per conversion may honestly be
    // worked out AND a target exists to measure it against — never on an
    // invented target, and never on a conversion column that is counting page
    // views.
    if (overTarget && cpaCents != null && target != null) {
      const overCents = cpaCents - target.cents;
      // A month of the window, so the figure is comparable with every other
      // monthly impact on the queue. The campaign metrics are the 30-day pull,
      // so the conversion count is already a month's worth.
      const monthlyOverspendCents = Math.max(0, Math.round(overCents * c.conversions));
      out.push({
        entityType: "campaign", entityId: `${c.id}:cost_target`, entityName: c.name, campaignId: c.id,
        findingType: "cpa_above_target",
        severity: cpaCents > target.cents * 2 ? "high" : "medium",
        riskLevel: "medium",
        // Bringing a cost per conversion down is search terms, landing pages,
        // bids and offer. Two of those have no guarded path here and the other
        // two are people-work, so this is a brief rather than a button.
        applicability: "vendor",
        title: target.basis === "stated"
          ? `"${c.name}" pays $${(cpaCents / 100).toFixed(2)} a conversion against a $${(target.cents / 100).toFixed(2)} ceiling`
          : `"${c.name}" pays $${(cpaCents / 100).toFixed(2)} a conversion, and an estimated $${(target.cents / 100).toFixed(2)} is what one is worth`,
        summary: target.basis === "stated"
          ? `The campaign is working in the sense that it converts. It is converting above the cost this client asked to pay, so `
            + `every extra conversion widens the gap. The levers are the search terms it matches, the page those clicks land on, `
            + `and the bids — in that order, because the first two cost nothing to test.`
          : `The campaign converts, and on the customer value and close rate recorded for this client each conversion costs more `
            + `than one is worth. That figure is an estimate rather than something measured, so read it as a reason to check the `
            + `numbers rather than as a verdict. If the estimate is right, this campaign loses money on every conversion it buys.`,
        evidence: {
          metrics: {
            costMicros: c.costMicros, clicks: c.clicks, conversions: c.conversions,
            costPerConversionCents: cpaCents, targetCents: target.cents,
            overByCents: overCents,
          },
          ...win,
          lines: [
            `${usd(c.costMicros)} · ${c.clicks} clicks · ${c.conversions.toFixed(1)} conversions (30 days)`,
            `$${(cpaCents / 100).toFixed(2)} a conversion, $${(overCents / 100).toFixed(2)} over`,
            ...targetLines,
          ],
        },
        estImpactCents: monthlyOverspendCents,
        impactUnit: "usd_month",
        impactAssumption: target.basis === "stated"
          ? `${c.conversions.toFixed(1)} conversions a month at $${(overCents / 100).toFixed(2)} over the recorded ceiling. `
            + `That is the size of the gap between what conversions cost and what they were meant to cost — not a saving anybody `
            + `has promised, and not money that appears the day somebody looks at it.`
          : `Estimated, not measured. ${c.conversions.toFixed(1)} conversions a month at $${(overCents / 100).toFixed(2)} more than a lead is `
            + `worth on this client's recorded customer value and close rate. It is the size of the question at today's numbers, `
            + `and it moves the moment either of those figures is corrected.`,
        changePayload: null,
        guardNote: "Bids and landing pages have no guarded path here, and nothing pauses a converting campaign automatically.",
      });
    }

    // ── The campaign that converts cheaply, with impressions still to buy ──
    // The other half of `budget_limited`, and the one nothing looked for. That
    // rule fires on a campaign losing impressions to its daily CAP. A campaign
    // at 55% impression share, four points lost to budget and 35% lost to Ad
    // Rank, buying conversions at half what this client says one is worth,
    // produces no row anywhere — every metric on it reads healthy, which is
    // exactly why nothing speaks for it.
    //
    // The reading is silent on every verdict but `room`, which is the whole
    // reason it can be a rule rather than a column: a line on every campaign
    // saying whether it has headroom is a line people learn to scroll past.
    const head = headroomReading({
      campaignId: c.id, campaignName: c.name,
      costMicros: c.costMicros, conversions: c.conversions,
      impressionShare: c.impressionShare,
      budgetLostShare: c.budgetLostShare, rankLostShare: c.rankLostShare,
      // Passed, never recomputed. The float-denominator refusal and the
      // broken-column refusal are both already in this one figure.
      costPerConversionCents: cpaCents,
      targetCents: target?.cents ?? null,
      targetBasis: target?.basis ?? null,
      budgetRuleFloor: THRESHOLDS.budgetLostShare,
      // The same haircut the budget rule applies, so the two rules can never
      // print two different extra-spend figures for one campaign.
      captureRate: BUDGET_CAPTURE_RATE,
      readiness: biddingByCampaign.get(c.id) ?? null,
      rankRuleAlsoFired: rankLost > THRESHOLDS.rankLostShare,
    });
    headroomReadings.push({ verdict: head.verdict, silence: head.silence });
    if (head.verdict === "room" && head.extraConversions != null && head.extraSpendMicros != null) {
      out.push({
        entityType: "campaign", entityId: `${c.id}:headroom`, entityName: c.name, campaignId: c.id,
        findingType: "headroom",
        // Never high. A campaign performing well with room to do more of it is
        // an opportunity, and putting it at the same weight as money leaving
        // the account for nothing is how a queue stops sorting anything.
        severity: "medium",
        riskLevel: "medium",
        // The lever is a bid or a target, which has no guarded path here by
        // design, or a daily cap the budget rule's own floor says is not
        // costing enough to be worth moving. Either way, a brief.
        applicability: "vendor",
        title: head.lever === "rank"
          ? `"${c.name}" buys conversions ${pct(head.marginShare ?? 0)} under target and gives up ${pct(head.lostShare ?? 0)} of its impressions to Ad Rank`
          : `"${c.name}" buys conversions ${pct(head.marginShare ?? 0)} under target and gives up ${pct(head.lostShare ?? 0)} of its impressions`,
        summary: head.lever === "rank"
          ? `Each conversion costs $${((cpaCents ?? 0) / 100).toFixed(2)} against $${((target?.cents ?? 0) / 100).toFixed(2)}, and the campaign is only reaching ${pct(c.impressionShare ?? 0)} of the `
            + `searches it could. What it gives up goes to Ad Rank rather than to the daily budget, so the money lever is what we are willing to pay `
            + `for a conversion — a higher bid, or a looser target on the strategy — and the margin against what a lead is worth is what makes paying `
            + `more sane rather than reckless. Ad relevance and the landing page buy the same impressions without paying for them, so try those first.`
          : `Each conversion costs $${((cpaCents ?? 0) / 100).toFixed(2)} against $${((target?.cents ?? 0) / 100).toFixed(2)}, and the campaign is only reaching ${pct(c.impressionShare ?? 0)} of the `
            + `searches it could, mostly because the daily cap runs out. The cap is under the floor at which this engine proposes a budget rise on its `
            + `own, so nothing is proposed here — but this is the cheapest campaign on the account to put another pound into.`,
        evidence: {
          metrics: head.metrics,
          ...win,
          lines: [...head.lines, ...head.blockers, ...targetLines],
        },
        // LEADS, not dollars. The margin this row is built on is already
        // measured against what a lead is worth, and running that same figure
        // through the projected volume as well would turn one recorded number
        // into a dollar forecast of a change nobody has made.
        estImpactCents: Math.round(head.extraConversions * 100),
        impactUnit: "leads_month",
        impactAssumption: headroomClaim(head, BUDGET_CAPTURE_RATE),
        changePayload: null,
        guardNote: "No API change proposed. A bid or a bid target is deliberately outside the guarded path, and the daily cap here is under the floor at which this engine proposes a budget move at all.",
      });
    }

    // ── How big is the demand this campaign is already losing? ─────────────
    // `rank_limited` above says more budget will not fix an Ad Rank problem and
    // claims no figure, which is right about the FIX — nothing here can say
    // what a bid change does. This is the other question, which is answerable:
    // how many searches this campaign already bids on go to somebody else. It
    // never repeats the fix advice and defers to that row for it.
    //
    // A PROJECTION. Never `recoverable`: nothing here is money leaving the
    // account now, and the basis word travels with the figure.
    const dem = demandCaptureReading({
      campaignId: c.id, campaignName: c.name, channelType: c.channelType,
      costMicros: c.costMicros, clicks: c.clicks, impressions: c.impressions,
      conversions: c.conversions,
      impressionShare: c.impressionShare,
      rankLostShare: c.rankLostShare, budgetLostShare: c.budgetLostShare,
      // Composed from the one tracking reading, never re-decided. A conversion
      // rate read off a column counting page views is a page-view rate, and
      // projecting leads through it is the finding doing harm.
      columnCountsOutcomes: tracking.countsOutcomes,
      targetCents: target?.cents ?? null,
      targetBasis: target?.basis ?? null,
      leadValueCents: perLeadCents,
      // Passed, never recomputed: the float-denominator refusal and the
      // broken-column refusal are both already inside this one figure.
      costPerConversionCents: cpaCents,
      // The same haircut the budget rule and the headroom rule apply, so no two
      // rules can print two different sizes for one campaign.
      captureRate: BUDGET_CAPTURE_RATE,
      rankRuleFloor: THRESHOLDS.rankLostShare,
      minSpendMicros: THRESHOLDS.campaignMinSpendMicros,
    });
    demandReadings.push(dem);
    if (dem.verdict === "demand") {
      out.push({
        entityType: "campaign", entityId: `${c.id}:demand`, entityName: c.name, campaignId: c.id,
        findingType: "unmet_demand",
        // Never high. Demand nobody is capturing is an opportunity, and putting
        // it at the weight of money leaving the account for nothing is how a
        // queue stops sorting anything.
        severity: "medium",
        riskLevel: "low",
        // Ad Rank is bid, expected click-through and landing-page experience.
        // Bids have no guarded path here by design and the quality half is ad
        // copy and landing pages. A brief, never a button.
        applicability: "vendor",
        title: dem.tier === "money" && dem.netValueCents != null
          ? `"${c.name}" is losing ${pct(dem.rankLostShare ?? 0)} of the searches it bids on — about ${(dem.extraLeads ?? 0).toFixed(1)} enquiries a month it is not getting`
          : dem.tier === "leads" && dem.extraLeads != null
            ? `"${c.name}" is losing ${pct(dem.rankLostShare ?? 0)} of the searches it bids on — about ${dem.extraLeads.toFixed(1)} enquiries a month it is not getting`
            : `"${c.name}" is losing ${pct(dem.rankLostShare ?? 0)} of the searches it bids on — about ${Math.round(dem.extraClicks ?? 0)} clicks a month it is not getting`,
        summary: `This is demand the client is ALREADY targeting and already relevant to: every one of these searches matched a keyword `
          + `in this campaign and the account was in the auction for it. It is not being outspent — the share it gives up goes to Ad Rank, `
          + `so it is being outranked or held back on quality. That makes it the cheapest growth on the account to reach, because nothing `
          + `has to be researched, built or written from nothing. `
          + (dem.tier === "clicks"
            ? `How much it is worth cannot be said yet, and the reason is on the row rather than assumed away.`
            : `What it is worth is projected from this campaign's own numbers and is a forecast, not money on the record.`)
          + ` The fix itself — bid, ad relevance, landing page — is the row on this campaign's Ad Rank, not this one.`,
        evidence: {
          metrics: dem.metrics,
          ...win,
          lines: [...dem.lines, ...dem.preconditions, ...targetLines],
        },
        // LEADS, never dollars, for `headroom`'s reason: the money tier is
        // already the leads figure multiplied by a recorded lead value, and
        // claiming both would run one recorded number through the projection
        // twice. Nought where no leads figure could be reached — and `rankImpact`
        // reads that as "projects no extra leads this run", which is what it is.
        estImpactCents: dem.extraLeads != null ? Math.round(dem.extraLeads * 100) : 0,
        impactUnit: "leads_month",
        impactAssumption: demandCaptureClaim(dem, BUDGET_CAPTURE_RATE),
        changePayload: null,
        guardNote: "No API change proposed and none is possible here. Ad Rank moves on bid, expected click-through and landing-page experience; bids are deliberately outside the guarded path and the other two are people-work.",
      });
    }
  }

  // ── 2. Search terms — the biggest single source of waste ──────────────────
  // Grouped per campaign so one negative-keyword change carries many terms,
  // which is both how a human would do it and far fewer approvals to press.
  const wasteByCampaign = new Map<string, SearchTermRow[]>();
  for (const t of input.searchTerms) {
    if (t.conversions > 0 || t.allConversions > 0) continue;
    if (t.costMicros < THRESHOLDS.searchTermWasteMicros) continue;
    if (alreadyNegated(t.term, input.existingNegatives)) continue;
    // A protected term is one the client has told us never to block. Blocking a
    // partner or brand term by accident costs far more than the spend it saves,
    // so it is filtered here AND refused again by the apply path's guard.
    if (isProtected(t.term)) continue;
    wasteByCampaign.set(t.campaignName, [...(wasteByCampaign.get(t.campaignName) ?? []), t]);
  }

  /**
   * WHAT THIS RULE PROPOSES BLOCKING TRAFFIC ON.
   *
   * Every term above was selected because it recorded no conversions. On an
   * account whose conversion column is broken, EVERY term records no
   * conversions — so this rule would propose phrase negatives against the
   * account's entire top spend, including the queries actually producing the
   * client's business, and the only thing standing in the way would be
   * somebody reading a fifty-item list. Blocking traffic that converts is the
   * expensive direction to be wrong in, so the proposal is held back and the
   * money it would have named is carried on the tracking finding instead —
   * held, not lost, and said with its figure.
   */
  const heldBackTerms: SearchTermRow[] = [];
  if (!zeroMeansZero) {
    for (const terms of wasteByCampaign.values()) heldBackTerms.push(...terms);
    wasteByCampaign.clear();
  }

  for (const [campaignName, terms] of wasteByCampaign) {
    const sorted = [...terms].sort((a, b) => b.costMicros - a.costMicros);
    const first = sorted[0];
    if (!first) continue;
    const total = sorted.reduce((s, t) => s + t.costMicros, 0);
    const monthly = Math.round(total / 3);                 // 90-day window → per month
    const recoverable = Math.round(monthly * RECOVERY_RATE);
    /**
     * HOW MUCH OF THIS CAMPAIGN'S SPEND THE REPORT THESE TERMS CAME FROM
     * ACTUALLY SHOWS.
     *
     * Google withholds queries too few people searched, and those clicks are
     * still charged. So this figure has always been worked out over an unknown
     * fraction of the money and stated as though it were the whole of it. It
     * says the share now — measured on this campaign rather than quoted from
     * anybody's study — and where the share is low the claim changes rather
     * than the claim carrying a footnote.
     */
    const seen = visibility.get(first.campaignId) ?? null;
    out.push({
      entityType: "campaign", entityId: `${first.campaignId}:wasted_terms`, entityName: campaignName, campaignId: first.campaignId,
      findingType: "wasted_search_term",
      // A list worked out over a third of the campaign's money is not the
      // strongest row on an account, whatever its dollar figure says.
      severity: seen && coverageChangesTheClaim(seen) && seen.verdict !== "unread" ? "medium" : "high",
      riskLevel: "low",
      applicability: "api",
      title: `${sorted.length} search terms in "${campaignName}" spent ${usd(total)} converting nothing`,
      summary: `These queries matched, took clicks and produced nothing over 90 days. Adding them as phrase negatives on the `
        + `campaign stops the spend without touching bids, budgets or ad copy. Every one is checked against the protected-term `
        + `list first, and any already present as a negative is skipped rather than duplicated.`,
      evidence: {
        metrics: {
          termCount: sorted.length, costMicros: total,
          clicks: sorted.reduce((s, t) => s + t.clicks, 0), conversions: 0,
          ...(seen?.metrics ?? {}),
        },
        ...win,
        lines: sorted.slice(0, 12).map((t) => `${usd(t.costMicros)} · ${t.clicks} clicks · "${t.term}"`)
          .concat(sorted.length > 12 ? [`…and ${sorted.length - 12} more`] : [])
          .concat(seen ? [seen.line] : []),
      },
      estImpactCents: microsToCents(recoverable),
      impactUnit: "usd_month",
      impactAssumption: `${usd(total)} over 90 days is ${usd(monthly)}/month; we claim ${Math.round(RECOVERY_RATE * 100)}% of it. `
        + `The haircut is because some of this traffic would have converted eventually and some terms are relevant but badly landed — `
        + `claiming the full figure promises a saving we can't deliver.`
        + (seen?.caveat ? ` ${seen.caveat}` : ""),
      changePayload: {
        op: "campaignNegatives",
        body: [{
          campaign: campaignName,
          matchType: "PHRASE",
          reason: `${sorted.length} terms, ${usd(total)} over 90 days, zero conversions and zero all-conversions.`,
          keywords: sorted.slice(0, 50).map((t) => t.term),
        }],
        plainEnglish: `Add ${Math.min(sorted.length, 50)} phrase negatives to "${campaignName}" so these queries stop matching.`,
        guard: `Negative-keyword guard: any term colliding with a protected pattern aborts the whole run; terms already present are skipped, not duplicated. Removal is a first-class operation, so a negative that turns out to block wanted traffic is one click to undo.`,
      },
      guardNote: "Protected-term collision aborts the run; duplicates are skipped.",
    });
  }

  // ── 2b. Search terms — the queries that are working ───────────────────────
  /**
   * THE LINE ABOVE THIS SECTION, AND WHAT IT THREW AWAY.
   *
   * The waste rule opens `if (t.conversions > 0 || t.allConversions > 0)
   * continue;`. Every query that PRODUCED something was read, discarded, and
   * read again next week. Seven of this engine's eight original rules cut
   * waste; this is the one that reads the same report for the opposite thing.
   *
   * A converting query the account holds no keyword for is being bought
   * through whatever looser keyword happens to match it, at that keyword's bid,
   * in that keyword's ad group, against that ad group's ads. It is the clearest
   * growth signal a search account has and it costs nothing extra to read.
   *
   * NO DOLLAR IS CLAIMED and the reason is in `promotionClaim`: the conversions
   * already happen and are already in this campaign's totals, so pricing the
   * change at their value counts the same conversion twice.
   */
  const promotions = queryPromotions({
    terms: input.searchTerms,
    existingKeywords: input.existingKeywords,
    // Composed from the one tracking reading, never re-decided. A conversion
    // on a column counting page views is a page view, and bidding deliberately
    // on the queries producing the most of them is the finding doing harm.
    columnCountsOutcomes: tracking.countsOutcomes,
    protectedPatterns: input.protectedPatterns,
  });
  for (const cp of promotions.byCampaign) {
    const seen = visibility.get(cp.campaignId) ?? null;
    out.push({
      entityType: "campaign", entityId: `${cp.campaignId}:promote_terms`, entityName: cp.campaignName,
      campaignId: cp.campaignId,
      findingType: "converting_search_term",
      // Never high, for the same reason it claims no dollar: nothing is
      // currently going wrong on these queries. They are working, and this is
      // about buying them deliberately instead of by accident.
      severity: "medium",
      riskLevel: "low",
      // Adding a keyword is not a guarded operation here and this does not make
      // it one. It means choosing an ad group, a match type and a bid — three
      // judgements, two of which change which ads a query is served against.
      applicability: "vendor",
      title: `${cp.queries.length} quer${cp.queries.length === 1 ? "y" : "ies"} in "${cp.campaignName}" converted ${cp.totalConversions.toFixed(1)} times and ${cp.queries.length === 1 ? "is" : "are"} not a keyword`,
      summary: `Each of these matched, took clicks and produced conversions over 90 days, and none of them is in the account as a keyword. `
        + `They are being bought through whichever looser keyword happens to match them, at that keyword's bid and inside that keyword's ad group. `
        + `Adding each one — usually as a phrase or exact keyword in the ad group whose ads already answer it — gives it its own bid, its own match `
        + `type and its own reporting line. Read each one before adding it: a query that converts twice is not always a query worth its own keyword.`,
      evidence: {
        metrics: { ...cp.metrics, alreadyKeywords: promotions.alreadyKeywords },
        ...win,
        lines: [
          ...cp.lines,
          `Floor: at least ${PROMOTE_MIN_CONVERSIONS} conversions and ${usd(PROMOTE_MIN_COST_MICROS)} over the 90-day window, on the column this account actually counts.`,
          `Checked against every enabled keyword in the account, matched on letters and digits only, so case and punctuation cannot hide a duplicate.`,
          ...(seen && seen.verdict !== "not_applicable" ? [seen.line] : []),
        ],
      },
      // No dollar and no lead count. See `promotionClaim`.
      estImpactCents: 0,
      impactUnit: "usd_month",
      // …and yet it has a size, which is what lets it rank without claiming a
      // gain: the money ALREADY flowing through these queries, at a bid nobody
      // set, over a ninety-day window read as a month. `estImpactCents` stays
      // at nought because nothing is gained; this says how big the thing is.
      atStakeCents: Math.round(microsToCents(cp.totalCostMicros) / 3),
      impactAssumption: promotionClaim(cp, promotions.alreadyKeywords)
        + (seen?.caveat ? ` ${seen.caveat}` : ""),
      changePayload: null,
      guardNote: "Nothing to apply. Creating a keyword needs an ad group, a match type and a bid chosen for it, none of which is mechanical, and none of which is in the guarded operation list.",
    });
  }

  // ── 3. Keywords — spend without return, and quality problems ──────────────
  // Same reasoning as the search terms above: "this keyword converted nothing"
  // and "nothing on this account is recorded" are the same row, and one of them
  // is a reason to stop paying for a keyword the client's business depends on.
  const deadKeywords = zeroMeansZero
    ? input.keywords.filter((k) => k.conversions === 0 && k.costMicros >= THRESHOLDS.keywordWasteMicros)
    : [];
  const heldBackKeywords = zeroMeansZero
    ? []
    : input.keywords.filter((k) => k.conversions === 0 && k.costMicros >= THRESHOLDS.keywordWasteMicros);
  for (const k of deadKeywords) {
    const monthly = Math.round(k.costMicros / 3);
    out.push({
      entityType: "keyword", entityId: k.criterionResourceName, entityName: k.text, campaignId: k.campaignId,
      findingType: "dead_keyword", severity: "high", riskLevel: "medium",
      // Pausing or re-bidding a keyword is not in the guarded API scope. What IS
      // in scope is pointing it at a better page, which is often the real fix —
      // and unlike an ad edit it does not resubmit anything for policy review.
      applicability: "vendor",
      title: `Keyword "${k.text}" spent ${usd(k.costMicros)} over 90 days with no conversions`,
      summary: `${usd(monthly)}/month on a ${k.matchType.toLowerCase()} keyword that has produced nothing. `
        + `The choice is pause it, cut its bid, or land it on a page that actually answers the search — `
        + `check the landing page before pausing, because a relevant keyword on the wrong page looks identical to a bad keyword.`,
      evidence: {
        metrics: { costMicros: k.costMicros, clicks: k.clicks, conversions: 0, qualityScore: k.qualityScore ?? 0 },
        ...win,
        lines: [
          `${usd(k.costMicros)} · ${k.clicks} clicks · 0 conversions (90 days)`,
          `${k.matchType} match in "${k.campaignName}"${k.adGroupName ? ` › ${k.adGroupName}` : ""}`,
          k.finalUrls.length ? `Lands on ${k.finalUrls.join(", ")}` : "Inherits the ad's final URL",
          k.qualityScore ? `Quality score ${k.qualityScore}` : "No quality score reported",
        ],
      },
      estImpactCents: microsToCents(Math.round(monthly * RECOVERY_RATE)),
      impactUnit: "usd_month",
      impactAssumption: `${usd(monthly)}/month at ${Math.round(RECOVERY_RATE * 100)}% recovery. Pausing a keyword removes its spend but also its `
        + `assists, which we cannot see from last-click conversions — hence the haircut.`,
      changePayload: null,
      guardNote: "Pausing keywords and changing bids are outside the guarded API scope. Keyword final-URL changes are in scope and can be proposed separately.",
    });
  }

  // An account-level row needs a reason to exist. Without a spend floor these
  // three rules fired on every mapped account whatever it was doing, which is
  // how a queue teaches people to scroll past a whole class of finding.
  const accountWorthARow = accountTotals.costMicros >= THRESHOLDS.accountMinSpendMicros;

  const lowQs = input.keywords.filter((k) => (k.qualityScore ?? 0) > 0 && (k.qualityScore as number) < THRESHOLDS.qualityScoreFloor);
  if (accountWorthARow && lowQs.length) {
    const spend = lowQs.reduce((s, k) => s + k.costMicros, 0);
    out.push({
      entityType: "account", entityId: `${input.accountId}:low_quality_score`, entityName: "Quality score",
      findingType: "low_quality_score", severity: "medium", riskLevel: "low",
      applicability: "vendor",
      title: `${lowQs.length} keywords carry a quality score below ${THRESHOLDS.qualityScoreFloor}`,
      summary: `Google charges a relevance premium on every click for these. It is almost always an ad-copy or landing-page `
        + `mismatch rather than a bidding problem, so the fix is copy and pages — which is people-work, not an API call.`,
      evidence: {
        metrics: { keywordCount: lowQs.length, costMicros: spend },
        ...win,
        lines: lowQs.slice(0, 10).map((k) => `QS ${k.qualityScore} · ${usd(k.costMicros)} · "${k.text}" (${k.campaignName})`),
      },
      estImpactCents: 0,
      impactUnit: "usd_month",
      impactAssumption: "No dollar estimate: the premium Google charges for low quality score isn't exposed by the API, so any figure would be invented.",
      changePayload: null,
      guardNote: "Ad copy is out of scope by policy — see the LegitScript note in the vendor brief.",
    });
  }

  // ── 4. Ad coverage ────────────────────────────────────────────────────────
  const byGroup = new Map<string, AdGroupAdRow[]>();
  for (const a of input.ads) byGroup.set(a.adGroupId, [...(byGroup.get(a.adGroupId) ?? []), a]);
  const thin = Array.from(byGroup.entries()).filter(([, v]) => v.length < THRESHOLDS.minAdsPerGroup);
  if (accountWorthARow && thin.length) {
    out.push({
      entityType: "account", entityId: `${input.accountId}:thin_ad_groups`, entityName: "Ad coverage",
      findingType: "thin_ad_group", severity: "medium", riskLevel: "low",
      applicability: "vendor",
      title: `${thin.length} ad groups run fewer than ${THRESHOLDS.minAdsPerGroup} enabled ads`,
      summary: `With one ad in a group Google has nothing to test against, so the account never improves on its own. `
        + `Adding a second responsive search ad per group is the single cheapest structural fix available.`,
      evidence: {
        metrics: { adGroupCount: thin.length, totalAdGroups: byGroup.size },
        ...win,
        lines: thin.slice(0, 8).map(([, v]) => `${v[0]?.campaignName ?? "?"} › ${v[0]?.adGroupName ?? "?"} — ${v.length} ad`),
      },
      estImpactCents: 0,
      impactUnit: "usd_month",
      impactAssumption: "No dollar estimate: the lift from adding a test ad depends entirely on the copy written, which is exactly the part we're asking a person to do.",
      changePayload: null,
      guardNote: "Creating or editing ads is out of the guarded API scope — a Google ad is effectively immutable, so a change means a new ad plus pausing the old one, and on a LegitScript-certified account that resubmits for policy review.",
    });
  }

  const weak = input.ads.filter((a) => ["POOR", "AVERAGE"].includes(String(a.adStrength ?? "").toUpperCase()));
  if (accountWorthARow && weak.length) {
    out.push({
      entityType: "account", entityId: `${input.accountId}:weak_ad_strength`, entityName: "Ad strength",
      findingType: "weak_ad_strength", severity: "low", riskLevel: "low",
      applicability: "vendor",
      title: `${weak.length} enabled ads are rated Poor or Average`,
      summary: `Ad strength is Google's own read on headline and description variety. Lifting it usually buys impression share `
        + `at the same bid. It needs new copy, which on a certified account has to be a new ad rather than an edit.`,
      evidence: {
        metrics: { weakAdCount: weak.length, totalAds: input.ads.length },
        ...win,
        lines: weak.slice(0, 8).map((a) => `${a.campaignName} › ${a.adGroupName} — ${a.adStrength}`),
      },
      estImpactCents: 0,
      impactUnit: "usd_month",
      impactAssumption: "No dollar estimate: impression-share gain from ad strength isn't modellable from the fields the API exposes.",
      changePayload: null,
      guardNote: "Ad copy out of scope by policy (LegitScript).",
    });
  }


  // ── 5. The conversion column itself ───────────────────────────────────────
  // Last, because it reports what the rules above held back. Each defect is its
  // own row: a tag that never fires, an account with nothing marked primary and
  // an account counting page views are three different jobs done by three
  // different people, and one row carrying all three is one row nobody finishes.
  const heldBackTermSpend = heldBackTerms.reduce((s2, t) => s2 + t.costMicros, 0);
  const heldBackKeywordSpend = heldBackKeywords.reduce((s2, k) => s2 + k.costMicros, 0);
  const heldBack = heldBackTerms.length + heldBackKeywords.length;
  const heldBackLines = heldBack > 0
    ? [
        `${heldBackTerms.length} search term(s) and ${heldBackKeywords.length} keyword(s) worth ${usd(heldBackTermSpend + heldBackKeywordSpend)} over the window `
          + `look like waste and are NOT being proposed as negatives while this stands`,
        `On an account with no working conversion column, a query that converts and a query that converts nothing produce the identical row — `
          + `so blocking on that basis can stop the traffic the client's business runs on`,
      ]
    : [];

  for (const d of tracking.defects) {
    out.push({
      entityType: "account", entityId: `${input.accountId}:tracking:${d.key}`, entityName: "Conversion tracking",
      findingType: "conversion_tracking_gap",
      // A broken conversion column is not one finding among several. Every
      // other judgement on the account is downstream of it.
      severity: "high",
      riskLevel: "medium",
      // Conversion actions, tags and analytics links are not in the guarded API
      // scope and should not be: creating a conversion action changes what the
      // account optimises toward, which is a decision rather than a fix.
      applicability: "vendor",
      title: d.title,
      summary: d.summary
        + (heldBack > 0
          ? ` It is also why this audit is proposing no negative keywords on this account: ${heldBack} item(s) carrying `
            + `${usd(heldBackTermSpend + heldBackKeywordSpend)} read as waste, and on a broken column so would everything that works.`
          : ""),
      evidence: {
        metrics: { ...d.metrics, heldBackItems: heldBack, heldBackMicros: heldBackTermSpend + heldBackKeywordSpend },
        ...win,
        lines: [...d.lines, ...heldBackLines],
      },
      // No dollar figure. What broken tracking costs is the difference between
      // the decisions made on a false reading and the ones that would have been
      // made on a true one, and nothing here can see the second of those. The
      // held-back spend is named in the evidence rather than claimed as a
      // saving, because it is a figure whose whole point is that it may be wrong.
      estImpactCents: 0,
      impactUnit: "usd_month",
      impactAssumption: "No figure claimed. What this costs is every decision made on a conversion count that is not true, "
        + "and nothing here can price a decision nobody made. The spend named in the evidence is what is currently unreadable, "
        + "not a saving.",
      changePayload: null,
      guardNote: "Conversion actions and tags have no guarded path here, deliberately — creating one changes what the account bids toward.",
    });
  }

  // SILENCE IS NEVER A PASS. Where a part of the conversion reading could not be
  // taken, say which part rather than letting the absence of a row read as a
  // clean account. This is not a defect and carries no severity of its own — it
  // is the reading saying what it could not see.
  // Gated on the platform DECLARING that it reports a conversion-tracking
  // configuration at all. Without this the row is produced on every account of
  // every platform whose adapter has no such object to read, saying a piece
  // could not be checked and naming a fix that would never stop producing it.
  if (signals.conversionConfig && tracking.defects.length === 0 && tracking.unread.length > 0 && accountWorthARow) {
    out.push({
      entityType: "account", entityId: `${input.accountId}:tracking:unread`, entityName: "Conversion tracking",
      findingType: "conversion_tracking_gap", severity: "medium", riskLevel: "low",
      applicability: "vendor",
      title: "Part of this account's conversion tracking could not be read",
      summary: "Nothing here says the tracking is wrong. It says a piece of it could not be checked, which is a different answer — "
        + "and every cost-per-conversion figure on this account, and every judgement this audit makes about a campaign working or "
        + "not working, rests on the piece that is missing.",
      evidence: {
        metrics: { costMicros: accountTotals.costMicros, clicks: accountTotals.clicks, conversions: accountTotals.conversions },
        ...win,
        lines: tracking.unread.map((u) => u.charAt(0).toUpperCase() + u.slice(1))
          .concat([`${usd(accountTotals.costMicros)} · ${accountTotals.clicks} clicks over the window`]),
      },
      estImpactCents: 0,
      impactUnit: "usd_month",
      impactAssumption: "No figure claimed — this row exists because a reading could not be taken, not because one came back bad.",
      changePayload: null,
      guardNote: "Nothing to apply. Read the account's conversion settings and this row stops being produced.",
    });
  }

  // ── 5b. The platform's own verdict on whether it can learn at all ─────────
  // The Meta analogue of the question the Google half of this engine cannot
  // ask: is there enough of the one event this ad set optimises for, inside the
  // platform's own window, for its delivery model to stop guessing. On Google
  // that number is a support-page convention and nothing reports it. On Meta
  // the platform says so itself, per ad set, and often reports the threshold it
  // is measuring against — so this rule reads a verdict rather than forming
  // one, and the counts are only ever used to say how far short.
  //
  // NO DOLLAR FIGURE. An ad set stuck in learning is not spend at risk the way
  // a campaign converting nothing is: it delivers, it just delivers worse and
  // less predictably, and what that costs is the difference between the results
  // it got and the ones a settled ad set would have got — which nothing here
  // can see. The spend is named in the evidence as what is being spent under an
  // unstable model, never claimed as a saving. Same call `rank_limited` makes.
  for (const a of input.adSets ?? []) {
    if (!signals.learningState) break;
    if (a.costMicros < THRESHOLDS.learningAdSetMinSpendMicros) continue;
    const reading = learningReading(a);
    // Only the platform saying it does not expect to get there. LEARNING is the
    // ordinary state of a new ad set and resolves by itself; raising a row on it
    // would fire on every launch and teach people to scroll past the ones that
    // matter. An unreadable state says nothing — it was never asked.
    if (reading.verdict !== "limited") continue;

    // A campaign under a restricted-advertising category has age, gender and
    // detailed targeting stripped, so the usual "widen the audience" answer is
    // not one that exists on it. Read from the campaign the ad set sits under;
    // absent means the adapter did not read it, and nothing is assumed.
    const parent = a.campaignId ? input.campaigns.find((c) => c.id === a.campaignId) : undefined;
    const restricted = parent?.specialAdCategories ?? null;
    const isRestricted = Array.isArray(restricted) && restricted.length > 0;

    const shortClause = reading.shortBy != null && reading.shortBy > 0
      ? `It is about ${reading.shortBy} event(s) short of the threshold it is measured against.`
      : reading.events == null
        ? `How far short it is was not reported, so the size of the gap is unknown.`
        : `It is at or above the threshold on the counts reported and the platform still says it cannot settle, which usually means the events are arriving too unevenly to learn from.`;

    const fixes = [
      "Fewer ad sets carrying more of the budget, so one of them clears the threshold instead of several falling short.",
      "A shallower event to optimise for, where one exists that is still worth having — only the optimisation event counts, so a deeper one on a small account counts almost nothing.",
      isRestricted
        ? `This campaign runs under a restricted-advertising category (${restricted!.join(", ")}), so age, gender and detailed targeting are stripped and "broaden the audience" is not an option that exists on it.`
        : "A wider audience, so the same budget reaches enough people to produce the event more often.",
      "Leaving it alone once it is changed. Every significant edit restarts the count, so a week of small adjustments keeps an ad set permanently short.",
    ];

    out.push({
      entityType: "campaign", entityId: `${a.id}:learning`, entityName: a.name,
      findingType: "learning_limited",
      severity: "high",
      riskLevel: "medium",
      // Consolidating ad sets, changing the optimisation event and widening an
      // audience are all structural decisions about how the account is built,
      // and none has a guarded path here. Budget is the one thing this system
      // can change, and more budget on an ad set optimising for an event that
      // barely happens buys more of an unstable signal rather than a stable one.
      applicability: "vendor",
      title: `"${a.name}" is not getting enough of the event it optimises for to settle`,
      summary: `The platform's own reading of this ad set is ${reading.status}: it does not expect to gather enough of the one `
        + `event this ad set optimises for to stop guessing. ${shortClause} Until it does, what the ad set delivers stays `
        + `unstable, the cost per result moves week to week, and any comparison drawn against another ad set is a comparison `
        + `between two guesses.`,
      evidence: {
        metrics: {
          costMicros: a.costMicros,
          ...(reading.events != null ? { learningEvents: reading.events } : {}),
          learningThreshold: reading.threshold,
          ...(reading.shortBy != null ? { shortBy: reading.shortBy } : {}),
        },
        ...win,
        lines: [
          ...reading.lines,
          a.campaignName ? `Ad set in "${a.campaignName}"` : "The campaign this ad set sits under was not read",
          ...fixes,
        ],
      },
      estImpactCents: 0,
      impactUnit: "usd_month",
      impactAssumption: "No figure claimed. What an unsettled ad set costs is the difference between the results it got and the "
        + "ones a settled one would have got, and nothing here can see the second of those. The spend named above is what is "
        + "being spent under a model that is still guessing, not a saving.",
      changePayload: null,
      guardNote: "No API change proposed. Consolidating ad sets, changing the optimisation event and widening an audience are "
        + "decisions about how the account is built, and none of them has a guarded path here — deliberately.",
    });
  }

  // ── 6. Does anything tell this account which leads became customers? ──────
  // The account buys form fills, and the platform only ever learns which
  // clicks produced one. Which of those became a customer is in the client's
  // CRM and nothing sends it back. This row says whether it COULD be sent, per
  // client, from data already here — and it deliberately stops short of saying
  // it should be. See the OCH note in docs/agent-reports/ads-revenue-insights.md.
  // Gated on this system capturing THIS PLATFORM'S click identifier on a lead.
  // Where it does not, the chain does not exist to be read: the row would
  // report `no_click_ids` on every account and send somebody to fix the wrong
  // platform's tagging. That is a different answer from a thin chain and it is
  // said in the report rather than on a finding row nobody can close.
  const readiness = signals.clickIdOnLead ? outcomeReadiness(input.outcomes, input.economics) : null;
  if (readiness && accountWorthARow) {
    const perMonth = readiness.outcomesPerMonth;
    const thin = readiness.verdict === "too_thin_to_bid";
    out.push({
      entityType: "account", entityId: `${input.accountId}:outcome_feedback`, entityName: "Closed outcomes",
      findingType: "outcome_feedback_gap",
      severity: readiness.verdict === "no_click_ids" ? "high" : "medium",
      riskLevel: "medium",
      // There is no guarded path for writing a conversion action or uploading a
      // conversion, and there should not be one: it changes what the account
      // optimises toward, unattended, on a live account.
      applicability: "vendor",
      title: readiness.verdict === "no_click_ids"
        ? "No lead on this account carries a Google click id, so no customer can ever be traced back to a click"
        : readiness.verdict === "no_outcomes"
          ? "Clicks are being captured and nothing records which of them became a customer"
          : thin
            ? `This account closes about ${(perMonth ?? 0).toFixed(1)} outcome(s) a month — too few for a platform to bid on`
            : `This account closes about ${(perMonth ?? 0).toFixed(1)} outcomes a month, which is enough volume to be a decision`,
      summary: readiness.verdict === "no_click_ids"
        ? "The platform can only ever learn from clicks it can identify. A click id that is not captured today cannot be recovered later, so every day this runs is a day of outcomes that can never be tied back to the campaign that bought them."
        : readiness.verdict === "no_outcomes"
          ? "The click ids are arriving and nothing on the other end closes the loop. Until a CRM outcome reaches a lead we captured, the only thing anyone here can say about a campaign is how many forms it filled in."
          : thin
            ? "There is a real chain here from click to closed customer, and it is far too thin to be what a bidding strategy learns from: a strategy pointed at a signal this sparse retrains on almost nothing. "
              + `What it IS enough for is our own decisions — which campaigns to fund, which terms to cut — made weekly by a person, which needs no learning volume at all. The volume figure, not a recommendation, is the finding.`
            : "The chain from click to closed customer is complete and has volume behind it. Whether the platform should be bidding on it is a decision for a person and is recorded nowhere yet; this row exists so the decision can be made on numbers rather than on an assumption.",
      evidence: {
        metrics: readiness.metrics,
        ...win,
        lines: [
          ...readiness.lines,
          ...readiness.blockers,
          ...(perMonth != null
            ? [`About ${perMonth.toFixed(1)} closed outcome(s) a month, against the ${MIN_MONTHLY_OUTCOMES_FOR_BIDDING} a month a bidding strategy is widely said to need — a convention, not something checked here`]
            : []),
        ],
      },
      // No dollar figure, deliberately. What this is worth is the difference
      // between the decisions taken on form fills and the ones that would be
      // taken on customers, and nothing here can price a decision nobody made.
      estImpactCents: 0,
      impactUnit: "usd_month",
      impactAssumption: readiness.measuredValueCents != null
        ? `No figure claimed. The CRM's own amounts put one of these outcomes at about $${(readiness.measuredValueCents / 100).toFixed(2)}, measured rather than assumed, and it is stated here for context only — `
          + `multiplying it by anything would be a claim about decisions nobody has taken.`
        : "No figure claimed, and none can be: nothing has measured what one of these outcomes is worth. A value on the client record is not a measurement unless the client supplied it.",
      changePayload: null,
      guardNote: "Nothing here is applied. Uploading an outcome, or changing what a conversion action does, is outside the guarded path on purpose — it changes what a live account bids toward.",
    });
  }

  // ── 7. Can the bidding learn, can the platform be told about an outage,
  //       and does anything say what a lead is worth? ──────────────────────
  // Their own module: three readings that share nothing with the waste rules
  // above except the account they are about.
  out.push(...readinessFindings({
    accountId: input.accountId,
    platformLabel: input.platform === "google_ads" ? "Google Ads" : input.platform === "meta" ? "Meta" : "Microsoft Advertising",
    windowStart, windowEnd,
    readiness: biddingByCampaign,
    campaigns: input.campaigns,
    tracking,
    conversionActions: input.tracking?.actions ?? null,
    economics: input.economics,
    dailyConversions: input.dailyConversions,
    // Measured from the client's CRM, never from clients.customer_value_cents,
    // which on at least one account here is explicitly our assumption.
    measuredWonValueCents: input.outcomes?.measuredWonValueCents ?? null,
    campaignMinSpendMicros: THRESHOLDS.campaignMinSpendMicros,
    accountMinSpendMicros: THRESHOLDS.accountMinSpendMicros,
    accountCostMicros: accountTotals.costMicros,
  }));


  // ── 8. What the account is not bidding on at all ─────────────────────────
  // THE ONE READING BUILT ON SOMETHING OUTSIDE THE ACCOUNT. Every rule above
  // reads what is already in it — a query only reaches the search-terms report
  // because a keyword already matched it — so nothing until now could say a
  // whole category is uncovered. This reads the keyword research this agency
  // already runs (the worker's `run-research` job, stored in Postgres) against
  // what the account holds, and it is gated on a CONFIRMED services list:
  // without one it produces nothing and says why, because a believable list of
  // demand for services a client does not offer discredits every other row.
  const gaps = keywordGaps({
    research: input.research,
    services: input.services ?? { services: null, confirmedBy: null, confirmedAt: null, candidatesWaiting: 0 },
    existingKeywords: input.existingKeywords,
    seenTerms: input.searchTerms.map((t) => t.term),
    existingNegatives: input.existingNegatives,
    // The proof half of relevance: a query that already became an enquiry here
    // is proof this client provides the thing, not an inference from a name.
    // Only the primary column, for `query-promotion.ts`'s reason.
    provenQueries: input.searchTerms
      .filter((t) => t.conversions > 0)
      .map((t) => ({ term: t.term, conversions: t.conversions })),
    protectedPatterns: input.protectedPatterns,
    // Composed from the coverage the search-terms report actually had, so
    // "we have not seen this query" is weakened where the report saw little.
    accountTermCoverage: input.searchTermSpendByCampaign != null && accountTotals.costMicros > 0
      ? Object.values(input.searchTermSpendByCampaign).reduce((a, b) => a + b, 0) / accountTotals.costMicros
      : null,
  });
  for (const g of gaps.services) {
    out.push({
      entityType: "account", entityId: `${input.accountId}:gap:${g.service.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      entityName: g.service, campaignId: null,
      findingType: "keyword_gap",
      // Never high. Nothing is going wrong: this is demand nobody has built
      // for, and building is a project rather than a fix.
      severity: "medium",
      riskLevel: "low",
      // Building for uncovered demand means a campaign or an ad group — a
      // judgement about structure, budget, copy and a landing page. None of it
      // is mechanical and none of it is in the guarded operation list.
      applicability: "vendor",
      title: `"${g.service}" has ${g.totalVolume.toLocaleString()} searches a month and nothing in this account bids on it`,
      summary: `These terms are a service this client has on record and the account has never been seen on any of them — they are in no keyword, `
        + `in ninety days of search terms, or blocked by a negative somebody added deliberately. Whether this is worth building is a judgement about `
        + `structure, budget, copy and a landing page; nothing here proposes a campaign and nothing here is applied.`,
      evidence: { metrics: g.metrics, ...win, lines: g.lines },
      // No gain is claimed. The money below is the SIZE of the demand.
      estImpactCents: 0,
      impactUnit: "usd_month",
      atStakeCents: g.marketCostCents,
      impactAssumption: gapClaim(g, gaps.coverageTrusted)
        + ` Terms under ${GAP_MIN_TERM_VOLUME} searches a month are left out, and a service whose uncovered terms come to under ${GAP_MIN_SERVICE_VOLUME} a month is not raised at all.`,
      changePayload: null,
      guardNote: "Nothing to apply. Creating a campaign or an ad group is outside the guarded operation list by design.",
    });
  }

  // ── 9. What has to exist before traffic is worth sending ─────────────────
  // Its own module, on `shared/data-gaps.ts`'s rules rather than inside it —
  // that resolver reads Postgres and the app may never call an ad platform,
  // and both of these are built on facts only an adapter holds.
  const trafficChecks = trafficReadiness({
    campaigns: input.campaigns.map((c) => ({ id: c.id, name: c.name, costMicros: c.costMicros, channelType: c.channelType })),
    destinations: input.ads
      .filter((a): a is AdGroupAdRow & { campaignId: string } => Boolean(a.campaignId))
      .map((a): AdDestination => ({
        campaignId: a.campaignId, campaignName: a.campaignName,
        adGroupName: a.adGroupName, finalUrl: a.finalUrl ?? null,
      })),
    conversionActions: input.tracking?.actions ?? null,
    phone: input.phone,
    campaignMinSpendMicros: THRESHOLDS.campaignMinSpendMicros,
    windowDays: 30,
  });
  for (const r of trafficChecks) {
    // `clear` and `cant_tell` are real answers and the module produces them on
    // purpose, so silence is never read as a pass — but only `open` is a row in
    // anybody's queue. A line on every campaign saying its landing pages are
    // fine is a line people learn to scroll past.
    if (r.state !== "open") continue;
    out.push({
      entityType: r.campaignId ? "campaign" : "account",
      entityId: r.campaignId ? `${r.campaignId}:${r.key}` : `${input.accountId}:${r.key}`,
      entityName: r.campaignName ?? input.accountId,
      campaignId: r.campaignId,
      findingType: r.key,
      severity: r.key === "generic_landing_page" ? "high" : "medium",
      riskLevel: "low",
      applicability: "vendor",
      title: r.title,
      summary: r.summary,
      evidence: { metrics: r.metrics, ...win, lines: r.lines },
      estImpactCents: 0,
      impactUnit: "usd_month",
      atStakeCents: r.atStakeCents,
      impactAssumption: r.key === "generic_landing_page"
        ? `The figure is this campaign's own monthly spend — the money currently landing on a page that cannot answer what was searched. `
          + `It is not a saving: a better page does not return the spend, it changes what the spend buys, and by how much is not something this can know.`
        : `The figure is the account's own monthly spend — the money whose phone enquiries are not being counted. `
          + `It is not a saving and not a gain: counting the calls changes what every figure on this account MEANS, and the share is read from the client's own lead feed `
          + `against the ${Math.round(CALL_TRACKING_PHONE_SHARE * 100)}% at which a conversion column is measuring a minority of the outcome.`,
      changePayload: null,
      guardNote: r.key === "generic_landing_page"
        ? "Nothing to apply. Choosing a landing page, or writing one, is not a guarded operation and is not mechanical."
        : "Nothing to apply. Creating or configuring a conversion action changes what a live account bids toward and is outside the guarded path on purpose.",
    });
  }

  // ── 10. Why this account has no growth findings ──────────────────────────
  // THE ROW THAT EXISTS BECAUSE THREE REFUSALS WERE BEING DROPPED ON THE
  // FLOOR. `gaps`, `promotions`, the headroom readings and the demand readings
  // above each write a precise sentence when they have nothing to say, and
  // until this nothing read any of them: the loops iterate the entries, an
  // empty list has no entries, and the reason left the process with the
  // process. An account whose growth readings are all blocked therefore looked
  // exactly like an account with no growth on it, and those are opposite
  // situations.
  //
  // It claims NOTHING — no money, no leads, no opportunity — because it does
  // not know whether there is one. That is the point of it.
  {
    const growthTypes = new Set(["headroom", "converting_search_term", "keyword_gap", "budget_limited", "unmet_demand"]);
    const growthRaised = out.filter((f) => growthTypes.has(f.findingType)).length;

    const facts: GrowthSilenceFact[] = [];

    // Cheapest to answer first, deliberately. The list is rendered in the
    // order it is built and never re-sorted by anything computed.
    if (gaps.verdict !== "found") {
      const fixable = gaps.verdict === "no_services_recorded" || gaps.verdict === "no_research" || gaps.verdict === "keywords_unread";
      facts.push({
        findingType: "keyword_gap",
        label: "Demand this client sells into that no campaign bids on",
        verdict: gaps.verdict,
        silence: gaps.silence,
        fixable,
        unlock: gaps.verdict === "no_services_recorded"
          ? "Confirm what this client actually sells, on their client page. The list is already seeded from their own converting queries, their SEO targets and their campaign names, so it is ticking rather than typing — and until somebody ticks it, a list of demand for services they do not offer is the only thing this could produce."
          : gaps.verdict === "no_research"
            ? "Run the keyword research on this client's SEO tab. This reading compares that research against what the account holds, and with no research there is nothing to compare."
            : gaps.verdict === "keywords_unread"
              ? "The account's keyword list could not be read this run. Check the connector on Admin -> Connectors; a term cannot be called missing from a list nobody could see."
              : null,
        owner: fixable ? "us" : null,
      });
    }
    if (promotions.verdict !== "found") {
      const fixable = promotions.verdict === "column_not_outcomes" || promotions.verdict === "keywords_unread";
      facts.push({
        findingType: "converting_search_term",
        label: "Searches that already convert and are not keywords yet",
        verdict: promotions.verdict,
        silence: promotions.silence,
        fixable,
        unlock: promotions.verdict === "column_not_outcomes"
          ? "Settle what this account counts as a conversion. Until a conversion here is an enquiry, a query that 'converted' may have produced a page view, and bidding deliberately on whichever queries produce the most of those is this reading doing harm rather than nothing."
          : promotions.verdict === "keywords_unread"
            ? "The account's keyword list could not be read this run, so nothing can say a converting query is missing from it."
            : null,
        owner: fixable ? "us" : null,
      });
    }
    {
      const blockedHead = headroomReadings.find((h) => h.verdict === "cant_tell");
      const anyRoom = headroomReadings.some((h) => h.verdict === "room");
      if (!anyRoom && blockedHead) {
        facts.push({
          findingType: "headroom",
          label: "Campaigns converting cheaply enough to buy more of",
          verdict: blockedHead.verdict,
          silence: blockedHead.silence,
          fixable: true,
          unlock: target == null
            ? "Record what a lead may cost this client — a cost-per-lead ceiling, or a customer value and a close rate. This reading is a MARGIN measured against that figure, so without it there is nothing to measure and no campaign on this account can be called cheap enough to buy more of."
            : "Settle what this account counts as a conversion. This reading divides money by conversions, and that division is refused outright on a column nobody has confirmed is counting enquiries.",
          owner: target == null ? "client" : "us",
        });
      }
    }
    {
      const blockedDem = demandReadings.find((d) => d.verdict === "cant_tell");
      const anyDemand = demandReadings.some((d) => d.verdict === "demand");
      if (!anyDemand && blockedDem) {
        facts.push({
          findingType: "unmet_demand",
          label: "Searches this account already bids on and is losing",
          verdict: blockedDem.verdict,
          silence: blockedDem.silence,
          fixable: true,
          unlock: "The platform reported no impression share for these campaigns. On a search campaign that is a connector or permissions problem worth checking; on a campaign that is not a search campaign there is no such figure to report and this reading has nothing to say about it.",
          owner: "us",
        });
      }
    }

    const gsr = growthSilenceReading({
      accountId: input.accountId,
      accountName: input.accountId,
      facts,
      accountCostMicros: accountTotals.costMicros,
      minSpendMicros: THRESHOLDS.accountMinSpendMicros,
      growthFindingsRaised: growthRaised,
    });
    if (gsr.verdict === "all_blocked" || gsr.verdict === "partly_blocked") {
      out.push({
        entityType: "account", entityId: `${input.accountId}:growth_unreadable`,
        entityName: input.accountId, campaignId: null,
        findingType: "growth_unreadable",
        // High only where EVERY growth reading is blocked: a queue that can
        // physically only ever show waste is a different problem from one
        // missing a reading or two, and the severity is the only thing on the
        // row that says which.
        severity: gsr.verdict === "all_blocked" ? "high" : "medium",
        riskLevel: "low",
        applicability: "vendor",
        title: gsr.title,
        summary: gsr.summary,
        evidence: { metrics: gsr.metrics, ...win, lines: gsr.lines },
        // Nought, and `RANK_BASIS` gives this type `none` rather than
        // `unpriced`: `unpriced` means a recorded figure would put the row in
        // the money order, and no figure would. This row is about the question
        // being unanswerable, not about its answer being unrecorded.
        estImpactCents: 0,
        impactUnit: "usd_month",
        impactAssumption: growthSilenceClaim(gsr),
        changePayload: null,
        guardNote: "Nothing to apply. Every line here is a figure somebody records or a connector somebody fixes, and none of it is a change to a live ad account.",
      });
    }
  }

  /**
   * ONE CAMPAIGN'S FINDINGS, READ TOGETHER.
   *
   * Everything above decides on its own. `sequenceFindings` is the only pass
   * that groups them, and it orders a campaign's rows stop -> measure ->
   * improve -> grow so nobody funds the waste before stopping it. It suppresses
   * nothing, re-prices nothing and re-severities nothing; the group holding the
   * biggest single figure still comes first, so the queue reads the same at the
   * top as it did before.
   *
   * ONE MEASURE, FIRST, so the ordering has something honest to sort on.
   * `est_impact_cents` carries dollars on one row, leads on another and nought
   * on a third; `rankImpact` puts every row that can reach one into cents a
   * month and says what KIND of claim the figure is. It changes no figure and
   * suppresses nothing — `estImpactCents`, `impactUnit`, severity and risk are
   * all untouched — and a row it cannot price keeps its campaign group and its
   * stage rather than being sunk or floated.
   */
  const ranked = out.map((f) => ({
    ...f,
    rank: rankImpact(f, targets, input.economics, f.atStakeCents ?? null),
  }));
  return sequenceFindings(ranked);
}

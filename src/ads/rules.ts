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

/**
 * Bump on ANY threshold or impact-formula change. Mirror: shared/ads-findings.ts.
 *
 * 4, not 3: the dashboard's mirror was taken to 3 by the Meta work landing
 * alongside this, and two changes must not ship under one version number —
 * a finding records the version that produced it so a row can be read back
 * against the rules of its day, and a shared number makes two sets of rules
 * indistinguishable a year later.
 */
export const ADS_RULESET_VERSION = 4;

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
}

// ── Output ───────────────────────────────────────────────────────────────────
export interface DerivedFinding {
  entityType: "campaign" | "ad_group" | "keyword" | "search_term" | "ad" | "asset" | "account";
  /** Stable identity. A platform resource id where one exists; otherwise a
   *  normalized natural key scoped to its parent, because a search term has no
   *  id and we still need the same term next week to land on the same row. */
  entityId: string;
  entityName: string;
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
        entityType: "campaign", entityId: c.id, entityName: c.name,
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
        entityType: "campaign", entityId: c.id, entityName: c.name,
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
        entityType: "campaign", entityId: c.id, entityName: c.name,
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
        entityType: "campaign", entityId: `${c.id}:cost_target`, entityName: c.name,
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
      entityType: "campaign", entityId: `${first.campaignId}:wasted_terms`, entityName: campaignName,
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
      entityType: "keyword", entityId: k.criterionResourceName, entityName: k.text,
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
  if (tracking.defects.length === 0 && tracking.unread.length > 0 && accountWorthARow) {
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

  // ── 6. Does anything tell this account which leads became customers? ──────
  // The account buys form fills, and the platform only ever learns which
  // clicks produced one. Which of those became a customer is in the client's
  // CRM and nothing sends it back. This row says whether it COULD be sent, per
  // client, from data already here — and it deliberately stops short of saying
  // it should be. See the OCH note in docs/agent-reports/ads-revenue-insights.md.
  const readiness = outcomeReadiness(input.outcomes, input.economics);
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

  return out.sort((a, b) => b.estImpactCents - a.estImpactCents);
}

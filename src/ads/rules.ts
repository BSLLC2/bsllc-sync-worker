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

/** Bump on ANY threshold or impact-formula change. Mirror: shared/ads-findings.ts. */
export const ADS_RULESET_VERSION = 1;

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

  // ── 1. Campaign-level: budget-limited, rank-limited, converting nothing ────
  for (const c of input.campaigns) {
    if (c.costMicros < THRESHOLDS.campaignMinSpendMicros) continue;

    const budgetLost = c.budgetLostShare ?? 0;
    if (budgetLost > THRESHOLDS.budgetLostShare) {
      const converting = c.conversions > 0;
      // Only propose money at a campaign that is already converting. Raising
      // budget on a campaign that converts nothing buys more of what is not
      // working — the single most common bad recommendation in paid search.
      const uplift = Math.round(c.costMicros * budgetLost * BUDGET_CAPTURE_RATE);
      const newDailyUsd = Math.round((c.dailyBudgetMicros / 1_000_000) * 1.25 * 100) / 100;
      out.push({
        entityType: "campaign", entityId: c.id, entityName: c.name,
        findingType: "budget_limited",
        severity: budgetLost > THRESHOLDS.budgetLostShareHigh ? "high" : "medium",
        riskLevel: converting ? "low" : "high",
        applicability: converting && c.budgetResourceName ? "api" : "vendor",
        title: converting
          ? `"${c.name}" is budget-capped and converting — it loses ${pct(budgetLost)} of impressions to budget`
          : `"${c.name}" is budget-capped but converting nothing — fix relevance before adding budget`,
        summary: converting
          ? `The campaign gave up ${pct(budgetLost)} of its available impressions because the daily budget ran out, `
            + `while producing ${c.conversions.toFixed(1)} conversions on ${usd(c.costMicros)}. Raising budget buys more of what already works.`
          : `The campaign gave up ${pct(budgetLost)} of its impressions to budget but recorded no conversions on ${usd(c.costMicros)}. `
            + `More budget would buy more of what is not working. Fix targeting, landing page or tracking first.`,
        evidence: {
          metrics: {
            costMicros: c.costMicros, clicks: c.clicks, conversions: c.conversions,
            budgetLostShare: budgetLost, impressionShare: c.impressionShare ?? 0,
            dailyBudgetMicros: c.dailyBudgetMicros,
          },
          ...win,
          lines: [
            `${usd(c.costMicros)} spent · ${c.clicks} clicks · ${c.conversions.toFixed(1)} conversions (30 days)`,
            `Impression share ${pct(c.impressionShare ?? 0)} · lost to budget ${pct(budgetLost)}`,
            `Daily budget ${usd(c.dailyBudgetMicros)}`,
          ],
        },
        estImpactCents: converting ? microsToCents(uplift) : 0,
        impactUnit: "usd_month",
        impactAssumption: converting
          ? `Assumes we capture ${pct(BUDGET_CAPTURE_RATE)} of the impression share currently lost to budget at today's cost per click. `
            + `Impression share lost is not demand gained — the auction does not hand it over one-for-one.`
          : `No impact claimed: this campaign converts nothing, so extra budget has no modelled return.`,
        changePayload: converting && c.budgetResourceName
          ? {
              op: "budgets",
              body: [{ campaign: c.name, newDailyUsd, reason: `Budget-capped: losing ${pct(budgetLost)} of impressions to budget while converting.` }],
              plainEnglish: `Raise "${c.name}" from ${usd(c.dailyBudgetMicros)}/day to $${newDailyUsd.toFixed(2)}/day (+25%).`,
              guard: `Budget guard: refuses any move above 2× the current budget or more than $100/day in one run. A 25% step is well inside both.`,
            }
          : null,
        guardNote: converting
          ? "Budget guard: max 2× and max $100/day movement per run."
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

    if (c.clicks >= THRESHOLDS.noConversionClicks && c.conversions === 0) {
      out.push({
        entityType: "campaign", entityId: c.id, entityName: c.name,
        findingType: "no_conversions", severity: "high", riskLevel: "medium",
        applicability: "vendor",
        title: `"${c.name}" took ${c.clicks} clicks and ${usd(c.costMicros)} with zero conversions`,
        summary: `At this click volume, zero conversions is almost always one of two things: conversion tracking is broken, `
          + `or the traffic is wrong. Check tracking FIRST — pausing a campaign whose conversions simply aren't being recorded is an expensive mistake.`,
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
  }

  // ── 2. Search terms — the biggest single source of waste ──────────────────
  // Grouped per campaign so one negative-keyword change carries many terms,
  // which is both how a human would do it and far fewer approvals to press.
  const wasteByCampaign = new Map<string, SearchTermRow[]>();
  for (const t of input.searchTerms) {
    if (t.conversions > 0 || t.allConversions > 0) continue;
    if (t.costMicros < THRESHOLDS.searchTermWasteMicros) continue;
    if (input.existingNegatives.has(t.term.toLowerCase())) continue;
    // A protected term is one the client has told us never to block. Blocking a
    // partner or brand term by accident costs far more than the spend it saves,
    // so it is filtered here AND refused again by the apply path's guard.
    if (isProtected(t.term)) continue;
    wasteByCampaign.set(t.campaignName, [...(wasteByCampaign.get(t.campaignName) ?? []), t]);
  }

  for (const [campaignName, terms] of wasteByCampaign) {
    const sorted = [...terms].sort((a, b) => b.costMicros - a.costMicros);
    const first = sorted[0];
    if (!first) continue;
    const total = sorted.reduce((s, t) => s + t.costMicros, 0);
    const monthly = Math.round(total / 3);                 // 90-day window → per month
    const recoverable = Math.round(monthly * RECOVERY_RATE);
    out.push({
      entityType: "campaign", entityId: `${first.campaignId}:wasted_terms`, entityName: campaignName,
      findingType: "wasted_search_term", severity: "high", riskLevel: "low",
      applicability: "api",
      title: `${sorted.length} search terms in "${campaignName}" spent ${usd(total)} converting nothing`,
      summary: `These queries matched, took clicks and produced nothing over 90 days. Adding them as phrase negatives on the `
        + `campaign stops the spend without touching bids, budgets or ad copy. Every one is checked against the protected-term `
        + `list first, and any already present as a negative is skipped rather than duplicated.`,
      evidence: {
        metrics: {
          termCount: sorted.length, costMicros: total,
          clicks: sorted.reduce((s, t) => s + t.clicks, 0), conversions: 0,
        },
        ...win,
        lines: sorted.slice(0, 12).map((t) => `${usd(t.costMicros)} · ${t.clicks} clicks · "${t.term}"`)
          .concat(sorted.length > 12 ? [`…and ${sorted.length - 12} more`] : []),
      },
      estImpactCents: microsToCents(recoverable),
      impactUnit: "usd_month",
      impactAssumption: `${usd(total)} over 90 days is ${usd(monthly)}/month; we claim ${Math.round(RECOVERY_RATE * 100)}% of it. `
        + `The haircut is because some of this traffic would have converted eventually and some terms are relevant but badly landed — `
        + `claiming the full figure promises a saving we can't deliver.`,
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
  const deadKeywords = input.keywords.filter(
    (k) => k.conversions === 0 && k.costMicros >= THRESHOLDS.keywordWasteMicros,
  );
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

  const lowQs = input.keywords.filter((k) => (k.qualityScore ?? 0) > 0 && (k.qualityScore as number) < THRESHOLDS.qualityScoreFloor);
  if (lowQs.length) {
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
  if (thin.length) {
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
  if (weak.length) {
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

  return out.sort((a, b) => b.estImpactCents - a.estImpactCents);
}

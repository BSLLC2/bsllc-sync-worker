/**
 * Google Ads adapter — the reference implementation of PlatformAdapter.
 *
 * Reads are the same GAQL the read-only audit has always used (search terms,
 * budgets, keywords, ad strength), normalized into the rules engine's
 * platform-neutral shapes. Writes go through `applyChangeSet` in
 * src/apply-ads-changes.ts — the SAME guarded function the hand-run CLI uses,
 * so approving a finding in the dashboard cannot reach an operation the CLI
 * would refuse.
 *
 * Read the capability block below before promising a client anything: it is the
 * short version of docs/ADS_PLATFORM_CAPABILITIES.md, kept next to the code so
 * it goes stale slower.
 */

import { GoogleAdsApi } from "google-ads-api";
import {
  applyChangeSet, rollbackChangeSet, openCustomer,
  type ChangeSet, type PriorValue,
} from "../apply-ads-changes.js";
import type {
  PlatformAdapter, PlatformCapabilities, AdapterContext, ValidationResult, ApplyResult, VerifyMetrics,
} from "./platform.js";
import type {
  AuditInput, CampaignRow, SearchTermRow, KeywordRow, AdGroupAdRow,
  ConversionActionRow, TrackingFacts,
} from "./rules.js";
import type { ConversionLagRow } from "./bidding-readiness.js";
import type { DailyConversionRow } from "./tracking-outage.js";
import type { ExistingKeyword } from "./query-promotion.js";

/** The API returns enums as integers over REST, not their string names, so a
 *  `=== "BROAD"` comparison silently never matches. Map both forms. */
const MATCH_TYPE: Record<string, string> = {
  "2": "EXACT", "3": "PHRASE", "4": "BROAD", EXACT: "EXACT", PHRASE: "PHRASE", BROAD: "BROAD",
};
const matchType = (v: unknown): string => MATCH_TYPE[String(v ?? "")] ?? String(v ?? "?");

/**
 * The same indignity, for the enums the conversion-tracking reading decides on.
 *
 * `trackingReading` refuses to compute money when a counting action's category
 * is a page view, and it decides that by comparing the category to Google's own
 * word for it. Over REST that word arrives as `"3"`. A comparison against
 * `"PAGE_VIEW"` would therefore never match, on every account, silently — the
 * rule would read as "nothing wrong here" forever and nothing would say so.
 * Normalising happens HERE rather than in the rules, because which shape an
 * enum arrives in is one vendor's API and the rules are platform-neutral.
 *
 * Values from the read-only diagnostics that already decode them
 * (src/dump-ads-conversions.ts, src/diagnose-och-ads.ts). A number this map
 * does not know passes through as its own digits rather than being guessed at,
 * and an unknown category reads as ambiguous, which is the safe direction.
 */
export const CONVERSION_CATEGORY: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "DEFAULT", "3": "PAGE_VIEW", "4": "PURCHASE",
  "5": "SIGNUP", "6": "LEAD", "7": "DOWNLOAD", "8": "ADD_TO_CART", "9": "BEGIN_CHECKOUT",
  "10": "SUBSCRIBE_PAID", "11": "PHONE_CALL_LEAD", "12": "IMPORTED_LEAD", "13": "SUBMIT_LEAD_FORM",
  "14": "BOOK_APPOINTMENT", "15": "REQUEST_QUOTE", "16": "GET_DIRECTIONS", "17": "OUTBOUND_CLICK",
  "18": "CONTACT", "19": "ENGAGEMENT", "20": "STORE_VISIT", "21": "STORE_SALE",
  "22": "QUALIFIED_LEAD", "23": "CONVERTED_LEAD",
};
const CONVERSION_STATUS: Record<string, string> = { "2": "ENABLED", "3": "REMOVED", "4": "HIDDEN" };
const CONVERSION_TYPE: Record<string, string> = {
  "2": "AD_CALL", "3": "CLICK_TO_CALL", "4": "GOOGLE_PLAY_DOWNLOAD", "5": "GOOGLE_PLAY_IN_APP_PURCHASE",
  "6": "UPLOAD_CALLS", "7": "UPLOAD_CLICKS", "8": "WEBPAGE", "9": "WEBSITE_CALL",
  "10": "STORE_SALES_DIRECT_UPLOAD", "11": "STORE_SALES", "12": "FIREBASE_ANDROID_FIRST_OPEN",
  "16": "GOOGLE_ANALYTICS_4_CUSTOM", "17": "GOOGLE_ANALYTICS_4_PURCHASE",
};
/**
 * The bidding strategy a campaign is on. The readiness reading turns on this
 * value — a campaign under the published conversion minimum matters where it
 * runs a strategy with a conversion target and does not where it does not —
 * so an undecoded integer here would make every account read as having no
 * target strategy anywhere, silently and forever. Same indignity, same fix.
 */
export const BIDDING_STRATEGY_TYPE: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "ENHANCED_CPC", "3": "MANUAL_CPC", "4": "MANUAL_CPM",
  "5": "PAGE_ONE_PROMOTED", "6": "TARGET_CPA", "7": "TARGET_OUTRANK_SHARE", "8": "TARGET_ROAS",
  "9": "TARGET_SPEND", "10": "MAXIMIZE_CONVERSIONS", "11": "MAXIMIZE_CONVERSION_VALUE",
  "12": "PERCENT_CPC", "13": "MANUAL_CPV", "14": "TARGET_CPM", "15": "TARGET_IMPRESSION_SHARE",
  "16": "COMMISSION", "17": "INVALID", "18": "MANUAL_CPA", "19": "FIXED_CPM",
  "20": "TARGET_CPV", "21": "TARGET_CPC", "22": "FIXED_SHARE_OF_VOICE",
};
/**
 * What kind of campaign it is. Undecoded, a Search campaign arrives as "2",
 * which matches no channel name — so the coverage reading treated EVERY search
 * campaign as one with no search-terms report and skipped the check entirely,
 * while printing "no search-terms report exists for a 2 campaign". Same defect
 * as the conversion-action enums, one field along.
 */
export const ADVERTISING_CHANNEL_TYPE: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "SEARCH", "3": "DISPLAY", "4": "SHOPPING",
  "5": "HOTEL", "6": "VIDEO", "7": "MULTI_CHANNEL", "8": "LOCAL", "9": "SMART",
  "10": "PERFORMANCE_MAX", "11": "LOCAL_SERVICES", "12": "DISCOVERY", "13": "TRAVEL",
  "14": "DEMAND_GEN",
};
/** How long after the click a conversion arrived, as the platform buckets it. */
export const CONVERSION_LAG_BUCKET: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "LESS_THAN_ONE_DAY", "3": "ONE_TO_TWO_DAYS",
  "4": "TWO_TO_THREE_DAYS", "5": "THREE_TO_FOUR_DAYS", "6": "FOUR_TO_FIVE_DAYS",
  "7": "FIVE_TO_SIX_DAYS", "8": "SIX_TO_SEVEN_DAYS", "9": "SEVEN_TO_EIGHT_DAYS",
  "10": "EIGHT_TO_NINE_DAYS", "11": "NINE_TO_TEN_DAYS", "12": "TEN_TO_ELEVEN_DAYS",
  "13": "ELEVEN_TO_TWELVE_DAYS", "14": "TWELVE_TO_THIRTEEN_DAYS", "15": "THIRTEEN_TO_FOURTEEN_DAYS",
  "16": "FOURTEEN_TO_TWENTY_ONE_DAYS", "17": "TWENTY_ONE_TO_THIRTY_DAYS",
  "18": "THIRTY_TO_FORTY_FIVE_DAYS", "19": "FORTY_FIVE_TO_SIXTY_DAYS", "20": "SIXTY_TO_NINETY_DAYS",
};
/** Only the value the tracking reading actually branches on. */
export const TRACKING_STATUS: Record<string, string> = {
  "2": "NOT_CONVERSION_TRACKED", "3": "CONVERSION_TRACKING_MANAGED_BY_SELF",
  "4": "CONVERSION_TRACKING_MANAGED_BY_THIS_MANAGER", "5": "CONVERSION_TRACKING_MANAGED_BY_ANY_MANAGER",
};
/** A string already in Google's own words passes through untouched, so the
 *  normalisation is safe whichever shape a future client library returns. */
export function enumName(map: Record<string, string>, v: unknown): string | null {
  if (v == null) return null;
  const raw = String(v);
  if (map[raw]) return map[raw];
  const upper = raw.toUpperCase();
  return Object.values(map).includes(upper) ? upper : raw;
}

/** Run a GAQL query, returning [] and logging rather than throwing — one
 *  unsupported field must not sink the whole audit. */
async function safeQuery(customer: any, label: string, gaql: string, onLog?: (s: string) => void): Promise<any[]> {
  try {
    return await customer.query(gaql);
  } catch (e: any) {
    const msg = e?.errors?.map((x: any) => x.message).join("; ") || e?.message || String(e);
    (onLog ?? console.log)(`    ⚠ ${label} query failed: ${msg.slice(0, 200)}`);
    return [];
  }
}

/**
 * The same query, with the one distinction `safeQuery` cannot make: null when
 * the query threw, an array when it ran. Used only where an empty result is
 * itself a finding — an account with no conversion actions is broken, and a
 * query that failed is not, and the two must never be the same value.
 */
async function tryQuery(customer: any, label: string, gaql: string, onLog?: (s: string) => void): Promise<any[] | null> {
  try {
    return await customer.query(gaql);
  } catch (e: any) {
    const msg = e?.errors?.map((x: any) => x.message).join("; ") || e?.message || String(e);
    (onLog ?? console.log)(`    ⚠ ${label} query failed: ${msg.slice(0, 200)}`);
    return null;
  }
}

export class GoogleAdsAdapter implements PlatformAdapter {
  readonly platform = "google_ads" as const;

  constructor(
    private readonly api: GoogleAdsApi,
    private readonly cfg: { loginCustomerId: string; refreshToken: string },
    private readonly onLog: (s: string) => void = console.log,
  ) {}

  private customerCache = new Map<string, any>();
  private async customer(accountId: string): Promise<any> {
    const hit = this.customerCache.get(accountId);
    if (hit) return hit;
    const c = await openCustomer(this.api, this.cfg, accountId);
    this.customerCache.set(accountId, c);
    return c;
  }

  capabilities(): PlatformCapabilities {
    return {
      platform: "google_ads",
      label: "Google Ads",
      credentialed: Boolean(this.cfg.refreshToken),
      canChange: {
        budgets: true,
        bidStrategy: true,          // the API can; we deliberately have no guarded path
        keywords: true,
        negativeKeywords: true,
        audiences: true,
        targeting: true,
        statusChanges: true,
        // A served Google ad is effectively immutable: the API rejects edits to
        // an existing ad's text. "Changing an ad" means creating a new one and
        // pausing the old, which resubmits for policy review. On a
        // LegitScript-certified account that is a risk we do not take unattended.
        creativeEdit: false,
        creativeCreate: true,       // possible; deliberately out of our scope
        finalUrls: true,
        assetDetach: true,
      },
      guardedOps: ["budgets", "campaignNegatives", "removeCampaignNegatives", "keywordFinalUrls", "removeAssets", "dataExclusions"],
      notes: [
        "Ad copy is out of scope by policy, not by API limitation — OCH runs under LegitScript.",
        "Performance Max exposes asset groups, budget and (limited) signals; it does not expose keyword-level control, so PMax findings are budget/asset shaped only.",
        "Bid strategy changes are within the API but have no guarded path here — they become vendor briefs.",
        "A data exclusion tells Smart Bidding to ignore conversion data over a past date range. It is the one guarded operation that changes what the platform LEARNS rather than what it serves, it may cover at most 14 days, and the account is re-read over those exact dates before it is written — conversions backfill, and excluding a range that has since filled in throws real signal away.",
      ],
    };
  }

  // ── Read ───────────────────────────────────────────────────────────────────
  async read(ctx: AdapterContext): Promise<AuditInput> {
    const customer = await this.customer(ctx.accountId);
    const log = this.onLog;

    // Impression-share metrics are averaged over whatever window you ask for, so
    // a trailing-30 figure and a trailing-7 figure can differ enormously right
    // after a structural change. The rules run on the 30-day figure; the 7-day
    // one is pulled so the evidence lines can show both and nobody has to argue
    // about whose number is right.
    const campaignRows = await safeQuery(customer, "campaign 30d", `
      SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
             campaign.resource_name, campaign.bidding_strategy_type,
             campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas,
             campaign.maximize_conversions.target_cpa_micros,
             campaign.maximize_conversion_value.target_roas,
             campaign_budget.resource_name, campaign_budget.amount_micros,
             metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions,
             metrics.search_impression_share, metrics.search_budget_lost_impression_share,
             metrics.search_rank_lost_impression_share
        FROM campaign
       WHERE segments.date DURING LAST_30_DAYS AND campaign.status = 'ENABLED'`, log);

    const campaigns: CampaignRow[] = campaignRows.map((r: any) => ({
      id: String(r.campaign?.id ?? ""),
      name: String(r.campaign?.name ?? ""),
      // Decoded, not stringified: see ADVERTISING_CHANNEL_TYPE. enumName returns
      // null for a value the map does not know, and null reads as "not read"
      // rather than as "not a search campaign" — an unknown channel must not
      // silently switch the coverage check off.
      channelType: enumName(ADVERTISING_CHANNEL_TYPE, r.campaign?.advertising_channel_type),
      dailyBudgetMicros: Number(r.campaign_budget?.amount_micros ?? 0),
      budgetResourceName: r.campaign_budget?.resource_name ?? null,
      costMicros: Number(r.metrics?.cost_micros ?? 0),
      clicks: Number(r.metrics?.clicks ?? 0),
      impressions: Number(r.metrics?.impressions ?? 0),
      conversions: Number(r.metrics?.conversions ?? 0),
      impressionShare: r.metrics?.search_impression_share != null ? Number(r.metrics.search_impression_share) : null,
      budgetLostShare: r.metrics?.search_budget_lost_impression_share != null ? Number(r.metrics.search_budget_lost_impression_share) : null,
      rankLostShare: r.metrics?.search_rank_lost_impression_share != null ? Number(r.metrics.search_rank_lost_impression_share) : null,
      resourceName: r.campaign?.resource_name ? String(r.campaign.resource_name) : null,
      bidStrategyType: enumName(BIDDING_STRATEGY_TYPE, r.campaign?.bidding_strategy_type),
      // Google returns a target field only where one is set, and a nought where
      // it is not. Both read as "no target", which for a Maximize strategy is
      // the answer that decides whether the conversion floor applies to it at
      // all — so it is computed from the fields that came back rather than left
      // null, and the campaign query either ran for every row or for none.
      hasBidTarget: [
        r.campaign?.target_cpa?.target_cpa_micros,
        r.campaign?.target_roas?.target_roas,
        r.campaign?.maximize_conversions?.target_cpa_micros,
        r.campaign?.maximize_conversion_value?.target_roas,
      ].some((v) => v != null && Number(v) > 0),
    }));

    // Existing negatives, so we never propose a duplicate.
    const negRows = await safeQuery(customer, "negative keywords", `
      SELECT campaign.name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
        FROM campaign_criterion
       WHERE campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'`, log);
    const existingNegatives = new Set<string>(
      negRows.map((r: any) => String(r.campaign_criterion?.keyword?.text ?? "").toLowerCase()).filter(Boolean),
    );

    // ── Every keyword the account holds, as a SETTINGS read ────────────────
    // Not the `keyword_view` pull below: that one is filtered to
    // `cost_micros > 0` and capped at 300 rows, so a keyword that took no
    // clicks in the window is missing from it — and "missing from a
    // performance report" is not "not in the account". The promotion rule
    // proposes adding keywords, so it checks against the whole list or it
    // proposes nothing at all; `tryQuery` returns null on a failed read and
    // null is what makes the rule silent rather than confident.
    //
    // No date segment, so no metrics come back and the row count is the
    // account's live keyword count rather than a window's worth of them.
    const kwListRows = await tryQuery(customer, "keyword list", `
      SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
             ad_group.name, campaign.name
        FROM ad_group_criterion
       WHERE ad_group_criterion.type = 'KEYWORD'
         AND ad_group_criterion.negative = FALSE
         AND ad_group_criterion.status = 'ENABLED'
         AND ad_group.status = 'ENABLED'
         AND campaign.status = 'ENABLED'`, log);
    const existingKeywords: ExistingKeyword[] | null = kwListRows
      ? kwListRows.map((r: any) => ({
          text: String(r.ad_group_criterion?.keyword?.text ?? ""),
          matchType: matchType(r.ad_group_criterion?.keyword?.match_type),
          adGroupName: r.ad_group?.name ? String(r.ad_group.name) : null,
          campaignName: r.campaign?.name ? String(r.campaign.name) : null,
        })).filter((k: ExistingKeyword) => k.text.length > 0)
      : null;

    // GAQL's DURING literals stop at LAST_30_DAYS — there is no LAST_90_DAYS —
    // so the 90-day windows are an explicit BETWEEN range.
    const termRows = await safeQuery(customer, "search terms", `
      SELECT search_term_view.search_term, campaign.id, campaign.name, ad_group.name,
             metrics.cost_micros, metrics.clicks, metrics.impressions,
             metrics.conversions, metrics.all_conversions
        FROM search_term_view
       WHERE segments.date BETWEEN '${ctx.windowStart}' AND '${ctx.windowEnd}' AND metrics.cost_micros > 0
       ORDER BY metrics.cost_micros DESC
       LIMIT 500`, log);

    // The same query row can appear under several ad groups; the rules care
    // about the term's TOTAL cost in a campaign, so fold before evaluating —
    // otherwise a term split across three ad groups reads as three cheap terms
    // and slips under the waste floor.
    const termAcc = new Map<string, SearchTermRow>();
    for (const r of termRows) {
      const term = String(r.search_term_view?.search_term ?? "");
      const campaignId = String(r.campaign?.id ?? "");
      const key = `${campaignId}::${term.toLowerCase()}`;
      const prev = termAcc.get(key);
      const row: SearchTermRow = {
        term, campaignId,
        campaignName: String(r.campaign?.name ?? ""),
        adGroupName: r.ad_group?.name ? String(r.ad_group.name) : null,
        costMicros: Number(r.metrics?.cost_micros ?? 0),
        clicks: Number(r.metrics?.clicks ?? 0),
        conversions: Number(r.metrics?.conversions ?? 0),
        allConversions: Number(r.metrics?.all_conversions ?? 0),
      };
      if (!prev) { termAcc.set(key, row); continue; }
      prev.costMicros += row.costMicros;
      prev.clicks += row.clicks;
      prev.conversions += row.conversions;
      prev.allConversions += row.allConversions;
    }

    // Live criteria only. A keyword paused mid-window still carries its spend
    // for the trailing 90 days, so an unfiltered pull reports keywords that were
    // dealt with weeks ago as though they were open waste.
    const kwRows = await safeQuery(customer, "keywords", `
      SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text,
             ad_group_criterion.keyword.match_type,
             ad_group_criterion.quality_info.quality_score,
             ad_group_criterion.final_urls,
             campaign.id, campaign.name, ad_group.name,
             metrics.cost_micros, metrics.clicks, metrics.conversions
        FROM keyword_view
       WHERE segments.date BETWEEN '${ctx.windowStart}' AND '${ctx.windowEnd}' AND metrics.cost_micros > 0
         AND ad_group_criterion.status = 'ENABLED'
         AND campaign.status = 'ENABLED'
       ORDER BY metrics.cost_micros DESC
       LIMIT 300`, log);

    const keywords: KeywordRow[] = kwRows.map((r: any) => ({
      criterionResourceName: String(r.ad_group_criterion?.resource_name ?? ""),
      text: String(r.ad_group_criterion?.keyword?.text ?? ""),
      matchType: matchType(r.ad_group_criterion?.keyword?.match_type),
      qualityScore: r.ad_group_criterion?.quality_info?.quality_score != null
        ? Number(r.ad_group_criterion.quality_info.quality_score) : null,
      campaignId: String(r.campaign?.id ?? ""),
      campaignName: String(r.campaign?.name ?? ""),
      adGroupName: r.ad_group?.name ? String(r.ad_group.name) : null,
      costMicros: Number(r.metrics?.cost_micros ?? 0),
      clicks: Number(r.metrics?.clicks ?? 0),
      conversions: Number(r.metrics?.conversions ?? 0),
      finalUrls: Array.isArray(r.ad_group_criterion?.final_urls) ? r.ad_group_criterion.final_urls.map(String) : [],
    }));

    // Scope to live ad groups in live campaigns. Filtering on ad_group_ad.status
    // alone still counts enabled ads sitting inside paused ad groups or paused
    // campaigns, which invents coverage gaps in parts of the account nobody runs.
    const adRows = await safeQuery(customer, "ads", `
      SELECT campaign.name, ad_group.id, ad_group.name,
             ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad_strength, ad_group_ad.status
        FROM ad_group_ad
       WHERE ad_group_ad.status = 'ENABLED'
         AND ad_group.status = 'ENABLED'
         AND campaign.status = 'ENABLED'`, log);

    const ads: AdGroupAdRow[] = adRows.map((r: any) => ({
      adGroupId: String(r.ad_group?.id ?? ""),
      adGroupName: String(r.ad_group?.name ?? ""),
      campaignName: String(r.campaign?.name ?? ""),
      adId: String(r.ad_group_ad?.ad?.id ?? ""),
      adType: r.ad_group_ad?.ad?.type != null ? String(r.ad_group_ad.ad.type) : null,
      adStrength: r.ad_group_ad?.ad_strength != null ? String(r.ad_group_ad.ad_strength) : null,
    }));

    // ── How much of each campaign's money the search-terms report shows ────
    // The SAME 30-day window the campaign figures above cover. That sameness
    // is the whole point: the 90-day term pull further up is capped at 500
    // rows and covers three months, so dividing it by a one-month campaign
    // cost is two numbers over two windows rather than a coverage share.
    // Zero-cost terms are excluded because they contribute nothing to the
    // numerator and are most of the rows on a large account.
    const coverageRows = await tryQuery(customer, "search term spend 30d", `
      SELECT campaign.id, metrics.cost_micros
        FROM search_term_view
       WHERE segments.date DURING LAST_30_DAYS AND metrics.cost_micros > 0`, log);
    // Null all the way through where the query failed. An empty map would say
    // "the report showed nothing", which on a working account is a finding,
    // and we would not have the evidence for it.
    let searchTermSpendByCampaign: Record<string, number> | null = null;
    if (coverageRows) {
      searchTermSpendByCampaign = {};
      for (const r of coverageRows) {
        const id = String((r as any).campaign?.id ?? "");
        if (!id) continue;
        searchTermSpendByCampaign[id] = (searchTermSpendByCampaign[id] ?? 0) + Number((r as any).metrics?.cost_micros ?? 0);
      }
    }

    // ── How long after the click this account's conversions arrive ─────────
    // The variable the OCH offline-conversion upload foundered on and which
    // nothing here has ever measured. Per campaign, because the readiness
    // reading is per campaign; folded and read in src/ads/bidding-readiness.ts.
    const lagRows = await tryQuery(customer, "conversion lag", `
      SELECT campaign.id, segments.conversion_lag_bucket, metrics.conversions
        FROM campaign
       WHERE segments.date BETWEEN '${ctx.windowStart}' AND '${ctx.windowEnd}'
         AND campaign.status = 'ENABLED'`, log);
    const conversionLag: ConversionLagRow[] | null = lagRows
      ? lagRows.map((r: any) => ({
          campaignId: String(r.campaign?.id ?? ""),
          bucket: enumName(CONVERSION_LAG_BUCKET, r.segments?.conversion_lag_bucket) ?? "UNKNOWN",
          conversions: Number(r.metrics?.conversions ?? 0),
        }))
      : null;

    // ── Day by day, so a silent column can be given a start and an end ─────
    // Without two dates there is nothing to tell the platform to ignore, and
    // the conversion reading below can only ever say the column is quiet now.
    const dailyRows = await tryQuery(customer, "daily conversions", `
      SELECT segments.date, metrics.clicks, metrics.conversions, metrics.cost_micros
        FROM customer
       WHERE segments.date BETWEEN '${ctx.windowStart}' AND '${ctx.windowEnd}'
       ORDER BY segments.date ASC`, log);
    const dailyConversions: DailyConversionRow[] | null = dailyRows
      ? dailyRows.map((r: any) => ({
          date: String(r.segments?.date ?? ""),
          clicks: Number(r.metrics?.clicks ?? 0),
          conversions: Number(r.metrics?.conversions ?? 0),
          costMicros: Number(r.metrics?.cost_micros ?? 0),
        })).filter((d: DailyConversionRow) => d.date.length === 10)
      : null;

    // ── Conversion tracking ────────────────────────────────────────────────
    // Read last and read carefully, because every rule above it judges a
    // campaign on "converted" or "converted nothing" and a failed read here
    // looks exactly like an account with no conversion actions. `tryQuery`
    // exists for that one distinction: it returns null when the query threw
    // and [] when the account genuinely has nothing.
    const tracking = await this.readTracking(customer, ctx);

    return {
      platform: "google_ads",
      accountId: ctx.accountId,
      windowStart: ctx.windowStart,
      windowEnd: ctx.windowEnd,
      campaigns,
      searchTerms: Array.from(termAcc.values()),
      keywords,
      ads,
      existingNegatives,
      protectedPatterns: ctx.protectedPatterns,
      tracking,
      conversionLag,
      dailyConversions,
      searchTermSpendByCampaign,
      existingKeywords,
      // The client's own economics are not the platform's to know. They are
      // read from Postgres by the caller (src/ads-findings-run.ts) and merged
      // onto the input, which keeps this adapter what it is: one vendor's API.
      economics: null,
    };
  }

  /**
   * What the account says about its own conversion tracking.
   *
   * Three reads, in falling order of how much they tell us, and each one is
   * allowed to fail without costing the others:
   *   1. the account-level tracking status — the one field that answers
   *      "is anything configured at all";
   *   2. the conversion actions WITH what each has recorded over the window;
   *   3. the same actions without metrics, where (2) is not available on this
   *      API version — in which case every count comes back null and the rules
   *      refuse to argue from a nought they did not read.
   */
  private async readTracking(customer: any, ctx: AdapterContext): Promise<TrackingFacts> {
    const log = this.onLog;

    const statusRows = await safeQuery(customer, "conversion tracking status", `
      SELECT customer.id, customer.conversion_tracking_setting.conversion_tracking_status
        FROM customer LIMIT 1`, log);
    const status = enumName(TRACKING_STATUS, statusRows[0]?.customer?.conversion_tracking_setting?.conversion_tracking_status);

    const map = (r: any, recorded: number | null): ConversionActionRow => ({
      id: String(r.conversion_action?.id ?? ""),
      name: String(r.conversion_action?.name ?? ""),
      status: enumName(CONVERSION_STATUS, r.conversion_action?.status),
      category: enumName(CONVERSION_CATEGORY, r.conversion_action?.category),
      actionType: enumName(CONVERSION_TYPE, r.conversion_action?.type),
      primaryForGoal: r.conversion_action?.primary_for_goal != null
        ? Boolean(r.conversion_action.primary_for_goal) : null,
      countsIntoConversionsColumn: r.conversion_action?.include_in_conversions_metric != null
        ? Boolean(r.conversion_action.include_in_conversions_metric) : null,
      conversionsInWindow: recorded,
      // What the account already says a conversion on this action is worth.
      // Read so the proxy-value reading can tell an account with no value from
      // one that already has a better figure than anything we could model.
      defaultValue: r.conversion_action?.value_settings?.default_value != null
        ? Number(r.conversion_action.value_settings.default_value) : null,
      alwaysUseDefaultValue: r.conversion_action?.value_settings?.always_use_default_value != null
        ? Boolean(r.conversion_action.value_settings.always_use_default_value) : null,
    });

    const withMetrics = await tryQuery(customer, "conversion actions (with metrics)", `
      SELECT conversion_action.id, conversion_action.name, conversion_action.status,
             conversion_action.category, conversion_action.type,
             conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric,
             conversion_action.value_settings.default_value,
             conversion_action.value_settings.always_use_default_value,
             metrics.all_conversions
        FROM conversion_action
       WHERE segments.date BETWEEN '${ctx.windowStart}' AND '${ctx.windowEnd}'`, log);

    if (withMetrics) {
      // The resource returns one row per action per segment on some versions,
      // so fold by action id rather than trusting one row each.
      const acc = new Map<string, ConversionActionRow>();
      for (const r of withMetrics) {
        const row = map(r, Number(r.metrics?.all_conversions ?? 0));
        const prev = acc.get(row.id);
        if (!prev) { acc.set(row.id, row); continue; }
        prev.conversionsInWindow = (prev.conversionsInWindow ?? 0) + (row.conversionsInWindow ?? 0);
      }
      return { status, actions: Array.from(acc.values()) };
    }

    const settingsOnly = await tryQuery(customer, "conversion actions (settings only)", `
      SELECT conversion_action.id, conversion_action.name, conversion_action.status,
             conversion_action.category, conversion_action.type,
             conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric,
             conversion_action.value_settings.default_value,
             conversion_action.value_settings.always_use_default_value
        FROM conversion_action`, log);

    // Null all the way through where nothing came back. An empty array here
    // would say "this account has no conversion actions", which is a finding,
    // and we do not have the evidence for it.
    return { status, actions: settingsOnly ? settingsOnly.map((r: any) => map(r, null)) : null };
  }

  // ── Validate / apply / rollback ────────────────────────────────────────────
  // All three go through the CLI's own guarded function. `validate` is
  // applyChangeSet with apply:false, which is exactly the dry run the CLI does —
  // every operation is sent to Google with validate_only and nothing is written.
  private accountForOps = "";
  /** Set before validate/apply/rollback — these verbs carry no account in their
   *  signature (the interface is deliberately narrow), so the caller binds one. */
  bindAccount(accountId: string) { this.accountForOps = accountId; }

  private changeSetFor(op: string, body: unknown, protectedPatterns: string[] = []): ChangeSet {
    const cs: ChangeSet = { client: "(bound)", protectedPatterns };
    // The op name comes from a finding's stored payload, which the rules engine
    // wrote from a fixed set — but cast through unknown rather than asserting a
    // ChangeSet has an index signature, so a typo lands as an ignored key
    // instead of a type error nobody reads.
    (cs as unknown as Record<string, unknown>)[op] = body;
    return cs;
  }

  async validate(op: string, body: unknown): Promise<ValidationResult> {
    if (!this.accountForOps) throw new Error("bindAccount() first.");
    const customer = await this.customer(this.accountForOps);
    try {
      const out = await applyChangeSet(customer, this.accountForOps, this.changeSetFor(op, body), { apply: false, onLog: this.onLog });
      return { ok: true, serverValidated: true, message: out.log.join("\n") };
    } catch (e: any) {
      const msg = e?.errors?.map((x: any) => x.message).join("; ") || (e instanceof Error ? e.message : String(e));
      return { ok: false, serverValidated: true, message: msg };
    }
  }

  async apply(op: string, body: unknown, protectedPatterns: string[] = []): Promise<ApplyResult> {
    if (!this.accountForOps) throw new Error("bindAccount() first.");
    const customer = await this.customer(this.accountForOps);
    try {
      const out = await applyChangeSet(
        customer, this.accountForOps, this.changeSetFor(op, body, protectedPatterns),
        { apply: true, onLog: this.onLog },
      );
      // No prior values means nothing was actually changed, or something was
      // changed we cannot reverse. Either way, do not report success — the
      // caller treats a null here as a hard failure and will not mark the
      // finding applied.
      const priorValues = out.priorValues.length ? out.priorValues : null;
      return {
        ok: priorValues != null,
        message: out.log.join("\n"),
        result: out.results,
        priorValues,
        rollbackPlan: out.rollback,
      };
    } catch (e: any) {
      const msg = e?.errors?.map((x: any) => x.message).join("; ") || (e instanceof Error ? e.message : String(e));
      return { ok: false, message: msg, result: null, priorValues: null, rollbackPlan: [] };
    }
  }

  async rollback(priorValues: unknown): Promise<ApplyResult> {
    if (!this.accountForOps) throw new Error("bindAccount() first.");
    const customer = await this.customer(this.accountForOps);
    const pv = (Array.isArray(priorValues) ? priorValues : []) as PriorValue[];
    try {
      const out = await rollbackChangeSet(customer, pv, { apply: true, onLog: this.onLog });
      return {
        ok: true,
        message: out.log.join("\n"),
        result: { restored: out.restored, manual: out.manual },
        priorValues: null,
        rollbackPlan: out.manual,
      };
    } catch (e: any) {
      const msg = e?.errors?.map((x: any) => x.message).join("; ") || (e instanceof Error ? e.message : String(e));
      return { ok: false, message: msg, result: null, priorValues: null, rollbackPlan: [] };
    }
  }

  // ── Verify ─────────────────────────────────────────────────────────────────
  /**
   * Re-read the metrics for the entity a change was made to, over an explicit
   * window. The 14/28-day after-check calls this twice — once for the window
   * before the change, once after — so a result is a comparison, not a snapshot.
   */
  async verify(entityType: string, entityId: string, windowStart: string, windowEnd: string): Promise<VerifyMetrics> {
    const accountId = this.accountForOps;
    if (!accountId) throw new Error("bindAccount() first.");
    const customer = await this.customer(accountId);
    const between = `segments.date BETWEEN '${windowStart}' AND '${windowEnd}'`;

    // A campaign-scoped finding measures that campaign. Anything account-scoped
    // (or an entity whose id is a synthetic key like "<campaign>:wasted_terms")
    // measures the account, because that is the level the change actually moved.
    const campaignId = entityType === "campaign" ? entityId.split(":")[0] : "";
    const gaql = campaignId
      ? `SELECT metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
           FROM campaign WHERE ${between} AND campaign.id = ${campaignId}`
      : `SELECT metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
           FROM customer WHERE ${between}`;

    const rows = await safeQuery(customer, `verify ${entityType}`, gaql, this.onLog);
    const metrics = rows.reduce(
      (acc, r: any) => ({
        costMicros: acc.costMicros + Number(r.metrics?.cost_micros ?? 0),
        clicks: acc.clicks + Number(r.metrics?.clicks ?? 0),
        impressions: acc.impressions + Number(r.metrics?.impressions ?? 0),
        conversions: acc.conversions + Number(r.metrics?.conversions ?? 0),
      }),
      { costMicros: 0, clicks: 0, impressions: 0, conversions: 0 },
    );
    return { metrics, windowStart, windowEnd };
  }
}

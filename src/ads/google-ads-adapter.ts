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
import type { AuditInput, CampaignRow, SearchTermRow, KeywordRow, AdGroupAdRow } from "./rules.js";

/** The API returns enums as integers over REST, not their string names, so a
 *  `=== "BROAD"` comparison silently never matches. Map both forms. */
const MATCH_TYPE: Record<string, string> = {
  "2": "EXACT", "3": "PHRASE", "4": "BROAD", EXACT: "EXACT", PHRASE: "PHRASE", BROAD: "BROAD",
};
const matchType = (v: unknown): string => MATCH_TYPE[String(v ?? "")] ?? String(v ?? "?");

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
      guardedOps: ["budgets", "campaignNegatives", "removeCampaignNegatives", "keywordFinalUrls", "removeAssets"],
      notes: [
        "Ad copy is out of scope by policy, not by API limitation — OCH runs under LegitScript.",
        "Performance Max exposes asset groups, budget and (limited) signals; it does not expose keyword-level control, so PMax findings are budget/asset shaped only.",
        "Bid strategy changes are within the API but have no guarded path here — they become vendor briefs.",
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
             campaign_budget.resource_name, campaign_budget.amount_micros,
             metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions,
             metrics.search_impression_share, metrics.search_budget_lost_impression_share,
             metrics.search_rank_lost_impression_share
        FROM campaign
       WHERE segments.date DURING LAST_30_DAYS AND campaign.status = 'ENABLED'`, log);

    const campaigns: CampaignRow[] = campaignRows.map((r: any) => ({
      id: String(r.campaign?.id ?? ""),
      name: String(r.campaign?.name ?? ""),
      channelType: r.campaign?.advertising_channel_type != null ? String(r.campaign.advertising_channel_type) : null,
      dailyBudgetMicros: Number(r.campaign_budget?.amount_micros ?? 0),
      budgetResourceName: r.campaign_budget?.resource_name ?? null,
      costMicros: Number(r.metrics?.cost_micros ?? 0),
      clicks: Number(r.metrics?.clicks ?? 0),
      impressions: Number(r.metrics?.impressions ?? 0),
      conversions: Number(r.metrics?.conversions ?? 0),
      impressionShare: r.metrics?.search_impression_share != null ? Number(r.metrics.search_impression_share) : null,
      budgetLostShare: r.metrics?.search_budget_lost_impression_share != null ? Number(r.metrics.search_budget_lost_impression_share) : null,
      rankLostShare: r.metrics?.search_rank_lost_impression_share != null ? Number(r.metrics.search_rank_lost_impression_share) : null,
    }));

    // Existing negatives, so we never propose a duplicate.
    const negRows = await safeQuery(customer, "negative keywords", `
      SELECT campaign.name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
        FROM campaign_criterion
       WHERE campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'`, log);
    const existingNegatives = new Set<string>(
      negRows.map((r: any) => String(r.campaign_criterion?.keyword?.text ?? "").toLowerCase()).filter(Boolean),
    );

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
    };
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

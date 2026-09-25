/**
 * Meta (Facebook / Instagram) adapter — same interface, same loop.
 *
 * DORMANT UNTIL CREDENTIALED, deliberately. Everything here is written against
 * the Marketing API's Graph endpoints, but with no META_ACCESS_TOKEN set it
 * reports `credentialed: false`, returns an empty read, and refuses every
 * mutation with a clear message instead of throwing something a cron will turn
 * into a red X. That mirrors how every other optional integration in this
 * worker behaves (Dialpad, Slack): present, inert, obvious.
 *
 * WHAT META CAN AND CANNOT CHANGE — the short version; the long one is in
 * docs/ADS_PLATFORM_CAPABILITIES.md:
 *  - Budgets (daily/lifetime, campaign or ad-set level) — yes, and this is the
 *    one operation we expose a guarded path for, because it is the only Meta
 *    change that is both high-value and cleanly reversible.
 *  - Status (pause/activate) at campaign, ad set and ad level — yes via the API,
 *    deliberately not exposed here for the same reason as Google: a pause and a
 *    broken-tracking false alarm look identical from the outside.
 *  - Targeting and audiences — the API can write them, but under Advantage+ the
 *    inputs are treated as suggestions to the delivery model rather than hard
 *    constraints, so "we changed the targeting" is not a claim we can verify.
 *    Vendor brief.
 *  - Creative — a Meta ad's creative is effectively immutable once created. A
 *    change means a NEW ad object and pausing the old one, which resets learning
 *    and re-enters review. Out of scope here exactly as on Google.
 *  - Special Ad Categories (housing, employment, credit, and social issues) strip
 *    age, gender and detailed targeting, and any account running under one has
 *    far less that is safe to automate. The adapter reads the flag so a finding
 *    can say so rather than proposing something the category forbids.
 *
 * Rate limits: the Marketing API is points-based per app per ad account over a
 * rolling window, and reads are cheap while writes are not. Every call here is a
 * read except the two mutation verbs, and the read path asks for one Insights
 * page per level rather than walking every object.
 */

import type {
  PlatformAdapter, PlatformCapabilities, AdapterContext, ValidationResult, ApplyResult, VerifyMetrics,
} from "./platform.js";
import type { AuditInput, AdSetRow, CampaignRow } from "./rules.js";
// The counting rule, the click rule and the money rule live in ONE place, and
// this adapter is one of its two readers -- the other is the metric importer
// (src/import-meta.ts). Two copies of "what is a conversion on Meta" is how a
// finding and a dashboard figure start disagreeing about the same account.
// countMetaConversions is re-exported below because src/verify-ads-findings.ts
// has always imported it from here.
import {
  META_GRAPH, countMetaConversions, metaLinkClicks, metaSpendToMicros,
} from "../meta/insights.js";

export { countMetaConversions };

const GRAPH = META_GRAPH;

/** Meta reports money in the account's currency as a decimal string, not
 *  micros. Absent reads as nought HERE only because the rules engine's row
 *  types carry a plain number; the importer keeps the null. */
const toMicros = (v: unknown) => metaSpendToMicros(v) ?? 0;

export interface MetaConfig {
  /** System-user access token with ads_read (+ ads_management to mutate). */
  accessToken: string | null;
}

export function loadMetaConfig(): MetaConfig {
  const t = process.env.META_ACCESS_TOKEN?.trim();
  return { accessToken: t && t.length ? t : null };
}

export class MetaAdapter implements PlatformAdapter {
  readonly platform = "meta" as const;
  private accountForOps = "";

  constructor(
    private readonly cfg: MetaConfig,
    private readonly onLog: (s: string) => void = console.log,
  ) {}

  bindAccount(accountId: string) { this.accountForOps = accountId; }

  capabilities(): PlatformCapabilities {
    return {
      platform: "meta",
      label: "Meta",
      credentialed: Boolean(this.cfg.accessToken),
      canChange: {
        budgets: true,
        bidStrategy: true,
        keywords: false,            // Meta has no keywords at all
        negativeKeywords: false,    // …so no negatives either
        audiences: true,
        targeting: true,
        statusChanges: true,
        creativeEdit: false,        // creatives are immutable; a change is a new ad
        creativeCreate: true,
        finalUrls: false,           // the destination lives on the creative
        assetDetach: false,
      },
      guardedOps: this.cfg.accessToken ? ["budgets"] : [],
      notes: [
        this.cfg.accessToken
          ? "Credentialed. Only budget changes have a guarded path."
          : "DORMANT — no META_ACCESS_TOKEN. Reads return empty and every mutation is refused.",
        "No keywords or negatives exist on Meta, so the search-term and keyword findings never apply here. Meta findings are budget, delivery and creative shaped.",
        "Advantage+ treats audience inputs as signals to the delivery model, not constraints — a targeting change cannot be verified the way a Google negative can, so targeting is always a vendor brief.",
        "Special Ad Category accounts lose age, gender and detailed targeting. The flag is carried onto the campaign row so a finding says which advice is not available rather than naming a control that is not there.",
        "Meta reports its own learning verdict per ad set (learning_stage_info), and often the threshold it is measuring against. That is read and used as-is: the engine reports the platform's verdict rather than forming one from a support-page number.",
        "There is no fbclid column anywhere in this system, so the click-to-customer chain that Google accounts are read on does not exist here and no reading of it is attempted.",
        "Meta has no equivalent of Google's bidding data exclusions. When tracking breaks there is no way to tell the delivery model to ignore those days, so the only remedy is behavioural — leave the account alone and let the events return.",
      ],
    };
  }

  private async graph(path: string, params: Record<string, string> = {}): Promise<any> {
    if (!this.cfg.accessToken) throw new Error("Meta is not credentialed (META_ACCESS_TOKEN unset).");
    const qs = new URLSearchParams({ ...params, access_token: this.cfg.accessToken });
    const resp = await fetch(`${GRAPH}/${path}?${qs}`);
    const body = (await resp.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!resp.ok) {
      const msg = body?.error?.message ?? `HTTP ${resp.status}`;
      throw new Error(`Meta API: ${msg}`);
    }
    return body;
  }

  /**
   * Read the account's campaigns and their insights for the window.
   *
   * Meta has no search terms, keywords or ad-strength analogue, so those arrive
   * empty and the rules engine simply produces no findings of those types. That
   * is the adapter pattern doing its job: the rules do not need to know which
   * platform they are looking at, they just find nothing where there is nothing.
   */
  async read(ctx: AdapterContext): Promise<AuditInput> {
    const empty: AuditInput = {
      platform: "meta", accountId: ctx.accountId,
      windowStart: ctx.windowStart, windowEnd: ctx.windowEnd,
      campaigns: [], adSets: [], searchTerms: [], keywords: [], ads: [],
      existingNegatives: new Set(), protectedPatterns: ctx.protectedPatterns,
    };
    if (!this.cfg.accessToken) {
      this.onLog(`    · Meta dormant (no META_ACCESS_TOKEN) — skipping ${ctx.accountId}`);
      return empty;
    }

    const act = ctx.accountId.startsWith("act_") ? ctx.accountId : `act_${ctx.accountId}`;
    const timeRange = JSON.stringify({ since: ctx.windowStart, until: ctx.windowEnd });

    let insights: any[] = [];
    try {
      const resp = await this.graph(`${act}/insights`, {
        level: "campaign",
        time_range: timeRange,
        // `inline_link_clicks`, not `clicks`. Meta's `clicks` is Clicks (All) —
        // it counts reactions, comments, shares, profile-photo clicks and media
        // expansions alongside link clicks. Every click-based judgement in the
        // rules engine (cost per click, the 100-click floor before "zero
        // conversions" means anything, conversions per click) reads a link
        // click, so handing it Clicks (All) inflates the denominator and makes
        // a working account look like it converts nothing.
        // `attribution_setting` is carried so a person can see which window the
        // numbers were counted under; `objective_results` is the platform's own
        // count of what the ad set optimises for. See countMetaConversions.
        fields: "campaign_id,campaign_name,spend,clicks,inline_link_clicks,impressions,actions,objective,objective_results,attribution_setting",
        limit: "200",
      });
      insights = Array.isArray(resp?.data) ? resp.data : [];
    } catch (e) {
      this.onLog(`    ⚠ Meta insights failed for ${act}: ${e instanceof Error ? e.message : e}`);
      return empty;
    }

    // Budgets live on the campaign object, not on insights, so they are a
    // second call. Failing this one degrades the finding rather than the run:
    // without a budget we cannot propose a budget change, and the rules will
    // mark the finding vendor-applicable instead.
    const budgets = new Map<string, number>();
    // `special_ad_categories` was ALREADY being requested here and thrown away,
    // while docs/ADS_PLATFORM_CAPABILITIES.md claimed the adapter read it "so a
    // finding can say so". It is kept now, on the campaign row, because it
    // changes what advice is honest: a campaign under one of these has age,
    // gender and detailed targeting stripped, so a finding that says "widen the
    // audience" is telling somebody to use a control that is not there.
    // NULL for a campaign the budget read never reached — absent is "not read",
    // never "there are none".
    const categories = new Map<string, string[]>();
    let readCampaignObjects = false;
    try {
      const resp = await this.graph(`${act}/campaigns`, {
        fields: "id,name,daily_budget,lifetime_budget,status,special_ad_categories",
        limit: "200",
      });
      readCampaignObjects = true;
      for (const c of resp?.data ?? []) {
        // Meta returns budgets in the account currency's minor unit (cents).
        const daily = Number(c.daily_budget ?? 0);
        if (daily > 0) budgets.set(String(c.id), daily * 10_000); // cents → micros
        const cats = Array.isArray(c.special_ad_categories)
          ? c.special_ad_categories.map((x: unknown) => String(x)).filter((x: string) => x && x !== "NONE")
          : [];
        categories.set(String(c.id), cats);
      }
    } catch (e) {
      this.onLog(`    ⚠ Meta campaign budgets failed for ${act}: ${e instanceof Error ? e.message : e}`);
    }

    // Ad sets, and the platform's own verdict on whether its delivery model can
    // settle on each one. This is the read the Google side has no analogue for:
    // `learning_stage_info` carries Meta's own status, the events it counted and
    // — where it reports one — the threshold it is measuring against, so the
    // rules read a verdict instead of forming one from a support-page number.
    // A failure here degrades the run rather than ending it: no ad sets means
    // no learning findings, which is the same silence an adapter that does not
    // read them produces.
    const adSets: AdSetRow[] = [];
    try {
      const resp = await this.graph(`${act}/adsets`, {
        fields: "id,name,campaign_id,optimization_goal,effective_status,learning_stage_info",
        limit: "200",
      });
      const spendByAdSet = new Map<string, { cost: number; campaignName: string | null }>();
      try {
        const ins = await this.graph(`${act}/insights`, {
          level: "adset",
          time_range: timeRange,
          fields: "adset_id,campaign_name,spend",
          limit: "500",
        });
        for (const r of ins?.data ?? []) {
          spendByAdSet.set(String(r.adset_id ?? ""), {
            cost: toMicros(r.spend),
            campaignName: r.campaign_name ? String(r.campaign_name) : null,
          });
        }
      } catch (e) {
        this.onLog(`    ⚠ Meta ad-set insights failed for ${act}: ${e instanceof Error ? e.message : e}`);
      }
      for (const a of resp?.data ?? []) {
        const id = String(a.id ?? "");
        if (!id) continue;
        const li = a.learning_stage_info ?? null;
        const spend = spendByAdSet.get(id);
        const events = li && li.conversions != null ? Number(li.conversions) : null;
        const threshold = li && li.dynamic_lp_conversions_threshold != null
          ? Number(li.dynamic_lp_conversions_threshold) : null;
        adSets.push({
          id,
          name: String(a.name ?? ""),
          campaignId: a.campaign_id ? String(a.campaign_id) : null,
          campaignName: spend?.campaignName ?? null,
          optimizationGoal: a.optimization_goal ? String(a.optimization_goal) : null,
          learningStatus: li?.status ? String(li.status) : null,
          // NULL IS NOT READ. A missing count arriving as a nought would report
          // every settled ad set as starved of events.
          learningEvents: Number.isFinite(events as number) ? events : null,
          learningThreshold: Number.isFinite(threshold as number) && (threshold as number) > 0 ? threshold : null,
          costMicros: spend?.cost ?? 0,
          effectiveStatus: a.effective_status ? String(a.effective_status) : null,
        });
      }
    } catch (e) {
      this.onLog(`    ⚠ Meta ad sets failed for ${act}: ${e instanceof Error ? e.message : e}`);
    }

    let inflatedClickRows = 0;
    const campaigns: CampaignRow[] = insights.map((r: any) => {
      const id = String(r.campaign_id ?? "");
      // ONE conversion counted once. See countMetaConversions: Meta reports the
      // same lead under two or three action types and the old regex summed
      // every one of them.
      const { conversions } = countMetaConversions(r);
      // Link clicks, falling back to Clicks (All) only where the link metric is
      // missing — and counted, so the log can say the fallback was taken rather
      // than quietly handing the rules engine a different metric. The rule
      // itself is shared with the importer; see meta/insights.ts trap 3.
      const link = metaLinkClicks(r);
      if (link.usedAllClicks && (link.clicks ?? 0) > 0) inflatedClickRows++;
      return {
        id,
        name: String(r.campaign_name ?? ""),
        channelType: r.objective ? String(r.objective) : null,
        dailyBudgetMicros: budgets.get(id) ?? 0,
        budgetResourceName: null,     // Meta budgets are edited by campaign id
        costMicros: toMicros(r.spend),
        clicks: link.clicks ?? 0,
        impressions: Number(r.impressions ?? 0),
        conversions,
        // Meta has no impression-share metrics. Null, not zero — a zero would
        // read as "we lose none of it", which is a claim, not an absence.
        impressionShare: null,
        budgetLostShare: null,
        rankLostShare: null,
        // [] is "we read it and there are none"; undefined is "the campaign
        // object read never reached this campaign", and the rules keep the two
        // apart. Not conflated: one of them is a fact about the account.
        specialAdCategories: readCampaignObjects ? (categories.get(id) ?? []) : undefined,
      };
    });

    if (inflatedClickRows > 0) {
      this.onLog(`    ⚠ Meta: ${inflatedClickRows} campaign row(s) reported no inline_link_clicks, so Clicks (All) was used — that figure counts reactions and comments as clicks`);
    }
    const attribution = insights.find((r: any) => r.attribution_setting)?.attribution_setting;
    this.onLog(
      `    · Meta read ${campaigns.length} campaign(s) and ${adSets.length} ad set(s)`
      + `${attribution ? ` · attribution ${attribution}` : ""}`,
    );

    return { ...empty, campaigns, adSets };
  }

  async validate(op: string, body: unknown): Promise<ValidationResult> {
    if (!this.cfg.accessToken) {
      return { ok: false, serverValidated: false, message: "Meta is dormant — no META_ACCESS_TOKEN on the worker." };
    }
    if (op !== "budgets") {
      return { ok: false, serverValidated: false, message: `Meta adapter has no guarded path for "${op}". It belongs in a vendor brief.` };
    }
    // Meta has no validate_only. Say so rather than implying a server dry run
    // happened: the honest answer is that we checked the shape ourselves and
    // the platform has not seen it.
    const items = Array.isArray(body) ? body : [];
    for (const it of items as { campaignId?: string; newDailyUsd?: number; fromDailyMinor?: number }[]) {
      if (!it.campaignId) return { ok: false, serverValidated: false, message: "Each budget change needs a campaignId." };
      if (!(Number(it.newDailyUsd) > 0)) return { ok: false, serverValidated: false, message: "newDailyUsd must be positive." };
      // The staleness guard's input, checked here as well as at apply, so a
      // change set with no recorded starting budget is refused before anybody
      // presses Approve rather than after.
      if (it.fromDailyMinor == null) {
        return {
          ok: false, serverValidated: false,
          message: `Budget change on ${it.campaignId} carries no recorded starting budget, so nothing can tell a current proposal from a stale one. Re-run the findings audit so it is worked out from today's number.`,
        };
      }
    }
    return {
      ok: true, serverValidated: false,
      message: `${items.length} budget change(s) look well-formed. Meta has no validate_only endpoint, so this is a local check only — the platform has not seen the payload.`,
    };
  }

  async apply(op: string, body: unknown): Promise<ApplyResult> {
    if (!this.cfg.accessToken) {
      return { ok: false, message: "Meta is dormant — no META_ACCESS_TOKEN on the worker.", result: null, priorValues: null, rollbackPlan: [] };
    }
    if (op !== "budgets") {
      return { ok: false, message: `Meta adapter has no guarded path for "${op}".`, result: null, priorValues: null, rollbackPlan: [] };
    }
    const items = (Array.isArray(body) ? body : []) as { campaignId: string; newDailyUsd: number; fromDailyMinor?: number; reason?: string }[];
    const priorValues: { campaignId: string; dailyBudgetMinor: number }[] = [];
    const rollbackPlan: string[] = [];
    const results: unknown[] = [];

    for (const it of items) {
      // Read the current value FIRST. No prior value, no change — the same rule
      // the Google path enforces.
      const cur = await this.graph(it.campaignId, { fields: "id,name,daily_budget" });
      const priorMinor = Number(cur?.daily_budget ?? 0);
      if (!(priorMinor > 0)) {
        return {
          ok: false,
          message: `Campaign ${it.campaignId} has no daily budget to change (it may use a lifetime or ad-set budget). Refusing rather than guessing.`,
          result: null, priorValues: null, rollbackPlan: [],
        };
      }
      // ── The staleness guard, mirroring the Google apply path ────────────
      // `newDailyUsd` is a frozen dollar figure rather than a delta, so without
      // the budget it was worked out FROM there is nothing that can tell a
      // current +25% step from a week-old one somebody has since overtaken.
      // Enforced here rather than inherited from a shared helper, because this
      // is a different API and a shared helper would hide that.
      //
      // ABSENT IS REFUSED, not waved through — the same rule the Google path
      // lives by. A proposal with no recorded starting point cannot prove it is
      // current, and re-running the audit rewrites the payload in place.
      if (it.fromDailyMinor == null) {
        return {
          ok: false,
          message: `Campaign ${it.campaignId} carries no recorded starting budget, so this proposal cannot be shown to be current. Re-run the findings audit and approve the fresh one.`,
          result: null, priorValues: null, rollbackPlan: [],
        };
      }
      // A cent of tolerance, because the platform normalises what it stores.
      if (Math.abs(priorMinor - it.fromDailyMinor) > 1) {
        return {
          ok: false,
          message: `Campaign ${it.campaignId} was ${it.fromDailyMinor / 100}/day when this was worked out and is ${priorMinor / 100}/day now. Somebody has moved it since, and applying ${it.newDailyUsd} would overwrite their change with a stale figure. Refusing.`,
          result: null, priorValues: null, rollbackPlan: [],
        };
      }
      const nextMinor = Math.round(it.newDailyUsd * 100);
      // Same guard rails as the Google path, enforced here rather than inherited,
      // because this is a different API and a shared helper would hide that.
      if (nextMinor > priorMinor * 2) {
        return { ok: false, message: `Guard: ${priorMinor / 100} → ${nextMinor / 100} on ${it.campaignId} exceeds 2×.`, result: null, priorValues: null, rollbackPlan: [] };
      }
      if ((nextMinor - priorMinor) / 100 > 100) {
        return { ok: false, message: `Guard: ${priorMinor / 100} → ${nextMinor / 100} on ${it.campaignId} exceeds $100/day.`, result: null, priorValues: null, rollbackPlan: [] };
      }

      const qs = new URLSearchParams({ daily_budget: String(nextMinor), access_token: this.cfg.accessToken! });
      const resp = await fetch(`${GRAPH}/${it.campaignId}`, { method: "POST", body: qs });
      const out = (await resp.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!resp.ok) {
        return { ok: false, message: `Meta API: ${out?.error?.message ?? resp.status}`, result: out, priorValues: null, rollbackPlan: [] };
      }
      priorValues.push({ campaignId: it.campaignId, dailyBudgetMinor: priorMinor });
      rollbackPlan.push(`Meta campaign ${it.campaignId} ("${cur?.name ?? "?"}"): set daily_budget back to ${priorMinor} (minor units).`);
      results.push(out);
      this.onLog(`  ✅ Meta budget: ${it.campaignId} ${priorMinor / 100} → ${nextMinor / 100}/day — APPLIED`);
    }

    return { ok: priorValues.length > 0, message: `${priorValues.length} Meta budget change(s) applied.`, result: results, priorValues: priorValues.length ? priorValues : null, rollbackPlan };
  }

  async rollback(priorValues: unknown): Promise<ApplyResult> {
    if (!this.cfg.accessToken) {
      return { ok: false, message: "Meta is dormant — no META_ACCESS_TOKEN on the worker.", result: null, priorValues: null, rollbackPlan: [] };
    }
    const pv = (Array.isArray(priorValues) ? priorValues : []) as { campaignId: string; dailyBudgetMinor: number }[];
    const restored: string[] = [];
    for (const p of pv) {
      const qs = new URLSearchParams({ daily_budget: String(p.dailyBudgetMinor), access_token: this.cfg.accessToken });
      const resp = await fetch(`${GRAPH}/${p.campaignId}`, { method: "POST", body: qs });
      if (!resp.ok) {
        const out = (await resp.json().catch(() => ({}))) as { error?: { message?: string } };
        return { ok: false, message: `Meta API: ${out?.error?.message ?? resp.status}`, result: null, priorValues: null, rollbackPlan: [] };
      }
      restored.push(`${p.campaignId} → ${p.dailyBudgetMinor} minor units/day`);
    }
    return { ok: true, message: `Restored ${restored.length} Meta budget(s).`, result: { restored }, priorValues: null, rollbackPlan: [] };
  }

  async verify(_entityType: string, entityId: string, windowStart: string, windowEnd: string): Promise<VerifyMetrics> {
    const zero = { metrics: { costMicros: 0, clicks: 0, impressions: 0, conversions: 0 }, windowStart, windowEnd };
    if (!this.cfg.accessToken) return zero;
    try {
      const resp = await this.graph(`${entityId}/insights`, {
        time_range: JSON.stringify({ since: windowStart, until: windowEnd }),
        fields: "spend,clicks,inline_link_clicks,impressions,actions,objective_results",
      });
      const r = resp?.data?.[0];
      if (!r) return zero;
      // The SAME counting the read uses. A before/after check that counts
      // conversions differently from the read that raised the finding compares
      // two different numbers and calls the difference an effect.
      const { conversions } = countMetaConversions(r);
      return {
        metrics: {
          costMicros: toMicros(r.spend),
          clicks: metaLinkClicks(r).clicks ?? 0,
          impressions: Number(r.impressions ?? 0),
          conversions,
        },
        windowStart, windowEnd,
      };
    } catch (e) {
      this.onLog(`    ⚠ Meta verify failed for ${entityId}: ${e instanceof Error ? e.message : e}`);
      return zero;
    }
  }
}

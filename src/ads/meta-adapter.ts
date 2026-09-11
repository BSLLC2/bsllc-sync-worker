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
import type { AuditInput, CampaignRow } from "./rules.js";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Meta reports money in the account's currency as a decimal string, not micros. */
const toMicros = (v: unknown) => Math.round(Number(v ?? 0) * 1_000_000);

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
        "Special Ad Category accounts lose age, gender and detailed targeting. The adapter reads the flag so findings do not propose something the category forbids.",
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
      campaigns: [], searchTerms: [], keywords: [], ads: [],
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
        fields: "campaign_id,campaign_name,spend,clicks,impressions,actions,objective",
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
    try {
      const resp = await this.graph(`${act}/campaigns`, {
        fields: "id,name,daily_budget,lifetime_budget,status,special_ad_categories",
        limit: "200",
      });
      for (const c of resp?.data ?? []) {
        // Meta returns budgets in the account currency's minor unit (cents).
        const daily = Number(c.daily_budget ?? 0);
        if (daily > 0) budgets.set(String(c.id), daily * 10_000); // cents → micros
      }
    } catch (e) {
      this.onLog(`    ⚠ Meta campaign budgets failed for ${act}: ${e instanceof Error ? e.message : e}`);
    }

    const campaigns: CampaignRow[] = insights.map((r: any) => {
      // Meta reports conversions as a list of typed action counts, not one
      // number. Summing every action type would count link clicks and video
      // views as conversions, so only the offsite/onsite conversion families
      // are taken.
      const actions: { action_type?: string; value?: string }[] = Array.isArray(r.actions) ? r.actions : [];
      const conversions = actions
        .filter((a) => /^(offsite_conversion|onsite_conversion|lead|purchase|complete_registration|submit_application)/.test(String(a.action_type ?? "")))
        .reduce((s, a) => s + Number(a.value ?? 0), 0);
      return {
        id: String(r.campaign_id ?? ""),
        name: String(r.campaign_name ?? ""),
        channelType: r.objective ? String(r.objective) : null,
        dailyBudgetMicros: budgets.get(String(r.campaign_id ?? "")) ?? 0,
        budgetResourceName: null,     // Meta budgets are edited by campaign id
        costMicros: toMicros(r.spend),
        clicks: Number(r.clicks ?? 0),
        impressions: Number(r.impressions ?? 0),
        conversions,
        // Meta has no impression-share metrics. Null, not zero — a zero would
        // read as "we lose none of it", which is a claim, not an absence.
        impressionShare: null,
        budgetLostShare: null,
        rankLostShare: null,
      };
    });

    return { ...empty, campaigns };
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
    for (const it of items as { campaignId?: string; newDailyUsd?: number }[]) {
      if (!it.campaignId) return { ok: false, serverValidated: false, message: "Each budget change needs a campaignId." };
      if (!(Number(it.newDailyUsd) > 0)) return { ok: false, serverValidated: false, message: "newDailyUsd must be positive." };
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
    const items = (Array.isArray(body) ? body : []) as { campaignId: string; newDailyUsd: number; reason?: string }[];
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
        fields: "spend,clicks,impressions,actions",
      });
      const r = resp?.data?.[0];
      if (!r) return zero;
      const actions: { action_type?: string; value?: string }[] = Array.isArray(r.actions) ? r.actions : [];
      return {
        metrics: {
          costMicros: toMicros(r.spend),
          clicks: Number(r.clicks ?? 0),
          impressions: Number(r.impressions ?? 0),
          conversions: actions
            .filter((a) => /^(offsite_conversion|onsite_conversion|lead|purchase)/.test(String(a.action_type ?? "")))
            .reduce((s, a) => s + Number(a.value ?? 0), 0),
        },
        windowStart, windowEnd,
      };
    } catch (e) {
      this.onLog(`    ⚠ Meta verify failed for ${entityId}: ${e instanceof Error ? e.message : e}`);
      return zero;
    }
  }
}

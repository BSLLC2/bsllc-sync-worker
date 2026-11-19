/**
 * Meta ads in depth: what each ad did each day, where it was shown and to whom,
 * and what each campaign, ad set and ad IS, as the platform reported them.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The Meta importer (src/import-meta.ts) writes ACCOUNT monthly totals and the
 * findings adapter (src/ads/meta-adapter.ts) reads CAMPAIGNS over 90 days. Nothing
 * held an ad, an ad set or a placement by day, so Google's depth (daily campaign
 * figures, a structure snapshot, keyword and search-term days) had no Meta twin and
 * every judgement about creative, audience or placement was a judgement about a
 * total. This is the store for that. The rules over it are in src/meta/rules.ts.
 *
 * ── THE RULES THIS FILE FOLLOWS (they are the Google store's, one platform along) ──
 *
 *  · READ-ONLY. Every request is a GET (src/meta/graph.ts). Nothing is written to Meta.
 *  · ONE CONVERSION IS COUNTED ONCE and a lead is not a click: `countMetaConversions`,
 *    `sumMetaActionValues`, `metaSpendToMicros` from src/meta/insights.ts are the
 *    only way a figure leaves a Graph row. Spend is a decimal string in the ACCOUNT'S
 *    currency, converted to micros here, once.
 *  · LINK CLICKS ARE LINK CLICKS. `inline_link_clicks` is requested and `clicks`
 *    (Clicks (All): reactions, comments, shares) is NOT. A row with no link-click
 *    figure stores null; there is no fallback to the wider metric here.
 *  · A NULL IS UNANSWERED. Conversions and their value are null unless the account
 *    reported one somewhere in the read window (`evidencedMetric`), reach and
 *    frequency are null where Meta returned none, and a stored 0 is a real nought.
 *  · A READ AT THE ROW CEILING, OR ONE WITH A ROW WE COULD NOT PLACE, WRITES NOTHING
 *    FOR THAT PART. A partial list read as complete turns every missing ad into an
 *    ad that did not spend. A failure writes `ok = false` and keeps the earlier span.
 *  · NO PERSON. Age and gender are COUNT BREAKDOWNS of delivery (a bucket and its
 *    spend), never a person. Targeting is stored as COUNTS (how many interests,
 *    custom audiences, countries), never their names.
 *
 * Pure except where a function takes a database client (src/meta/depth-store.ts).
 */
import { createHash } from "node:crypto";
import { evidencedMetric } from "../metric-evidence.js";
import { countMetaConversions, metaEvidenceWindow, metaSpendToMicros, sumMetaActionValues } from "./insights.js";
import { addDays } from "../ads/daily-metrics.js";

export const PLATFORM = "meta";
export const FIRST_RUN_DAYS = 60;
export const RESTATE_DAYS = 14;
export const MAX_DAYS = 90;
export const SLICE_DAYS = 14;
export const RETAIN_DAYS = 120;
export const MAX_AD_DAY_ROWS = 50_000;
export const MAX_SEGMENT_ROWS = 50_000;
export const MAX_ENTITIES_PER_TYPE = 20_000;
export const PARTS = ["ad_days", "segments", "entities"] as const;
export type Part = (typeof PARTS)[number];
export const SEGMENT_KINDS = ["placement", "age", "gender"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];
export const ENTITY_TYPES = ["campaign", "adset", "ad"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const NO_ACCOUNTS_NOTE = "no Meta ad account is mapped, so no ad was captured for any client";

// ── What is asked of Meta. EVERY NAME BELOW IS UNVERIFIED LIVE: see docs/META-DEPTH-UNVERIFIED.md ──
/** `ctr` is deliberately not requested: Meta's own ctr is over Clicks (All), the wrong click. It is derived from the two figures stored beside it. */
export const AD_DAY_FIELDS =
  "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,frequency,inline_link_clicks,actions,action_values";
export const SEGMENT_FIELDS = "campaign_id,adset_id,spend,impressions,inline_link_clicks,actions";
export const SEGMENT_BREAKDOWNS: Record<SegmentKind, string> = {
  placement: "publisher_platform,platform_position",
  age: "age",
  gender: "gender",
};
export const CAMPAIGN_FIELDS = "id,name,status,effective_status,daily_budget,lifetime_budget,bid_strategy,objective,buying_type";
export const ADSET_FIELDS =
  "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,bid_strategy,billing_event,learning_stage_info,targeting";
export const AD_FIELDS = "id,name,adset_id,campaign_id,status,effective_status,creative{id}";

// ── Windows ─────────────────────────────────────────────────────────────────
/** The window to read: the `n` days ending YESTERDAY (UTC). `firstRun` reads 60, a refresh 14. */
export function metaDaysWindow(today: string, firstRun: boolean, days?: number): { start: string; end: string } {
  const n = Math.max(1, Math.min(days ?? (firstRun ? FIRST_RUN_DAYS : RESTATE_DAYS), MAX_DAYS));
  const end = addDays(today, -1);
  return { start: addDays(end, -(n - 1)), end };
}

/** The window cut into slices of at most `SLICE_DAYS`, oldest first. Daily rows at ad level are large; one slice is one request chain. */
export function sliceWindow(w: { start: string; end: string }, size = SLICE_DAYS): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  let s = w.start;
  while (s <= w.end) {
    const e = addDays(s, size - 1);
    out.push({ start: s, end: e > w.end ? w.end : e });
    s = addDays(e, 1);
  }
  return out;
}

// ── Small readers ───────────────────────────────────────────────────────────
const digits = (v: unknown): string | null => { const s = String(v ?? "").trim(); return /^\d+$/.test(s) ? s : null; };
const isDay = (v: unknown): string | null => { const s = String(v ?? "").trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const clip = (v: unknown, n: number): string | null => { const s = String(v ?? "").trim(); return s ? s.slice(0, n) : null; };
/** A finite number or null. An unreadable string is an absence, never a nought. */
export function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
const wholeOrNull = (v: unknown): number | null => { const n = numOrNull(v); return n == null ? null : Math.max(0, Math.round(n)); };

// ── Ad days ─────────────────────────────────────────────────────────────────
export interface AdDayRow {
  campaignId: string; adsetId: string; adId: string;
  campaignName: string | null; adsetName: string | null; adName: string | null;
  day: string;
  spendMicros: number;
  impressions: number;
  /** Reach THAT DAY. Not additive across days or ads. Null = Meta returned none. */
  reach: number | null;
  /** Impressions per person THAT DAY (Meta's own figure). Null = none returned. */
  frequency: number | null;
  /** Link clicks only. Null = Meta returned no link-click figure; never Clicks (All). */
  linkClicks: number | null;
  /** Null = the account reported no conversion anywhere in this read's window. */
  conversions: number | null;
  conversionValue: number | null;
}

export interface BuildResult<T> {
  rows: T[];
  /** Rows Meta returned that could not be placed (no id, no date, no readable spend). ANY of these means the read is not complete. */
  unplaceable: number;
}

/**
 * Raw `level=ad, time_increment=1` rows into stored rows.
 *
 * `unplaceable` counts a row with no ad id, no day, a day range instead of one day,
 * or no readable spend. Spend is the one figure a delivered ad always has, and a row
 * without it is a row this store would have to guess at, so the CALLER refuses to
 * write a part that has any.
 */
export function buildAdDayRows(raw: readonly Record<string, unknown>[]): BuildResult<AdDayRow> {
  const win = metaEvidenceWindow(raw);
  const key = (r: AdDayRow) => `${r.adId}|${r.day}`;
  const by = new Map<string, AdDayRow & { _dupe: boolean }>();
  let unplaceable = 0;
  raw.forEach((r) => {
    const adId = digits(r.ad_id), adsetId = digits(r.adset_id), campaignId = digits(r.campaign_id);
    const day = isDay(r.date_start);
    const stop = isDay(r.date_stop);
    const spend = metaSpendToMicros(r.spend);
    if (!adId || !adsetId || !campaignId || !day || (stop && stop !== day) || spend == null) { unplaceable++; return; }
    const conv = countMetaConversions(r);
    const val = sumMetaActionValues(r);
    const row: AdDayRow & { _dupe: boolean } = {
      campaignId, adsetId, adId,
      campaignName: clip(r.campaign_name, 200), adsetName: clip(r.adset_name, 200), adName: clip(r.ad_name, 200),
      day, spendMicros: Math.max(0, spend),
      impressions: wholeOrNull(r.impressions) ?? 0,
      reach: wholeOrNull(r.reach), frequency: numOrNull(r.frequency),
      linkClicks: wholeOrNull(r.inline_link_clicks),
      // Evidence: has the account reported this metric ANYWHERE in the window? Null if not; a nought otherwise.
      conversions: evidencedMetric(conv.basis === "none" ? 0 : conv.conversions, [...win.conversions]),
      conversionValue: evidencedMetric(val.basis === "none" ? 0 : val.value, [...win.values]),
      _dupe: false,
    };
    const have = by.get(key(row));
    if (!have) { by.set(key(row), row); return; }
    // A repeated ad-day (an unexpected extra segmentation): the additive figures are summed, reach and frequency are NOT additive and become null.
    have.spendMicros += row.spendMicros; have.impressions += row.impressions;
    have.linkClicks = have.linkClicks == null || row.linkClicks == null ? null : have.linkClicks + row.linkClicks;
    have.conversions = have.conversions == null || row.conversions == null ? null : have.conversions + row.conversions;
    have.conversionValue = have.conversionValue == null || row.conversionValue == null ? null : have.conversionValue + row.conversionValue;
    have.reach = null; have.frequency = null; have._dupe = true;
  });
  const rows = Array.from(by.values()).map(({ _dupe, ...r }) => { void _dupe; return r; })
    .sort((a, b) => a.day.localeCompare(b.day) || a.adId.localeCompare(b.adId));
  return { rows, unplaceable };
}

// ── Segment days ────────────────────────────────────────────────────────────
export interface SegmentDayRow {
  campaignId: string; adsetId: string; day: string;
  kind: SegmentKind; segment: string;
  spendMicros: number; impressions: number; linkClicks: number | null; conversions: number | null;
}

const SEG_MAX = 80;
/** The label for one segment, or null when the row does not carry the breakdown it was asked for. */
export function segmentLabel(kind: SegmentKind, r: Record<string, unknown>): string | null {
  if (kind === "placement") {
    const pp = clip(r.publisher_platform, 40), pos = clip(r.platform_position, 40);
    return pp && pos ? `${pp}/${pos}` : null;
  }
  if (kind === "age") return clip(r.age, SEG_MAX);
  return clip(r.gender, SEG_MAX);
}

export function buildSegmentRows(raw: readonly Record<string, unknown>[], kind: SegmentKind): BuildResult<SegmentDayRow> {
  const conv = raw.map((r) => { const c = countMetaConversions(r); return c.basis === "none" ? 0 : c.conversions; });
  const by = new Map<string, SegmentDayRow>();
  let unplaceable = 0;
  raw.forEach((r, i) => {
    const adsetId = digits(r.adset_id), campaignId = digits(r.campaign_id), day = isDay(r.date_start);
    const segment = segmentLabel(kind, r);
    const spend = metaSpendToMicros(r.spend);
    if (!adsetId || !campaignId || !day || !segment || spend == null) { unplaceable++; return; }
    const row: SegmentDayRow = {
      campaignId, adsetId, day, kind, segment,
      spendMicros: Math.max(0, spend), impressions: wholeOrNull(r.impressions) ?? 0,
      linkClicks: wholeOrNull(r.inline_link_clicks),
      conversions: evidencedMetric(conv[i]!, conv),
    };
    const k = `${adsetId}|${day}|${kind}|${segment}`;
    const have = by.get(k);
    if (!have) { by.set(k, row); return; }
    have.spendMicros += row.spendMicros; have.impressions += row.impressions;
    have.linkClicks = have.linkClicks == null || row.linkClicks == null ? null : have.linkClicks + row.linkClicks;
    have.conversions = have.conversions == null || row.conversions == null ? null : have.conversions + row.conversions;
  });
  const rows = Array.from(by.values()).sort((a, b) =>
    a.day.localeCompare(b.day) || a.adsetId.localeCompare(b.adsetId) || a.segment.localeCompare(b.segment));
  return { rows, unplaceable };
}

// ── Entities (campaign, ad set, ad) as a daily interval snapshot ─────────────
export interface MetaEntityRow {
  entityType: EntityType;
  entityId: string;
  parentId: string | null;
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  dailyBudgetMicros: number | null;
  lifetimeBudgetMicros: number | null;
  optimizationGoal: string | null;
  bidStrategy: string | null;
  attrs: Record<string, string | number | boolean | null>;
}

/** Meta reports budgets in the account currency's MINOR unit (cents for USD): × 10,000 = micros. UNVERIFIED for zero-decimal currencies, where it would be wrong; the adapter makes the same assumption. */
export function minorToMicros(v: unknown): number | null {
  const n = numOrNull(v);
  return n == null || n <= 0 ? null : Math.round(n * 10_000);
}

/** Counts only, never names: how many interests, audiences and places an ad set targets. */
export function targetingSummary(t: unknown): Record<string, number | null> {
  const o = (t && typeof t === "object" ? t : {}) as Record<string, any>;
  const len = (v: unknown): number | null => (Array.isArray(v) ? v.length : null);
  const geo = (o.geo_locations && typeof o.geo_locations === "object" ? o.geo_locations : {}) as Record<string, unknown>;
  const flexible = Array.isArray(o.flexible_spec) ? o.flexible_spec : null;
  let interests: number | null = null;
  if (flexible) interests = flexible.reduce((n: number, f: any) => n + (Array.isArray(f?.interests) ? f.interests.length : 0), 0);
  return {
    countries: len(geo.countries), regions: len(geo.regions), cities: len(geo.cities),
    interests,
    custom_audiences: len(o.custom_audiences), excluded_custom_audiences: len(o.excluded_custom_audiences),
    age_min: wholeOrNull(o.age_min), age_max: wholeOrNull(o.age_max),
    genders: len(o.genders),
  };
}

export function normalizeCampaign(r: Record<string, unknown>): MetaEntityRow | null {
  const id = digits(r.id);
  if (!id) return null;
  return {
    entityType: "campaign", entityId: id, parentId: null, name: clip(r.name, 200),
    status: clip(r.status, 40), effectiveStatus: clip(r.effective_status, 60),
    dailyBudgetMicros: minorToMicros(r.daily_budget), lifetimeBudgetMicros: minorToMicros(r.lifetime_budget),
    optimizationGoal: null, bidStrategy: clip(r.bid_strategy, 60),
    attrs: { objective: clip(r.objective, 60), buying_type: clip(r.buying_type, 40) },
  };
}

export function normalizeAdSet(r: Record<string, unknown>): MetaEntityRow | null {
  const id = digits(r.id);
  if (!id) return null;
  const li = (r.learning_stage_info && typeof r.learning_stage_info === "object" ? r.learning_stage_info : {}) as Record<string, unknown>;
  const tgt = targetingSummary(r.targeting);
  return {
    entityType: "adset", entityId: id, parentId: digits(r.campaign_id), name: clip(r.name, 200),
    status: clip(r.status, 40), effectiveStatus: clip(r.effective_status, 60),
    dailyBudgetMicros: minorToMicros(r.daily_budget), lifetimeBudgetMicros: minorToMicros(r.lifetime_budget),
    optimizationGoal: clip(r.optimization_goal, 60), bidStrategy: clip(r.bid_strategy, 60),
    // The learning STATUS word is kept (it moves rarely). The learning EVENT COUNT is not: it changes every day and would open a new interval every morning.
    attrs: { billing_event: clip(r.billing_event, 40), learning_status: clip(li.status, 40), ...tgt },
  };
}

export function normalizeAd(r: Record<string, unknown>): MetaEntityRow | null {
  const id = digits(r.id);
  if (!id) return null;
  const creative = (r.creative && typeof r.creative === "object" ? r.creative : {}) as Record<string, unknown>;
  return {
    entityType: "ad", entityId: id, parentId: digits(r.adset_id), name: clip(r.name, 200),
    status: clip(r.status, 40), effectiveStatus: clip(r.effective_status, 60),
    dailyBudgetMicros: null, lifetimeBudgetMicros: null, optimizationGoal: null, bidStrategy: null,
    attrs: { campaign_id: digits(r.campaign_id), creative_id: digits(creative.id) },
  };
}

/** A stable fingerprint of one entity's settings, over decoded values with sorted keys. */
export function metaEntityHash(e: MetaEntityRow): string {
  const parts = [
    e.entityType, e.entityId, e.parentId ?? "", e.name ?? "", e.status ?? "", e.effectiveStatus ?? "",
    String(e.dailyBudgetMicros ?? ""), String(e.lifetimeBudgetMicros ?? ""), e.optimizationGoal ?? "", e.bidStrategy ?? "",
    ...Object.keys(e.attrs).sort().map((k) => `${k}=${e.attrs[k] ?? ""}`),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

export interface OpenEntity { id: string; entityType: EntityType; entityId: string; contentHash: string; validFrom: string; lastSeenOn: string }
export interface EntityPlan {
  opens: { entity: MetaEntityRow; hash: string }[];
  closes: { id: string; validTo: string }[];
  touches: { id: string }[];
  /** An interval opened EARLIER TODAY that this reading replaces in place: the grain is a date. */
  replaces: { id: string; entity: MetaEntityRow; hash: string }[];
  /** Types not read in full this run. NOTHING of theirs may be closed. */
  incompleteTypes: EntityType[];
}

/**
 * Pure. What is stored, what was read, one date: one plan. A type this run could not
 * read in full closes NOTHING (an entity missing from a partial list is missing from the
 * LIST, never from the account), and a closed interval ends on the date it was last
 * confirmed live, never on a date this run invented.
 */
export function reconcileEntities(opts: { open: OpenEntity[]; read: MetaEntityRow[]; on: string; completeTypes: EntityType[] }): EntityPlan {
  const complete = new Set<EntityType>(opts.completeTypes);
  const key = (t: string, id: string) => `${t}\u0000${id}`;
  const openBy = new Map(opts.open.map((o) => [key(o.entityType, o.entityId), o]));
  const seen = new Set<string>();
  const plan: EntityPlan = { opens: [], closes: [], touches: [], replaces: [], incompleteTypes: ENTITY_TYPES.filter((t) => !complete.has(t)) };
  for (const e of opts.read) {
    const k = key(e.entityType, e.entityId);
    seen.add(k);
    const hash = metaEntityHash(e);
    const prev = openBy.get(k);
    if (!prev) { plan.opens.push({ entity: e, hash }); continue; }
    if (prev.contentHash === hash) { plan.touches.push({ id: prev.id }); continue; }
    if (prev.validFrom === opts.on) { plan.replaces.push({ id: prev.id, entity: e, hash }); continue; }
    plan.closes.push({ id: prev.id, validTo: prev.lastSeenOn });
    plan.opens.push({ entity: e, hash });
  }
  for (const o of opts.open) {
    if (seen.has(key(o.entityType, o.entityId))) continue;
    if (!complete.has(o.entityType)) continue;
    plan.closes.push({ id: o.id, validTo: o.lastSeenOn });
  }
  return plan;
}

// ── Coverage ────────────────────────────────────────────────────────────────
export interface Span { coveredFrom: string; coveredTo: string }
export function hasSpan(prev: Span | null): prev is Span { return prev != null && prev.coveredFrom <= prev.coveredTo; }

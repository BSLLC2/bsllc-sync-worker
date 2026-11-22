/**
 * WHY A CAMPAIGN IS LIMITED, as the platform reports it: how much of the search
 * it could have shown in it was lost to budget and to ad rank, each keyword's
 * quality score and cost to reach the first page, the hours and devices the
 * money went through, and the places it went.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The dashboard could say a campaign was "limited by budget" (the platform's own
 * status word) and could not say HOW MUCH it lost, to what, on which days, at
 * which hours or on which devices. A keyword's quality score was read live inside
 * the audit and then dropped. Nothing stored the platform's own answer to "why is
 * this campaign not getting more". This is the store. Nothing here changes a
 * detection rule and nothing here is a finding; a reader decides what to say.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 *
 *  · READ-ONLY. Every query is a SELECT. Nothing is written to any ad platform.
 *  · FIVE PARTS, EACH ITS OWN SCAN (`share_days`, `keyword_quality`,
 *    `segment_hours`, `segment_devices`, `geo`), so one failing query does not
 *    erase what another last read, and a failure is a dated row that says so.
 *  · A SHARE IS NULLABLE AND A NULL IS UNANSWERED. The platform returns no share
 *    for a day a campaign had nothing eligible to show, and a share is never
 *    summed or defaulted. A DAY WITH NO SHARE ROW IS NOT A NOUGHT: unlike the
 *    campaign day record, absence here says nothing, because the platform omits
 *    the share rather than answering 0.
 *  · A BOUND IS KEPT AS A BOUND. The platform can answer "less than 10%" (as a
 *    string, or as the sentinel 0.0999) instead of a figure. The number it gave
 *    is stored and a separate text flag (`lt`, `gt`) says it is a bound; it is
 *    never rounded up to a figure and never stored as a nought. The 0.0999
 *    sentinel is the platform's documented spelling of "under ten percent"; it
 *    is read as that and is unverified against a live account.
 *  · MONEY IS MICROS, verbatim: `cost_micros`, `first_page_cpc_micros`,
 *    `top_of_page_cpc_micros`. Declared in the dashboard's ADS_SHARE_UNITS.
 *  · A KEYWORD'S QUALITY IS WHAT THE PLATFORM SAYS NOW. The score is 1 to 10 and
 *    anything else is null; each component is below, average or above, and a
 *    component the platform did not report is null (UNKNOWN and UNSPECIFIED are
 *    not an answer). A CPC estimate of 0 or none is no estimate, not a free click.
 *  · DAY PARTS READ 60 DAYS FIRST AND 14 AFTER, in slices of 14 days, because an
 *    hour-by-day read of a large account can exceed the row ceiling that one
 *    14-day slice cannot. WINDOW PARTS (quality, geo) read the 30 days ending
 *    yesterday (UTC) and REPLACE that window whole.
 *  · A READ AT THE ROW CEILING WRITES NOTHING for that part: a truncated list read
 *    as complete would turn every missing row into a nought.
 *  · A FAILED READ WRITES A FAILURE, NOT SILENCE: the scan row says ok = false and
 *    keeps its coverage where it was.
 *  · NO SEARCH TERMS, NO PEOPLE. A place is a numeric id, never a name.
 *
 * Pure except the store functions at the foot, which take a client.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { evidencedMetric } from "../metric-evidence.js";
import { addDays, coverageAfter, hasSpan } from "./daily-metrics.js";
import { KEYWORD_MATCH_TYPE, snapshotEnum, type UnrecognisedEnum } from "./structure-snapshot.js";
import { decodeQsBucket } from "./qs-components.js";
import { keywordEntityId } from "./keyword-metrics.js";

export const PLATFORM = "google_ads";
export const BACKFILL_DAYS = 60;
export const RESTATE_DAYS = 14;
/** One query covers at most this many days, so a slice stays under the ceiling. */
export const SLICE_DAYS = 14;
export const WINDOW_DAYS = 30;
export const RETAIN_DAYS = 120;
export const MAX_ROWS = 50_000;
export const PARTS = ["share_days", "keyword_quality", "segment_hours", "segment_devices", "geo"] as const;
export type Part = (typeof PARTS)[number];
export const DAY_PARTS: readonly Part[] = ["share_days", "segment_hours", "segment_devices"];
export const SEGMENT_KINDS = ["hour", "device"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export const NO_ACCOUNTS_NOTE = "no Google Ads account is mapped, so no impression share, quality score or segment was captured for any client";

// Every field below was checked against the installed library's own field list
// (verify-gaql-fields). Whether the platform accepts each combination against a
// live account is UNVERIFIED: the first run is a dry run, read it.
export const SHARE_DAYS_GAQL = `
  SELECT campaign.id, campaign.name, segments.date,
         metrics.search_impression_share, metrics.search_budget_lost_impression_share,
         metrics.search_rank_lost_impression_share, metrics.search_top_impression_share,
         metrics.search_absolute_top_impression_share
    FROM campaign
   WHERE segments.date BETWEEN '{{start}}' AND '{{end}}'
     AND campaign.status != 'REMOVED'
     AND campaign.advertising_channel_type = 'SEARCH'`;

export const KEYWORD_QUALITY_GAQL = `
  SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id,
         ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
         ad_group_criterion.quality_info.quality_score,
         ad_group_criterion.quality_info.search_predicted_ctr,
         ad_group_criterion.quality_info.creative_quality_score,
         ad_group_criterion.quality_info.post_click_quality_score,
         ad_group_criterion.position_estimates.first_page_cpc_micros,
         ad_group_criterion.position_estimates.top_of_page_cpc_micros
    FROM ad_group_criterion
   WHERE ad_group_criterion.type = 'KEYWORD'
     AND ad_group_criterion.negative = FALSE
     AND ad_group_criterion.status != 'REMOVED'
     AND ad_group.status != 'REMOVED'
     AND campaign.status != 'REMOVED'`;

export const SEGMENT_HOURS_GAQL = `
  SELECT campaign.id, segments.date, segments.hour,
         metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM campaign
   WHERE segments.date BETWEEN '{{start}}' AND '{{end}}'
     AND campaign.status != 'REMOVED'`;

export const SEGMENT_DEVICES_GAQL = `
  SELECT campaign.id, segments.date, segments.device,
         metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM campaign
   WHERE segments.date BETWEEN '{{start}}' AND '{{end}}'
     AND campaign.status != 'REMOVED'`;

/** Country and, where the platform allows the segment with this view, the most specific place. */
export const GEO_GAQL = `
  SELECT campaign.id, user_location_view.country_criterion_id, user_location_view.targeting_location,
         segments.geo_target_most_specific_location,
         metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM user_location_view
   WHERE segments.date BETWEEN '{{start}}' AND '{{end}}'
     AND campaign.status != 'REMOVED'`;

/** The same read without the finer place, for an API version that refuses the segment with this view. */
export const GEO_GAQL_COUNTRY_ONLY = GEO_GAQL.replace("         segments.geo_target_most_specific_location,\n", "");

export const QUERY_BY_PART: Record<Part, string> = {
  share_days: SHARE_DAYS_GAQL, keyword_quality: KEYWORD_QUALITY_GAQL,
  segment_hours: SEGMENT_HOURS_GAQL, segment_devices: SEGMENT_DEVICES_GAQL, geo: GEO_GAQL,
};

export const fillWindow = (gaql: string, w: { start: string; end: string }): string =>
  gaql.replace("{{start}}", w.start).replace("{{end}}", w.end);

// ── Windows ─────────────────────────────────────────────────────────────────
/** The window a window part reads: the 30 days ending YESTERDAY (UTC). */
export function windowEndingYesterday(today: string, days = WINDOW_DAYS): { start: string; end: string } {
  const n = Math.max(1, Math.min(days, 90));
  const end = addDays(today, -1);
  return { start: addDays(end, -(n - 1)), end };
}

/** A day part's window: 60 days the first time, 14 after, ending yesterday (UTC). */
export function dayWindow(today: string, firstRun: boolean, days?: number): { start: string; end: string } {
  const n = Math.max(1, Math.min(days ?? (firstRun ? BACKFILL_DAYS : RESTATE_DAYS), 400));
  const end = addDays(today, -1);
  return { start: addDays(end, -(n - 1)), end };
}

/** Slices of at most `size` days, oldest first, covering the window exactly with no overlap. */
export function sliceWindow(w: { start: string; end: string }, size = SLICE_DAYS): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  let from = w.start;
  while (from <= w.end) {
    const to = addDays(from, size - 1);
    out.push({ start: from, end: to < w.end ? to : w.end });
    from = addDays(to, 1);
  }
  return out;
}

// ── Shares ──────────────────────────────────────────────────────────────────
export type ShareBound = "lt" | "gt";
export interface ShareValue { value: number | null; bound: ShareBound | null }
const NO_SHARE: ShareValue = { value: null, bound: null };
/** The platform's spelling of "under ten percent" as a number. UNVERIFIED against a live account. */
export const UNDER_TEN_SENTINEL = 0.0999;

/**
 * One impression-share measure into a figure and, where the platform gave a
 * bound, a flag. A fraction from 0 to 1. Anything that does not read as one is
 * null: a value over 1, a negative, "--", text.
 */
export function parseShare(raw: unknown): ShareValue {
  if (raw == null) return NO_SHARE;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0 || raw > 1) return NO_SHARE;
    if (Math.abs(raw - UNDER_TEN_SENTINEL) < 1e-9) return { value: raw, bound: "lt" };
    return { value: raw, bound: null };
  }
  const s = String(raw).trim();
  if (!s || s === "--") return NO_SHARE;
  const m = s.match(/^(<=|>=|<|>|≤|≥)?\s*(\d+(?:\.\d+)?)\s*(%)?$/);
  if (!m) return NO_SHARE;
  let n = Number(m[2]);
  if (m[3]) n = n / 100;
  if (!Number.isFinite(n) || n < 0 || n > 1) return NO_SHARE;
  const op = m[1];
  const bound: ShareBound | null = op === "<" || op === "<=" || op === "≤" ? "lt" : op === ">" || op === ">=" || op === "≥" ? "gt" : null;
  if (!bound && Math.abs(n - UNDER_TEN_SENTINEL) < 1e-9) return { value: n, bound: "lt" };
  return { value: n, bound };
}

const finite = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const digits = (v: unknown): string | null => { const s = String(v ?? "").trim(); return /^\d+$/.test(s) ? s : null; };
const tail = (v: unknown): string | null => digits(String(v ?? "").split("/").pop());
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export const SHARE_MEASURES = ["impression_share", "budget_lost_share", "rank_lost_share", "top_share", "abs_top_share"] as const;
export type ShareMeasure = (typeof SHARE_MEASURES)[number];
const SHARE_METRIC: Record<ShareMeasure, [string, string]> = {
  impression_share: ["search_impression_share", "searchImpressionShare"],
  budget_lost_share: ["search_budget_lost_impression_share", "searchBudgetLostImpressionShare"],
  rank_lost_share: ["search_rank_lost_impression_share", "searchRankLostImpressionShare"],
  top_share: ["search_top_impression_share", "searchTopImpressionShare"],
  abs_top_share: ["search_absolute_top_impression_share", "searchAbsoluteTopImpressionShare"],
};

export interface ShareDayRow {
  campaignId: string;
  campaignName: string | null;
  /** YYYY-MM-DD, account-local. */
  date: string;
  shares: Record<ShareMeasure, ShareValue>;
}

export function normalizeShareDay(row: any): ShareDayRow | null {
  const campaignId = digits(row?.campaign?.id);
  const date = String(row?.segments?.date ?? "").trim();
  if (!campaignId || !isDay(date)) return null;
  const m = row?.metrics ?? {};
  const shares = {} as Record<ShareMeasure, ShareValue>;
  for (const k of SHARE_MEASURES) shares[k] = parseShare(m[SHARE_METRIC[k][0]] ?? m[SHARE_METRIC[k][1]]);
  const name = String(row?.campaign?.name ?? "").trim();
  return { campaignId, campaignName: name ? name.slice(0, 200) : null, date, shares };
}

/**
 * One row per campaign per day. A row where the platform gave no share at all is
 * dropped: it says nothing, and the scan row says how far the read reached. A
 * repeated campaign-day is not summed (a share cannot be); the last one wins.
 */
export function buildShareRows(raw: readonly any[]): ShareDayRow[] {
  const by = new Map<string, ShareDayRow>();
  for (const r of raw) {
    const n = normalizeShareDay(r);
    if (!n) continue;
    if (!SHARE_MEASURES.some((k) => n.shares[k].value != null)) continue;
    by.set(`${n.campaignId}|${n.date}`, n);
  }
  return Array.from(by.values()).sort((a, b) => a.date.localeCompare(b.date) || a.campaignId.localeCompare(b.campaignId));
}

// ── Keyword quality ─────────────────────────────────────────────────────────
export interface KeywordQualityRow {
  campaignId: string;
  adGroupId: string;
  criterionId: string;
  entityId: string;
  keywordText: string | null;
  matchType: string | null;
  /** 1 to 10, or null. */
  qualityScore: number | null;
  /** below | average | above, or null. */
  expectedCtr: string | null;
  adRelevance: string | null;
  landingPage: string | null;
  firstPageCpcMicros: number | null;
  topOfPageCpcMicros: number | null;
}

const score = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
};
const cpc = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function normalizeKeywordQuality(row: any, report?: UnrecognisedEnum[]): KeywordQualityRow | null {
  const campaignId = digits(row?.campaign?.id);
  const adGroupId = digits(row?.ad_group?.id);
  const criterionId = digits(row?.ad_group_criterion?.criterion_id);
  if (!campaignId || !adGroupId || !criterionId) return null;
  const q = row?.ad_group_criterion?.quality_info ?? {};
  const p = row?.ad_group_criterion?.position_estimates ?? {};
  const text = String(row?.ad_group_criterion?.keyword?.text ?? "").trim();
  return {
    campaignId, adGroupId, criterionId, entityId: keywordEntityId(adGroupId, criterionId),
    keywordText: text ? text.slice(0, 200) : null,
    matchType: snapshotEnum(KEYWORD_MATCH_TYPE, row?.ad_group_criterion?.keyword?.match_type, "ad_group_criterion.keyword.match_type", report),
    qualityScore: score(q.quality_score ?? q.qualityScore),
    expectedCtr: decodeQsBucket(q.search_predicted_ctr ?? q.searchPredictedCtr),
    adRelevance: decodeQsBucket(q.creative_quality_score ?? q.creativeQualityScore),
    landingPage: decodeQsBucket(q.post_click_quality_score ?? q.postClickQualityScore),
    firstPageCpcMicros: cpc(p.first_page_cpc_micros ?? p.firstPageCpcMicros),
    topOfPageCpcMicros: cpc(p.top_of_page_cpc_micros ?? p.topOfPageCpcMicros),
  };
}

/** One row per keyword. An unscored keyword is kept (all null) so a reader can say how many have no score. */
export function buildQualityRows(raw: readonly any[], report?: UnrecognisedEnum[]): KeywordQualityRow[] {
  const by = new Map<string, KeywordQualityRow>();
  for (const r of raw) {
    const n = normalizeKeywordQuality(r, report);
    if (n) by.set(n.entityId, n);
  }
  return Array.from(by.values()).sort((a, b) => a.entityId.localeCompare(b.entityId));
}

// ── Segments (hour of day, device) ──────────────────────────────────────────
/** The library's Device enum numbers. The worker keeps its own copy: this module is pure. */
export const DEVICE: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "MOBILE", "3": "TABLET", "4": "DESKTOP", "5": "OTHER", "6": "CONNECTED_TV",
};

export interface SegmentRow {
  campaignId: string;
  date: string;
  kind: SegmentKind;
  /** "0".."23" for an hour, or the device word. */
  value: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number | null;
}

export function normalizeSegment(row: any, kind: SegmentKind, report?: UnrecognisedEnum[]): (Omit<SegmentRow, "conversions"> & { conversions: number }) | null {
  const campaignId = digits(row?.campaign?.id);
  const date = String(row?.segments?.date ?? "").trim();
  if (!campaignId || !isDay(date)) return null;
  let value: string | null;
  if (kind === "hour") {
    const h = Number(row?.segments?.hour);
    value = Number.isInteger(h) && h >= 0 && h <= 23 ? String(h) : null;
  } else {
    const d = snapshotEnum(DEVICE, row?.segments?.device, "segments.device", report);
    value = d && d !== "UNSPECIFIED" && d !== "UNKNOWN" ? d : null;
  }
  if (value == null) return null;
  const m = row?.metrics ?? {};
  return {
    campaignId, date, kind, value,
    impressions: Math.max(0, Math.round(finite(m.impressions))),
    clicks: Math.max(0, Math.round(finite(m.clicks))),
    costMicros: Math.max(0, Math.round(finite(m.cost_micros ?? m.costMicros))),
    conversions: Math.max(0, finite(m.conversions)),
  };
}

/** One row per campaign, day and segment value (repeats summed), conversions nulled where nothing in the window shows they are counted. */
export function buildSegmentRows(raw: readonly any[], kind: SegmentKind, report?: UnrecognisedEnum[]): SegmentRow[] {
  const by = new Map<string, NonNullable<ReturnType<typeof normalizeSegment>>>();
  for (const r of raw) {
    const n = normalizeSegment(r, kind, report);
    if (!n) continue;
    const k = `${n.campaignId}|${n.date}|${n.value}`;
    const have = by.get(k);
    if (have) {
      have.impressions += n.impressions; have.clicks += n.clicks;
      have.costMicros += n.costMicros; have.conversions += n.conversions;
    } else by.set(k, n);
  }
  const all = Array.from(by.values());
  const window = all.map((r) => r.conversions);
  return all.map((r) => ({ ...r, conversions: evidencedMetric(r.conversions, window) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.campaignId.localeCompare(b.campaignId) || a.value.localeCompare(b.value, undefined, { numeric: true }));
}

// ── Geography ───────────────────────────────────────────────────────────────
export interface GeoRow {
  campaignId: string;
  /** The platform's country id, numeric. */
  countryId: string;
  /** The most specific place's id, or "" where the read did not carry one. */
  locationId: string;
  /** Null = the platform did not say. */
  targetingLocation: boolean | null;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number | null;
}

export function normalizeGeo(row: any): (Omit<GeoRow, "conversions"> & { conversions: number }) | null {
  const campaignId = digits(row?.campaign?.id);
  const countryId = digits(row?.user_location_view?.country_criterion_id ?? row?.userLocationView?.countryCriterionId);
  if (!campaignId || !countryId) return null;
  const t = row?.user_location_view?.targeting_location ?? row?.userLocationView?.targetingLocation;
  const m = row?.metrics ?? {};
  return {
    campaignId, countryId,
    locationId: tail(row?.segments?.geo_target_most_specific_location ?? row?.segments?.geoTargetMostSpecificLocation) ?? "",
    targetingLocation: typeof t === "boolean" ? t : null,
    impressions: Math.max(0, Math.round(finite(m.impressions))),
    clicks: Math.max(0, Math.round(finite(m.clicks))),
    costMicros: Math.max(0, Math.round(finite(m.cost_micros ?? m.costMicros))),
    conversions: Math.max(0, finite(m.conversions)),
  };
}

/** One row per campaign and place (repeats summed); nothing is read from a person. */
export function buildGeoRows(raw: readonly any[]): GeoRow[] {
  const by = new Map<string, NonNullable<ReturnType<typeof normalizeGeo>>>();
  for (const r of raw) {
    const n = normalizeGeo(r);
    if (!n) continue;
    const k = `${n.campaignId}|${n.countryId}|${n.locationId}`;
    const have = by.get(k);
    if (have) {
      have.impressions += n.impressions; have.clicks += n.clicks;
      have.costMicros += n.costMicros; have.conversions += n.conversions;
      if (have.targetingLocation == null) have.targetingLocation = n.targetingLocation;
    } else by.set(k, n);
  }
  const all = Array.from(by.values());
  const window = all.map((r) => r.conversions);
  return all.map((r) => ({ ...r, conversions: evidencedMetric(r.conversions, window) }))
    .sort((a, b) => a.campaignId.localeCompare(b.campaignId) || a.countryId.localeCompare(b.countryId) || a.locationId.localeCompare(b.locationId));
}

export const accountLine = (name: string, part: Part, rows: number, window: { start: string; end: string }): string =>
  `  ${name}: ${rows} ${part.replace("_", " ")} row${rows === 1 ? "" : "s"}, ${window.start} to ${window.end}`;

// ── Store ───────────────────────────────────────────────────────────────────
/** Idempotent. The dashboard's ensureSchema() makes the same tables (v301); keep the columns identical to server/db.ts. */
export async function ensureShareTables(c: pg.Client): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS ads_share_days (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL, campaign_name TEXT, metric_date TEXT NOT NULL,
      impression_share DOUBLE PRECISION, impression_share_bound TEXT,
      budget_lost_share DOUBLE PRECISION, budget_lost_share_bound TEXT,
      rank_lost_share DOUBLE PRECISION, rank_lost_share_bound TEXT,
      top_share DOUBLE PRECISION, top_share_bound TEXT,
      abs_top_share DOUBLE PRECISION, abs_top_share_bound TEXT,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_share_days_day ON ads_share_days (platform, account_id, campaign_id, metric_date);
    CREATE INDEX IF NOT EXISTS idx_ads_share_days_client ON ads_share_days (client_id, metric_date);
    CREATE TABLE IF NOT EXISTS ads_keyword_quality (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL, ad_group_id TEXT NOT NULL, criterion_id TEXT NOT NULL, entity_id TEXT NOT NULL,
      keyword_text TEXT, match_type TEXT, quality_score INTEGER, expected_ctr TEXT, ad_relevance TEXT, landing_page TEXT,
      first_page_cpc_micros BIGINT, top_of_page_cpc_micros BIGINT,
      window_start TEXT NOT NULL, window_end TEXT NOT NULL, synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_keyword_quality_window ON ads_keyword_quality (platform, account_id, ad_group_id, criterion_id, window_end);
    CREATE INDEX IF NOT EXISTS idx_ads_keyword_quality_client ON ads_keyword_quality (client_id, window_end);
    CREATE TABLE IF NOT EXISTS ads_segment_days (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL, metric_date TEXT NOT NULL, segment_kind TEXT NOT NULL, segment_value TEXT NOT NULL,
      impressions BIGINT NOT NULL DEFAULT 0, clicks BIGINT NOT NULL DEFAULT 0, cost_micros BIGINT NOT NULL DEFAULT 0,
      conversions DOUBLE PRECISION, synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_segment_days_key ON ads_segment_days (platform, account_id, campaign_id, metric_date, segment_kind, segment_value);
    CREATE INDEX IF NOT EXISTS idx_ads_segment_days_client ON ads_segment_days (client_id, segment_kind, metric_date);
    CREATE TABLE IF NOT EXISTS ads_geo_windows (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL, country_id TEXT NOT NULL, location_id TEXT NOT NULL DEFAULT '', targeting_location BOOLEAN,
      impressions BIGINT NOT NULL DEFAULT 0, clicks BIGINT NOT NULL DEFAULT 0, cost_micros BIGINT NOT NULL DEFAULT 0,
      conversions DOUBLE PRECISION, window_start TEXT NOT NULL, window_end TEXT NOT NULL, synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_geo_windows_key ON ads_geo_windows (platform, account_id, campaign_id, country_id, location_id, window_end);
    CREATE INDEX IF NOT EXISTS idx_ads_geo_windows_client ON ads_geo_windows (client_id, window_end);
    CREATE TABLE IF NOT EXISTS ads_share_scans (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      part TEXT NOT NULL, covered_from TEXT NOT NULL, covered_to TEXT NOT NULL,
      last_scan_at TIMESTAMPTZ NOT NULL DEFAULT now(), ok BOOLEAN NOT NULL DEFAULT true,
      rows_read INTEGER NOT NULL DEFAULT 0, note TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_share_scans_part ON ads_share_scans (platform, account_id, part);`);
}

export async function loadPartCoverage(c: pg.Client, accountId: string, part: Part): Promise<{ coveredFrom: string; coveredTo: string } | null> {
  const { rows } = await c.query<{ covered_from: string; covered_to: string }>(
    `SELECT covered_from, covered_to FROM ads_share_scans WHERE platform = $1 AND account_id = $2 AND part = $3`,
    [PLATFORM, accountId, part],
  );
  return rows[0] ? { coveredFrom: rows[0].covered_from, coveredTo: rows[0].covered_to } : null;
}

async function writeScan(
  c: pg.Client, clientId: string, accountId: string, part: Part, from: string, to: string, rows: number, note: string,
): Promise<void> {
  await c.query(
    `INSERT INTO ads_share_scans (id, client_id, platform, account_id, part, covered_from, covered_to, last_scan_at, ok, rows_read, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), true, $8, $9)
     ON CONFLICT (platform, account_id, part) DO UPDATE SET
       client_id = EXCLUDED.client_id, covered_from = EXCLUDED.covered_from, covered_to = EXCLUDED.covered_to,
       last_scan_at = now(), ok = true, rows_read = EXCLUDED.rows_read, note = EXCLUDED.note`,
    [randomUUID(), clientId, PLATFORM, accountId, part, from, to, rows, note.slice(0, 400)],
  );
}

/** Move a day part's coverage and write its rows, in one transaction. */
async function inTx<T>(c: pg.Client, fn: () => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try { const out = await fn(); await c.query("COMMIT"); return out; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
}

export async function storeShareDays(
  c: pg.Client, clientId: string, accountId: string, rows: readonly ShareDayRow[], window: { start: string; end: string }, note: string,
): Promise<{ coveredFrom: string; restarted: boolean }> {
  return inTx(c, async () => {
    for (const r of rows) {
      const s = r.shares;
      await c.query(
        `INSERT INTO ads_share_days (id, client_id, platform, account_id, campaign_id, campaign_name, metric_date,
           impression_share, impression_share_bound, budget_lost_share, budget_lost_share_bound, rank_lost_share, rank_lost_share_bound,
           top_share, top_share_bound, abs_top_share, abs_top_share_bound, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
         ON CONFLICT (platform, account_id, campaign_id, metric_date) DO UPDATE SET
           client_id = EXCLUDED.client_id, campaign_name = EXCLUDED.campaign_name,
           impression_share = EXCLUDED.impression_share, impression_share_bound = EXCLUDED.impression_share_bound,
           budget_lost_share = EXCLUDED.budget_lost_share, budget_lost_share_bound = EXCLUDED.budget_lost_share_bound,
           rank_lost_share = EXCLUDED.rank_lost_share, rank_lost_share_bound = EXCLUDED.rank_lost_share_bound,
           top_share = EXCLUDED.top_share, top_share_bound = EXCLUDED.top_share_bound,
           abs_top_share = EXCLUDED.abs_top_share, abs_top_share_bound = EXCLUDED.abs_top_share_bound, synced_at = now()`,
        [randomUUID(), clientId, PLATFORM, accountId, r.campaignId, r.campaignName, r.date,
          s.impression_share.value, s.impression_share.bound, s.budget_lost_share.value, s.budget_lost_share.bound,
          s.rank_lost_share.value, s.rank_lost_share.bound, s.top_share.value, s.top_share.bound,
          s.abs_top_share.value, s.abs_top_share.bound],
      );
    }
    await c.query(`DELETE FROM ads_share_days WHERE platform = $1 AND account_id = $2 AND metric_date < $3`, [PLATFORM, accountId, addDays(window.end, -RETAIN_DAYS)]);
    const cov = coverageAfter(await loadPartCoverage(c, accountId, "share_days"), window);
    await writeScan(c, clientId, accountId, "share_days", cov.coveredFrom, window.end, rows.length, note);
    return cov;
  });
}

export async function storeSegmentDays(
  c: pg.Client, clientId: string, accountId: string, kind: SegmentKind, rows: readonly SegmentRow[],
  window: { start: string; end: string }, note: string,
): Promise<{ coveredFrom: string; restarted: boolean }> {
  const part: Part = kind === "hour" ? "segment_hours" : "segment_devices";
  return inTx(c, async () => {
    for (const r of rows) {
      await c.query(
        `INSERT INTO ads_segment_days (id, client_id, platform, account_id, campaign_id, metric_date, segment_kind, segment_value, impressions, clicks, cost_micros, conversions, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT (platform, account_id, campaign_id, metric_date, segment_kind, segment_value) DO UPDATE SET
           client_id = EXCLUDED.client_id, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
           cost_micros = EXCLUDED.cost_micros, conversions = EXCLUDED.conversions, synced_at = now()`,
        [randomUUID(), clientId, PLATFORM, accountId, r.campaignId, r.date, r.kind, r.value, r.impressions, r.clicks, r.costMicros, r.conversions],
      );
    }
    await c.query(`DELETE FROM ads_segment_days WHERE platform = $1 AND account_id = $2 AND segment_kind = $3 AND metric_date < $4`, [PLATFORM, accountId, kind, addDays(window.end, -RETAIN_DAYS)]);
    const cov = coverageAfter(await loadPartCoverage(c, accountId, part), window);
    await writeScan(c, clientId, accountId, part, cov.coveredFrom, window.end, rows.length, note);
    return cov;
  });
}

/** Replace this window's keyword quality rows and move the scan, in one transaction. */
export async function storeKeywordQuality(
  c: pg.Client, clientId: string, accountId: string, rows: readonly KeywordQualityRow[], window: { start: string; end: string },
): Promise<void> {
  await inTx(c, async () => {
    await c.query(`DELETE FROM ads_keyword_quality WHERE platform = $1 AND account_id = $2 AND window_end = $3`, [PLATFORM, accountId, window.end]);
    for (const r of rows) {
      await c.query(
        `INSERT INTO ads_keyword_quality (id, client_id, platform, account_id, campaign_id, ad_group_id, criterion_id, entity_id, keyword_text, match_type,
           quality_score, expected_ctr, ad_relevance, landing_page, first_page_cpc_micros, top_of_page_cpc_micros, window_start, window_end, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())`,
        [randomUUID(), clientId, PLATFORM, accountId, r.campaignId, r.adGroupId, r.criterionId, r.entityId, r.keywordText, r.matchType,
          r.qualityScore, r.expectedCtr, r.adRelevance, r.landingPage, r.firstPageCpcMicros, r.topOfPageCpcMicros, window.start, window.end],
      );
    }
    await c.query(`DELETE FROM ads_keyword_quality WHERE platform = $1 AND account_id = $2 AND window_end < $3`, [PLATFORM, accountId, addDays(window.end, -RETAIN_DAYS)]);
    await writeScan(c, clientId, accountId, "keyword_quality", window.start, window.end, rows.length, `${rows.length} keywords, ${window.start} to ${window.end}`);
  });
}

export async function storeGeo(
  c: pg.Client, clientId: string, accountId: string, rows: readonly GeoRow[], window: { start: string; end: string }, note = "",
): Promise<void> {
  await inTx(c, async () => {
    await c.query(`DELETE FROM ads_geo_windows WHERE platform = $1 AND account_id = $2 AND window_end = $3`, [PLATFORM, accountId, window.end]);
    for (const r of rows) {
      await c.query(
        `INSERT INTO ads_geo_windows (id, client_id, platform, account_id, campaign_id, country_id, location_id, targeting_location, impressions, clicks, cost_micros, conversions, window_start, window_end, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())`,
        [randomUUID(), clientId, PLATFORM, accountId, r.campaignId, r.countryId, r.locationId, r.targetingLocation, r.impressions, r.clicks, r.costMicros, r.conversions, window.start, window.end],
      );
    }
    await c.query(`DELETE FROM ads_geo_windows WHERE platform = $1 AND account_id = $2 AND window_end < $3`, [PLATFORM, accountId, addDays(window.end, -RETAIN_DAYS)]);
    await writeScan(c, clientId, accountId, "geo", window.start, window.end, rows.length, `${rows.length} places, ${window.start} to ${window.end}${note ? `; ${note}` : ""}`);
  });
}

/** A failed read. The coverage stays where the last good run left it; a first-ever failure writes a row whose span is empty, so the failure is dated and covers nothing. */
export async function recordShareFailure(
  c: pg.Client, clientId: string, accountId: string, part: Part, today: string, why: string,
): Promise<void> {
  await c.query(
    `INSERT INTO ads_share_scans (id, client_id, platform, account_id, part, covered_from, covered_to, last_scan_at, ok, rows_read, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), false, 0, $8)
     ON CONFLICT (platform, account_id, part) DO UPDATE SET last_scan_at = now(), ok = false, note = EXCLUDED.note`,
    [randomUUID(), clientId, PLATFORM, accountId, part, today, addDays(today, -1), `read failed: ${why}`.slice(0, 400)],
  );
}

export { hasSpan };

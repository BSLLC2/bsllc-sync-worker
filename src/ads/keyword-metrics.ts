/**
 * Each keyword's last 30 days, and each campaign's conversions split by the
 * conversion action that counted them, as the platform reported them.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The findings rules judge a keyword and a conversion setup, but the only
 * stored figures were campaign totals (`ads_daily_metrics`) and the cut
 * lists inside a finding's evidence. Nothing held a keyword's spend and
 * conversions as a figure, and nothing said WHICH conversion action produced a
 * campaign's conversions. This is the store for both. Nothing here changes a
 * detection rule; a reader decides what to do with it.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 *
 *  · READ-ONLY. Two SELECTs per account. Nothing is written to any ad platform.
 *  · A WINDOW, NOT A DAY. Each run reads the 30 days ending yesterday (UTC) and
 *    REPLACES that account's rows for that window end, whole, so a restated
 *    figure lands and a keyword that stopped spending leaves no stale row.
 *    Windows older than `RETAIN_DAYS` are pruned.
 *  · MONEY IS MICROS, verbatim (`cost_micros`). `conversions_value` is in the
 *    ACCOUNT'S CURRENCY UNITS, not micros, exactly as the platform reports it,
 *    and the column name says nothing else: it is never converted here.
 *  · A NULL IS UNANSWERED. Keyword conversions are null unless the account
 *    reported a conversion somewhere in the window (`evidencedMetric`).
 *  · A READ AT THE ROW CEILING WRITES NOTHING for that part. A truncated list
 *    read as complete would make every missing keyword a keyword that did not
 *    spend.
 *  · EACH PART IS ITS OWN SCAN (`keywords`, `conversion_actions`), so one
 *    failing query does not erase what the other last read, and a failure is a
 *    dated row that says so.
 *  · NO SEARCH TERMS, NO PEOPLE. A keyword is what the account manager typed.
 *
 * Pure except the store functions at the foot, which take a client.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { evidencedMetric } from "../metric-evidence.js";
import { KEYWORD_MATCH_TYPE, snapshotEnum, type UnrecognisedEnum } from "./structure-snapshot.js";
import { addDays } from "./daily-metrics.js";

export const PLATFORM = "google_ads";
export const WINDOW_DAYS = 30;
export const RETAIN_DAYS = 120;
export const MAX_ROWS = 50_000;
export const PARTS = ["keywords", "conversion_actions"] as const;
export type Part = (typeof PARTS)[number];

export const NO_ACCOUNTS_NOTE = "no Google Ads account is mapped, so no keyword figure was captured for any client";

export const KEYWORD_METRICS_GAQL = `
  SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id,
         ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
         metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM keyword_view
   WHERE segments.date BETWEEN '{{start}}' AND '{{end}}'
     AND ad_group_criterion.negative = FALSE
     AND ad_group_criterion.status != 'REMOVED'`;

export const CONVERSION_ACTION_METRICS_GAQL = `
  SELECT campaign.id, segments.conversion_action, segments.conversion_action_name,
         metrics.conversions, metrics.conversions_value, metrics.all_conversions
    FROM campaign
   WHERE segments.date BETWEEN '{{start}}' AND '{{end}}'
     AND campaign.status != 'REMOVED'`;

/** The window to read: the 30 days ending YESTERDAY (UTC). */
export function metricsWindow(today: string, days = WINDOW_DAYS): { start: string; end: string } {
  const n = Math.max(1, Math.min(days, 90));
  const end = addDays(today, -1);
  return { start: addDays(end, -(n - 1)), end };
}

const finite = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const digits = (v: unknown): string | null => { const s = String(v ?? "").trim(); return /^\d+$/.test(s) ? s : null; };
const tail = (v: unknown): string | null => digits(String(v ?? "").split("/").pop());

export interface KeywordMetricRow {
  campaignId: string;
  adGroupId: string;
  criterionId: string;
  entityId: string;
  keywordText: string | null;
  matchType: string | null;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number | null;
}

/** Same id shape the structure snapshot uses for an ad group keyword (`ag:<adGroup>:<criterion>`). */
export function keywordEntityId(adGroupId: string, criterionId: string): string {
  return `ag:${adGroupId}:${criterionId}`;
}

export function normalizeKeywordMetric(row: any, report?: UnrecognisedEnum[]): Omit<KeywordMetricRow, "conversions"> & { conversions: number } | null {
  const adGroupId = digits(row?.ad_group?.id);
  const criterionId = digits(row?.ad_group_criterion?.criterion_id);
  const campaignId = digits(row?.campaign?.id);
  if (!adGroupId || !criterionId || !campaignId) return null;
  const m = row?.metrics ?? {};
  const text = String(row?.ad_group_criterion?.keyword?.text ?? "").trim();
  return {
    campaignId, adGroupId, criterionId, entityId: keywordEntityId(adGroupId, criterionId),
    keywordText: text ? text.slice(0, 200) : null,
    matchType: snapshotEnum(KEYWORD_MATCH_TYPE, row?.ad_group_criterion?.keyword?.match_type, "ad_group_criterion.keyword.match_type", report),
    impressions: Math.max(0, Math.round(finite(m.impressions))),
    clicks: Math.max(0, Math.round(finite(m.clicks))),
    costMicros: Math.max(0, Math.round(finite(m.cost_micros ?? m.costMicros))),
    conversions: Math.max(0, finite(m.conversions)),
  };
}

/** One row per keyword (the platform can return a keyword once per segment, so repeats are summed), conversions nulled where nothing in the window shows they are counted. */
export function buildKeywordRows(raw: readonly any[], report?: UnrecognisedEnum[]): KeywordMetricRow[] {
  const by = new Map<string, NonNullable<ReturnType<typeof normalizeKeywordMetric>>>();
  for (const r of raw) {
    const n = normalizeKeywordMetric(r, report);
    if (!n) continue;
    const have = by.get(n.entityId);
    if (have) {
      have.impressions += n.impressions; have.clicks += n.clicks;
      have.costMicros += n.costMicros; have.conversions += n.conversions;
    } else by.set(n.entityId, n);
  }
  const all = Array.from(by.values());
  const window = all.map((r) => r.conversions);
  return all.map((r) => ({ ...r, conversions: evidencedMetric(r.conversions, window) }))
    .sort((a, b) => a.entityId.localeCompare(b.entityId));
}

export interface ConversionActionRow {
  campaignId: string;
  conversionActionId: string;
  conversionActionName: string | null;
  conversions: number;
  /** ACCOUNT CURRENCY UNITS, not micros. */
  conversionsValue: number;
  allConversions: number;
}

export function normalizeConversionActionMetric(row: any): ConversionActionRow | null {
  const campaignId = digits(row?.campaign?.id);
  const actionId = tail(row?.segments?.conversion_action);
  if (!campaignId || !actionId) return null;
  const m = row?.metrics ?? {};
  const name = String(row?.segments?.conversion_action_name ?? "").trim();
  return {
    campaignId, conversionActionId: actionId,
    conversionActionName: name ? name.slice(0, 200) : null,
    conversions: Math.max(0, finite(m.conversions)),
    conversionsValue: Math.max(0, finite(m.conversions_value ?? m.conversionsValue)),
    allConversions: Math.max(0, finite(m.all_conversions ?? m.allConversions)),
  };
}

/** A row where nothing counted is dropped: the platform lists an action a campaign had no conversions on only as zeros, which says nothing. */
export function buildConversionActionRows(raw: readonly any[]): ConversionActionRow[] {
  const by = new Map<string, ConversionActionRow>();
  for (const r of raw) {
    const n = normalizeConversionActionMetric(r);
    if (!n) continue;
    const k = `${n.campaignId}|${n.conversionActionId}`;
    const have = by.get(k);
    if (have) {
      have.conversions += n.conversions; have.conversionsValue += n.conversionsValue; have.allConversions += n.allConversions;
      have.conversionActionName = have.conversionActionName ?? n.conversionActionName;
    } else by.set(k, n);
  }
  return Array.from(by.values())
    .filter((r) => r.conversions > 0 || r.allConversions > 0 || r.conversionsValue > 0)
    .sort((a, b) => a.campaignId.localeCompare(b.campaignId) || a.conversionActionId.localeCompare(b.conversionActionId));
}

export const accountLine = (name: string, part: Part, rows: number, window: { start: string; end: string }): string =>
  `  ${name}: ${rows} ${part === "keywords" ? "keyword" : "campaign conversion action"} row${rows === 1 ? "" : "s"}, ${window.start} to ${window.end}`;

// ── Store ───────────────────────────────────────────────────────────────────
/** Idempotent. The dashboard's ensureSchema() makes the same tables (v277);
 *  keep the columns identical to server/db.ts. */
export async function ensureKeywordMetricTables(c: pg.Client): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS ads_keyword_metrics (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL, ad_group_id TEXT NOT NULL, criterion_id TEXT NOT NULL, entity_id TEXT NOT NULL,
      keyword_text TEXT, match_type TEXT, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
      impressions BIGINT NOT NULL DEFAULT 0, clicks BIGINT NOT NULL DEFAULT 0, cost_micros BIGINT NOT NULL DEFAULT 0,
      conversions DOUBLE PRECISION, synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_keyword_metrics_window ON ads_keyword_metrics (platform, account_id, ad_group_id, criterion_id, window_end);
    CREATE INDEX IF NOT EXISTS idx_ads_keyword_metrics_client ON ads_keyword_metrics (client_id, window_end);
    CREATE TABLE IF NOT EXISTS ads_campaign_conversion_actions (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL, conversion_action_id TEXT NOT NULL, conversion_action_name TEXT,
      conversions DOUBLE PRECISION NOT NULL DEFAULT 0, conversions_value DOUBLE PRECISION NOT NULL DEFAULT 0,
      all_conversions DOUBLE PRECISION NOT NULL DEFAULT 0, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_campaign_conv_actions_window ON ads_campaign_conversion_actions (platform, account_id, campaign_id, conversion_action_id, window_end);
    CREATE INDEX IF NOT EXISTS idx_ads_campaign_conv_actions_client ON ads_campaign_conversion_actions (client_id, window_end);
    CREATE TABLE IF NOT EXISTS ads_keyword_metric_scans (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      part TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
      last_scan_at TIMESTAMPTZ NOT NULL DEFAULT now(), ok BOOLEAN NOT NULL DEFAULT true,
      rows_read INTEGER NOT NULL DEFAULT 0, note TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_keyword_metric_scans_part ON ads_keyword_metric_scans (platform, account_id, part);`);
}

async function writeScan(
  c: pg.Client, clientId: string, accountId: string, part: Part, window: { start: string; end: string },
  ok: boolean, rows: number, note: string,
): Promise<void> {
  await c.query(
    `INSERT INTO ads_keyword_metric_scans (id, client_id, platform, account_id, part, window_start, window_end, last_scan_at, ok, rows_read, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8, $9, $10)
     ON CONFLICT (platform, account_id, part) DO UPDATE SET
       client_id = EXCLUDED.client_id, window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
       last_scan_at = now(), ok = EXCLUDED.ok, rows_read = EXCLUDED.rows_read, note = EXCLUDED.note`,
    [randomUUID(), clientId, PLATFORM, accountId, part, window.start, window.end, ok, rows, note.slice(0, 400)],
  );
}

/** Replace this window's keyword rows and move the scan, in one transaction. */
export async function storeKeywordMetrics(
  c: pg.Client, clientId: string, accountId: string, rows: readonly KeywordMetricRow[], window: { start: string; end: string },
): Promise<void> {
  await c.query("BEGIN");
  try {
    await c.query(`DELETE FROM ads_keyword_metrics WHERE platform = $1 AND account_id = $2 AND window_end = $3`, [PLATFORM, accountId, window.end]);
    for (const r of rows) {
      await c.query(
        `INSERT INTO ads_keyword_metrics (id, client_id, platform, account_id, campaign_id, ad_group_id, criterion_id, entity_id, keyword_text, match_type, window_start, window_end, impressions, clicks, cost_micros, conversions, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())`,
        [randomUUID(), clientId, PLATFORM, accountId, r.campaignId, r.adGroupId, r.criterionId, r.entityId, r.keywordText, r.matchType, window.start, window.end, r.impressions, r.clicks, r.costMicros, r.conversions],
      );
    }
    await c.query(`DELETE FROM ads_keyword_metrics WHERE platform = $1 AND account_id = $2 AND window_end < $3`, [PLATFORM, accountId, addDays(window.end, -RETAIN_DAYS)]);
    await writeScan(c, clientId, accountId, "keywords", window, true, rows.length, `${rows.length} keywords, ${window.start} to ${window.end}`);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

export async function storeConversionActionMetrics(
  c: pg.Client, clientId: string, accountId: string, rows: readonly ConversionActionRow[], window: { start: string; end: string },
): Promise<void> {
  await c.query("BEGIN");
  try {
    await c.query(`DELETE FROM ads_campaign_conversion_actions WHERE platform = $1 AND account_id = $2 AND window_end = $3`, [PLATFORM, accountId, window.end]);
    for (const r of rows) {
      await c.query(
        `INSERT INTO ads_campaign_conversion_actions (id, client_id, platform, account_id, campaign_id, conversion_action_id, conversion_action_name, conversions, conversions_value, all_conversions, window_start, window_end, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())`,
        [randomUUID(), clientId, PLATFORM, accountId, r.campaignId, r.conversionActionId, r.conversionActionName, r.conversions, r.conversionsValue, r.allConversions, window.start, window.end],
      );
    }
    await c.query(`DELETE FROM ads_campaign_conversion_actions WHERE platform = $1 AND account_id = $2 AND window_end < $3`, [PLATFORM, accountId, addDays(window.end, -RETAIN_DAYS)]);
    await writeScan(c, clientId, accountId, "conversion_actions", window, true, rows.length, `${rows.length} campaign conversion actions, ${window.start} to ${window.end}`);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** A failed read: the scan row says so and the earlier rows stay as the last good run left them. */
export async function recordKeywordMetricFailure(
  c: pg.Client, clientId: string, accountId: string, part: Part, window: { start: string; end: string }, why: string,
): Promise<void> {
  await c.query(
    `INSERT INTO ads_keyword_metric_scans (id, client_id, platform, account_id, part, window_start, window_end, last_scan_at, ok, rows_read, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), false, 0, $8)
     ON CONFLICT (platform, account_id, part) DO UPDATE SET last_scan_at = now(), ok = false, note = EXCLUDED.note`,
    [randomUUID(), clientId, PLATFORM, accountId, part, window.start, window.end, `read failed: ${why}`.slice(0, 400)],
  );
}

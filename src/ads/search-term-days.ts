/**
 * Each search term's DAY: what people typed, which keyword it matched, and what
 * that day cost, as the platform reported it.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The findings audit reads search terms live and keeps only the worst few
 * inside a finding's evidence. Nothing held a term by day, so "a brand search is
 * spending in a campaign that is not the brand campaign" and "a search for
 * something the client does not sell is costing money" could not be answered
 * from our own records. The dashboard's term-leakage reading reads this table.
 * Nothing here changes a detection rule.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 *
 *  · READ-ONLY. One SELECT per account. Nothing is written to any ad platform.
 *  · A WINDOW, REPLACED WHOLE. Each run reads the 90 days ending yesterday (UTC)
 *    and replaces that account's rows inside that window, so a restated figure
 *    lands and a term that stopped spending leaves no stale row. Days older than
 *    `RETAIN_DAYS` are pruned.
 *  · MONEY IS MICROS, verbatim (`cost_micros`). `conversions_value` is in the
 *    ACCOUNT'S CURRENCY UNITS, not micros, exactly as the platform reports it.
 *  · A NULL IS UNANSWERED. Conversions and conversion value are null unless the
 *    account reported one somewhere in the window (`evidencedMetric`).
 *    `impression_share` is ALWAYS null: the search-terms report does not carry it
 *    and the column is kept so a later source can fill it without a migration.
 *  · THE PLATFORM WITHHOLDS LOW-VOLUME TERMS. The report lists the terms it is
 *    willing to show; the rest of a campaign's spend is in terms nobody sees. That
 *    is not captured here and nothing here pretends it is: the reader sets the
 *    campaign's own cost beside the listed terms' cost and says the difference.
 *  · A READ AT THE ROW CEILING WRITES NOTHING. A truncated list read as complete
 *    would make every missing term a term that did not spend.
 *  · A FAILURE IS A DATED ROW (`ads_search_term_scans.ok = false`) that keeps the
 *    earlier span, never silence.
 *  · A TERM IS WHAT A PERSON TYPED AND CAN CARRY A NAME. It is capped at 200
 *    characters and kept only for this account's own reading; the dashboard
 *    shows terms to staff and never to a client.
 *
 * Pure except the store functions at the foot, which take a client.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { evidencedMetric } from "../metric-evidence.js";
import { KEYWORD_MATCH_TYPE, snapshotEnum, type UnrecognisedEnum } from "./structure-snapshot.js";
import { addDays } from "./daily-metrics.js";

export const PLATFORM = "google_ads";
export const WINDOW_DAYS = 90;
export const RETAIN_DAYS = 120;
export const MAX_ROWS = 100_000;
export const TERM_MAX = 200;

export const NO_ACCOUNTS_NOTE = "no Google Ads account is mapped, so no search term was captured for any client";

export const SEARCH_TERM_DAYS_GAQL = `
  SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
         search_term_view.search_term, segments.date,
         segments.keyword.info.text, segments.keyword.info.match_type,
         metrics.impressions, metrics.clicks, metrics.cost_micros,
         metrics.conversions, metrics.conversions_value
    FROM search_term_view
   WHERE segments.date BETWEEN '{{start}}' AND '{{end}}'
     AND campaign.status != 'REMOVED'`;

/** The window to read: the days ending YESTERDAY (UTC). */
export function termWindow(today: string, days = WINDOW_DAYS): { start: string; end: string } {
  const n = Math.max(1, Math.min(days, 90));
  const end = addDays(today, -1);
  return { start: addDays(end, -(n - 1)), end };
}

const finite = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const digits = (v: unknown): string | null => { const s = String(v ?? "").trim(); return /^\d+$/.test(s) ? s : null; };
const day = (v: unknown): string | null => { const s = String(v ?? "").trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const clip = (v: unknown, n: number): string => String(v ?? "").trim().slice(0, n);

export interface SearchTermDayRow {
  campaignId: string;
  campaignName: string;
  adGroupId: string;
  adGroupName: string;
  term: string;
  matchedKeyword: string;
  matchType: string;
  date: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number | null;
  conversionsValue: number | null;
}

type Normal = Omit<SearchTermDayRow, "conversions" | "conversionsValue"> & { conversions: number; conversionsValue: number };

export function normalizeSearchTermDay(row: any, report?: UnrecognisedEnum[]): Normal | null {
  const campaignId = digits(row?.campaign?.id);
  const adGroupId = digits(row?.ad_group?.id);
  const date = day(row?.segments?.date);
  const term = clip(row?.search_term_view?.search_term, TERM_MAX).toLowerCase();
  if (!campaignId || !adGroupId || !date || !term) return null;
  const m = row?.metrics ?? {};
  const kw = clip(row?.segments?.keyword?.info?.text, TERM_MAX).toLowerCase();
  return {
    campaignId, campaignName: clip(row?.campaign?.name, 200), adGroupId, adGroupName: clip(row?.ad_group?.name, 200),
    term, matchedKeyword: kw,
    matchType: kw ? (snapshotEnum(KEYWORD_MATCH_TYPE, row?.segments?.keyword?.info?.match_type, "segments.keyword.info.match_type", report) ?? "") : "",
    date,
    impressions: Math.max(0, Math.round(finite(m.impressions))),
    clicks: Math.max(0, Math.round(finite(m.clicks))),
    costMicros: Math.max(0, Math.round(finite(m.cost_micros ?? m.costMicros))),
    conversions: Math.max(0, finite(m.conversions)),
    conversionsValue: Math.max(0, finite(m.conversions_value ?? m.conversionsValue)),
  };
}

export const rowKey = (r: { campaignId: string; adGroupId: string; term: string; matchedKeyword: string; matchType: string; date: string }): string =>
  [r.campaignId, r.adGroupId, r.term, r.matchedKeyword, r.matchType, r.date].join("|");

/** One row per (campaign, ad group, term, matched keyword, match type, day): the platform can return a key twice across segments, so repeats are summed.
 *  Conversions are nulled where nothing in the window shows they are counted. */
export function buildSearchTermRows(raw: readonly any[], report?: UnrecognisedEnum[]): SearchTermDayRow[] {
  const by = new Map<string, Normal>();
  for (const r of raw) {
    const n = normalizeSearchTermDay(r, report);
    if (!n) continue;
    const k = rowKey(n);
    const have = by.get(k);
    if (have) {
      have.impressions += n.impressions; have.clicks += n.clicks; have.costMicros += n.costMicros;
      have.conversions += n.conversions; have.conversionsValue += n.conversionsValue;
    } else by.set(k, n);
  }
  const all = Array.from(by.values());
  const convs = all.map((r) => r.conversions);
  const vals = all.map((r) => r.conversionsValue);
  return all
    .map((r) => ({ ...r, conversions: evidencedMetric(r.conversions, convs), conversionsValue: evidencedMetric(r.conversionsValue, vals) }))
    .sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
}

export const accountLine = (name: string, rows: number, window: { start: string; end: string }): string =>
  `  ${name}: ${rows} search term day row${rows === 1 ? "" : "s"}, ${window.start} to ${window.end}`;

// ── Store ───────────────────────────────────────────────────────────────────
/** Idempotent. The dashboard's ensureSchema() makes the same tables (v280); keep the columns identical to server/db.ts. */
export async function ensureSearchTermTables(c: pg.Client): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS ads_search_term_days (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL DEFAULT '', ad_group_id TEXT NOT NULL, ad_group_name TEXT NOT NULL DEFAULT '',
      term TEXT NOT NULL, matched_keyword TEXT NOT NULL DEFAULT '', match_type TEXT NOT NULL DEFAULT '', day TEXT NOT NULL,
      impressions BIGINT NOT NULL DEFAULT 0, clicks BIGINT NOT NULL DEFAULT 0, cost_micros BIGINT NOT NULL DEFAULT 0,
      conversions DOUBLE PRECISION, conversions_value DOUBLE PRECISION, impression_share DOUBLE PRECISION,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_search_term_days_key ON ads_search_term_days (platform, account_id, campaign_id, ad_group_id, term, matched_keyword, match_type, day);
    CREATE INDEX IF NOT EXISTS idx_ads_search_term_days_client ON ads_search_term_days (client_id, day);
    CREATE TABLE IF NOT EXISTS ads_search_term_scans (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      covered_from TEXT, covered_to TEXT, last_scan_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ok BOOLEAN NOT NULL DEFAULT true, rows_read INTEGER NOT NULL DEFAULT 0, note TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_search_term_scans_account ON ads_search_term_scans (platform, account_id);`);
}

/** Replace the window's rows and move the scan, in one transaction. */
export async function storeSearchTermDays(
  c: pg.Client, clientId: string, accountId: string, rows: readonly SearchTermDayRow[], window: { start: string; end: string },
): Promise<void> {
  await c.query("BEGIN");
  try {
    await c.query(`DELETE FROM ads_search_term_days WHERE platform = $1 AND account_id = $2 AND day BETWEEN $3 AND $4`, [PLATFORM, accountId, window.start, window.end]);
    for (const r of rows) {
      await c.query(
        `INSERT INTO ads_search_term_days (id, client_id, platform, account_id, campaign_id, campaign_name, ad_group_id, ad_group_name, term, matched_keyword, match_type, day, impressions, clicks, cost_micros, conversions, conversions_value, impression_share, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NULL, now())`,
        [randomUUID(), clientId, PLATFORM, accountId, r.campaignId, r.campaignName, r.adGroupId, r.adGroupName, r.term, r.matchedKeyword, r.matchType, r.date, r.impressions, r.clicks, r.costMicros, r.conversions, r.conversionsValue],
      );
    }
    await c.query(`DELETE FROM ads_search_term_days WHERE platform = $1 AND account_id = $2 AND day < $3`, [PLATFORM, accountId, addDays(window.end, -RETAIN_DAYS)]);
    await c.query(
      `INSERT INTO ads_search_term_scans (id, client_id, platform, account_id, covered_from, covered_to, last_scan_at, ok, rows_read, note)
       VALUES ($1,$2,$3,$4,$5,$6, now(), true, $7, $8)
       ON CONFLICT (platform, account_id) DO UPDATE SET
         client_id = EXCLUDED.client_id, covered_from = EXCLUDED.covered_from, covered_to = EXCLUDED.covered_to,
         last_scan_at = now(), ok = true, rows_read = EXCLUDED.rows_read, note = EXCLUDED.note`,
      [randomUUID(), clientId, PLATFORM, accountId, window.start, window.end, rows.length, `${rows.length} search term day rows, ${window.start} to ${window.end}`],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** A failed read: the scan row says so and the earlier rows and span stay as the last good run left them. */
export async function recordSearchTermFailure(c: pg.Client, clientId: string, accountId: string, why: string): Promise<void> {
  await c.query(
    `INSERT INTO ads_search_term_scans (id, client_id, platform, account_id, covered_from, covered_to, last_scan_at, ok, rows_read, note)
     VALUES ($1,$2,$3,$4,NULL,NULL, now(), false, 0, $5)
     ON CONFLICT (platform, account_id) DO UPDATE SET last_scan_at = now(), ok = false, note = EXCLUDED.note`,
    [randomUUID(), clientId, PLATFORM, accountId, `read failed: ${why}`.slice(0, 400)],
  );
}

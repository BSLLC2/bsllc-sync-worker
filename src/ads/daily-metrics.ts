/**
 * Each campaign's DAY: impressions, clicks, cost and conversions, as the
 * platform reported them, kept so a change can be read before and after it.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Postgres held ads figures only as monthly totals (`ads.impressions` and its
 * siblings in metric_snapshots) and, for conversions and cost alone, a before
 * and after pulled live from the API per change episode (`ads_change_outcomes`).
 * Nothing held a campaign's day. So "impressions fell by more than half on two
 * weekdays after the budget moved" and "conversions are lower than the clicks
 * explain" could not be answered from our own records, and could not be
 * answered at all once the platform's reporting window had moved on.
 * The dashboard's before and after reading and its conversion explanation read
 * this table.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 *
 *  · READ-ONLY. One SELECT per account. Nothing is written to any ad platform.
 *  · MONEY IS MICROS, verbatim. `cost_micros` is one millionth of the account's
 *    currency, exactly as `ads.cost_micros` is; the dashboard converts it once.
 *  · A NULL IS UNANSWERED. The platform answers 0 conversions both for "nobody
 *    converted" and for "no conversion action is counting". A nought is planted
 *    only where the account reported a conversion SOMEWHERE in the window this
 *    run pulled (`evidencedMetric`, the rule analytics already follows); else
 *    the day carries null. The next run re-plants the earlier days the first time
 *    a conversion appears, because the window is re-read every run.
 *  · A DAY WITH NO ROW IS A DAY THE CAMPAIGN SERVED NOTHING, and only inside the
 *    span `ads_daily_scans` says was read. The platform returns no row for a
 *    campaign-day with no activity, so absence is a nought here, but only where
 *    somebody looked. `covered_from` restarts when a gap is left.
 *  · A READ AT THE ROW CEILING WRITES NOTHING. A truncated list read as
 *    complete would make every missing day a nought.
 *  · A FAILED READ WRITES A FAILURE, NOT SILENCE: the scan row says ok = false
 *    and keeps its coverage where it was.
 *  · THE NEWEST DAY IS NOT TRUSTED HERE and is not read by the dashboard: the
 *    window ends yesterday (UTC), and the last `RESTATE_DAYS` are re-read every
 *    run because conversions are attributed late.
 *
 * Pure except the two store functions at the foot, which take a client.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { evidencedMetric } from "../metric-evidence.js";

export const PLATFORM = "google_ads";

/** First run: about two months, so the four-week baseline of a change a month
 *  old is already there. */
export const BACKFILL_DAYS = 60;
/** Every later run re-reads this many days, which also restates late conversions. */
export const RESTATE_DAYS = 14;
/** More rows than this is a read we cannot call complete, so nothing is written. */
export const MAX_DAILY_ROWS = 50_000;

export const DAILY_GAQL = `
  SELECT campaign.id, campaign.name, segments.date,
         metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM campaign
   WHERE segments.date BETWEEN '{{start}}' AND '{{end}}'
     AND campaign.status != 'REMOVED'`;

export const NO_ACCOUNTS_NOTE = "no Google Ads account is mapped, so no campaign day was captured for any client";

export interface DailyRow {
  campaignId: string;
  campaignName: string | null;
  /** YYYY-MM-DD, account-local, as the platform segments it. */
  date: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  /** Null = unanswered (see the rules). */
  conversions: number | null;
}

const DAY = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export function addDays(date: string, n: number): string {
  return ymd(Date.parse(`${date}T00:00:00Z`) + n * DAY);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

/** The window to read. `today` is the UTC day the run starts; the window ends YESTERDAY. */
export function readWindow(today: string, firstRun: boolean, days?: number): { start: string; end: string } {
  const n = Math.max(1, Math.min(days ?? (firstRun ? BACKFILL_DAYS : RESTATE_DAYS), 400));
  const end = addDays(today, -1);
  return { start: addDays(end, -(n - 1)), end };
}

const finite = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** One API row into one stored row, or null for a row with no campaign or date. */
export function normalizeDaily(row: any): { campaignId: string; campaignName: string | null; date: string; impressions: number; clicks: number; costMicros: number; conversions: number } | null {
  const id = String(row?.campaign?.id ?? "").trim();
  const date = String(row?.segments?.date ?? "").trim();
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const m = row?.metrics ?? {};
  const name = String(row?.campaign?.name ?? "").trim();
  return {
    campaignId: id, campaignName: name || null, date,
    impressions: Math.max(0, Math.round(finite(m.impressions))),
    clicks: Math.max(0, Math.round(finite(m.clicks))),
    costMicros: Math.max(0, Math.round(finite(m.cost_micros ?? m.costMicros))),
    conversions: Math.max(0, finite(m.conversions)),
  };
}

/**
 * The rows to store, with conversions nulled where the account gave no evidence
 * it counts them anywhere in the window. A repeated campaign-day (the API can
 * return one per segment) is summed.
 */
export function buildDailyRows(raw: readonly any[]): DailyRow[] {
  const byKey = new Map<string, ReturnType<typeof normalizeDaily> & object>();
  for (const r of raw) {
    const n = normalizeDaily(r);
    if (!n) continue;
    const k = `${n.campaignId}|${n.date}`;
    const have = byKey.get(k);
    if (have) {
      have.impressions += n.impressions; have.clicks += n.clicks;
      have.costMicros += n.costMicros; have.conversions += n.conversions;
    } else byKey.set(k, n);
  }
  const all = Array.from(byKey.values());
  const window = all.map((r) => r.conversions);
  return all.map((r) => ({ ...r, conversions: evidencedMetric(r.conversions, window) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.campaignId.localeCompare(b.campaignId));
}

/** A scan row whose span is empty is a first-ever failure: it dates the failure and covers nothing. */
export function hasSpan(prev: { coveredFrom: string; coveredTo: string } | null): prev is { coveredFrom: string; coveredTo: string } {
  return prev != null && prev.coveredFrom <= prev.coveredTo;
}

/** Where coverage starts after a run. A gap since the last good run restarts it. */
export function coverageAfter(prev: { coveredFrom: string; coveredTo: string } | null, window: { start: string; end: string }): { coveredFrom: string; restarted: boolean } {
  if (!hasSpan(prev)) return { coveredFrom: window.start, restarted: false };
  // Continuous when this window starts no later than the day after the last covered day.
  const continuous = daysBetween(prev.coveredTo, window.start) <= 1;
  const from = continuous && prev.coveredFrom < window.start ? prev.coveredFrom : window.start;
  return { coveredFrom: from, restarted: !continuous };
}

export const accountLine = (name: string, rows: number, campaigns: number, window: { start: string; end: string }, note = ""): string =>
  `  ${name}: ${rows} campaign-day${rows === 1 ? "" : "s"} across ${campaigns} campaign${campaigns === 1 ? "" : "s"}, ${window.start} to ${window.end}${note ? ` (${note})` : ""}`;

// ── Store ───────────────────────────────────────────────────────────────────
/** The two tables, idempotent. The dashboard's ensureSchema() makes the same
 *  ones; this lets the job run before that deploy lands, as the other ads
 *  stores do. Keep the columns identical to server/db.ts. */
export async function ensureDailyTables(c: pg.Client): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS ads_daily_metrics (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL, campaign_name TEXT, metric_date TEXT NOT NULL,
      impressions BIGINT NOT NULL DEFAULT 0, clicks BIGINT NOT NULL DEFAULT 0, cost_micros BIGINT NOT NULL DEFAULT 0,
      conversions DOUBLE PRECISION, synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_daily_metrics_day ON ads_daily_metrics (platform, account_id, campaign_id, metric_date);
    CREATE INDEX IF NOT EXISTS idx_ads_daily_metrics_client ON ads_daily_metrics (client_id, metric_date);
    CREATE TABLE IF NOT EXISTS ads_daily_scans (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      covered_from TEXT NOT NULL, covered_to TEXT NOT NULL, last_scan_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ok BOOLEAN NOT NULL DEFAULT true, rows_read INTEGER NOT NULL DEFAULT 0, note TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_daily_scans_account ON ads_daily_scans (platform, account_id);`);
}

export async function loadCoverage(c: pg.Client, accountId: string): Promise<{ coveredFrom: string; coveredTo: string } | null> {
  const { rows } = await c.query<{ covered_from: string; covered_to: string }>(
    `SELECT covered_from, covered_to FROM ads_daily_scans WHERE platform = $1 AND account_id = $2`,
    [PLATFORM, accountId],
  );
  return rows[0] ? { coveredFrom: rows[0].covered_from, coveredTo: rows[0].covered_to } : null;
}

/** Write the rows and move the coverage, in one transaction. */
export async function storeDaily(
  c: pg.Client, clientId: string, accountId: string, rows: readonly DailyRow[], window: { start: string; end: string }, note: string,
): Promise<{ coveredFrom: string; restarted: boolean }> {
  await c.query("BEGIN");
  try {
    for (const r of rows) {
      await c.query(
        `INSERT INTO ads_daily_metrics (id, client_id, platform, account_id, campaign_id, campaign_name, metric_date, impressions, clicks, cost_micros, conversions, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         ON CONFLICT (platform, account_id, campaign_id, metric_date) DO UPDATE SET
           client_id = EXCLUDED.client_id, campaign_name = EXCLUDED.campaign_name,
           impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, cost_micros = EXCLUDED.cost_micros,
           conversions = EXCLUDED.conversions, synced_at = now()`,
        [randomUUID(), clientId, PLATFORM, accountId, r.campaignId, r.campaignName, r.date, r.impressions, r.clicks, r.costMicros, r.conversions],
      );
    }
    const prev = await loadCoverage(c, accountId);
    const cov = coverageAfter(prev, window);
    await c.query(
      `INSERT INTO ads_daily_scans (id, client_id, platform, account_id, covered_from, covered_to, last_scan_at, ok, rows_read, note)
       VALUES ($1,$2,$3,$4,$5,$6, now(), true, $7, $8)
       ON CONFLICT (platform, account_id) DO UPDATE SET
         client_id = EXCLUDED.client_id, covered_from = EXCLUDED.covered_from, covered_to = EXCLUDED.covered_to,
         last_scan_at = now(), ok = true, rows_read = EXCLUDED.rows_read, note = EXCLUDED.note`,
      [randomUUID(), clientId, PLATFORM, accountId, cov.coveredFrom, window.end, rows.length, note.slice(0, 400)],
    );
    await c.query("COMMIT");
    return cov;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** A read that failed. The coverage stays where the last good run left it; a
 *  first-ever failure writes a row whose span is empty, so the failure is dated. */
export async function recordDailyFailure(
  c: pg.Client, clientId: string, accountId: string, today: string, why: string,
): Promise<void> {
  await c.query(
    `INSERT INTO ads_daily_scans (id, client_id, platform, account_id, covered_from, covered_to, last_scan_at, ok, rows_read, note)
     VALUES ($1,$2,$3,$4,$5,$6, now(), false, 0, $7)
     ON CONFLICT (platform, account_id) DO UPDATE SET last_scan_at = now(), ok = false, note = EXCLUDED.note`,
    [randomUUID(), clientId, PLATFORM, accountId, today, addDays(today, -1), `read failed: ${why}`.slice(0, 400)],
  );
}

/**
 * Which campaign a click came from, for the clicks that became a lead we hold.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * A lead's form carries the id of the ad click it came from (`web_inquiries.gclid`). The platform's own click record says which
 * campaign, ad group and keyword that click was. Nothing joined the two, so a closed sale could not be followed back to a
 * campaign. This writes `click id -> campaign` and the dashboard reads it (shared/click-attribution.ts). Nothing here changes a
 * detection rule and nothing is sent anywhere.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 *
 *  · READ-ONLY. One SELECT per account per day. Nothing is written to any ad platform.
 *  · KEEP ONLY A CLICK THAT BECAME A LEAD. The click record is every click the account received. A click is kept only when its
 *    click id is already on one of THIS client's enquiries, so the table holds no click that did not become a lead. No name,
 *    phone, email, search text or page is read into it: the query does not ask for them.
 *  · ONE DAY AT A TIME. The platform serves the click record for a single date per query, so each day is its own SELECT.
 *  · COVERAGE IS A RECORD. `ads_click_scans` says how far the account was read in full. A lead older than `covered_from` was never
 *    in the window, a lead inside it with no row was read and not found: different facts, so the dashboard names them apart.
 *  · A DAY AT THE ROW CEILING WRITES NOTHING for the run. A truncated day read as complete would turn missing clicks into
 *    clicks that never happened.
 *  · A FAILED READ WRITES A FAILURE, NOT SILENCE: the scan says ok = false and keeps its span.
 *  · The platform keeps a click about 90 days, so the first run reads 90 days and every later run re-reads the last
 *    `RESTATE_DAYS`, which catches a lead that arrived a few days after its click.
 *
 * Pure except the store functions at the foot, which take a client.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { addDays, coverageAfter, hasSpan } from "./daily-metrics.js";

export const PLATFORM = "google_ads";
export const BACKFILL_DAYS = 90;
export const RESTATE_DAYS = 14;
export const MAX_DAY_ROWS = 50_000;
/** Kept this long, then pruned: a click older than the platform keeps it can never be re-read. */
export const RETAIN_DAYS = 120;
export const NO_ACCOUNTS_NOTE = "no Google Ads account is mapped, so no click was placed on a campaign for any client";

/** `click_view` only serves one date per query, and returns the click id with the campaign, ad group and keyword it came through. */
export const CLICK_GAQL = `
  SELECT click_view.gclid, click_view.keyword, campaign.id, ad_group.id, segments.date
    FROM click_view
   WHERE segments.date = '{{day}}'`;

export interface ClickRow { gclid: string; campaignId: string; adGroupId: string | null; criterionId: string | null; date: string }

/** `customers/1/adGroupCriteria/222~333` -> `333`. */
export function criterionOf(resource: unknown): string | null {
  const m = /~(\d+)$/.exec(String(resource ?? ""));
  return m ? m[1]! : null;
}

export function normalizeClick(row: any): ClickRow | null {
  const gclid = String(row?.click_view?.gclid ?? "").trim();
  const campaignId = String(row?.campaign?.id ?? "").trim();
  const date = String(row?.segments?.date ?? "").trim();
  if (!gclid || !campaignId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ag = String(row?.ad_group?.id ?? row?.adGroup?.id ?? "").trim();
  return { gclid, campaignId, adGroupId: ag || null, criterionId: criterionOf(row?.click_view?.keyword), date };
}

/** The clicks to keep: only those whose click id is on one of this client's enquiries, one per click id (the earliest day). */
export function keepKnown(raw: readonly any[], known: ReadonlySet<string>): ClickRow[] {
  const byId = new Map<string, ClickRow>();
  for (const r of raw) {
    const n = normalizeClick(r);
    if (!n || !known.has(n.gclid)) continue;
    const have = byId.get(n.gclid);
    if (!have || n.date < have.date) byId.set(n.gclid, n);
  }
  return Array.from(byId.values()).sort((a, b) => a.date.localeCompare(b.date) || a.gclid.localeCompare(b.gclid));
}

/** The days to read. `today` is the UTC day the run starts; the window ends YESTERDAY. */
export function readDays(today: string, firstRun: boolean, days?: number): string[] {
  const n = Math.max(1, Math.min(days ?? (firstRun ? BACKFILL_DAYS : RESTATE_DAYS), BACKFILL_DAYS));
  const end = addDays(today, -1);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(end, -i));
  return out;
}

export const accountLine = (name: string, days: number, kept: number, known: number, note = ""): string =>
  `  ${name}: ${days} day${days === 1 ? "" : "s"} read, ${kept} of ${known} known click id${known === 1 ? "" : "s"} placed on a campaign${note ? ` (${note})` : ""}`;

// ── Store ───────────────────────────────────────────────────────────────────
/** The two tables, idempotent. Keep the columns identical to server/db.ts (v288). */
export async function ensureClickTables(c: pg.Client): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS ads_click_map (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      gclid TEXT NOT NULL, click_date TEXT NOT NULL, campaign_id TEXT NOT NULL, ad_group_id TEXT, criterion_id TEXT,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_click_map_click ON ads_click_map (platform, account_id, gclid);
    CREATE INDEX IF NOT EXISTS idx_ads_click_map_client ON ads_click_map (client_id, click_date);
    CREATE TABLE IF NOT EXISTS ads_click_scans (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
      covered_from TEXT NOT NULL, covered_to TEXT NOT NULL, last_scan_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ok BOOLEAN NOT NULL DEFAULT true, days_read INTEGER NOT NULL DEFAULT 0, clicks_kept INTEGER NOT NULL DEFAULT 0, note TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_click_scans_account ON ads_click_scans (platform, account_id);`);
}

/** The click ids already on this client's enquiries, recent enough that the platform may still hold the click. */
export async function loadKnownClickIds(c: pg.Client, clientSlug: string, today: string): Promise<Set<string>> {
  const { rows } = await c.query<{ gclid: string }>(
    `SELECT DISTINCT btrim(gclid) AS gclid FROM web_inquiries
      WHERE client_slug = $1 AND gclid IS NOT NULL AND btrim(gclid) <> '' AND submitted_at >= $2::date`,
    [clientSlug, addDays(today, -(RETAIN_DAYS + 1))],
  );
  return new Set(rows.map((r) => r.gclid));
}

export async function loadClickCoverage(c: pg.Client, accountId: string): Promise<{ coveredFrom: string; coveredTo: string } | null> {
  const { rows } = await c.query<{ covered_from: string; covered_to: string }>(
    `SELECT covered_from, covered_to FROM ads_click_scans WHERE platform = $1 AND account_id = $2`, [PLATFORM, accountId]);
  return rows[0] ? { coveredFrom: rows[0].covered_from, coveredTo: rows[0].covered_to } : null;
}

/** Write the kept clicks and move the coverage, in one transaction. */
export async function storeClicks(
  c: pg.Client, clientId: string, accountId: string, rows: readonly ClickRow[], window: { start: string; end: string }, daysRead: number, note: string,
): Promise<{ coveredFrom: string; restarted: boolean }> {
  await c.query("BEGIN");
  try {
    for (const r of rows) {
      await c.query(
        `INSERT INTO ads_click_map (id, client_id, platform, account_id, gclid, click_date, campaign_id, ad_group_id, criterion_id, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (platform, account_id, gclid) DO UPDATE SET
           client_id = EXCLUDED.client_id, click_date = EXCLUDED.click_date, campaign_id = EXCLUDED.campaign_id,
           ad_group_id = EXCLUDED.ad_group_id, criterion_id = EXCLUDED.criterion_id, synced_at = now()`,
        [randomUUID(), clientId, PLATFORM, accountId, r.gclid, r.date, r.campaignId, r.adGroupId, r.criterionId],
      );
    }
    const prev = await loadClickCoverage(c, accountId);
    const cov = coverageAfter(prev, window);
    await c.query(
      `INSERT INTO ads_click_scans (id, client_id, platform, account_id, covered_from, covered_to, last_scan_at, ok, days_read, clicks_kept, note)
       VALUES ($1,$2,$3,$4,$5,$6, now(), true, $7, $8, $9)
       ON CONFLICT (platform, account_id) DO UPDATE SET
         client_id = EXCLUDED.client_id, covered_from = EXCLUDED.covered_from, covered_to = EXCLUDED.covered_to,
         last_scan_at = now(), ok = true, days_read = EXCLUDED.days_read, clicks_kept = EXCLUDED.clicks_kept, note = EXCLUDED.note`,
      [randomUUID(), clientId, PLATFORM, accountId, cov.coveredFrom, window.end, daysRead, rows.length, note.slice(0, 400)],
    );
    await c.query(`DELETE FROM ads_click_map WHERE platform = $1 AND account_id = $2 AND click_date < $3`, [PLATFORM, accountId, addDays(window.end, -RETAIN_DAYS)]);
    await c.query("COMMIT");
    return cov;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** A read that failed. The coverage stays where the last good run left it; a first-ever failure writes an empty span, so the failure is dated. */
export async function recordClickFailure(c: pg.Client, clientId: string, accountId: string, today: string, why: string): Promise<void> {
  await c.query(
    `INSERT INTO ads_click_scans (id, client_id, platform, account_id, covered_from, covered_to, last_scan_at, ok, days_read, clicks_kept, note)
     VALUES ($1,$2,$3,$4,$5,$6, now(), false, 0, 0, $7)
     ON CONFLICT (platform, account_id) DO UPDATE SET last_scan_at = now(), ok = false, note = EXCLUDED.note`,
    [randomUUID(), clientId, PLATFORM, accountId, today, addDays(today, -1), `read failed: ${why}`.slice(0, 400)],
  );
}

export { hasSpan };

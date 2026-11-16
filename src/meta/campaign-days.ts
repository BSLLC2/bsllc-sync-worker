/**
 * Each Meta campaign, ad set and ad, one day at a time, as the platform reported it.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `src/import-meta.ts` plants one MONTHLY, ACCOUNT-LEVEL total per client
 * (`meta.cost_micros` and its siblings in metric_snapshots). That answers what the
 * channel cost and returned in total and nothing below it: which campaign, which ad
 * set and which ad is spending, and what each one brought. This reads the level below
 * the account, one row per entity per day, into two tables the dashboard app declares
 * (`meta_insight_days`, `meta_insight_scans`). The monthly importer is untouched and
 * every figure it writes still comes from its own call.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 *
 *  · READ-ONLY. One GET per page of insights. Nothing is written to Meta.
 *  · THE UNIT RULES ARE `meta/insights.ts`'s AND ARE NOT RESTATED HERE. Spend is a
 *    decimal string in the account's currency and becomes MICROS once (`metaSpendToMicros`).
 *    Clicks are LINK clicks, with Clicks (All) as a named fallback (`metaLinkClicks`):
 *    the fallback is stored as `used_all_clicks` on the row. A lead is counted once
 *    through the declared action families (`countMetaConversions`). Meta's own `ctr` is
 *    a percentage and is not stored at all; a reader derives it from the clicks and
 *    impressions stored here.
 *  · A NULL IS UNANSWERED, NEVER A NOUGHT. A figure Meta did not return is null.
 *    Leads take the same evidence rule the monthly importer uses (`evidencedMetric`):
 *    a nought is stored only where the account reported a lead SOMEWHERE in the pull for
 *    that level, because Meta answers 0 both for "nobody converted" and for "no event is
 *    configured" and never says which.
 *  · REACH AND FREQUENCY ARE PER DAY AND ARE NOT ADDITIVE. A person reached on Monday and
 *    again on Tuesday is one person, so seven days of reach added up is not a week's reach.
 *    They are stored for the day Meta reported them and no reading here or in the app sums
 *    them; a week's reach would need its own call with a seven day range.
 *  · A DAY WITH NO ROW IS A DAY THE ENTITY DID NOT DELIVER, and only inside the span
 *    `meta_insight_scans` says was read. Outside it nobody looked.
 *  · A READ AT THE ROW CEILING WRITES NOTHING. A truncated list read as complete would
 *    turn every missing day into a nought. One level failing never costs another.
 *  · A FAILED READ WRITES A FAILURE, NOT SILENCE: the scan row says ok = false and the
 *    covered span stays where the last good read left it.
 *  · THE WINDOW ENDS YESTERDAY (UTC). The first read is `BACKFILL_DAYS`; every later one
 *    re-reads `RESTATE_DAYS`, because attribution restates the newest days. The dashboard
 *    does not read the newest stored day as final.
 *
 * NONE OF THE REQUEST SHAPES BELOW HAS BEEN RUN AGAINST A LIVE ACCOUNT. They are written
 * from the Marketing API insights reference (`level`, `time_increment=1`, `time_range`,
 * `fields`, cursor paging). The first run is a dry run: read it before running live.
 *
 * Pure except the store functions at the foot, which take a client.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { evidencedMetric } from "../metric-evidence.js";
import { batchSql } from "../ga4-report/store.js";
import { addDays, coverageAfter, hasSpan, readWindow } from "../ads/daily-metrics.js";
import { countMetaConversions, metaLinkClicks, metaSpendToMicros, META_GRAPH } from "./insights.js";

export { addDays, hasSpan, readWindow };

export const PLATFORM = "meta";
/** The three levels below the account, and the ONLY ones read. */
export const META_LEVELS = ["campaign", "adset", "ad"] as const;
export type MetaLevel = (typeof META_LEVELS)[number];

export const BACKFILL_DAYS = 60;
export const RESTATE_DAYS = 14;
/** More rows than this for one level of one account is a read we cannot call complete. OURS. */
export const MAX_META_ROWS = 50_000;
/** Rows asked for in one page. */
export const PAGE_LIMIT = 500;
/** Pages followed before the read is called too big, whatever the ceiling says. */
export const MAX_PAGES = Math.ceil(MAX_META_ROWS / PAGE_LIMIT) + 5;
/** Rows are written this many to a statement. */
export const BATCH_ROWS = 500;

export const NO_ACCOUNTS_NOTE = "no Meta ad account is mapped, so no campaign day was captured for any client";

const COMMON_FIELDS = "spend,impressions,reach,frequency,clicks,inline_link_clicks,actions";
/** The fields asked for at each level: the ids and names that say what the row is, then the shared measures. */
export const META_DAY_FIELDS: Record<MetaLevel, string> = {
  campaign: `campaign_id,campaign_name,${COMMON_FIELDS}`,
  adset: `campaign_id,campaign_name,adset_id,adset_name,${COMMON_FIELDS}`,
  ad: `campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,${COMMON_FIELDS}`,
};

/** One insights row, in the shape this repository stores it. */
export interface MetaDayRow {
  level: MetaLevel;
  entityId: string;
  entityName: string | null;
  campaignId: string;
  adsetId: string | null;
  /** YYYY-MM-DD, account-local, as Meta segments it. */
  date: string;
  impressions: number | null;
  linkClicks: number | null;
  /** Clicks (All) stood in for link clicks on this row. */
  usedAllClicks: boolean;
  /** MICROS of the ad account's own currency. */
  spendMicros: number | null;
  /** Null = unanswered: the account reported no lead anywhere in the pull. */
  leads: number | null;
  /** Per day. NEVER summed across days. */
  reach: number | null;
  /** Per day. NEVER summed or averaged across days. */
  frequency: number | null;
}

const finite = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};
const whole = (n: number | null): number | null => (n == null ? null : Math.max(0, Math.round(n)));
const text = (v: unknown, max = 200): string | null => {
  const t = String(v ?? "").trim();
  return t ? t.slice(0, max) : null;
};

/** The url for one page of one level, with the token. NEVER log this. */
export function insightsUrl(act: string, level: MetaLevel, window: { start: string; end: string }, token: string, graph = META_GRAPH): string {
  const qs = new URLSearchParams({
    level,
    time_increment: "1",
    time_range: JSON.stringify({ since: window.start, until: window.end }),
    fields: META_DAY_FIELDS[level],
    limit: String(PAGE_LIMIT),
    access_token: token,
  });
  return `${graph}/${act}/insights?${qs}`;
}

/**
 * Raw insights rows into stored rows. A row with no id for its level or no real date is
 * refused (counted in `unplaced`), never stored under a guess. A repeated (entity, day) is
 * counted in `repeats` and the LAST one wins: reach cannot be added and the others were
 * never split by anything that would make two rows for one day mean two things.
 */
export function buildMetaDayRows(level: MetaLevel, raw: readonly Record<string, unknown>[]): { rows: MetaDayRow[]; unplaced: number; repeats: number } {
  const idKey = level === "campaign" ? "campaign_id" : level === "adset" ? "adset_id" : "ad_id";
  const nameKey = level === "campaign" ? "campaign_name" : level === "adset" ? "adset_name" : "ad_name";
  type Partial = Omit<MetaDayRow, "leads"> & { counted: number; basis: "objective_results" | "actions" | "none" };
  const byKey = new Map<string, Partial>();
  let unplaced = 0;
  let repeats = 0;
  for (const r of raw) {
    const entityId = text(r[idKey], 64);
    const date = text(r.date_start, 10);
    const campaignId = text(r.campaign_id, 64);
    if (!entityId || !campaignId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { unplaced++; continue; }
    const { clicks, usedAllClicks } = metaLinkClicks(r);
    const { conversions, basis } = countMetaConversions({ actions: r.actions });
    const row: Partial = {
      level, entityId, entityName: text(r[nameKey]), campaignId, adsetId: level === "campaign" ? null : text(r.adset_id, 64),
      date, impressions: whole(finite(r.impressions)), linkClicks: whole(clicks), usedAllClicks,
      spendMicros: metaSpendToMicros(r.spend), reach: whole(finite(r.reach)), frequency: finite(r.frequency),
      counted: basis === "none" ? 0 : conversions, basis,
    };
    const k = `${entityId}|${date}`;
    if (byKey.has(k)) repeats++;
    byKey.set(k, row);
  }
  const all = Array.from(byKey.values());
  // The evidence is this level's WHOLE pull for the account: whether the pixel reports leads at all is a fact about the account.
  const window = all.map((r) => r.counted);
  const rows: MetaDayRow[] = all
    .map(({ counted, basis: _basis, ...r }) => ({ ...r, leads: evidencedMetric(counted, window) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.entityId.localeCompare(b.entityId));
  return { rows, unplaced, repeats };
}

export interface Page { data?: unknown; paging?: { next?: string }; error?: { message?: string; code?: number } }
export type FetchJson = (url: string) => Promise<{ ok: boolean; status: number; body: Page }>;

export interface LevelRead { rows: Record<string, unknown>[]; tooBig: boolean; pages: number }

/**
 * Every row of one level, following `paging.next`. Past `MAX_META_ROWS` the read is flagged
 * too big and the rows are DROPPED by the caller, never stored as a short list. An error body
 * names the platform's message and nothing else: the url (which carries the token) is never in it.
 */
export async function readLevel(
  fetchJson: FetchJson, act: string, level: MetaLevel, window: { start: string; end: string }, token: string, graph = META_GRAPH,
): Promise<LevelRead> {
  let url: string | null = insightsUrl(act, level, window, token, graph);
  const rows: Record<string, unknown>[] = [];
  let pages = 0;
  while (url) {
    const resp = await fetchJson(url);
    pages++;
    if (!resp.ok) {
      const e = resp.body?.error;
      throw new Error(`Meta API ${resp.status}${e?.code ? ` (code ${e.code})` : ""}: ${String(e?.message ?? "no message").slice(0, 200)}`);
    }
    if (Array.isArray(resp.body.data)) rows.push(...(resp.body.data as Record<string, unknown>[]));
    if (rows.length >= MAX_META_ROWS || pages >= MAX_PAGES) return { rows: [], tooBig: Boolean(resp.body.paging?.next) || rows.length >= MAX_META_ROWS, pages };
    url = resp.body.paging?.next ?? null;
  }
  return { rows, tooBig: false, pages };
}

export const accountLine = (name: string, level: MetaLevel, rows: number, entities: number, window: { start: string; end: string }, note = ""): string =>
  `  ${name} · ${level}: ${rows} day-row${rows === 1 ? "" : "s"} across ${entities} ${level === "adset" ? "ad set" : level}${entities === 1 ? "" : "s"}, ${window.start} to ${window.end}${note ? ` (${note})` : ""}`;

// ── Store ───────────────────────────────────────────────────────────────────
/**
 * The two tables, idempotent. The dashboard's ensureSchema() makes the same ones; this lets the
 * job run before that deploy lands, as the other ads stores do. Keep the columns identical to server/db.ts.
 */
export async function ensureMetaDayTables(c: pg.Client): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS meta_insight_days (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, account_id TEXT NOT NULL, level TEXT NOT NULL,
      entity_id TEXT NOT NULL, entity_name TEXT, campaign_id TEXT NOT NULL, adset_id TEXT, metric_date TEXT NOT NULL,
      impressions BIGINT, link_clicks BIGINT, used_all_clicks BOOLEAN NOT NULL DEFAULT false, spend_micros BIGINT,
      leads DOUBLE PRECISION, reach BIGINT, frequency DOUBLE PRECISION, synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_insight_days_day ON meta_insight_days (account_id, level, entity_id, metric_date);
    CREATE INDEX IF NOT EXISTS idx_meta_insight_days_client ON meta_insight_days (client_id, metric_date);
    CREATE TABLE IF NOT EXISTS meta_insight_scans (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, account_id TEXT NOT NULL, level TEXT NOT NULL,
      covered_from TEXT NOT NULL, covered_to TEXT NOT NULL, last_scan_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ok BOOLEAN NOT NULL DEFAULT true, rows_read INTEGER NOT NULL DEFAULT 0, note TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_insight_scans_level ON meta_insight_scans (account_id, level);`);
}

export const INSERT_META_DAY = `INSERT INTO meta_insight_days
  (id, client_id, account_id, level, entity_id, entity_name, campaign_id, adset_id, metric_date, impressions, link_clicks,
   used_all_clicks, spend_micros, leads, reach, frequency, synced_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
 ON CONFLICT (account_id, level, entity_id, metric_date) DO UPDATE SET
   client_id = EXCLUDED.client_id, entity_name = EXCLUDED.entity_name, campaign_id = EXCLUDED.campaign_id,
   adset_id = EXCLUDED.adset_id, impressions = EXCLUDED.impressions, link_clicks = EXCLUDED.link_clicks,
   used_all_clicks = EXCLUDED.used_all_clicks, spend_micros = EXCLUDED.spend_micros, leads = EXCLUDED.leads,
   reach = EXCLUDED.reach, frequency = EXCLUDED.frequency, synced_at = EXCLUDED.synced_at`;

export const INSERT_META_SCAN = `INSERT INTO meta_insight_scans
  (id, client_id, account_id, level, covered_from, covered_to, last_scan_at, ok, rows_read, note)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
 ON CONFLICT (account_id, level) DO UPDATE SET
   client_id = EXCLUDED.client_id, covered_from = EXCLUDED.covered_from, covered_to = EXCLUDED.covered_to,
   last_scan_at = EXCLUDED.last_scan_at, ok = EXCLUDED.ok, rows_read = EXCLUDED.rows_read, note = EXCLUDED.note`;

export async function loadMetaCoverage(c: pg.Client, accountId: string, level: MetaLevel): Promise<{ coveredFrom: string; coveredTo: string } | null> {
  const { rows } = await c.query<{ covered_from: string; covered_to: string }>(
    `SELECT covered_from, covered_to FROM meta_insight_scans WHERE account_id = $1 AND level = $2`, [accountId, level],
  );
  return rows[0] ? { coveredFrom: rows[0].covered_from, coveredTo: rows[0].covered_to } : null;
}

/** Write the rows and move the coverage, in one transaction. */
export async function storeMetaDays(
  c: pg.Client, clientId: string, accountId: string, level: MetaLevel, rows: readonly MetaDayRow[],
  window: { start: string; end: string }, note: string, now: Date = new Date(),
): Promise<{ coveredFrom: string; restarted: boolean }> {
  await c.query("BEGIN");
  try {
    for (let i = 0; i < rows.length; i += BATCH_ROWS) {
      const chunk = rows.slice(i, i + BATCH_ROWS);
      const params = chunk.flatMap((r) => [
        randomUUID(), clientId, accountId, level, r.entityId, r.entityName, r.campaignId, r.adsetId, r.date, r.impressions, r.linkClicks,
        r.usedAllClicks, r.spendMicros, r.leads, r.reach, r.frequency, now,
      ]);
      await c.query(batchSql(INSERT_META_DAY, chunk.length), params);
    }
    const prev = await loadMetaCoverage(c, accountId, level);
    const cov = coverageAfter(prev, window);
    await c.query(INSERT_META_SCAN, [randomUUID(), clientId, accountId, level, cov.coveredFrom, window.end, now, true, rows.length, note.slice(0, 400)]);
    await c.query("COMMIT");
    return cov;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** A read that failed. The coverage stays where the last good run left it; a first-ever failure writes an empty span, so the failure is dated. */
export async function recordMetaFailure(
  c: pg.Client, clientId: string, accountId: string, level: MetaLevel, today: string, why: string, now: Date = new Date(),
): Promise<void> {
  await c.query(
    `INSERT INTO meta_insight_scans (id, client_id, account_id, level, covered_from, covered_to, last_scan_at, ok, rows_read, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,false,0,$8)
     ON CONFLICT (account_id, level) DO UPDATE SET last_scan_at = EXCLUDED.last_scan_at, ok = false, note = EXCLUDED.note`,
    [randomUUID(), clientId, accountId, level, today, addDays(today, -1), now, `read failed: ${why}`.slice(0, 400)],
  );
}

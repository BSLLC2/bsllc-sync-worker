/**
 * The only writes the Business Profile reader makes: daily counts in `gbp_daily`,
 * search-term counts in `gbp_keywords` (both schema v257) and a status in
 * `signal_runs`. Column lists are LITERAL so the app's `npm run verify:wiring` can
 * read them against shared/schema.ts in both directions.
 *
 * COUNTS ONLY. A row is a place (a location id), a day or a month, a metric or a
 * search term, and a number. There is no column for a reviewer, a review, a photo or a
 * person, and `verify:security` in the dashboard fails the day one appears.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../page-behaviour/store.js";
import type { GbpDayRow, GbpKeywordRow } from "./types.js";

const id = (...parts: Array<string | number>): string => createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 40);

export const UPSERT_DAILY = `INSERT INTO gbp_daily (id, client_id, location_id, day, metric, value, read_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7)
 ON CONFLICT (client_id, location_id, day, metric) DO UPDATE SET value = EXCLUDED.value, read_at = EXCLUDED.read_at`;

export const UPSERT_KEYWORD = `INSERT INTO gbp_keywords (id, client_id, location_id, month, keyword, impressions, impressions_bound, read_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
 ON CONFLICT (client_id, location_id, month, keyword) DO UPDATE SET impressions = EXCLUDED.impressions, impressions_bound = EXCLUDED.impressions_bound, read_at = EXCLUDED.read_at`;

/** Housekeeping: a day older than $2 and a month older than $3 are dropped. */
export const PRUNE_DAILY = `DELETE FROM gbp_daily WHERE client_id = $1 AND day < $2`;
export const PRUNE_KEYWORDS = `DELETE FROM gbp_keywords WHERE client_id = $1 AND month < $2`;
/** Months of search terms already stored for a location, so an old month is read once. */
export const STORED_KEYWORD_MONTHS = `SELECT DISTINCT month FROM gbp_keywords WHERE client_id = $1 AND location_id = $2`;

export async function writeDaily(c: Queryable, clientId: string, locationId: string, rows: GbpDayRow[], at: Date): Promise<void> {
  for (const r of rows) await c.query(UPSERT_DAILY, [id("d", clientId, locationId, r.day, r.metric), clientId, locationId, r.day, r.metric, r.value, at]);
}
export async function writeKeywords(c: Queryable, clientId: string, locationId: string, rows: GbpKeywordRow[], at: Date): Promise<void> {
  for (const r of rows) await c.query(UPSERT_KEYWORD, [id("k", clientId, locationId, r.month, r.keyword), clientId, locationId, r.month, r.keyword, r.impressions, r.bound, at]);
}

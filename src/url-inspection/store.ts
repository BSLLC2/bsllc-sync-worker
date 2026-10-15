/**
 * The only writes the URL inspection reader makes: rows in `seo_url_inspection`
 * (schema v257) and a status in `signal_runs`. Column lists are LITERAL so the app's
 * `npm run verify:wiring` can read them against shared/schema.ts in both directions.
 *
 * Latest four rows per address are kept; older ones are deleted. A FAILED inspection
 * is a row too (state error, no facts), so the app can say it could not look.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../page-behaviour/store.js";
import type { InspectionRowOut } from "./types.js";

const id = (...parts: Array<string | number>): string => createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 40);

export const INSERT_INSPECTION = `INSERT INTO seo_url_inspection
  (id, client_id, url, page_path, site_url, picked_for, inspected_at, state, detail, verdict, coverage_state, indexing_state,
   google_canonical, user_canonical, last_crawl_at, page_fetch_state, robots_txt_state, mobile_verdict, rich_results_json)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
 ON CONFLICT (id) DO UPDATE SET
   state = EXCLUDED.state, detail = EXCLUDED.detail, verdict = EXCLUDED.verdict, coverage_state = EXCLUDED.coverage_state,
   indexing_state = EXCLUDED.indexing_state, google_canonical = EXCLUDED.google_canonical, user_canonical = EXCLUDED.user_canonical,
   last_crawl_at = EXCLUDED.last_crawl_at, page_fetch_state = EXCLUDED.page_fetch_state, robots_txt_state = EXCLUDED.robots_txt_state,
   mobile_verdict = EXCLUDED.mobile_verdict, rich_results_json = EXCLUDED.rich_results_json`;

/** Keep the four newest rows for one address. The number is a literal on purpose: a guard reads it. */
export const PRUNE_INSPECTION = `DELETE FROM seo_url_inspection
 WHERE client_id = $1 AND url = $2
   AND id NOT IN (SELECT id FROM seo_url_inspection WHERE client_id = $1 AND url = $2 ORDER BY inspected_at DESC LIMIT 4)`;

export const COUNT_TODAY = `SELECT count(*)::int AS n FROM seo_url_inspection WHERE client_id = $1 AND site_url = $2 AND inspected_at >= $3`;
export const LAST_OK = `SELECT page_path, max(inspected_at) AS at FROM seo_url_inspection WHERE client_id = $1 AND state = 'ok' GROUP BY page_path`;

export async function writeInspection(c: Queryable, clientId: string, r: InspectionRowOut): Promise<void> {
  await c.query(INSERT_INSPECTION, [
    id("i", clientId, r.url, r.inspectedAt.toISOString()), clientId, r.url, r.pagePath, r.siteUrl, r.pickedFor, r.inspectedAt, r.state, r.detail,
    r.verdict, r.coverageState, r.indexingState, r.googleCanonical, r.userCanonical, r.lastCrawlAt, r.pageFetchState, r.robotsTxtState, r.mobileVerdict, r.richResultsJson,
  ]);
  await c.query(PRUNE_INSPECTION, [clientId, r.url]);
}

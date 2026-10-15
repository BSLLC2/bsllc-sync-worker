/**
 * The only writes the Bing reader makes: query, page and site-level counts, crawl
 * issues, one small row per site, and a status in `signal_runs` (all schema v257).
 * Column lists are LITERAL so the dashboard's `npm run verify:wiring` can read them
 * against shared/schema.ts in both directions.
 *
 * COUNTS AND ADDRESSES OF THE CLIENT'S OWN PAGES. A row is a day, a search (or a page
 * or a crawl issue), and numbers. There is no column for a visitor, an IP, a person or
 * anything Bing could attach to one.
 *
 * Many rows go in per statement (unnest of arrays), because a year of queries one
 * round trip at a time is minutes of a runner's clock.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../page-behaviour/store.js";
import type { BingAiStatus, BingIssueRow, BingPageRow, BingQueryRow, BingSiteDayRow } from "./types.js";

const id = (...parts: Array<string | number>): string => createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 40);
export const BATCH = 500;

export const UPSERT_QUERY_DAYS = `INSERT INTO bing_query_days (id, client_id, site_url, day, query, clicks, impressions, avg_position, read_at)
 SELECT t.id, $1, $2, t.day, t.query, t.clicks, t.impressions, t.avg_position, $3
   FROM unnest($4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::float8[]) AS t(id, day, query, clicks, impressions, avg_position)
 ON CONFLICT (client_id, site_url, day, query) DO UPDATE SET clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, avg_position = EXCLUDED.avg_position, read_at = EXCLUDED.read_at`;

export const UPSERT_PAGE_DAYS = `INSERT INTO bing_page_days (id, client_id, site_url, day, page_url, clicks, impressions, avg_position, read_at)
 SELECT t.id, $1, $2, t.day, t.page_url, t.clicks, t.impressions, t.avg_position, $3
   FROM unnest($4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::float8[]) AS t(id, day, page_url, clicks, impressions, avg_position)
 ON CONFLICT (client_id, site_url, day, page_url) DO UPDATE SET clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, avg_position = EXCLUDED.avg_position, read_at = EXCLUDED.read_at`;

export const UPSERT_SITE_DAY = `INSERT INTO bing_site_days (id, client_id, site_url, day, clicks, impressions, crawled_pages, crawl_errors, in_index, in_links, blocked_robots, code_4xx, code_5xx, dns_failures, timeouts, read_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
 ON CONFLICT (client_id, site_url, day) DO UPDATE SET clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, crawled_pages = EXCLUDED.crawled_pages,
   crawl_errors = EXCLUDED.crawl_errors, in_index = EXCLUDED.in_index, in_links = EXCLUDED.in_links, blocked_robots = EXCLUDED.blocked_robots,
   code_4xx = EXCLUDED.code_4xx, code_5xx = EXCLUDED.code_5xx, dns_failures = EXCLUDED.dns_failures, timeouts = EXCLUDED.timeouts, read_at = EXCLUDED.read_at`;

/** The issues list is the CURRENT list: what Bing no longer reports is cleared, then the current ones go in. */
export const CLEAR_ISSUES = `DELETE FROM bing_crawl_issues WHERE client_id = $1 AND site_url = $2`;
export const INSERT_ISSUE = `INSERT INTO bing_crawl_issues (id, client_id, site_url, url, http_code, issue_flags, issue_text, in_links, read_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
 ON CONFLICT (client_id, site_url, url) DO UPDATE SET http_code = EXCLUDED.http_code, issue_flags = EXCLUDED.issue_flags, issue_text = EXCLUDED.issue_text, in_links = EXCLUDED.in_links, read_at = EXCLUDED.read_at`;

export const UPSERT_SITE = `INSERT INTO bing_sites (client_id, site_url, is_verified, ai_status, ai_checked_at, read_at)
 VALUES ($1, $2, $3, $4, $5, $6)
 ON CONFLICT (client_id, site_url) DO UPDATE SET is_verified = EXCLUDED.is_verified, ai_status = EXCLUDED.ai_status, ai_checked_at = EXCLUDED.ai_checked_at, read_at = EXCLUDED.read_at`;

/** Housekeeping: a day older than $2 is dropped. */
export const PRUNE_QUERY_DAYS = `DELETE FROM bing_query_days WHERE client_id = $1 AND day < $2`;
export const PRUNE_PAGE_DAYS = `DELETE FROM bing_page_days WHERE client_id = $1 AND day < $2`;
export const PRUNE_SITE_DAYS = `DELETE FROM bing_site_days WHERE client_id = $1 AND day < $2`;

export async function writeQueryDays(c: Queryable, clientId: string, siteUrl: string, rows: BingQueryRow[], at: Date): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const b = rows.slice(i, i + BATCH);
    await c.query(UPSERT_QUERY_DAYS, [clientId, siteUrl, at, b.map((r) => id("q", clientId, siteUrl, r.day, r.query)), b.map((r) => r.day), b.map((r) => r.query), b.map((r) => r.clicks), b.map((r) => r.impressions), b.map((r) => r.avgPosition)]);
  }
}
export async function writePageDays(c: Queryable, clientId: string, siteUrl: string, rows: BingPageRow[], at: Date): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const b = rows.slice(i, i + BATCH);
    await c.query(UPSERT_PAGE_DAYS, [clientId, siteUrl, at, b.map((r) => id("p", clientId, siteUrl, r.day, r.pageUrl)), b.map((r) => r.day), b.map((r) => r.pageUrl), b.map((r) => r.clicks), b.map((r) => r.impressions), b.map((r) => r.avgPosition)]);
  }
}
export async function writeSiteDays(c: Queryable, clientId: string, siteUrl: string, rows: BingSiteDayRow[], at: Date): Promise<void> {
  for (const r of rows) {
    await c.query(UPSERT_SITE_DAY, [id("s", clientId, siteUrl, r.day), clientId, siteUrl, r.day, r.clicks, r.impressions, r.crawledPages, r.crawlErrors, r.inIndex, r.inLinks, r.blockedRobots, r.code4xx, r.code5xx, r.dnsFailures, r.timeouts, at]);
  }
}
export async function writeIssues(c: Queryable, clientId: string, siteUrl: string, rows: BingIssueRow[], at: Date): Promise<void> {
  await c.query(CLEAR_ISSUES, [clientId, siteUrl]);
  for (const r of rows) await c.query(INSERT_ISSUE, [id("i", clientId, siteUrl, r.url), clientId, siteUrl, r.url, r.httpCode, r.issueFlags, r.issueText, r.inLinks, at]);
}
export async function writeSite(c: Queryable, clientId: string, siteUrl: string, verified: boolean | null, ai: BingAiStatus, at: Date): Promise<void> {
  await c.query(UPSERT_SITE, [clientId, siteUrl, verified, ai, at, at]);
}

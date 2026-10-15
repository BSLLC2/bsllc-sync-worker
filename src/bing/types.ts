/**
 * Bing Webmaster Tools: what is asked, what is kept, our own limits.
 *
 * NOTHING HERE HAS BEEN RUN AGAINST BING. No Bing Webmaster account or key exists yet.
 * The method names, the answer fields and the date format are written from the
 * Webmaster API reference as I know it; `docs/INTEGRATIONS-SETUP.md` in the dashboard
 * repository lists what is unverified, and the reader parses defensively and says so in
 * its status.
 */

export const BING_BASE = "https://ssl.bing.com/webmaster/api.svc/json";

/** The methods this reader calls. Names are the API's; the shape of each answer is parsed in api.ts. */
export const BING_METHODS = {
  sites: "GetUserSites",
  queries: "GetQueryStats",
  pages: "GetPageStats",
  traffic: "GetRankAndTrafficStats",
  crawl: "GetCrawlStats",
  issues: "GetCrawlIssues",
} as const;

/**
 * AI and Copilot citation data. NO METHOD FOR IT IS DOCUMENTED TO THIS BUILD, and the
 * brief is not to guess one. So the reader PROBES a single candidate by the
 * documented "method not found" answer: if Bing says the method does not exist the
 * feature is recorded as unavailable; if it answers, that is recorded as "answered, not
 * mapped" with the number of rows it gave, and NOTHING from the answer is stored. The
 * name below is a GUESS used only to ask the question; it is written here so a person
 * who learns the real name changes one line.
 */
export const AI_CITATION_PROBE_METHOD = "GetAICitations";

/** Days of query and page counts kept. Bing gives about six months. */
export const BING_KEEP_DAYS = 190;
/** Rows kept for one site: the busiest queries and pages, with every day of each. Ours. */
export const BING_QUERY_ROW_CAP = 20_000;
export const BING_PAGE_ROW_CAP = 8_000;
/** Crawl issues kept for one site (the exact addresses). */
export const BING_ISSUE_CAP = 400;
/** One call at a time, with a pause. Bing's limits are not published to this build. */
export const BING_PAUSE_MS = 500;
export const BING_STRING_MAX = 500;

export interface BingQueryRow { day: string; query: string; clicks: number; impressions: number; avgPosition: number | null }
export interface BingPageRow { day: string; pageUrl: string; clicks: number; impressions: number; avgPosition: number | null }
export interface BingSiteDayRow {
  day: string;
  clicks: number | null; impressions: number | null;
  crawledPages: number | null; crawlErrors: number | null; inIndex: number | null; inLinks: number | null;
  blockedRobots: number | null; code4xx: number | null; code5xx: number | null; dnsFailures: number | null; timeouts: number | null;
}
export interface BingIssueRow { url: string; httpCode: number | null; issueFlags: number | null; issueText: string | null; inLinks: number | null }
/** The dashboard has the same list (`BING_AI_STATUSES` in shared/schema.ts); `verify:wiring` compares the two. */
export const BING_AI_STATUS_VALUES = ["unavailable", "answered_not_mapped", "unknown"] as const;
export type BingAiStatus = (typeof BING_AI_STATUS_VALUES)[number];

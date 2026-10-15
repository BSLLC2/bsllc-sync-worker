/**
 * Google Business Profile performance: what is asked, what is kept, our own limits.
 *
 * NOTHING HERE HAS BEEN RUN AGAINST GOOGLE. Business Profile API access is granted by
 * Google on application, and no approved project exists yet. Every address, field name
 * and enum below is written from the Business Profile Performance API reference as I
 * know it; `docs/INTEGRATIONS-SETUP.md` in the dashboard repository lists what is
 * unverified, and the reader parses defensively and says so in its status.
 */

export const GBP_PERFORMANCE_BASE = "https://businessprofileperformance.googleapis.com/v1";
export const GBP_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";

/**
 * The daily metrics asked for, by Google's name, and the short key each is stored
 * under. The dashboard has the same list (`GBP_METRIC_KEYS` in shared/gbp-readings.ts)
 * and `verify:wiring` compares the two. A metric Google sends that is not here is
 * counted and named, never stored under a guessed key.
 */
export const GBP_DAILY_METRICS: Record<string, string> = {
  CALL_CLICKS: "calls",
  BUSINESS_DIRECTION_REQUESTS: "directions",
  WEBSITE_CLICKS: "website_clicks",
  BUSINESS_CONVERSATIONS: "messages",
  BUSINESS_BOOKINGS: "bookings",
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: "views_desktop_maps",
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: "views_desktop_search",
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: "views_mobile_maps",
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: "views_mobile_search",
};
export const GBP_METRIC_KEYS = Object.values(GBP_DAILY_METRICS);

/** Days of daily counts asked for each run: this month so far, all of last month, and a margin. Ours. */
export const GBP_WINDOW_DAYS = 75;
/** Google's counts trail by a few days; the last day asked for is yesterday and the reading names the newest day it HAS. */
export const GBP_END_LAG_DAYS = 1;
/** Months of search terms kept. The newest complete month is re-read each run; an older month only when none is stored. */
export const GBP_KEYWORD_MONTHS = 6;
export const GBP_KEYWORDS_PER_MONTH = 150;
export const GBP_KEYWORD_PAGE_SIZE = 100;
export const GBP_KEYWORD_MAX_PAGES = 3;
/** How long a row is kept. Counts are tiny; this is housekeeping, not a limit that matters. */
export const GBP_KEEP_DAYS = 400;
export const GBP_KEEP_KEYWORD_MONTHS = 14;
export const GBP_PAUSE_MS = 400;

/** The digits of a Business Profile location id. A longer or shorter value is not one. */
export const GBP_LOCATION_ID_RE = /^\d{5,25}$/;

export interface GbpDayRow { day: string; metric: string; value: number }
export interface GbpKeywordRow { month: string; keyword: string; impressions: number; bound: "exact" | "below" }

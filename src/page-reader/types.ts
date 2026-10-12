/** The shapes the page reader passes around. Mirrors shared/schema.ts seoPageFacts. */

export const FOUND_BY = ["ranking", "home", "enquiry", "sitemap"] as const;
export type SeoPageFoundByName = (typeof FOUND_BY)[number];

export const PAGE_STATES = [
  "read", "blocked_robots", "not_found", "error_status", "timeout",
  "not_html", "too_large", "off_site_redirect", "fetch_failed",
] as const;
export type PageState = (typeof PAGE_STATES)[number];

/** One row of seo_page_facts, as the reader produces it. */
export interface PageRow {
  url: string;
  finalUrl: string | null;
  foundBy: SeoPageFoundByName;
  state: PageState;
  statusCode: number | null;
  error: string | null;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  h1Count: number | null;
  outlineJson: string | null;
  wordCount: number | null;
  canonical: string | null;
  noindex: boolean | null;
  schemaTypesJson: string | null;
  inLinks: number | null;
  outLinks: number | null;
  pagesRead: number | null;
  phrasesJson: string | null;
  phrasesChecked: number | null;
}

/**
 * Search Console URL Inspection: what Google itself says about one page.
 *
 * Analytics and Search Console's performance report say HOW MANY visits a page
 * got. They cannot say why it stopped getting them. This asks Google, page by
 * page, whether the page is in the index, which address Google treats as the
 * original, when it last visited, whether anything stopped it, and whether the
 * page is usable on a phone. COUNTS AND STATES ONLY: no page text, no visitor.
 *
 * THE QUOTA. Google publishes 2,000 inspections per property per day and 600 per
 * minute, with a project-wide ceiling above that (as published when this was
 * written; verify against Google's current Search Console API usage limits page).
 * We spend far less on purpose, and the figures below are OURS, not Google's:
 * 150 a property a day, 40 a client a run, one call every 1.5 seconds (40 a
 * minute). The daily count is read from the rows this job has already written for
 * the property today, so a rerun the same day cannot double the spend.
 */

/** The endpoint, as documented for urlInspection.index.inspect. NOT run against a live property. */
export const INSPECT_ENDPOINT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
/** The scope. The documentation lists both the read-only and the full Search Console scope. */
export const INSPECT_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

/** Google's published limits, quoted so a person can check them. Not used to decide anything. */
export const PUBLISHED_PER_PROPERTY_PER_DAY = 2000;
export const PUBLISHED_PER_PROPERTY_PER_MINUTE = 600;

/** OUR lines. */
export const INSPECT_DAILY_CAP = 150;
export const INSPECT_RUN_MAX = 40;
export const INSPECT_PAUSE_MS = 1500;
/** Rows kept per address. The prune query in store.ts says the same number as a literal. */
export const KEEP_PER_URL = 4;
/** A page inspected inside this many days is not inspected again, unless it fell. */
export const REINSPECT_DAYS = 6;
export const REINSPECT_FELL_DAYS = 2;
/** After this many failures in a row on one property, stop for the run. */
export const STOP_AFTER_FAILURES = 3;

export const PICKED_FOR = ["fell", "top", "home"] as const;
export type PickedFor = (typeof PICKED_FOR)[number];

export const INSPECT_STATES = ["ok", "error"] as const;
export type InspectState = (typeof INSPECT_STATES)[number];

export interface InspectionRowOut {
  url: string;
  pagePath: string;
  siteUrl: string;
  pickedFor: PickedFor;
  inspectedAt: Date;
  state: InspectState;
  /** Why an inspection failed, with no key and no token in it. Null on an ok row. */
  detail: string | null;
  verdict: string | null;
  coverageState: string | null;
  indexingState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlAt: Date | null;
  pageFetchState: string | null;
  robotsTxtState: string | null;
  mobileVerdict: string | null;
  richResultsJson: string | null;
}

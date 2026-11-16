/**
 * Backlinks for each client's site and up to three named competitors, from DataForSEO, which the
 * worker already pays for. Counts and domain names of OTHER websites only: no anchor text, no page
 * of ours or theirs, no person. The tables belong to the dashboard app (schema v304, provisional);
 * this repository only writes rows. docs/BACKLINKS.md is the contract in words.
 *
 * NO DATAFORSEO REQUEST SHAPE BELOW HAS BEEN RUN AGAINST THE LIVE API. They are written from the
 * published reference. The first dry run prints the estimate and reads nothing; the first real run
 * should be one client.
 *
 * COST. Every call costs money, so a run states what it expects to spend before it reads anything and
 * refuses to go past BACKLINKS_RUN_BUDGET_CENTS. The estimates here are OURS, a guess at the published
 * price, and the real charge is read from each answer and added up.
 */

export const BACKLINK_RUN_STATUSES = ["ok", "off", "no_key", "error", "no_data", "capped"] as const;
export type BacklinkRunStatus = (typeof BACKLINK_RUN_STATUSES)[number];
export const BACKLINK_ROLES = ["own", "competitor"] as const;
export type BacklinkRole = (typeof BACKLINK_ROLES)[number];

/** Competitors a person may name per client. Typed, never picked by this job. */
export const MAX_COMPETITORS = 3;
/** The referring domains kept for each target. */
export const TOP_REFERRING_DOMAINS = 10;
/** The window "new and lost" is read over. */
export const NEW_LOST_DAYS = 30;
/** The default budget for one run, in cents. A person raises it with the BACKLINKS_RUN_BUDGET_CENTS variable. */
export const DEFAULT_RUN_BUDGET_CENTS = 150;
/** Rows older than this are deleted at the end of a client's write. */
export const KEEP_SUMMARY_DAYS = 400;
export const KEEP_DOMAIN_DAYS = 60;

/** What one call is expected to cost, in dollars. OURS and unverified; the real figure is read from each answer. */
export const EST_USD = { summary: 0.02, newLost: 0.02, referringDomains: 0.03 } as const;
export const EST_USD_PER_DOMAIN = Math.round((EST_USD.summary + EST_USD.newLost + EST_USD.referringDomains) * 10000) / 10000;

export interface DomainRead {
  domain: string;
  role: BacklinkRole;
  /** Null where that call failed: unanswered, never a nought. */
  summary: {
    backlinks: number | null;
    referringDomains: number | null;
    referringMainDomains: number | null;
    brokenBacklinks: number | null;
    /** Counts of links by how the link is made, from the provider's own type counts. No anchor text. */
    anchorLinks: number | null;
    imageLinks: number | null;
    otherLinks: number | null;
  } | null;
  newLost: { newBacklinks: number | null; lostBacklinks: number | null; newDomains: number | null; lostDomains: number | null } | null;
  topDomains: Array<{ domain: string; backlinks: number | null; firstSeen: string | null }> | null;
  costUsd: number;
  failed: string[];
}

export interface ClientBacklinkResult {
  status: BacklinkRunStatus;
  detail: string | null;
  reads: DomainRead[];
  estimatedUsd: number;
  spentUsd: number;
}

export interface DfsAnswer { result: any; cost: number }
/** One DataForSEO call. Throws with a plain message on a failure. The test seam. */
export type DfsCall = (path: string, body: unknown[]) => Promise<DfsAnswer>;

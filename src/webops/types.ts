/**
 * WebOps site-care readers: what they write and what a run can end as.
 *
 * THE CONTRACT WITH THE APP IS ONE TABLE, `site_care_readings`, one row per client,
 * kind and subject (a host or a project). The app side was being built at the same
 * time as this one and its table name and columns were NOT yet visible when this was
 * written: every name below is provisional and lives in two places only, the literal
 * INSERT in `store.ts` and the column list in docs/WEBOPS-READERS.md. If the app
 * declares different names, change those two and nothing else.
 *
 * WHAT IS STORED. Counts, dates, milliseconds and yes/no facts. Never a page, a
 * response body, a header VALUE, a certificate, a plugin name, a person or a secret.
 * Header names that are missing are the one list kept (names only, from a fixed set).
 *
 * A FAILED READ IS NEVER "OK". Every reader ends as one of the states below. A read
 * that failed stores `could_not_check` with the reason, nulls every measurement (a
 * figure from last week beside "could not check" would read as current) and keeps
 * `last_read_at`, the last time the reader actually saw the site.
 */
export const READ_KINDS = ["site", "domain", "wp"] as const;
export type ReadKind = (typeof READ_KINDS)[number];

/** read: the reader got its answer. could_not_check: it tried and failed.
 *  blocked_by_robots: the site's robots.txt forbids the home page to us (nothing read).
 *  off: not switched on for this account. no_key: a secret this worker lacks. */
export const READ_STATES = ["read", "could_not_check", "blocked_by_robots", "off", "no_key"] as const;
export type ReadState = (typeof READ_STATES)[number];

/** The only security headers looked for, by name. Presence only, never the value. */
export const SECURITY_HEADERS = ["strict-transport-security", "x-content-type-options", "x-frame-options-or-frame-ancestors", "referrer-policy"] as const;

export type CanonicalState = "same" | "other_host" | "other_path" | "none";

export interface SiteFacts {
  httpStatus: number | null;
  responseMs: number | null;
  redirectHops: number | null;
  endedHttps: boolean | null;
  /** The host the chain ended on, when it is not the host that was asked for. */
  endsOffSite: boolean | null;
  canonicalState: CanonicalState | null;
  /** From the TLS handshake. Null where the final address is not https. */
  certExpiresOn: string | null;
  certTrusted: boolean | null;
  headersMissing: string[] | null;
}

export interface DomainFacts { domainExpiresOn: string | null }

/** Every field here is null when the dashboard did not report it. Unverified field names: see umbrella.ts. */
export interface WpFacts {
  wpCoreBehind: boolean | null;
  wpPluginsBehind: number | null;
  wpThemesBehind: number | null;
  wpVulnerabilities: number | null;
  wpUptimePct: number | null;
  wpLastBackupAt: string | null;
  wpLastBackupOk: boolean | null;
}

export interface ReadingOut {
  kind: ReadKind;
  subject: string;
  state: ReadState;
  detail: string | null;
  site: SiteFacts | null;
  domain: DomainFacts | null;
  wp: WpFacts | null;
}

export const SITE_USER_AGENT = "BSLLC-SiteCare/1.0 (+https://work.bsllc.biz; one public request to check the client's own site is up)";
export const SITE_TIMEOUT_MS = 15_000;
export const SITE_MAX_REDIRECTS = 5;
export const SITE_BODY_BYTES = 200_000;

/**
 * The platform adapter seam.
 *
 * Everything above this interface — the rules engine, the findings store, the
 * apply/verify jobs, the review screen — is platform-agnostic. Everything below
 * it is one vendor's API and its particular indignities. Adding Microsoft
 * Advertising means writing one file that satisfies this interface; it must not
 * mean touching the rules or the store.
 *
 * Six verbs, and they are the whole loop:
 *   read     — pull the evidence (read-only; never mutates)
 *   validate — ask the platform whether a change would be accepted, changing
 *              nothing. Google has validate_only; where a platform has no
 *              equivalent the adapter must say so rather than pretend.
 *   apply    — make the change AND return the prior values. An adapter that
 *              cannot return prior values must refuse the change: an
 *              irreversible change is not one we make unattended.
 *   rollback — restore those prior values.
 *   verify   — re-read the metrics for an entity over a window, for the
 *              14/28-day after-check.
 *   capabilities — what this platform can and cannot change, so the UI and the
 *              vendor briefs can tell the truth without hardcoding vendor
 *              knowledge in the app.
 *
 * See docs/ADS_PLATFORM_CAPABILITIES.md for the researched per-platform limits.
 */

import type { AuditInput } from "./rules.js";

export type PlatformId = "google_ads" | "meta" | "microsoft";

export interface AdapterContext {
  accountId: string;
  /** Inclusive YYYY-MM-DD window for the long evidence pull. */
  windowStart: string;
  windowEnd: string;
  /** Client-protected terms — never proposed as negatives. */
  protectedPatterns: string[];
}

export interface ValidationResult {
  ok: boolean;
  /** True when the platform genuinely dry-ran this. False means the adapter
   *  could only check it locally — say so rather than imply a server check. */
  serverValidated: boolean;
  message: string;
}

export interface ApplyResult {
  ok: boolean;
  message: string;
  /** Whatever the platform returned — created resource names, etc. */
  result: unknown;
  /**
   * The prior values, captured BEFORE the mutate. This is what rollback
   * restores. Null is a hard failure, not a warning: the apply path refuses to
   * proceed when the adapter cannot produce one.
   */
  priorValues: unknown | null;
  /** Human-readable reversal steps, printed the way the CLI already prints them. */
  rollbackPlan: string[];
}

export interface VerifyMetrics {
  /** Platform-neutral metric bag over the requested window. */
  metrics: Record<string, number>;
  windowStart: string;
  windowEnd: string;
}

/**
 * What this platform's API can actually change. Written down per platform so
 * "the API can't do that" is a fact in the codebase rather than something each
 * session re-guesses. `false` entries are what generate vendor briefs.
 */
export interface PlatformCapabilities {
  platform: PlatformId;
  /** Human label. */
  label: string;
  /** Does the adapter have working credentials right now? */
  credentialed: boolean;
  /** Per-capability: can the API change it, and what we support. */
  canChange: {
    budgets: boolean;
    bidStrategy: boolean;
    keywords: boolean;
    negativeKeywords: boolean;
    audiences: boolean;
    targeting: boolean;
    statusChanges: boolean;
    /** Creative EDIT in place. False on Google and Meta — see the doc. */
    creativeEdit: boolean;
    /** Creative CREATE (new ad, pause old) — possible but out of our scope. */
    creativeCreate: boolean;
    finalUrls: boolean;
    assetDetach: boolean;
  };
  /** What WE have built a guarded path for — a strict subset of canChange. */
  guardedOps: string[];
  /** Anything a person needs to know before trusting the above. */
  notes: string[];
}

export interface PlatformAdapter {
  platform: PlatformId;
  capabilities(): PlatformCapabilities;
  /** Read-only evidence pull, normalized into the rules engine's input shape. */
  read(ctx: AdapterContext): Promise<AuditInput>;
  /** Dry run. Must not change anything, on any code path. */
  validate(op: string, body: unknown): Promise<ValidationResult>;
  /** Apply. Must return prior values or refuse. */
  apply(op: string, body: unknown): Promise<ApplyResult>;
  /** Restore prior values captured by a previous apply. */
  rollback(priorValues: unknown): Promise<ApplyResult>;
  /** Re-read metrics for the after-check. */
  verify(entityType: string, entityId: string, windowStart: string, windowEnd: string): Promise<VerifyMetrics>;
}

/** Thrown by an adapter that is a declared seam rather than an implementation. */
export class AdapterNotImplemented extends Error {
  constructor(platform: PlatformId, what: string) {
    super(`${platform}: ${what} is not implemented yet. See docs/ADS_PLATFORM_CAPABILITIES.md.`);
    this.name = "AdapterNotImplemented";
  }
}

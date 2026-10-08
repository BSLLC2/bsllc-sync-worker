/**
 * What one audit run did to one account, in the shape the dashboard reads.
 *
 * Pure. The audit already COUNTS everything it dropped, routed, closed or left
 * alone and printed it into a log nobody opens (`run-accounting.ts`). This is
 * the same accounting, kept: one row per account per run in `ads_audit_runs`,
 * so the Ads decisions page can say what the last audit did instead of leaving
 * a person to guess whether the rows in front of them are today's.
 *
 * WHAT IS STORED IS COUNTS AND NAMES, NEVER SENTENCES. The words a person reads
 * live in the dashboard (`shared/ads-audit-run.ts`), where the copy guards read
 * them. A sentence written here would be a second wording of every count.
 *
 * FOUR OUTCOMES, AND NONE OF THEM IS A NOUGHT:
 *   read          the account was read and the rules ran over it.
 *   read_nothing  the read came back with no campaigns. Indistinguishable from a
 *                 failed read, so NOTHING was swept and old rows stay as they
 *                 were. The page says so rather than printing "0 raised".
 *   failed        the read or the write threw. `reason` is the first line of the
 *                 error, trimmed, and nothing else.
 *   skipped       the account was NOT audited this run, and why (connector off,
 *                 client paused, no token for the platform).
 *
 * The contract with the dashboard is the key lists below. `npm run verify:wiring`
 * (surface 12 in the dashboard repo) compares them with the dashboard's own in
 * both directions, so a field added here and not read there fails the build of
 * whichever repo is checked out beside the other.
 *
 * Every figure, campaign and term in the guards is invented.
 */
import type { AuditAccounting } from "./rules.js";
import type { NotRechecked } from "./sweep-plan.js";

export const RUN_SUMMARY_VERSION = 1;

export const RUN_OUTCOMES = ["read", "read_nothing", "failed", "skipped"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** Top-level keys of the stored JSON. The dashboard declares the same list. */
export const RUN_SUMMARY_KEYS = ["v", "counts", "raisedIds", "raised", "closed", "leftAlone", "notRechecked"] as const;

/** Every count, by name. The dashboard declares the same list. */
export const RUN_COUNT_KEYS = [
  "raised", "created", "refreshed", "reopened", "leftDecided",
  "closedCleared", "closedRuleUpdate", "closedReplaced", "closedNotAudited",
  "heldForClient", "blockedByNegative", "coreSearchesHeld", "competitorKeywords", "stoppedKeywords", "targetHeld",
] as const;
export type RunCountKey = (typeof RUN_COUNT_KEYS)[number];

/** How many names are kept per list. The count beside each is never capped. */
export const RUN_RECORD_CAP = 25;
export const RUN_LEFT_ALONE_CAP = 40;
export const RUN_RAISED_ID_CAP = 300;
export const RUN_REASON_CAP = 240;

export type RaisedChange = "new" | "updated" | "reopened";
export type ClosedWhy = "cleared" | "rule_update" | "replaced" | "not_audited";
export type LeftAloneKind = "blocked_by_negative" | "core_search" | "competitor_keyword" | "stopped_keyword";

export interface RaisedRecord { id: string; title: string; change: RaisedChange }
export interface ClosedRecord { id: string; title: string; why: ClosedWhy }
export interface LeftAloneRecord { kind: LeftAloneKind; text: string; because: string; campaign: string }

export interface AdsRunSummary {
  v: typeof RUN_SUMMARY_VERSION;
  counts: Record<RunCountKey, number>;
  raisedIds: string[];
  raised: RaisedRecord[];
  closed: ClosedRecord[];
  leftAlone: LeftAloneRecord[];
  notRechecked: NotRechecked[];
}

export interface RunFacts {
  /** Per finding the rules produced, in the order the rank pass left them. */
  upserts: { id: string; title: string; outcome: "created" | "refreshed" | "reopened" | "left_dismissed" | "left_in_flight" }[];
  /** Rows closed by the sweep and by the supersede pass. */
  closed: ClosedRecord[];
  accounting: AuditAccounting;
  notRechecked: NotRechecked[];
}

const one = (s: string, cap: number) => s.replace(/\s+/g, " ").trim().slice(0, cap);

export function buildRunSummary(f: RunFacts): AdsRunSummary {
  const a = f.accounting;
  const waiting = f.upserts.filter((u) => u.outcome === "created" || u.outcome === "refreshed" || u.outcome === "reopened");
  const count = (o: string) => f.upserts.filter((u) => u.outcome === o).length;
  const closedBy = (w: ClosedWhy) => f.closed.filter((c) => c.why === w).length;

  const leftAlone: LeftAloneRecord[] = [];
  for (const b of a.promotionsBlocked) {
    leftAlone.push({
      kind: "blocked_by_negative", text: one(b.term, 80), campaign: one(b.campaignName, 80),
      because: `a ${b.by.matchType.toLowerCase()} negative "${one(b.by.text, 60)}" already blocks it`,
    });
  }
  for (const h of a.coreSearchesNotBlocked) {
    leftAlone.push({
      kind: "core_search", text: one(h.term, 80), campaign: one(h.campaignName, 80),
      because: `it matches a service the client sells ("${one(h.block.service, 60)}")`,
    });
  }
  for (const c of a.competitorKeywords) {
    leftAlone.push({
      kind: "competitor_keyword", text: `${c.count} keyword${c.count === 1 ? "" : "s"}`, campaign: one(c.campaignName, 80),
      because: "on a recorded competitor name, judged on cost per conversion",
    });
  }
  for (const k of a.keywordsStopped) {
    leftAlone.push({
      kind: "stopped_keyword", text: one(k.text, 80), campaign: one(k.campaignName, 80),
      because: `no spend since ${k.lastSpendOn}`,
    });
  }

  return {
    v: RUN_SUMMARY_VERSION,
    counts: {
      raised: waiting.length,
      created: count("created"),
      refreshed: count("refreshed"),
      reopened: count("reopened"),
      leftDecided: count("left_dismissed") + count("left_in_flight"),
      closedCleared: closedBy("cleared"),
      closedRuleUpdate: closedBy("rule_update"),
      closedReplaced: closedBy("replaced"),
      closedNotAudited: closedBy("not_audited"),
      heldForClient: a.budgetRoutedToClient.length,
      blockedByNegative: a.promotionsBlocked.length,
      coreSearchesHeld: a.coreSearchesNotBlocked.length,
      competitorKeywords: a.competitorKeywords.reduce((n, c) => n + c.count, 0),
      stoppedKeywords: a.keywordsStopped.length,
      targetHeld: a.targetHeld.length,
    },
    raisedIds: waiting.slice(0, RUN_RAISED_ID_CAP).map((u) => u.id),
    raised: waiting.slice(0, RUN_RECORD_CAP).map((u) => ({
      id: u.id, title: one(u.title, 140),
      change: u.outcome === "created" ? "new" : u.outcome === "reopened" ? "reopened" : "updated",
    })),
    closed: f.closed.slice(0, RUN_RECORD_CAP).map((c) => ({ id: c.id, title: one(c.title, 140), why: c.why })),
    leftAlone: leftAlone.slice(0, RUN_LEFT_ALONE_CAP),
    notRechecked: f.notRechecked,
  };
}

/** A failure's one-line reason: the first line, trimmed. Never a stack, never a token. */
export function failureReason(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const first = raw.split(/\r?\n/)[0] ?? "";
  // Anything that looks like a credential is cut rather than kept.
  const cleaned = first.replace(/(bearer\s+)[\w.\-]+/gi, "$1[cut]").replace(/\b(ya29|1\/\/|AIza)[\w.\-]{8,}/g, "[cut]");
  return cleaned.slice(0, RUN_REASON_CAP) || "the read failed";
}

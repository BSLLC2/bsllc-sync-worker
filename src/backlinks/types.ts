/**
 * The backlink read's shared words. The first list is the dashboard's older link read (`seo_backlink_runs`); the other three are the link
 * audit's (`link_audit_*`). `npm run verify:wiring` compares every list below with the dashboard's, both ways.
 */
export const BACKLINK_RUN_STATUSES = ["ok", "off", "no_key", "error", "no_data", "capped"] as const;
export const LINK_AUDIT_RUN_STATUSES = ["ok", "off", "no_key", "error", "no_data", "capped"] as const;
export const LINK_AUDIT_PART_STATES = ["ok", "failed", "capped", "skipped", "no_data"] as const;
export const LINK_AUDIT_TARGET_KINDS = ["broken", "redirect"] as const;

export type RunStatus = (typeof LINK_AUDIT_RUN_STATUSES)[number];
export type PartState = (typeof LINK_AUDIT_PART_STATES)[number];
export type TargetKind = (typeof LINK_AUDIT_TARGET_KINDS)[number];

export interface SummaryOut {
  domain: string; role: "own" | "competitor"; backlinks: number | null; referringDomains: number | null; referringMainDomains: number | null;
  brokenBacklinks: number | null; anchorLinks: number | null; imageLinks: number | null; otherLinks: number | null; costUsd: number | null;
}
export interface DomainOut {
  refDomain: string; tld: string; rank: number | null; spamScore: number | null; backlinks: number | null; dofollowBacklinks: number | null;
  firstSeen: string | null; lastSeen: string | null; lostDate: string | null; spamAnchor: boolean | null;
}
export interface TargetOut { pagePath: string; kind: TargetKind; statusCode: number | null; redirectPath: string | null; backlinks: number | null; referringDomains: number | null }
export interface AnchorOut { anchor: string; referringDomains: number | null; backlinks: number | null; firstSeen: string | null; lastSeen: string | null }
export interface GapOut { refDomain: string; rank: number | null; spamScore: number | null; competitors: string[] }

export interface AuditRead {
  status: RunStatus;
  detail: string | null;
  summaries: SummaryOut[];
  domains: DomainOut[] | null;
  targets: TargetOut[] | null;
  anchors: AnchorOut[] | null;
  gap: GapOut[] | null;
  domainsState: PartState; domainsRead: number | null; domainsTotal: number | null;
  anchorsState: PartState; anchorsRead: number | null;
  targetsState: PartState; targetsRead: number | null;
  gapState: PartState; gapRead: number | null;
  spamState: PartState;
  estimatedUsd: number;
  spentUsd: number;
}

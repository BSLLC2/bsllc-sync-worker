/**
 * The findings store — lifecycle rules over Postgres.
 *
 * This is where "the answer switches day to day" is actually fixed. `upsert`
 * below is not a plain INSERT ... ON CONFLICT: it is the set of rules deciding
 * what a re-detection MEANS for a finding that already exists.
 *
 *   open / proposed  → refresh the evidence in place, bump times_seen. The
 *                      finding is the same finding; its numbers are newer.
 *   dismissed        → LEAVE IT ALONE, unless the bucketed evidence hash moved,
 *                      in which case re-open it with a 'reopened' event saying
 *                      exactly why. This one branch is most of the value of the
 *                      whole feature.
 *   approved/applied/verifying/won/lost → do not touch the status. A change is
 *                      in flight or has been measured; a fresh detection must
 *                      not drag it backwards into the review queue.
 *   reverted         → treat like dismissed. We put it back on purpose.
 *
 * Every branch writes an ads_finding_events row, including the machine ones, so
 * months later "what did we recommend, what did we do, and why did it come
 * back" is answerable from the database rather than a workflow log.
 */

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { evidenceHash, materiallyChanged, ADS_RULESET_VERSION, type DerivedFinding, type ClientEconomics, type OutcomeFeedFacts, type MissingFigureWhy } from "./rules.js";
import type { ClientServiceFacts } from "./service-relevance.js";
import type { ResearchFacts, ResearchKeyword } from "./keyword-gap.js";
import type { RecordedTarget } from "./keyword-sourcing.js";
import type { PhoneDemandFacts } from "./traffic-readiness.js";
import { parseCompetitorNames } from "./competitor-names.js";
import {
  planSweep, planOrphanClosures, isMachineClosure,
  type NotRechecked, type OrphanGroup, type MappingState, type OrphanPlan,
} from "./sweep-plan.js";
import { failureReason, type AdsRunSummary, type RunOutcome, type ClosedRecord } from "./run-summary.js";

export type Actor = string;

export interface UpsertResult {
  id: string;
  outcome: "created" | "refreshed" | "reopened" | "left_dismissed" | "left_in_flight";
}

/** Statuses where a human decision or a live change is already in play. */
const IN_FLIGHT = ["approved", "applied", "verifying", "won", "lost"];
const SETTLED = ["dismissed", "reverted"];

export async function upsertFinding(
  c: pg.Client,
  clientId: string,
  platform: string,
  accountId: string,
  f: DerivedFinding,
  actor: Actor,
): Promise<UpsertResult> {
  const hash = evidenceHash(f.evidence.metrics);
  /**
   * WHERE THE ORDER IS PERSISTED, so the app never re-decides it.
   *
   * `evaluate` ranks every finding it produces and the reading rides on the
   * row. A finding written before ruleset 6 carries no basis at all, which the
   * dashboard reads as "not ranked yet" and says so rather than filling in a
   * nought — every open finding is re-ranked by the next weekly audit, so
   * nothing is backfilled and nothing stays unranked for long.
   *
   * It is NOT derived from `est_impact_cents`: that column carries dollars on
   * one row, leads on another and a deliberate nought on a third.
   */
  const rank = f.rank ?? { cents: null, basis: "none" as const, why: "", blockedBy: null };
  const evidenceJson = JSON.stringify(f.evidence);
  const changePayloadJson = f.changePayload ? JSON.stringify(f.changePayload) : null;
  // A finding with a ready payload is already a proposal — there is nothing
  // further for a machine to do to it, so it goes straight to 'proposed' and
  // the only missing ingredient is a person.
  const freshStatus = f.changePayload ? "proposed" : "open";

  const { rows: existingRows } = await c.query<{
    id: string; status: string; evidence_hash: string | null; times_seen: number;
    dismissed_by: string | null; dismissed_reason: string | null;
  }>(
    `SELECT id, status, evidence_hash, times_seen, dismissed_by, dismissed_reason FROM ads_findings
      WHERE client_id = $1 AND platform = $2 AND account_id = $3 AND entity_id = $4 AND finding_type = $5`,
    [clientId, platform, accountId, f.entityId, f.findingType],
  );
  const existing = existingRows[0];

  if (!existing) {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO ads_findings (
         id, client_id, platform, account_id, entity_type, entity_id, entity_name, finding_type,
         status, severity, risk_level, applicability, title, summary,
         evidence_json, evidence_hash, window_start, window_end,
         est_impact_cents, impact_unit, impact_assumption,
         change_payload_json, guard_note, ruleset_version, proposed_at,
         rank_cents, rank_basis, rank_why
       ) VALUES (
         $24, $1,$2,$3,$4,$5,$6,$7,
         $8,$9,$10,$11,$12,$13,
         $14,$15,$16,$17,
         $18,$19,$20,
         $21,$22,$23, CASE WHEN $21::text IS NULL THEN NULL ELSE now() END,
         $25,$26,$27
       ) RETURNING id`,
      [
        clientId, platform, accountId, f.entityType, f.entityId, f.entityName, f.findingType,
        freshStatus, f.severity, f.riskLevel, f.applicability, f.title, f.summary,
        evidenceJson, hash, f.evidence.windowStart, f.evidence.windowEnd,
        f.estImpactCents, f.impactUnit, f.impactAssumption,
        changePayloadJson, f.guardNote, ADS_RULESET_VERSION, randomUUID(),
        rank.cents, rank.basis, rank.why,
      ],
    );
    const newId = rows[0]?.id;
    if (!newId) throw new Error("ads_findings insert returned no id.");
    await logEvent(c, newId, "detected", actor, f.title, JSON.stringify({ hash, estImpactCents: f.estImpactCents }));
    return { id: newId, outcome: "created" };
  }

  // A change is in flight or already measured. Refresh nothing that would
  // disturb it — not even the evidence, because the evidence on an applied
  // finding is the BEFORE picture and overwriting it destroys the comparison
  // the 14/28-day check depends on.
  if (IN_FLIGHT.includes(existing.status)) {
    await c.query(`UPDATE ads_findings SET last_seen_at = now(), times_seen = times_seen + 1 WHERE id = $1`, [existing.id]);
    return { id: existing.id, outcome: "left_in_flight" };
  }

  // Settled by a human. The ONLY thing that brings it back is the evidence
  // genuinely moving — and when it does, the event log says so, so nobody
  // wonders why a dismissed finding reappeared.
  if (SETTLED.includes(existing.status)) {
    // A row the AUDIT closed for a reason that has since gone (the rules moved,
    // or its account was not being read) was never decided by anybody, so it
    // comes back whatever the evidence hash says. A person's dismissal never
    // matches this and stays sticky.
    const machineClosed = isMachineClosure(existing.dismissed_by, existing.dismissed_reason, actor);
    if (!machineClosed && !materiallyChanged(existing.evidence_hash, hash)) {
      await c.query(`UPDATE ads_findings SET last_seen_at = now() WHERE id = $1`, [existing.id]);
      return { id: existing.id, outcome: "left_dismissed" };
    }
    await c.query(
      `UPDATE ads_findings SET
         status = $2, severity = $3, risk_level = $4, applicability = $5,
         title = $6, summary = $7, evidence_json = $8, evidence_hash = $9,
         window_start = $10, window_end = $11,
         est_impact_cents = $12, impact_unit = $13, impact_assumption = $14,
         change_payload_json = $15, guard_note = $16, ruleset_version = $17,
         rank_cents = $18, rank_basis = $19, rank_why = $20,
         last_seen_at = now(), times_seen = times_seen + 1,
         dismissed_by = NULL, dismissed_at = NULL, dismissed_reason = NULL,
         proposed_at = CASE WHEN $15::text IS NULL THEN NULL ELSE now() END
       WHERE id = $1`,
      [
        existing.id, freshStatus, f.severity, f.riskLevel, f.applicability,
        f.title, f.summary, evidenceJson, hash, f.evidence.windowStart, f.evidence.windowEnd,
        f.estImpactCents, f.impactUnit, f.impactAssumption,
        changePayloadJson, f.guardNote, ADS_RULESET_VERSION,
        rank.cents, rank.basis, rank.why,
      ],
    );
    await logEvent(
      c, existing.id, "reopened", actor,
      machineClosed
        ? "Raised again — the audit had closed it and it applies again."
        : `Evidence moved since it was dismissed — re-raised for another look.`,
      JSON.stringify({ previousHash: existing.evidence_hash, hash, estImpactCents: f.estImpactCents }),
    );
    return { id: existing.id, outcome: "reopened" };
  }

  // Still awaiting a decision: same finding, newer numbers.
  await c.query(
    `UPDATE ads_findings SET
       status = $2, severity = $3, risk_level = $4, applicability = $5,
       title = $6, summary = $7, evidence_json = $8, evidence_hash = $9,
       window_start = $10, window_end = $11,
       est_impact_cents = $12, impact_unit = $13, impact_assumption = $14,
       change_payload_json = $15, guard_note = $16, ruleset_version = $17,
       rank_cents = $18, rank_basis = $19, rank_why = $20,
       last_seen_at = now(), times_seen = times_seen + 1,
       proposed_at = CASE WHEN $15::text IS NULL THEN NULL ELSE COALESCE(proposed_at, now()) END
     WHERE id = $1`,
    [
      existing.id, freshStatus, f.severity, f.riskLevel, f.applicability,
      f.title, f.summary, evidenceJson, hash, f.evidence.windowStart, f.evidence.windowEnd,
      f.estImpactCents, f.impactUnit, f.impactAssumption,
      changePayloadJson, f.guardNote, ADS_RULESET_VERSION,
      rank.cents, rank.basis, rank.why,
    ],
  );
  // Only log when the numbers actually moved. A weekly "evidence refreshed"
  // row that says nothing changed is noise that buries the events that matter.
  if (materiallyChanged(existing.evidence_hash, hash)) {
    await logEvent(c, existing.id, "updated", actor, "Evidence refreshed.", JSON.stringify({ previousHash: existing.evidence_hash, hash }));
  }
  return { id: existing.id, outcome: "refreshed" };
}

/**
 * Close out findings of a type that the latest run no longer sees.
 *
 * A search term we negated stops appearing; a budget-capped campaign that is no
 * longer capped stops matching. Those findings are not dismissed (nobody said
 * no) and not won (nothing was measured) — they simply stopped being true, and
 * leaving them in the review queue is how a screen fills up with stale advice.
 * Only untouched statuses are swept; anything a human or the apply path has
 * moved is left exactly where it is.
 */
export async function sweepResolved(
  c: pg.Client,
  clientId: string,
  platform: string,
  accountId: string,
  /** The (finding type, entity) PAIRS this run produced — see `pairKey`. Entity
   *  ids alone are not a key: three rules key a row on the bare campaign id. */
  presentPairs: ReadonlySet<string>,
  actor: Actor,
  opts: { currentRuleset?: number; unrecheckable?: ReadonlyMap<string, string> } = {},
): Promise<{ closed: ClosedRecord[]; notRechecked: NotRechecked[] }> {
  const { rows } = await c.query<{
    id: string; title: string; entity_id: string; finding_type: string; ruleset_version: number; entity_name: string | null;
  }>(
    `SELECT id, title, entity_id, finding_type, ruleset_version, entity_name FROM ads_findings
      WHERE client_id = $1 AND platform = $2 AND account_id = $3
        AND status IN ('open','proposed')`,
    [clientId, platform, accountId],
  );
  const plan = planSweep(
    rows.map((r) => ({
      id: r.id, title: r.title, entityId: r.entity_id, findingType: r.finding_type,
      rulesetVersion: r.ruleset_version, entityName: r.entity_name,
    })),
    presentPairs,
    opts.currentRuleset ?? ADS_RULESET_VERSION,
    opts.unrecheckable ?? new Map(),
  );
  const closed: ClosedRecord[] = [];
  for (const k of plan.close) {
    await c.query(
      `UPDATE ads_findings
          SET status = 'dismissed', dismissed_by = $2, dismissed_at = now(), dismissed_reason = $3
        WHERE id = $1 AND status IN ('open','proposed')`,
      [k.row.id, actor, k.reason],
    );
    await logEvent(c, k.row.id, "dismissed", actor, k.eventNote, null);
    closed.push({ id: k.row.id, title: k.row.title, why: k.kind === "rule_update" ? "rule_update" : "cleared" });
  }
  return { closed, notRechecked: plan.leftBecauseUnreadable };
}

// ── Accounts the audit no longer reads ───────────────────────────────────────

/**
 * Digits only for a Google account number, as the run normalises it; Meta
 * numbers keep their `act_` prefix. One function so the audit's targets and the
 * orphan comparison cannot disagree about what "the same account" means.
 */
export function normaliseAccountId(v: string): string {
  const t = (v ?? "").trim();
  return t.startsWith("act_") ? t : t.replace(/\D/g, "");
}

/** Every (client, platform, account) holding open rows, with what the mapping now says. */
export async function listOpenAccountGroups(c: pg.Client): Promise<{ groups: OrphanGroup[]; totalOpen: number }> {
  const { rows } = await c.query<{
    client_id: string; platform: string; account_id: string; n: string; last_seen: Date | string | null;
    client_status: string | null; mapping_id: string | null; mapping_enabled: boolean | null; mapping_external: string | null;
  }>(
    `WITH g AS (
       SELECT client_id, platform, account_id, count(*) AS n, max(last_seen_at) AS last_seen
         FROM ads_findings WHERE status IN ('open','proposed')
        GROUP BY client_id, platform, account_id)
     SELECT g.client_id, g.platform, g.account_id, g.n::text AS n, g.last_seen,
            cl.status AS client_status,
            cm.id AS mapping_id, cm.enabled AS mapping_enabled, cm.external_id AS mapping_external
       FROM g
       LEFT JOIN clients cl ON cl.id = g.client_id
       LEFT JOIN connector_mappings cm ON cm.client_id = g.client_id AND cm.source = g.platform`,
  );
  type Row = (typeof rows)[number];
  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.platform}\u0000${r.client_id}\u0000${r.account_id}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const groups: OrphanGroup[] = [];
  for (const list of Array.from(byKey.values())) {
    const first = list[0]!;
    // More than one mapping row for a client and platform is possible. The one
    // that names THIS account decides; failing that, one that is switched on.
    const same = list.find((r) => r.mapping_external && normaliseAccountId(r.mapping_external) === normaliseAccountId(first.account_id));
    const pick = same ?? list.find((r) => r.mapping_enabled === true && r.mapping_id != null) ?? first;
    const last = first.last_seen ? new Date(first.last_seen as string | Date) : null;
    groups.push({
      clientId: first.client_id, platform: first.platform, accountId: first.account_id,
      openRows: Number(first.n),
      lastCheckedOn: last && !Number.isNaN(last.getTime()) ? last.toISOString().slice(0, 10) : null,
      state: {
        clientStatus: first.client_status,
        mappingExists: pick.mapping_id != null,
        mappingEnabled: pick.mapping_enabled === true,
        mappingAccountId: pick.mapping_external,
      },
    });
  }
  return { groups, totalOpen: groups.reduce((n, g) => n + g.openRows, 0) };
}

/** Close the open rows of every account this run did not read, behind the breaker. */
export async function sweepUnauditedAccounts(
  c: pg.Client,
  audited: ReadonlySet<string>,
  actor: Actor,
): Promise<{ plan: OrphanPlan; closedByGroup: { group: OrphanGroup; closed: ClosedRecord[]; reason: string }[] }> {
  const { groups, totalOpen } = await listOpenAccountGroups(c);
  const plan = planOrphanClosures(groups, audited, totalOpen, normaliseAccountId);
  const closedByGroup: { group: OrphanGroup; closed: ClosedRecord[]; reason: string }[] = [];
  for (const k of plan.close) {
    const { rows } = await c.query<{ id: string; title: string }>(
      `SELECT id, title FROM ads_findings
        WHERE client_id = $1 AND platform = $2 AND account_id = $3 AND status IN ('open','proposed')`,
      [k.group.clientId, k.group.platform, k.group.accountId],
    );
    const closed: ClosedRecord[] = [];
    for (const r of rows) {
      await c.query(
        `UPDATE ads_findings
            SET status = 'dismissed', dismissed_by = $2, dismissed_at = now(), dismissed_reason = $3
          WHERE id = $1 AND status IN ('open','proposed')`,
        [r.id, actor, k.reason],
      );
      await logEvent(c, r.id, "dismissed", actor, "Closed — this ad account is no longer audited.", null);
      closed.push({ id: r.id, title: r.title, why: "not_audited" });
    }
    closedByGroup.push({ group: k.group, closed, reason: k.reason });
  }
  return { plan, closedByGroup };
}

/**
 * Mapped accounts the audit did NOT read, for the run record: a connector row
 * with an account number on a client who is not launch/active, or that is
 * switched off. Churned clients are left out — nobody is optimising them.
 */
export async function unauditedMappings(
  c: pg.Client,
  source: string,
  onlyClient?: string,
): Promise<{ clientId: string; clientName: string; accountId: string; why: string }[]> {
  const { rows } = await c.query<{ id: string; name: string; status: string | null; external_id: string; enabled: boolean }>(
    `SELECT c.id, c.name, c.status, cm.external_id, cm.enabled
       FROM clients c
       JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source = $1
      WHERE cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''
        AND c.status <> 'churned'
        AND (cm.enabled = false OR c.status NOT IN ('launch','active'))
      ORDER BY c.name`,
    [source],
  );
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const want = slugify(onlyClient ?? "");
  return rows
    .filter((r) => !onlyClient || slugify(r.name).startsWith(want) || r.external_id.replace(/\D/g, "") === onlyClient.replace(/\D/g, ""))
    .map((r) => ({
      clientId: r.id, clientName: r.name, accountId: r.external_id.trim(),
      why: !r.enabled ? "the connector is switched off" : `the client is marked ${r.status ?? "inactive"}`,
    }));
}

// ── The run record ───────────────────────────────────────────────────────────

const RUN_KEEP = 8;

/**
 * Write one account's run record, then keep only the last few for that account.
 *
 * NEVER FAILS THE RUN. This is bookkeeping about the audit, and an audit that
 * died because its own receipt could not be written would be the worst of both:
 * a run that did its work and reports that it did not. A missing table (the
 * dashboard has not deployed the schema yet) or any other error is returned as
 * a sentence for the log and nothing else.
 */
export async function writeRunRecord(
  c: pg.Client,
  r: {
    clientId: string; platform: string; accountId: string; startedAt: Date;
    outcome: RunOutcome; reason: string | null; scoped: boolean; ruleset: number;
    summary: AdsRunSummary | null;
  },
): Promise<string | null> {
  try {
    await c.query(
      `INSERT INTO ads_audit_runs (id, client_id, platform, account_id, started_at, ran_at, ruleset_version, scoped, outcome, reason, summary_json)
       VALUES ($1,$2,$3,$4,$5, now(), $6,$7,$8,$9,$10)`,
      [
        randomUUID(), r.clientId, r.platform, r.accountId, r.startedAt.toISOString(), r.ruleset, r.scoped, r.outcome,
        r.reason ? r.reason.slice(0, 240) : null,
        r.summary ? JSON.stringify(r.summary) : null,
      ],
    );
    await c.query(
      `DELETE FROM ads_audit_runs
        WHERE client_id = $1 AND platform = $2 AND account_id = $3
          AND id NOT IN (
            SELECT id FROM ads_audit_runs
             WHERE client_id = $1 AND platform = $2 AND account_id = $3
             ORDER BY ran_at DESC LIMIT ${RUN_KEEP})`,
      [r.clientId, r.platform, r.accountId],
    );
    return null;
  } catch (e) {
    return `run record not written: ${failureReason(e)}`;
  }
}


/**
 * Close the rows a sharper finding replaced.
 *
 * WHY THIS IS NOT LEFT TO `sweepResolved`. That function closes anything that
 * stopped being produced with "No longer present in the account — the
 * condition cleared on its own." For a superseded row that sentence is false
 * twice over: the condition did not clear, and the row did not go away for
 * want of evidence. Somebody working the queue would read it as fixed.
 *
 * So this runs FIRST, names the row that took its place, and writes the same
 * event history every other decision writes. The sweep afterwards finds the
 * row already dismissed and leaves it alone.
 *
 * A row already APPROVED, APPLIED or MEASURED is never touched — a person
 * acted on it and this is not a machine's decision to undo.
 */
export async function supersedeFindings(
  c: pg.Client,
  clientId: string,
  platform: string,
  accountId: string,
  items: { entityId: string; findingType: string; reason: string }[],
  actor: Actor,
): Promise<ClosedRecord[]> {
  const closed: ClosedRecord[] = [];
  for (const it of items) {
    const { rows } = await c.query<{ id: string; title: string }>(
      `UPDATE ads_findings
          SET status = 'dismissed', dismissed_by = $5, dismissed_at = now(), dismissed_reason = $6
        WHERE client_id = $1 AND platform = $2 AND account_id = $3
          AND entity_id = $4 AND finding_type = $7
          AND status IN ('open','proposed')
        RETURNING id, title`,
      [clientId, platform, accountId, it.entityId, actor, it.reason, it.findingType],
    );
    for (const r of rows) {
      await logEvent(c, r.id, "dismissed", actor, it.reason, null);
      closed.push({ id: r.id, title: r.title, why: "replaced" });
    }
  }
  return closed;
}

export async function logEvent(
  c: pg.Client,
  findingId: string,
  action: string,
  actor: Actor,
  note: string | null,
  detailJson: string | null,
): Promise<void> {
  await c.query(
    `INSERT INTO ads_finding_events (id, finding_id, action, actor, note, detail_json)
     VALUES ($6, $1, $2, $3, $4, $5)`,
    [findingId, action, actor, note, detailJson, randomUUID()],
  );
}

/** Every client with an enabled, populated mapping for a platform. */
export async function mappedAccounts(
  c: pg.Client,
  source: string,
  onlyClient?: string,
): Promise<{ clientId: string; clientName: string; accountId: string }[]> {
  const { rows } = await c.query<{ id: string; name: string; external_id: string }>(
    `SELECT c.id, c.name, cm.external_id
       FROM clients c
       JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source = $1 AND cm.enabled = true
      WHERE cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''
        AND c.status IN ('launch','active')
      ORDER BY c.name`,
    [source],
  );
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const want = slugify(onlyClient ?? "");
  return rows
    .filter((r) => !onlyClient || slugify(r.name).startsWith(want) || r.external_id.replace(/\D/g, "") === onlyClient.replace(/\D/g, ""))
    .map((r) => ({ clientId: r.id, clientName: r.name, accountId: r.external_id.trim() }));
}

/**
 * Client-protected terms: brand and partner words we must never block.
 *
 * Read from the client's aliases plus its own name, so a client called
 * "Ohio Community Health" can never have "ohio community health" negated by an
 * automated proposal. This is belt and braces — the apply path refuses these
 * again at mutation time — but catching it at detection means the finding never
 * reaches a human's screen looking like a good idea.
 */
/**
 * The client's own name, aliases and domain label, lowercased, and NOTHING the
 * client had to type. `protectedPatternsFor` below is this list plus the terms
 * collected from the client (partners, sister brands, a competitor term they
 * bid on deliberately). The landing-page check needs only the first half: the
 * front page is right for a search for the company, and is not automatically
 * right for a search for a partner. NULL where the client could not be read —
 * unanswered, never an empty brand.
 */
export async function brandPatternsFor(c: pg.Client, clientId: string): Promise<string[] | null> {
  try {
    return await derivedBrandPatternsFor(c, clientId);
  } catch {
    return null;
  }
}

/**
 * Other providers' names somebody typed for this client
 * (`clients.ads_competitor_terms`, dashboard schema v231, typed on the client's
 * Ads tab). NULL covers every way of not having an answer: the column is not
 * deployed yet, the read failed, nobody typed anything. It is never an empty
 * list, because an empty list would say somebody looked and the client has no
 * rivals.
 */
export async function competitorNamesFor(c: pg.Client, clientId: string): Promise<string[] | null> {
  try {
    const { rows } = await c.query<{ ads_competitor_terms: string | null }>(
      `SELECT ads_competitor_terms FROM clients WHERE id = $1`, [clientId],
    );
    return parseCompetitorNames(rows[0]?.ads_competitor_terms ?? null);
  } catch {
    return null;
  }
}

/** THROWS on a failed read, unlike `brandPatternsFor`. The protected-term guard
 *  must never lose the client's own name to a swallowed error: a protected list
 *  that silently comes back empty is a guard that is off. */
async function derivedBrandPatternsFor(c: pg.Client, clientId: string): Promise<string[] | null> {
  const { rows } = await c.query<{ name: string; aliases: string | null; seo_domain: string | null }>(
    `SELECT name, aliases, seo_domain FROM clients WHERE id = $1`, [clientId],
  );
  const r = rows[0];
  if (!r) return null;
  return derivedBrandPatterns(r);
}

/** Pure. A client row in, the brand patterns out. Exported so a guard can drive it. */
export function derivedBrandPatterns(r: { name: string; aliases: string | null; seo_domain: string | null }): string[] {
  const out = new Set<string>();
  const add = (v: string | null | undefined) => {
    const t = (v ?? "").trim().toLowerCase();
    if (t.length >= 3) out.add(t);
  };
  add(r.name);
  for (const a of (r.aliases ?? "").split(",")) add(a);
  // The bare domain label ("ohiocommunityhealth" from ohiocommunityhealth.com)
  // catches branded queries typed as a URL.
  if (r.seo_domain) add(r.seo_domain.replace(/^www\./, "").split(".")[0]);
  return Array.from(out);
}

export async function protectedPatternsFor(c: pg.Client, clientId: string): Promise<string[]> {
  const derived = await derivedBrandPatternsFor(c, clientId);
  if (derived == null) return [];
  const out = new Set<string>(derived);
  // The half we cannot derive: partners, sister brands, product names the
  // client owns, competitor terms they bid on deliberately. Collected by the
  // "Protected terms collected from the client" launch step into
  // clients.ads_protected_terms (dashboard schema v163). This is the SAME
  // source of truth as the derived patterns, not a second one — one function
  // still answers "what may never be blocked for this client", and the apply
  // path keeps refusing a collision at mutation time regardless.
  for (const t of await collectedProtectedTerms(c, clientId)) {
    const v = t.trim().toLowerCase();
    if (v.length >= 3) out.add(v);
  }
  return Array.from(out);
}

/** clients.ads_protected_terms, one term per line or comma-separated. Returns
 *  nothing (rather than throwing) on a database that predates the column, so a
 *  worker deploy never has to be lock-stepped with a dashboard deploy. */
async function collectedProtectedTerms(c: pg.Client, clientId: string): Promise<string[]> {
  try {
    const { rows } = await c.query<{ ads_protected_terms: string | null }>(
      `SELECT ads_protected_terms FROM clients WHERE id = $1`, [clientId],
    );
    return (rows[0]?.ads_protected_terms ?? "")
      .split(/[\n,]/)
      .map((t) => t.trim().toLowerCase())
      // Mirrors parseProtectedTerms in the dashboard's shared/ads-findings.ts:
      // a one- or two-character term matches inside almost every query, and the
      // guard is a whole-run ABORT rather than a filter, so junk here is
      // expensive. Dropped rather than honoured.
      .filter((t) => t.length >= 3);
  } catch {
    return [];
  }
}

/**
 * Did the CLIENT agree to us changing this ad account?
 *
 * "unrecorded" (the column being NULL, which is where every client starts) is
 * NOT a soft yes — it behaves exactly like "reporting_only". Our manager link
 * grants write access to every account whether or not the client ever wanted
 * us using it, so the absence of an answer has to mean no; anything else makes
 * the default state of the system "we may change a stranger's budget".
 *
 * Mirrors ADS_WRITE_AUTHORITIES / adsWritesAllowed in the dashboard's
 * shared/ads-findings.ts. Read defensively: on a database without the column
 * the answer is "unrecorded", i.e. read-only, which is the safe direction.
 */
export async function adsWriteAuthorityFor(
  c: pg.Client,
  clientId: string,
): Promise<{ allowed: boolean; value: string; clientName: string }> {
  const { rows: nameRows } = await c.query<{ name: string }>(`SELECT name FROM clients WHERE id = $1`, [clientId]);
  const clientName = nameRows[0]?.name ?? clientId;
  let value = "unrecorded";
  try {
    const { rows } = await c.query<{ ads_write_authority: string | null }>(
      `SELECT ads_write_authority FROM clients WHERE id = $1`, [clientId],
    );
    const raw = (rows[0]?.ads_write_authority ?? "").trim();
    if (raw === "reporting_only" || raw === "changes") value = raw;
  } catch {
    /* column not deployed yet → unrecorded → read-only */
  }
  return { allowed: value === "changes", value, clientName };
}

/**
 * What the client has recorded about what a customer is worth to them.
 *
 * This is the half of the rules engine nothing was feeding: every threshold in
 * it was a flat number, so a campaign read identically whether it was hitting
 * the client's cost-per-lead target or running at three times it.
 *
 * Read defensively, column by column, so a worker deploy is never lock-stepped
 * with a dashboard deploy — and read as NULL rather than nought wherever the
 * answer is missing.
 *
 * THE ONE TRAP IS `client_targets.cpl_ceiling_cents`. That column is
 * `DEFAULT 0`, the dialog that writes it says "leave a field at 0 to skip it",
 * and the health score already reads a nought there as "no target set". So a
 * nought is resolved to null HERE, once, and nothing downstream ever sees it —
 * a ceiling of nothing is a sentence somebody could mean and this is not how
 * they would say it.
 *
 * The month is the newest row at or before the window's end, matching the
 * dashboard's own `getTargetForMonthOrLatestBefore`: nobody retypes these
 * monthly, so the effective record is whatever was last typed. The month comes
 * back with the figure so a finding can say how old the number it used is.
 */
/**
 * Pure. Why a figure that reads as missing is missing, in the order of how sure
 * the record is. A figure above nought is not missing and gets no reason.
 * `stored` of null is the ordinary blank; a stored nought is "the shape of a
 * blank", named; a person's recorded absence wins over both because it is the
 * only one of the three that is an ANSWER.
 */
export function missingFigureWhy(i: {
  stored: number | null; unknownAt: Date | string | null; unknownBy: string | null; notAsked: boolean;
}): MissingFigureWhy | null {
  if (i.stored != null && Number(i.stored) > 0) return null;
  if (i.unknownAt != null) {
    const at = i.unknownAt instanceof Date ? i.unknownAt.toISOString() : String(i.unknownAt);
    return { kind: "recorded_absent", by: (i.unknownBy ?? "").trim() || null, at: at.slice(0, 10) };
  }
  if (i.stored != null) return { kind: "stored_as_nought" };
  if (i.notAsked) return { kind: "not_asked" };
  return null;
}

export async function clientEconomicsFor(
  c: pg.Client,
  clientId: string,
  windowEnd: string,
): Promise<ClientEconomics> {
  const out: ClientEconomics = {
    customerValueCents: null,
    customerValueFromClient: false,
    closeRatePct: null,
    cplCeilingCents: null,
    cplCeilingMonth: null,
    adBudgetMonthlyCents: null,
    adBudgetMonth: null,
  };

  try {
    const { rows } = await c.query<{
      customer_value_cents: number | null;
      customer_value_source: string | null;
      close_rate_pct: number | null;
    }>(
      `SELECT customer_value_cents, customer_value_source, close_rate_pct
         FROM clients WHERE id = $1`,
      [clientId],
    );
    const r = rows[0];
    if (r) {
      out.customerValueCents = r.customer_value_cents != null && r.customer_value_cents > 0
        ? Number(r.customer_value_cents) : null;
      out.customerValueFromClient = Boolean((r.customer_value_source ?? "").trim());
      out.closeRatePct = r.close_rate_pct != null && Number(r.close_rate_pct) > 0
        ? Number(r.close_rate_pct) : null;
    }
  } catch {
    /* column not deployed → unanswered, which is the safe reading */
  }

  // WHY a figure that is missing is missing, read separately so a database
  // without these columns still returns the figures above. See `MissingFigureWhy`.
  try {
    const { rows } = await c.query<{
      close_rate_pct: number | null; customer_value_cents: number | null; revenue_model: string | null;
      close_rate_unknown_at: Date | string | null; close_rate_unknown_by: string | null;
      customer_value_unknown_at: Date | string | null; customer_value_unknown_by: string | null;
    }>(
      `SELECT close_rate_pct, customer_value_cents, revenue_model,
              close_rate_unknown_at, close_rate_unknown_by,
              customer_value_unknown_at, customer_value_unknown_by
         FROM clients WHERE id = $1`,
      [clientId],
    );
    const r = rows[0];
    if (r) {
      out.closeRateWhy = missingFigureWhy({
        stored: r.close_rate_pct, unknownAt: r.close_rate_unknown_at, unknownBy: r.close_rate_unknown_by,
        notAsked: r.revenue_model === "retainer",
      });
      out.customerValueWhy = missingFigureWhy({
        stored: r.customer_value_cents, unknownAt: r.customer_value_unknown_at, unknownBy: r.customer_value_unknown_by,
        notAsked: false,
      });
    }
  } catch {
    /* not deployed → the sentence says what it always said */
  }

  try {
    const month = windowEnd.slice(0, 7);
    const { rows } = await c.query<{ month: string; cpl_ceiling_cents: number | null }>(
      `SELECT month, cpl_ceiling_cents FROM client_targets
        WHERE client_id = $1 AND month <= $2
        ORDER BY month DESC LIMIT 1`,
      [clientId, month],
    );
    const r = rows[0];
    if (r && r.cpl_ceiling_cents != null && Number(r.cpl_ceiling_cents) > 0) {
      out.cplCeilingCents = Number(r.cpl_ceiling_cents);
      out.cplCeilingMonth = r.month;
    }
  } catch {
    /* table not deployed → unanswered */
  }

  // THE AD BUDGET THE CLIENT APPROVED. Same table, same trap: `ad_budget_cents`
  // is `DEFAULT 0` and a nought there is a blank, so it is resolved to null
  // here and nothing downstream sees a nought. Read from its OWN newest
  // non-nought row rather than the ceiling's row, because the two are typed
  // independently and the newest row for one may have left the other blank.
  try {
    const month = windowEnd.slice(0, 7);
    const { rows } = await c.query<{ month: string; ad_budget_cents: number | null }>(
      `SELECT month, ad_budget_cents FROM client_targets
        WHERE client_id = $1 AND month <= $2 AND ad_budget_cents > 0
        ORDER BY month DESC LIMIT 1`,
      [clientId, month],
    );
    const r = rows[0];
    if (r && r.ad_budget_cents != null && Number(r.ad_budget_cents) > 0) {
      out.adBudgetMonthlyCents = Number(r.ad_budget_cents);
      out.adBudgetMonth = r.month;
    }
  } catch {
    /* column not deployed → unanswered */
  }

  return out;
}

/**
 * What the record already holds about this client's leads becoming customers.
 *
 * Every row read here is one this system already writes: `web_inquiries` (the
 * leads and their click ids), `lead_attributions` (what the client's CRM did
 * with them, written daily by match-web-leads-to-crm) and
 * `offline_conversion_uploads` (what has already been sent back to a platform).
 * No ad platform is contacted and nothing is written.
 *
 * THE WON WINDOW IS DELIBERATELY LONGER THAN THE EVIDENCE WINDOW. A deal closes
 * months after the click, so counting wins over the same 90 days the campaign
 * metrics cover would read a healthy account as having none. Six months is used
 * and the month count travels with the number so the rate can be stated rather
 * than implied.
 *
 * Sample and suspected-sample rows are excluded on the same rule the
 * attribution chain uses: `is_sample` is confirmed demo data and never counts.
 */
/** Pure. The three counts of the lead split from one query row; forms are
 *  what is left after the calls and the unnamed are taken out, so the three
 *  always add to the total. Exported so a guard can drive it. */
export function splitOf(l: {
  leads: string; gclid_leads: string; calls: string; blank: string; gclid_calls: string; gclid_blank: string;
}): NonNullable<OutcomeFeedFacts["split"]> {
  const total = Number(l.leads), calls = Number(l.calls), blank = Number(l.blank);
  const gTotal = Number(l.gclid_leads), gCalls = Number(l.gclid_calls), gBlank = Number(l.gclid_blank);
  return {
    forms: total - calls - blank, calls, unclassified: blank,
    gclidForms: gTotal - gCalls - gBlank, gclidCalls: gCalls, gclidUnclassified: gBlank,
  };
}

export async function outcomeFeedFactsFor(
  c: pg.Client,
  clientId: string,
  clientSlug: string,
  windowStart: string,
  windowEnd: string,
): Promise<OutcomeFeedFacts | null> {
  const WON_WINDOW_MONTHS = 6;
  try {
    // The split rests on ONE column: a tracked call's form name is the label
    // `Phone: …`, matched the way the dashboard's `feedOf` matches it (case
    // insensitive, tolerant of spaces around the colon), and a row with no form
    // name is neither a form nor a call. Nothing else on the row is consulted.
    const isCall = `coalesce(form_name, '') ~* '^\\s*phone\\s*:'`;
    const isBlank = `nullif(btrim(coalesce(form_name, '')), '') IS NULL`;
    const hasClick = `nullif(btrim(gclid), '') IS NOT NULL`;
    const { rows: leadRows } = await c.query<{
      leads: string; gclid_leads: string; newest: string | null;
      calls: string; blank: string; gclid_calls: string; gclid_blank: string;
    }>(
      `SELECT count(*)::text AS leads,
              count(*) FILTER (WHERE ${hasClick})::text AS gclid_leads,
              max(submitted_at) FILTER (WHERE ${hasClick})::date::text AS newest,
              count(*) FILTER (WHERE ${isCall})::text AS calls,
              count(*) FILTER (WHERE NOT (${isCall}) AND ${isBlank})::text AS blank,
              count(*) FILTER (WHERE ${isCall} AND ${hasClick})::text AS gclid_calls,
              count(*) FILTER (WHERE NOT (${isCall}) AND ${isBlank} AND ${hasClick})::text AS gclid_blank
         FROM web_inquiries
        WHERE client_slug = $1
          AND submitted_at >= $2::date AND submitted_at < ($3::date + 1)
          AND status NOT IN ('junk', 'internal_test')`,
      [clientSlug, windowStart, windowEnd],
    );
    const l = leadRows[0];

    const { rows: crmRows } = await c.query<{ matched: string; won: string; avg_value: string | null }>(
      `SELECT count(*) FILTER (WHERE web_inquiry_at >= $2)::text AS matched,
              count(*) FILTER (WHERE stage = 'won' AND won_on >= $3)::text AS won,
              avg(value_cents) FILTER (WHERE stage = 'won' AND won_on >= $3 AND value_cents IS NOT NULL)::text AS avg_value
         FROM lead_attributions
        WHERE client_id = $1 AND web_inquiry_id IS NOT NULL AND NOT is_sample`,
      [
        clientId,
        windowStart,
        new Date(Date.now() - WON_WINDOW_MONTHS * 30 * 86_400_000).toISOString().slice(0, 10),
      ],
    );
    const r = crmRows[0];

    const { rows: upRows } = await c.query<{ n: string; newest: string | null }>(
      `SELECT count(*)::text AS n, max(uploaded_at)::date::text AS newest
         FROM offline_conversion_uploads WHERE client_slug = $1`,
      [clientSlug],
    );
    const u = upRows[0];

    const avg = r?.avg_value != null ? Math.round(Number(r.avg_value)) : null;
    return {
      leadsInWindow: Number(l?.leads ?? 0),
      gclidLeadsInWindow: Number(l?.gclid_leads ?? 0),
      newestGclidLeadOn: l?.newest ?? null,
      split: l ? splitOf(l) : null,
      windowStart, windowEnd,
      crmRowsInWindow: Number(r?.matched ?? 0),
      wonInWindow: Number(r?.won ?? 0),
      wonWindowMonths: WON_WINDOW_MONTHS,
      measuredWonValueCents: Number.isFinite(avg as number) ? avg : null,
      uploadsEver: Number(u?.n ?? 0),
      newestUploadOn: u?.newest ?? null,
    };
  } catch {
    // A table this deploy does not have yet reads as "not gathered", which the
    // reading treats as unknown rather than as an account with no outcomes.
    return null;
  }
}

// ── What this client actually sells ──────────────────────────────────────────
/**
 * The CONFIRMED services list, and only the confirmed one.
 *
 * `client_services` also holds candidates this system derived from the client's
 * own SEO targets, their converting queries and their campaign names — and not
 * one of them is returned here. A derived candidate is a guess, and letting the
 * seed double as the answer is how nobody ever confirms a list and the
 * "recorded" services become the guess wearing a better label. The gate is
 * `confirmed_at IS NOT NULL` on the row AND `clients.services_confirmed_at` on
 * the account: the first says somebody put this service there, the second says
 * somebody looked at the whole list. A list nobody has reviewed as a whole is
 * one ticked service and a wander off.
 *
 * A NULL `services` means nobody has confirmed a list, which the keyword-gap
 * reading refuses on. It is never [] — an empty array would say somebody
 * looked and recorded none, which is a different answer.
 */
export async function clientServicesFor(
  c: pg.Client,
  clientId: string,
): Promise<ClientServiceFacts> {
  const none: ClientServiceFacts =
    { services: null, confirmedBy: null, confirmedAt: null, candidatesWaiting: 0 };
  try {
    const { rows: clientRows } = await c.query<{ by: string | null; at: string | null }>(
      `SELECT services_confirmed_by AS by, services_confirmed_at::date::text AS at
         FROM clients WHERE id = $1`,
      [clientId],
    );
    const stamp = clientRows[0];

    // ONLY WHAT THEY SELL. `stance` (v198) records three different things: a
    // service they offer, one their own site says they do NOT offer, and one
    // somebody looked for and found no sign of. Reading all three as "their
    // services" fed the second list into the keyword-gap rule as a SEED — so a
    // clinic that refers detox out would have had research expanded from
    // "detox", which is the one row that discredits the whole page. The second
    // list's own job, suppression, is unchanged and is done in the dashboard.
    const { rows } = await c.query<{ name: string; note: string | null; confirmed: boolean }>(
      `SELECT name, note, (confirmed_at IS NOT NULL) AS confirmed
         FROM client_services
        WHERE client_id = $1 AND active = true AND stance = 'offers'
        ORDER BY sort_order ASC, name ASC`,
      [clientId],
    );
    const waiting = rows.filter((r) => !r.confirmed).length;
    if (!stamp?.at) return { ...none, candidatesWaiting: waiting };
    const confirmed = rows.filter((r) => r.confirmed);
    if (confirmed.length === 0) return { ...none, candidatesWaiting: waiting };
    return {
      services: confirmed.map((r) => ({ name: r.name, note: r.note })),
      confirmedBy: stamp.by ?? null,
      confirmedAt: stamp.at,
      candidatesWaiting: waiting,
    };
  } catch {
    // A table or column this deploy does not have yet reads as "nobody has
    // confirmed a list", which produces no gap rows and says so.
    return none;
  }
}

// ── The client's OWN keyword list ────────────────────────────────────────────
/**
 * The keywords somebody put on this client's rank-tracking list.
 *
 * `seo_targets` is written by the dashboard — an AM types them on the client's
 * SEO tab, or ticks them out of a research pull — and the worker's `import-seo`
 * job has pulled a rank for each of them every week since. It is the only list
 * in this system that is a PERSON'S ANSWER about which searches matter for this
 * client, and until 2026-09-30 nothing in the ads path read it: the keyword-gap
 * rule seeded from service NAMES, and the research panel loaded this very list
 * only to strike out rows it already held.
 *
 * NULL MEANS THE READ FAILED, never that the list is empty. A client who has
 * chosen no keywords is [] and has its own sentence; the two lead to different
 * acts, so they are never collapsed. A table this deploy does not have reads as
 * null for the same reason `clientServicesFor` swallows its own error.
 *
 * `active = true` only: a target somebody removed is not a chosen keyword any
 * more. BOTH report statuses are returned — 'baseline' governs what may be
 * CLAIMED in the aggregate rank metrics, not whether a person chose the term.
 */
export async function seoTargetsFor(
  c: pg.Client,
  clientId: string,
): Promise<RecordedTarget[] | null> {
  try {
    const { rows } = await c.query<{ keyword: string; tag: string | null; report_status: string | null }>(
      `SELECT keyword, tag, report_status
         FROM seo_targets
        WHERE client_id = $1 AND active = true
        ORDER BY keyword ASC`,
      [clientId],
    );
    return rows
      .map((r) => ({ keyword: String(r.keyword ?? "").trim(), tag: r.tag, reportStatus: r.report_status }))
      .filter((t) => t.keyword.length > 0);
  } catch {
    return null;
  }
}

// ── The keyword research already on record ───────────────────────────────────
/**
 * The newest completed research run for this client.
 *
 * NOTHING HERE CALLS DATAFORSEO. `research_requests` is filled by the worker's
 * own `run-research` job, which an account manager starts from the client's SEO
 * tab; this is a Postgres read of what that job stored. The rows are
 * `DiscoveryKeyword`s as the dashboard's shared/schema.ts declares them, and
 * the mapping to `ResearchKeyword` is the one place the shapes meet.
 *
 * Only `kind = 'discovery'`, because that is the only kind scoped to a client
 * AND carrying the client's own organic position per term. `ideas` and `gap`
 * runs are keyed to a seed or a competitor rather than to an account, so a
 * keyword-gap reading built on one would be reading somebody else's research.
 */
export async function researchFactsFor(
  c: pg.Client,
  clientId: string,
): Promise<ResearchFacts | null> {
  try {
    const { rows } = await c.query<{
      result_json: string | null; params_json: string | null;
      location_name: string | null; ran: string | null;
    }>(
      `SELECT result_json, params_json, location_name, completed_at::date::text AS ran
         FROM research_requests
        WHERE client_id = $1 AND kind = 'discovery' AND status = 'done'
          AND result_json IS NOT NULL
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 1`,
      [clientId],
    );
    const r = rows[0];
    if (!r?.result_json) return null;

    let parsed: unknown;
    try { parsed = JSON.parse(r.result_json); } catch { return null; }
    if (!Array.isArray(parsed)) return null;

    let seeds: string[] = [];
    if (r.params_json) {
      try {
        const p = JSON.parse(r.params_json) as { seeds?: unknown };
        if (Array.isArray(p?.seeds)) seeds = p.seeds.filter((x): x is string => typeof x === "string");
      } catch { /* an unreadable params blob costs the seeds line and nothing else */ }
    }

    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    const keywords: ResearchKeyword[] = parsed
      .map((raw): ResearchKeyword | null => {
        const k = raw as Record<string, unknown>;
        const keyword = typeof k?.keyword === "string" ? k.keyword.trim() : "";
        if (!keyword) return null;
        return {
          keyword,
          volume: num(k.volume),
          // DataForSEO reports cost per click in the currency of the location,
          // as a plain number of DOLLARS. This is the one place that unit
          // crosses into this engine, and it crosses once.
          cpcDollars: num(k.cpc),
          difficulty: num(k.difficulty),
          intent: typeof k.intent === "string" ? k.intent : null,
          clientRank: num(k.clientRank),
          competitorRank: num(k.competitorRank),
        };
      })
      .filter((k): k is ResearchKeyword => k != null);

    return { keywords, ranAt: r.ran ?? null, location: r.location_name ?? null, seeds };
  } catch {
    return null;
  }
}

// ── How this client's enquiries actually arrive ──────────────────────────────
/**
 * Phone leads against every lead, over the window.
 *
 * `web_inquiries.form_name` is where a call lands: the dashboard's
 * `server/webform.ts` labels a post from a call-tracking webhook
 * `Phone: <source>` and a real form submission with the form's own name, so the
 * prefix is the recorded distinction rather than an inference from a name.
 *
 * NULL EVERYWHERE MEANS NOT READ. An account whose lead feed could not be read
 * must not report that none of its enquiries are calls.
 */
export async function phoneDemandFor(
  c: pg.Client,
  clientSlug: string,
  windowStart: string,
  windowEnd: string,
): Promise<PhoneDemandFacts | null> {
  try {
    const { rows } = await c.query<{ total: string; phone: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE form_name LIKE 'Phone:%')::text AS phone
         FROM web_inquiries
        WHERE client_slug = $1
          AND submitted_at >= $2::date AND submitted_at < ($3::date + 1)
          AND status NOT IN ('junk', 'internal_test')`,
      [clientSlug, windowStart, windowEnd],
    );
    const r = rows[0];
    if (!r) return null;
    return { totalLeads: Number(r.total), phoneLeads: Number(r.phone) };
  } catch {
    return null;
  }
}

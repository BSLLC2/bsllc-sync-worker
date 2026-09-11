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
import { evidenceHash, materiallyChanged, ADS_RULESET_VERSION, type DerivedFinding } from "./rules.js";

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
  const evidenceJson = JSON.stringify(f.evidence);
  const changePayloadJson = f.changePayload ? JSON.stringify(f.changePayload) : null;
  // A finding with a ready payload is already a proposal — there is nothing
  // further for a machine to do to it, so it goes straight to 'proposed' and
  // the only missing ingredient is a person.
  const freshStatus = f.changePayload ? "proposed" : "open";

  const { rows: existingRows } = await c.query<{
    id: string; status: string; evidence_hash: string | null; times_seen: number;
  }>(
    `SELECT id, status, evidence_hash, times_seen FROM ads_findings
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
         change_payload_json, guard_note, ruleset_version, proposed_at
       ) VALUES (
         $24, $1,$2,$3,$4,$5,$6,$7,
         $8,$9,$10,$11,$12,$13,
         $14,$15,$16,$17,
         $18,$19,$20,
         $21,$22,$23, CASE WHEN $21::text IS NULL THEN NULL ELSE now() END
       ) RETURNING id`,
      [
        clientId, platform, accountId, f.entityType, f.entityId, f.entityName, f.findingType,
        freshStatus, f.severity, f.riskLevel, f.applicability, f.title, f.summary,
        evidenceJson, hash, f.evidence.windowStart, f.evidence.windowEnd,
        f.estImpactCents, f.impactUnit, f.impactAssumption,
        changePayloadJson, f.guardNote, ADS_RULESET_VERSION, randomUUID(),
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
    if (!materiallyChanged(existing.evidence_hash, hash)) {
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
         last_seen_at = now(), times_seen = times_seen + 1,
         dismissed_by = NULL, dismissed_at = NULL, dismissed_reason = NULL,
         proposed_at = CASE WHEN $15::text IS NULL THEN NULL ELSE now() END
       WHERE id = $1`,
      [
        existing.id, freshStatus, f.severity, f.riskLevel, f.applicability,
        f.title, f.summary, evidenceJson, hash, f.evidence.windowStart, f.evidence.windowEnd,
        f.estImpactCents, f.impactUnit, f.impactAssumption,
        changePayloadJson, f.guardNote, ADS_RULESET_VERSION,
      ],
    );
    await logEvent(
      c, existing.id, "reopened", actor,
      `Evidence moved since it was dismissed — re-raised for another look.`,
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
       last_seen_at = now(), times_seen = times_seen + 1,
       proposed_at = CASE WHEN $15::text IS NULL THEN NULL ELSE COALESCE(proposed_at, now()) END
     WHERE id = $1`,
    [
      existing.id, freshStatus, f.severity, f.riskLevel, f.applicability,
      f.title, f.summary, evidenceJson, hash, f.evidence.windowStart, f.evidence.windowEnd,
      f.estImpactCents, f.impactUnit, f.impactAssumption,
      changePayloadJson, f.guardNote, ADS_RULESET_VERSION,
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
  stillPresentIds: string[],
  actor: Actor,
): Promise<number> {
  const { rows } = await c.query<{ id: string; title: string }>(
    `SELECT id, title FROM ads_findings
      WHERE client_id = $1 AND platform = $2 AND account_id = $3
        AND status IN ('open','proposed')
        AND NOT (entity_id = ANY($4::text[]))`,
    [clientId, platform, accountId, stillPresentIds],
  );
  for (const r of rows) {
    await c.query(
      `UPDATE ads_findings
          SET status = 'dismissed', dismissed_by = $2, dismissed_at = now(),
              dismissed_reason = 'No longer present in the account — the condition cleared on its own.'
        WHERE id = $1`,
      [r.id, actor],
    );
    await logEvent(c, r.id, "dismissed", actor, "Condition cleared — not seen in the latest audit.", null);
  }
  return rows.length;
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
export async function protectedPatternsFor(c: pg.Client, clientId: string): Promise<string[]> {
  const { rows } = await c.query<{ name: string; aliases: string | null; seo_domain: string | null }>(
    `SELECT name, aliases, seo_domain FROM clients WHERE id = $1`, [clientId],
  );
  const r = rows[0];
  if (!r) return [];
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

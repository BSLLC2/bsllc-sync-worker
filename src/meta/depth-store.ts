/**
 * The Postgres side of the Meta depth reads. Everything here talks to the database
 * and to nothing else: no Meta call, no network.
 *
 * Tables (the dashboard's ensureSchema() makes the same ones; keep the columns
 * identical to server/db.ts):
 *   meta_ad_days       one row per ad per day
 *   meta_segment_days  one row per ad set per day per placement / age / gender
 *   meta_entities      campaign, ad set and ad settings as a daily interval snapshot
 *   meta_scans         one row per account and part: how far the record reaches
 *
 * Beyond the columns the brief named, this file adds `id`, `synced_at` (every table)
 * and `content_hash`, `updated_at` (entities): an interval table cannot tell an
 * unchanged entity from a changed one without a hash.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { addDays, coverageAfter, hasSpan as spanOk } from "../ads/daily-metrics.js";
import {
  PLATFORM, RETAIN_DAYS, metaEntityHash, reconcileEntities,
  type AdDayRow, type EntityPlan, type EntityType, type MetaEntityRow, type OpenEntity, type Part, type SegmentDayRow, type Span,
} from "./depth.js";
import { metaAccountId } from "./insights.js";
import type { DepthEntity, MetaDepthInput, PartState } from "./rules.js";

export async function ensureMetaDepthTables(c: pg.Client): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS meta_ad_days (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, account_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL, adset_id TEXT NOT NULL, ad_id TEXT NOT NULL,
      campaign_name TEXT, adset_name TEXT, ad_name TEXT, day DATE NOT NULL,
      spend_micros BIGINT NOT NULL DEFAULT 0, impressions BIGINT NOT NULL DEFAULT 0,
      reach BIGINT, frequency DOUBLE PRECISION, link_clicks BIGINT,
      conversions DOUBLE PRECISION, conversion_value DOUBLE PRECISION,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_ad_days ON meta_ad_days (client_id, account_id, ad_id, day);
    CREATE INDEX IF NOT EXISTS idx_meta_ad_days_client ON meta_ad_days (client_id, day);
    CREATE TABLE IF NOT EXISTS meta_segment_days (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, account_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL, adset_id TEXT NOT NULL, day DATE NOT NULL,
      kind TEXT NOT NULL, segment TEXT NOT NULL,
      spend_micros BIGINT NOT NULL DEFAULT 0, impressions BIGINT NOT NULL DEFAULT 0,
      link_clicks BIGINT, conversions DOUBLE PRECISION,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_segment_days ON meta_segment_days (client_id, account_id, adset_id, day, kind, segment);
    CREATE INDEX IF NOT EXISTS idx_meta_segment_days_client ON meta_segment_days (client_id, day);
    CREATE TABLE IF NOT EXISTS meta_entities (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, account_id TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, parent_id TEXT, name TEXT,
      status TEXT, effective_status TEXT, daily_budget_micros BIGINT, lifetime_budget_micros BIGINT,
      optimization_goal TEXT, bid_strategy TEXT, attrs_json TEXT, content_hash TEXT,
      valid_from DATE NOT NULL, valid_to DATE, last_seen_on DATE NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    ALTER TABLE meta_entities ADD COLUMN IF NOT EXISTS content_hash TEXT;
    ALTER TABLE meta_entities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_entities_interval ON meta_entities (client_id, account_id, entity_type, entity_id, valid_from);
    CREATE INDEX IF NOT EXISTS idx_meta_entities_open ON meta_entities (client_id, account_id) WHERE valid_to IS NULL;
    CREATE TABLE IF NOT EXISTS meta_scans (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, account_id TEXT NOT NULL, part TEXT NOT NULL,
      covered_from DATE NOT NULL, covered_to DATE NOT NULL, ok BOOLEAN NOT NULL DEFAULT true,
      rows_read INTEGER NOT NULL DEFAULT 0, detail TEXT,
      scanned_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_scans_part ON meta_scans (client_id, account_id, part);`);
}

export interface MetaTarget { clientId: string; clientName: string; accountId: string; rawId: string }

/**
 * Which client uses which Meta ad account: connector_mappings (source 'meta'), the same place the importer
 * reads. Not filtered by client status (a metric is a record of money spent) but a CHURNED client is skipped,
 * as every other reader here does.
 */
export async function metaTargets(c: pg.Client, onlyClient?: string): Promise<MetaTarget[]> {
  const { rows } = await c.query<{ client_id: string; name: string | null; external_id: string }>(
    `SELECT cm.client_id, c.name, cm.external_id
       FROM connector_mappings cm JOIN clients c ON c.id = cm.client_id
      WHERE cm.source = 'meta' AND cm.enabled = true
        AND cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''
        AND COALESCE(c.status, '') <> 'churned'
      ORDER BY c.name`,
  );
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const want = slug(onlyClient ?? "");
  return rows
    .map((r) => ({ clientId: r.client_id, clientName: r.name ?? r.client_id, accountId: metaAccountId(r.external_id), rawId: r.external_id.trim() }))
    .filter((t) => !onlyClient || t.clientId === onlyClient || slug(t.clientName).startsWith(want));
}

export async function loadSpan(c: pg.Client, clientId: string, accountId: string, part: Part): Promise<(Span & { ok: boolean }) | null> {
  const { rows } = await c.query<{ f: string; t: string; ok: boolean }>(
    `SELECT to_char(covered_from,'YYYY-MM-DD') AS f, to_char(covered_to,'YYYY-MM-DD') AS t, ok
       FROM meta_scans WHERE client_id = $1 AND account_id = $2 AND part = $3`,
    [clientId, accountId, part],
  );
  return rows[0] ? { coveredFrom: rows[0].f, coveredTo: rows[0].t, ok: rows[0].ok } : null;
}

async function writeScan(
  c: pg.Client, clientId: string, accountId: string, part: Part, from: string, to: string, ok: boolean, rows: number, detail: string,
): Promise<void> {
  await c.query(
    `INSERT INTO meta_scans (id, client_id, account_id, part, covered_from, covered_to, ok, rows_read, detail, scanned_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (client_id, account_id, part) DO UPDATE SET
       covered_from = EXCLUDED.covered_from, covered_to = EXCLUDED.covered_to, ok = EXCLUDED.ok,
       rows_read = EXCLUDED.rows_read, detail = EXCLUDED.detail, scanned_at = now()`,
    [randomUUID(), clientId, accountId, part, from, to, ok, rows, detail.slice(0, 400)],
  );
}

/** A failed or refused read. The span stays where the last good run left it; a first-ever failure writes an EMPTY span, so the failure is dated and covers nothing. */
export async function recordMetaFailure(
  c: pg.Client, clientId: string, accountId: string, part: Part, today: string, why: string,
): Promise<void> {
  const prev = await loadSpan(c, clientId, accountId, part);
  await c.query(
    `INSERT INTO meta_scans (id, client_id, account_id, part, covered_from, covered_to, ok, rows_read, detail, scanned_at)
     VALUES ($1,$2,$3,$4,$5,$6, false, 0, $7, now())
     ON CONFLICT (client_id, account_id, part) DO UPDATE SET ok = false, detail = EXCLUDED.detail, scanned_at = now()`,
    [randomUUID(), clientId, accountId, part, today, addDays(today, -1), `read failed: ${why}`.slice(0, 400)],
  );
  void prev;
}

/** Replace the window's ad days and move the span, in one transaction. */
export async function storeAdDays(
  c: pg.Client, clientId: string, accountId: string, rows: readonly AdDayRow[], window: { start: string; end: string },
): Promise<{ coveredFrom: string; restarted: boolean }> {
  await c.query("BEGIN");
  try {
    await c.query(`DELETE FROM meta_ad_days WHERE client_id = $1 AND account_id = $2 AND day BETWEEN $3 AND $4`, [clientId, accountId, window.start, window.end]);
    for (const r of rows) {
      await c.query(
        `INSERT INTO meta_ad_days (id, client_id, account_id, campaign_id, adset_id, ad_id, campaign_name, adset_name, ad_name, day,
           spend_micros, impressions, reach, frequency, link_clicks, conversions, conversion_value, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())`,
        [randomUUID(), clientId, accountId, r.campaignId, r.adsetId, r.adId, r.campaignName, r.adsetName, r.adName, r.day,
          r.spendMicros, r.impressions, r.reach, r.frequency, r.linkClicks, r.conversions, r.conversionValue],
      );
    }
    await c.query(`DELETE FROM meta_ad_days WHERE client_id = $1 AND account_id = $2 AND day < $3`, [clientId, accountId, addDays(window.end, -RETAIN_DAYS)]);
    const prev = await loadSpan(c, clientId, accountId, "ad_days");
    const cov = coverageAfter(spanOk(prev) ? prev : null, window);
    await writeScan(c, clientId, accountId, "ad_days", cov.coveredFrom, window.end, true, rows.length, `${rows.length} ad-days, ${window.start} to ${window.end}`);
    await c.query("COMMIT");
    return cov;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

export async function storeSegmentDays(
  c: pg.Client, clientId: string, accountId: string, rows: readonly SegmentDayRow[], window: { start: string; end: string },
): Promise<{ coveredFrom: string; restarted: boolean }> {
  await c.query("BEGIN");
  try {
    await c.query(`DELETE FROM meta_segment_days WHERE client_id = $1 AND account_id = $2 AND day BETWEEN $3 AND $4`, [clientId, accountId, window.start, window.end]);
    for (const r of rows) {
      await c.query(
        `INSERT INTO meta_segment_days (id, client_id, account_id, campaign_id, adset_id, day, kind, segment, spend_micros, impressions, link_clicks, conversions, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())`,
        [randomUUID(), clientId, accountId, r.campaignId, r.adsetId, r.day, r.kind, r.segment, r.spendMicros, r.impressions, r.linkClicks, r.conversions],
      );
    }
    await c.query(`DELETE FROM meta_segment_days WHERE client_id = $1 AND account_id = $2 AND day < $3`, [clientId, accountId, addDays(window.end, -RETAIN_DAYS)]);
    const prev = await loadSpan(c, clientId, accountId, "segments");
    const cov = coverageAfter(spanOk(prev) ? prev : null, window);
    await writeScan(c, clientId, accountId, "segments", cov.coveredFrom, window.end, true, rows.length, `${rows.length} segment-days, ${window.start} to ${window.end}`);
    await c.query("COMMIT");
    return cov;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

export async function loadOpenEntities(c: pg.Client, clientId: string, accountId: string): Promise<OpenEntity[]> {
  const { rows } = await c.query<{ id: string; entity_type: string; entity_id: string; content_hash: string | null; vf: string; ls: string }>(
    `SELECT id, entity_type, entity_id, content_hash, to_char(valid_from,'YYYY-MM-DD') AS vf, to_char(last_seen_on,'YYYY-MM-DD') AS ls
       FROM meta_entities WHERE client_id = $1 AND account_id = $2 AND valid_to IS NULL`,
    [clientId, accountId],
  );
  return rows.map((r) => ({ id: r.id, entityType: r.entity_type as EntityType, entityId: r.entity_id, contentHash: r.content_hash ?? "", validFrom: r.vf, lastSeenOn: r.ls }));
}

/** Apply an entity plan, and move the entities scan, in one transaction. */
export async function applyEntityPlan(
  c: pg.Client, clientId: string, accountId: string, plan: EntityPlan, on: string, readCount: number, note: string,
): Promise<void> {
  await c.query("BEGIN");
  try {
    for (const t of plan.touches) await c.query(`UPDATE meta_entities SET last_seen_on = $2, updated_at = now() WHERE id = $1`, [t.id, on]);
    for (const cl of plan.closes) await c.query(`UPDATE meta_entities SET valid_to = $2, updated_at = now() WHERE id = $1 AND valid_to IS NULL`, [cl.id, cl.validTo]);
    for (const r of plan.replaces) {
      const e = r.entity;
      await c.query(
        `UPDATE meta_entities SET parent_id=$2, name=$3, status=$4, effective_status=$5, daily_budget_micros=$6, lifetime_budget_micros=$7,
           optimization_goal=$8, bid_strategy=$9, attrs_json=$10, content_hash=$11, last_seen_on=$12, updated_at=now() WHERE id=$1`,
        [r.id, e.parentId, e.name, e.status, e.effectiveStatus, e.dailyBudgetMicros, e.lifetimeBudgetMicros, e.optimizationGoal, e.bidStrategy, JSON.stringify(e.attrs), r.hash, on],
      );
    }
    for (const o of plan.opens) {
      const e = o.entity;
      await c.query(
        `INSERT INTO meta_entities (id, client_id, account_id, entity_type, entity_id, parent_id, name, status, effective_status,
           daily_budget_micros, lifetime_budget_micros, optimization_goal, bid_strategy, attrs_json, content_hash, valid_from, valid_to, last_seen_on, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NULL,$17, now())
         ON CONFLICT (client_id, account_id, entity_type, entity_id, valid_from) DO NOTHING`,
        [randomUUID(), clientId, accountId, e.entityType, e.entityId, e.parentId, e.name, e.status, e.effectiveStatus,
          e.dailyBudgetMicros, e.lifetimeBudgetMicros, e.optimizationGoal, e.bidStrategy, JSON.stringify(e.attrs), o.hash, on, on],
      );
    }
    // A snapshot is a DATE, so its span is the one day.
    await writeScan(c, clientId, accountId, "entities", on, on, plan.incompleteTypes.length === 0, readCount, note);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** Convenience used by the guard: plan and apply one reading. */
export async function snapshotEntities(
  c: pg.Client, clientId: string, accountId: string, read: MetaEntityRow[], on: string, completeTypes: EntityType[], note: string,
): Promise<EntityPlan> {
  const open = await loadOpenEntities(c, clientId, accountId);
  const plan = reconcileEntities({ open, read, on, completeTypes });
  await applyEntityPlan(c, clientId, accountId, plan, on, read.length, note);
  return plan;
}

export { metaEntityHash, PLATFORM };

/** Everything the rules need, from the four tables. A missing scan row is `present: false`, never a clean read. */
export async function loadMetaDepthInput(
  c: pg.Client, clientId: string, rawAccountId: string, today: string, accountName: string, cplCeilingCents: number | null,
): Promise<MetaDepthInput> {
  const accountId = metaAccountId(rawAccountId);
  const since = addDays(today, -RETAIN_DAYS);
  const ad = await c.query<Record<string, any>>(
    `SELECT campaign_id, adset_id, ad_id, campaign_name, adset_name, ad_name, to_char(day,'YYYY-MM-DD') AS day,
            spend_micros, impressions, reach, frequency, link_clicks, conversions, conversion_value
       FROM meta_ad_days WHERE client_id = $1 AND account_id = $2 AND day >= $3`, [clientId, accountId, since]);
  const seg = await c.query<Record<string, any>>(
    `SELECT campaign_id, adset_id, to_char(day,'YYYY-MM-DD') AS day, kind, segment, spend_micros, impressions, link_clicks, conversions
       FROM meta_segment_days WHERE client_id = $1 AND account_id = $2 AND day >= $3`, [clientId, accountId, since]);
  const ent = await c.query<Record<string, any>>(
    `SELECT entity_type, entity_id, parent_id, name, effective_status, daily_budget_micros, lifetime_budget_micros, optimization_goal,
            attrs_json, to_char(valid_from,'YYYY-MM-DD') AS vf
       FROM meta_entities WHERE client_id = $1 AND account_id = $2 AND valid_to IS NULL`, [clientId, accountId]);
  const scans = await c.query<Record<string, any>>(
    `SELECT part, to_char(covered_from,'YYYY-MM-DD') AS f, to_char(covered_to,'YYYY-MM-DD') AS t, ok FROM meta_scans WHERE client_id = $1 AND account_id = $2`, [clientId, accountId]);
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  const state = (part: string): PartState => {
    const r = scans.rows.find((x) => x.part === part);
    return r && r.f <= r.t ? { present: true, ok: Boolean(r.ok), coveredFrom: r.f, coveredTo: r.t } : { present: Boolean(r), ok: false, coveredFrom: "9999-12-31", coveredTo: "0000-01-01" };
  };
  return {
    today, accountId, accountName, cplCeilingCents,
    adDays: ad.rows.map((r) => ({
      campaignId: r.campaign_id, adsetId: r.adset_id, adId: r.ad_id, campaignName: r.campaign_name, adsetName: r.adset_name, adName: r.ad_name, day: r.day,
      spendMicros: Number(r.spend_micros), impressions: Number(r.impressions), reach: num(r.reach), frequency: num(r.frequency),
      linkClicks: num(r.link_clicks), conversions: num(r.conversions), conversionValue: num(r.conversion_value),
    })),
    segments: seg.rows.map((r) => ({
      campaignId: r.campaign_id, adsetId: r.adset_id, day: r.day, kind: r.kind, segment: r.segment,
      spendMicros: Number(r.spend_micros), impressions: Number(r.impressions), linkClicks: num(r.link_clicks), conversions: num(r.conversions),
    })),
    entities: ent.rows.map((r): DepthEntity => ({
      entityType: r.entity_type, entityId: r.entity_id, parentId: r.parent_id, name: r.name, effectiveStatus: r.effective_status,
      dailyBudgetMicros: num(r.daily_budget_micros), lifetimeBudgetMicros: num(r.lifetime_budget_micros), optimizationGoal: r.optimization_goal,
      validFrom: r.vf, attrs: r.attrs_json ? JSON.parse(r.attrs_json) : {},
    })),
    scans: { ad_days: state("ad_days"), segments: state("segments"), entities: state("entities") },
  };
}

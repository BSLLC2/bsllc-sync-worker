/**
 * The database half of the "did the data land" reading. Read-only toward every
 * source table; the one write is this job's own derived table, `source_landed`
 * (declared and created by the dashboard's schema, v300).
 *
 * Counts and dates only: nothing here selects a name, an address, a figure or a
 * caller. A table the dashboard has not created yet is skipped and said, never
 * read as "nothing landed".
 */
import { SOURCE_SPECS, type LandedSource } from "./catalog.js";
import type { ClientFacts, Landed, LandedRow } from "./reading.js";

export interface Queryable { query<T = any>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>; }

export const INSERT_LANDED = `INSERT INTO source_landed (client_id, source, last_row_at, expected_hours, state, detail, checked_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (client_id, source) DO UPDATE SET last_row_at = EXCLUDED.last_row_at, expected_hours = EXCLUDED.expected_hours,
    state = EXCLUDED.state, detail = EXCLUDED.detail, checked_at = EXCLUDED.checked_at`;

/** Derived rows for a client no longer judged (churned, internal) or a source no longer in the catalog go. Nothing else is deleted. */
export const PRUNE_LANDED = `DELETE FROM source_landed WHERE NOT (client_id = ANY($1::text[]) AND source = ANY($2::text[]))`;

const exists = async (c: Queryable, table: string): Promise<boolean> =>
  Boolean((await c.query<{ r: string | null }>(`SELECT to_regclass($1) AS r`, [table])).rows[0]?.r);

export async function gatherClients(c: Queryable): Promise<ClientFacts[]> {
  const { rows } = await c.query<{ id: string; name: string; status: string | null; is_internal: boolean | null; seo_domain: string | null; connectors: string[] | null; targets: number }>(
    `SELECT cl.id, cl.name, cl.status, cl.is_internal, cl.seo_domain,
            (SELECT array_agg(DISTINCT cm.source) FROM connector_mappings cm
              WHERE cm.client_id = cl.id AND cm.enabled = true AND cm.external_id IS NOT NULL AND btrim(cm.external_id) <> '') AS connectors,
            (SELECT count(*)::int FROM seo_targets t WHERE t.client_id = cl.id AND t.active = true) AS targets
       FROM clients cl ORDER BY cl.name`,
  );
  return rows.map((r) => ({
    clientId: r.id, name: r.name, status: r.status, isInternal: r.is_internal === true, seoDomain: r.seo_domain,
    connectors: new Set(r.connectors ?? []), activeRankTargets: Number(r.targets) || 0,
  }));
}

const asDate = (v: unknown): Date | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export interface Gathered {
  landed: Map<string, Landed>;
  /** Sources whose table is not there yet: skipped, never read as "never". */
  unreadable: LandedSource[];
}
export const keyOf = (clientId: string, source: string) => `${clientId}|${source}`;

export async function gatherLanded(c: Queryable): Promise<Gathered> {
  const landed = new Map<string, Landed>();
  const unreadable: LandedSource[] = [];
  const skip = (kind: string) => SOURCE_SPECS.filter((s) => s.where.kind === kind).forEach((s) => unreadable.push(s.source));

  // Metrics: a LIVE row is a landed row. An error or no-data row is something, but it is not data.
  if (await exists(c, "metric_snapshots")) {
    const sources = SOURCE_SPECS.flatMap((s) => (s.where.kind === "metric_snapshots" ? [s.where.source] : []));
    const { rows } = await c.query<{ client_id: string; source: string; last_live: Date | string | null; last_any: Date | string | null; latest_state: string | null }>(
      `SELECT client_id, source,
              max(synced_at) FILTER (WHERE data_state = 'live') AS last_live,
              max(synced_at) AS last_any,
              (array_agg(data_state ORDER BY synced_at DESC))[1] AS latest_state
         FROM metric_snapshots WHERE source = ANY($1::text[]) GROUP BY client_id, source`,
      [sources],
    );
    for (const r of rows) {
      const live = asDate(r.last_live);
      const note = !live ? "only error or no-data rows have arrived" : r.latest_state && r.latest_state !== "live" ? `the latest read was ${r.latest_state === "error" ? "an error" : "no data"}` : null;
      landed.set(keyOf(r.client_id, r.source), { lastRowAt: live, note });
    }
  } else skip("metric_snapshots");

  // Ad accounts: the daily scan table says how far the record reaches. covered_to is a date; the day it names is landed in full.
  if (await exists(c, "ads_daily_scans")) {
    const { rows } = await c.query<{ client_id: string; covered_to: string | null; latest_ok: boolean | null }>(
      `SELECT client_id, max(covered_to) AS covered_to, (array_agg(ok ORDER BY last_scan_at DESC))[1] AS latest_ok
         FROM ads_daily_scans WHERE platform = 'google_ads' GROUP BY client_id`,
    );
    for (const r of rows) {
      const through = r.covered_to && /^\d{4}-\d{2}-\d{2}$/.test(r.covered_to) ? new Date(`${r.covered_to}T00:00:00Z`) : null;
      const end = through ? new Date(through.getTime() + 86_400_000) : null;
      landed.set(keyOf(r.client_id, "google_ads"), { lastRowAt: end, note: r.latest_ok === false ? "the latest scan failed" : null });
    }
  } else skip("ads_daily_scans");

  // Position checks: a check that failed has an error and is not a position.
  if (await exists(c, "seo_rank_history")) {
    const { rows } = await c.query<{ client_id: string; last_ok: Date | string | null; latest_ok: boolean | null }>(
      `SELECT client_id, max(captured_at) FILTER (WHERE error IS NULL) AS last_ok, (array_agg(error IS NULL ORDER BY captured_at DESC))[1] AS latest_ok
         FROM seo_rank_history GROUP BY client_id`,
    );
    for (const r of rows) landed.set(keyOf(r.client_id, "rank_checks"), { lastRowAt: asDate(r.last_ok), note: r.latest_ok === false ? "the latest check failed" : null });
  } else skip("rank_history");

  // The four newer readers: one status row each. Landed means the run wrote rows.
  if (await exists(c, "signal_runs")) {
    const { rows } = await c.query<{ client_id: string; source: string; status: string; rows: number; ran_at: Date | string | null }>(
      `SELECT client_id, source, status, rows, ran_at FROM signal_runs`,
    );
    for (const r of rows) {
      const brought = (r.status === "ok" || r.status === "capped") && Number(r.rows) > 0;
      landed.set(keyOf(r.client_id, r.source), { lastRowAt: brought ? asDate(r.ran_at) : null, note: brought ? null : `the latest read ended as ${r.status}${Number(r.rows) === 0 && r.status === "ok" ? " with no rows" : ""}` });
    }
  } else skip("signal_runs");

  return { landed, unreadable };
}

export async function writeRows(c: Queryable, rows: readonly LandedRow[], liveClientIds: readonly string[], sources: readonly string[], at: Date): Promise<void> {
  await c.query("BEGIN");
  try {
    for (const r of rows) await c.query(INSERT_LANDED, [r.clientId, r.source, r.lastRowAt, r.expectedHours, r.state, r.detail, at]);
    await c.query(PRUNE_LANDED, [liveClientIds, sources]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

export const tableReady = (c: Queryable) => exists(c, "source_landed");

/**
 * The only writes the Website performance reader makes: rows in three tables the
 * dashboard app declares (ga4_site_days, ga4_report_rows, ga4_report_runs). This
 * worker never creates or alters them. Every column list is a LITERAL on purpose:
 * the app's `npm run verify:wiring` reads each INSERT here and checks every column
 * against shared/schema.ts, and a list built at run time would read as no columns.
 *
 * ONE TRANSACTION PER CLIENT. Daily rows are upserted on (client_id, day). For each
 * kind that read in full, that client's rows of the kind for the months read are
 * deleted and re-inserted, so a month GA4 restated replaces itself and a month with
 * no rows for a kind stays absent. A kind that failed is not touched. The run row
 * goes last. If the transaction fails nothing of it stays and the run row is
 * written on its own as an error, so a failed write never claims `ok`.
 */
import { createHash } from "node:crypto";
import type { ClientReportResult, DailyRowOut, ReportKind, ReportRowOut } from "./types.js";

export interface Queryable { query: (sql: string, params?: unknown[]) => Promise<unknown> }

const id = (...parts: Array<string | number>): string => createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 40);

export const INSERT_SITE_DAY = `INSERT INTO ga4_site_days
  (id, client_id, day, sessions, engaged_sessions, engagement_seconds, users, key_events, synced_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
 ON CONFLICT (client_id, day) DO UPDATE SET
   sessions = EXCLUDED.sessions, engaged_sessions = EXCLUDED.engaged_sessions,
   engagement_seconds = EXCLUDED.engagement_seconds, users = EXCLUDED.users,
   key_events = EXCLUDED.key_events, synced_at = EXCLUDED.synced_at`;

export const INSERT_REPORT_ROW = `INSERT INTO ga4_report_rows
  (id, client_id, month, kind, parent, key, sessions, engaged_sessions, engagement_seconds, events, synced_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
 ON CONFLICT (client_id, month, kind, parent, key) DO UPDATE SET
   sessions = EXCLUDED.sessions, engaged_sessions = EXCLUDED.engaged_sessions,
   engagement_seconds = EXCLUDED.engagement_seconds, events = EXCLUDED.events, synced_at = EXCLUDED.synced_at`;

export const DELETE_KIND_MONTHS = `DELETE FROM ga4_report_rows WHERE client_id = $1 AND kind = $2 AND month = ANY($3::text[])`;

export const INSERT_RUN = `INSERT INTO ga4_report_runs
  (id, client_id, status, detail, first_day, last_day, first_month, last_month, rows, capped_kinds, failed_kinds,
   excluded_countries, form_event, groups_json, ran_at, excluded_channels)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
 ON CONFLICT (client_id) DO UPDATE SET
   status = EXCLUDED.status, detail = EXCLUDED.detail, first_day = EXCLUDED.first_day, last_day = EXCLUDED.last_day,
   first_month = EXCLUDED.first_month, last_month = EXCLUDED.last_month, rows = EXCLUDED.rows,
   capped_kinds = EXCLUDED.capped_kinds, failed_kinds = EXCLUDED.failed_kinds,
   excluded_countries = EXCLUDED.excluded_countries, form_event = EXCLUDED.form_event,
   groups_json = EXCLUDED.groups_json, ran_at = EXCLUDED.ran_at, excluded_channels = EXCLUDED.excluded_channels`;

/**
 * The run row of a run that wrote no rows (off, error, no_data, too big). The rows
 * already in the tables are still there and still describe the span and the
 * configuration an EARLIER run applied, so those columns are kept; saying the new
 * configuration applied to rows it never touched would be a false statement.
 */
export const INSERT_RUN_KEEP = `INSERT INTO ga4_report_runs
  (id, client_id, status, detail, first_day, last_day, first_month, last_month, rows, capped_kinds, failed_kinds,
   excluded_countries, form_event, groups_json, ran_at, excluded_channels)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
 ON CONFLICT (client_id) DO UPDATE SET
   status = EXCLUDED.status, detail = EXCLUDED.detail,
   capped_kinds = EXCLUDED.capped_kinds, failed_kinds = EXCLUDED.failed_kinds, ran_at = EXCLUDED.ran_at`;

/**
 * ONE STATEMENT PER BATCH, NOT PER ROW. The first version sent one INSERT per row; with 24 months of
 * daily and per-page rows per client over a remote database that is tens of thousands of round trips,
 * and a real run took over half an hour where the dry run (no writes) took two minutes. The batch
 * statement is DERIVED from the single-row literal above (the same column list, the same ON CONFLICT
 * clause), so the app's wiring check still reads one source of truth. Rows are de-duplicated on their id
 * first, last one wins, which is what the sequential upserts did: a single statement may not touch the
 * same row twice.
 */
export const BATCH_ROWS = 500;

export function batchSql(single: string, rows: number): string {
  const m = /VALUES \(([^)]*)\)/.exec(single);
  if (!m) throw new Error("no VALUES tuple to batch");
  const width = (m[1]!.match(/\$\d+/g) ?? []).length;
  const tuples: string[] = [];
  for (let i = 0; i < rows; i++) {
    tuples.push("(" + Array.from({ length: width }, (_, k) => `$${i * width + k + 1}`).join(", ") + ")");
  }
  return single.replace(/VALUES \([^)]*\)/, "VALUES " + tuples.join(", "));
}

async function insertBatched(c: Queryable, single: string, rows: ReadonlyArray<unknown[]>): Promise<void> {
  const byId = new Map<unknown, unknown[]>();
  for (const r of rows) byId.set(r[0], r);
  const unique = [...byId.values()];
  for (let i = 0; i < unique.length; i += BATCH_ROWS) {
    const chunk = unique.slice(i, i + BATCH_ROWS);
    await c.query(batchSql(single, chunk.length), chunk.flat());
  }
}

async function writeDaily(c: Queryable, clientId: string, rows: readonly DailyRowOut[], at: Date) {
  await insertBatched(c, INSERT_SITE_DAY, rows.map((r) => [id("d", clientId, r.day), clientId, r.day, r.sessions, r.engagedSessions, r.engagementSeconds, r.users, r.keyEvents, at]));
}

async function writeKind(c: Queryable, clientId: string, kind: ReportKind, months: readonly string[], rows: readonly ReportRowOut[], at: Date) {
  await c.query(DELETE_KIND_MONTHS, [clientId, kind, [...months]]);
  await insertBatched(c, INSERT_REPORT_ROW, rows.map((r) => [
    id("r", clientId, r.month, r.kind, r.parent, r.key), clientId, r.month, r.kind, r.parent, r.key,
    r.sessions, r.engagedSessions, r.engagementSeconds, r.events, at,
  ]));
}

/** The config this run APPLIED, as stored on the run row. */
function appliedConfig(r: ClientReportResult) {
  return {
    excluded: JSON.stringify(r.config.excludeCountries),
    channels: JSON.stringify(r.config.excludeChannels),
    event: r.config.formEvent,
    groups: JSON.stringify(r.config.groups),
  };
}

export async function writeRun(c: Queryable, clientId: string, r: ClientReportResult, at: Date): Promise<void> {
  const cfg = appliedConfig(r);
  await c.query(r.daily ? INSERT_RUN : INSERT_RUN_KEEP, [
    id("run", clientId), clientId, r.status, r.detail, r.firstDay, r.lastDay, r.firstMonth, r.lastMonth, r.rows,
    r.cappedKinds.join(","), r.failedKinds.join(","), cfg.excluded, cfg.event, cfg.groups, at, cfg.channels,
  ]);
}

/** Writes one client's result in one transaction. Returns false (and writes only an error run row) if it failed. */
export async function writeClientReport(c: Queryable, clientId: string, r: ClientReportResult, at: Date): Promise<{ ok: boolean; message: string | null }> {
  try {
    await c.query("BEGIN");
    if (r.daily) await writeDaily(c, clientId, r.daily, at);
    for (const [kind, rows] of Object.entries(r.kinds) as Array<[ReportKind, ReportRowOut[]]>) {
      await writeKind(c, clientId, kind, r.months, rows, at);
    }
    await writeRun(c, clientId, r, at);
    await c.query("COMMIT");
    return { ok: true, message: null };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    const failed: ClientReportResult = {
      ...r, status: "error", detail: "The rows could not be written, so nothing was changed for this account.",
      daily: null, kinds: {}, rows: 0, cappedKinds: [], failedKinds: [],
    };
    await writeRun(c, clientId, failed, at).catch(() => {});
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 160) : "write failed" };
  }
}

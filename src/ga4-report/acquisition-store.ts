/**
 * The only writes the traffic-acquisition reader makes: rows in two tables the dashboard app
 * declares (ga4_acquisition_windows, ga4_acquisition_runs). This worker never creates or alters
 * them. Every column list is a LITERAL so the app's `npm run verify:wiring` can read each INSERT.
 *
 * ONE TRANSACTION PER CLIENT. For each kind read in full for both windows, that client's rows of
 * the kind are deleted and re-inserted, so a window GA4 restated replaces itself and a source that
 * left the top list does not linger. A kind that failed is not touched. The run row goes last. If
 * the transaction fails nothing of it stays and the run row is written on its own as an error.
 */
import { createHash } from "node:crypto";
import { safeMessage } from "../page-behaviour/http.js";
import { configKey, sanitiseConfig, withSiteDefault } from "./config.js";
import { batchSql, type Queryable } from "./store.js";
import { ACQUISITION_KINDS, type AcquisitionKind, type AcquisitionResult, type AcquisitionRowOut, readClientAcquisition } from "./acquisition.js";
import type { Io } from "./ga4.js";
import { PAUSE_MS } from "./types.js";
import type { FetchLike } from "./types.js";

const id = (...parts: Array<string | number>): string => createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 40);

export const INSERT_ACQ_ROW = `INSERT INTO ga4_acquisition_windows
  (id, client_id, kind, period, window_start, window_end, key, sessions, engaged_sessions, key_events, synced_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
 ON CONFLICT (client_id, kind, period, key) DO UPDATE SET
   window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end, sessions = EXCLUDED.sessions,
   engaged_sessions = EXCLUDED.engaged_sessions, key_events = EXCLUDED.key_events, synced_at = EXCLUDED.synced_at`;

export const DELETE_ACQ_KIND = `DELETE FROM ga4_acquisition_windows WHERE client_id = $1 AND kind = $2`;

export const INSERT_ACQ_RUN = `INSERT INTO ga4_acquisition_runs
  (id, client_id, status, detail, current_start, current_end, before_start, before_end, rows, capped_kinds, failed_kinds,
   excluded_countries, excluded_channels, own_hostnames, ran_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
 ON CONFLICT (client_id) DO UPDATE SET
   status = EXCLUDED.status, detail = EXCLUDED.detail, current_start = EXCLUDED.current_start, current_end = EXCLUDED.current_end,
   before_start = EXCLUDED.before_start, before_end = EXCLUDED.before_end, rows = EXCLUDED.rows,
   capped_kinds = EXCLUDED.capped_kinds, failed_kinds = EXCLUDED.failed_kinds, excluded_countries = EXCLUDED.excluded_countries,
   excluded_channels = EXCLUDED.excluded_channels, own_hostnames = EXCLUDED.own_hostnames, ran_at = EXCLUDED.ran_at`;

/**
 * The run row of a run that wrote no rows (off, error, no_data). The rows already in the table still
 * describe the windows and settings an EARLIER run applied, so those columns are kept; saying the new
 * windows applied to rows it never touched would be a false statement.
 */
export const INSERT_ACQ_RUN_KEEP = `INSERT INTO ga4_acquisition_runs
  (id, client_id, status, detail, current_start, current_end, before_start, before_end, rows, capped_kinds, failed_kinds,
   excluded_countries, excluded_channels, own_hostnames, ran_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
 ON CONFLICT (client_id) DO UPDATE SET
   status = EXCLUDED.status, detail = EXCLUDED.detail, capped_kinds = EXCLUDED.capped_kinds,
   failed_kinds = EXCLUDED.failed_kinds, ran_at = EXCLUDED.ran_at`;

const BATCH = 500;
async function insertBatched(c: Queryable, rows: ReadonlyArray<unknown[]>): Promise<void> {
  const byId = new Map<unknown, unknown[]>();
  for (const r of rows) byId.set(r[0], r);
  const unique = [...byId.values()];
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    await c.query(batchSql(INSERT_ACQ_ROW, chunk.length), chunk.flat());
  }
}

function runParams(clientId: string, r: AcquisitionResult, at: Date): unknown[] {
  return [
    id("acq-run", clientId), clientId, r.status, r.detail,
    r.windows?.current.start ?? null, r.windows?.current.end ?? null, r.windows?.prior.start ?? null, r.windows?.prior.end ?? null,
    r.rows, r.cappedKinds.join(","), r.failedKinds.join(","),
    JSON.stringify(r.config.excludeCountries), JSON.stringify(r.config.excludeChannels), JSON.stringify(r.config.ownHostnames), at,
  ];
}

/** Writes one client's result in one transaction. Returns false (and writes only an error run row) if it failed. */
export async function writeClientAcquisition(c: Queryable, clientId: string, r: AcquisitionResult, at: Date): Promise<{ ok: boolean; message: string | null }> {
  const wrote = r.status === "ok";
  try {
    await c.query("BEGIN");
    if (wrote) {
      for (const kind of ACQUISITION_KINDS as readonly AcquisitionKind[]) {
        const rows = r.kinds[kind];
        if (!rows) continue;
        await c.query(DELETE_ACQ_KIND, [clientId, kind]);
        await insertBatched(c, rows.map((x: AcquisitionRowOut) => [
          id("acq", clientId, x.kind, x.period, x.key), clientId, x.kind, x.period, x.windowStart, x.windowEnd, x.key,
          x.sessions, x.engagedSessions, x.keyEvents, at,
        ]));
      }
    }
    await c.query(wrote ? INSERT_ACQ_RUN : INSERT_ACQ_RUN_KEEP, runParams(clientId, r, at));
    await c.query("COMMIT");
    return { ok: true, message: null };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    const failed: AcquisitionResult = { ...r, status: "error", detail: "The rows could not be written, so nothing was changed for this account.", kinds: {}, rows: 0, cappedKinds: [], failedKinds: [] };
    await c.query(INSERT_ACQ_RUN_KEEP, runParams(clientId, failed, at)).catch(() => {});
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 160) : "write failed" };
  }
}

export interface AcquisitionInput { id: string; name: string; property: string | null; site?: string | null }
export interface AcquisitionPipelineResult { attempted: number; answered: number; casualties: string[]; lines: string[]; summary: string }

/** Every client, one after another: read, then write (unless a dry run). One client's failure never stops the others. */
export async function processAcquisition(opts: {
  clients: readonly AcquisitionInput[];
  settings: ReadonlyMap<string, string>;
  fetch: FetchLike;
  token: () => Promise<string>;
  today: string;
  db: Queryable;
  dryRun: boolean;
  sleep?: (ms: number) => Promise<void>;
  pauseMs?: number;
  now?: () => Date;
}): Promise<AcquisitionPipelineResult> {
  const res: AcquisitionPipelineResult = { attempted: 0, answered: 0, casualties: [], lines: [], summary: "" };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (const client of opts.clients) {
    const config = withSiteDefault(sanitiseConfig(opts.settings.get(configKey(client.id))), client.site);
    let result: AcquisitionResult;
    try {
      if (!client.property) result = await readClientAcquisition(null, config, null, { today: opts.today });
      else {
        let token = "", tokenError: string | null = null;
        try { token = await opts.token(); } catch (e) { tokenError = safeMessage(e); }
        const io: Io | null = tokenError ? null : { fetch: opts.fetch, token, property: client.property, sleep, pauseMs: opts.pauseMs ?? PAUSE_MS, calls: 0 };
        result = await readClientAcquisition(client.property, config, io, { today: opts.today }, tokenError);
      }
    } catch (e) {
      res.casualties.push(`${client.name}: could not be read (${safeMessage(e)})`);
      res.attempted += 1;
      continue;
    }
    if (result.status !== "off") res.attempted += 1;
    const answered = result.status === "ok" || result.status === "no_data";
    if (result.status === "error") res.casualties.push(`${client.name}: ${result.detail ?? "error"}`);
    else if (result.failedKinds.length) res.casualties.push(`${client.name}: ${result.failedKinds.join(", ")} kept their earlier rows`);
    if (opts.dryRun) {
      if (answered) res.answered += 1;
      res.lines.push(`(dry run) ${client.name} acquisition: ${result.status}${result.windows ? `, ${result.windows.current.start}..${result.windows.current.end} against ${result.windows.prior.start}..${result.windows.prior.end}` : ""}, ${result.rows} rows`);
      continue;
    }
    const w = await writeClientAcquisition(opts.db, client.id, result, (opts.now ?? (() => new Date()))());
    if (w.ok) { if (answered) res.answered += 1; }
    else res.casualties.push(`${client.name}: the acquisition rows could not be written (${w.message})`);
    res.lines.push(`${client.name} acquisition: ${result.status}, ${result.rows} rows${result.failedKinds.length ? `, failed ${result.failedKinds.join(",")}` : ""}`);
  }
  res.summary = `acquisition: ${res.attempted} account${res.attempted === 1 ? "" : "s"}, ${res.answered} read, ${res.casualties.length} with a problem${opts.dryRun ? " (dry run)" : ""}`;
  return res;
}

/**
 * The only writes the page-behaviour reader makes: rows in five tables the
 * dashboard app declares (schema v252). Every column list is a LITERAL on purpose:
 * the app's `npm run verify:wiring` reads each INSERT here and checks every column
 * against shared/schema.ts in both directions, and a list built at run time would
 * read as no columns at all.
 *
 * Every write is an upsert on a deterministic id, so a second run on the same day
 * is the same run. A source that fails keeps the last good rows; nothing here
 * deletes a row except the explicit age-out of Clarity days.
 */
import { createHash } from "node:crypto";
import type { BehaviourRowOut, ClarityDayOut, EventRowOut, RunOut, VitalRowOut } from "./types.js";

/** Anything with a `query`, so the guard can hand it a recorder and the script a pg client. */
export interface Queryable { query: (sql: string, params?: unknown[]) => Promise<unknown> }

const id = (...parts: Array<string | number>): string => createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 40);

export const INSERT_BEHAVIOUR = `INSERT INTO seo_page_behaviour
  (id, client_id, source, page_path, device, period, window_start, window_end,
   sessions, engaged_sessions, engagement_seconds, key_events, clicks, impressions, top_queries_json, synced_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
 ON CONFLICT (client_id, source, page_path, device, period) DO UPDATE SET
   window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
   sessions = EXCLUDED.sessions, engaged_sessions = EXCLUDED.engaged_sessions,
   engagement_seconds = EXCLUDED.engagement_seconds, key_events = EXCLUDED.key_events,
   clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
   top_queries_json = EXCLUDED.top_queries_json, synced_at = EXCLUDED.synced_at`;

export const INSERT_EVENTS = `INSERT INTO seo_page_events
  (id, client_id, page_path, device, event_name, section, period, window_start, window_end, event_count, synced_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
 ON CONFLICT (client_id, page_path, device, event_name, section, period) DO UPDATE SET
   window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
   event_count = EXCLUDED.event_count, synced_at = EXCLUDED.synced_at`;

export const INSERT_VITALS = `INSERT INTO seo_page_vitals
  (id, client_id, page_path, form_factor, source, lcp_ms, inp_ms, cls, collection_first, collection_last, state, detail, fetched_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
 ON CONFLICT (client_id, page_path, form_factor, source) DO UPDATE SET
   lcp_ms = EXCLUDED.lcp_ms, inp_ms = EXCLUDED.inp_ms, cls = EXCLUDED.cls,
   collection_first = EXCLUDED.collection_first, collection_last = EXCLUDED.collection_last,
   state = EXCLUDED.state, detail = EXCLUDED.detail, fetched_at = EXCLUDED.fetched_at`;

export const INSERT_CLARITY = `INSERT INTO seo_clarity_days
  (id, client_id, page_path, day, sessions, scroll_depth_avg, engagement_seconds, dead_click_pct, rage_click_pct, quickback_pct, synced_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
 ON CONFLICT (client_id, page_path, day) DO UPDATE SET
   sessions = EXCLUDED.sessions, scroll_depth_avg = EXCLUDED.scroll_depth_avg,
   engagement_seconds = EXCLUDED.engagement_seconds, dead_click_pct = EXCLUDED.dead_click_pct,
   rage_click_pct = EXCLUDED.rage_click_pct, quickback_pct = EXCLUDED.quickback_pct, synced_at = EXCLUDED.synced_at`;

export const INSERT_RUN = `INSERT INTO seo_ux_runs
  (client_id, source, status, detail, rows, capped, total_found, window_end, ran_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
 ON CONFLICT (client_id, source) DO UPDATE SET
   status = EXCLUDED.status, detail = EXCLUDED.detail, rows = EXCLUDED.rows, capped = EXCLUDED.capped,
   total_found = EXCLUDED.total_found, window_end = EXCLUDED.window_end, ran_at = EXCLUDED.ran_at`;

export async function writeBehaviour(c: Queryable, clientId: string, rows: readonly BehaviourRowOut[], at: Date): Promise<void> {
  for (const r of rows) {
    await c.query(INSERT_BEHAVIOUR, [
      id("b", clientId, r.source, r.pagePath, r.device, r.period), clientId, r.source, r.pagePath, r.device, r.period, r.windowStart, r.windowEnd,
      r.sessions, r.engagedSessions, r.engagementSeconds, r.keyEvents, r.clicks, r.impressions, r.topQueriesJson, at,
    ]);
  }
}

export async function writeEvents(c: Queryable, clientId: string, rows: readonly EventRowOut[], at: Date): Promise<void> {
  for (const r of rows) {
    await c.query(INSERT_EVENTS, [
      id("e", clientId, r.pagePath, r.device, r.eventName, r.section, r.period), clientId, r.pagePath, r.device, r.eventName, r.section, r.period,
      r.windowStart, r.windowEnd, r.eventCount, at,
    ]);
  }
}

export async function writeVitals(c: Queryable, clientId: string, rows: readonly VitalRowOut[], at: Date): Promise<void> {
  for (const r of rows) {
    await c.query(INSERT_VITALS, [
      id("v", clientId, r.pagePath, r.formFactor, r.source), clientId, r.pagePath, r.formFactor, r.source,
      r.lcpMs, r.inpMs, r.cls, r.collectionFirst, r.collectionLast, r.state, r.detail, at,
    ]);
  }
}

export async function writeClarity(c: Queryable, clientId: string, rows: readonly ClarityDayOut[], at: Date): Promise<void> {
  for (const r of rows) {
    await c.query(INSERT_CLARITY, [
      id("c", clientId, r.pagePath, r.day), clientId, r.pagePath, r.day,
      r.sessions, r.scrollDepthAvg, r.engagementSeconds, r.deadClickPct, r.rageClickPct, r.quickbackPct, at,
    ]);
  }
}

export async function writeRun(c: Queryable, clientId: string, r: RunOut, at: Date): Promise<void> {
  await c.query(INSERT_RUN, [clientId, r.source, r.status, r.detail, r.rows, r.capped, r.totalFound, r.windowEnd, at]);
}

/** Clarity days older than this are dropped. The reading looks back 28; the extra is slack. */
export const CLARITY_KEEP_DAYS = 120;
export const DELETE_OLD_CLARITY = `DELETE FROM seo_clarity_days WHERE client_id = $1 AND day < $2`;

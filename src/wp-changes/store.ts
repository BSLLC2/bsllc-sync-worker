/**
 * Storing what a site's public API said. Idempotent, and a site that could not
 * be asked leaves its earlier events exactly as they were.
 *
 * The dashboard's ensureSchema() makes the same tables (v280); keep the columns
 * identical to server/db.ts.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { SOURCE, type WpSiteResult } from "./wp.js";

export async function ensureSiteChangeTables(c: pg.Client): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS site_change_events (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, event TEXT NOT NULL,
      event_at TIMESTAMPTZ NOT NULL, url_path TEXT NOT NULL DEFAULT '', external_id TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS uq_site_change_events_key ON site_change_events (client_id, source, external_id, event, event_at);
    CREATE INDEX IF NOT EXISTS idx_site_change_events_client ON site_change_events (client_id, event_at);
    CREATE TABLE IF NOT EXISTS site_change_scans (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL,
      last_scan_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_read_at TIMESTAMPTZ, items_read INTEGER NOT NULL DEFAULT 0,
      capped BOOLEAN NOT NULL DEFAULT false, note TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_site_change_scans_client ON site_change_scans (client_id, source);`);
}

export const RETAIN_DAYS = 400;

/** One scan row per client and source. `last_read_at` moves only on a read that worked. Events are added, never rewritten. */
export async function storeWpResult(c: pg.Client, clientId: string, r: WpSiteResult): Promise<{ inserted: number }> {
  await c.query("BEGIN");
  try {
    let inserted = 0;
    if (r.state === "read") {
      for (const ch of r.changes) {
        const res = await c.query(
          `INSERT INTO site_change_events (id, client_id, source, kind, event, event_at, url_path, external_id, observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
           ON CONFLICT (client_id, source, external_id, event, event_at) DO NOTHING`,
          [randomUUID(), clientId, SOURCE, ch.kind, ch.event, ch.at, ch.urlPath.slice(0, 300), ch.externalId],
        );
        inserted += res.rowCount ?? 0;
      }
      await c.query(`DELETE FROM site_change_events WHERE client_id = $1 AND source = $2 AND event_at < now() - ($3::int * interval '1 day')`, [clientId, SOURCE, RETAIN_DAYS]);
    }
    await c.query(
      `INSERT INTO site_change_scans (id, client_id, source, state, last_scan_at, last_read_at, items_read, capped, note)
       VALUES ($1,$2,$3,$4, now(), CASE WHEN $4 = 'read' THEN now() ELSE NULL END, $5, $6, $7)
       ON CONFLICT (client_id, source) DO UPDATE SET
         state = EXCLUDED.state, last_scan_at = now(),
         last_read_at = CASE WHEN EXCLUDED.state = 'read' THEN now() ELSE site_change_scans.last_read_at END,
         items_read = CASE WHEN EXCLUDED.state = 'read' THEN EXCLUDED.items_read ELSE site_change_scans.items_read END,
         capped = EXCLUDED.capped, note = EXCLUDED.note`,
      [randomUUID(), clientId, SOURCE, r.state, r.items, r.capped, r.note.slice(0, 400)],
    );
    await c.query("COMMIT");
    return { inserted };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

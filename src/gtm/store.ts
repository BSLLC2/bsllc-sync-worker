/**
 * The only writes the Tag Manager reader makes: one row of declared facts per client in
 * `gtm_container_facts`, and a status in `signal_runs`. Column lists are LITERAL so the
 * dashboard's `npm run verify:wiring` can read them against shared/schema.ts in both
 * directions.
 *
 * ONE ROW A CLIENT. A good read replaces the row. A FAILED read changes only the status
 * columns, so the last good facts stay (with their own date) instead of being wiped by
 * a day the service account lost its grant.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../page-behaviour/store.js";
import type { GtmErrorState, GtmFacts, GtmVersionOut } from "./types.js";

const id = (...parts: Array<string | number>): string => createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 40);

export const UPSERT_FACTS = `INSERT INTO gtm_container_facts
  (id, client_id, container_public_id, container_path, version_id, version_name, published_at, tags_json, read_at, ok, error_state)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
 ON CONFLICT (client_id) DO UPDATE SET
   container_public_id = EXCLUDED.container_public_id, container_path = EXCLUDED.container_path, version_id = EXCLUDED.version_id,
   version_name = EXCLUDED.version_name, published_at = EXCLUDED.published_at, tags_json = EXCLUDED.tags_json,
   read_at = EXCLUDED.read_at, ok = EXCLUDED.ok, error_state = EXCLUDED.error_state`;

/** A failed read: status only. The last good facts, and the date they were read, stay as they were. */
export const UPSERT_FAILED = `INSERT INTO gtm_container_facts
  (id, client_id, container_public_id, container_path, version_id, version_name, published_at, tags_json, read_at, ok, error_state)
 VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, NULL, $4, false, $5)
 ON CONFLICT (client_id) DO UPDATE SET container_public_id = EXCLUDED.container_public_id, ok = false, error_state = EXCLUDED.error_state`;

export async function writeFacts(c: Queryable, clientId: string, publicId: string, containerPath: string | null, version: GtmVersionOut, facts: GtmFacts | null, errorState: GtmErrorState | null, at: Date): Promise<void> {
  await c.query(UPSERT_FACTS, [
    id("gtm", clientId), clientId, publicId, containerPath, version.versionId, version.versionName, version.publishedAt,
    facts ? JSON.stringify(facts) : null, at, true, errorState,
  ]);
}

export async function writeFailed(c: Queryable, clientId: string, publicId: string, errorState: GtmErrorState, at: Date): Promise<void> {
  await c.query(UPSERT_FAILED, [id("gtm", clientId), clientId, publicId, at, errorState]);
}

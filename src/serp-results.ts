/**
 * The top results of a tracked search, kept from the response the weekly rank pull
 * already paid for. No extra provider call is made to get them.
 *
 * What is kept: the first ten organic results of the latest SERP_CAPTURES_KEPT weekly
 * captures per search (position, address, domain, title). Older captures of the same
 * search are removed when a new one is written, so a client's table is bounded at
 * (tracked searches x captures x ten). No snippet, no rating, no page text.
 *
 * Written by the weekly rank pull (src/import-seo.ts) and read by the dashboard,
 * which never calls the provider. The competitor PAGE reading that fills the
 * read_* columns is a separate job (src/read-serp-pages.ts).
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { SERP_ORGANIC_KEPT, type SerpOrganic } from "./dataforseo.js";

/** How many weekly captures per search are kept. OURS: enough to see this week against last. */
export const SERP_CAPTURES_KEPT = 4;

/**
 * The write, spelled out. The column list is a literal on purpose: the app's
 * `npm run verify:wiring` reads every INSERT in this repo and checks each column
 * against shared/schema.ts.
 */
export const INSERT_SERP_RESULT = `INSERT INTO seo_serp_results
  (id, client_id, seo_target_id, keyword, device, captured_at, position, url, domain, title)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
 ON CONFLICT (client_id, keyword, device, captured_at, position) DO NOTHING`;

/** Remove every capture of one search older than the newest SERP_CAPTURES_KEPT. */
export const PRUNE_SERP_RESULTS = `DELETE FROM seo_serp_results
  WHERE client_id = $1 AND keyword = $2 AND device = $3
    AND captured_at < COALESCE((
      SELECT min(captured_at) FROM (
        SELECT DISTINCT captured_at FROM seo_serp_results
         WHERE client_id = $1 AND keyword = $2 AND device = $3
         ORDER BY captured_at DESC LIMIT ${SERP_CAPTURES_KEPT}) newest), 'infinity'::timestamptz)`;

export async function serpTableExists(c: pg.Client): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'seo_serp_results'`);
  return r.rowCount === 1;
}

/** One search's capture. A search whose check failed, or that returned no organic result, writes nothing. */
export async function writeSerpCapture(
  c: pg.Client,
  input: { clientId: string; targetId: string | null; keyword: string; device: string; capturedAt: Date; organic: readonly SerpOrganic[] },
): Promise<number> {
  const rows = input.organic.slice(0, SERP_ORGANIC_KEPT);
  if (!rows.length) return 0;
  for (const r of rows) {
    await c.query(INSERT_SERP_RESULT, [randomUUID(), input.clientId, input.targetId, input.keyword, input.device, input.capturedAt, r.position, r.url, r.domain, r.title]);
  }
  await c.query(PRUNE_SERP_RESULTS, [input.clientId, input.keyword, input.device]);
  return rows.length;
}

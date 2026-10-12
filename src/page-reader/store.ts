/**
 * The one write the page reader makes: a row in seo_page_facts, rewritten each read.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { PageRow } from "./types.js";

/**
 * The write, spelled out. The column list is a literal on purpose: the app's
 * `npm run verify:wiring` reads every INSERT in this repo and checks each column
 * against shared/schema.ts, and a list built at run time would be read as no
 * columns at all.
 */
export const INSERT_PAGE_FACTS = `INSERT INTO seo_page_facts
  (id, client_id, url, final_url, found_by, state, status_code, error, fetched_at,
   title, meta_description, h1, h1_count, outline_json, word_count, canonical, noindex,
   schema_types_json, in_links, out_links, pages_read, phrases_json, phrases_checked)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
 ON CONFLICT (client_id, url) DO UPDATE SET
   final_url = EXCLUDED.final_url, found_by = EXCLUDED.found_by, state = EXCLUDED.state,
   status_code = EXCLUDED.status_code, error = EXCLUDED.error, fetched_at = EXCLUDED.fetched_at,
   title = EXCLUDED.title, meta_description = EXCLUDED.meta_description, h1 = EXCLUDED.h1,
   h1_count = EXCLUDED.h1_count, outline_json = EXCLUDED.outline_json, word_count = EXCLUDED.word_count,
   canonical = EXCLUDED.canonical, noindex = EXCLUDED.noindex, schema_types_json = EXCLUDED.schema_types_json,
   in_links = EXCLUDED.in_links, out_links = EXCLUDED.out_links, pages_read = EXCLUDED.pages_read,
   phrases_json = EXCLUDED.phrases_json, phrases_checked = EXCLUDED.phrases_checked`;

export async function writePageRow(c: pg.Client, clientId: string, r: PageRow, at: Date): Promise<void> {
  await c.query(INSERT_PAGE_FACTS, [
    randomUUID(), clientId, r.url, r.finalUrl, r.foundBy, r.state, r.statusCode, r.error, at,
    r.title, r.metaDescription, r.h1, r.h1Count, r.outlineJson, r.wordCount, r.canonical, r.noindex,
    r.schemaTypesJson, r.inLinks, r.outLinks, r.pagesRead, r.phrasesJson, r.phrasesChecked,
  ]);
}


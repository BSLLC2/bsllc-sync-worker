/**
 * The only writes the backlink reader makes: rows in three tables the dashboard app declares (seo_backlink_summaries,
 * seo_backlink_domains, seo_backlink_runs, schema v304 provisional). This worker never creates or alters them. Every
 * column list is a LITERAL on purpose: the app's `npm run verify:wiring` reads each INSERT here and checks every column
 * against shared/schema.ts, and a list built at run time would read as no columns.
 *
 * ONE TRANSACTION PER CLIENT. A part that failed keeps the value an earlier read of the same day wrote (COALESCE), and a
 * referring-domain list that failed is not replaced. The run row goes last.
 */
import { createHash } from "node:crypto";
import { KEEP_DOMAIN_DAYS, KEEP_SUMMARY_DAYS, NEW_LOST_DAYS, type ClientBacklinkResult, type DomainRead } from "./types.js";
import { addDaysYmd } from "./dfs.js";

export interface Queryable { query: (sql: string, params?: unknown[]) => Promise<unknown> }

const id = (...parts: Array<string | number>): string => createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 40);

export const INSERT_SUMMARY = `INSERT INTO seo_backlink_summaries
  (id, client_id, domain, role, read_on, backlinks, referring_domains, referring_main_domains, broken_backlinks, anchor_links, image_links, other_links,
   new_backlinks, lost_backlinks, new_domains, lost_domains, window_days, cost_usd, read_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
 ON CONFLICT (client_id, domain, read_on) DO UPDATE SET
   role = EXCLUDED.role,
   backlinks = COALESCE(EXCLUDED.backlinks, seo_backlink_summaries.backlinks),
   referring_domains = COALESCE(EXCLUDED.referring_domains, seo_backlink_summaries.referring_domains),
   referring_main_domains = COALESCE(EXCLUDED.referring_main_domains, seo_backlink_summaries.referring_main_domains),
   broken_backlinks = COALESCE(EXCLUDED.broken_backlinks, seo_backlink_summaries.broken_backlinks),
   anchor_links = COALESCE(EXCLUDED.anchor_links, seo_backlink_summaries.anchor_links),
   image_links = COALESCE(EXCLUDED.image_links, seo_backlink_summaries.image_links),
   other_links = COALESCE(EXCLUDED.other_links, seo_backlink_summaries.other_links),
   new_backlinks = COALESCE(EXCLUDED.new_backlinks, seo_backlink_summaries.new_backlinks),
   lost_backlinks = COALESCE(EXCLUDED.lost_backlinks, seo_backlink_summaries.lost_backlinks),
   new_domains = COALESCE(EXCLUDED.new_domains, seo_backlink_summaries.new_domains),
   lost_domains = COALESCE(EXCLUDED.lost_domains, seo_backlink_summaries.lost_domains),
   window_days = EXCLUDED.window_days, cost_usd = EXCLUDED.cost_usd, read_at = EXCLUDED.read_at`;

export const DELETE_DOMAINS = `DELETE FROM seo_backlink_domains WHERE client_id = $1 AND domain = $2 AND read_on = $3`;

export const INSERT_DOMAIN = `INSERT INTO seo_backlink_domains
  (id, client_id, domain, read_on, ref_domain, backlinks, first_seen, read_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
 ON CONFLICT (client_id, domain, read_on, ref_domain) DO UPDATE SET
   backlinks = EXCLUDED.backlinks, first_seen = EXCLUDED.first_seen, read_at = EXCLUDED.read_at`;

export const INSERT_RUN = `INSERT INTO seo_backlink_runs
  (id, client_id, status, detail, domains_read, estimated_usd, spent_usd, ran_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
 ON CONFLICT (client_id) DO UPDATE SET
   status = EXCLUDED.status, detail = EXCLUDED.detail, domains_read = EXCLUDED.domains_read,
   estimated_usd = EXCLUDED.estimated_usd, spent_usd = EXCLUDED.spent_usd, ran_at = EXCLUDED.ran_at`;

export const PRUNE_SUMMARIES = `DELETE FROM seo_backlink_summaries WHERE client_id = $1 AND read_on < $2`;
export const PRUNE_DOMAINS = `DELETE FROM seo_backlink_domains WHERE client_id = $1 AND read_on < $2`;

/** A domain read worth a row: at least one part answered. */
export const answered = (r: DomainRead): boolean => r.summary != null || r.newLost != null || r.topDomains != null;

export async function writeRun(c: Queryable, clientId: string, r: ClientBacklinkResult, at: Date): Promise<void> {
  const read = r.reads.filter(answered).length;
  await c.query(INSERT_RUN, [id("run", clientId), clientId, r.status, r.detail, read, r.estimatedUsd, r.spentUsd, at]);
}

/** Writes one client's reads in one transaction. A failure writes only an error run row and says so. */
export async function writeClientBacklinks(c: Queryable, clientId: string, r: ClientBacklinkResult, today: string, at: Date): Promise<{ ok: boolean; message: string | null }> {
  try {
    await c.query("BEGIN");
    for (const d of r.reads) {
      if (!answered(d)) continue;
      const s = d.summary, n = d.newLost;
      await c.query(INSERT_SUMMARY, [
        id("s", clientId, d.domain, today), clientId, d.domain, d.role, today,
        s?.backlinks ?? null, s?.referringDomains ?? null, s?.referringMainDomains ?? null, s?.brokenBacklinks ?? null, s?.anchorLinks ?? null, s?.imageLinks ?? null, s?.otherLinks ?? null,
        n?.newBacklinks ?? null, n?.lostBacklinks ?? null, n?.newDomains ?? null, n?.lostDomains ?? null, NEW_LOST_DAYS, d.costUsd, at,
      ]);
      if (d.topDomains) {
        await c.query(DELETE_DOMAINS, [clientId, d.domain, today]);
        for (const t of d.topDomains) await c.query(INSERT_DOMAIN, [id("d", clientId, d.domain, today, t.domain), clientId, d.domain, today, t.domain, t.backlinks, t.firstSeen, at]);
      }
    }
    await writeRun(c, clientId, r, at);
    await c.query(PRUNE_SUMMARIES, [clientId, addDaysYmd(today, -KEEP_SUMMARY_DAYS)]);
    await c.query(PRUNE_DOMAINS, [clientId, addDaysYmd(today, -KEEP_DOMAIN_DAYS)]);
    await c.query("COMMIT");
    return { ok: true, message: null };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    const failed: ClientBacklinkResult = { ...r, status: "error", detail: "The rows could not be written, so nothing was changed for this account.", reads: [] };
    await writeRun(c, clientId, failed, at).catch(() => {});
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 160) : "write failed" };
  }
}

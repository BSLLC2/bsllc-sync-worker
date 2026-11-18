/**
 * The link audit's writes. The column lists are LITERAL on purpose: the dashboard's `npm run verify:wiring` reads each one against
 * `shared/schema.ts` both ways, so a column added on one side and not the other fails the build.
 *
 * REPLACE ON A COMPLETE READ, KEEP ON ANYTHING ELSE. A part read in full replaces that client's rows for the part inside one
 * transaction. A part that was capped is upserted over what is there, so the earlier rows stay. A part that failed or was not read is
 * not touched at all: the last good rows stay and the run row says which part failed.
 *
 * NEVER STORED: a person, an email address or a phone number (anchors go through cleanAnchor first), a competitor's anchor, a page
 * address with a host (pages are paths on the client's own site).
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../page-behaviour/store.js";
import type { AuditRead, PartState } from "./types.js";

export const BATCH = 400;
const hid = (...parts: Array<string | number>): string => createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 40);

/* The dashboard's older link read (the weekly counts), still written by this job. */
export const INSERT_SUMMARY = `INSERT INTO seo_backlink_summaries (id, client_id, domain, role, read_on, backlinks, referring_domains, referring_main_domains, broken_backlinks, anchor_links, image_links, other_links, new_backlinks, lost_backlinks, new_domains, lost_domains, window_days, cost_usd, read_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
 ON CONFLICT (client_id, domain, read_on) DO UPDATE SET role = EXCLUDED.role, backlinks = EXCLUDED.backlinks, referring_domains = EXCLUDED.referring_domains,
   referring_main_domains = EXCLUDED.referring_main_domains, broken_backlinks = EXCLUDED.broken_backlinks, anchor_links = EXCLUDED.anchor_links, image_links = EXCLUDED.image_links,
   other_links = EXCLUDED.other_links, new_backlinks = EXCLUDED.new_backlinks, lost_backlinks = EXCLUDED.lost_backlinks, new_domains = EXCLUDED.new_domains,
   lost_domains = EXCLUDED.lost_domains, window_days = EXCLUDED.window_days, cost_usd = EXCLUDED.cost_usd, read_at = EXCLUDED.read_at`;

export const INSERT_DOMAIN = `INSERT INTO seo_backlink_domains (id, client_id, domain, read_on, ref_domain, backlinks, first_seen, read_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
 ON CONFLICT (client_id, domain, read_on, ref_domain) DO UPDATE SET backlinks = EXCLUDED.backlinks, first_seen = EXCLUDED.first_seen, read_at = EXCLUDED.read_at`;

export const INSERT_RUN = `INSERT INTO seo_backlink_runs (id, client_id, status, detail, domains_read, estimated_usd, spent_usd, ran_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
 ON CONFLICT (client_id) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, domains_read = EXCLUDED.domains_read,
   estimated_usd = EXCLUDED.estimated_usd, spent_usd = EXCLUDED.spent_usd, ran_at = EXCLUDED.ran_at`;

/* The link audit. */
export const INSERT_AUDIT_DOMAIN = `INSERT INTO link_audit_domains (id, client_id, ref_domain, tld, rank, spam_score, backlinks, dofollow_backlinks, first_seen, last_seen, lost_date, spam_anchor, read_on, read_at)
 SELECT t.id, $1, t.ref_domain, t.tld, t.rank, t.spam_score, t.backlinks, t.dofollow_backlinks, t.first_seen, t.last_seen, t.lost_date, t.spam_anchor, $2, $3
   FROM jsonb_to_recordset($4::jsonb) AS t(id text, ref_domain text, tld text, rank int, spam_score int, backlinks int, dofollow_backlinks int, first_seen text, last_seen text, lost_date text, spam_anchor boolean)
 ON CONFLICT (client_id, ref_domain) DO UPDATE SET tld = EXCLUDED.tld, rank = EXCLUDED.rank, spam_score = EXCLUDED.spam_score, backlinks = EXCLUDED.backlinks,
   dofollow_backlinks = EXCLUDED.dofollow_backlinks, first_seen = EXCLUDED.first_seen, last_seen = EXCLUDED.last_seen, lost_date = EXCLUDED.lost_date,
   spam_anchor = EXCLUDED.spam_anchor, read_on = EXCLUDED.read_on, read_at = EXCLUDED.read_at`;

export const INSERT_AUDIT_TARGET = `INSERT INTO link_audit_targets (id, client_id, page_path, kind, status_code, redirect_path, backlinks, referring_domains, read_on, read_at)
 SELECT t.id, $1, t.page_path, t.kind, t.status_code, t.redirect_path, t.backlinks, t.referring_domains, $2, $3
   FROM jsonb_to_recordset($4::jsonb) AS t(id text, page_path text, kind text, status_code int, redirect_path text, backlinks int, referring_domains int)
 ON CONFLICT (client_id, page_path) DO UPDATE SET kind = EXCLUDED.kind, status_code = EXCLUDED.status_code, redirect_path = EXCLUDED.redirect_path,
   backlinks = EXCLUDED.backlinks, referring_domains = EXCLUDED.referring_domains, read_on = EXCLUDED.read_on, read_at = EXCLUDED.read_at`;

export const INSERT_AUDIT_ANCHOR = `INSERT INTO link_audit_anchors (id, client_id, anchor, referring_domains, backlinks, first_seen, last_seen, read_on, read_at)
 SELECT t.id, $1, t.anchor, t.referring_domains, t.backlinks, t.first_seen, t.last_seen, $2, $3
   FROM jsonb_to_recordset($4::jsonb) AS t(id text, anchor text, referring_domains int, backlinks int, first_seen text, last_seen text)
 ON CONFLICT (client_id, anchor) DO UPDATE SET referring_domains = EXCLUDED.referring_domains, backlinks = EXCLUDED.backlinks, first_seen = EXCLUDED.first_seen,
   last_seen = EXCLUDED.last_seen, read_on = EXCLUDED.read_on, read_at = EXCLUDED.read_at`;

export const INSERT_AUDIT_GAP = `INSERT INTO link_audit_gap (id, client_id, ref_domain, rank, spam_score, competitors_linked, competitors, read_on, read_at)
 SELECT t.id, $1, t.ref_domain, t.rank, t.spam_score, t.competitors_linked, t.competitors, $2, $3
   FROM jsonb_to_recordset($4::jsonb) AS t(id text, ref_domain text, rank int, spam_score int, competitors_linked int, competitors text)
 ON CONFLICT (client_id, ref_domain) DO UPDATE SET rank = EXCLUDED.rank, spam_score = EXCLUDED.spam_score, competitors_linked = EXCLUDED.competitors_linked,
   competitors = EXCLUDED.competitors, read_on = EXCLUDED.read_on, read_at = EXCLUDED.read_at`;

export const INSERT_AUDIT_RUN = `INSERT INTO link_audit_runs (id, client_id, status, detail, read_on, domains_state, domains_read, domains_total, anchors_state, anchors_read, targets_state, targets_read, gap_state, gap_read, spam_state, estimated_usd, spent_usd, ran_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
 ON CONFLICT (client_id) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, read_on = EXCLUDED.read_on, domains_state = EXCLUDED.domains_state,
   domains_read = EXCLUDED.domains_read, domains_total = EXCLUDED.domains_total, anchors_state = EXCLUDED.anchors_state, anchors_read = EXCLUDED.anchors_read,
   targets_state = EXCLUDED.targets_state, targets_read = EXCLUDED.targets_read, gap_state = EXCLUDED.gap_state, gap_read = EXCLUDED.gap_read,
   spam_state = EXCLUDED.spam_state, estimated_usd = EXCLUDED.estimated_usd, spent_usd = EXCLUDED.spent_usd, ran_at = EXCLUDED.ran_at`;

/** Table names a replace may clear, one per part. A fixed list: never built from input. */
const CLEAR: Record<"domains" | "targets" | "anchors" | "gap", string> = {
  domains: "DELETE FROM link_audit_domains WHERE client_id = $1",
  targets: "DELETE FROM link_audit_targets WHERE client_id = $1",
  anchors: "DELETE FROM link_audit_anchors WHERE client_id = $1",
  gap: "DELETE FROM link_audit_gap WHERE client_id = $1",
};

async function writeRows(c: Queryable, sql: string, clientId: string, readOn: string, at: Date, rows: Array<Record<string, unknown>>): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) await c.query(sql, [clientId, readOn, at, JSON.stringify(rows.slice(i, i + BATCH))]);
}

/** Replace on a complete read, upsert over a capped one, leave a failed or skipped part alone. */
async function part(c: Queryable, kind: keyof typeof CLEAR, state: PartState, clientId: string, write: () => Promise<void>): Promise<void> {
  if (state === "ok" || state === "no_data") await c.query(CLEAR[kind], [clientId]);
  if (state === "ok" || state === "capped") await write();
}

export async function writeAudit(c: Queryable, clientId: string, ownDomain: string, a: AuditRead, readOn: string, at: Date): Promise<void> {
  await c.query("BEGIN");
  try {
    for (const s of a.summaries) {
      await c.query(INSERT_SUMMARY, [hid("s", clientId, s.domain, readOn), clientId, s.domain, s.role, readOn, s.backlinks, s.referringDomains, s.referringMainDomains, s.brokenBacklinks, s.anchorLinks, s.imageLinks, s.otherLinks, null, null, null, null, null, s.costUsd, at]);
    }
    if (a.domains && (a.domainsState === "ok" || a.domainsState === "capped")) {
      await part(c, "domains", a.domainsState, clientId, () => writeRows(c, INSERT_AUDIT_DOMAIN, clientId, readOn, at, a.domains!.map((d) => ({
        id: hid("d", clientId, d.refDomain), ref_domain: d.refDomain, tld: d.tld, rank: d.rank, spam_score: d.spamScore, backlinks: d.backlinks, dofollow_backlinks: d.dofollowBacklinks,
        first_seen: d.firstSeen, last_seen: d.lastSeen, lost_date: d.lostDate, spam_anchor: d.spamAnchor,
      }))));
      // The older table keeps the top of the same read, for the competitor comparisons that read it.
      for (const d of a.domains.slice(0, 200)) await c.query(INSERT_DOMAIN, [hid("o", clientId, ownDomain, readOn, d.refDomain), clientId, ownDomain, readOn, d.refDomain, d.backlinks, d.firstSeen, at]);
    }
    if (a.targets) await part(c, "targets", a.targetsState, clientId, () => writeRows(c, INSERT_AUDIT_TARGET, clientId, readOn, at, a.targets!.map((t) => ({
      id: hid("t", clientId, t.pagePath), page_path: t.pagePath, kind: t.kind, status_code: t.statusCode, redirect_path: t.redirectPath, backlinks: t.backlinks, referring_domains: t.referringDomains,
    }))));
    else if (a.targetsState === "no_data") await c.query(CLEAR.targets, [clientId]);
    if (a.anchors) await part(c, "anchors", a.anchorsState, clientId, () => writeRows(c, INSERT_AUDIT_ANCHOR, clientId, readOn, at, a.anchors!.map((x) => ({
      id: hid("a", clientId, x.anchor), anchor: x.anchor, referring_domains: x.referringDomains, backlinks: x.backlinks, first_seen: x.firstSeen, last_seen: x.lastSeen,
    }))));
    else if (a.anchorsState === "no_data") await c.query(CLEAR.anchors, [clientId]);
    if (a.gap) await part(c, "gap", a.gapState, clientId, () => writeRows(c, INSERT_AUDIT_GAP, clientId, readOn, at, a.gap!.map((g) => ({
      id: hid("g", clientId, g.refDomain), ref_domain: g.refDomain, rank: g.rank, spam_score: g.spamScore, competitors_linked: g.competitors.length, competitors: g.competitors.join(","),
    }))));
    else if (a.gapState === "no_data") await c.query(CLEAR.gap, [clientId]);
    await c.query(INSERT_RUN, [hid("r", clientId), clientId, a.status, a.detail, a.domains?.length ?? 0, a.estimatedUsd, a.spentUsd, at]);
    await c.query(INSERT_AUDIT_RUN, [
      hid("ar", clientId), clientId, a.status, a.detail, readOn, a.domainsState, a.domainsRead, a.domainsTotal, a.anchorsState, a.anchorsRead,
      a.targetsState, a.targetsRead, a.gapState, a.gapRead, a.spamState, a.estimatedUsd, a.spentUsd, at,
    ]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

/** A client the read could not run for (no site, search off, no key): only the run row says so; every stored row stays. */
export async function writeRunOnly(c: Queryable, clientId: string, status: "off" | "no_key" | "error", detail: string, at: Date): Promise<void> {
  await c.query(INSERT_RUN, [hid("r", clientId), clientId, status, detail, 0, null, null, at]);
  await c.query(INSERT_AUDIT_RUN, [hid("ar", clientId), clientId, status, detail, null, "skipped", null, null, "skipped", null, "skipped", null, "skipped", null, "skipped", null, null, at]);
}

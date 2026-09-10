#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: the nightly /api/cron/lead-hygiene (Vercel Cron, native --
 * see CLAUDE.md) should be auto-classifying score-0 prospect/unclassified
 * contacts older than 14 days as solicitors. debug-bsllc-leads-staleness
 * found 1311 leads-board candidates, all score 0, all 31-90 days old --
 * well past the 14-day cutoff -- and NONE have been swept. Is the cron
 * actually running? Check for its fingerprint: crm_activities rows with
 * subject "Auto-classified as solicitor" (system-inserted by sweepStaleLeads),
 * and how many of the 1311 candidates have accountRole set (a sweep
 * exemption not checked by the previous script).
 *
 *   npm run debug-lead-hygiene-cron-status
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const PRE_SQL_STAGES = new Set(["subscriber", "lead", "marketingqualifiedlead"]);

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: sweepEvents } = await c.query<{ n: string; last: string | null; first: string | null }>(
      `SELECT COUNT(*) AS n, MAX(occurred_at) AS last, MIN(occurred_at) AS first FROM crm_activities
        WHERE kind = 'lifecycle_change' AND subject = 'Auto-classified as solicitor'`,
    );
    console.log(`Auto-classified-as-solicitor events ever logged: ${sweepEvents[0]?.n ?? 0} (first ${sweepEvents[0]?.first}, last ${sweepEvents[0]?.last})\n`);

    const { rows: heartbeats } = await c.query<{ job: string; status: string; occurred_at: string }>(
      `SELECT job, status, occurred_at FROM heartbeats WHERE job ILIKE '%lead%hygiene%' ORDER BY occurred_at DESC LIMIT 5`,
    ).catch(() => ({ rows: [] as Array<{ job: string; status: string; occurred_at: string }> }));
    console.log(`Heartbeats matching lead-hygiene (worker-side jobs only -- this cron is native Vercel, may not heartbeat here): ${heartbeats.length} row(s)`);
    for (const h of heartbeats) console.log(`  ${h.job} — ${h.status} @ ${h.occurred_at}`);

    const { rows: candidates } = await c.query<{
      id: string; account_role: string | null; company_id: string | null; created_at: string;
    }>(
      `SELECT id, account_role, company_id, created_at FROM contacts
        WHERE (contact_type IS NULL OR contact_type = 'prospect')
          AND (lifecycle_stage IS NULL OR lifecycle_stage IN ('subscriber','lead','marketingqualifiedlead'))`,
    );
    const withRole = candidates.filter((c) => c.account_role).length;
    const withCompany = candidates.filter((c) => c.company_id).length;
    console.log(`\nOf ${candidates.length} board candidates: ${withRole} have accountRole set (sweep-exempt), ${withCompany} have a companyId set.`);

    const cutoff = new Date(Date.now() - 14 * 86_400_000);
    const eligible = candidates.filter((c) => !c.account_role && new Date(c.created_at) < cutoff);
    console.log(`${eligible.length} are >14 days old AND have no accountRole -- these should already be solicitor if the cron ran even once.`);

    const { rows: latestFew } = await c.query<{ name: string; created_at: string; original_source: string | null; hubspot_id: string | null }>(
      `SELECT name, created_at, original_source, hubspot_id FROM contacts
        WHERE (contact_type IS NULL OR contact_type = 'prospect')
          AND (lifecycle_stage IS NULL OR lifecycle_stage IN ('subscriber','lead','marketingqualifiedlead'))
        ORDER BY created_at ASC LIMIT 10`,
    );
    console.log(`\n10 OLDEST board candidates (these should be the first ever swept):`);
    for (const r of latestFew) console.log(`  ${r.name} — created ${r.created_at} — source=${r.original_source ?? "(none)"} — hubspotId=${r.hubspot_id ?? "(none)"}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: why does the BS LLC Leads board (getLeadsBoard in storage.ts)
 * show old, dead HubSpot contacts as if they're active? Hypothesis: a
 * contact with ANY outbound crm_activities row -- even one logged years ago
 * -- gets permanent engagement score > 0 (getContactEngagement), which
 * exempts it from sweepStaleLeads forever AND keeps it off the "needs
 * follow-up" flag. So a long-dead HubSpot lead with one old logged call
 * just sits on the board indefinitely, looking "active" (MQL badge) with no
 * red dot. This checks whether that's actually happening at scale.
 *
 *   npm run debug-bsllc-leads-staleness
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const PRE_SQL_STAGES = new Set(["subscriber", "lead", "marketingqualifiedlead"]);

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: candidates } = await c.query<{
      id: string; name: string; email: string | null; created_at: string;
      hubspot_id: string | null; original_source: string | null; lifecycle_stage: string | null;
    }>(
      `SELECT id, name, email, created_at, hubspot_id, original_source, lifecycle_stage FROM contacts
        WHERE (contact_type IS NULL OR contact_type = 'prospect')
          AND (lifecycle_stage IS NULL OR lifecycle_stage IN ('subscriber','lead','marketingqualifiedlead'))`,
    );
    console.log(`${candidates.length} candidate(s) match the Leads board filter (contactType null/prospect, lifecycleStage null/subscriber/lead/mql).\n`);

    const ids = candidates.map((c) => c.id);
    if (ids.length === 0) return;

    const { rows: onDeal } = await c.query<{ contact_id: string }>(
      `SELECT DISTINCT contact_id FROM (
         SELECT contact_id FROM deals WHERE contact_id = ANY($1)
         UNION SELECT contact_id FROM deal_contacts WHERE contact_id = ANY($1)
       ) x`,
      [ids],
    );
    const onDealSet = new Set(onDeal.map((r) => r.contact_id));
    const board = candidates.filter((c) => !onDealSet.has(c.id));
    console.log(`${board.length} actually on the board (excludes ${onDeal.length} already on a deal).\n`);

    const { rows: lastOutbound } = await c.query<{ contact_id: string; last: string }>(
      `SELECT contact_id, MAX(occurred_at) AS last FROM crm_activities
        WHERE contact_id = ANY($1) AND direction = 'outbound' GROUP BY contact_id`,
      [board.map((b) => b.id)],
    );
    const lastOutboundMap = new Map(lastOutbound.map((r) => [r.contact_id, r.last]));

    const now = Date.now();
    const DAY = 86_400_000;
    let neverTouched = 0, touchedRecent90 = 0, touchedStale = 0;
    const staleExamples: Array<{ name: string; ageDays: number; lastTouchDaysAgo: number; source: string | null }> = [];
    for (const b of board) {
      const ageDays = Math.floor((now - new Date(b.created_at).getTime()) / DAY);
      const last = lastOutboundMap.get(b.id);
      if (!last) { neverTouched++; continue; }
      const lastTouchDaysAgo = Math.floor((now - new Date(last).getTime()) / DAY);
      if (lastTouchDaysAgo <= 90) { touchedRecent90++; continue; }
      touchedStale++;
      if (staleExamples.length < 15) staleExamples.push({ name: b.name, ageDays, lastTouchDaysAgo, source: b.original_source });
    }
    console.log(`Of ${board.length} on the board:`);
    console.log(`  ${neverTouched} never had an outbound touch logged (score 0 -- eligible for the nightly 14-day sweep, needsFollowUp works normally)`);
    console.log(`  ${touchedRecent90} have an outbound touch within the last 90 days (genuinely being worked)`);
    console.log(`  ${touchedStale} have an outbound touch, but it's >90 days old (score > 0 forever, PERMANENTLY exempt from the sweep, never flagged needsFollowUp) <-- likely the "old garbage" bucket\n`);

    if (staleExamples.length > 0) {
      console.log(`Examples of stale-but-permanently-exempt leads (name, contact age, days since last touch, source):`);
      for (const e of staleExamples) console.log(`  ${e.name} — ${e.ageDays}d old, last touch ${e.lastTouchDaysAgo}d ago, source=${e.source ?? "(none)"}`);
    }

    const { rows: ageBuckets } = await c.query<{ bucket: string; n: string }>(
      `SELECT CASE
         WHEN created_at > now() - interval '30 days' THEN '0-30d'
         WHEN created_at > now() - interval '90 days' THEN '31-90d'
         WHEN created_at > now() - interval '365 days' THEN '91-365d'
         ELSE '365d+'
       END AS bucket, COUNT(*) AS n
       FROM contacts WHERE id = ANY($1) GROUP BY bucket ORDER BY bucket`,
      [board.map((b) => b.id)],
    );
    console.log(`\nBoard age distribution:`);
    for (const r of ageBuckets) console.log(`  ${r.bucket}: ${r.n}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only diagnostic: scope out what "get rid of solicitors" and "clean up
 * useless contacts" would actually touch, before writing any deletion logic.
 * "solicitor" is an overloaded tag in this codebase -- CONTACT_TYPES treats it
 * as a legit referral source (attorneys/professionals), but sweepStaleLeads
 * and the Leads page's "Dismiss" action both also use it as the bucket for
 * auto-classified dead/spam leads. Those need to stay separable: an evangelist
 * (isEvangelist=true) or anyone credited on a deal's referredByContactId
 * carries real referral-revenue history and must not be swept up in a bulk
 * delete of the same tag.
 *
 *   npm run debug-contact-cleanup-scope
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: totalRow } = await c.query<{ n: string }>(`SELECT COUNT(*) AS n FROM contacts`);
    console.log(`Total contacts: ${totalRow[0]!.n}\n`);

    const { rows: byType } = await c.query<{ contact_type: string | null; n: string }>(
      `SELECT contact_type, COUNT(*) AS n FROM contacts GROUP BY contact_type ORDER BY n DESC`,
    );
    console.log(`By contact_type:`);
    for (const r of byType) console.log(`  ${r.contact_type ?? "(null)"}\t${r.n}`);

    console.log(`\n-- Solicitor bucket breakdown --`);
    const { rows: solTotal } = await c.query<{ n: string }>(`SELECT COUNT(*) AS n FROM contacts WHERE contact_type = 'solicitor'`);
    console.log(`Total solicitor contacts: ${solTotal[0]!.n}`);

    const { rows: solEvangelist } = await c.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM contacts WHERE contact_type = 'solicitor' AND is_evangelist = true`,
    );
    console.log(`  ...marked isEvangelist (real referral-revenue tracking): ${solEvangelist[0]!.n}`);

    const { rows: solReferred } = await c.query<{ n: string }>(
      `SELECT COUNT(DISTINCT c.id) AS n FROM contacts c
         JOIN deals d ON d.referred_by_contact_id = c.id
        WHERE c.contact_type = 'solicitor'`,
    );
    console.log(`  ...credited as referredByContactId on at least one deal: ${solReferred[0]!.n}`);

    const { rows: solEitherProtected } = await c.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM contacts c
        WHERE c.contact_type = 'solicitor'
          AND (c.is_evangelist = true OR EXISTS (SELECT 1 FROM deals d WHERE d.referred_by_contact_id = c.id))`,
    );
    console.log(`  ...either (protected -- has real referral value): ${solEitherProtected[0]!.n}`);

    const { rows: solHasActivity } = await c.query<{ n: string }>(
      `SELECT COUNT(DISTINCT c.id) AS n FROM contacts c
         JOIN crm_activities a ON a.contact_id = c.id
        WHERE c.contact_type = 'solicitor'`,
    );
    console.log(`  ...has at least one logged crm_activities row (any kind, including the auto-sweep note itself): ${solHasActivity[0]!.n}`);

    const { rows: solOutbound } = await c.query<{ n: string }>(
      `SELECT COUNT(DISTINCT c.id) AS n FROM contacts c
         JOIN crm_activities a ON a.contact_id = c.id AND a.direction = 'outbound'
        WHERE c.contact_type = 'solicitor'`,
    );
    console.log(`  ...has a real OUTBOUND touch logged (someone actually called/emailed them): ${solOutbound[0]!.n}`);

    console.log(`\n-- System-wide "useless" candidates (no email, no phone, no company, not on any deal, never referenced, zero activity/sms) --`);
    const { rows: uselessRows } = await c.query<{ contact_type: string | null; n: string }>(
      `SELECT c.contact_type, COUNT(*) AS n
         FROM contacts c
        WHERE c.email IS NULL AND c.phone IS NULL AND c.company_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.contact_id = c.id OR d.referred_by_contact_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.contact_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM crm_activities a WHERE a.contact_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM sms_messages s WHERE s.contact_id = c.id)
          AND c.is_evangelist = false
        GROUP BY c.contact_type ORDER BY n DESC`,
    );
    let uselessTotal = 0;
    for (const r of uselessRows) { console.log(`  ${r.contact_type ?? "(null)"}\t${r.n}`); uselessTotal += Number(r.n); }
    console.log(`  TOTAL: ${uselessTotal}`);

    console.log(`\n-- Duplicate groups (same normalized email, 2+ contacts) --`);
    const { rows: dupRows } = await c.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT lower(trim(email)) AS e FROM contacts WHERE email IS NOT NULL AND trim(email) != ''
         GROUP BY lower(trim(email)) HAVING COUNT(*) > 1
       ) x`,
    );
    console.log(`  Duplicate email groups: ${dupRows[0]!.n}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

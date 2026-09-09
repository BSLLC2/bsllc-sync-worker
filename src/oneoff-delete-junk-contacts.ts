#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Deletes two categories of contact rows that carry no value, per the
 * bsllc.biz working agreement's "keep the CRM focused and useful" cleanup:
 *
 *  1. Auto-classified "solicitor" contacts (sweepStaleLeads' dead-lead
 *     bucket, reused by the Leads page's "Dismiss" action) that carry NO
 *     real referral value: not flagged isEvangelist, not credited as
 *     referredByContactId on any deal, not the buyer contact on any deal,
 *     not an associated deal_contacts buyer, and never had a real OUTBOUND
 *     touch logged (the one crm_activities row most of them have is just
 *     the auto-sweep's own note, not a human contacting them). This is the
 *     same criteria a live debug-contact-cleanup-scope run confirmed ALL
 *     534 current solicitor rows satisfy -- none are legitimate referral
 *     sources (attorneys/professionals), the intended meaning of that
 *     CONTACT_TYPES value; every one here is dead weight from the hygiene
 *     sweep. Re-evaluated live at delete time, not hardcoded, in case new
 *     data landed since that report.
 *
 *  2. System-wide "empty" contacts of ANY type: no email, no phone, no
 *     company, not evangelist, not on any deal (buyer or referrer or
 *     deal_contacts), and zero logged crm_activities/sms_messages. Blank
 *     records with nothing to clean up around.
 *
 * lead_follow_up_reminders.contact_id carries a real Postgres FK to
 * contacts(id) (the only one that exists -- everything else, crm_activities/
 * deals/deal_contacts/sms_messages/pricing_quotes, is this codebase's usual
 * loose text reference, not enforced) so matching reminder rows are deleted
 * first, then crm_activities/sms_messages for the same contacts (orphaned
 * notes about a deleted contact serve nothing), then the contacts themselves.
 *
 *   npm run oneoff-delete-junk-contacts -- --dry-run   (read-only)
 *   npm run oneoff-delete-junk-contacts                (applies)
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

const SAFE_SOLICITOR_SQL = `
  SELECT c.id, c.name, c.email
    FROM contacts c
   WHERE c.contact_type = 'solicitor'
     AND c.is_evangelist = false
     AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.referred_by_contact_id = c.id OR d.contact_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.contact_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM crm_activities a WHERE a.contact_id = c.id AND a.direction = 'outbound')
`;

const EMPTY_CONTACT_SQL = `
  SELECT c.id, c.name, c.email
    FROM contacts c
   WHERE c.email IS NULL AND c.phone IS NULL AND c.company_id IS NULL
     AND c.is_evangelist = false
     AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.contact_id = c.id OR d.referred_by_contact_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.contact_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM crm_activities a WHERE a.contact_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM sms_messages s WHERE s.contact_id = c.id)
`;

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: solicitors } = await c.query<{ id: string; name: string; email: string | null }>(SAFE_SOLICITOR_SQL);
    const { rows: empties } = await c.query<{ id: string; name: string; email: string | null }>(EMPTY_CONTACT_SQL);

    const byId = new Map<string, { name: string; email: string | null; why: string[] }>();
    for (const r of solicitors) byId.set(r.id, { name: r.name, email: r.email, why: ["dead-lead solicitor, no referral value"] });
    for (const r of empties) {
      const existing = byId.get(r.id);
      if (existing) existing.why.push("also empty");
      else byId.set(r.id, { name: r.name, email: r.email, why: ["empty -- no contact info, no engagement"] });
    }

    console.log(`Solicitor bucket (no referral value, no real engagement): ${solicitors.length}`);
    console.log(`Empty contacts (any type, no info, no engagement): ${empties.length}`);
    console.log(`Total distinct contacts to delete: ${byId.size}\n`);

    let i = 0;
    for (const [id, info] of byId) {
      if (i++ >= 20) { console.log(`  ... and ${byId.size - 20} more`); break; }
      console.log(`  ${id}  ${info.name}  <${info.email ?? "no email"}>  (${info.why.join(", ")})`);
    }

    if (byId.size === 0) { console.log("\nNothing to delete."); return; }
    if (dryRun) { console.log("\n(dry-run — no changes written)"); return; }

    const ids = Array.from(byId.keys());
    const { rowCount: remindersDeleted } = await c.query(`DELETE FROM lead_follow_up_reminders WHERE contact_id = ANY($1::text[])`, [ids]);
    const { rowCount: activitiesDeleted } = await c.query(`DELETE FROM crm_activities WHERE contact_id = ANY($1::text[])`, [ids]);
    const { rowCount: smsDeleted } = await c.query(`DELETE FROM sms_messages WHERE contact_id = ANY($1::text[])`, [ids]);
    const { rowCount: contactsDeleted } = await c.query(`DELETE FROM contacts WHERE id = ANY($1::text[])`, [ids]);

    console.log(`\nDeleted ${contactsDeleted} contact(s), ${activitiesDeleted} crm_activities row(s), ${remindersDeleted} lead_follow_up_reminders row(s), ${smsDeleted} sms_messages row(s).`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

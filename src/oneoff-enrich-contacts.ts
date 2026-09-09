#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import crypto from "node:crypto";

/**
 * One-off backfill: apply the same contact-enrichment logic as the app's
 * storage.enrichContacts() (server/storage.ts, bsllc-account-health) directly
 * against Postgres, for existing contacts that predate that logic. Run here
 * instead of through the live app because this sandbox has no reachable path
 * to the deployed app's authenticated /api/crm/contacts/enrich route.
 *
 * Mirrors storage.enrichContacts() rule-for-rule -- keep both in sync if one
 * changes. Fill-blank-only: never overwrites a field a human (or another
 * sync) already set. Signals, highest confidence first:
 *   - companyId: a deal this contact is actually on (deals.contact_id or
 *     deal_contacts) beats a guessed email-domain match against companies.domain
 *     (free email providers skipped; only applied when exactly one company
 *     shares that domain).
 *   - contactType: "client" if on a Closed Won deal, or their company is
 *     already a client, or they already carry an account role (Billing/PM/
 *     Decision maker/Technical -- only makes sense for a real client contact);
 *     else "prospect" if they have a recorded original_source (came through
 *     a real inbound channel).
 *   - lifecycleStage: "customer" for client/past_client, "opportunity" if on
 *     any still-open deal, "other" for solicitor/vendor/partner, "lead" for
 *     an original_source'd prospect.
 *
 *   npm run oneoff-enrich-contacts -- --dry-run   (read-only, prints the plan)
 *   npm run oneoff-enrich-contacts                (applies)
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "icloud.com",
  "me.com", "live.com", "msn.com", "proton.me", "protonmail.com",
]);

function normalizeDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const trimmed = domain.trim();
  if (!trimmed) return null;
  return (trimmed.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0] ?? trimmed).toLowerCase();
}

interface ContactRow {
  id: string; email: string | null; company_id: string | null;
  contact_type: string | null; lifecycle_stage: string | null;
  original_source: string | null; account_role: string | null;
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: candidates } = await c.query<ContactRow>(
      `SELECT id, email, company_id, contact_type, lifecycle_stage, original_source, account_role
         FROM contacts
        WHERE company_id IS NULL OR contact_type IS NULL OR lifecycle_stage IS NULL`,
    );
    if (candidates.length === 0) {
      console.log("No contacts missing company/type/stage. Nothing to enrich.");
      return;
    }

    const { rows: domainRows } = await c.query<{ id: string; domain: string }>(
      `SELECT id, domain FROM companies WHERE domain IS NOT NULL`,
    );
    const companyIdsByDomain = new Map<string, string[]>();
    for (const r of domainRows) {
      const arr = companyIdsByDomain.get(r.domain) ?? [];
      arr.push(r.id);
      companyIdsByDomain.set(r.domain, arr);
    }
    const { rows: clientCompanyRows } = await c.query<{ id: string }>(
      `SELECT id FROM companies WHERE client_id IS NOT NULL`,
    );
    const clientCompanyIds = new Set(clientCompanyRows.map((r) => r.id));

    const ids = candidates.map((r) => r.id);
    const { rows: directDeals } = await c.query<{ contact_id: string; company_id: string | null; status: string }>(
      `SELECT contact_id, company_id, status FROM deals WHERE contact_id = ANY($1::text[])`,
      [ids],
    );
    const { rows: dcRows } = await c.query<{ contact_id: string; deal_id: string }>(
      `SELECT contact_id, deal_id FROM deal_contacts WHERE contact_id = ANY($1::text[])`,
      [ids],
    );
    const dealIdsFromDc = dcRows.map((r) => r.deal_id);
    const { rows: linkedDeals } = dealIdsFromDc.length > 0
      ? await c.query<{ id: string; company_id: string | null; status: string }>(
          `SELECT id, company_id, status FROM deals WHERE id = ANY($1::text[])`,
          [dealIdsFromDc],
        )
      : { rows: [] as { id: string; company_id: string | null; status: string }[] };
    const dealById = new Map(linkedDeals.map((d) => [d.id, d]));

    const dealInfoByContact = new Map<string, { companyIds: Set<string>; won: boolean; open: boolean }>();
    const noteDeal = (contactId: string | null, companyId: string | null, status: string) => {
      if (!contactId) return;
      let info = dealInfoByContact.get(contactId);
      if (!info) { info = { companyIds: new Set(), won: false, open: false }; dealInfoByContact.set(contactId, info); }
      if (companyId) info.companyIds.add(companyId);
      if (status === "won") info.won = true;
      if (status === "open") info.open = true;
    };
    for (const r of directDeals) noteDeal(r.contact_id, r.company_id, r.status);
    for (const r of dcRows) {
      const d = dealById.get(r.deal_id);
      if (d) noteDeal(r.contact_id, d.company_id, d.status);
    }

    type Patch = { companyId?: string; contactType?: string; lifecycleStage?: string };
    const plan: Array<{ id: string; patch: Patch }> = [];
    for (const row of candidates) {
      const patch: Patch = {};
      const dealInfo = dealInfoByContact.get(row.id);

      let companyId: string | null = row.company_id;
      if (!companyId && dealInfo && dealInfo.companyIds.size === 1) {
        companyId = Array.from(dealInfo.companyIds)[0] ?? null;
        if (companyId) patch.companyId = companyId;
      } else if (!companyId && row.email) {
        const domain = normalizeDomain(row.email.split("@")[1]);
        if (domain && !FREE_EMAIL_DOMAINS.has(domain)) {
          const matches = companyIdsByDomain.get(domain);
          if (matches && matches.length === 1) {
            companyId = matches[0] ?? null;
            if (companyId) patch.companyId = companyId;
          }
        }
      }

      let contactType = row.contact_type;
      if (!contactType) {
        if (dealInfo?.won) contactType = "client";
        else if (companyId && clientCompanyIds.has(companyId)) contactType = "client";
        else if (row.account_role) contactType = "client";
        else if (row.original_source) contactType = "prospect";
        if (contactType) patch.contactType = contactType;
      }

      if (!row.lifecycle_stage) {
        let lifecycleStage: string | null = null;
        if (contactType === "client" || contactType === "past_client") lifecycleStage = "customer";
        else if (dealInfo?.open) lifecycleStage = "opportunity";
        else if (contactType === "solicitor" || contactType === "vendor" || contactType === "partner") lifecycleStage = "other";
        else if (contactType === "prospect" && row.original_source) lifecycleStage = "lead";
        if (lifecycleStage) patch.lifecycleStage = lifecycleStage;
      }

      if (Object.keys(patch).length > 0) plan.push({ id: row.id, patch });
    }

    if (plan.length === 0) {
      console.log(`Checked ${candidates.length} under-filled contact(s) — no field had enough signal to fill.`);
      return;
    }

    const companyLinked = plan.filter((p) => p.patch.companyId).length;
    const typeSet = plan.filter((p) => p.patch.contactType).length;
    const stageSet = plan.filter((p) => p.patch.lifecycleStage).length;
    console.log(`Checked ${candidates.length} under-filled contact(s) — ${plan.length} to enrich (${companyLinked} company, ${typeSet} type, ${stageSet} stage).`);
    for (const p of plan.slice(0, 25)) {
      console.log(`  ${p.id}: ${JSON.stringify(p.patch)}`);
    }
    if (plan.length > 25) console.log(`  ... and ${plan.length - 25} more`);

    if (dryRun) { console.log("\n(dry-run — no changes written)"); return; }

    for (const p of plan) {
      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (p.patch.companyId) { sets.push(`company_id = $${i++}`); values.push(p.patch.companyId); }
      if (p.patch.contactType) { sets.push(`contact_type = $${i++}`); values.push(p.patch.contactType); }
      if (p.patch.lifecycleStage) { sets.push(`lifecycle_stage = $${i++}`); values.push(p.patch.lifecycleStage); }
      values.push(p.id);
      await c.query(`UPDATE contacts SET ${sets.join(", ")} WHERE id = $${i}`, values);

      const kind = p.patch.contactType || p.patch.lifecycleStage ? "lifecycle_change" : "note";
      const filled = Object.keys(p.patch).join(", ");
      await c.query(
        `INSERT INTO crm_activities (id, contact_id, kind, source, subject, body)
         VALUES ($1, $2, $3, 'system', $4, $5)`,
        [
          crypto.randomUUID(), p.id, kind, "Auto-enriched from existing data",
          `Filled in: ${filled} — based on real deal involvement, email domain, source, account role, or company/client association already on file.`,
        ],
      );
    }
    console.log(`\nEnriched ${plan.length} contact(s).`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

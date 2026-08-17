#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * Syncs ALL HubSpot deals into the app's `deals` table (and the companies they
 * hang off), so the in-app pipeline mirrors HubSpot while the team is still
 * mid-transition. Idempotent: upserts by hubspot_id, safe to run on a schedule.
 *
 * The deployed app makes no third-party calls (per the working agreement); this
 * worker is the external sync process that writes to Postgres.
 *
 * Env: HUBSPOT_TOKEN (private-app token with crm.objects.deals.read,
 *      crm.objects.companies.read, crm.objects.owners.read, and
 *      crm.pipelines.read), DATABASE_URL.
 *
 *   npm run import-hubspot-deals
 *   npm run import-hubspot-deals -- --dry-run
 */
const HS = "https://api.hubapi.com";

function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function hs<T = any>(path: string, token: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HS}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429 && attempt < 6) { await sleep(1000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`HubSpot ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
  }
}
async function hsPost<T = any>(path: string, token: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HS}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 429 && attempt < 6) { await sleep(1000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`HubSpot POST ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Map an open HubSpot stage label onto the app's 4 open stages (won/lost are
// decided by stage metadata, not label).
function mapOpenStage(label: string): string {
  const l = label.toLowerCase();
  if (/qualif/.test(l)) return "Qualified to buy";
  if (/decision|bought|buy-in|bought-in/.test(l)) return "Decision maker bought-in";
  if (/contract|signed|negoti|develop/.test(l)) return "Contract sent";
  if (/pitch|present|proposal|appointment|demo|scheduled/.test(l)) return "Project pitched";
  return "Qualified to buy";
}

interface StageInfo { label: string; isClosed: boolean; probability: number }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const token = env("HUBSPOT_TOKEN");

  // 1) Pipelines → stageId → {label, isClosed, probability}
  const pipes = await hs<{ results: Array<{ label: string; stages: Array<{ id: string; label: string; metadata: Record<string, string> }> }> }>("/crm/v3/pipelines/deals", token);
  const stageMap = new Map<string, StageInfo>();
  for (const p of pipes.results) for (const s of p.stages) {
    stageMap.set(s.id, { label: s.label, isClosed: s.metadata?.isClosed === "true", probability: Number(s.metadata?.probability ?? "0") });
  }

  // 2) Owners → id → name
  const ownerMap = new Map<string, string>();
  let ownerAfter: string | undefined;
  do {
    const q: { results: Array<{ id: string; firstName?: string; lastName?: string; email?: string }>; paging?: { next?: { after?: string } } } =
      await hs(`/crm/v3/owners?limit=100${ownerAfter ? `&after=${ownerAfter}` : ""}`, token);
    for (const o of q.results) ownerMap.set(o.id, [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.email || "");
    ownerAfter = q.paging?.next?.after;
  } while (ownerAfter);

  // 3) Page through all deals with their company association.
  const props = ["dealname", "amount", "dealstage", "pipeline", "closedate", "hubspot_owner_id", "closed_lost_reason_deal", "hs_lastmodifieddate", "notes_last_updated"];
  type HsDeal = { id: string; properties: Record<string, string>; associations?: { companies?: { results?: Array<{ id: string }> } } };
  const deals: HsDeal[] = [];
  let after: string | undefined;
  do {
    const q: { results: HsDeal[]; paging?: { next?: { after?: string } } } =
      await hs(`/crm/v3/objects/deals?limit=100&associations=companies&properties=${props.join(",")}${after ? `&after=${after}` : ""}`, token);
    deals.push(...q.results);
    after = q.paging?.next?.after;
  } while (after);
  console.log(`import-hubspot-deals — pulled ${deals.length} deals, ${stageMap.size} stages, ${ownerMap.size} owners${dryRun ? " (dry-run)" : ""}`);

  // 4) Batch-resolve company names for all associated company ids.
  const companyIds = Array.from(new Set(deals.map((d) => d.associations?.companies?.results?.[0]?.id).filter(Boolean) as string[]));
  const companyName = new Map<string, string>();
  for (let i = 0; i < companyIds.length; i += 100) {
    const chunk = companyIds.slice(i, i + 100);
    const r = await hsPost<{ results: Array<{ id: string; properties: { name?: string } }> }>("/crm/v3/objects/companies/batch/read", token, { properties: ["name"], inputs: chunk.map((id) => ({ id })) });
    for (const c of r.results) companyName.set(c.id, c.properties?.name ?? "");
  }

  if (dryRun) {
    const byStatus = { won: 0, lost: 0, open: 0 };
    for (const d of deals) {
      const si = stageMap.get(d.properties.dealstage ?? "");
      const status = !si ? "open" : si.isClosed ? (si.probability >= 1 ? "won" : "lost") : "open";
      byStatus[status as keyof typeof byStatus]++;
    }
    console.log(`  would upsert: ${byStatus.won} won, ${byStatus.lost} lost, ${byStatus.open} open; ${companyIds.length} companies`);
    return;
  }

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    // 5) Upsert companies (by hubspot_id, else by lower(name)) → app company id.
    const appCompanyId = new Map<string, string>(); // hubspotCompanyId → app id
    for (const hsCoId of companyIds) {
      const name = (companyName.get(hsCoId) || "").trim();
      if (!name) continue;
      let id: string | undefined;
      const byHs = await c.query<{ id: string }>(`SELECT id FROM companies WHERE hubspot_id = $1 LIMIT 1`, [hsCoId]);
      if (byHs.rows[0]) id = byHs.rows[0].id;
      if (!id) {
        const byName = await c.query<{ id: string }>(`SELECT id FROM companies WHERE lower(name) = lower($1) LIMIT 1`, [name]);
        if (byName.rows[0]) { id = byName.rows[0].id; await c.query(`UPDATE companies SET hubspot_id = $1 WHERE id = $2 AND hubspot_id IS NULL`, [hsCoId, id]); }
      }
      if (!id) {
        id = randomUUID();
        await c.query(`INSERT INTO companies (id, name, hubspot_id, notes) VALUES ($1, $2, $3, 'Imported from HubSpot')`, [id, name, hsCoId]);
      }
      appCompanyId.set(hsCoId, id);
    }

    // 6) Upsert deals by hubspot_id.
    let created = 0, updated = 0;
    for (const d of deals) {
      const p = d.properties;
      const si = stageMap.get(p.dealstage ?? "");
      const status = !si ? "open" : si.isClosed ? (si.probability >= 1 ? "won" : "lost") : "open";
      const stage = status === "won" ? "Closed won" : status === "lost" ? "Closed lost" : mapOpenStage(si?.label ?? "");
      const amountCents = p.amount ? Math.round(Number(p.amount) * 100) : 0;
      const closeDate = p.closedate ? p.closedate.slice(0, 10) : null;
      const ownerName = p.hubspot_owner_id ? (ownerMap.get(p.hubspot_owner_id) || null) : null;
      const lostReason = status === "lost" ? (p.closed_lost_reason_deal || null) : null;
      const hsCoId = d.associations?.companies?.results?.[0]?.id;
      const companyId = hsCoId ? (appCompanyId.get(hsCoId) ?? null) : null;
      const closedAt = status === "open" ? null : (p.hs_lastmodifieddate ? new Date(p.hs_lastmodifieddate) : new Date());
      const lastContacted = p.notes_last_updated ? new Date(p.notes_last_updated) : null;
      const name = (p.dealname || "Untitled deal").trim();

      const existing = await c.query<{ id: string }>(`SELECT id FROM deals WHERE hubspot_id = $1 LIMIT 1`, [d.id]);
      if (existing.rows[0]) {
        await c.query(
          `UPDATE deals SET name=$1, company_id=COALESCE($2, company_id), stage=$3, status=$4, amount_cents=$5,
             close_date=$6, owner_name=$7, closed_lost_reason=$8, source=COALESCE(source,'hubspot'),
             closed_at=$9, last_contacted_at=$10 WHERE id=$11`,
          [name, companyId, stage, status, amountCents, closeDate, ownerName, lostReason, closedAt, lastContacted, existing.rows[0].id],
        );
        updated++;
      } else {
        await c.query(
          `INSERT INTO deals (id, name, company_id, stage, status, amount_cents, close_date, owner_name,
             closed_lost_reason, source, hubspot_id, closed_at, last_contacted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'hubspot',$10,$11,$12)`,
          [randomUUID(), name, companyId, stage, status, amountCents, closeDate, ownerName, lostReason, d.id, closedAt, lastContacted],
        );
        created++;
      }
    }
    console.log(`Done: ${created} created, ${updated} updated, ${appCompanyId.size} companies linked.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

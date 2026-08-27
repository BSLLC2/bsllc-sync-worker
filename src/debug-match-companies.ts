#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off diagnostic: how well do our CRM company names actually match QBO
 * customer DisplayNames? getUnbilledClosedWonDeals() only excludes a deal
 * from "not yet billed" when it can match the deal's company to a QBO
 * customer (via an explicit link or an exact name match) AND that customer
 * has real billing evidence — so if name matching is failing broadly, the
 * list stays huge with real false positives even though the QBO data itself
 * is fine. This prints match-rate stats plus real examples so the actual
 * matching logic can be fixed based on evidence, not another guess.
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(llc|inc|incorporated|corp|corporation|co|company|ltd|llp|pllc|pc)\b\.?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const { rows: companies } = await c.query<{ id: string; name: string }>(`SELECT id, name FROM companies`);
    const { rows: qboCustomers } = await c.query<{ id: string; name: string }>(`SELECT id, name FROM qbo_customers`);
    const qboByExact = new Map(qboCustomers.map((q) => [q.name.trim().toLowerCase(), q]));
    const qboByNorm = new Map(qboCustomers.map((q) => [normalize(q.name), q]));

    // Only companies with at least one Closed Won deal matter for this list.
    const { rows: wonCompanyIds } = await c.query<{ company_id: string | null }>(
      `SELECT DISTINCT company_id FROM deals WHERE status = 'won' AND company_id IS NOT NULL`,
    );
    const relevantIds = new Set(wonCompanyIds.map((r) => r.company_id));
    const relevant = companies.filter((co) => relevantIds.has(co.id));

    let exact = 0, normOnly = 0, none = 0;
    const noneExamples: string[] = [];
    const normExamples: { company: string; qbo: string }[] = [];
    for (const co of relevant) {
      const nameLower = co.name.trim().toLowerCase();
      if (qboByExact.has(nameLower)) { exact++; continue; }
      const norm = normalize(co.name);
      const hit = qboByNorm.get(norm);
      if (hit) { normOnly++; if (normExamples.length < 15) normExamples.push({ company: co.name, qbo: hit.name }); continue; }
      none++;
      if (noneExamples.length < 40) noneExamples.push(co.name);
    }
    console.log(`companies with a Closed Won deal: ${relevant.length}`);
    console.log(`qbo customers synced: ${qboCustomers.length}`);
    console.log(`exact match: ${exact}, normalized-only match: ${normOnly}, no match at all: ${none}`);
    console.log(`sample normalized-only matches (company -> qbo): ${JSON.stringify(normExamples, null, 2)}`);
    console.log(`sample UNMATCHED company names: ${JSON.stringify(noneExamples, null, 2)}`);
    console.log(`sample qbo customer names (first 40): ${JSON.stringify(qboCustomers.slice(0, 40).map((q) => q.name), null, 2)}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

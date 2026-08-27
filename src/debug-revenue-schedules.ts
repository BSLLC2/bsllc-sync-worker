#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off diagnostic: Gap Analysis month table shows scheduled+pipeline
 * revenue collapsing to near-zero (~$300/mo) for Oct/Nov/Dec despite active
 * MRR retainers presumably continuing. scheduledCentsForMonth() sums active
 * revenue_schedules rows where ym is between startDate and endDate
 * (inclusive, endDate null = ongoing) — so this checks whether most active
 * recurring rows have an endDate that cuts off before Oct, and where that
 * endDate is coming from (clients.contractEnd for the backfill path,
 * deals.retainerTermMonths for the deal-close path).
 */
async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const now = new Date();
    // 2 months out from "now" is where the reported drop starts (Oct, when
    // this ran in Aug) -- computed instead of hardcoded so this stays valid
    // whenever it's re-run.
    const cutoff = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const cutoffMonthEnd = new Date(now.getFullYear(), now.getMonth() + 3, 0).toISOString().slice(0, 10);
    console.log(`using cutoff date: ${cutoffStr} (checking end_date < this)`);

    const { rows: countRows } = await c.query<{ active: boolean; count: string }>(
      `SELECT active, count(*) FROM revenue_schedules GROUP BY active`,
    );
    console.log(`revenue_schedules row counts by active flag: ${JSON.stringify(countRows)}`);
    const { rows: anyRows } = await c.query(`SELECT * FROM revenue_schedules ORDER BY created_at DESC NULLS LAST LIMIT 5`);
    console.log(`most recent 5 revenue_schedules rows (any active state): ${JSON.stringify(anyRows, null, 2)}`);

    const { rows: schedules } = await c.query<{
      id: string; deal_id: string | null; client_id: string | null; kind: string;
      start_date: string; end_date: string | null; monthly_amount_cents: number | null;
      one_time_amount_cents: number | null; active: boolean;
    }>(`SELECT id, deal_id, client_id, kind, start_date, end_date, monthly_amount_cents, one_time_amount_cents, active FROM revenue_schedules WHERE active = true`);

    const recurring = schedules.filter((s) => s.kind === "recurring");
    const oneTime = schedules.filter((s) => s.kind === "one_time");
    const withEnd = recurring.filter((s) => s.end_date);
    const withoutEnd = recurring.filter((s) => !s.end_date);
    const cutoffBeforeOct = withEnd.filter((s) => s.end_date! < cutoffStr);

    let recurringMonthlyTotal = 0;
    for (const s of recurring) recurringMonthlyTotal += s.monthly_amount_cents ?? 0;
    let ongoingMonthlyTotal = 0;
    for (const s of withoutEnd) ongoingMonthlyTotal += s.monthly_amount_cents ?? 0;
    let octMonthlyTotal = 0;
    for (const s of recurring) {
      if (s.start_date <= cutoffStr && (!s.end_date || s.end_date >= cutoffMonthEnd)) octMonthlyTotal += s.monthly_amount_cents ?? 0;
    }

    console.log(`total active revenue_schedules rows: ${schedules.length} (recurring: ${recurring.length}, one_time: ${oneTime.length})`);
    console.log(`recurring rows WITH an end_date: ${withEnd.length}, WITHOUT (ongoing): ${withoutEnd.length}`);
    console.log(`recurring rows whose end_date is BEFORE cutoff: ${cutoffBeforeOct.length}`);
    console.log(`sum of monthly_amount_cents across ALL active recurring rows: $${(recurringMonthlyTotal / 100).toFixed(2)}`);
    console.log(`sum of monthly_amount_cents across rows with NO end_date (would still be active in Oct): $${(ongoingMonthlyTotal / 100).toFixed(2)}`);
    console.log(`computed October total (start<=Oct<=end or no end): $${(octMonthlyTotal / 100).toFixed(2)}`);
    console.log(`sample of recurring rows WITH an end_date cutting off before Oct (first 20):`);
    console.log(JSON.stringify(cutoffBeforeOct.slice(0, 20).map((s) => ({
      dealId: s.deal_id, clientId: s.client_id, start: s.start_date, end: s.end_date, monthly: (s.monthly_amount_cents ?? 0) / 100,
    })), null, 2));

    // Where is that end_date coming from? Cross-reference clients.contractEnd
    // (backfill path) and deals.retainerTermMonths (deal-close path).
    const clientIds = cutoffBeforeOct.filter((s) => s.client_id).map((s) => s.client_id) as string[];
    const dealIds = cutoffBeforeOct.filter((s) => s.deal_id).map((s) => s.deal_id) as string[];
    if (clientIds.length) {
      const { rows: clientRows } = await c.query<{ id: string; name: string; contract_end: string | null; status: string }>(
        `SELECT id, name, contract_end, status FROM clients WHERE id = ANY($1::text[])`,
        [clientIds],
      );
      console.log(`clients behind cutoff-before-Oct schedules (${clientRows.length}):`);
      console.log(JSON.stringify(clientRows.slice(0, 20), null, 2));
    }
    if (dealIds.length) {
      const { rows: dealRows } = await c.query<{ id: string; name: string; retainer_term_months: number | null; closed_at: string | null }>(
        `SELECT id, name, retainer_term_months, closed_at FROM deals WHERE id = ANY($1::text[])`,
        [dealIds],
      );
      console.log(`deals behind cutoff-before-Oct schedules (${dealRows.length}):`);
      console.log(JSON.stringify(dealRows.slice(0, 20), null, 2));
    }

    // Overall client contractEnd distribution for active/launch clients.
    const { rows: allClients } = await c.query<{ id: string; name: string; status: string; contract_end: string | null; monthly_retainer_cents: number | null }>(
      `SELECT id, name, status, contract_end, monthly_retainer_cents FROM clients WHERE status IN ('launch','active')`,
    );
    const withContractEnd = allClients.filter((c2) => c2.contract_end);
    const endingBeforeOct = withContractEnd.filter((c2) => c2.contract_end! < cutoffStr);
    console.log(`active/launch clients: ${allClients.length}, with a contract_end set: ${withContractEnd.length}, contract_end before cutoff: ${endingBeforeOct.length}`);
    console.log(`sample clients with contract_end before Oct (first 20):`);
    console.log(JSON.stringify(endingBeforeOct.slice(0, 20).map((c2) => ({ name: c2.name, contractEnd: c2.contract_end, monthly: (c2.monthly_retainer_cents ?? 0) / 100 })), null, 2));
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

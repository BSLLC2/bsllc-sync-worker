#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off diagnostic: is the app's new QBO-recurring-invoice "Scheduled"
 * projection double-counting invoices that have ALREADY gone out this
 * month (and therefore already exist as a real row in qbo_invoices,
 * already counted in Actual/AR)? A live report showed a large "This
 * month" Scheduled figure that looked too high given most recurring
 * templates' own next-due-date already rolled to next month -- need to
 * see the real per-template numbers, not guess.
 */
function stepDate(d: Date, intervalType: string | null, numInterval: number): Date {
  const n = numInterval || 1;
  switch (intervalType) {
    case "Daily": return new Date(d.getTime() + n * 86_400_000);
    case "Weekly": return new Date(d.getTime() + n * 7 * 86_400_000);
    case "Yearly": return new Date(d.getFullYear() + n, d.getMonth(), d.getDate());
    case "Monthly":
    default: return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
  }
}
function ymOf(d: Date): string { return d.toISOString().slice(0, 7); }

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const now = new Date();
    const currentYm = ymOf(now);
    const { rows: templates } = await c.query<{
      id: string; customer_id: string | null; customer_name: string | null; template_name: string | null;
      amount_cents: number; active: boolean; interval_type: string | null; num_interval: number;
      next_date: string | null; previous_date: string | null;
    }>(`SELECT id, customer_id, customer_name, template_name, amount_cents, active, interval_type, num_interval, next_date, previous_date FROM qbo_recurring_invoices ORDER BY customer_name`);
    console.log(`total recurring templates: ${templates.length}, active: ${templates.filter((t) => t.active).length}`);

    const { rows: invoices } = await c.query<{ id: string; customer_id: string | null; txn_date: string | null; total_cents: number }>(
      `SELECT id, customer_id, txn_date, total_cents FROM qbo_invoices WHERE txn_date >= $1`,
      [`${currentYm}-01`],
    );
    const invoicesByCustomer = new Map<string, { txnDate: string; totalCents: number }[]>();
    for (const inv of invoices) {
      if (!inv.customer_id || !inv.txn_date) continue;
      if (!invoicesByCustomer.has(inv.customer_id)) invoicesByCustomer.set(inv.customer_id, []);
      invoicesByCustomer.get(inv.customer_id)!.push({ txnDate: inv.txn_date, totalCents: inv.total_cents });
    }

    let thisMonthTotal = 0;
    const thisMonthRows: any[] = [];
    for (const t of templates) {
      if (!t.active || !t.amount_cents) continue;
      let cursor = t.next_date ? new Date(t.next_date) : t.previous_date ? stepDate(new Date(t.previous_date), t.interval_type, t.num_interval) : null;
      if (!cursor || Number.isNaN(cursor.getTime())) continue;
      let guard = 0;
      while (ymOf(cursor) < currentYm && guard < 120) { cursor = stepDate(cursor, t.interval_type, t.num_interval); guard++; }
      if (ymOf(cursor) !== currentYm) continue; // only care about what lands THIS month for this check
      thisMonthTotal += t.amount_cents;
      const existingInvoices = t.customer_id ? invoicesByCustomer.get(t.customer_id) ?? [] : [];
      thisMonthRows.push({
        template: t.template_name, customer: t.customer_name, amount: t.amount_cents / 100,
        intervalType: t.interval_type, numInterval: t.num_interval, nextDate: t.next_date, previousDate: t.previous_date,
        computedMonth: ymOf(cursor),
        alreadyInvoicedThisMonth: existingInvoices.map((i) => ({ txnDate: i.txnDate, amount: i.totalCents / 100 })),
      });
    }
    console.log(`sum of active templates landing in current month (${currentYm}) under the app's projection logic: $${(thisMonthTotal / 100).toFixed(2)}`);
    console.log(`count of templates landing this month: ${thisMonthRows.length}`);
    console.log(JSON.stringify(thisMonthRows, null, 2));
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

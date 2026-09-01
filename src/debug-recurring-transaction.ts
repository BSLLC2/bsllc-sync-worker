#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { QboClient } from "./qbo.js";

/**
 * Read-only: dumps the raw QBO RecurringTransaction record(s) matching a
 * customer name filter, full JSON -- for confirming what RecurType/
 * ScheduleInfo actually got persisted, since QBO's own UI label ("Scheduled"
 * vs "Automated" vs "Reminder") doesn't map 1:1 onto the API's RecurType
 * enum in an obvious way. One-off diagnostic, not part of the regular sync.
 *
 *   npm run debug-recurring-transaction -- --customer=Integrus
 */
function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const filter = (arg("customer") ?? "").toLowerCase();
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const qbo = new QboClient(c);
    await qbo.connect();
    const rows = (await qbo.getRecurringInvoiceTemplates()) as { Invoice?: Record<string, unknown> & { CustomerRef?: { name?: string } } }[];
    const matches = filter ? rows.filter((r) => (r.Invoice?.CustomerRef?.name ?? "").toLowerCase().includes(filter)) : rows;
    console.log(`${matches.length} of ${rows.length} recurring transaction(s) matched "${filter}"`);
    for (const m of matches) {
      console.log(JSON.stringify(m, null, 2));
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

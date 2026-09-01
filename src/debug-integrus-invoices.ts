#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { QboClient } from "./qbo.js";

/**
 * Read-only: dumps the full raw QBO Invoice records for Integrus Partners
 * (customer 8310) so we can see Line items + EmailStatus for both INV-1655
 * and INV-1656 -- the user reported seeing two open $5,000 invoices and we
 * need the real content before deciding whether one is a genuine duplicate
 * bill, not guess from the QBO search-results screenshot alone.
 *
 *   npm run debug-integrus-invoices
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const qbo = new QboClient(c);
    await qbo.connect();
    const call = (qbo as unknown as { call: <T>(method: string, path: string) => Promise<T> }).call.bind(qbo);
    const q = encodeURIComponent(`SELECT * FROM Invoice WHERE CustomerRef = '8310'`);
    const res = await call<{ QueryResponse?: { Invoice?: unknown[] } }>("GET", `query?query=${q}`);
    const invoices = res.QueryResponse?.Invoice ?? [];
    console.log(`${invoices.length} invoice(s) found for customer 8310`);
    for (const inv of invoices) {
      console.log(JSON.stringify(inv, null, 2));
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

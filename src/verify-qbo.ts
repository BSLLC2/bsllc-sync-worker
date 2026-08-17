#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { QboClient } from "./qbo.js";

/**
 * Read-only go-live check for QuickBooks Online. Authenticates with the five
 * QBO_* secrets (client id/secret + refresh token + realm + env) and reads the
 * connected company's name. Writes NOTHING to QBO — no customers, estimates, or
 * invoices. Use it once after setting production secrets to confirm the worker
 * is wired to the right live company before enabling the real sync.
 *
 *   npm run verify-qbo
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const qbo = new QboClient(c);
    const { realmId, companyName } = await qbo.ping();
    console.log(`✓ QBO auth OK — env=${process.env.QBO_ENV || "sandbox"}, realm ${realmId} → "${companyName}"`);
    console.log("  (read-only check — nothing was written to QuickBooks)");
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ QBO verify FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

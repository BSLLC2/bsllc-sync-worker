#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { QboClient } from "./qbo.js";

/**
 * (Re)sends one existing QBO invoice by email — dispatched on demand by the
 * client-detail Invoices card's "Send"/"Remind" button (via GitHub's Actions
 * API), the same narrow app→worker exception as sync-client-now. The app
 * never calls QuickBooks directly; this script is the only thing that does.
 *
 * QBO has no separate "send a reminder" endpoint — resending the same
 * invoice IS the reminder, so this one script covers both buttons.
 *
 *   npm run send-qbo-invoice -- --invoice-id=123
 */
function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const invoiceId = arg("invoice-id");
  if (!invoiceId) throw new Error("Missing --invoice-id");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const qbo = new QboClient(c);
    await qbo.connect();
    await qbo.sendInvoice(invoiceId);
    console.log(`✓ sent invoice ${invoiceId}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

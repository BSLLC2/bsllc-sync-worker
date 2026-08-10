#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Insert ONE clearly-labeled test web inquiry so you can watch the dashboard's
 * Marketing → Web Inquiries view populate end-to-end — without waiting for a
 * real form submission. Synthetic on purpose (fake gclid, test name) so it will
 * NOT match any real admission and can never be uploaded to Google Ads as a
 * conversion. Fully reversible: run with --undo to remove it.
 *
 * Note: this writes to the DASHBOARD (web_inquiries table), NOT the Google
 * Sheet — the sheet is an INPUT the website form owns; the worker only reads it.
 */
const SLUG = "ohio-community-health-och";
const TEST_EMAIL = "test-inquiry@bsllc.biz";

async function main() {
  const undo = process.argv.includes("--undo");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    if (undo) {
      const r = await c.query("DELETE FROM web_inquiries WHERE client_slug=$1 AND email=$2", [SLUG, TEST_EMAIL]);
      console.log(`Removed ${r.rowCount ?? 0} test inquiry row(s).`);
      return;
    }
    const r = await c.query(
      `INSERT INTO web_inquiries
         (id, client_slug, first_name, last_name, email, phone, dob, gclid,
          utm_source, utm_medium, utm_campaign, raw_json, submitted_at)
       VALUES ($1,$2,'TEST','Inquiry',$3,'000-000-0000','2000-01-01','TEST_GCLID_DEMO',
               'test','test','verification', $4, now())
       ON CONFLICT DO NOTHING`,
      [randomUUID(), SLUG, TEST_EMAIL, JSON.stringify({ source: "seed-test-inquiry (safe to delete)" })],
    );
    console.log(
      r.rowCount && r.rowCount > 0
        ? `Inserted 1 TEST inquiry for ${SLUG}. Open Marketing → Web Inquiries to see it. Remove later with --undo.`
        : `Test inquiry already present (dedupe). Open Marketing → Web Inquiries. Remove with --undo.`,
    );
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

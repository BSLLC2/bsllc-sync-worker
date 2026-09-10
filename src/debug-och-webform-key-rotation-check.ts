#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: did the just-submitted OCH test lead (email
 * test-inquiry@bsllc.biz) actually land after rotating WEBFORM_SECRET and
 * updating BSLLC_WEBFORM_KEY on OCH's WordPress server? Checks the most
 * recent web_inquiries rows for OCH regardless of email, plus specifically
 * for the test address, so a mismatch (401 swallowed silently) is visible
 * either way.
 *
 *   npm run debug-och-webform-key-rotation-check
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: recent } = await c.query<{ email: string | null; phone: string | null; form_name: string | null; submitted_at: string }>(
      `SELECT email, phone, form_name, submitted_at FROM web_inquiries
        WHERE client_slug = 'ohio-community-health-och'
        ORDER BY submitted_at DESC LIMIT 5`,
    );
    console.log("5 most recent OCH web_inquiries rows:");
    for (const r of recent) console.log(`  ${r.submitted_at} — ${r.email ?? "(no email)"} / ${r.phone ?? "(no phone)"} — form: ${r.form_name ?? "(none)"}`);

    const { rows: testRows } = await c.query<{ email: string; submitted_at: string }>(
      `SELECT email, submitted_at FROM web_inquiries
        WHERE client_slug = 'ohio-community-health-och' AND email = 'test-inquiry@bsllc.biz'
        ORDER BY submitted_at DESC LIMIT 3`,
    );
    console.log(`\ntest-inquiry@bsllc.biz rows: ${testRows.length}`);
    for (const r of testRows) console.log(`  ${r.submitted_at}`);

    const now = Date.now();
    const freshTest = testRows.find((r) => now - new Date(r.submitted_at).getTime() < 5 * 60_000);
    console.log(freshTest ? "\nFOUND a test row within the last 5 minutes -- the rotation worked end to end." : "\nNo test row in the last 5 minutes yet.");
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

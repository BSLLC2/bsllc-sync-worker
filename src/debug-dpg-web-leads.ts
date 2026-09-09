#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only diagnostic: is Diesel Power Group's website form actually
 * posting to /api/webform at all? web_inquiries is the raw capture table
 * behind the Website Leads page and the close-the-loop Google Ads offline-
 * conversion pipeline -- if nothing's landing there for DPG, either no form
 * on the site has the Webhook action wired (see CLAUDE.md's "Website lead
 * capture" section: every form is wired separately, one missing form
 * captures nothing and nothing errors), or DPG's slug doesn't match what
 * the form is actually posting.
 *
 *   npm run debug-dpg-web-leads
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: clientRow } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE lower(name) LIKE '%diesel%'`,
    );
    console.log(`Client match:`, clientRow);

    const { rows: distinctSlugs } = await c.query<{ client_slug: string; n: string }>(
      `SELECT client_slug, COUNT(*) AS n FROM web_inquiries GROUP BY client_slug ORDER BY n DESC`,
    );
    console.log(`\nAll client_slug values seen in web_inquiries (${distinctSlugs.length} distinct):`);
    for (const r of distinctSlugs) console.log(`  ${r.client_slug}: ${r.n}`);

    const { rows: dpgTotal } = await c.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM web_inquiries WHERE client_slug = 'diesel-power-group'`,
    );
    console.log(`\nweb_inquiries rows for client_slug='diesel-power-group' (ever): ${dpgTotal[0]!.n}`);

    const { rows: dpgRecent } = await c.query<{ id: string; submitted_at: string; form_name: string | null; email: string | null; page_url: string | null }>(
      `SELECT id, submitted_at, form_name, email, page_url FROM web_inquiries WHERE client_slug = 'diesel-power-group' ORDER BY submitted_at DESC LIMIT 10`,
    );
    console.log(`\nMost recent 10 (any age):`);
    for (const r of dpgRecent) console.log(`  ${r.submitted_at}  form="${r.form_name ?? "(none)"}"  ${r.email ?? "(no email)"}  ${r.page_url ?? ""}`);

    // Cross-check what the setup checklist's webform_tracking item actually
    // sees for DPG -- which forms posted in the last 30 days, per client.
    const { rows: last30ByForm } = await c.query<{ form_name: string | null; n: string }>(
      `SELECT form_name, COUNT(*) AS n FROM web_inquiries
        WHERE client_slug = 'diesel-power-group' AND submitted_at > now() - interval '30 days'
        GROUP BY form_name ORDER BY n DESC`,
    );
    console.log(`\nForms that posted for DPG in the last 30 days:`);
    if (last30ByForm.length === 0) console.log(`  (none)`);
    for (const r of last30ByForm) console.log(`  "${r.form_name ?? "(none)"}": ${r.n}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

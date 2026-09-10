#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only, cross-client status report: for every real client, is web lead
 * capture (/api/webform) actually wired, and does GA4/HubSpot metric data
 * exist recently? One query pass instead of asking per-client -- refreshed
 * daily-state, not yesterday's numbers, since a day (and possibly a form
 * fix) may have passed.
 *
 *   npm run debug-all-clients-gap-status
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: clients } = await c.query<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM clients ORDER BY name`,
    );
    console.log(`${clients.length} client(s) total.\n`);

    const { rows: wiRows } = await c.query<{ client_slug: string; n: string; last: string | null }>(
      `SELECT client_slug, COUNT(*) AS n, MAX(submitted_at) AS last FROM web_inquiries GROUP BY client_slug`,
    );
    const wiBySlug = new Map(wiRows.map((r) => [r.client_slug, r]));

    const { rows: wi30 } = await c.query<{ client_slug: string; form_name: string | null; n: string }>(
      `SELECT client_slug, form_name, COUNT(*) AS n FROM web_inquiries
        WHERE submitted_at > now() - interval '30 days'
        GROUP BY client_slug, form_name`,
    );
    const wi30BySlug = new Map<string, Array<{ form: string | null; n: string }>>();
    for (const r of wi30) {
      const arr = wi30BySlug.get(r.client_slug) ?? [];
      arr.push({ form: r.form_name, n: r.n });
      wi30BySlug.set(r.client_slug, arr);
    }

    const { rows: ga4Rows } = await c.query<{ client_id: string; n: string; last: string | null }>(
      `SELECT client_id, COUNT(*) AS n, MAX(synced_at) AS last FROM metric_snapshots
        WHERE source = 'ga4' AND synced_at > now() - interval '30 days'
        GROUP BY client_id`,
    );
    const ga4ById = new Map(ga4Rows.map((r) => [r.client_id, r]));

    const { rows: hsRows } = await c.query<{ client_id: string; n: string; last: string | null }>(
      `SELECT client_id, COUNT(*) AS n, MAX(synced_at) AS last FROM metric_snapshots
        WHERE source = 'hubspot' AND synced_at > now() - interval '30 days'
        GROUP BY client_id`,
    );
    const hsById = new Map(hsRows.map((r) => [r.client_id, r]));

    function slugify(name: string): string {
      return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    }

    for (const cl of clients) {
      const slug = slugify(cl.name);
      const wi = wiBySlug.get(slug);
      const forms30 = wi30BySlug.get(slug) ?? [];
      const ga4 = ga4ById.get(cl.id);
      const hs = hsById.get(cl.id);
      console.log(`${cl.name} (${cl.status}) [slug=${slug}]`);
      console.log(`  web_inquiries: ${wi ? `${wi.n} ever, last ${wi.last}` : "0 EVER"}`);
      if (forms30.length > 0) {
        console.log(`    forms posting in last 30d: ${forms30.map((f) => `"${f.form ?? "(none)"}"×${f.n}`).join(", ")}`);
      }
      console.log(`  ga4 (30d): ${ga4 ? `${ga4.n} rows, last ${ga4.last}` : "none"}`);
      console.log(`  hubspot metrics (30d): ${hs ? `${hs.n} rows, last ${hs.last}` : "none"}`);
      console.log("");
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

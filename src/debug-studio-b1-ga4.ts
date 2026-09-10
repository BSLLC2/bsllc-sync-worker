#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: is Studio B1 (an ACTIVE client with zero GA4 rows in the last
 * 30 days) even configured for GA4 at all? Checks connector_mappings (the
 * DB-driven property map import-ga4.ts reads alongside the static
 * GA4_PROPERTY_MAP env JSON) so "never configured" and "configured but
 * failing" read as different, actionable findings.
 *
 *   npm run debug-studio-b1-ga4
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: client } = await c.query<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM clients WHERE lower(name) LIKE '%studio b1%' OR lower(name) LIKE '%studio%b1%'`,
    );
    console.log("Client match:", client);
    if (client.length === 0) return;
    const clientId = client[0]!.id;

    const { rows: mappings } = await c.query(
      `SELECT * FROM connector_mappings WHERE client_id = $1`,
      [clientId],
    );
    console.log("\nAll connector_mappings rows for this client:");
    console.log(JSON.stringify(mappings, null, 2));
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: Sebastien says the DPG CallRail tracking number should already
 * be logged in the dashboard's own connector_mappings row for DPG's
 * callrail connector (external_id/notes). Pulling it directly.
 *
 *   npm run debug-dpg-callrail-number
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: client } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE lower(name) LIKE '%diesel%' OR lower(name) LIKE '%dpg%'`,
    );
    console.log("Client match:", client);
    if (client.length === 0) return;
    const clientId = client[0]!.id;

    const { rows: mappings } = await c.query(
      `SELECT * FROM connector_mappings WHERE client_id = $1`,
      [clientId],
    );
    console.log("\nAll connector_mappings rows for DPG:");
    console.log(JSON.stringify(mappings, null, 2));

    const { rows: tokens } = await c.query(
      `SELECT client_id, source, notes, created_at FROM client_integration_tokens WHERE client_id = $1`,
      [clientId],
    ).catch(() => ({ rows: [] as any[] }));
    console.log("\nclient_integration_tokens rows for DPG (if that table exists):");
    console.log(JSON.stringify(tokens, null, 2));
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Correct a connector_mappings.external_id that was entered wrong (e.g. a
 * Search Console UI URL pasted in place of the property identifier). Matches
 * the client by exact name first, then a safe case-insensitive substring;
 * refuses if >1 client matches or the (client, source) mapping doesn't exist,
 * so it can never create a mapping or touch the wrong row.
 *
 *   npm run fix-connector-external-id -- --client="Franklin Brazing" --source=gsc --external-id="sc-domain:franklinbrazing.com"
 *   npm run fix-connector-external-id -- --client="Franklin Brazing" --source=gsc --external-id="sc-domain:franklinbrazing.com" --dry-run
 */
function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const clientName = arg("client");
  const source = arg("source");
  const externalId = arg("external-id");
  const dryRun = process.argv.slice(2).includes("--dry-run");
  if (!clientName) throw new Error('Pass --client="<name>"');
  if (!source) throw new Error("Pass --source=<gsc|ga4|google_ads|...>");
  if (!externalId) throw new Error('Pass --external-id="<correct value>"');

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    let { rows: cl } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE lower(trim(name)) = lower(trim($1))`, [clientName],
    );
    if (cl.length === 0) {
      ({ rows: cl } = await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM clients WHERE name ILIKE '%' || $1 || '%' ORDER BY name`, [clientName],
      ));
    }
    if (cl.length > 1) {
      console.log(`Ambiguous "${clientName}" — matches ${cl.length}: ${cl.map((x) => x.name).join(", ")}. Be more specific.`);
      return;
    }
    const client = cl[0];
    if (!client) { console.log(`No client matching "${clientName}".`); return; }

    const { rows: mapping } = await c.query<{ id: string; external_id: string | null }>(
      `SELECT id, external_id FROM connector_mappings WHERE client_id = $1 AND source = $2`, [client.id, source],
    );
    const m = mapping[0];
    if (!m) { console.log(`No ${source} mapping exists for ${client.name} — nothing to fix (this script never creates one).`); return; }
    if (m.external_id === externalId) { console.log(`${client.name} · ${source} external_id is already "${externalId}" — nothing to do.`); return; }

    console.log(`${client.name} · ${source}: "${m.external_id}" → "${externalId}"${dryRun ? " (dry-run)" : ""}`);
    if (dryRun) return;
    const res = await c.query(
      `UPDATE connector_mappings SET external_id = $2, updated_at = now() WHERE id = $1`, [m.id, externalId],
    );
    console.log(`✓ Updated ${res.rowCount} connector mapping.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ fix-connector-external-id failed:", e instanceof Error ? e.message : e); process.exit(1); });

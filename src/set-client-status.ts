#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Set a client's account status (launch | active | paused | churned). Paused and
 * churned accounts are segmented out of the active roster on the portfolio board.
 * Matches the client by exact name first, then a safe case-insensitive substring
 * (so short names like "CSCH" work); refuses if >1 client matches so we never
 * flip the wrong account.
 *
 *   npm run set-client-status -- --client="CSCH" --status=paused
 *   npm run set-client-status -- --client="CSCH" --status=paused --dry-run
 */
const STATUSES = ["launch", "active", "paused", "churned"] as const;

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const clientName = arg("client");
  const status = (arg("status") || "").toLowerCase();
  const dryRun = process.argv.slice(2).includes("--dry-run");
  if (!clientName) throw new Error('Pass --client="<name>"');
  if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
    throw new Error(`Pass --status=${STATUSES.join(" | ")}`);
  }

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    let { rows: cl } = await c.query<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM clients WHERE lower(trim(name)) = lower(trim($1))`, [clientName],
    );
    if (cl.length === 0) {
      ({ rows: cl } = await c.query<{ id: string; name: string; status: string }>(
        `SELECT id, name, status FROM clients WHERE name ILIKE '%' || $1 || '%' ORDER BY name`, [clientName],
      ));
    }
    if (cl.length > 1) {
      console.log(`Ambiguous "${clientName}" — matches ${cl.length}: ${cl.map((x) => x.name).join(", ")}. Be more specific.`);
      return;
    }
    const client = cl[0];
    if (!client) {
      const { rows: all } = await c.query<{ name: string; status: string }>(
        `SELECT name, status FROM clients ORDER BY name`,
      );
      console.log(`No client matching "${clientName}". Known clients:`);
      for (const r of all) console.log(`  • ${r.name} (${r.status})`);
      return;
    }
    if (client.status === status) {
      console.log(`${client.name} is already '${status}' — nothing to do.`);
      return;
    }
    console.log(`${client.name}: ${client.status} → ${status}${dryRun ? " (dry-run)" : ""}`);
    if (dryRun) return;
    const res = await c.query(`UPDATE clients SET status = $2 WHERE id = $1`, [client.id, status]);
    console.log(`✓ Set ${res.rowCount} client to '${status}'.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ set-client-status failed:", e instanceof Error ? e.message : e); process.exit(1); });

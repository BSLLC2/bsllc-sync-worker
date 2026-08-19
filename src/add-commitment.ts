#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Create one commitment (task) directly, for cases that need a task on the
 * board right now and don't fit the app's own UI flow (e.g. flagging an
 * external blocker ahead of a client meeting). Matches the client by exact
 * name first, then a safe case-insensitive substring; refuses if >1 match.
 *
 *   npm run add-commitment -- --client="Ohio Community Health (OCH)" \
 *     --title="BLOCKER: add GSC service account to Search Console" \
 *     --priority=P0 --status=blocked --owner-type=bs_llc --assignee=Sebastien \
 *     --due=2026-08-20 --description="..."
 *   (add --dry-run to preview)
 */
const PRIORITIES = ["P0", "P1", "P2", "P3", "P4", "P5"];
const STATUSES = ["not_started", "in_progress", "blocked", "complete"];
const OWNER_TYPES = ["bs_llc", "client"];
const CATEGORIES = ["setup", "ongoing"];

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const clientName = arg("client");
  const title = arg("title");
  const priority = (arg("priority") || "P2").toUpperCase();
  const status = arg("status") || "not_started";
  const ownerType = arg("owner-type") || "bs_llc";
  const assignee = arg("assignee") || null;
  const due = arg("due") || null;
  const description = arg("description") || null;
  const category = arg("category") || "ongoing";
  const dryRun = process.argv.slice(2).includes("--dry-run");

  if (!clientName) throw new Error('Pass --client="<name>"');
  if (!title) throw new Error('Pass --title="<task title>"');
  if (!PRIORITIES.includes(priority)) throw new Error(`--priority must be one of ${PRIORITIES.join(", ")}`);
  if (!STATUSES.includes(status)) throw new Error(`--status must be one of ${STATUSES.join(", ")}`);
  if (!OWNER_TYPES.includes(ownerType)) throw new Error(`--owner-type must be one of ${OWNER_TYPES.join(", ")}`);
  if (!CATEGORIES.includes(category)) throw new Error(`--category must be one of ${CATEGORIES.join(", ")}`);

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

    console.log(`${client.name}: + "${title}" [${priority} · ${status} · ${ownerType}${assignee ? ` · ${assignee}` : ""}${due ? ` · due ${due}` : ""}]${dryRun ? " (dry-run)" : ""}`);
    if (dryRun) return;

    const id = randomUUID();
    const ownerName = ownerType === "client" ? "Client" : "BS LLC";
    await c.query(
      `INSERT INTO commitments
         (id, client_id, priority, title, description, owner_type, owner_name, assignee_name, status, category, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, client.id, priority, title, description, ownerType, ownerName, assignee, status, category, due],
    );
    console.log(`✓ Created commitment ${id}.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ add-commitment failed:", e instanceof Error ? e.message : e); process.exit(1); });

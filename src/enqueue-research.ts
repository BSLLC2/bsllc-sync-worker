#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * Enqueue a research_requests row (the same thing the app's SEO research page
 * does when you click "Research"). Useful for smoke-testing DataForSEO from the
 * worker side, or seeding a fresh request so run-research picks it up on its
 * next tick. Insert only — run-research does the actual DataForSEO call.
 *
 *   npm run enqueue-research -- --kind=ideas --query="commercial roofing"
 *   npm run enqueue-research -- --kind=rankings --target=example.com --query=example.com
 */
function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const kind = (arg("kind") || "ideas").toLowerCase();
  const query = arg("query") || "";
  const target = arg("target") || null;
  const location = arg("location") || "United States";
  const language = arg("language") || "English";
  if (kind !== "ideas" && kind !== "rankings") throw new Error('Pass --kind=ideas or --kind=rankings');
  if (!query) throw new Error('Pass --query="<seed or domain>"');
  if (kind === "rankings" && !target) throw new Error('kind=rankings needs --target=<domain>');

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    // id is generated app-side (no DB default), so provide one here.
    const id = randomUUID();
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO research_requests (id, kind, query, target, location_name, language_name, status, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'worker')
       RETURNING id`,
      [id, kind, query, target, location, language],
    );
    console.log(`✓ Enqueued ${kind} request "${query}"${target ? ` (target ${target})` : ""} → id ${rows[0]?.id}. run-research will pick it up.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ enqueue-research failed:", e instanceof Error ? e.message : e); process.exit(1); });

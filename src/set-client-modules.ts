#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Set a client's module entitlement flags (ads/seo/aeo/revenue_roi) — what the
 * Client Onboarding Sequence's "what your dashboard tracks" step shows as
 * included. These flags were added with no backfill, so every existing
 * client defaults to all-false until set here or via Admin > Clients >
 * Modules in the app. Site health is NOT included — it reuses the existing
 * web_ops_add_on column and isn't touched by this script.
 * Matches the client by exact name first, then a safe case-insensitive
 * substring (so short names like "CSCH" work); refuses if >1 client matches.
 *
 *   npm run set-client-modules -- --client="LBL Law" --ads --seo --aeo --revenue-roi
 *   npm run set-client-modules -- --client="LBL Law" --ads --seo --aeo --revenue-roi --dry-run
 */
function flag(name: string): boolean { return process.argv.slice(2).includes(`--${name}`); }
function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const clientName = arg("client");
  const dryRun = flag("dry-run");
  if (!clientName) throw new Error('Pass --client="<name>"');
  const next = { ads: flag("ads"), seo: flag("seo"), aeo: flag("aeo"), revenueRoi: flag("revenue-roi") };

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    let { rows: cl } = await c.query<{ id: string; name: string; module_ads: boolean; module_seo: boolean; module_aeo: boolean; module_revenue_roi: boolean }>(
      `SELECT id, name, module_ads, module_seo, module_aeo, module_revenue_roi FROM clients WHERE lower(trim(name)) = lower(trim($1))`, [clientName],
    );
    if (cl.length === 0) {
      ({ rows: cl } = await c.query(
        `SELECT id, name, module_ads, module_seo, module_aeo, module_revenue_roi FROM clients WHERE name ILIKE '%' || $1 || '%' ORDER BY name`, [clientName],
      ));
    }
    if (cl.length > 1) {
      console.log(`Ambiguous "${clientName}" — matches ${cl.length}: ${cl.map((x) => x.name).join(", ")}. Be more specific.`);
      return;
    }
    const client = cl[0];
    if (!client) {
      const { rows: all } = await c.query<{ name: string }>(`SELECT name FROM clients ORDER BY name`);
      console.log(`No client matching "${clientName}". Known clients:`);
      for (const r of all) console.log(`  • ${r.name}`);
      return;
    }
    console.log(
      `${client.name}: ads ${client.module_ads}→${next.ads}, seo ${client.module_seo}→${next.seo}, ` +
      `aeo ${client.module_aeo}→${next.aeo}, revenueRoi ${client.module_revenue_roi}→${next.revenueRoi}${dryRun ? " (dry-run)" : ""}`,
    );
    if (dryRun) return;
    const res = await c.query(
      `UPDATE clients SET module_ads = $2, module_seo = $3, module_aeo = $4, module_revenue_roi = $5 WHERE id = $1`,
      [client.id, next.ads, next.seo, next.aeo, next.revenueRoi],
    );
    console.log(`✓ Updated ${res.rowCount} client's module flags.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error("✗ set-client-modules failed:", e instanceof Error ? e.message : e); process.exit(1); });

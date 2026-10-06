#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off: record the EVIDENCE for Diesel Power Group's revenue figure
 * (clients.revenue_basis_note), so the dashboard reads the closed-deal tracker's
 * `manual.revenue_system_cents` as the tracker's figure and not as context.
 *
 * What the note says is the dashboard's own sentence (TRACKER_BASIS_NOTE in
 * shared/tracker-ledger.ts, compared by `npm run verify:wiring`): DPG's Odoo
 * sales matched to our lead log by BS LLC, each row marked Won by a person here,
 * and DPG has not confirmed the rows. It deliberately does NOT say the client
 * tabulated anything: the sheet is hand-matched by BS LLC.
 *
 * The client is looked up by NAME (default "Diesel Power Group") or by slug, and
 * the run stops unless exactly one account matches. No id is typed anywhere.
 * Dry run by default. Idempotent: the note is a plain overwrite with the same
 * text, and nothing else is touched.
 *
 *   npm run oneoff-seed-dpg-tracker                       # dry run
 *   npm run oneoff-seed-dpg-tracker -- --dry-run=false    # write
 *   npm run oneoff-seed-dpg-tracker -- --client="Diesel Power Group"
 *   npm run oneoff-seed-dpg-tracker -- --slug=diesel-power-group
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? process.env[k.toUpperCase().replace(/-/g, "_")] ?? d).trim();

const BASIS_NOTE =
  "DPG — Lead to Closed-Won Tracker (a Google Sheet kept by BS LLC): DPG's Odoo sales matched to our own lead log by phone, email and company name, each row marked Won by a person at BS LLC. Billing window from 2026-09-03. DPG has not confirmed the rows.";

const slugOf = (name: string) => name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

async function main() {
  const dryRun = arg("dry-run", "true") !== "false";
  const byName = arg("client", "Diesel Power Group");
  const bySlug = arg("slug");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    await c.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS revenue_basis_note TEXT`); // dashboard ensureSchema v141
    const { rows } = await c.query<{ id: string; name: string; revenue_basis_note: string | null }>(`SELECT id, name, revenue_basis_note FROM clients`);
    const hits = bySlug
      ? rows.filter((r) => slugOf(r.name) === bySlug.toLowerCase())
      : rows.filter((r) => r.name.trim().toLowerCase() === byName.toLowerCase());
    if (hits.length === 0) throw new Error(`No account named "${bySlug || byName}". Nothing was changed. Pass --client="<exact name>" or --slug=<slug>.`);
    if (hits.length > 1) throw new Error(`${hits.length} accounts match "${bySlug || byName}". Nothing was changed. ${bySlug ? "Two accounts share that slug; settle the duplicate first." : "Pass --slug to choose one."}`);
    const client = hits[0]!;
    console.log(`${client.name}: revenue_basis_note is ${client.revenue_basis_note ? (client.revenue_basis_note === BASIS_NOTE ? "already this text" : "set to something else, will be replaced") : "empty, will be set"}.`);
    console.log(`note -> ${BASIS_NOTE}`);
    if (dryRun) { console.log("DRY RUN — nothing written."); return; }
    await c.query(`UPDATE clients SET revenue_basis_note = $2 WHERE id = $1`, [client.id, BASIS_NOTE]);
    console.log("done.");
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

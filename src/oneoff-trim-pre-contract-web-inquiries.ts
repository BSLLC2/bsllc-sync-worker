#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off: set a client's contract_start and delete replayed Website Leads
 * (rows with an external_id, i.e. site-history replays) submitted before it.
 * Live webhook rows are never touched. Franklin Brazing's first replay ran
 * before the plugin's "Send history from" cutoff existed and pulled in
 * Nov 2021 – May 2022 submissions that predate the engagement (2023-12-15).
 *
 *   npm run oneoff-trim-pre-contract-web-inquiries -- --client=franklin-brazing --start=2023-12-15 --dry-run=true
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? process.env[k.toUpperCase().replace(/-/g, "_")] ?? d).trim();

async function main() {
  const slug = arg("client"); const start = arg("start"); const dryRun = arg("dry-run", "true") !== "false";
  if (!slug || !/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error("--client=<slug> --start=YYYY-MM-DD required");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: [client] } = await c.query<{ id: string; name: string; contract_start: string | null }>(
      `SELECT id, name, contract_start FROM clients WHERE lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')) = $1 OR lower(regexp_replace(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'), '^-+|-+$', '', 'g')) = $1 LIMIT 1`, [slug]);
    if (!client) throw new Error(`no client for slug ${slug}`);
    console.log(`${client.name}: contract_start ${client.contract_start ?? "(unset)"} -> ${start}`);
    const { rows: [pre] } = await c.query<{ n: string; oldest: string | null; newest: string | null }>(
      `SELECT count(*)::text AS n, min(submitted_at)::text AS oldest, max(submitted_at)::text AS newest
         FROM web_inquiries WHERE client_slug = $1 AND external_id IS NOT NULL AND submitted_at < $2::date`, [slug, start]);
    console.log(`replayed rows before ${start}: ${pre?.n ?? "0"} (${pre?.oldest?.slice(0, 10) ?? "—"} → ${pre?.newest?.slice(0, 10) ?? "—"})`);
    if (!dryRun) {
      await c.query(`UPDATE clients SET contract_start = $2 WHERE id = $1 AND (contract_start IS NULL OR contract_start <> $2)`, [client.id, start]);
      const del = await c.query(`DELETE FROM web_inquiries WHERE client_slug = $1 AND external_id IS NOT NULL AND submitted_at < $2::date`, [slug, start]);
      console.log(`deleted ${del.rowCount}; contract_start set.`);
    } else console.log("DRY RUN — nothing written.");
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

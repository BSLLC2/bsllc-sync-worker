#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Scoped, deliberate cleanup: deletes metric_snapshots for ONE client + ONE
 * source. Used to clear stale/legacy rows (e.g. the old weekly Perplexity data)
 * before re-laying a clean single-scale history with import-csv.ts.
 *
 * Refuses to run without --confirm. Recoverable: the CSV is the source of truth.
 *
 * Usage:
 *   tsx src/purge-source.ts --client=ohio-community-health-och --source=google_ads --confirm
 */

function arg(name: string): string | undefined {
  const pre = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pre));
  return hit ? hit.slice(pre.length) : undefined;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function main() {
  const clientRef = arg("client");
  const source = arg("source");
  const confirm = process.argv.includes("--confirm");
  if (!clientRef || !source) throw new Error("Required: --client=<name/slug/uuid> --source=<source>");
  if (!confirm) throw new Error("Refusing to delete without --confirm");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL");

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows: clients } = await client.query<{ id: string; name: string }>(
      "SELECT id, name FROM clients",
    );
    const match =
      clients.find((c) => c.id === clientRef) ||
      clients.find((c) => slug(c.name) === slug(clientRef)) ||
      clients.find((c) => c.name.toLowerCase() === clientRef.toLowerCase());
    if (!match) {
      throw new Error(
        `Unknown client "${clientRef}". Known: ${clients.map((c) => slug(c.name)).join(", ")}`,
      );
    }
    const res = await client.query(
      "DELETE FROM metric_snapshots WHERE client_id = $1 AND source = $2",
      [match.id, source],
    );
    console.log(`Deleted ${res.rowCount ?? 0} ${source} snapshot(s) for ${match.name} (${match.id}).`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("purge failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

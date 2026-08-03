import { readFileSync, existsSync } from "node:fs";
import pg from "pg";
import { digitsOnly, type Config } from "./config.js";

/**
 * One account to pull: which dashboard client it maps to, and which Google Ads
 * customer id to query.
 *  - clientRef  → goes into the payload's `client_id`. When it comes from
 *                 connector_mappings it is the exact client UUID; when it comes
 *                 from accounts.json it is a slug/name that sync.ts resolves.
 *  - customerId → the Google Ads account id, digits only.
 */
export interface Target {
  clientRef: string;
  clientLabel: string;
  customerId: string;
}

/**
 * Primary discovery path (per the spec): read connector_mappings from Neon.
 * READ-ONLY — the worker never writes to the database directly; the dashboard's
 * `npm run sync` owns every write. Only enabled google_ads rows with an
 * external id are pulled.
 */
export async function targetsFromDb(cfg: Config): Promise<Target[]> {
  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{
      client_id: string;
      name: string;
      external_id: string;
    }>(
      `SELECT cm.client_id, c.name, cm.external_id
         FROM connector_mappings cm
         JOIN clients c ON c.id = cm.client_id
        WHERE cm.source = 'google_ads'
          AND cm.enabled = true
          AND cm.external_id IS NOT NULL
          AND cm.external_id <> ''
        ORDER BY c.name`,
    );
    return rows.map((r) => ({
      clientRef: r.client_id,
      clientLabel: r.name,
      customerId: digitsOnly(r.external_id),
    }));
  } finally {
    await client.end();
  }
}

/**
 * Bootstrap fallback: connector_mappings is empty on day one (nobody has wired
 * accounts in Admin → Connectors yet), so the worker has nothing to discover.
 * An optional accounts.json lets the very first backfill run anyway. Every
 * entry it emits carries external_id, and the dashboard's sync write-back
 * CREATES the connector_mappings row from it — so after one run, DB discovery
 * takes over and this file can go away.
 */
export function targetsFromFile(path: string): Target[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${path}: expected a JSON array`);
  return raw.map((row, i) => {
    const r = row as Record<string, unknown>;
    const clientRef = r.client;
    const customerId = r.customer_id;
    if (typeof clientRef !== "string" || typeof customerId !== "string") {
      throw new Error(
        `${path}[${i}]: each entry needs string "client" and "customer_id"`,
      );
    }
    return {
      clientRef,
      clientLabel: clientRef,
      customerId: digitsOnly(customerId),
    };
  });
}

/**
 * Resolve the account list: connector_mappings first, then fall back to
 * accounts.json only when the DB has nothing. An explicit path forces the file.
 */
export async function resolveTargets(
  cfg: Config,
  accountsFile: string | undefined,
): Promise<{ targets: Target[]; from: "db" | "file" }> {
  if (accountsFile) {
    if (!existsSync(accountsFile)) throw new Error(`accounts file not found: ${accountsFile}`);
    return { targets: targetsFromFile(accountsFile), from: "file" };
  }
  const dbTargets = await targetsFromDb(cfg);
  if (dbTargets.length > 0) return { targets: dbTargets, from: "db" };
  const fallback = "accounts.json";
  if (existsSync(fallback)) return { targets: targetsFromFile(fallback), from: "file" };
  return { targets: [], from: "db" };
}

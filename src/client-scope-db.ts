/**
 * The database half of src/client-scope.ts: for a reader that is configured by
 * client slug rather than found through connector_mappings (the sheet
 * trackers). Read-only. A client we cannot find, or a database we cannot reach,
 * is read as live: a null is unanswered, never "churned".
 */
import pg from "pg";
import { isChurned } from "./client-scope.js";

/** The app's slug rule for a client name (lowercase, runs of anything else become one dash). */
export const slugOfName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Slugs of every churned client. Empty when the database cannot be reached. */
export async function churnedSlugs(databaseUrl: string | undefined): Promise<Set<string>> {
  if (!databaseUrl) return new Set();
  const c = new pg.Client({ connectionString: databaseUrl });
  try {
    await c.connect();
    const { rows } = await c.query<{ name: string; status: string | null }>(`SELECT name, status FROM clients`);
    return new Set(rows.filter((r) => isChurned(r.status)).map((r) => slugOfName(r.name)));
  } catch {
    return new Set();
  } finally {
    await c.end().catch(() => {});
  }
}

/**
 * For a reader that already leaves churned clients out in its own SQL: print
 * how many churned clients exist, so the run output names what was not read.
 * It never changes what the reader selects, and a failure here costs nothing.
 */
export async function logChurnedSkipped(c: pg.Client, label: string): Promise<void> {
  try {
    const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM clients WHERE COALESCE(status, '') = 'churned'`);
    console.log(`${label}: ${rows[0]?.n ?? 0} churned skipped`);
  } catch {
    // The count is a courtesy line; the reader must not fail over it.
  }
}

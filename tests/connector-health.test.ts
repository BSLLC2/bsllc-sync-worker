/**
 * "Connector failing" means: the newest ERROR row is STRICTLY newer than the
 * newest live/no_data row (CLAUDE.md "Morning automation").
 *
 * This runs the REAL SQL the morning audit runs — FAILING_CONNECTORS_SQL,
 * imported from src/connector-health.ts — against a real Postgres with rows
 * seeded for each case. A test against a TypeScript re-implementation of the
 * rule would prove nothing about the query that actually ships, and the two
 * halves of this rule are exactly the kind that a re-implementation gets right
 * while the SQL gets wrong.
 *
 * Needs TEST_DATABASE_URL (CI's Postgres service sets it); skips with a printed
 * reason otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { FAILING_CONNECTORS_SQL, HEALTHY_STATES, MONITORED_CLIENT_STATUSES } from "../src/connector-health.js";

const URL = (process.env.TEST_DATABASE_URL || "").trim();
const HAVE_DB = URL.length > 0;

/** Just the four tables the query touches — not the dashboard's whole schema. */
const SCHEMA = `
CREATE TABLE clients (id text PRIMARY KEY, name text NOT NULL, status text NOT NULL);
CREATE TABLE connector_mappings (client_id text NOT NULL, source text NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE metric_snapshots (
  id serial PRIMARY KEY,
  client_id text NOT NULL,
  source text NOT NULL,
  metric_key text NOT NULL,
  data_state text NOT NULL,
  error_message text,
  period_end timestamptz,
  synced_at timestamptz NOT NULL
);`;

describe.skipIf(!HAVE_DB)("the connector-failing rule, in the SQL that ships", () => {
  let db: string;
  let client: pg.Client;

  const hoursAgo = (h: number) => `now() - interval '${h} hours'`;

  /** Seed one metric row. `at` is an SQL expression for synced_at. */
  async function snapshot(opts: { client: string; source: string; state: "live" | "no_data" | "error"; at: string; key?: string; error?: string; periodEnd?: string }) {
    await client.query(
      `INSERT INTO metric_snapshots (client_id, source, metric_key, data_state, error_message, period_end, synced_at)
       VALUES ($1, $2, $3, $4, $5, ${opts.periodEnd ?? "now() - interval '1 day'"}, ${opts.at})`,
      [opts.client, opts.source, opts.key ?? `${opts.source}.clicks`, opts.state, opts.error ?? null],
    );
  }

  const failing = async (): Promise<Array<{ name: string; source: string; error_message: string | null }>> =>
    (await client.query(FAILING_CONNECTORS_SQL)).rows;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: URL });
    await admin.connect();
    db = `worker_conn_${Date.now().toString(36)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    await admin.end();
    client = new pg.Client({ connectionString: URL.replace(/\/[^/?]*(\?|$)/, `/${db}$1`) });
    await client.connect();
    await client.query(SCHEMA);
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    const admin = new pg.Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin.end();
  });

  beforeEach(async () => {
    await client.query("TRUNCATE metric_snapshots, connector_mappings, clients");
    await client.query(`INSERT INTO clients (id, name, status) VALUES ('c1', 'Ohio Community Health', 'active')`);
    await client.query(`INSERT INTO connector_mappings (client_id, source, enabled) VALUES ('c1', 'gsc', true)`);
  });

  it("reports a connector whose only row is an error", async () => {
    await snapshot({ client: "c1", source: "gsc", state: "error", at: hoursAgo(1), error: "403 permission" });
    const rows = await failing();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ name: "Ohio Community Health", source: "gsc", error_message: "403 permission" });
  });

  it("reports a connector whose newest error is newer than its newest success", async () => {
    await snapshot({ client: "c1", source: "gsc", state: "live", at: hoursAgo(5), key: "gsc.clicks" });
    await snapshot({ client: "c1", source: "gsc", state: "error", at: hoursAgo(1), key: "gsc.avg_position", error: "400 bad request" });
    expect((await failing()).length).toBe(1);
  });

  it("does NOT report a past failure once a later run succeeded — the GSC backfill case", async () => {
    // This is the one that kept OCH's Search Console reading as failing: the
    // 16-month backfill 400'd and left an error row behind. Different metric
    // keys on purpose: rows on the SAME key are already resolved by `latest`
    // picking the newest per key, so using one key would test nothing about
    // the error-vs-success comparison this rule is made of.
    await snapshot({ client: "c1", source: "gsc", state: "error", at: hoursAgo(30), key: "gsc.avg_position", error: "400 older than 16 months" });
    await snapshot({ client: "c1", source: "gsc", state: "live", at: hoursAgo(2), key: "gsc.clicks" });
    expect(await failing()).toEqual([]);
  });

  it("counts no_data as a success — a quiet account is not a broken connector", async () => {
    expect(HEALTHY_STATES).toContain("no_data");
    // The only healthy row is no_data, and it is on a different metric key
    // from the error, so the error genuinely survives into `err`. If no_data
    // were not treated as a success this connector would read as failing.
    await snapshot({ client: "c1", source: "gsc", state: "error", at: hoursAgo(30), key: "gsc.avg_position", error: "timeout" });
    await snapshot({ client: "c1", source: "gsc", state: "no_data", at: hoursAgo(2), key: "gsc.clicks" });
    expect(await failing()).toEqual([]);
  });

  it("a no_data run OLDER than the error still leaves the connector failing", async () => {
    // Proves the clause above is about the state, not about ordering.
    await snapshot({ client: "c1", source: "gsc", state: "no_data", at: hoursAgo(30), key: "gsc.clicks" });
    await snapshot({ client: "c1", source: "gsc", state: "error", at: hoursAgo(2), key: "gsc.avg_position", error: "403" });
    expect((await failing()).length).toBe(1);
  });

  it("is STRICTLY newer: an error at the same instant as a success is not a failure", async () => {
    await client.query(`INSERT INTO metric_snapshots (client_id, source, metric_key, data_state, error_message, period_end, synced_at)
      VALUES ('c1','gsc','gsc.clicks','live',NULL, now() - interval '1 day', '2026-09-10T07:00:00Z'),
             ('c1','gsc','gsc.impressions','error','boom', now() - interval '1 day', '2026-09-10T07:00:00Z')`);
    expect(await failing()).toEqual([]);
  });

  it("compares per SOURCE, so a broken GSC does not hide behind a healthy GA4", async () => {
    await client.query(`INSERT INTO connector_mappings (client_id, source, enabled) VALUES ('c1', 'ga4', true)`);
    await snapshot({ client: "c1", source: "ga4", state: "live", at: hoursAgo(1) });
    await snapshot({ client: "c1", source: "gsc", state: "error", at: hoursAgo(1), error: "403" });
    const rows = await failing();
    expect(rows.map((r) => r.source)).toEqual(["gsc"]);
  });

  it("compares per METRIC first, so an error on one key does not bury a newer success on it", async () => {
    // `latest` is DISTINCT ON (client, source, metric_key): the newest row per
    // metric. An old error on gsc.clicks must not outrank its own newer live row.
    await snapshot({ client: "c1", source: "gsc", state: "error", at: hoursAgo(10), key: "gsc.clicks", error: "old" });
    await snapshot({ client: "c1", source: "gsc", state: "live", at: hoursAgo(1), key: "gsc.clicks" });
    expect(await failing()).toEqual([]);
  });

  it("ignores a source with no enabled connector mapping", async () => {
    await client.query(`UPDATE connector_mappings SET enabled = false WHERE client_id = 'c1' AND source = 'gsc'`);
    await snapshot({ client: "c1", source: "gsc", state: "error", at: hoursAgo(1), error: "403" });
    expect(await failing()).toEqual([]);
  });

  it("ignores a source that was never mapped at all", async () => {
    await snapshot({ client: "c1", source: "square", state: "error", at: hoursAgo(1), error: "403" });
    expect(await failing()).toEqual([]);
  });

  it("only reports launch and active clients", async () => {
    expect(Array.from(MONITORED_CLIENT_STATUSES).sort()).toEqual(["active", "launch"]);
    for (const status of ["churned", "paused"]) {
      await client.query(`UPDATE clients SET status = $1 WHERE id = 'c1'`, [status]);
      await client.query("TRUNCATE metric_snapshots");
      await snapshot({ client: "c1", source: "gsc", state: "error", at: hoursAgo(1), error: "403" });
      expect(await failing(), `a ${status} client should not be reported`).toEqual([]);
    }
    for (const status of MONITORED_CLIENT_STATUSES) {
      await client.query(`UPDATE clients SET status = $1 WHERE id = 'c1'`, [status]);
      await client.query("TRUNCATE metric_snapshots");
      await snapshot({ client: "c1", source: "gsc", state: "error", at: hoursAgo(1), error: "403" });
      expect((await failing()).length, `a ${status} client should be reported`).toBe(1);
    }
  });

  it("ignores a future-dated row, so a bad timestamp cannot declare a connector broken", async () => {
    await snapshot({ client: "c1", source: "gsc", state: "live", at: hoursAgo(2), key: "gsc.clicks" });
    await snapshot({ client: "c1", source: "gsc", state: "error", at: "now() + interval '10 days'", key: "gsc.avg_position", error: "stamped in the future", periodEnd: "now() + interval '20 days'" });
    expect(await failing()).toEqual([]);
  });

  it("reports the NEWEST error message, not an older one", async () => {
    await snapshot({ client: "c1", source: "gsc", state: "error", at: hoursAgo(10), key: "gsc.clicks", error: "the old error" });
    await snapshot({ client: "c1", source: "gsc", state: "error", at: hoursAgo(1), key: "gsc.impressions", error: "the current error" });
    const rows = await failing();
    expect(rows.length).toBe(1);
    expect(rows[0]!.error_message).toBe("the current error");
  });

  it("returns one row per failing connector, not one per metric key", async () => {
    for (const key of ["gsc.clicks", "gsc.impressions", "gsc.avg_position"]) {
      await snapshot({ client: "c1", source: "gsc", state: "error", at: hoursAgo(1), key, error: "403" });
    }
    expect((await failing()).length).toBe(1);
  });

  it("reports nothing when everything is healthy", async () => {
    await snapshot({ client: "c1", source: "gsc", state: "live", at: hoursAgo(1) });
    expect(await failing()).toEqual([]);
  });
});

describe.skipIf(HAVE_DB)("connector-failing rule (skipped)", () => {
  it("needs a database", () => {
    console.warn("[worker] connector-health skipped: no TEST_DATABASE_URL set");
    expect(HAVE_DB).toBe(false);
  });
});

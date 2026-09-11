/**
 * "Connector failing" — ONE definition, used by Admin → Connectors, the daily
 * brief and the morning audit (CLAUDE.md "Morning automation"):
 *
 *   the newest ERROR row is strictly newer than the newest live/no_data row
 *   (or there is no live/no_data row at all).
 *
 * Two parts of that are easy to get wrong and both have:
 *  - `no_data` is a SUCCESS. The pipeline ran and the account was genuinely
 *    empty. Treating it as "not a success" made every quiet account read as a
 *    broken connector.
 *  - STRICTLY newer. A past failure must not stick once a later run succeeded,
 *    which is exactly what the GSC 16-month backfill error used to do: it left
 *    an error row newer than every good one until the clamp was added.
 *
 * The SQL lives here as an exported constant so the audit and the test run the
 * same text — a test against a re-implementation of this rule would prove
 * nothing about the query that actually ships.
 */

/** Rows: one per failing (client, source) with the client name and last error. */
export const FAILING_CONNECTORS_SQL = `
WITH latest AS (
  SELECT DISTINCT ON (client_id, source, metric_key)
         client_id, source, metric_key, data_state, error_message, synced_at
    FROM metric_snapshots
   WHERE (period_end IS NULL OR period_end <= now())
   ORDER BY client_id, source, metric_key, synced_at DESC),
-- a run that answered no_data is a success too: the pipeline worked, the account was empty
live AS (SELECT client_id, source, max(synced_at) AS m FROM latest WHERE data_state IN ('live', 'no_data') GROUP BY 1, 2),
err AS (SELECT DISTINCT ON (client_id, source) client_id, source, error_message, synced_at
          FROM latest WHERE data_state = 'error' ORDER BY client_id, source, synced_at DESC)
SELECT c.name, e.source, e.error_message
  FROM err e
  JOIN connector_mappings m ON m.client_id = e.client_id AND m.source = e.source AND m.enabled
  JOIN clients c ON c.id = e.client_id
  LEFT JOIN live ON live.client_id = e.client_id AND live.source = e.source
 WHERE (live.m IS NULL OR e.synced_at > live.m)
   AND c.status IN ('launch', 'active')`;

/** Data states that count as the connector having worked. */
export const HEALTHY_STATES = ["live", "no_data"] as const;

/** Client statuses the audit reports on — a churned client's dead connector is
 *  not a problem anyone needs a task for. */
export const MONITORED_CLIENT_STATUSES = ["launch", "active"] as const;

#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import pg from "pg";
import { loadConfig, digitsOnly } from "./config.js";
import { makeAdsApi } from "./google-ads.js";

/**
 * Prove — right now, per client, per connector — that we can actually read the
 * account, and record the answer.
 *
 * The gap this closes: an AM hands a client the service-account address, the
 * client says "done", and until tonight's sync either fails or silently returns
 * nothing, nobody can tell whether it worked. Franklin Brazing's Search Console
 * 403 stayed open for weeks because there was no way to self-serve check it.
 *
 * This is NOT an import. Each probe is the smallest real read that answers one
 * question — can we read this, yes or no — and it writes nothing to
 * metric_snapshots. That last part is load-bearing: an 'error' row there would
 * make a perfectly healthy connector read as failing under the
 * newest-error-newer-than-newest-success rule the whole system uses. Test
 * results live in their own table, `connector_tests`.
 *
 * It also classifies nothing. The API's error text is stored verbatim and the
 * dashboard turns it into a fix at read time (shared/connection-test.ts), so
 * there is exactly one copy of that mapping and a rule added later improves
 * every result already stored. Duplicating it here would drift, and a drifted
 * instruction sends a client to change the wrong setting in the wrong console.
 *
 * Usage:
 *   npm run test-connections -- --client=<clientId> [--sources=gsc,ga4,google_ads]
 *                               [--request-ids=<id>,<id>] [--dry-run]
 *   npm run test-connections -- --stale-days=7 [--max=60] [--dry-run]
 *
 * --request-ids pairs 1:1 with --sources: the dashboard opens a 'running' row
 * per source the instant the button is pressed (so the UI has something honest
 * to show) and passes the ids here to be closed. Without them — the sweep below
 * — this inserts its own rows instead.
 *
 * --stale-days is the morning audit's sweep: re-probe every live client's
 * connectors whose last test has aged out. It exists because a pass is evidence
 * about the moment it was taken — an admin can revoke access in October that
 * was granted in August, and nobody would press the button again to find out.
 * The audit then files the regression as a task (see audit-and-repair.ts).
 */

/** Connectors that authenticate with an access grant a client can actually
 *  make, and that therefore have something to prove. HubSpot and D365 use a
 *  per-client token we hold rather than a grant, so their own importer is the
 *  only meaningful test; mirrors TESTABLE_SOURCES in the dashboard. */
const TESTABLE = ["gsc", "ga4", "google_ads"] as const;
type Testable = (typeof TESTABLE)[number];

const GSC_API = "https://searchconsole.googleapis.com/webmasters/v3";
const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

/** What the probe found. Mirrors CONNECTION_TEST_OUTCOMES on the dashboard. */
type Outcome = "pass" | "no_data" | "fail";

interface ProbeResult {
  outcome: Outcome;
  /** Verbatim API error. Never re-worded, never summarised — the dashboard's
   *  mapping matches on Google's own wording and an AM may have to read it. */
  rawError: string | null;
  /** Anything else the probe established, in a sentence a person can read. */
  detail: string | null;
  /** True when we could list what we CAN see and this account wasn't in it —
   *  the one fact that separates "granted on the wrong property" from "never
   *  granted". Only Search Console can answer it (see the GSC probe). */
  visibleElsewhere: boolean;
  /** Which call was made, so a stored result is still legible in a year. */
  probe: string;
}

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d).trim();
const dryRun = process.argv.includes("--dry-run");
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Long enough to read Google's full message (its useful part is often at the
 *  end, after a URL), short enough not to bloat the row. */
const CAP = 1000;
const trim = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, CAP);

function serviceAccount(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON.");
  let json: any;
  try { json = JSON.parse(raw); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON."); }
  if (!json.client_email || !json.private_key) throw new Error("Service-account JSON missing client_email / private_key.");
  return json;
}

/** One access token per scope per run. Minting is itself a real check: a dead
 *  or rotated key fails here, before any property is touched, and that error
 *  text is what tells the dashboard this is OURS rather than the client's. */
async function token(scope: string): Promise<string> {
  const sa = serviceAccount();
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [scope] });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Failed to mint an access token from the service account.");
  return token;
}

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── Search Console ────────────────────────────────────────────────────────
/**
 * Three small calls, in this order, because each one earns the next:
 *   1. sites.list — what can this service account see AT ALL? An empty list
 *      means nobody has added us anywhere, which is a different conversation
 *      from "added to the wrong property".
 *   2. sites.get — our permission level on the target. Search Console will
 *      happily list a property we've been added to as `siteUnverifiedUser`,
 *      which can read nothing; that reads as "granted" to a client and as a
 *      403 to us, and only this call tells the two apart.
 *   3. a 1-row searchAnalytics query — the actual read, which is the only
 *      thing that proves data comes back rather than just that a door opened.
 */
async function probeGsc(siteUrl: string): Promise<ProbeResult> {
  const t = await token(GSC_SCOPE);
  const base = { visibleElsewhere: false, detail: null as string | null };

  // 1. What we can see.
  let visible: string[] = [];
  const listRes = await fetch(`${GSC_API}/sites`, { headers: { Authorization: `Bearer ${t}` } });
  if (!listRes.ok) {
    // A failure to even list is about the credential or the API being off, not
    // about this property — pass it straight through for the dashboard to say so.
    return { ...base, outcome: "fail", rawError: trim(`sites.list → ${listRes.status} ${await listRes.text().catch(() => "")}`), probe: "sites.list" };
  }
  const listed: any = await listRes.json().catch(() => ({}));
  visible = (listed.siteEntry ?? []).map((e: any) => String(e.siteUrl ?? "")).filter(Boolean);
  const seen = `We can currently see ${visible.length} Search Console propert${visible.length === 1 ? "y" : "ies"}${visible.length ? `: ${visible.slice(0, 10).join(", ")}` : ""}.`;

  // 2. Our level on the target.
  const getRes = await fetch(`${GSC_API}/sites/${encodeURIComponent(siteUrl)}`, { headers: { Authorization: `Bearer ${t}` } });
  if (!getRes.ok) {
    const body = await getRes.text().catch(() => "");
    return {
      outcome: "fail",
      rawError: trim(`sites.get ${siteUrl} → ${getRes.status} ${body}`),
      detail: seen,
      // The whole point of having listed first: if we can see OTHER properties
      // but not this one, the grant happened — on the wrong property. That is
      // usually sc-domain: vs https:// , which look identical to a client.
      visibleElsewhere: visible.length > 0,
      probe: "sites.get",
    };
  }
  const site: any = await getRes.json().catch(() => ({}));
  const level = String(site.permissionLevel ?? "");
  if (level === "siteUnverifiedUser") {
    return {
      outcome: "fail",
      // Phrased so the dashboard's insufficient_permission rule matches on the
      // level itself rather than on a status code that never arrives here.
      rawError: trim(`sites.get returned permissionLevel "${level}" for ${siteUrl}`),
      detail: `${siteUrl} lists us as an unverified user, which cannot read Search Analytics.`,
      visibleElsewhere: false,
      probe: "sites.get",
    };
  }

  // 3. The real read. A 7-day window with one row: enough to prove data flows,
  // small enough that running it on every client costs nothing.
  const end = iso(new Date(Date.now() - 3 * 86_400_000)); // GSC lags ~2-3 days
  const start = iso(new Date(Date.now() - 10 * 86_400_000));
  const qRes = await fetch(`${GSC_API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ startDate: start, endDate: end, dimensions: [], rowLimit: 1 }),
  });
  if (!qRes.ok) {
    return { outcome: "fail", rawError: trim(`searchAnalytics.query ${siteUrl} → ${qRes.status} ${await qRes.text().catch(() => "")}`), detail: seen, visibleElsewhere: false, probe: "searchAnalytics.query" };
  }
  const q: any = await qRes.json().catch(() => ({}));
  const row = q.rows?.[0];
  const impressions = Number(row?.impressions ?? 0);
  if (!row || impressions === 0) {
    return {
      outcome: "no_data",
      rawError: null,
      detail: `Access confirmed at permission level "${level || "unknown"}", but ${siteUrl} reported no impressions between ${start} and ${end}.`,
      visibleElsewhere: false,
      probe: "searchAnalytics.query",
    };
  }
  return {
    outcome: "pass",
    rawError: null,
    detail: `Read ${impressions} impression${impressions === 1 ? "" : "s"} and ${Number(row.clicks ?? 0)} click${Number(row.clicks ?? 0) === 1 ? "" : "s"} for ${siteUrl} (${start}…${end}) at permission level "${level || "unknown"}".`,
    visibleElsewhere: false,
    probe: "searchAnalytics.query",
  };
}

// ── GA4 ───────────────────────────────────────────────────────────────────
/**
 * One call: a one-row report over the last seven days. It answers access and
 * data presence together, which is all we need — the Data API's read-only
 * scope has no list call, so unlike Search Console there is no cheap way to
 * find out what else we CAN see, and we deliberately don't pretend otherwise.
 *
 * Property ids are normalised the same way import-ga4.ts does: someone pasting
 * "properties/123" from the API docs would otherwise produce
 * .../properties/properties/123 and a bare 404, which reads as a dead
 * connector rather than as a fixable typo.
 */
async function probeGa4(rawProperty: string): Promise<ProbeResult> {
  const propertyId = rawProperty.trim().replace(/^properties\//i, "").trim();
  const t = await token(GA4_SCOPE);
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
      metrics: [{ name: "sessions" }],
      limit: 1,
    }),
  });
  if (!res.ok) {
    return { outcome: "fail", rawError: trim(`runReport properties/${propertyId} → ${res.status} ${await res.text().catch(() => "")}`), detail: null, visibleElsewhere: false, probe: "runReport" };
  }
  const j: any = await res.json().catch(() => ({}));
  const sessions = Number(j.rows?.[0]?.metricValues?.[0]?.value ?? 0);
  if (!j.rows?.length || sessions === 0) {
    return {
      outcome: "no_data",
      rawError: null,
      detail: `Access confirmed on property ${propertyId}, but it reported 0 sessions in the last 7 days.`,
      visibleElsewhere: false,
      probe: "runReport",
    };
  }
  return { outcome: "pass", rawError: null, detail: `Read ${sessions} session${sessions === 1 ? "" : "s"} from property ${propertyId} over the last 7 days.`, visibleElsewhere: false, probe: "runReport" };
}

// ── Google Ads ────────────────────────────────────────────────────────────
/**
 * Two tiny GAQL queries. The first has no metrics in it on purpose: it asks the
 * account to describe itself, which succeeds even on a manager account and so
 * lets us catch the commonest bad id — a client who pasted their MCC number
 * instead of the ad account's — by reading `customer.manager` rather than by
 * waiting for a REQUESTED_METRICS_FOR_MANAGER error we'd have to guess at.
 *
 * Note this connector does NOT use the shared service account: Google Ads
 * authenticates with our OAuth client + developer token + manager account. A
 * client sent the service-account address for Ads will add it somewhere
 * harmless and nothing will change, which is why the dashboard's Ads fix text
 * says so explicitly.
 */
async function probeAds(customerId: string): Promise<ProbeResult> {
  const cfg = loadConfig();
  const api = makeAdsApi(cfg);
  const id = digitsOnly(customerId);

  // Accounts reach us two ways — under the BS LLC manager, or shared directly
  // with the authenticated user. Same dual path as google-ads.ts pullWindow:
  // without the direct fallback, a directly-shared account fails with
  // authorization_error=2 even though it is perfectly reachable.
  const run = async (query: string) => {
    try {
      return await api.Customer({ customer_id: id, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken }).query(query);
    } catch (mccErr) {
      try {
        return await api.Customer({ customer_id: id, refresh_token: cfg.refreshToken }).query(query);
      } catch {
        throw mccErr; // the MCC error is the more informative of the two
      }
    }
  };

  let describe: any[];
  try {
    describe = await run("SELECT customer.id, customer.descriptive_name, customer.manager, customer.status FROM customer LIMIT 1");
  } catch (e) {
    return { outcome: "fail", rawError: trim(`customer describe ${id} → ${err(e)}`), detail: null, visibleElsewhere: false, probe: "GAQL customer" };
  }
  const c = (describe[0]?.customer ?? {}) as Record<string, unknown>;
  const name = String(c.descriptive_name ?? "");
  if (c.manager === true) {
    // Phrased to match the dashboard's manager_account_id rule, which exists
    // because this failure is invisible otherwise: access is fine, the id is
    // just one that can never return performance figures.
    return {
      outcome: "fail",
      rawError: trim(`REQUESTED_METRICS_FOR_MANAGER: customer ${id}${name ? ` ("${name}")` : ""} is a manager account; metrics cannot be requested for a manager account.`),
      detail: `We can reach ${id}, but it is a manager account rather than an ad account.`,
      visibleElsewhere: false,
      probe: "GAQL customer",
    };
  }

  let rows: any[];
  try {
    rows = await run("SELECT metrics.impressions, metrics.clicks, metrics.cost_micros FROM customer WHERE segments.date DURING LAST_7_DAYS");
  } catch (e) {
    return { outcome: "fail", rawError: trim(`customer metrics ${id} → ${err(e)}`), detail: `We can reach ${id}${name ? ` ("${name}")` : ""} but could not read its figures.`, visibleElsewhere: false, probe: "GAQL metrics" };
  }
  const impressions = Number((rows[0]?.metrics as any)?.impressions ?? 0);
  if (!rows.length || impressions === 0) {
    return {
      outcome: "no_data",
      rawError: null,
      detail: `Access confirmed on ${id}${name ? ` ("${name}")` : ""}, status ${String(c.status ?? "unknown")}, but it reported no impressions in the last 7 days.`,
      visibleElsewhere: false,
      probe: "GAQL metrics",
    };
  }
  return {
    outcome: "pass",
    rawError: null,
    detail: `Read ${impressions} impression${impressions === 1 ? "" : "s"} from ${id}${name ? ` ("${name}")` : ""} over the last 7 days.`,
    visibleElsewhere: false,
    probe: "GAQL metrics",
  };
}

/**
 * Re-probe everything that has aged out. Each result is a new row rather than
 * an update, because the history IS the regression signal: audit-and-repair
 * compares the newest result against the previous pass to tell "this was
 * revoked" from "this was never granted", and those are different tasks for
 * different people.
 *
 * One connector's failure never stops the sweep — a dead credential on one
 * source would otherwise hide the state of every other client.
 */
async function sweep(days: number, max: number): Promise<void> {
  const databaseUrl = (process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("Missing DATABASE_URL.");
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const stale = await findStale(c, days, max);
    console.log(`Connection test sweep — ${stale.length} connector(s) untested or older than ${days} day(s)${dryRun ? " (dry-run)" : ""}`);
    const { rows: mappings } = await c.query<{ client_id: string; source: string; external_id: string }>(
      `SELECT client_id, source, external_id FROM connector_mappings WHERE enabled AND external_id IS NOT NULL AND external_id <> ''`,
    );
    const key = (clientId: string, source: string) => `${clientId}:${source}`;
    const idBy = new Map(mappings.map((m) => [key(m.client_id, m.source), m.external_id.trim()]));

    for (const row of stale) {
      const source = row.source as Testable;
      const externalId = idBy.get(key(row.client_id, source));
      if (!externalId) continue; // switched off between the query and now
      let result: ProbeResult;
      try {
        result = await probe(source, externalId);
      } catch (e) {
        result = { outcome: "fail", rawError: trim(err(e)), detail: null, visibleElsewhere: false, probe: "unknown" };
      }
      const mark = result.outcome === "pass" ? "✓" : result.outcome === "no_data" ? "·" : "✗";
      console.log(`  ${mark} ${row.name} · ${source} (${externalId}) — ${result.outcome}${result.detail ? ` · ${result.detail}` : ""}${result.rawError ? ` · ${result.rawError.slice(0, 160)}` : ""}`);
      if (dryRun) continue;
      await c.query(
        `INSERT INTO connector_tests (id, client_id, source, outcome, external_id, raw_error, detail, visible_elsewhere, probe, requested_by, started_at, tested_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, 'audit', now(), now())`,
        [row.client_id, source, result.outcome, externalId, result.rawError, result.detail, result.visibleElsewhere, result.probe],
      );
    }
  } finally {
    await c.end();
  }
}

async function probe(source: Testable, externalId: string): Promise<ProbeResult> {
  if (source === "gsc") return probeGsc(externalId);
  if (source === "ga4") return probeGa4(externalId);
  return probeAds(externalId);
}

/** Every (client, source) worth re-probing: a live client, a connector that is
 *  switched on with an id, and no settled test result inside the window. Capped
 *  so one bad day can never turn the morning audit into a quota incident. */
async function findStale(c: pg.Client, days: number, max: number): Promise<{ client_id: string; name: string; source: string }[]> {
  const { rows } = await c.query<{ client_id: string; name: string; source: string }>(
    `SELECT m.client_id, cl.name, m.source
       FROM connector_mappings m
       JOIN clients cl ON cl.id = m.client_id
       LEFT JOIN LATERAL (
         SELECT max(tested_at) AS last_at FROM connector_tests t
          WHERE t.client_id = m.client_id AND t.source = m.source AND t.outcome <> 'running'
       ) t ON true
      WHERE m.enabled AND m.external_id IS NOT NULL AND m.external_id <> ''
        AND m.source = ANY($1::text[])
        AND cl.status IN ('launch', 'active')
        AND (t.last_at IS NULL OR t.last_at < now() - ($2 || ' days')::interval)
      ORDER BY t.last_at NULLS FIRST, cl.name
      LIMIT $3`,
    [[...TESTABLE], String(days), max],
  );
  return rows;
}

async function main() {
  // Sweep mode: no single client, just everything that has aged out.
  const staleDays = Number(arg("stale-days", "0"));
  if (staleDays > 0) return sweep(staleDays, Number(arg("max", "60")));

  const clientId = arg("client");
  if (!clientId) throw new Error("Missing --client=<clientId>.");
  const asked = arg("sources").split(",").map((s) => s.trim()).filter(Boolean);
  const requestIds = arg("request-ids").split(",").map((s) => s.trim()).filter(Boolean);
  const databaseUrl = (process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("Missing DATABASE_URL.");

  const sources = (asked.length ? asked : [...TESTABLE]).filter((s): s is Testable => (TESTABLE as readonly string[]).includes(s));
  if (!sources.length) throw new Error(`Nothing testable in --sources="${arg("sources")}". Valid: ${TESTABLE.join(", ")}.`);
  // The dashboard pairs request ids to sources positionally. A mismatch means
  // we would close the wrong row, so refuse rather than guess.
  if (requestIds.length && requestIds.length !== sources.length) {
    throw new Error(`--request-ids has ${requestIds.length} id(s) for ${sources.length} source(s); they pair 1:1.`);
  }

  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const { rows: mappings } = await c.query<{ source: string; external_id: string }>(
      `SELECT source, external_id FROM connector_mappings
        WHERE client_id = $1 AND enabled AND external_id IS NOT NULL AND external_id <> ''`,
      [clientId],
    );
    const bySource = new Map(mappings.map((m) => [m.source, m.external_id.trim()]));
    const { rows: clientRows } = await c.query<{ name: string }>(`SELECT name FROM clients WHERE id = $1`, [clientId]);
    console.log(`Connection test — ${clientRows[0]?.name ?? clientId}, ${sources.length} connector(s)${dryRun ? " (dry-run)" : ""}`);

    for (const [i, source] of sources.entries()) {
      const requestId = requestIds[i] ?? null;
      const externalId = bySource.get(source);
      let result: ProbeResult;
      if (!externalId) {
        // The mapping was switched off or blanked between the button press and
        // this run. Record it honestly rather than reporting a permission error
        // for an account we never actually asked about.
        const nothingToTest = `No ${source} account ID is entered and switched on for this client, so there was nothing to test.`;
        result = { outcome: "fail", rawError: nothingToTest, detail: nothingToTest, visibleElsewhere: false, probe: "none" };
      } else {
        try {
          result = await probe(source, externalId);
        } catch (e) {
          // Anything that escaped a probe — a dead credential, a thrown parse.
          // Store it verbatim; the dashboard decides whether it is ours or theirs.
          result = { outcome: "fail", rawError: trim(err(e)), detail: null, visibleElsewhere: false, probe: "unknown" };
        }
      }

      const mark = result.outcome === "pass" ? "✓" : result.outcome === "no_data" ? "·" : "✗";
      console.log(`  ${mark} ${source}${externalId ? ` (${externalId})` : ""} — ${result.outcome}${result.detail ? ` · ${result.detail}` : ""}${result.rawError ? ` · ${result.rawError.slice(0, 200)}` : ""}`);
      if (dryRun) continue;

      if (requestId) {
        // Close the row the dashboard opened. Guarded on outcome='running' so a
        // replayed run can never overwrite a settled result.
        const { rowCount } = await c.query(
          `UPDATE connector_tests
              SET outcome = $2, raw_error = $3, detail = $4, visible_elsewhere = $5, probe = $6,
                  external_id = coalesce($7, external_id), tested_at = now()
            WHERE id = $1 AND outcome = 'running'`,
          [requestId, result.outcome, result.rawError, result.detail, result.visibleElsewhere, result.probe, externalId ?? null],
        );
        if (rowCount) continue;
        console.log(`    (request ${requestId} was already settled — recording a new row instead)`);
      }
      await c.query(
        `INSERT INTO connector_tests (id, client_id, source, outcome, external_id, raw_error, detail, visible_elsewhere, probe, requested_by, started_at, tested_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
        [clientId, source, result.outcome, externalId ?? null, result.rawError, result.detail, result.visibleElsewhere, result.probe, arg("by", "audit")],
      );
    }
  } finally {
    await c.end();
  }
  // Always exit 0 on a completed run. A connector that fails its test is a
  // RESULT, not a broken job — going red here would bury the genuine "the test
  // harness itself is broken" signal under every client's missing grant.
}

main().catch((e) => { console.error(err(e)); process.exit(1); });

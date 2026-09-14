#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import { GoogleAdsApi } from "google-ads-api";
import pg from "pg";
import {
  analyzeAdsVisibility,
  analyzeGscSites,
  adsCustomerId,
  checkGa4PropertyId,
  classifyFailure,
  formatProbeError,
  httpErrorText,
  isProbeableSource,
  outcomeForRead,
  summarizeRun,
  truncate,
  STRANDED_ERROR,
  windowHasData,
  MAX_DETAIL,
  PROBEABLE_SOURCES,
  SOURCE_LABEL,
  type GscSiteEntry,
  type ProbeResult,
  type RunLine,
} from "./connection-probe.js";

/**
 * "Test connection" — the worker half.
 *
 * The dashboard's per-connector Test button opens a `connector_tests` row per
 * source with outcome='running', then dispatches this workflow with the client,
 * the sources and the row ids. This job asks Google for the SMALLEST possible
 * real read of that client's account and replaces each row with what it found.
 *
 * Why this exists at all: an AM hands a client a service-account address, the
 * client says "done", and until a nightly sync either failed or silently
 * returned nothing, nobody could tell whether it had worked. A Search Console
 * 403 sat open for weeks for exactly that reason.
 *
 * Four rules this job is built around:
 *
 *  1. `no_data` is NOT a failure. We got in, the account answered, it holds
 *     nothing for the window. A newly created property is legitimately empty,
 *     and sending the client another access request for that is the expensive
 *     mistake this whole feature exists to prevent.
 *  2. When the failure is OURS — our Google API switched off, our
 *     service-account key dead, our quota spent — the log says so loudly and
 *     prints nothing that reads like "ask the client for access". Every client
 *     would be failing simultaneously in that case.
 *  3. An error we do not recognise is reported as unrecognised, with the raw
 *     text. A confident wrong instruction costs more than no instruction.
 *  4. NO ROW IS EVER LEFT `running`. Every request id passed in ends in a
 *     terminal state — per-source failures are caught, the job's own failure
 *     path is caught, and the workflow runs a --finalize-only pass even when
 *     this process is killed outright. A row stuck running shows a test we
 *     never finished, which is the exact dishonesty this replaces.
 *
 * The error→fix translation is deliberately NOT here: the dashboard does it at
 * read time from the raw text (its shared/connection-test.ts explains why one
 * mapping in one repo is the only safe arrangement). This job stores the API's
 * words verbatim. See connection-probe.ts for the narrow, log-only
 * ours-vs-theirs verdict that does live on this side, and why.
 *
 * Usage:
 *   npm run test-connections -- --client=<clientId> --request-ids=a,b --sources=gsc,ga4
 *   npm run test-connections -- --client=<clientId> --sources=gsc --dry-run
 *   npm run test-connections -- --request-ids=a,b --finalize-only --reason="…"
 *
 * --dry-run does everything except the database write (it still performs the
 * real reads — that is the part worth proving) and prints what it would have
 * stored. Dispatched by .github/workflows/test-connections.yml.
 */

// ── args ────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length).trim() : undefined;
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Probe budget per source. A hung fetch must not be the reason a row is left
 *  open, so every call is bounded and a timeout is a normal, classified
 *  failure rather than a dead job. */
const PROBE_TIMEOUT_MS = 60_000;
/** The enrichment calls (what CAN we see?) are a nice-to-have on top of an
 *  answer we already have — they get a shorter leash. */
const ENRICH_TIMEOUT_MS = 30_000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s (fetch failed to answer)`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
}

// ── auth (same shapes the importers use — no new secret) ────────────────────

function serviceAccount(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON.");
  let json: { client_email?: string; private_key?: string };
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }
  if (!json.client_email || !json.private_key) throw new Error("Service-account JSON missing client_email / private_key.");
  return { client_email: json.client_email, private_key: json.private_key };
}

/** One token per scope, minted once and reused across a run's sources. */
async function tokenFor(scope: string): Promise<string> {
  const sa = serviceAccount();
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [scope] });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error(`Failed to mint an access token for ${scope}.`);
  return token;
}

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const GSC_API = "https://searchconsole.googleapis.com/webmasters/v3";
const GA4_API = "https://analyticsdata.googleapis.com/v1beta";

/**
 * Google Ads config, read straight from the environment rather than through
 * config.ts's loadConfig(). loadConfig() also requires DASHBOARD_DIR, which
 * exists so importers can shell out to the dashboard's `npm run sync` — this
 * job writes its own rows directly and has no business checking out the
 * dashboard repo just to satisfy a variable it never uses.
 */
function adsEnv() {
  const req = (n: string) => {
    const v = process.env[n];
    if (!v || !v.trim()) throw new Error(`Missing required env var ${n}.`);
    return v.trim();
  };
  return {
    clientId: req("GOOGLE_ADS_CLIENT_ID"),
    clientSecret: req("GOOGLE_ADS_CLIENT_SECRET"),
    developerToken: req("GOOGLE_ADS_DEVELOPER_TOKEN"),
    refreshToken: req("GOOGLE_ADS_REFRESH_TOKEN"),
    loginCustomerId: adsCustomerId(req("GOOGLE_ADS_LOGIN_CUSTOMER_ID")),
  };
}

// ── the probes ──────────────────────────────────────────────────────────────

/**
 * Search Console.
 *
 * The real read first (one call when everything works), and the "what CAN we
 * see" enumeration only when it fails. sites.list is free, in scope, and is the
 * one place any of the three APIs will tell us what we actually hold — which is
 * what turns "permission denied" into "you granted us the wrong property, here
 * is the one you granted".
 */
async function probeGsc(property: string): Promise<ProbeResult> {
  const start = daysAgo(30);
  // Search Console finalises data a couple of days behind; asking up to today
  // would report an empty tail as an empty property.
  const end = daysAgo(3);
  const probe = `gsc:searchAnalytics.query ${start}..${end}`;
  const token = await tokenFor(GSC_SCOPE);

  const res = await withTimeout(
    fetch(`${GSC_API}/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate: start, endDate: end, dimensions: [], dataState: "final" }),
    }),
    PROBE_TIMEOUT_MS,
    "Search Console searchAnalytics.query",
  );

  if (res.ok) {
    const json = (await res.json()) as { rows?: Array<{ clicks?: number; impressions?: number }> };
    const row = json.rows?.[0];
    const clicks = Number(row?.clicks ?? 0);
    const impressions = Number(row?.impressions ?? 0);
    const outcome = outcomeForRead(windowHasData([clicks, impressions]));
    return {
      outcome,
      rawError: null,
      detail: truncate(
        outcome === "pass"
          ? `Read ${clicks} clicks / ${impressions} impressions for ${property} over ${start}..${end}.`
          : `The read succeeded — Search Console returned no rows for ${property} over ${start}..${end}. The access works; the property is empty for that window.`,
        MAX_DETAIL,
      ),
      visibleElsewhere: false,
      probe,
    };
  }

  const rawError = httpErrorText(res.status, await res.text());

  // Enrichment: what does Search Console list for us? Only meaningful if this
  // call itself succeeds — if it fails too, we say nothing rather than imply a
  // check we did not make.
  let detail: string | null = null;
  let visibleElsewhere = false;
  try {
    const sitesRes = await withTimeout(
      fetch(`${GSC_API}/sites`, { headers: { Authorization: `Bearer ${token}` } }),
      ENRICH_TIMEOUT_MS,
      "Search Console sites.list",
    );
    if (sitesRes.ok) {
      const body = (await sitesRes.json()) as { siteEntry?: GscSiteEntry[] };
      const analysis = analyzeGscSites(property, body.siteEntry ?? []);
      detail = analysis.detail;
      visibleElsewhere = analysis.visibleElsewhere;
    } else {
      detail = truncate(
        `We could not list the properties visible to us either (sites.list → HTTP ${sitesRes.status}), so we cannot say whether this is the wrong property or no grant at all.`,
        MAX_DETAIL,
      );
    }
  } catch (e) {
    detail = truncate(`We could not list the properties visible to us (${formatProbeError(e).slice(0, 160)}), so nothing here rules a wrong-property mix-up in or out.`, MAX_DETAIL);
  }

  return { outcome: "fail", rawError, detail, visibleElsewhere, probe: `${probe} + sites.list` };
}

/**
 * GA4.
 *
 * Property-level access covers every data stream, so there is exactly one thing
 * to check and one common way for it to be wrong on OUR side: a measurement id
 * (G-XXXXXXX) stored where the numeric property id belongs. That is caught
 * before the call — gambling on whether Google answers 400 or 404 for a
 * malformed path would leave the fix reading as the client's when it is ours.
 *
 * GA4's read-only Data API has no list call, so unlike Search Console we cannot
 * say which properties we CAN see. We therefore never imply we looked.
 */
async function probeGa4(rawId: string): Promise<ProbeResult> {
  const check = checkGa4PropertyId(rawId);
  if (!check.ok) {
    return {
      outcome: "fail",
      rawError: check.probeError ?? `Invalid property id "${rawId}".`,
      detail: check.detail ?? null,
      visibleElsewhere: false,
      probe: "ga4:property-id check (no API call made)",
    };
  }

  const start = daysAgo(28);
  const end = daysAgo(1);
  const probe = `ga4:runReport sessions ${start}..${end} (properties/${check.id})`;
  const token = await tokenFor(GA4_SCOPE);

  const res = await withTimeout(
    fetch(`${GA4_API}/properties/${check.id}:runReport`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate: start, endDate: end }],
        metrics: [{ name: "sessions" }],
        limit: 1,
      }),
    }),
    PROBE_TIMEOUT_MS,
    "GA4 runReport",
  );

  if (res.ok) {
    const json = (await res.json()) as { rows?: Array<{ metricValues?: Array<{ value?: string }> }> };
    const sessions = Number(json.rows?.[0]?.metricValues?.[0]?.value ?? 0);
    const outcome = outcomeForRead(windowHasData([sessions]));
    return {
      outcome,
      rawError: null,
      detail: truncate(
        outcome === "pass"
          ? `Read ${sessions} sessions from GA4 property ${check.id} over ${start}..${end}.`
          : `The read succeeded — GA4 property ${check.id} reported 0 sessions over ${start}..${end}. The access works; the property is empty for that window, which is normal for one created recently or one the site does not actually report into.`,
        MAX_DETAIL,
      ),
      visibleElsewhere: false,
      probe,
    };
  }

  return {
    outcome: "fail",
    rawError: httpErrorText(res.status, await res.text()),
    // Deliberately no claim about other properties: GA4's read-only Data API
    // has no list call, so we have not looked and must not sound as if we had.
    detail: truncate(
      `Probed GA4 property ${check.id} directly. GA4's read-only Data API has no list call, so we cannot tell from here whether we have access to a DIFFERENT property of this client's — only that this one refused.`,
      MAX_DETAIL,
    ),
    visibleElsewhere: false,
    probe,
  };
}

const ADS_GAQL = `
  SELECT metrics.impressions, metrics.clicks, metrics.cost_micros
  FROM customer
  WHERE segments.date BETWEEN '{{start}}' AND '{{end}}'
`;

/**
 * Google Ads.
 *
 * Different credential entirely: OAuth + developer token + our manager account.
 * The shared service-account address is not used at all, and sending it to a
 * client for Ads is a guaranteed wasted round trip.
 *
 * Two access routes, and the failure mode that dominates is neither of them
 * being broken: a link invitation from our manager account that was sent and
 * never ACCEPTED. That is not a permission error, so the enrichment reports
 * whether our manager can see the account at all rather than asserting a
 * permission problem.
 */
async function probeAds(rawId: string): Promise<ProbeResult> {
  const customerId = adsCustomerId(rawId);
  if (!customerId) {
    return {
      outcome: "fail",
      rawError: `Invalid customer id "${rawId}": no digits in the Google Ads account id we hold (probe check — no API call was made).`,
      detail: "Ours to fix in Admin → Connectors → Google Ads — the ten-digit Customer ID is at the top right inside the ad account.",
      visibleElsewhere: false,
      probe: "google_ads:customer-id check (no API call made)",
    };
  }

  const env = adsEnv();
  const api = new GoogleAdsApi({ client_id: env.clientId, client_secret: env.clientSecret, developer_token: env.developerToken });
  const start = daysAgo(30);
  const end = daysAgo(1);
  const query = ADS_GAQL.replace("{{start}}", start).replace("{{end}}", end);

  // Accounts reach us two ways: under our manager account, or shared directly
  // with the authenticated user. Try the manager header first and fall back to
  // a direct call — the same dual path pullWindow() uses, without which a
  // directly-shared account fails with "the manager's customer id must be set"
  // even though it is perfectly reachable.
  let rows: Array<{ metrics?: Record<string, unknown> }> = [];
  let via = "via MCC";
  try {
    rows = await withTimeout(
      api.Customer({ customer_id: customerId, login_customer_id: env.loginCustomerId, refresh_token: env.refreshToken }).query(query),
      PROBE_TIMEOUT_MS,
      "Google Ads query (via manager account)",
    );
  } catch (mccErr) {
    try {
      rows = await withTimeout(
        api.Customer({ customer_id: customerId, refresh_token: env.refreshToken }).query(query),
        PROBE_TIMEOUT_MS,
        "Google Ads query (direct)",
      );
      via = "direct, no manager header";
    } catch {
      // Report the manager-account error: it is the route we actually intend
      // to use, and the direct attempt was only ever a fallback.
      const rawError = formatProbeError(mccErr);
      const { visibleElsewhere, detail } = await adsVisibilityDetail(api, env, customerId);
      return { outcome: "fail", rawError, detail, visibleElsewhere, probe: `google_ads:GAQL customer metrics ${start}..${end} + customer_client list` };
    }
  }

  const m = (rows[0]?.metrics ?? {}) as Record<string, unknown>;
  const impressions = Number(m.impressions ?? 0);
  const clicks = Number(m.clicks ?? 0);
  const cost = Number(m.cost_micros ?? 0);
  const outcome = outcomeForRead(windowHasData([impressions, clicks, cost]));
  return {
    outcome,
    rawError: null,
    detail: truncate(
      outcome === "pass"
        ? `Read ${impressions} impressions / ${clicks} clicks for account ${customerId} over ${start}..${end} (${via}).`
        : `The read succeeded (${via}) — account ${customerId} served nothing over ${start}..${end}. The access works; the account is simply not spending, which is normal before a campaign launches.`,
      MAX_DETAIL,
    ),
    visibleElsewhere: false,
    probe: `google_ads:GAQL customer metrics ${start}..${end} (${via})`,
  };
}

/** Best-effort: can our manager account see this ad account at all? Never
 *  writes another client's account id anywhere near this client's row — only
 *  the presence or absence of THIS one, plus a count. */
async function adsVisibilityDetail(
  api: GoogleAdsApi,
  env: ReturnType<typeof adsEnv>,
  customerId: string,
): Promise<{ visibleElsewhere: boolean; detail: string }> {
  try {
    const rows = await withTimeout(
      api
        .Customer({ customer_id: env.loginCustomerId, login_customer_id: env.loginCustomerId, refresh_token: env.refreshToken })
        .query("SELECT customer_client.id, customer_client.manager FROM customer_client"),
      ENRICH_TIMEOUT_MS,
      "Google Ads customer_client list",
    );
    const visibleIds = rows
      .map((r) => (r as { customer_client?: { id?: unknown; manager?: unknown } }).customer_client)
      .filter((cc): cc is { id?: unknown; manager?: unknown } => Boolean(cc))
      // Manager nodes are not ad accounts and cannot report metrics; counting
      // them would inflate "accounts we can see".
      .filter((cc) => cc.manager !== true)
      .map((cc) => String(cc.id ?? ""))
      .filter(Boolean);
    return analyzeAdsVisibility(customerId, { visibleIds, listed: true });
  } catch (e) {
    console.log(`    (could not list accounts under the manager account: ${formatProbeError(e).slice(0, 200)})`);
    return analyzeAdsVisibility(customerId, { visibleIds: [], listed: false });
  }
}

async function probe(source: string, externalId: string): Promise<ProbeResult> {
  if (source === "gsc") return probeGsc(externalId);
  if (source === "ga4") return probeGa4(externalId);
  if (source === "google_ads") return probeAds(externalId);
  // Unreachable in practice — main() refuses a non-probeable source before it
  // gets here — but a thrown error would strand the row, so answer instead.
  return {
    outcome: "fail",
    rawError: `No probe exists for source "${source}" (probe check — no API call was made). Only ${PROBEABLE_SOURCES.join(", ")} authenticate with an access grant that can be probed.`,
    detail: "Ours: the dashboard dispatched a source this job cannot test. Raise it with engineering; nothing here says anything about the client.",
    visibleElsewhere: false,
    probe: "unsupported source",
  };
}

// ── database ────────────────────────────────────────────────────────────────

interface TestRow {
  id: string;
  client_id: string;
  source: string;
  external_id: string | null;
  outcome: string;
}

/**
 * Close one row. Scoped to `outcome = 'running'` so it is idempotent and so a
 * later --finalize-only sweep can never overwrite a real answer with "the job
 * died" — whichever writes first, wins, and that is always the more informed
 * one.
 */
async function writeResult(db: pg.Client, row: TestRow, result: ProbeResult): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE connector_tests
        SET outcome = $2, raw_error = $3, detail = $4, visible_elsewhere = $5, probe = $6, tested_at = now()
      WHERE id = $1 AND outcome = 'running'`,
    [row.id, result.outcome, result.rawError, result.detail, result.visibleElsewhere, result.probe],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The safety net. Any row we were handed that is still `running` is closed as
 * a failure that says the test did not complete — never as a verdict on the
 * client's access, because it isn't one.
 *
 * Called from main()'s finally block AND, separately, by the workflow's
 * always() step, which covers the cases this process cannot: an OOM kill, a
 * cancelled run, a step timeout.
 */
async function finalizeStranded(db: pg.Client, ids: string[], reason: string, dryRun: boolean, clientId: string): Promise<number> {
  if (!ids.length) return 0;
  // The stored error is fixed text (see STRANDED_ERROR for why the run's own
  // status must never end up in it). The variable part goes in `detail`, which
  // the dashboard renders but never pattern-matches.
  const rawError = STRANDED_ERROR;
  const detail = truncate(
    `Why: ${reason} Re-run the test; if it strands twice, the workflow is failing before it reaches Google.`,
    MAX_DETAIL,
  );
  // Scoped to the dispatched client whenever we were told one, so an id that
  // does not belong to this run can never be closed by it.
  const scope = clientId ? ` AND client_id = $4` : "";
  const params: unknown[] = clientId ? [ids, rawError, detail, clientId] : [ids, rawError, detail];
  if (dryRun) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM connector_tests WHERE id = ANY($1::text[]) AND outcome = 'running'${clientId ? " AND client_id = $2" : ""}`,
      clientId ? [ids, clientId] : [ids],
    );
    if (rows.length) console.log(`  [dry-run] would close ${rows.length} stranded row(s) as fail: ${reason}`);
    return rows.length;
  }
  const { rowCount } = await db.query(
    `UPDATE connector_tests
        SET outcome = 'fail', raw_error = $2, detail = $3, probe = 'job did not finish', tested_at = now()
      WHERE id = ANY($1::text[]) AND outcome = 'running'${scope}`,
    params,
  );
  const n = rowCount ?? 0;
  if (n > 0) console.log(`  Closed ${n} stranded row(s) so nothing is left "running": ${reason}`);
  return n;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const clientId = arg("client") ?? "";
  const requestIds = list(arg("request-ids"));
  const sources = list(arg("sources"));
  const dryRun = flag("dry-run");
  const finalizeOnly = flag("finalize-only");
  const reason = arg("reason") || "the workflow run failed or was cancelled before the probe wrote a result";

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !dbUrl.trim()) throw new Error("Missing DATABASE_URL.");
  const db = new pg.Client({ connectionString: dbUrl.trim() });
  await db.connect();

  // Everything after this point must reach the finally block, which is the
  // last line of defence against a row left running.
  // A dry run writes nothing, so it has nothing to strand and nothing to
  // close — tracking ids here would make a clean dry run print a scary
  // "would close N stranded rows" for rows it deliberately left alone.
  const toFinalize = new Set<string>(dryRun ? [] : requestIds);
  try {
    if (finalizeOnly) {
      console.log(`═══ test-connections — finalize-only sweep (${requestIds.length} row id(s)) ═══`);
      if (!requestIds.length) {
        console.log("Nothing to finalize.");
        return;
      }
      await finalizeStranded(db, requestIds, reason, dryRun, clientId);
      toFinalize.clear();
      return;
    }

    console.log(`═══ Connection test${dryRun ? " (DRY RUN — no database write)" : ""} ═══`);

    // Resolve what to probe. Normal path: the dashboard already opened a row
    // per source and handed us the ids, and the row carries the external_id it
    // was opened against — use THAT rather than re-reading connector_mappings,
    // so a correction made in Admin mid-run cannot silently change what an
    // in-flight result means.
    let targets: TestRow[] = [];
    if (requestIds.length) {
      const { rows } = await db.query<TestRow>(
        `SELECT id, client_id, source, external_id, outcome FROM connector_tests WHERE id = ANY($1::text[])`,
        [requestIds],
      );
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      for (const id of requestIds) {
        const row = byId.get(id);
        if (!row) {
          // Nothing to strand — the row does not exist. Say so; a silent skip
          // here would look identical to a successful probe.
          console.log(`  ! request id ${id} has no connector_tests row — skipping.`);
          toFinalize.delete(id);
          continue;
        }
        if (clientId && row.client_id !== clientId) {
          // Refuse to touch another client's row, whatever was dispatched.
          console.log(`  ! request id ${id} belongs to a different client than --client — refusing to touch it.`);
          toFinalize.delete(id);
          continue;
        }
        if (row.outcome !== "running") {
          console.log(`  · request id ${id} (${row.source}) is already '${row.outcome}' — leaving it alone.`);
          toFinalize.delete(id);
          continue;
        }
        targets.push(row);
      }
      // `sources` is passed alongside `request_ids` by the dashboard and is
      // informational here: the row is the authority on what it is for.
      if (sources.length && sources.length !== requestIds.length) {
        console.log(`  · note: ${sources.length} source(s) passed for ${requestIds.length} request id(s) — going by the rows.`);
      }
    } else {
      // Standalone dry run: no rows were opened, so read the connectors
      // straight from the mapping table. Never writes anything.
      if (!dryRun) throw new Error("Pass --request-ids=<ids> (the dashboard supplies them), or use --dry-run to probe without writing.");
      if (!clientId) throw new Error("Pass --client=<clientId> for a standalone dry run.");
      const wanted = sources.length ? sources : [...PROBEABLE_SOURCES];
      const { rows } = await db.query<{ source: string; external_id: string | null }>(
        `SELECT source, external_id FROM connector_mappings
          WHERE client_id = $1 AND enabled = true AND external_id IS NOT NULL AND external_id <> '' AND source = ANY($2::text[])`,
        [clientId, wanted],
      );
      targets = rows.map((r, i) => ({ id: `dry-run-${i}`, client_id: clientId, source: r.source, external_id: r.external_id, outcome: "running" }));
    }

    if (clientId) {
      const { rows } = await db.query<{ name: string | null }>(`SELECT name FROM clients WHERE id = $1`, [clientId]);
      console.log(`Client: ${rows[0]?.name ?? clientId}`);
    }
    if (!targets.length) {
      console.log("Nothing to probe.");
      return;
    }

    const lines: RunLine[] = [];
    let oursCount = 0;

    for (const row of targets) {
      const label = SOURCE_LABEL[row.source as keyof typeof SOURCE_LABEL] ?? row.source;
      console.log(`\n── ${label} (${row.source}) ──`);
      if (!isProbeableSource(row.source)) {
        console.log(`  ! ${row.source} is not probeable — closing the row rather than leaving it open.`);
      }
      const externalId = row.external_id?.trim() ?? "";
      console.log(`  id on the connector: ${externalId || "(none stored)"}`);

      let result: ProbeResult;
      try {
        result = await probe(row.source, externalId);
      } catch (e) {
        // Anything the probe threw — a dead token, a timeout, an unexpected
        // shape. This is the per-source net: it must never propagate, because
        // one source throwing would strand every row after it.
        result = {
          outcome: "fail",
          rawError: formatProbeError(e),
          detail: null,
          visibleElsewhere: false,
          probe: `${row.source}:probe threw`,
        };
      }

      if (result.outcome === "fail") {
        const verdict = classifyFailure(row.source, result.rawError);
        if (verdict.scope === "ours") oursCount++;
        console.log(`  OUTCOME: fail (${verdict.code})`);
        console.log(`  ${verdict.summary}`);
        console.log(`  error: ${truncate(result.rawError ?? "(none)", 500)}`);
        lines.push({ source: row.source, outcome: "fail", scope: verdict.scope });
      } else if (result.outcome === "no_data") {
        // Spelled out every time on purpose. "No data" is the result most
        // likely to be misread as a failure, and the misreading costs a client
        // email asking for access they already granted.
        console.log("  OUTCOME: no_data — we got IN and the account answered with nothing. The access WORKS. This is not a permission problem and must not be reported as one.");
        lines.push({ source: row.source, outcome: "no_data" });
      } else {
        console.log("  OUTCOME: pass — we read real data.");
        lines.push({ source: row.source, outcome: "pass" });
      }
      if (result.detail) console.log(`  detail: ${result.detail}`);
      console.log(`  probe: ${result.probe}`);

      if (dryRun) {
        console.log(`  [dry-run] would write: outcome=${result.outcome}, visible_elsewhere=${result.visibleElsewhere}, raw_error=${result.rawError ? `${result.rawError.length} chars` : "null"}`);
      } else {
        const written = await writeResult(db, row, result);
        toFinalize.delete(row.id);
        console.log(written ? `  written to connector_tests row ${row.id}.` : `  row ${row.id} was no longer 'running' — left as it was.`);
      }
    }

    console.log(`\n${summarizeRun(lines)}`);
    if (oursCount > 0) {
      console.log(
        "\n!! At least one failure above is OURS, not the client's — our Google API, our service-account key, our quota or our network.\n" +
          "!! Every client will be failing the same way right now. Fix it on our side and re-test.\n" +
          "!! Do NOT send an access request to any client on the strength of this run.",
      );
    }
  } finally {
    // Last line of defence inside this process. The workflow runs the same
    // sweep separately, for the kills this block never sees.
    try {
      await finalizeStranded(db, [...toFinalize], reason, dryRun, clientId);
    } catch (e) {
      console.error(`Could not close stranded rows: ${formatProbeError(e)}`);
    }
    await db.end();
  }
}

main().catch((e) => {
  // The message is the last line of the log, which is what a heartbeat-style
  // note or a human skimming a red run actually reads.
  console.error(formatProbeError(e));
  process.exit(1);
});

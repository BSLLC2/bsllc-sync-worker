#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { runDashboardSync, type SyncEntry } from "./emit.js";
import { monthSnapshot, ymd } from "./dates.js";
import { loadMetaConfig } from "./ads/meta-adapter.js";
import { emitJobSummary } from "./ads-operability.js";
import {
  META_GRAPH, META_MAX_LOOKBACK_MONTHS, META_MONTHLY_FIELDS, META_METRIC_KEYS,
  metaAccountId, metaConversionWindow, metaMonthlyMetrics, monthsBackStart,
} from "./meta/insights.js";

/**
 * Meta (Facebook / Instagram) paid social -> dashboard metrics importer.
 *
 * WHY THIS EXISTS. One paid channel had cost and no reporting. A client was
 * spending real money on Meta every month and the OS could not see a cent of
 * it: Admin -> Connectors read the account as "Not connected", the client page
 * had no Meta panel, and no return-on-spend figure anywhere could be honest
 * while one paid channel was missing from the denominator.
 *
 * The findings adapter (src/ads/meta-adapter.ts) has been written against the
 * Marketing API for some time and has never run for want of a token, but it
 * judges CAMPAIGNS -- it has never written a metric row. This is the other
 * half: monthly spend and performance per client, per mapped ad account, in
 * `client_metrics`, in the shape the client page already expects.
 *
 * THE BOUNDARY IS UNCHANGED. The worker is the only thing that reads a third
 * party; the app reads Postgres. This makes one read against the Graph API and
 * hands the result to the dashboard's own `npm run sync`, which owns every
 * write -- the same contract src/import-ga4.ts and src/index.ts live by. There
 * is no SQL in this file.
 *
 * WHAT IT WRITES, and nothing else: the six keys in META_METRIC_KEYS. That
 * list has to equal EXPECTED_METRIC_KEYS.meta in the dashboard's
 * shared/schema.ts, and the money keys among them have to be declared in
 * METRIC_CURRENCY_UNITS there. The app's `npm run verify:wiring` reads this
 * repo and fails if either drifts -- because a metric key nobody declares the
 * unit of is precisely how this system once printed the same figure as "$32"
 * and "$32,000,000" on one screen.
 *
 * WHAT A HUMAN HAS TO DO FIRST. One secret, META_ACCESS_TOKEN, a system-user
 * token with `ads_read` on each client's ad account; and one mapping per
 * client in Admin -> Connectors -> Meta, the ad account id including the
 * `act_` prefix. Neither of those can be done from here. With accounts mapped
 * and no token this run FAILS, loudly, every day, rather than reporting green
 * over an importer that is doing nothing -- see the exit rules in main().
 *
 * Usage:
 *   npm run import-meta                       # every mapped account, 24 months
 *   npm run import-meta -- --months=6
 *   npm run import-meta -- --since=2026-01-01
 *   npm run import-meta -- --client=<client uuid or name prefix> --dry-run
 */

const DEFAULT_MONTHS = 24;

interface Args {
  since: string;
  months: number;
  dryRun: boolean;
  onlyClient: string;
}

function parseArgs(argv: string[], now: Date): Args {
  let since = "";
  let months = DEFAULT_MONTHS;
  let dryRun = false;
  let onlyClient = "";
  for (const a of argv) {
    if (a.startsWith("--since=")) since = a.slice("--since=".length).trim();
    else if (a.startsWith("--months=")) months = Math.max(1, Number(a.slice("--months=".length)) || DEFAULT_MONTHS);
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--client=")) onlyClient = a.slice("--client=".length).trim();
  }
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`--since must be YYYY-MM-DD (got "${since}")`);
  const start = since || monthsBackStart(months, now);
  const floor = monthsBackStart(META_MAX_LOOKBACK_MONTHS, now);
  if (start < floor) {
    throw new Error(
      `Meta will not report an insights window starting before ${floor} (37 months). ` +
      `Asked for ${start}. Nothing older than that exists to import.`,
    );
  }
  return { since: start, months, dryRun, onlyClient };
}

interface MetaTarget { clientId: string; clientName: string; accountId: string; rawId: string }

/**
 * The source of truth for which client uses which Meta ad account is the
 * dashboard itself: Admin -> Connectors, stored in connector_mappings
 * (source='meta', external_id = the ad account id). Read-only -- the worker
 * never writes to the database directly.
 *
 * Deliberately NOT filtered by client status. The findings audit reads only
 * `launch` and `active` accounts because a finding is advice somebody has to
 * act on; a metric is a record of money that was spent, and a paused client's
 * last two months of spend is exactly the figure somebody needs when they ask
 * what the account cost. A churned client keeps its history either way.
 */
async function targetsFromDb(databaseUrl: string, onlyClient: string): Promise<MetaTarget[]> {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ client_id: string; name: string | null; external_id: string }>(
      `SELECT cm.client_id, c.name, cm.external_id
         FROM connector_mappings cm
         JOIN clients c ON c.id = cm.client_id
        WHERE cm.source = 'meta' AND cm.enabled = true
          AND cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''
        ORDER BY c.name`,
    );
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const want = slug(onlyClient);
    return rows
      .map((r) => ({
        clientId: r.client_id,
        clientName: r.name ?? r.client_id,
        accountId: metaAccountId(r.external_id),
        rawId: r.external_id.trim(),
      }))
      .filter((t) => !onlyClient || t.clientId === onlyClient || slug(t.clientName).startsWith(want));
  } finally {
    await c.end();
  }
}

/**
 * One account's monthly insights. Follows `paging.next` because the Graph API
 * pages everything, even a result that fits -- a 24-row answer never needs a
 * second page, and a silent truncation would read as an account that stopped
 * spending.
 */
async function monthlyInsights(
  token: string, act: string, since: string, until: string,
  onLog: (s: string) => void,
): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams({
    level: "account",
    time_increment: "monthly",
    time_range: JSON.stringify({ since, until }),
    fields: META_MONTHLY_FIELDS,
    limit: "500",
    access_token: token,
  });
  let url: string | null = `${META_GRAPH}/${act}/insights?${qs}`;
  const out: Record<string, unknown>[] = [];
  for (let page = 0; url && page < 24; page++) {
    const resp: Response = await fetch(url);
    const body = (await resp.json().catch(() => ({}))) as {
      data?: unknown; error?: { message?: string; code?: number }; paging?: { next?: string };
    };
    if (!resp.ok) {
      const e = body?.error;
      throw new Error(`Meta API ${resp.status}${e?.code ? ` (code ${e.code})` : ""}: ${e?.message ?? "no message"}`);
    }
    if (Array.isArray(body.data)) out.push(...(body.data as Record<string, unknown>[]));
    url = body.paging?.next ?? null;
    if (url) onLog(`      (following a second page of insights for ${act})`);
  }
  return out;
}

async function main() {
  const now = new Date();
  const args = parseArgs(process.argv.slice(2), now);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const dashboardDir = process.env.DASHBOARD_DIR?.trim();
  if (!databaseUrl || !dashboardDir) throw new Error("Missing DATABASE_URL / DASHBOARD_DIR.");

  const targets = await targetsFromDb(databaseUrl, args.onlyClient);

  // NOTHING MAPPED IS NOT A FAILURE, and it must not read as one. Nobody has
  // wired a Meta ad account in Admin -> Connectors yet, so there is no work and
  // nothing is broken. The heartbeat still says which of the two happened --
  // "no accounts mapped" and "three accounts, nothing came back" produce the
  // same empty screen otherwise, and they need opposite actions.
  if (!targets.length) {
    console.log("No Meta ad accounts are mapped. Add one in Admin -> Connectors -> Meta (paste the ad account id, act_...).");
    emitJobSummary("accounts=0 read=0 months=0 errors=0 · no Meta ad account is mapped in Admin → Connectors");
    process.exit(0);
  }

  // ACCOUNTS ARE MAPPED AND THERE IS NO TOKEN. Somebody has wired an account
  // and is waiting for figures, so this FAILS rather than exiting quietly:
  // a green heartbeat over an importer that can never import is the "stopped
  // or retired?" confusion the whole Data health page exists to end.
  const { accessToken } = loadMetaConfig();
  if (!accessToken) {
    console.error(`${targets.length} Meta ad account(s) are mapped and META_ACCESS_TOKEN is not set on the worker, so none of them can be read:`);
    for (const t of targets) console.error(`  ${t.clientName} → ${t.accountId}`);
    console.error("");
    console.error("Fix: create a system user in the BS LLC Meta business portfolio, grant it each");
    console.error("client's ad account with the ads_read permission, generate a token, and store it");
    console.error("as the META_ACCESS_TOKEN repository secret on bsllc-sync-worker. Nothing here can");
    console.error("do that step. See docs/META_CONNECTOR_SETUP.md.");
    emitJobSummary(`accounts=${targets.length} read=0 months=0 errors=${targets.length} · META_ACCESS_TOKEN is not set on the worker`);
    process.exit(1);
  }

  const until = ymd(now);
  console.log(
    `Meta import — ${targets.length} account(s) from connector_mappings, ${args.since}..${until}` +
    `${args.dryRun ? " · DRY RUN" : ""}`,
  );

  const syncs: SyncEntry[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  let read = 0;
  let planted = 0;

  for (const t of targets) {
    const base = { client_id: t.clientId, source: "meta" as const, external_id: t.accountId };
    if (!t.accountId) {
      // A mapping with no digits in it is a typo somebody can fix in a minute,
      // and it is recorded as an error row so the connector says so rather
      // than sitting on "Waiting for first sync" for ever.
      const msg = `"${t.rawId}" is not a Meta ad account id — paste it as act_1234567890 in Admin → Connectors.`;
      const { start, end, syncedAt } = monthSnapshot(until.slice(0, 7), now);
      syncs.push({ ...base, external_id: t.rawId, period_start: start, period_end: end, synced_at: syncedAt, data_state: "error", error_message: msg, metrics: {} });
      failures.push(`${t.clientName} → ${msg}`);
      continue;
    }

    let rows: Record<string, unknown>[];
    try {
      rows = await monthlyInsights(accessToken, t.accountId, args.since, until, (s) => console.log(s));
      read++;
    } catch (e) {
      // ONE ACCOUNT'S FAILURE MUST NOT COST THE REST, and it must not vanish
      // either: it lands as a data_state='error' row for the current month, so
      // the connector row and the freshness monitor both see it. The same
      // shape src/index.ts uses for a Google Ads account that will not answer.
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      const { start, end, syncedAt } = monthSnapshot(until.slice(0, 7), now);
      syncs.push({ ...base, period_start: start, period_end: end, synced_at: syncedAt, data_state: "error", error_message: msg, metrics: {} });
      failures.push(`${t.clientName} [${t.accountId}] → ${msg}`);
      console.error(`  ${t.clientName} [${t.accountId}] — FAILED: ${msg}`);
      continue;
    }

    // The evidence window is this account's WHOLE pull, read before any month
    // is planted: whether the pixel reports conversions at all is a fact about
    // the account, not about one month of it. See meta/insights.ts.
    const convWindow = metaConversionWindow(rows);
    const attribution = rows.find((r) => r.attribution_setting)?.attribution_setting;

    let months = 0;
    let liveMonths = 0;
    let allClicksRows = 0;
    let heldBack = 0;
    let unplaceable = 0;
    for (const row of rows) {
      const reading = metaMonthlyMetrics(row, convWindow);
      if (!reading.ym) { unplaceable++; continue; }
      // monthSnapshot caps the in-progress month at today, so period_end and
      // synced_at can never land in the future — which the Data health page
      // reads as "Bad timestamp (future)" and which then out-ranks every later,
      // correct row. Every monthly importer here shares that one function.
      const { start, end, syncedAt } = monthSnapshot(reading.ym, now);
      syncs.push({
        ...base,
        period_start: start,
        period_end: end,
        synced_at: syncedAt,
        data_state: reading.state,
        error_message: null,
        metrics: reading.metrics,
      });
      months++;
      if (reading.state === "live") liveMonths++;
      if (reading.usedAllClicks) allClicksRows++;
      if (reading.conversionsHeldBack) heldBack++;
    }
    planted += months;

    if (months === 0) {
      // The account answered and had nothing in the window. That is a real
      // reading, not an absence, so one no_data row goes in for the current
      // month: without it the connector reads "Not connected" for ever on an
      // account that is simply not running anything at the moment.
      const { start, end, syncedAt } = monthSnapshot(until.slice(0, 7), now);
      syncs.push({ ...base, period_start: start, period_end: end, synced_at: syncedAt, data_state: "no_data", error_message: null, metrics: {} });
      planted++;
    }

    console.log(
      `  ${t.clientName} [${t.accountId}] — ${months} month(s), ${liveMonths} with delivery` +
      `${attribution ? ` · attribution ${attribution}` : ""}`,
    );
    if (allClicksRows) notes.push(`${t.clientName} — ${allClicksRows} month(s) reported no inline_link_clicks, so Clicks (All) stood in; that figure counts reactions and comments as clicks`);
    if (heldBack) notes.push(`${t.clientName} — ${heldBack} month(s) recorded conversions as no data rather than as nought: this account has never reported one in the window, so there is probably no pixel event configured on it`);
    if (unplaceable) notes.push(`${t.clientName} — ${unplaceable} insights row(s) carried no usable date_start and were not planted`);
  }

  console.log(`\nPlanting ${syncs.length} monthly snapshot(s) across ${targets.length} account(s) · ${META_METRIC_KEYS.length} metric keys.`);
  const code = runDashboardSync({ databaseUrl, dashboardDir }, syncs, { dryRun: args.dryRun });

  // Printed AFTER the sync summary, which is one line per entry: anything above
  // it scrolls out of reach in CI, and the actionable part has to be last.
  if (notes.length) {
    console.error(`\n${notes.length} note(s) about what was imported:`);
    for (const n of notes) console.error(`  ${n}`);
  }
  if (failures.length) {
    console.error(`\n${failures.length} Meta ad account(s) could not be read:`);
    for (const f of failures) console.error(`  ${f}`);
    console.error("");
    console.error("A permissions error means the system user behind META_ACCESS_TOKEN has not been");
    console.error("granted that ad account. In Meta Business settings → Users → System users →");
    console.error("Assign assets, add the ad account with the ads_read permission.");
  }

  emitJobSummary(
    `accounts=${targets.length} read=${read} months=${planted} errors=${failures.length}` +
    (failures.length ? ` · ${failures.length} account(s) could not be read` : ` · ${planted} month(s) planted`),
  );

  // A run where EVERY account failed is a failure, not a quiet success across
  // nothing. A run where some worked is a success with named casualties, which
  // is what the error rows and the list above are for.
  if (read === 0) process.exit(1);
  process.exit(code || 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

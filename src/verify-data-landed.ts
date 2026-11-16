#!/usr/bin/env tsx
/**
 * "Did the data land": the reading, the store and the workflow, over INVENTED rows.
 *
 *   1. the catalog: ten sources, one spec each, no stray state
 *   2. the reading: never, stale, ok, not switched on; a failure is never ok; a null is never fresh
 *   3. who is judged: churned and the internal client never; paused still, except for ad accounts
 *   4. the store only READS the source tables and writes one derived table
 *   5. the workflow: scheduled, dry run by default, heartbeat on failure, no secret but the database
 *   6. the real store on a throwaway schema (when ADS_VERIFY_DATABASE_URL is set; CI's ads-store job)
 *
 *   npm run verify-data-landed
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { LANDED_SOURCES, LANDED_STATES, SOURCE_SPECS } from "./data-landed/catalog.js";
import { buildRows, countStates, judge, switchedOn, type ClientFacts, type Landed } from "./data-landed/reading.js";
import { INSERT_LANDED, PRUNE_LANDED, gatherClients, gatherLanded, keyOf, writeRows } from "./data-landed/store.js";

let failures = 0;
const section = (t: string) => console.log(`\n${t}`);
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, "..", p), "utf8");
const NOW = new Date("2026-11-16T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const client = (over: Partial<ClientFacts> = {}): ClientFacts => ({
  clientId: "c1", name: "Riverbend Recovery", status: "active", isInternal: false, seoDomain: "riverbend.example",
  connectors: new Set(["ga4", "gsc"]), activeRankTargets: 3, ...over,
});
const spec = (s: string) => SOURCE_SPECS.find((x) => x.source === s)!;

section("1. The catalog");
ok("every source has exactly one spec", LANDED_SOURCES.length === SOURCE_SPECS.length && LANDED_SOURCES.every((s) => SOURCE_SPECS.filter((x) => x.source === s).length === 1));
ok("the four states are the declared ones", LANDED_STATES.join() === "ok,stale,never,not_applicable");
ok("every window is positive and a daily source is under a week", SOURCE_SPECS.every((s) => s.expectedHours > 0) && spec("ga4").expectedHours <= 72);
ok("ad accounts are read for launch and active clients only", spec("google_ads").readsStatuses?.join() === "launch,active");

section("2. The reading");
const fresh: Landed = { lastRowAt: hoursAgo(10), note: null };
ok("a row inside the window is ok", judge(spec("ga4"), client(), fresh, NOW).state === "ok");
ok("a row past the window is stale, with the days said", (() => { const r = judge(spec("ga4"), client(), { lastRowAt: hoursAgo(24 * 6), note: null }, NOW); return r.state === "stale" && /6 days/.test(r.detail ?? ""); })());
ok("a source switched on with no row ever is never", judge(spec("ga4"), client(), null, NOW).state === "never");
ok("a source switched on whose only rows were errors is never, and says so", (() => { const r = judge(spec("ga4"), client(), { lastRowAt: null, note: "only error or no-data rows have arrived" }, NOW); return r.state === "never" && /error/.test(r.detail ?? ""); })());
ok("a source not switched on is not_applicable and expects nothing", (() => { const r = judge(spec("meta"), client(), null, NOW); return r.state === "not_applicable" && r.expectedHours === null; })());
ok("an unreadable time is unanswered, never fresh", judge(spec("ga4"), client(), { lastRowAt: new Date("not a date"), note: null }, NOW).state === "never");
ok("a time in the future is a clock fault, not freshness", judge(spec("ga4"), client(), { lastRowAt: hoursAgo(-48), note: null }, NOW).state === "stale");
ok("the latest read failing keeps its note on a stale row", /latest read was an error/.test(judge(spec("ga4"), client(), { lastRowAt: hoursAgo(100), note: "the latest read was an error" }, NOW).detail ?? ""));
ok("a weekly source is not stale after three days", judge(spec("rank_checks"), client(), { lastRowAt: hoursAgo(72), note: null }, NOW).state === "ok");
ok("position checks need tracked searches AND a site", !switchedOn(spec("rank_checks"), client({ activeRankTargets: 0 })) && !switchedOn(spec("rank_checks"), client({ seoDomain: " " })) && switchedOn(spec("rank_checks"), client()));
ok("page checks follow the Search Console connector", switchedOn(spec("gsc_inspect"), client()) && !switchedOn(spec("gsc_inspect"), client({ connectors: new Set(["ga4"]) })));
ok("the time on a not-applicable row is kept when something landed once", judge(spec("meta"), client(), fresh, NOW).lastRowAt !== null);

section("3. Who is judged");
const mix = [client({ clientId: "a" }), client({ clientId: "b", status: "churned" }), client({ clientId: "c", status: "paused" }), client({ clientId: "d", isInternal: true }), client({ clientId: "e", status: "Churned " })];
const rows = buildRows(mix, () => fresh, NOW);
const ids = new Set(rows.map((r) => r.clientId));
ok("churned clients are never judged, whatever the spelling", !ids.has("b") && !ids.has("e"));
ok("the internal client is not judged", !ids.has("d"));
ok("a paused client is still judged", ids.has("c"));
ok("every judged client gets one row per source", rows.length === 2 * SOURCE_SPECS.length);
ok("a paused client's ad account is not read, so it is not expected", judge(spec("google_ads"), client({ status: "paused", connectors: new Set(["google_ads"]) }), null, NOW).state === "not_applicable");
ok("a launch client's ad account is expected", judge(spec("google_ads"), client({ status: "launch", connectors: new Set(["google_ads"]) }), null, NOW).state === "never");
ok("the counts add up to the rows", Object.values(countStates(rows)).reduce((a, b) => a + b, 0) === rows.length);

section("4. The store reads the sources and writes one derived table");
const store = read("src/data-landed/store.ts");
const sql = Array.from(store.matchAll(/`((?:INSERT|UPDATE|DELETE)[\s\S]*?)`/g)).map((m) => m[1]!);
ok("the only writes in the store name source_landed", sql.length >= 2 && sql.every((s) => /\bsource_landed\b/.test(s)), `${sql.length} write statement(s)`);
ok("the upsert and the prune are the exported statements", /INSERT INTO source_landed/.test(INSERT_LANDED) && /DELETE FROM source_landed/.test(PRUNE_LANDED));
ok("no source table is written, truncated or altered", !/\b(UPDATE|TRUNCATE|ALTER|DROP)\b\s+(metric_snapshots|ads_daily_scans|seo_rank_history|signal_runs|clients|connector_mappings|seo_targets)/i.test(store));
ok("the job never selects a name, address, figure or caller from a source", !/\b(email|phone|caller|first_name|value_numeric|amount)\b/i.test(store.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "")));
const job = read("src/data-landed.ts");
ok("the job decides who is read through the one rule", /client-scope/.test(job) && /skippedLine\(/.test(job));
ok("a failed read exits non-zero, a missing table is named and left out", /process\.exit\(1\)/.test(job) && /not there yet/.test(job));

section("5. The workflow");
const wf = read(".github/workflows/data-landed.yml");
const code = wf.replace(/^\s*#.*$/gm, "");
ok("scheduled daily", /schedule:\s*\n\s*- cron: "\d+ \d+ \* \* \*"/.test(wf));
ok("dispatch takes client_id and dry_run, dry run defaulting to true", /client_id:/.test(wf) && /dry_run:[\s\S]*?default: "true"/.test(wf));
ok("the heartbeat is recorded even when the job fails", /Heartbeat[\s\S]{0,60}if: always\(\)/.test(wf));
ok("a dry run and a one-client run do not stamp the book-wide heartbeat", /if: always\(\) && inputs\.dry_run != 'true' && inputs\.client_id == ''/.test(wf));
ok("the heartbeat names the job", /--job=data_landed/.test(wf));
ok("the only secret is the database", Array.from(code.matchAll(/secrets\.([A-Z0-9_]+)/g)).every((m) => m[1] === "DATABASE_URL"));
ok("inputs reach the command through the environment", /CLIENT_ID: \$\{\{ inputs\.client_id \}\}/.test(wf) && !/run:[^\n]*\$\{\{ inputs\./.test(code));
ok("CI runs this guard", /npm run verify-data-landed/.test(read(".github/workflows/ci.yml")));

// ── 6. The real store ────────────────────────────────────────────────────────
const dbUrl = process.env.ADS_VERIFY_DATABASE_URL;
if (!dbUrl) {
  section("6. The real store");
  console.log("  ⏭  skipped: ADS_VERIFY_DATABASE_URL is not set. CI runs this section in the `ads-store` job.");
} else {
  await storeSection(dbUrl);
}

async function storeSection(url: string) {
  section("6. The real store, on a throwaway schema");
  const schema = `landed_${Math.random().toString(36).slice(2, 10)}`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await c.query(`
      CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT, is_internal BOOLEAN DEFAULT false, seo_domain TEXT);
      CREATE TABLE connector_mappings (client_id TEXT, source TEXT, enabled BOOLEAN, external_id TEXT);
      CREATE TABLE seo_targets (id TEXT, client_id TEXT, active BOOLEAN);
      CREATE TABLE metric_snapshots (client_id TEXT, source TEXT, data_state TEXT, synced_at TIMESTAMPTZ);
      CREATE TABLE ads_daily_scans (client_id TEXT, platform TEXT, covered_to TEXT, ok BOOLEAN, last_scan_at TIMESTAMPTZ);
      CREATE TABLE seo_rank_history (client_id TEXT, error TEXT, captured_at TIMESTAMPTZ);
      CREATE TABLE signal_runs (client_id TEXT, source TEXT, status TEXT, rows INTEGER, ran_at TIMESTAMPTZ);
      CREATE TABLE source_landed (client_id TEXT NOT NULL, source TEXT NOT NULL, last_row_at TIMESTAMPTZ, expected_hours INTEGER, state TEXT NOT NULL, detail TEXT, checked_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (client_id, source));
    `);
    const day = (h: number) => hoursAgo(h).toISOString();
    await c.query(`INSERT INTO clients VALUES ('a','Alpha','active',false,'alpha.example'),('b','Beta','churned',false,'beta.example'),('i','Own','active',true,null)`);
    await c.query(`INSERT INTO connector_mappings VALUES ('a','ga4',true,'123'),('a','gsc',true,'sc-domain:alpha.example'),('a','meta',true,''),('b','ga4',true,'456'),('a','ctm',true,'9')`);
    await c.query(`INSERT INTO seo_targets VALUES ('t1','a',true),('t2','a',false)`);
    // ga4: a live row 10 hours ago AND a newer error row: the live one is the landed one and the note says the latest read failed.
    await c.query(`INSERT INTO metric_snapshots VALUES ('a','ga4','live',$1),('a','ga4','error',$2),('a','gsc','error',$2),('b','ga4','live',$1)`, [day(10), day(1)]);
    await c.query(`INSERT INTO ads_daily_scans VALUES ('a','google_ads','2026-11-15',false,$1)`, [day(2)]);
    await c.query(`INSERT INTO seo_rank_history VALUES ('a',NULL,$1),('a','provider refused',$2)`, [day(300), day(3)]);
    await c.query(`INSERT INTO signal_runs VALUES ('a','ctm','no_data',0,$1)`, [day(5)]);

    const clients = await gatherClients(c);
    ok("clients are gathered with their switched-on connectors and tracked searches", clients.find((x) => x.clientId === "a")!.connectors.has("ga4") && clients.find((x) => x.clientId === "a")!.activeRankTargets === 1);
    ok("a connector with no account number is not switched on", !clients.find((x) => x.clientId === "a")!.connectors.has("meta"));
    const g = await gatherLanded(c);
    ok("nothing is skipped when every table exists", g.unreadable.length === 0);
    const ga4 = g.landed.get(keyOf("a", "ga4"))!;
    ok("the landed time of a metric is its newest LIVE row", Math.abs(ga4.lastRowAt!.getTime() - hoursAgo(10).getTime()) < 2000);
    ok("a newer error row does not make the source fresh, and is said", /latest read was an error/.test(ga4.note ?? ""));
    ok("a source with only error rows has no landed time", g.landed.get(keyOf("a", "gsc"))!.lastRowAt === null);
    ok("an ad account's landed time is the end of the day the scan covered, and a failed scan is said", /scan failed/.test(g.landed.get(keyOf("a", "google_ads"))!.note ?? "") && g.landed.get(keyOf("a", "google_ads"))!.lastRowAt!.toISOString() === "2026-11-16T00:00:00.000Z");
    ok("a failed position check is not a landed one", Math.abs(g.landed.get(keyOf("a", "rank_checks"))!.lastRowAt!.getTime() - hoursAgo(300).getTime()) < 2000);
    ok("a signal run that wrote no rows has no landed time", g.landed.get(keyOf("a", "ctm"))!.lastRowAt === null && /no_data/.test(g.landed.get(keyOf("a", "ctm"))!.note ?? ""));

    const live = clients.filter((x) => x.status !== "churned" && !x.isInternal);
    const built = buildRows(live, (id, s) => g.landed.get(keyOf(id, s)) ?? null, NOW);
    await c.query(`INSERT INTO source_landed VALUES ('b','ga4',NULL,48,'never','left over from before it churned',now()),('a','gone_source',NULL,1,'ok',NULL,now())`);
    await writeRows(c, built, live.map((x) => x.clientId), LANDED_SOURCES, NOW);
    const out = (await c.query<{ client_id: string; source: string; state: string }>(`SELECT client_id, source, state FROM source_landed`)).rows;
    ok("one row per live client and source is written", out.length === live.length * SOURCE_SPECS.length, `${out.length}`);
    ok("a churned client's old row and a source no longer in the catalog are pruned", !out.some((r) => r.client_id === "b") && !out.some((r) => r.source === "gone_source"));
    const st = (s: string) => out.find((r) => r.client_id === "a" && r.source === s)?.state;
    ok("the states are what the tables say", st("ga4") === "ok" && st("gsc") === "never" && st("ctm") === "never" && st("meta") === "not_applicable" && st("rank_checks") === "stale", `${st("ga4")} ${st("gsc")} ${st("ctm")} ${st("meta")} ${st("rank_checks")}`);
    const before = (await c.query(`SELECT count(*)::int AS n FROM metric_snapshots`)).rows[0]!.n;
    await writeRows(c, built, live.map((x) => x.clientId), LANDED_SOURCES, NOW);
    const n2 = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM source_landed`)).rows[0]!.n;
    ok("a second run is the same run, and no source row was touched", n2 === out.length && before === (await c.query(`SELECT count(*)::int AS n FROM metric_snapshots`)).rows[0]!.n);

    await c.query(`DROP TABLE signal_runs`);
    const g2 = await gatherLanded(c);
    ok("a missing table is named and left out, never read as nothing landed", g2.unreadable.join() === "gsc_inspect,gbp,bing,ctm");
    await c.query(`DROP TABLE source_landed`);
    let failed = false;
    try { await writeRows(c, built, ["a"], LANDED_SOURCES, NOW); } catch { failed = true; }
    ok("a write that fails rolls back and throws", failed);
  } finally {
    await c.query(`SET search_path TO public`).catch(() => {});
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);

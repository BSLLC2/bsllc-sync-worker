#!/usr/bin/env tsx
/**
 * Traffic acquisition over the last 28 complete days against the 28 before: the rules, against a pretend Google.
 *
 *   1. the windows: complete days, the 28 before them, both written on every row
 *   2. the request: channel and source/medium, the typed exclusions, no channel exclusion on the channel list
 *   3. the parse: counts only, a metric the property rejected is a NULL column, a repeated key is summed
 *   4. a kind is read in full for BOTH windows or not at all; a kind that fails keeps its earlier rows
 *   5. no secret in anything said
 *   6. it only reads (POST to runReport only), and the monthly reader's tables are never named
 *   7. the store, on a throwaway schema (when ADS_VERIFY_DATABASE_URL is set)
 *
 *   npm run verify-ga4-acquisition
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sanitiseConfig } from "./ga4-report/config.js";
import type { Io } from "./ga4-report/ga4.js";
import {
  ACQUISITION_KINDS, ACQUISITION_LADDER, acquisitionRequest, acquisitionWindows, parseAcquisition, readClientAcquisition, topRows,
} from "./ga4-report/acquisition.js";
import { INSERT_ACQ_ROW, INSERT_ACQ_RUN, INSERT_ACQ_RUN_KEEP, processAcquisition, writeClientAcquisition } from "./ga4-report/acquisition-store.js";
import type { FetchLike } from "./ga4-report/types.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const planted = (label: string, predicate: () => boolean) => {
  const caught = !predicate();
  console.log(`  ${caught ? "🧪" : "❌"} planted failure: ${label}${caught ? " — caught" : " — NOT CAUGHT"}`);
  if (!caught) failures++;
};
const section = (s: string) => console.log(`\n${s}`);
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");
const codeOnly = (src: string) => src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

console.log("GA4 acquisition, 28 days against the 28 before. A pretend Google; every figure invented.\n");

const TODAY = "2026-11-16";
const SECRET = "TOKEN-SECRET-77aa";
const noSleep = async () => {};

// ── 1. The windows ───────────────────────────────────────────────────────────
section("1. The windows");
const w = acquisitionWindows(TODAY);
ok("the current window is the 28 complete days ending two days back", w.current.end === "2026-11-14" && w.current.start === "2026-10-18");
ok("the window before is the 28 days ahead of it, with no gap and no overlap", w.prior.end === "2026-10-17" && w.prior.start === "2026-09-20");
ok("the month in progress is not what these windows are made of", w.current.end < TODAY);

// ── 2. The request ───────────────────────────────────────────────────────────
section("2. The request");
const reqCh = acquisitionRequest(w.current, "channel", ["sessions"], ["Singapore"], ["Direct"], ["a.example"]) as any;
const reqSm = acquisitionRequest(w.current, "source_medium", ["sessions"], ["Singapore"], ["Direct"], ["a.example"]) as any;
const flat = (f: unknown) => JSON.stringify(f ?? {});
ok("a channel list asks for the channel group, one date range", reqCh.dimensions[0].name === "sessionDefaultChannelGroup" && reqCh.dateRanges.length === 1);
ok("a source list asks for source and medium", reqSm.dimensions[0].name === "sessionSourceMedium");
ok("the typed country and hostname exclusions are on both", /Singapore/.test(flat(reqCh.dimensionFilter)) && /Singapore/.test(flat(reqSm.dimensionFilter)) && /a\.example/.test(flat(reqCh.dimensionFilter)));
ok("a typed channel exclusion is applied to the source list and NOT to the channel list", !/Direct/.test(flat(reqCh.dimensionFilter)) && /Direct/.test(flat(reqSm.dimensionFilter)));
planted("the channel list also leaves a channel out", () => !/Direct/.test(flat(acquisitionRequest(w.current, "source_medium", ["sessions"], [], ["Direct"], []).dimensionFilter)));
ok("it is ordered by sessions, busiest first", reqCh.orderBys[0].metric.metricName === "sessions" && reqCh.orderBys[0].desc === true);
ok("the ladder ends at sessions alone and starts at key events", ACQUISITION_LADDER[0]!.includes("keyEvents") && JSON.stringify(ACQUISITION_LADDER[ACQUISITION_LADDER.length - 1]) === JSON.stringify(["sessions"]));

// ── 3. The parse ─────────────────────────────────────────────────────────────
section("3. The parse");
const report = (names: string[], rows: Array<[string, ...number[]]>) => ({
  metricHeaders: names.map((name) => ({ name })),
  rows: rows.map(([k, ...ms]) => ({ dimensionValues: [{ value: k }], metricValues: ms.map((v) => ({ value: String(v) })) })),
});
const parsed = parseAcquisition(report(["sessions", "engagedSessions", "keyEvents"], [["Organic Search", 100, 70, 6], ["Direct", 40, 20, 1], ["Organic Search", 5, 3, 0]]), "channel", "current", w.current);
const org = parsed.find((r) => r.key === "Organic Search")!;
ok("a repeated key is summed and every row carries its own window", org.sessions === 105 && org.keyEvents === 6 && org.windowStart === w.current.start && org.windowEnd === w.current.end && parsed.length === 2);
const noKey = parseAcquisition(report(["sessions", "engagedSessions"], [["Direct", 40, 20]]), "channel", "before", w.prior)[0]!;
ok("a metric the report did not carry is NULL, never 0", noKey.keyEvents === null && noKey.sessions === 40);
ok("an empty key reads as (not set)", parseAcquisition(report(["sessions"], [["", 3]]), "source_medium", "current", w.current)[0]!.key === "(not set)");
const cut = topRows(Array.from({ length: 50 }, (_, i) => ({ kind: "channel" as const, period: "current" as const, windowStart: "a", windowEnd: "b", key: `k${i}`, sessions: i, engagedSessions: 1, keyEvents: null })), 40);
ok("the busiest rows are kept and the cut is said", cut.kept.length === 40 && cut.cut && cut.kept[0]!.key === "k49");
planted("a missing metric stored as 0", () => noKey.keyEvents === 0);

// ── 4. Read in full for both windows, or not at all ──────────────────────────
section("4. Both windows, in full");
interface Spec { rejectKeyEvents?: boolean; failKind?: "channel" | "source_medium"; failWindow?: "before"; endless?: boolean; status429Once?: boolean }
function pretend(spec: Spec = {}): { fetch: FetchLike; bodies: any[]; urls: string[]; methods: string[] } {
  const bodies: any[] = [], urls: string[] = [], methods: string[] = [];
  let tripped = false;
  const f: FetchLike = async (url, init) => {
    const b = JSON.parse(init?.body ?? "{}");
    bodies.push(b); urls.push(url); methods.push(init?.method ?? "GET");
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
    const dim = b.dimensions[0].name as string;
    const metrics = (b.metrics as Array<{ name: string }>).map((m) => m.name);
    if (spec.status429Once && !tripped) { tripped = true; return reply(429, { error: { message: "slow down" } }); }
    if (spec.rejectKeyEvents && (metrics.includes("keyEvents") || metrics.includes("conversions"))) return reply(400, { error: { message: "no such metric" } });
    const kind = dim === "sessionDefaultChannelGroup" ? "channel" : "source_medium";
    if (spec.failKind === kind) return reply(500, { error: { message: `server error carrying ${SECRET}` } });
    const isBefore = b.dateRanges[0].startDate === w.prior.start;
    if (spec.failWindow === "before" && isBefore) return reply(500, { error: { message: "down" } });
    if (spec.endless) {
      const rows = Array.from({ length: 25_000 }, (_, i) => ({ dimensionValues: [{ value: `k${b.offset}-${i}` }], metricValues: metrics.map(() => ({ value: "1" })) }));
      return reply(200, { metricHeaders: metrics.map((name) => ({ name })), rows, rowCount: 10_000_000 });
    }
    const keys = kind === "channel" ? ["Organic Search", "Direct", "Paid Social"] : ["google / organic", "(direct) / (none)", "fb / paid_social"];
    const scale = isBefore ? 1 : 2;
    return reply(200, {
      metricHeaders: metrics.map((name) => ({ name })),
      rows: keys.map((k, i) => ({ dimensionValues: [{ value: k }], metricValues: metrics.map((m) => ({ value: String(m === "sessions" ? (100 - i * 30) * scale : m === "engagedSessions" ? (60 - i * 20) * scale : 2 * scale) })) })),
      rowCount: keys.length,
    });
  };
  return { fetch: f, bodies, urls, methods };
}
const mkIo = (f: FetchLike): Io => ({ fetch: f, token: SECRET, property: "111", sleep: noSleep, pauseMs: 0, calls: 0 });
const cfg = sanitiseConfig(JSON.stringify({ excludeCountries: ["Singapore"] }));

const good = pretend();
const r = await readClientAcquisition("111", cfg, mkIo(good.fetch), { today: TODAY });
ok("a normal run reads both kinds for both windows and writes both", r.status === "ok" && r.failedKinds.length === 0 && ACQUISITION_KINDS.every((k) => r.kinds[k]!.length === 6));
ok("each row says which window it is", r.kinds.channel!.filter((x) => x.period === "current").every((x) => x.windowStart === w.current.start) && r.kinds.channel!.filter((x) => x.period === "before").every((x) => x.windowEnd === w.prior.end));
ok("four reads in all: two kinds, two windows", good.bodies.length === 4);
ok("it only POSTs the report call and nothing else", good.methods.every((m) => m === "POST") && good.urls.every((u) => /:runReport$/.test(u)));
const ladderR = pretend({ rejectKeyEvents: true });
const lr = await readClientAcquisition("111", cfg, mkIo(ladderR.fetch), { today: TODAY });
ok("a property that rejects key events falls to sessions and engaged sessions, key events NULL", lr.status === "ok" && lr.kinds.channel!.every((x) => x.keyEvents === null && x.sessions != null));
ok("the same metric rung is used for both windows of a kind", (() => { const per = new Map<string, string>(); for (const b of ladderR.bodies.slice(-4)) per.set(b.dateRanges[0].startDate + b.dimensions[0].name, b.metrics.map((m: any) => m.name).join()); return new Set(Array.from(per.values())).size <= 2; })());
const oneFails = await readClientAcquisition("111", cfg, mkIo(pretend({ failKind: "source_medium" }).fetch), { today: TODAY });
ok("a kind that fails is named and writes nothing, the other is kept", oneFails.status === "ok" && oneFails.failedKinds.join() === "source_medium" && oneFails.kinds.source_medium === undefined && oneFails.kinds.channel!.length === 6);
const halfWindow = await readClientAcquisition("111", cfg, mkIo(pretend({ failWindow: "before" }).fetch), { today: TODAY });
ok("a window that cannot be read fails the whole kind, never half a comparison", halfWindow.status === "error" && halfWindow.failedKinds.length === 2 && Object.keys(halfWindow.kinds).length === 0);
planted("half a comparison kept", () => Object.keys(halfWindow.kinds).length > 0);
const tooBig = await readClientAcquisition("111", cfg, mkIo(pretend({ endless: true }).fetch), { today: TODAY });
ok("a report past the ceiling is a failed kind, not a cut list", tooBig.status === "error" && tooBig.rows === 0);
const retried = await readClientAcquisition("111", cfg, mkIo(pretend({ status429Once: true }).fetch), { today: TODAY });
ok("a 429 is retried", retried.status === "ok");
const none = await readClientAcquisition(null, cfg, null, { today: TODAY });
ok("no property is `off`, not an error", none.status === "off" && none.rows === 0);
const noTok = await readClientAcquisition("111", cfg, null, { today: TODAY }, "no token");
ok("a token failure is an error that says so", noTok.status === "error" && /no token/.test(noTok.detail ?? ""));
const empty = await readClientAcquisition("111", cfg, mkIo((async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ metricHeaders: [{ name: "sessions" }], rows: [] }) })) as FetchLike), { today: TODAY });
ok("a property with no visits in either window is no_data", empty.status === "no_data" && empty.rows === 0);

// ── 5. No secret ─────────────────────────────────────────────────────────────
section("5. No secret in anything said");
ok("a Google error that echoes the token is scrubbed in the detail", !(oneFails.detail ?? "").includes(SECRET) && /\[secret\]/.test(oneFails.detail ?? ""), oneFails.detail ?? "");
planted("an unscrubbed error", () => !(`server error carrying ${SECRET}`).includes(SECRET));

// ── 6. It only reads, and leaves the monthly report alone ────────────────────
section("6. It only reads, and leaves the monthly report alone");
for (const f of ["ga4-report/acquisition.ts", "ga4-report/acquisition-store.ts"]) {
  const code = codeOnly(read(f));
  ok(`${f} never names the monthly report's tables`, !/ga4_report_rows|ga4_report_runs|ga4_site_days/.test(code));
  ok(`${f} holds no secret name and no fetch of its own`, !/GOOGLE_SERVICE_ACCOUNT|process\.env|\bfetch\(/.test(code));
}
const storeSrc = codeOnly(read("ga4-report/acquisition-store.ts"));
ok("the only tables it writes are its own two", Array.from(storeSrc.matchAll(/(?:INSERT INTO|DELETE FROM|UPDATE)\s+([a-z0-9_]+)/g)).every((m) => /^ga4_acquisition_(windows|runs)$/.test(m[1]!)));
ok("every key a stored row is unique on is in the INSERT's conflict target", /ON CONFLICT \(client_id, kind, period, key\)/.test(INSERT_ACQ_ROW) && /ON CONFLICT \(client_id\)/.test(INSERT_ACQ_RUN) && /ON CONFLICT \(client_id\)/.test(INSERT_ACQ_RUN_KEEP));
ok("a run that wrote nothing keeps the windows an earlier run applied", !/current_start = EXCLUDED/.test(INSERT_ACQ_RUN_KEEP));
const job = codeOnly(read("read-ga4-report.ts"));
ok("a missing acquisition table skips that half and never costs the monthly report", /ga4_acquisition_windows/.test(job) && /acqSkipped/.test(job));

// ── 7. The store ─────────────────────────────────────────────────────────────
section("7. The store");
const dbUrl = process.env.ADS_VERIFY_DATABASE_URL;
if (!dbUrl) console.log("  (skipped: set ADS_VERIFY_DATABASE_URL to run this against a throwaway Postgres)");
else {
  const schema = `acq_verify_${Date.now()}`;
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await c.query(`
      CREATE TABLE ga4_acquisition_windows (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
        key TEXT NOT NULL, sessions INTEGER, engaged_sessions INTEGER, key_events DOUBLE PRECISION, synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX uq_acq ON ga4_acquisition_windows (client_id, kind, period, key);
      CREATE TABLE ga4_acquisition_runs (id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, detail TEXT, current_start TEXT, current_end TEXT, before_start TEXT, before_end TEXT,
        rows INTEGER NOT NULL DEFAULT 0, capped_kinds TEXT, failed_kinds TEXT, excluded_countries TEXT, excluded_channels TEXT, own_hostnames TEXT, ran_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    const now = new Date("2026-11-16T09:00:00Z");
    const first = await readClientAcquisition("111", cfg, mkIo(pretend().fetch), { today: TODAY });
    const wr = await writeClientAcquisition(c, "CL", first, now);
    ok("a good result is written", wr.ok);
    let n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ga4_acquisition_windows`)).rows[0]!.n;
    ok("twelve rows: two kinds, two windows, three keys", n === "12");
    const sample = (await c.query<{ window_start: string; window_end: string; sessions: number }>(`SELECT window_start, window_end, sessions FROM ga4_acquisition_windows WHERE kind='channel' AND period='current' AND key='Organic Search'`)).rows[0]!;
    ok("each stored row carries its window dates", sample.window_start === w.current.start && sample.window_end === w.current.end && sample.sessions === 200);
    await writeClientAcquisition(c, "CL", await readClientAcquisition("111", cfg, mkIo(pretend().fetch), { today: TODAY }), now);
    n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ga4_acquisition_windows`)).rows[0]!.n;
    ok("a second run replaces and writes no extra rows", n === "12");
    // A kind that failed keeps its earlier rows.
    const part = await readClientAcquisition("111", cfg, mkIo(pretend({ failKind: "source_medium" }).fetch), { today: "2026-11-23" });
    await writeClientAcquisition(c, "CL", part, new Date("2026-11-23T09:00:00Z"));
    const sm = (await c.query<{ window_end: string }>(`SELECT DISTINCT window_end FROM ga4_acquisition_windows WHERE kind='source_medium' AND period='current'`)).rows;
    const ch = (await c.query<{ window_end: string }>(`SELECT DISTINCT window_end FROM ga4_acquisition_windows WHERE kind='channel' AND period='current'`)).rows;
    ok("the failed kind keeps its earlier window and the other moves forward", sm.length === 1 && sm[0]!.window_end === w.current.end && ch.length === 1 && ch[0]!.window_end === "2026-11-21");
    const run = (await c.query<{ status: string; failed_kinds: string; current_end: string }>(`SELECT status, failed_kinds, current_end FROM ga4_acquisition_runs WHERE client_id='CL'`)).rows[0]!;
    ok("the run row names the failed kind", run.failed_kinds === "source_medium" && run.status === "ok");
    // An error run changes no rows and keeps the earlier windows on the run row.
    const before = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ga4_acquisition_windows`)).rows[0]!.n;
    await writeClientAcquisition(c, "CL", await readClientAcquisition("111", cfg, null, { today: "2026-11-30" }, "no token"), new Date("2026-11-30T09:00:00Z"));
    const after = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ga4_acquisition_windows`)).rows[0]!.n;
    const run2 = (await c.query<{ status: string; current_end: string }>(`SELECT status, current_end FROM ga4_acquisition_runs WHERE client_id='CL'`)).rows[0]!;
    ok("an error run touches no rows and keeps the windows the rows describe", before === after && run2.status === "error" && run2.current_end === run.current_end);
    // The pipeline: a dry run makes no write at all.
    const writes: string[] = [];
    const recorder = { query: async (sql: string) => { writes.push(sql); return {}; } };
    const piped = await processAcquisition({ clients: [{ id: "CL2", name: "Dry Co", property: "111" }], settings: new Map(), fetch: pretend().fetch, token: async () => SECRET, today: TODAY, db: recorder, dryRun: true, sleep: noSleep, pauseMs: 0 });
    ok("a dry run reads, prints and writes nothing", writes.length === 0 && piped.lines.length === 1 && piped.answered === 1);
    const piped2 = await processAcquisition({ clients: [{ id: "CL3", name: "Live Co", property: "111" }, { id: "CL4", name: "No Prop", property: null }], settings: new Map(), fetch: pretend().fetch, token: async () => SECRET, today: TODAY, db: c, dryRun: false, sleep: noSleep, pauseMs: 0 });
    ok("a client with no property is `off` and the rest are still read", piped2.attempted === 1 && piped2.answered === 1);
    const off = (await c.query<{ status: string }>(`SELECT status FROM ga4_acquisition_runs WHERE client_id='CL4'`)).rows[0]!;
    ok("the client with no property still gets a run row that says off", off.status === "off");
    // A write that fails halfway rolls back whole and says error.
    const bad = { ...first, kinds: { channel: [{ ...first.kinds.channel![0]!, key: null as unknown as string }] } };
    const failed = await writeClientAcquisition(c, "CL5", bad, now);
    const leftover = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ga4_acquisition_windows WHERE client_id='CL5'`)).rows[0]!.n;
    const errRow = (await c.query<{ status: string }>(`SELECT status FROM ga4_acquisition_runs WHERE client_id='CL5'`)).rows[0];
    ok("a write that fails rolls back whole and records an error, never ok", !failed.ok && leftover === "0" && errRow?.status === "error");
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
}

console.log("\n" + "─".repeat(72));
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");

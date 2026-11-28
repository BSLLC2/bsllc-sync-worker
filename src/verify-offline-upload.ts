import { readFileSync, readdirSync, statSync } from "node:fs";
import {
  judgeWin, parseAllowList, parseValueSetting, planUpload, sentKey, GOOGLE_CLICK_WINDOW_DAYS,
  type Win,
} from "./ads/offline-upload.js";
import { runClient, type Db } from "./ads/offline-upload-run.js";
import { actionFault, validationAllows, scrub, type DmAnswer } from "./ads/data-manager.js";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { if (ok) pass++; else { fail++; console.log(`  FAIL  ${n}${d ? ` (${d})` : ""}`); } };
const TODAY = "2026-11-16";
const G = (n: number) => `CLICKID_${String(n).padStart(8, "0")}`;
const win = (o: Partial<Win> = {}): Win => ({ row: 1, closed: "2026-11-10", cents: 500000, gclid: G(1), clickOn: "2026-10-20", ...o });
const none = new Set<string>();

console.log("1. the allow-list");
check("blank allows nobody", Object.keys(parseAllowList("").list).length === 0 && parseAllowList("").fault === null);
check("bad JSON allows nobody and says so", Object.keys(parseAllowList("{x").list).length === 0 && !!parseAllowList("{x").fault);
check("an entry with no action allows nobody", Object.keys(parseAllowList('{"acme":{}}').list).length === 0 && !!parseAllowList('{"acme":{}}').fault);
check("an array allows nobody", !!parseAllowList("[1]").fault);
check("a good entry is read", parseAllowList('{"acme-co":{"action":"Closed sale (offline)"}}').list["acme-co"]?.action === "Closed sale (offline)");
check("one bad entry spoils the whole list", Object.keys(parseAllowList('{"acme-co":{"action":"Closed sale"},"B":{"action":"x"}}').list).length === 0);

console.log("2. which wins are ready");
check("an ordinary win is ready", judgeWin(win(), TODAY, none) === "ready");
check(`exactly ${GOOGLE_CLICK_WINDOW_DAYS} days after the click is ready`, judgeWin(win({ clickOn: "2026-08-12", closed: "2026-11-10" }), TODAY, none) === "ready");
check("91 days is too late", judgeWin(win({ clickOn: "2026-08-11", closed: "2026-11-10" }), TODAY, none) === "too_late");
check("closed before the click is refused", judgeWin(win({ clickOn: "2026-11-11" }), TODAY, none) === "before_click");
check("closed today waits", judgeWin(win({ closed: TODAY }), TODAY, none) === "future_or_today");
check("closed in the future waits", judgeWin(win({ closed: "2026-12-01" }), TODAY, none) === "future_or_today");
check("no click id", judgeWin(win({ gclid: null }), TODAY, none) === "no_click_id");
check("a click id with a space is refused", judgeWin(win({ gclid: "abc def ghi jkl" }), TODAY, none) === "bad_click_id");
check("no click date is refused, never guessed", judgeWin(win({ clickOn: null }), TODAY, none) === "no_click_date");
check("an impossible date is refused", judgeWin(win({ closed: "2026-02-31" }), TODAY, none) === "no_date");
check("already sent is skipped", judgeWin(win(), TODAY, new Set([sentKey(G(1), "2026-11-10")])) === "already_sent");

console.log("3. what each is worth");
const sheetWins = [win({ row: 1, gclid: G(1), cents: 250000 }), win({ row: 2, gclid: G(2), cents: 180000000 }), win({ row: 3, gclid: G(3), cents: 0 })];
const capped = planUpload(sheetWins, TODAY, none, { mode: "capped", capCents: 2500000 });
check("capped: nothing above the ceiling is sent", capped.rows.every((r) => (r.valueCents ?? 0) <= 2500000) && capped.rows[1]!.valueCents === 2500000 && capped.counts.cut === 1);
check("a sale recorded at nought carries no value", capped.rows[2]!.valueCents === null);
check("count only carries no value at all", planUpload(sheetWins, TODAY, none, { mode: "count", capCents: null }).rows.every((r) => r.valueCents === null));
check("amount mode keeps the recorded amount", planUpload(sheetWins, TODAY, none, { mode: "amount", capCents: null }).rows[1]!.valueCents === 180000000);
const nocap = planUpload(sheetWins, TODAY, none, { mode: "capped", capCents: null });
check("a ceiling mode with no ceiling sends nothing and says so", !nocap.ok && nocap.rows.length === 0 && /ceiling/.test(nocap.refusal ?? ""));
check("no setting at all defaults to capped with no ceiling (a stop)", parseValueSetting(null).mode === "capped" && parseValueSetting(null).capCents === null);
check("a typo ceiling above the maximum is no ceiling", parseValueSetting('{"mode":"capped","capCents":999999999999}').capCents === null);
check("a click id twice on one day is sent once", planUpload([win({ row: 1 }), win({ row: 2 })], TODAY, none, { mode: "count", capCents: null }).rows.length === 1);

console.log("4. the conversion action");
const good = { type: 7, status: 2, primary_for_goal: false };
check("a secondary enabled upload action is allowed", actionFault(good, "A") === null);
check("string enums are read too", actionFault({ type: "UPLOAD_CLICKS", status: "ENABLED", primary_for_goal: false }, "A") === null);
check("a missing action is a stop that says it is never created", /never creates/.test(actionFault(null, "A") ?? ""));
check("a PRIMARY action is refused", /secondary/.test(actionFault({ ...good, primary_for_goal: true }, "A") ?? ""));
check("an action that does not say is refused", actionFault({ type: 7, status: 2 }, "A") !== null);
check("another type is refused", actionFault({ ...good, type: 3 }, "A") !== null);
check("a paused action is refused", actionFault({ ...good, status: 3 }, "A") !== null);

console.log("5. validation first");
const now = new Date("2026-11-16T12:00:00Z");
check("a pass yesterday allows sending", validationAllows("2026-11-15T12:00:00Z", now));
check("a pass 15 days ago does not", !validationAllows("2026-10-31T12:00:00Z", now));
check("no pass does not", !validationAllows(null, now));
check("a pass dated in the future does not", !validationAllows("2026-11-20T00:00:00Z", now));

console.log("6. a run, against a pretend database and a pretend Google");
function fake(opts: { primary?: boolean | undefined; accounts?: number; summary?: boolean; failAll?: boolean; failedRows?: number; sent?: boolean; inquiry?: boolean } = {}) {
  const store: Record<string, string> = { "offline_value:c1": JSON.stringify({ mode: "capped", capCents: 2500000 }) };
  const recorded: unknown[][] = []; const bodies: any[] = []; const queries: { sql: string; p: unknown[] }[] = [];
  const summary = JSON.stringify({ counted: [
    { row: 1, closed: "2026-11-10", cents: 180000000, gclid: G(1), clickOn: "2026-10-20" },
    { row: 2, closed: "2026-11-09", cents: 400000, gclid: G(2), clickOn: "2026-10-21" },
    { row: 3, closed: "2026-11-09", cents: 400000, gclid: null, clickOn: null },
  ] });
  const db: Db = { async query(sql, p = []) {
    queries.push({ sql, p });
    if (/FROM clients$|SELECT id, name FROM clients/.test(sql)) return { rows: [{ id: "c1", name: "Acme Co" }] };
    if (/tracker_feed_summary/.test(sql)) return { rows: opts.summary === false ? [] : [{ value_text: summary }] };
    if (/FROM web_inquiries/.test(sql)) return { rows: opts.inquiry === false ? [] : [{ gclid: G(1), phone: "(614) 555-0142", email: "Planted.Person@Example.com" }] };
    if (/FROM offline_conversion_uploads/.test(sql)) return { rows: opts.sent ? [{ gclid: G(1), admission_date: "2026-11-10" }] : [] };
    if (/FROM app_settings/.test(sql)) { const v = store[String(p[0])]; return { rows: v ? [{ value: v }] : [] }; }
    if (/INSERT INTO app_settings/.test(sql)) { store[String(p[0])] = String(p[1]); return { rows: [] }; }
    if (/INSERT INTO offline_conversion_uploads/.test(sql)) { recorded.push(p); return { rows: [] }; }
    if (/connector_mappings/.test(sql)) return { rows: Array.from({ length: opts.accounts ?? 1 }, () => ({ external_id: "123-456-7890" })) };
    throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
  } };
  const customer = { async query() { return [{ conversion_action: { resource_name: "customers/1/conversionActions/9", id: 9, type: 7, status: 2, primary_for_goal: "primary" in opts ? opts.primary : false } }]; } };
  const dm = {
    async token() { return "tok"; },
    async ingest(_t: string, body: Record<string, unknown>): Promise<DmAnswer> {
      bodies.push(body);
      return opts.failAll ? { ok: false, status: 400, requestId: null, reason: "INVALID_ARGUMENT", scopeProblem: false, closedApi: false } : { ok: true, status: 200, requestId: "req1", reason: null, scopeProblem: false, closedApi: false };
    },
    async requestStatus() { return { received: 2, failed: opts.failedRows ?? 0 }; },
  };
  const lines: string[] = [];
  let opened = 0;
  const deps = { db, today: TODAY, now, env: { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "2141712409" } as Record<string, string | undefined>, log: (l: string) => lines.push(l), openCustomer: async () => { opened++; return customer as any; }, dm };
  return { deps, store, recorded, bodies, queries, lines, opened: () => opened };
}
const entry = { action: "Closed sale (offline)" };

let f = fake();
let o = await runClient("acme-co", entry, "dry", f.deps);
check("dry: nothing sent, recorded or opened", f.bodies.length === 0 && f.recorded.length === 0 && f.opened() === 0 && o.status === "dry" && o.ready === 2);
check("dry: the counts are printed", f.lines.some((l) => /wins 3: ready 2/.test(l)));
check("dry: no click id appears anywhere in the output", !f.lines.join("\n").includes("CLICKID"));

f = fake(); o = await runClient("acme-co", entry, "send", f.deps);
check("send without a validate pass stops before Google is opened", o.status === "stopped" && /validate/.test(o.stop ?? "") && f.opened() === 0 && f.bodies.length === 0);

f = fake(); o = await runClient("acme-co", entry, "validate", f.deps);
check("validate: one Data Manager request, validateOnly true, nothing recorded", f.bodies.length === 1 && f.bodies[0].validateOnly === true && f.recorded.length === 0 && o.status === "validated");
check("validate: the pass is remembered under dm_validated", !!f.store["dm_validated:acme-co"] && validationAllows(f.store["dm_validated:acme-co"], now));
check("validate: the large sale is cut to the ceiling in the request", f.bodies[0].events[0].conversionValue === 25000 && f.bodies[0].events[1].conversionValue === 4000);
check("validate: the event has the click id, the closed day in Eastern and a transaction id", f.bodies[0].events[0].adIdentifiers.gclid === G(1) && f.bodies[0].events[0].eventTimestamp === "2026-11-10T23:59:59-05:00" && /^sheet-/.test(f.bodies[0].events[0].transactionId));
check("validate: the destination is the secondary action's id and the login account", f.bodies[0].destinations[0].productDestinationId === "9" && f.bodies[0].destinations[0].loginAccount.accountId === "2141712409");
check("validate: the inquiry with the same click id carries a phone and an email hash, the other sale none", f.bodies[0].events[0].userData?.userIdentifiers?.length === 2 && f.bodies[0].events[1].userData === undefined && f.bodies[0].encoding === "HEX");
check("validate: the identifier record holds counts and Google's answer", (() => { const r = JSON.parse(f.store["enhanced_identifiers:acme-co"] ?? "{}"); return r.api === "validate" && r.withPhone === 1 && r.withEmail === 1 && r.rows === 2 && r.accepted === 2 && r.refused === 0 && r.included === true; })());
check("validate: no raw phone, email, hash or click id in the output or the record", (() => { const all = f.lines.join("\n") + (f.store["enhanced_identifiers:acme-co"] ?? ""); return !/CLICKID|planted|555|@/i.test(all) && !/[0-9a-f]{64}/.test(all); })());
check("no web_inquiries lookup names a person, only the click ids", f.queries.filter((q) => /web_inquiries/.test(q.sql)).every((q) => q.p.length === 2 && q.p[0] === "acme-co"));

f = fake({ inquiry: false }); await runClient("acme-co", entry, "validate", f.deps);
check("no inquiry row: no identifier, the sale still goes by click id", f.bodies[0].events.length === 2 && f.bodies[0].events.every((e: any) => e.userData === undefined) && f.bodies[0].encoding === undefined);

f = fake(); await runClient("acme-co", entry, "validate", f.deps);
const store2 = f.store;
const g = fake({ failedRows: 1 }); Object.assign(g.store, store2);
o = await runClient("acme-co", entry, "send", g.deps);
check("send after a pass: validateOnly false and accepted rows are recorded", g.bodies.length === 1 && g.bodies[0].validateOnly === false && g.recorded.length === 2 && o.status === "sent" && o.accepted === 1 && o.rejected === 1);
check("send: the recorded row carries the secondary action and the closed day", g.recorded[0]![3] === "customers/1/conversionActions/9" && g.recorded[0]![4] === "2026-11-10");
check("send: the identifier record is written with the send answer", JSON.parse(g.store["enhanced_identifiers:acme-co"]!).api === "send");
check("send: no click id in the output", !g.lines.join("\n").includes("CLICKID"));
check("send: an already-sent win is not sent again", await (async () => { const h = fake({ sent: true }); Object.assign(h.store, store2); await runClient("acme-co", entry, "send", h.deps); return h.bodies[0].events.length === 1; })());
const h2 = fake({ failAll: true }); Object.assign(h2.store, store2);
o = await runClient("acme-co", entry, "send", h2.deps);
check("a send where Google accepts nothing is a stop (the job exits 1) and records nothing", o.status === "stopped" && h2.recorded.length === 0);
f = fake({ failAll: true }); o = await runClient("acme-co", entry, "validate", f.deps);
check("a refused validate does not authorise a send", !f.store["dm_validated:acme-co"]);

f = fake({ primary: true }); o = await runClient("acme-co", entry, "validate", f.deps);
check("a primary action stops the run before anything is sent", o.status === "stopped" && f.bodies.length === 0);
f = fake({ primary: undefined }); o = await runClient("acme-co", entry, "validate", f.deps);
check("an action that does not say stops the run", o.status === "stopped" && f.bodies.length === 0);
f = fake({ accounts: 2 }); o = await runClient("acme-co", entry, "validate", f.deps);
check("two ad accounts stops the run", o.status === "stopped" && f.bodies.length === 0);
f = fake({ summary: false }); o = await runClient("acme-co", entry, "dry", f.deps);
check("an unread sheet stops the run", o.status === "stopped");
f = fake(); f.store["offline_value:c1"] = JSON.stringify({ mode: "capped" }); o = await runClient("acme-co", entry, "validate", f.deps);
check("no ceiling stops the run", o.status === "stopped" && /ceiling/.test(o.stop ?? "") && f.bodies.length === 0);
f = fake(); o = await runClient("franklin-brazing", entry, "dry", f.deps);
check("a slug that is not a client stops", o.status === "stopped");

console.log("7. the files themselves");
const run = readFileSync(new URL("./ads/offline-upload-run.ts", import.meta.url), "utf8");
const job = readFileSync(new URL("./upload-offline-conversions.ts", import.meta.url), "utf8");
const wf = readFileSync(new URL("../.github/workflows/upload-offline-conversions.yml", import.meta.url), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
check("never creates or changes a conversion action", !/conversionActions\.(create|update)|ConversionAction\s*\(/.test(code(run) + code(job)));
check("never reads the client's customer value", !/customer_value_cents|customerValue/.test(code(run) + code(job)));
check("never prints a click id", !/console\.(log|warn|error)\([^)]*gclid/.test(code(run) + code(job)));
check("the workflow is dispatch only", /workflow_dispatch/.test(wf) && !/^\s*schedule:/m.test(wf));
check("the workflow defaults to a dry run", /default: "dry"/.test(wf) && /\$\{IN_MODE:-dry\}/.test(wf));
check("the heartbeat is always() and skips dry and one-client runs", /if: always\(\) && inputs\.mode != 'dry'[^\n]*inputs\.client == ''/.test(wf));
check("the allow-list is read from one variable", /vars\.OFFLINE_UPLOAD_CLIENTS/.test(wf) && /process\.env\.OFFLINE_UPLOAD_CLIENTS/.test(job));
check("the refusal for a client off the list is live and exits", /if \(only && !list\[only\]\) \{[\s\S]{0,160}?process\.exit\(1\)/.test(job));
check("a client off the list is refused before any read", job.indexOf("is not on the allow-list") < job.indexOf("new pg.Client"));
check("scrub removes tokens and addresses", !/CLICKID|@/.test(scrub("bad CLICKID_00000001ABCDEFGHIJKLMN at a@b.co")));
check("the workflow passes the Data Manager refresh token", /DATA_MANAGER_REFRESH_TOKEN: \$\{\{ secrets\.DATA_MANAGER_REFRESH_TOKEN \}\}/.test(wf));

console.log("8. the old upload method is gone; every request goes through data-manager.ts");
const OLD = ["upload", "Click", "Conversions"].join(""); // built so this file does not name it
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = `${dir}/${n}`; return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
const srcDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const named = walk(srcDir).filter((p) => readFileSync(p, "utf8").includes(OLD));
check("no file under src/ names the old upload method", named.length === 0, named.map((p) => p.slice(srcDir.length)).join(", "));
check("the run builds and sends through data-manager.ts", /from "\.\/data-manager\.js"/.test(run) && /buildIngestBody\(/.test(run) && /dm\.ingest\(/.test(run));
check("the job's real calls are the data-manager ones", /import \{ getAccessToken, ingest, requestStatus \} from "\.\/ads\/data-manager\.js"/.test(job));
check("nothing in the run or the pure module calls Google's upload service or fetches", !/conversionUploads|fetch\(/.test(code(run) + code(readFileSync(new URL("./ads/offline-upload.ts", import.meta.url), "utf8"))));
check("the guard's own check works: a planted mention is found", ["x", OLD].join(" ").includes(OLD));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

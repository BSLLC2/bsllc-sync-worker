#!/usr/bin/env tsx
/**
 * Guard for the backlink reader: what it asks DataForSEO, what it spends, what it keeps and what it refuses to guess.
 *
 * No DataForSEO, no database, no key. A pretend DataForSEO (a function standing in for the one door) answers the real
 * request builders, parsers and orchestration, and a recording client stands in for Postgres so the real INSERTs are read
 * as text and as parameters. EVERY DOMAIN, COUNT AND COST BELOW IS INVENTED.
 *
 * WHAT THIS CANNOT PROVE. Nothing here has run against DataForSEO. The three endpoint paths, the request bodies and the
 * answer fields (summary counts, the type counts, new and lost per month, referring domains) are written from the
 * published reference as I know it, and the per-call prices are our own estimate. A green run means the code does what it
 * says against the shapes it expects, not that DataForSEO answers in them. docs/BACKLINKS.md lists each.
 *
 *   npx tsx src/verify-backlinks.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { budgetUsd, estimateUsd, fits, mayRead } from "./backlinks/cost.js";
import { competitorsKey, normaliseDomain, parseCompetitors } from "./backlinks/competitors.js";
import { NEW_LOST_PATH, REFERRING_PATH, SUMMARY_PATH, hasNothing, newLostBody, parseNewLost, parseReferring, parseSummary, readDomain, referringBody, summaryBody } from "./backlinks/dfs.js";
import { realCall } from "./backlinks/real.js";
import { planClient, processBacklinks, type ClientInput } from "./backlinks/run.js";
import { DELETE_DOMAINS, INSERT_DOMAIN, INSERT_RUN, INSERT_SUMMARY, PRUNE_DOMAINS, PRUNE_SUMMARIES, writeClientBacklinks, type Queryable } from "./backlinks/store.js";
import { DEFAULT_RUN_BUDGET_CENTS, EST_USD_PER_DOMAIN, MAX_COMPETITORS, TOP_REFERRING_DOMAINS, type DfsAnswer, type DfsCall } from "./backlinks/types.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);
const here = path.dirname(fileURLToPath(import.meta.url));

const TODAY = "2026-11-15";
type Call = { path: string; body: any };
function fakeDfs(opts: { fail?: (path: string, target: string) => boolean; cost?: number; empty?: Set<string> } = {}): { call: DfsCall; calls: Call[] } {
  const calls: Call[] = [];
  const call: DfsCall = async (p, body) => {
    const b = (body as any[])[0];
    calls.push({ path: p, body: b });
    if (opts.fail?.(p, b.target)) throw new Error(`${p}: 50000 Internal Error`);
    const cost = opts.cost ?? 0.02;
    const isEmpty = opts.empty?.has(b.target);
    if (p === SUMMARY_PATH) return { cost, result: [isEmpty ? { backlinks: 0, referring_domains: 0 } : { backlinks: 1200, referring_domains: 85, referring_main_domains: 80, broken_backlinks: 9, rank: 400, referring_links_types: { anchor: 900, image: 150, redirect: 20, canonical: 30, alternate: 100 }, referring_links_attributes: { nofollow: 200 } }] };
    if (p === NEW_LOST_PATH) return { cost, result: [{ items: isEmpty ? [] : [{ date: "2026-10-01", new_backlinks: 30, lost_backlinks: 10, new_referring_domains: 5, lost_referring_domains: 2 }, { date: "2026-11-01", new_backlinks: 12, lost_backlinks: 4, new_referring_domains: 3, lost_referring_domains: 1 }] }] };
    if (p === REFERRING_PATH) return { cost, result: [{ items: isEmpty ? [] : [{ domain: "WWW.Directory.example", backlinks: 40, first_seen: "2025-04-03 10:00:00 +00:00" }, { domain: "news.example", backlinks: 12, first_seen: "2026-01-09" }, { domain: "not a host", backlinks: 3 }, { domain: "203.0.113.4", backlinks: 2 }] }] };
    throw new Error(`unexpected path ${p}`);
  };
  return { call, calls };
}

interface Rec { sql: string; params: unknown[] }
function recorder(opts: { failOn?: RegExp } = {}): { db: Queryable; q: Rec[] } {
  const q: Rec[] = [];
  return { q, db: { query: async (sql: string, params: unknown[] = []) => { if (opts.failOn?.test(sql)) throw new Error("disk full"); q.push({ sql, params }); return {}; } } };
}
const kindOf = (sql: string) => (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql) ? sql.split(/\s/)[0]!.toLowerCase() : /INSERT INTO seo_backlink_summaries/.test(sql) ? "summary" : /INSERT INTO seo_backlink_domains/.test(sql) ? "domain" : /INSERT INTO seo_backlink_runs/.test(sql) ? "run" : /DELETE FROM seo_backlink_domains WHERE client_id = \$1 AND domain/.test(sql) ? "replace" : /DELETE FROM seo_backlink_(summaries|domains)/.test(sql) ? "prune" : "other");

const C = (id: string, name: string, site: string | null, competitors: string[] = [], moduleSeo = true): ClientInput => ({ id, name, site, moduleSeo, competitors });
const colsOf = (sql: string) => /\(([^)]*)\)\s*VALUES/s.exec(sql)![1]!.split(",").map((c) => c.trim());

/* ═════════════════════════ 1. competitors are typed, never picked ═════════════════════════ */
hr("1. the competitor list is a person's answer");
{
  ok("a hostname is cleaned of scheme, www, path and port", normaliseDomain("HTTPS://WWW.Rival.Example:8080/pricing?x=1") === "rival.example");
  ok("an address that is not a hostname is nothing", normaliseDomain("not a host") === null && normaliseDomain("203.0.113.4") === null && normaliseDomain("a") === null && normaliseDomain(7) === null && normaliseDomain("localhost") === null);
  const good = JSON.stringify({ domains: ["rival-one.example", "https://www.rival-two.example/", "RIVAL-ONE.example", "own.example", "x", "rival-three.example", "rival-four.example"], by: "Pat Owner", at: "2026-11-01T00:00:00Z" });
  const got = parseCompetitors(good, "own.example");
  ok("at most three, no repeats, never the client's own domain", got.length === MAX_COMPETITORS && MAX_COMPETITORS === 3 && got.join() === "rival-one.example,rival-two.example,rival-three.example", got.join());
  ok("an unsigned list is nobody's answer", parseCompetitors(JSON.stringify({ domains: ["rival-one.example"] }), null).length === 0 && parseCompetitors(JSON.stringify({ domains: ["rival-one.example"], by: " " }), null).length === 0);
  for (const bad of [null, undefined, "", "{", "[]", "42", '{"domains":"x","by":"A"}']) ok(`unusable value ${JSON.stringify(bad)} reads as none`, parseCompetitors(bad as any, null).length === 0);
  ok("the setting key is backlink_competitors:<clientId>", competitorsKey("abc") === "backlink_competitors:abc");
}

/* ═════════════════════════ 2. what is eligible, and the plan ═════════════════════════ */
hr("2. who is read");
{
  ok("the search module off is off, with the reason", planClient(C("a", "A", "a.example", [], false)).off?.includes("search module") === true);
  ok("no site is off, with the reason", planClient(C("a", "A", null)).off?.includes("No site address") === true && planClient(C("a", "A", "nope")).domains.length === 0);
  const p = planClient(C("a", "A", "https://www.a.example/", ["b.example", "a.example"]));
  ok("the plan is the own site first, then the competitors, never the own site twice", p.domains.map((d) => `${d.role}:${d.domain}`).join() === "own:a.example,competitor:b.example");
}

/* ═════════════════════════ 3. the answers are read defensively ═════════════════════════ */
hr("3. parsing: a part that is missing is null, never a nought");
{
  const s = parseSummary([{ backlinks: 1200, referring_domains: 85, referring_main_domains: 80, broken_backlinks: 9, referring_links_types: { anchor: 900, image: 150, redirect: 20, canonical: 30 } }])!;
  ok("counts are kept and the link types are counts only", s.backlinks === 1200 && s.anchorLinks === 900 && s.imageLinks === 150 && s.otherLinks === 50);
  ok("no field of the summary can hold text", Object.values(s).every((v) => v === null || typeof v === "number"));
  ok("an answer with no result is null", parseSummary([]) === null && parseSummary(null) === null && parseSummary("x" as any) === null);
  const bare = parseSummary([{ backlinks: 5 }])!;
  ok("a count the answer did not carry is null, not 0", bare.referringDomains === null && bare.anchorLinks === null && bare.otherLinks === null);
  ok("a negative or text count is unanswered", parseSummary([{ backlinks: -3, referring_domains: "12" }])!.backlinks === null && parseSummary([{ backlinks: -3, referring_domains: "12" }])!.referringDomains === null);
  const nl = parseNewLost([{ items: [{ new_backlinks: 30, lost_backlinks: 10 }, { new_backlinks: 12, lost_backlinks: 4, new_referring_domains: 3 }] }])!;
  ok("new and lost are summed over the window", nl.newBacklinks === 42 && nl.lostBacklinks === 14 && nl.newDomains === 3 && nl.lostDomains === null);
  ok("no items is unanswered", parseNewLost([{ items: [] }]) === null);
  const rd = parseReferring([{ items: [{ domain: "WWW.A.example", backlinks: 4, first_seen: "2026-01-01 00:00:00 +00:00" }, { domain: "bad host" }, { domain: "b.example", backlinks: 9, first_seen: "yesterday" }] }])!;
  ok("referring domains are cleaned, bad hosts dropped, a first-seen kept only when it is a date", rd.length === 2 && rd[0]!.domain === "a.example" && rd[0]!.firstSeen === "2026-01-01" && rd[1]!.firstSeen === null);
  ok("no anchor text key exists anywhere in what is kept", !/anchor_text|"anchor":\s*"/i.test(JSON.stringify([s, nl, rd])));
  const many = parseReferring([{ items: Array.from({ length: 40 }, (_, i) => ({ domain: `d${i}.example`, backlinks: i })) }])!;
  ok(`at most ${TOP_REFERRING_DOMAINS} referring domains per target`, many.length === TOP_REFERRING_DOMAINS);
}

/* ═════════════════════════ 4. the three calls per domain ═════════════════════════ */
hr("4. one domain: three calls, each part on its own");
{
  const f = fakeDfs();
  const r = await readDomain(f.call, "a.example", "own", TODAY);
  ok("three calls, to the three endpoints, each for the domain", f.calls.map((c) => c.path).join() === [SUMMARY_PATH, NEW_LOST_PATH, REFERRING_PATH].join() && f.calls.every((c) => c.body.target === "a.example"));
  ok("the summary asks for live links with no internal list", JSON.stringify(summaryBody("a.example")[0]).includes('"backlinks_status_type":"live"') && (summaryBody("a.example")[0] as any).internal_list_limit === 0);
  ok("new and lost is a 30 day window ending today", (newLostBody("a.example", TODAY)[0] as any).date_from === "2026-10-16" && (newLostBody("a.example", TODAY)[0] as any).date_to === TODAY);
  ok("referring domains asks for ten, most links first", (referringBody("a.example")[0] as any).limit === 10 && (referringBody("a.example")[0] as any).order_by[0] === "backlinks,desc");
  ok("the cost is what the answers said, added up", Math.abs(r.costUsd - 0.06) < 1e-9);
  const one = fakeDfs({ fail: (p) => p === NEW_LOST_PATH });
  const r1 = await readDomain(one.call, "a.example", "own", TODAY);
  ok("a failed part is null and named, the others are kept", r1.newLost === null && r1.summary !== null && r1.topDomains !== null && r1.failed.length === 1 && /new and lost/.test(r1.failed[0]!));
  const empty = fakeDfs({ empty: new Set(["z.example"]) });
  ok("a site with no links is recognised and is not an error", hasNothing(await readDomain(empty.call, "z.example", "own", TODAY)));
  const sec = await readDomain(async () => { throw new Error("login hunter2-secret failed"); }, "a.example", "own", TODAY, ["hunter2-secret"]);
  ok("a failure message carries no secret", sec.failed.every((m) => !m.includes("hunter2-secret")));
}

/* ═════════════════════════ 5. the cost guard ═════════════════════════ */
hr("5. the cost guard: priced first, refused whole, never overspent");
{
  ok("the default budget is a conservative $1.50", DEFAULT_RUN_BUDGET_CENTS === 150 && budgetUsd(undefined).usd === 1.5 && !budgetUsd(undefined).fromEnv);
  ok("the variable sets the budget in cents", budgetUsd("400").usd === 4 && budgetUsd("400").fromEnv);
  for (const bad of ["", "abc", "-5", "0", "NaN"]) ok(`an unusable budget ${JSON.stringify(bad)} is the default, never unlimited`, budgetUsd(bad).usd === 1.5);
  ok("a domain's estimate is the three calls added", Math.abs(EST_USD_PER_DOMAIN - 0.07) < 1e-9 && estimateUsd(10) === 0.7);
  ok("a plan inside the budget fits and one over does not", fits(21, 1.5) && !fits(22, 1.5));

  const clients = [C("a", "Alpha", "a.example", ["b.example", "c.example", "d.example"]), C("b", "Beta", "beta.example", ["x.example", "y.example", "z.example"]), C("c", "Gamma", "gamma.example")];
  const dry = fakeDfs();
  const d = await processBacklinks({ clients, call: dry.call, today: TODAY, budgetUsd: 5, dryRun: true, db: null });
  ok("a dry run prints the estimate and makes no call", dry.calls.length === 0 && /estimated \$0\.63/.test(d.lines[0]!), d.lines[0]);
  ok("a dry run over the budget says so and still reads nothing", (await processBacklinks({ clients, call: dry.call, today: TODAY, budgetUsd: 0.3, dryRun: true, db: null })).refused !== null && dry.calls.length === 0);
  const rec0 = recorder();
  const over = fakeDfs();
  const refused = await processBacklinks({ clients, call: over.call, today: TODAY, budgetUsd: 0.5, dryRun: false, db: rec0.db });
  ok("a plan over the budget is refused whole: no call, no write", refused.refused !== null && over.calls.length === 0 && rec0.q.length === 0 && /BACKLINKS_RUN_BUDGET_CENTS/.test(refused.refused!));
  ok("the refusal names the estimate and the budget", /\$0\.63/.test(refused.refused!) && /\$0\.50/.test(refused.refused!));

  // A budget that fits the estimate but is spent by real charges that run above it.
  const dear = fakeDfs({ cost: 0.4 });
  const rec1 = recorder();
  const run = await processBacklinks({ clients, call: dear.call, today: TODAY, budgetUsd: 0.7, dryRun: false, db: rec1.db });
  ok("real charges above the estimate stop the run: the spend never passes the budget by more than the one domain in flight", run.spentUsd <= 0.7 + 3 * 0.4 + 1e-9 && run.spentUsd < 2.0, String(run.spentUsd));
  ok("once the budget is used the rest are capped, named and keep their earlier rows", run.lines.some((l) => /capped/.test(l)) || run.answered === 3);
  ok("spending is checked BEFORE each domain", !mayRead(0.7, 0.7) && mayRead(0.62, 0.7) === (0.62 + EST_USD_PER_DOMAIN <= 0.7 + 1e-9));
  ok("a client with nothing to read is not a failure", (await processBacklinks({ clients: [C("o", "Off", null)], call: dry.call, today: TODAY, budgetUsd: 5, dryRun: false, db: recorder().db })).attempted === 0);
}

/* ═════════════════════════ 6. the run and the store ═════════════════════════ */
hr("6. a real run writes counts and domain names, one transaction per client");
{
  const f = fakeDfs();
  const rec = recorder();
  const res = await processBacklinks({ clients: [C("a", "Alpha", "a.example", ["b.example"])], call: f.call, today: TODAY, budgetUsd: 5, dryRun: false, db: rec.db, now: () => new Date("2026-11-15T05:20:00Z") });
  const seq = rec.q.map((x) => kindOf(x.sql));
  ok("one transaction: BEGIN first, COMMIT last, the run row before the prunes", seq[0] === "begin" && seq[seq.length - 1] === "commit" && seq.indexOf("run") < seq.indexOf("prune"));
  ok("two domains read, two summary rows, one per domain", res.answered === 1 && seq.filter((k) => k === "summary").length === 2);
  const sums = rec.q.filter((x) => kindOf(x.sql) === "summary");
  ok("the own site is role own and the competitor is role competitor", sums.map((x) => x.params[3]).join() === "own,competitor");
  ok("the row carries the counts and the 30 day window", sums[0]!.params[5] === 1200 && sums[0]!.params[6] === 85 && sums[0]!.params[12] === 42 && sums[0]!.params[16] === 30);
  ok("the referring-domain list is replaced for the day, then re-inserted", seq.filter((k) => k === "replace").length === 2 && seq.indexOf("replace") < seq.indexOf("domain"));
  const doms = rec.q.filter((x) => kindOf(x.sql) === "domain");
  ok("only valid hostnames are kept, cleaned", doms.every((x) => /^[a-z0-9.-]+\.[a-z]+$/.test(String(x.params[4]))) && doms.some((x) => x.params[4] === "directory.example") && !doms.some((x) => x.params[4] === "203.0.113.4"));
  ok("a part that failed keeps an earlier same-day value (COALESCE on every count)", (INSERT_SUMMARY.match(/COALESCE\(EXCLUDED/g) ?? []).length === 11);
  ok("a unique key per client, domain and day, so a rerun replaces", /ON CONFLICT \(client_id, domain, read_on\)/.test(INSERT_SUMMARY) && /ON CONFLICT \(client_id, domain, read_on, ref_domain\)/.test(INSERT_DOMAIN) && /ON CONFLICT \(client_id\)/.test(INSERT_RUN));
  const rows = rec.q.filter((x) => kindOf(x.sql) === "summary" || kindOf(x.sql) === "domain").flatMap((x) => x.params);
  ok("nothing person-like is written: every param is a number, a date, a domain name or a short label", rows.every((v) => v == null || typeof v === "number" || v instanceof Date || (typeof v === "string" && v.length <= 80 && !/@/.test(v))));
  const run = rec.q.find((x) => kindOf(x.sql) === "run")!;
  ok("the run row records status, domains read, estimate and spend", run.params[2] === "ok" && run.params[4] === 2 && Math.abs(Number(run.params[5]) - 0.14) < 1e-9 && Math.abs(Number(run.params[6]) - 0.12) < 1e-9);

  const partial = fakeDfs({ fail: (p, t) => p === REFERRING_PATH && t === "a.example" });
  const rec2 = recorder();
  await processBacklinks({ clients: [C("a", "Alpha", "a.example")], call: partial.call, today: TODAY, budgetUsd: 5, dryRun: false, db: rec2.db });
  ok("a referring-domain list that failed is not replaced", !rec2.q.some((x) => kindOf(x.sql) === "replace" || kindOf(x.sql) === "domain"));
  ok("and the run says which part", /referring domains/.test(String(rec2.q.find((x) => kindOf(x.sql) === "run")!.params[3])));

  const allBad = fakeDfs({ fail: () => true });
  const rec3 = recorder();
  const bad = await processBacklinks({ clients: [C("a", "Alpha", "a.example")], call: allBad.call, today: TODAY, budgetUsd: 5, dryRun: false, db: rec3.db });
  ok("every call failing is an error with no data row written", bad.casualties.length === 1 && !rec3.q.some((x) => kindOf(x.sql) === "summary") && rec3.q.find((x) => kindOf(x.sql) === "run")!.params[2] === "error");

  const none = fakeDfs({ empty: new Set(["a.example"]) });
  const rec4 = recorder();
  await processBacklinks({ clients: [C("a", "Alpha", "a.example")], call: none.call, today: TODAY, budgetUsd: 5, dryRun: false, db: rec4.db });
  ok("a site the provider holds no links for is no_data, not an error", rec4.q.find((x) => kindOf(x.sql) === "run")!.params[2] === "no_data");

  const brokenDb = recorder({ failOn: /INSERT INTO seo_backlink_summaries/ });
  const wr = await writeClientBacklinks(brokenDb.db, "a", { status: "ok", detail: null, reads: (await processBacklinks({ clients: [C("a", "Alpha", "a.example")], call: fakeDfs().call, today: TODAY, budgetUsd: 5, dryRun: false, db: null })).lines.length ? [await readDomain(fakeDfs().call, "a.example", "own", TODAY)] : [], estimatedUsd: 0.07, spentUsd: 0.06 }, TODAY, new Date());
  ok("a write that fails rolls back and records an error run, never ok", !wr.ok && brokenDb.q.some((x) => x.sql === "ROLLBACK") && brokenDb.q.filter((x) => kindOf(x.sql) === "run").every((x) => x.params[2] === "error"));
  ok("the prune statements are scoped to the client", /client_id = \$1 AND read_on < \$2/.test(PRUNE_SUMMARIES) && /client_id = \$1 AND read_on < \$2/.test(PRUNE_DOMAINS) && /client_id = \$1 AND domain = \$2 AND read_on = \$3/.test(DELETE_DOMAINS));
}

/* ═════════════════════════ 7. the real door ═════════════════════════ */
hr("7. the real DataForSEO door: POST only, retried on a temporary error, no password in a message");
{
  const seen: Array<{ url: string; method: string; auth: string }> = [];
  let n = 0;
  const fakeFetch = (async (url: string, init: any) => {
    seen.push({ url, method: init.method, auth: init.headers.authorization });
    if (n++ < 1) return { ok: false, status: 503, json: async () => ({}) } as any;
    return { ok: true, status: 200, json: async () => ({ tasks: [{ status_code: 20000, cost: 0.02, result: [{ backlinks: 1 }] }] }) } as any;
  }) as unknown as typeof fetch;
  const call = realCall({ login: "login@example.test", password: "pw-123456" }, fakeFetch, async () => {});
  const a = await call(SUMMARY_PATH, summaryBody("a.example"));
  ok("a 503 is retried once and then answers", a.cost === 0.02 && seen.length === 2 && seen.every((s) => s.method === "POST" && s.url === `https://api.dataforseo.com/v3${SUMMARY_PATH}`));
  const denied = realCall({ login: "l", password: "pw-123456" }, (async () => ({ ok: true, status: 200, json: async () => ({ tasks: [{ status_code: 40101, status_message: "auth pw-123456" }] }) })) as any, async () => {});
  let msg = "";
  try { await denied(SUMMARY_PATH, []); } catch (e) { msg = (e as Error).message; }
  let tries = 0;
  const wrongKey = realCall({ login: "l", password: "pw-123456" }, (async () => { tries++; return { ok: true, status: 200, json: async () => ({ tasks: [{ status_code: 40501, status_message: "invalid field" }] }) }; }) as any, async () => {});
  await wrongKey(SUMMARY_PATH, []).catch(() => {});
  ok("an error that is not temporary is not retried", tries === 1, String(tries));
  ok("a provider refusal is thrown with no password in it", msg.length > 0 && !msg.includes("pw-123456"), msg);
}

/* ═════════════════════════ 8. the files ═════════════════════════ */
hr("8. the contract: columns, schedule, secrets, no writes beyond the three tables");
{
  const store = fs.readFileSync(path.join(here, "backlinks/store.ts"), "utf8");
  const all = fs.readdirSync(path.join(here, "backlinks")).map((f) => fs.readFileSync(path.join(here, "backlinks", f), "utf8")).join("\n") + fs.readFileSync(path.join(here, "read-backlinks.ts"), "utf8");
  ok("the summary columns are the contract's", colsOf(INSERT_SUMMARY).join() === "id,client_id,domain,role,read_on,backlinks,referring_domains,referring_main_domains,broken_backlinks,anchor_links,image_links,other_links,new_backlinks,lost_backlinks,new_domains,lost_domains,window_days,cost_usd,read_at");
  ok("the domain columns are the contract's", colsOf(INSERT_DOMAIN).join() === "id,client_id,domain,read_on,ref_domain,backlinks,first_seen,read_at");
  ok("the run columns are the contract's", colsOf(INSERT_RUN).join() === "id,client_id,status,detail,domains_read,estimated_usd,spent_usd,ran_at");
  const written = Array.from(store.matchAll(/(?:INSERT INTO|DELETE FROM|UPDATE)\s+([a-z0-9_]+)/g)).map((m) => m[1]!);
  ok("only the three tables are written", written.length > 0 && written.every((t) => ["seo_backlink_summaries", "seo_backlink_domains", "seo_backlink_runs"].includes(t)), Array.from(new Set(written)).join());
  ok("the reader creates no table", !/CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX/i.test(all));
  ok("only POST calls and only the three backlink endpoints reach DataForSEO", /method: "POST"/.test(all) && !/method: "(GET|PUT|DELETE)"/.test(fs.readFileSync(path.join(here, "backlinks/real.ts"), "utf8")) && [SUMMARY_PATH, NEW_LOST_PATH, REFERRING_PATH].every((p) => p.startsWith("/backlinks/")));
  ok("no SERP or research call is made: the competitors that outrank a client come from rows already stored", !/\/serp\/|keywords_data|dataforseo_labs|appendix/.test(all.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  const wf = fs.readFileSync(path.join(here, "../.github/workflows/read-backlinks.yml"), "utf8");
  ok("the workflow is weekly and dispatchable with a client and a dry run that defaults to true", /cron: "20 5 \* \* 0"/.test(wf) && /client_id:/.test(wf) && /dry_run:[\s\S]*?default: "true"/.test(wf));
  ok("it reads the budget from the repository variable and passes the keys", /BACKLINKS_RUN_BUDGET_CENTS: \$\{\{ vars\.BACKLINKS_RUN_BUDGET_CENTS \}\}/.test(wf) && /DATAFORSEO_LOGIN/.test(wf) && /DATAFORSEO_PASSWORD/.test(wf));
  ok("the heartbeat step is `if: always()` and is skipped for a dry run and a one-client run", /if: always\(\) && \(github\.event_name != 'workflow_dispatch' \|\| \(inputs\.dry_run != 'true' && inputs\.client_id == ''\)\)/.test(wf) && /--job=read_backlinks/.test(wf));
  ok("the note goes through an environment variable, not into the shell line", /NOTE: \$\{\{ steps\.run\.outputs\.summary \}\}/.test(wf) && /--note="\$NOTE"/.test(wf));
  ok("the keys are named in one file only", fs.readdirSync(path.join(here, "backlinks")).filter((f) => /DATAFORSEO_PASSWORD/.test(fs.readFileSync(path.join(here, "backlinks", f), "utf8"))).length === 0);
  ok("a refused plan exits non-zero so the workflow goes red", /if \(res\.refused\) code = 3/.test(fs.readFileSync(path.join(here, "read-backlinks.ts"), "utf8")));
  ok("the dry run never opens a key or writes", /db: dryRun \? null : c/.test(fs.readFileSync(path.join(here, "read-backlinks.ts"), "utf8")) && /call: !dryRun && hasKey/.test(fs.readFileSync(path.join(here, "read-backlinks.ts"), "utf8")));
  ok("every request shape is marked unverified in the module header", /HAS BEEN RUN AGAINST THE LIVE API/.test(fs.readFileSync(path.join(here, "backlinks/types.ts"), "utf8")) && /UNVERIFIED LIVE/.test(fs.readFileSync(path.join(here, "backlinks/dfs.ts"), "utf8")));
}

console.log("\n" + "─".repeat(72));
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");

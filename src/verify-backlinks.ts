#!/usr/bin/env tsx
/**
 * Guard for the link audit read (src/backlinks, src/read-backlinks.ts). No network, no database, no key: a scripted pretend provider
 * answers through the injectable fetch and a recording stand-in takes the place of the database. EVERY ANSWER BELOW IS INVENTED.
 *
 *   npm run verify-backlinks
 */
import { readFileSync } from "node:fs";
import { CapReached, estimateCall, makeDfs, type Fetcher } from "./backlinks/api.js";
import { planLine, readAudit } from "./backlinks/run.js";
import { ANCHOR_MAX_CHARS, CHEAP_TLDS, cleanAnchor, isCheapTld, isSpamAnchor, pathOf, tldOf } from "./backlinks/rules.js";
import { parseAnchors, parseDomain, parseGap, parseTargets, SPAM_CHUNKS } from "./backlinks/read.js";
import * as store from "./backlinks/store.js";
import { BACKLINK_RUN_STATUSES, LINK_AUDIT_PART_STATES, LINK_AUDIT_RUN_STATUSES, LINK_AUDIT_TARGET_KINDS } from "./backlinks/types.js";

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = "") => { if (cond) { passed += 1; console.log(`  ok   ${name}`); } else { failed += 1; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`); } };
const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

const OWN = "ohiorecovery.example";
const COMP = ["rival.example", "other.example"];

interface Seen { path: string; body: any }
function fakeProvider(o: { failPath?: RegExp; costEach?: number; domainsPages?: number; emailAnchor?: boolean } = {}): { fetch: Fetcher; seen: Seen[] } {
  const seen: Seen[] = [];
  const pageOf = (n: number, kind: string) => Array.from({ length: n }, (_, i) => ({ domain: `${kind}${i}.shop`, rank: i % 3, backlinks: 2, first_seen: "2026-10-01 00:00:00 +00:00", backlinks_spam_score: 80, referring_links_attributes: { nofollow: 1 } }));
  const fetch: Fetcher = async (url, init) => {
    const path = url.replace("https://api.dataforseo.com/v3", "");
    const body = JSON.parse(init.body ?? "[]")[0] ?? {};
    seen.push({ path, body });
    const cost = o.costEach ?? 0.03;
    const reply = (result: unknown) => ({ ok: true, status: 200, text: async () => "", json: async () => ({ cost, tasks: [{ status_code: 20000, result }] }) });
    if (o.failPath?.test(path) && !(path.includes("referring_domains") && body.backlinks_status_type === "lost")) return { ok: false, status: 402, text: async () => "no", json: async () => ({}) };
    if (path === "/backlinks/summary/live") return reply([{ backlinks: 9000, referring_domains: body.target === OWN ? 1200 : 300, referring_main_domains: 1000, broken_backlinks: 40, referring_links_types: { anchor: 8000, image: 100 } }]);
    if (path === "/backlinks/referring_domains/live") {
      if (body.backlinks_status_type === "lost") return reply([{ items: [{ domain: "lost.example", rank: 400, backlinks: 5, lost_date: "2026-11-02 00:00:00 +00:00", first_seen: "2025-01-01" }] }]);
      const pages = o.domainsPages ?? 1;
      const items = body.offset / 1000 < pages - 1 ? pageOf(1000, `p${body.offset}-`) : pageOf(300, `q${body.offset}-`);
      if (body.offset === 0) items.unshift({ domain: "good.example", rank: 500, backlinks: 9, first_seen: "2024-01-01", backlinks_spam_score: 2, referring_links_attributes: { nofollow: 0 } });
      return reply([{ items }]);
    }
    if (path === "/backlinks/anchors/live") return reply([{ items: [
      { anchor: "tg @links_dealer | seo links for fast results", backlinks: 60, referring_domains: 40 },
      { anchor: o.emailAnchor ? "contact jane@example.com or +1 (513) 555-0100 now" : "ohio recovery", backlinks: 150, referring_domains: 4 },
      { anchor: "x".repeat(300), backlinks: 3, referring_domains: 2 },
      { anchor: "   ", backlinks: 1, referring_domains: 1 },
    ] }]);
    if (path === "/backlinks/backlinks/live") {
      if (body.filters?.[0]?.[0] === "is_broken") return reply([{ items: [
        { url_to: `https://${OWN}/old-page?x=1`, url_to_status_code: 404, domain_from: "a.example" }, { url_to: `https://www.${OWN}/old-page`, url_to_status_code: 404, domain_from: "b.example" },
        { url_to: `https://${OWN}/same`, url_to_status_code: 301, url_to_redirect_target: `https://${OWN}/same/`, domain_from: "c.example" },
        { url_to: `https://${OWN}/moved`, url_to_status_code: 301, url_to_redirect_target: `https://${OWN}/new`, domain_from: "d.example" },
        { url_to: "https://elsewhere.example/x", url_to_status_code: 404, domain_from: "e.example" },
      ] }]);
      return reply([{ items: [{ domain_from: "q0-0.shop" }, { domain_from: "WWW.Q0-1.shop" }] }]);
    }
    if (path === "/backlinks/domain_intersection/live") return reply([{ items: [
      { domain_intersection: { "1": { target: "chamber.example", rank: 400 }, "2": { target: "chamber.example", rank: 380 } } },
      { domain_intersection: { "1": { target: OWN, rank: 100 }, "2": { target: OWN, rank: 100 } } },
      { domain_intersection: { "1": { target: "one.example", rank: 10 } } },
    ] }]);
    return reply([]);
  };
  return { fetch, seen };
}
const dfsFor = (f: Fetcher, capUsd = 3) => makeDfs({ login: "l", password: "p" }, { fetch: f, capUsd, retryMs: 0 });

class Recorder { sql: string[] = []; params: unknown[][] = []; async query(sql: string, params?: unknown[]) { this.sql.push(sql); this.params.push(params ?? []); return { rowCount: 0, rows: [] }; } }

async function main() {
  console.log("rules: the cleaning and the lists");
  check("an email address and a phone number are replaced and the anchor is cut to 120", (() => { const a = cleanAnchor("write to jane@example.com or call +1 (513) 555-0100 " + "y".repeat(200)); return !!a && !/@/.test(a) && !/555/.test(a) && a.length <= ANCHOR_MAX_CHARS; })());
  check("an empty or non-text anchor is nothing", cleanAnchor("   ") === null && cleanAnchor(null) === null && cleanAnchor(5) === null);
  check("a cheap ending and a spam wording are recognised and a .com is not cheap", isCheapTld("x.shop") && isCheapTld("a.xyz") && !isCheapTld("good.com") && isSpamAnchor("TG @links_dealer | SEO links") && !isSpamAnchor("ohio recovery") && tldOf("a.b.shop") === "shop" && CHEAP_TLDS.includes("shop"));
  check("a page address becomes a path on the own site only", pathOf("https://www.x.example/Old/Page/?a=1#f") === "/old/page" && pathOf("") === null);

  console.log("\nthe estimate and the dry run");
  const plan = planLine({ own: OWN, competitors: COMP, capUsd: 3 });
  check("an estimate is printed before any money is spent and says it is unverified", /about \$\d+\.\d\d/.test(plan.line) && /unverified/.test(plan.line));
  const entry = src("read-backlinks.ts");
  const dryAt = entry.indexOf("if (dryRun)"), makeAt = entry.indexOf("makeDfs(creds");
  const dryBlock = entry.slice(dryAt, entry.indexOf("continue;", dryAt));
  check("a dry run continues before any request is made", dryAt > 0 && makeAt > dryAt && dryBlock.length < 400 && !/makeDfs|readAudit|writeAudit|writeRunOnly/.test(dryBlock));
  check("the default cap is 3 dollars and cannot pass 25", /: 3;/.test(entry) && /Math\.min\(capArg, 25\)/.test(entry));

  console.log("\na full read against the pretend provider");
  const p = fakeProvider({ emailAnchor: true });
  const full = await readAudit(dfsFor(p.fetch), { own: OWN, competitors: COMP, capUsd: 3 });
  const anchorCalls = p.seen.filter((s) => s.path === "/backlinks/anchors/live");
  check("anchors are asked for once, for the client's own site only, never a competitor's", anchorCalls.length === 1 && anchorCalls[0]!.body.target === OWN);
  check("no request names a competitor except its summary and the intersection", p.seen.filter((s) => s.body.target && COMP.includes(s.body.target)).every((s) => s.path === "/backlinks/summary/live"));
  check("the stored anchors hold no email address and no phone number and none is over 120 characters", (full.anchors ?? []).every((a) => !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|555/.test(a.anchor) && a.anchor.length <= ANCHOR_MAX_CHARS) && (full.anchors?.length ?? 0) === 3);
  check("referring sites carry rank, spam, the ending and a dofollow estimate", (full.domains ?? []).some((d) => d.refDomain === "good.example" && d.rank === 500 && d.spamScore === 2 && d.dofollowBacklinks === 9 && d.tld === "example") && (full.domains ?? []).some((d) => d.tld === "shop" && d.spamScore === 80));
  check("a lost site is kept with its date", (full.domains ?? []).some((d) => d.refDomain === "lost.example" && d.lostDate === "2026-11-02"));
  check("a site using a spam wording is flagged, a www prefix folded", (full.domains ?? []).some((d) => d.refDomain === "q0-0.shop" && d.spamAnchor === true) && (full.domains ?? []).some((d) => d.refDomain === "q0-1.shop" && d.spamAnchor === true) && (full.domains ?? []).some((d) => d.refDomain === "q0-2.shop" && d.spamAnchor === false));
  check("broken pages are paths on the own site, the same-destination redirect and another site's page are dropped", (full.targets ?? []).map((t) => `${t.kind}:${t.pagePath}`).sort().join(",") === "broken:/old-page,redirect:/moved" && (full.targets ?? []).find((t) => t.pagePath === "/old-page")?.referringDomains === 2);
  check("the gap drops the own site and a site only one competitor links from", (full.gap ?? []).length === 1 && full.gap![0]!.refDomain === "chamber.example" && full.gap![0]!.competitors.length === 2);
  check("the spam wordings ask in chunks of five", SPAM_CHUNKS.every((c) => c.length <= 5) && p.seen.filter((s) => s.path === "/backlinks/backlinks/live" && s.body.filters?.[0]?.[0] === "anchor").length === SPAM_CHUNKS.length);
  check("every part reads ok and the cost is the sum of the answers", full.status === "ok" && full.domainsState === "ok" && full.anchorsState === "ok" && full.targetsState === "ok" && full.gapState === "ok" && full.spamState === "ok" && Math.abs(full.spentUsd - 0.03 * p.seen.length) < 0.0001);
  check("the gap is not asked for with fewer than two named competitors", !(await (async () => { const q = fakeProvider(); await readAudit(dfsFor(q.fetch), { own: OWN, competitors: ["rival.example"], capUsd: 3 }); return q.seen.some((s) => s.path === "/backlinks/domain_intersection/live"); })()));

  console.log("\nthe cost cap");
  const cheap = fakeProvider({ costEach: 0.3 });
  const capped = await readAudit(dfsFor(cheap.fetch, 0.5), { own: OWN, competitors: COMP, capUsd: 0.5 });
  check("a cap stops the read before the next request would pass it and says so", capped.spentUsd <= 0.5 + 1e-9 && capped.status === "capped" && /spend cap/.test(capped.detail ?? ""));
  check("a part stopped by the cap is marked capped, not failed", [capped.domainsState, capped.anchorsState, capped.targetsState, capped.gapState].includes("capped") && ![capped.domainsState, capped.anchorsState, capped.targetsState, capped.gapState].includes("failed"));
  const guard = dfsFor(fakeProvider().fetch, estimateCall(1) - 0.0001);
  let threw = false; try { await guard.task("/backlinks/summary/live", [{}], 1); } catch (e) { threw = e instanceof CapReached; }
  check("a single request that would pass the cap is not sent", threw && guard.calls === 0);

  console.log("\na part that fails keeps its earlier rows");
  const bad = fakeProvider({ failPath: /anchors|domain_intersection/ });
  const partial = await readAudit(dfsFor(bad.fetch), { own: OWN, competitors: COMP, capUsd: 3 });
  check("a failed part is named and the other parts still read", partial.anchorsState === "failed" && partial.gapState === "failed" && partial.domainsState === "ok" && /anchors/.test(partial.detail ?? ""));
  const rec = new Recorder();
  await store.writeAudit(rec, "c1", OWN, partial, "2026-11-16", new Date("2026-11-16T10:00:00Z"));
  const clears = rec.sql.filter((s) => /^DELETE FROM/.test(s));
  check("a failed part is never cleared and a complete one is replaced inside a transaction", !clears.some((s) => /link_audit_anchors|link_audit_gap/.test(s)) && clears.some((s) => /link_audit_domains/.test(s)) && rec.sql[0] === "BEGIN" && rec.sql[rec.sql.length - 1] === "COMMIT");
  const capRec = new Recorder();
  await store.writeAudit(capRec, "c1", OWN, { ...full, domainsState: "capped" }, "2026-11-16", new Date());
  check("a capped part is upserted over what is there and never cleared", !capRec.sql.some((s) => /^DELETE FROM link_audit_domains/.test(s)) && capRec.sql.some((s) => /INSERT INTO link_audit_domains/.test(s)));
  const allParams = JSON.stringify(rec.params) + JSON.stringify(capRec.params);
  check("nothing written holds an email address or a phone number", !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(allParams) && !/\(513\)|555-0100/.test(allParams));
  const failRec = new Recorder();
  const throwing = { query: async (sql: string) => { failRec.sql.push(sql); if (/INSERT INTO link_audit_runs/.test(sql)) throw new Error("boom"); return { rowCount: 0 }; } };
  let rolled = false; try { await store.writeAudit(throwing, "c1", OWN, full, "2026-11-16", new Date()); } catch { rolled = failRec.sql.includes("ROLLBACK"); }
  check("a write that fails part way is rolled back whole", rolled);

  console.log("\nparsers: a field this build does not know is unanswered, never a nought");
  check("a site with no spam score or no nofollow figure carries null", (() => { const d = parseDomain({ domain: "a.example", rank: 5, backlinks: 3 }, false); return !!d && d.spamScore === null && d.dofollowBacklinks === null; })());
  check("an item with no name is dropped and a gap of one competitor is dropped", parseDomain({ rank: 1 }, false) === null && parseGap([{ domain_intersection: { "1": { target: "x.example" } } }], COMP, OWN).length === 0);
  check("equal anchors are summed", (() => { const a = parseAnchors([{ anchor: "A b", backlinks: 1 }, { anchor: "a  b", backlinks: 2 }, { anchor: "A  b", backlinks: 3 }]); return a.length === 2 && a.find((x) => x.anchor === "A b")?.backlinks === 4; })());
  check("a redirect to the same page is not a row", parseTargets([{ url_to: `https://${OWN}/a`, url_to_status_code: 302, url_to_redirect_target: `https://${OWN}/a/` }], OWN).length === 0);

  console.log("\nthe workflow, the store and the secrets");
  const wf = src("../.github/workflows/read-backlinks.yml");
  check("the workflow is weekly, dry run defaults to true, takes client_id and max_usd", /cron: "40 5 \* \* 1"/.test(wf) && /dry_run:[\s\S]*?default: "true"/.test(wf) && /client_id:/.test(wf) && /max_usd:/.test(wf));
  check("the heartbeat runs on failure and skips a dry run and a one-client run", /if: always\(\) && inputs\.dry_run != 'true' && inputs\.client_id == ''/.test(wf) && /--job=read_backlinks/.test(wf));
  check("the workflow names only the database and the two provider secrets", Array.from(wf.matchAll(/secrets\.([A-Z_]+)/g)).map((m) => m[1]).every((n) => ["DATABASE_URL", "DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"].includes(n!)));
  check("a note goes through the environment and not into the shell line", /NOTE: \$\{\{ steps\.run\.outputs\.summary \}\}/.test(wf) && /--note="\$NOTE"/.test(wf) && !/--note="\$\{\{/.test(wf));
  check("every column list in the store is a literal", [store.INSERT_SUMMARY, store.INSERT_DOMAIN, store.INSERT_RUN, store.INSERT_AUDIT_DOMAIN, store.INSERT_AUDIT_TARGET, store.INSERT_AUDIT_ANCHOR, store.INSERT_AUDIT_GAP, store.INSERT_AUDIT_RUN].every((s) => !s.includes("${")));
  check("no column list in the store source is built at run time", !/INSERT INTO \w+\s*\([^)]*\$\{/.test(src("backlinks/store.ts")));
  const keyUse = (f: string) => /process\.env\.DATAFORSEO/.test(src(f));
  check("the provider's login is read only where the other readers read it", !["read-backlinks.ts", "backlinks/api.ts", "backlinks/run.ts", "backlinks/read.ts", "backlinks/store.ts"].some(keyUse));
  check("the status lists are the dashboard's words", BACKLINK_RUN_STATUSES.length === 6 && LINK_AUDIT_RUN_STATUSES.length === 6 && LINK_AUDIT_PART_STATES.length === 5 && LINK_AUDIT_TARGET_KINDS.length === 2);
  check("the app is never called and no write goes to an ad platform or a site", !/(fetch\(|googleapis)/.test((src("backlinks/run.ts") + src("backlinks/store.ts") + src("backlinks/read.ts")).replace(/\/\*[\s\S]*?\*\//g, "")));

  console.log(`\n${failed ? "✗" : "✓"} link audit guard: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });

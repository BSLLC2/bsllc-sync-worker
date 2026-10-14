#!/usr/bin/env tsx
/**
 * Google's own recommendations: the reader.
 *
 * Proves, over INVENTED rows (no ad account, no network, no credential):
 *
 *   1. it only READS: neither source file names the platform's apply or dismiss
 *      calls, a mutate, or a write to findings
 *   2. the list of recommendation types is the client library's own, both ways
 *   3. a type is decoded from the library's own numbers; one it cannot name is
 *      counted as unrecognised and never folded into a known one
 *   4. a row is read whichever casing the client returns; an absent flag is
 *      NULL (unanswered), an object with no figure is no impact
 *   5. identity is the content: a re-issued suggestion keeps its id, two keyword
 *      suggestions on one campaign do not share one
 *   6. a run closes only what Google stopped returning, only on a WHOLE read,
 *      and re-opens what came back
 *   7. the selected fields exist in the library's own definition of the resource
 *   8. the real store, on a throwaway schema (when ADS_VERIFY_DATABASE_URL is set)
 *
 *   npm run verify-ads-google-recs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { enums } from "google-ads-api";
import {
  CLOSED_GONE_REASON, GOOGLE_RECS_DETAIL_GAQL, GOOGLE_RECS_GAQL, RECS_READ_CAP, REC_TYPE_NAMES, closeRecs,
  decodeRecType, ensureRecTables, normalizeRecommendation, parseRecDetails, planRecSync, readIsWhole, recId,
  recordRecScan, storedRecs, upsertRecs, withDetails, type NormalRec,
} from "./ads/google-recs.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n${s}`);
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");

const byNumber: Record<string, string> = {};
for (const [k, v] of Object.entries(enums.RecommendationType as unknown as Record<string, unknown>)) {
  if (typeof v === "number") byNumber[String(v)] = k;
}
const num = (name: string): string => {
  const hit = Object.entries(byNumber).find(([, n]) => n === name);
  if (!hit) throw new Error(`the installed library has no ${name}`);
  return hit[0];
};

// ── 1. It only reads ─────────────────────────────────────────────────────────
section("1. It only reads: nothing here applies or dismisses a suggestion in an ad account");
/** The words that would write to a platform, or to the findings this audit owns. */
export function writeWords(src: string): string[] {
  const code = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
  return [
    /applyRecommendation/i, /dismissRecommendation/i, /recommendationService/i, /\.mutate\s*\(/, /mutateResources/i,
    /customer\.recommendations/i, /INSERT INTO ads_findings/i, /UPDATE ads_findings/i, /ads_finding_events/i,
  ].filter((re) => re.test(code)).map((re) => re.source);
}
{
  for (const f of ["ads/google-recs.ts", "ads-google-recs.ts"]) {
    const w = writeWords(read(f));
    ok(`${f} names no apply, dismiss, mutate or findings write`, w.length === 0, w.join(", "));
  }
  ok("the checker catches a planted apply call", writeWords("await customer.recommendations.applyRecommendation(x)").length >= 1);
  ok("…and a planted dismissal", writeWords("service.dismissRecommendation(req)").length >= 1);
  ok("…and a planted write to findings", writeWords("await c.query(`UPDATE ads_findings SET status = 'dismissed'`)").length >= 1);
  ok("…and does not flag a comment that names them", writeWords("// we never call applyRecommendation here").length === 0);
  ok("both queries are SELECTs", /^\s*SELECT/i.test(GOOGLE_RECS_GAQL) && /^\s*SELECT/i.test(GOOGLE_RECS_DETAIL_GAQL));
}

// ── 2. The list of types is the library's ────────────────────────────────────
section("2. The type list is the client library's own enum, both ways");
{
  const lib = Object.values(byNumber).filter((n) => n !== "UNSPECIFIED" && n !== "UNKNOWN");
  const ours = [...REC_TYPE_NAMES] as string[];
  ok("every type in the library is in the list", lib.every((n) => ours.includes(n)), lib.filter((n) => !ours.includes(n)).join(", "));
  ok("every type in the list is in the library", ours.every((n) => lib.includes(n)), ours.filter((n) => !lib.includes(n)).join(", "));
  ok("no type is listed twice", new Set(ours).size === ours.length);
}

// ── 3. Decoding ──────────────────────────────────────────────────────────────
section("3. A type is decoded from the library's own numbers");
{
  ok("a known number gives its name", decodeRecType(num("CAMPAIGN_BUDGET"), byNumber) === "CAMPAIGN_BUDGET");
  ok("a name is accepted as it is", decodeRecType("keyword", byNumber) === "KEYWORD");
  ok("a number the library does not know is UNRECOGNISED, not the nearest type", decodeRecType("9999", byNumber) === "UNRECOGNISED:9999");
  ok("a name this build has never heard of is UNRECOGNISED", decodeRecType("BRAND_NEW_THING", byNumber) === "UNRECOGNISED:BRAND_NEW_THING");
  ok("an empty value is UNRECOGNISED, never a type", decodeRecType("", byNumber).startsWith("UNRECOGNISED"));
}

// ── 4. Reading a row ─────────────────────────────────────────────────────────
section("4. A row is read whichever casing comes back; an absence is a null");
const ACCOUNT = "1112223334";
const row = (over: Record<string, unknown> = {}) => ({
  recommendation: {
    resource_name: `customers/${ACCOUNT}/recommendations/aaa`,
    type: num("CAMPAIGN_BUDGET"),
    campaign: `customers/${ACCOUNT}/campaigns/555`,
    campaign_budget: `customers/${ACCOUNT}/campaignBudgets/777`,
    dismissed: false,
    impact: {
      base_metrics: { impressions: 1000, clicks: 50, cost_micros: 120_000_000, conversions: 4, conversions_value: 0 },
      potential_metrics: { impressions: 1400, clicks: 70, cost_micros: 168_000_000, conversions: 5.5, conversions_value: 0 },
    },
    ...over,
  },
});
{
  const a = normalizeRecommendation(row(), ACCOUNT, byNumber)!;
  ok("type, campaign and budget are read", a.recType === "CAMPAIGN_BUDGET" && a.campaignId === "555" && a.budgetId === "777");
  ok("Google's own dismissed flag is carried as stated", a.dismissedInGoogle === false);
  ok("the impact figures Google states are carried", a.impact?.potential?.clicks === 70 && a.impact?.base?.costMicros === 120_000_000);

  const camel = normalizeRecommendation({
    recommendation: {
      resourceName: "customers/1/recommendations/b", type: "KEYWORD", campaign: "customers/1/campaigns/9",
      adGroup: "customers/1/adGroups/3", dismissed: true, impact: { baseMetrics: { clicks: 3 } },
    },
  }, ACCOUNT, byNumber)!;
  ok("camel-case keys read the same", camel.recType === "KEYWORD" && camel.adGroupId === "3" && camel.dismissedInGoogle === true && camel.impact?.base?.clicks === 3);

  const bare = normalizeRecommendation({ recommendation: { resource_name: "customers/1/recommendations/c", type: num("SITELINK_ASSET") } }, ACCOUNT, byNumber)!;
  ok("an absent dismissed flag is NULL, not 'not dismissed'", bare.dismissedInGoogle === null);
  ok("an absent impact is null, not a row of noughts", bare.impact === null);
  const empty = normalizeRecommendation(row({ impact: { base_metrics: {}, potential_metrics: { clicks: null } } }), ACCOUNT, byNumber)!;
  ok("an impact object with no figure in it is no impact", empty.impact === null);
  ok("a row with no resource name is dropped", normalizeRecommendation({ recommendation: { type: 1 } }, ACCOUNT, byNumber) === null);
  const zero = normalizeRecommendation(row({ impact: { base_metrics: { conversions: 0 }, potential_metrics: {} } }), ACCOUNT, byNumber)!;
  ok("a stated nought is kept as a nought (Google said it)", zero.impact?.base?.conversions === 0);
}

// ── 5. Identity is the content ───────────────────────────────────────────────
section("5. Identity is what the suggestion IS, not what Google called it this week");
{
  const kw = (rn: string, text: string, match = 3) => ({
    list: normalizeRecommendation({ recommendation: { resource_name: rn, type: num("KEYWORD"), campaign: "customers/1/campaigns/9", ad_group: "customers/1/adGroups/3" } }, ACCOUNT, byNumber)!,
    detail: { recommendation: { resource_name: rn, keyword_recommendation: { keyword: { text, match_type: match }, recommended_cpc_bid_micros: 2_000_000 } } },
  });
  const withD = (x: ReturnType<typeof kw>) => withDetails([x.list], parseRecDetails([x.detail]), ACCOUNT)[0]!;
  const one = withD(kw("customers/1/recommendations/old", "Detox Cincinnati"));
  const reissued = withD(kw("customers/1/recommendations/new", "detox  cincinnati"));
  const other = withD(kw("customers/1/recommendations/other", "rehab cincinnati"));
  ok("a re-issue under a new resource name keeps its id", one.id === reissued.id && one.resourceName !== reissued.resourceName);
  ok("two keyword suggestions on one campaign do not share an id", one.id !== other.id);
  ok("a different match type is a different suggestion", one.id !== withD(kw("customers/1/recommendations/x", "detox cincinnati", 2)).id);
  ok("the keyword detail is parsed (text, match type, bid)", one.detail?.keyword?.text === "Detox Cincinnati" && one.detail?.keyword?.matchType === "PHRASE" && one.detail?.keyword?.cpcBidMicros === 2_000_000);
  const budget = parseRecDetails([{ recommendation: { resource_name: "r", campaign_budget_recommendation: { current_budget_amount_micros: 104_000_000, recommended_budget_amount_micros: 130_000_000 } } }]).get("r");
  ok("the budget detail is parsed", budget?.budget?.currentMicros === 104_000_000 && budget?.budget?.recommendedMicros === 130_000_000);
  ok("a detail row with nothing in it stores nothing", parseRecDetails([{ recommendation: { resource_name: "r2" } }]).size === 0);
  ok("the id is a function of the account too", recId("999", one) !== recId(ACCOUNT, one));
}

// ── 6. What a run does to what is stored ─────────────────────────────────────
section("6. A run closes only what Google stopped returning, only on a whole read");
{
  const mk = (n: number): NormalRec => normalizeRecommendation(row({ resource_name: `customers/1/recommendations/r${n}`, campaign: `customers/1/campaigns/${n}` }), ACCOUNT, byNumber)!;
  const [r1, r2, r3] = [mk(1), mk(2), mk(3)];
  const stored = [{ id: r1.id, closedAt: null }, { id: r2.id, closedAt: null }, { id: r3.id, closedAt: "2026-10-01T00:00:00Z" }];
  const whole = planRecSync(stored, [r1, r3], true);
  ok("a row Google no longer returns is closed", whole.close.length === 1 && whole.close[0] === r2.id);
  ok("a closed row Google returns again is re-opened", whole.reopen.length === 1 && whole.reopen[0] === r3.id);
  const cut = planRecSync(stored, [r1], false);
  ok("a read that was NOT whole closes nothing", cut.close.length === 0 && /not whole/.test(cut.closeHeld ?? ""));
  ok("…and says why, once", typeof cut.closeHeld === "string");
  const dup = planRecSync([], [r1, r1, r2], true);
  ok("two rows with one identity are stored once and counted", dup.upsert.length === 2 && dup.duplicates === 1);
  ok("an empty whole read closes everything open", planRecSync(stored, [], true).close.length === 2);
  ok("an empty read that was cut closes nothing", planRecSync(stored, [], false).close.length === 0);
  ok("a read at the cap is not whole", !readIsWhole(RECS_READ_CAP) && readIsWhole(RECS_READ_CAP - 1));
  ok("the closing reason says Google stopped returning it", /no longer returns/.test(CLOSED_GONE_REASON));
}

// ── 7. The selected fields exist ─────────────────────────────────────────────
section("7. Every field the queries select exists in the library's own definition of the resource");
{
  let defs = "";
  try {
    defs = readFileSync(join(here, "../node_modules/google-ads-node/build/protos/protos.d.ts"), "utf8");
  } catch { /* handled below */ }
  if (!defs) {
    console.log("  ⏭  skipped: the library's protos.d.ts is not installed here.");
  } else {
    const leaf = (gaql: string): string[] => Array.from(gaql.matchAll(/recommendation\.([a-z_.]+)/g)).map((m) => m[1]!.split(".").pop()!);
    const names = Array.from(new Set([...leaf(GOOGLE_RECS_GAQL), ...leaf(GOOGLE_RECS_DETAIL_GAQL)]));
    const missing = names.filter((n) => !new RegExp(`\\b${n}\\??:`).test(defs));
    ok(`all ${names.length} selected field names are declared by the library`, missing.length === 0, missing.join(", "));
    ok("the checker would catch a made-up field", !/\bdefinitely_not_a_field\??:/.test(defs));
  }
}

// ── 8. The real store ────────────────────────────────────────────────────────
const dbUrl = process.env.ADS_VERIFY_DATABASE_URL;
if (!dbUrl) {
  section("8. The real store functions");
  console.log("  ⏭  skipped: ADS_VERIFY_DATABASE_URL is not set. Locally: `node scripts/test-db.mjs start` in the dashboard repo prints a URL.");
  console.log("     CI runs this section in the `ads-store` job against a Postgres service container.");
} else {
  await storeSection(dbUrl);
}

async function storeSection(url: string) {
  section("8. The real store, on a throwaway schema");
  const schema = `ads_recs_${Math.random().toString(36).slice(2, 10)}`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await ensureRecTables(c);
    await ensureRecTables(c);
    ok("the tables are created, twice, without error", true);

    const mk = (n: number, type = "CAMPAIGN_BUDGET"): NormalRec => normalizeRecommendation(
      row({ resource_name: `customers/1/recommendations/s${n}`, type: num(type), campaign: `customers/1/campaigns/${n}` }), ACCOUNT, byNumber)!;
    const names = new Map([["1", "Brand — Core"]]);
    const [a, b] = [mk(1), mk(2)];
    await upsertRecs(c, "CL", "google_ads", ACCOUNT, [a, b], names);
    let st = await storedRecs(c, "google_ads", ACCOUNT);
    ok("two suggestions are stored", st.length === 2);
    const first = (await c.query<{ first_seen_at: Date; campaign_name: string | null }>(`SELECT first_seen_at, campaign_name FROM ads_google_recs WHERE id = $1`, [a.id])).rows[0]!;
    ok("the campaign's name rides on the row", first.campaign_name === "Brand — Core");

    await closeRecs(c, [b.id]);
    st = await storedRecs(c, "google_ads", ACCOUNT);
    ok("a closed suggestion carries a closed date and Google's reason", st.find((s) => s.id === b.id)?.closedAt != null
      && (await c.query<{ closed_why: string }>(`SELECT closed_why FROM ads_google_recs WHERE id = $1`, [b.id])).rows[0]!.closed_why === CLOSED_GONE_REASON);

    // Closing again never rewrites WHEN or WHY it was first closed.
    const closedOnce = (await c.query<{ closed_at: Date; closed_why: string }>(`SELECT closed_at, closed_why FROM ads_google_recs WHERE id = $1`, [b.id])).rows[0]!;
    await new Promise((r) => setTimeout(r, 20));
    await closeRecs(c, [b.id], "a second, different reason");
    const closedTwice = (await c.query<{ closed_at: Date; closed_why: string }>(`SELECT closed_at, closed_why FROM ads_google_recs WHERE id = $1`, [b.id])).rows[0]!;
    ok("closing an already-closed suggestion keeps its first date and its first reason",
      new Date(closedTwice.closed_at).getTime() === new Date(closedOnce.closed_at).getTime() && closedTwice.closed_why === closedOnce.closed_why);

    await new Promise((r) => setTimeout(r, 20));
    await upsertRecs(c, "CL", "google_ads", ACCOUNT, [a, b], names);
    const again = (await c.query<{ first_seen_at: Date }>(`SELECT first_seen_at FROM ads_google_recs WHERE id = $1`, [a.id])).rows[0]!;
    ok("a second read never rewrites first_seen_at", new Date(again.first_seen_at).getTime() === new Date(first.first_seen_at).getTime());
    st = await storedRecs(c, "google_ads", ACCOUNT);
    ok("a closed suggestion that comes back is re-opened", st.every((s) => s.closedAt === null));

    await closeRecs(c, [a.id]);
    await upsertRecs(c, "CL", "google_ads", ACCOUNT, [{ ...a, detail: null }], names);
    await c.query(`UPDATE ads_google_recs SET detail_json = '{"budget":{"currentMicros":1,"recommendedMicros":2}}' WHERE id = $1`, [a.id]);
    await upsertRecs(c, "CL", "google_ads", ACCOUNT, [{ ...a, detail: null }], names);
    const kept = (await c.query<{ detail_json: string | null }>(`SELECT detail_json FROM ads_google_recs WHERE id = $1`, [a.id])).rows[0]!;
    ok("a run whose detail pass failed does not wipe the detail already stored", kept.detail_json != null);

    await recordRecScan(c, "CL", "google_ads", ACCOUNT, { ok: true, liveCount: 2, whole: true, detailOk: true, note: "2 live" });
    await recordRecScan(c, "CL", "google_ads", ACCOUNT, { ok: false, liveCount: null, whole: null, detailOk: null, note: "auth" });
    const scans = (await c.query<{ ok: boolean; live_count: number | null }>(`SELECT ok, live_count FROM ads_google_rec_scans`)).rows;
    ok("one scan row per account, the newest outcome wins", scans.length === 1 && scans[0]!.ok === false && scans[0]!.live_count === null);
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
}

console.log("\n" + "─".repeat(72));
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");

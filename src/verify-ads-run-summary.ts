#!/usr/bin/env tsx
/**
 * Why an old finding could stay on the Ads decisions page, and what the audit
 * now says about what it did.
 *
 * The owner, after days of reports that the queue shows work that is done:
 * "did you finish the paid media stuff? I'm still seeing a ton of things on the
 * page". Reading the sweep found causes, and this guard pins each one:
 *
 *   1. THE SWEEP COMPARED ENTITY IDS, NOT FINDING TYPES. Three rules key a row
 *      on the bare campaign id, so a campaign that went on producing one of them
 *      kept every other row on it open for ever.
 *   2. A RULE CHANGE WAS REPORTED AS THE ACCOUNT CHANGING ("the condition
 *      cleared on its own").
 *   3. AN ACCOUNT THE AUDIT STOPPED READING (connector off, client paused,
 *      account number changed) WAS NEVER SWEPT.
 *   4. A RULE THAT COULD NOT RUN (negatives unread, a report that came back at
 *      its row limit) WAS READ AS A RULE THAT FOUND NOTHING.
 *   5. THE DUPLICATE QUESTION: two rules cannot emit one (type, entity) key in
 *      one run, and a re-detected machine closure comes back instead of staying
 *      shut behind an unchanged evidence hash.
 *
 * And the receipt: one row per account per run (`ads_audit_runs`) that the
 * dashboard reads, with counts that reconcile and an outcome that is never a
 * nought (read, read_nothing, failed, skipped).
 *
 * Sections 1-6 are pure. Section 7 drives the REAL store functions against a
 * throwaway Postgres schema when ADS_VERIFY_DATABASE_URL is set (CI sets it;
 * locally the dashboard repo's `node scripts/test-db.mjs start` prints one) and
 * says it was skipped when it is not.
 *
 * EVERY CLIENT, CAMPAIGN, TERM AND FIGURE HERE IS INVENTED. Nothing ran against
 * an ad account or a production database.
 *
 *   npm run verify-ads-run-summary
 */
import pg from "pg";
import {
  planSweep, planOrphanClosures, pairKey, unrecheckableTypes, isMachineClosure, notAuditedWhy, notAuditedReason,
  ruleUpdateReason, CLEARED_REASON, RULE_UPDATE_PREFIX, NOT_AUDITED_PREFIX, ORPHAN_SWEEP_MAX_SHARE,
  type OpenFindingRow, type OrphanGroup, type MappingState,
} from "./ads/sweep-plan.js";
import {
  buildRunSummary, failureReason, RUN_COUNT_KEYS, RUN_SUMMARY_KEYS, RUN_OUTCOMES, RUN_RECORD_CAP, RUN_LEFT_ALONE_CAP,
  type RunFacts,
} from "./ads/run-summary.js";
import { ADS_RULESET_VERSION, type AuditAccounting, type DerivedFinding } from "./ads/rules.js";
import {
  upsertFinding, sweepResolved, sweepUnauditedAccounts, writeRunRecord, normaliseAccountId, supersedeFindings,
} from "./ads/store.js";
import { readFileSync } from "node:fs";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n${s}`);
const ACTOR = "ads-findings-run";
const NOW = ADS_RULESET_VERSION;

const row = (id: string, findingType: string, entityId: string, rulesetVersion: number, title = `${findingType} on ${entityId}`): OpenFindingRow =>
  ({ id, findingType, entityId, rulesetVersion, title });

// ── The OCH-shaped book the owner described, from before ruleset 10 ─────────
// One campaign (111) that is still budget-limited and still over target, and
// four rows from earlier rulesets that the current rules no longer raise.
const OPEN_BEFORE: OpenFindingRow[] = [
  row("f1", "budget_limited", "111", 9),
  row("f2", "no_conversions", "111", 8),
  row("f3", "rank_limited", "111", 9),
  row("f4", "cpa_above_target", "111:cost_target", 9),
  row("f5", "wasted_search_term", "111:wasted_terms", 9),
  row("f6", "dead_keyword", "customers/1/adGroupCriteria/2~3", 9),
  row("f7", "low_quality_score", "9999:low_quality_score", NOW),
];
const PRESENT_NOW = new Set([pairKey("111", "budget_limited"), pairKey("111:cost_target", "cpa_above_target")]);

/** What the sweep did before this change: compare entity ids and nothing else. */
function legacyEntityOnlySweep(open: readonly OpenFindingRow[], presentPairs: ReadonlySet<string>): string[] {
  const entities = new Set(Array.from(presentPairs).map((k) => k.split("\u0000")[1]!));
  return open.filter((r) => !entities.has(r.entityId)).map((r) => r.id);
}

section("1. The sweep compares the PAIR a finding lives under, not the entity");
{
  const legacy = legacyEntityOnlySweep(OPEN_BEFORE, PRESENT_NOW);
  ok("the old comparison left no_conversions and rank_limited open because their campaign was still present",
    !legacy.includes("f2") && !legacy.includes("f3"), `old sweep would have closed ${legacy.join(", ")}`);
  const plan = planSweep(OPEN_BEFORE, PRESENT_NOW, NOW);
  const closed = plan.close.map((c) => c.row.id).sort();
  ok("the pair comparison closes both, and everything else the rules no longer raise",
    JSON.stringify(closed) === JSON.stringify(["f2", "f3", "f5", "f6", "f7"]), closed.join(", "));
  ok("a row still produced is untouched (the same entity can carry a row that stays)",
    !closed.includes("f1") && !closed.includes("f4"));
  ok("an entity id in one finding type is never evidence for another",
    planSweep([row("x", "no_conversions", "111", 9)], new Set([pairKey("111", "budget_limited")]), NOW).close.length === 1);
  ok("an empty present set closes every open row it is given (the caller guards the unread case)",
    planSweep(OPEN_BEFORE, new Set(), NOW).close.length === OPEN_BEFORE.length);
}

section("2. A rule update is named as one; a cleared condition is named as that");
{
  const plan = planSweep(OPEN_BEFORE, PRESENT_NOW, NOW);
  const byId = new Map(plan.close.map((c) => [c.row.id, c] as const));
  for (const id of ["f2", "f3", "f5", "f6"]) {
    const k = byId.get(id)!;
    ok(`${id}: raised under an older ruleset, so it says the rules moved`,
      k.kind === "rule_update" && k.reason.startsWith(`${RULE_UPDATE_PREFIX} (ruleset ${NOW})`) && !/cleared on its own/.test(k.reason), k.reason);
  }
  ok("the reason says which ruleset last raised it and that the account may have changed too",
    /last raised under ruleset 8/.test(byId.get("f2")!.reason) && /may also have changed/.test(byId.get("f2")!.reason));
  const cleared = byId.get("f7")!;
  ok("a row last raised under THIS ruleset is closed as the condition clearing, in the old words",
    cleared.kind === "cleared" && cleared.reason === CLEARED_REASON);
  ok("the rule-update reason is one sentence pair, with no figure and no id",
    !/\d{6,}/.test(ruleUpdateReason(8, 10)) && ruleUpdateReason(8, 10).split(". ").length === 2);
}

section("3. A rule that could not run is not a rule that found nothing");
{
  const open = [
    row("w1", "wasted_search_term", "111:wasted_terms", NOW),
    row("w2", "converting_search_term", "111:promote_terms", NOW),
    row("d1", "dead_keyword", "kw1", NOW),
    row("b1", "budget_limited", "222", NOW),
  ];
  const noNegatives = unrecheckableTypes({ negativesRead: false });
  const p1 = planSweep(open, new Set(), NOW, noNegatives);
  ok("negatives unread: waste and promotion rows stay open and are counted, not closed",
    p1.close.map((c) => c.row.id).sort().join() === "b1,d1" && p1.leftBecauseUnreadable.reduce((n, x) => n + x.count, 0) === 2);
  ok("…and each says why", p1.leftBecauseUnreadable.every((x) => /negative keywords could not be read/.test(x.why)));
  const cut = unrecheckableTypes({ negativesRead: true, keywordsTruncated: true, searchTermsTruncated: true });
  const p2 = planSweep(open, new Set(), NOW, cut);
  ok("a keyword report and a search-terms report that came back full protect their own types only",
    p2.close.map((c) => c.row.id).join() === "b1" && p2.leftBecauseUnreadable.length === 3);
  ok("nothing is protected when everything was read whole",
    unrecheckableTypes({ negativesRead: true }).size === 0 && planSweep(open, new Set(), NOW).close.length === 4);
}

section("4. An account the audit stopped reading is closed by name, behind a breaker");
{
  const norm = normaliseAccountId;
  const base: MappingState = { clientStatus: "active", mappingExists: true, mappingEnabled: true, mappingAccountId: "111-222-3333" };
  const grp = (clientId: string, accountId: string, openRows: number, state: Partial<MappingState>): OrphanGroup =>
    ({ clientId, platform: "google_ads", accountId, openRows, lastCheckedOn: "2026-10-01", state: { ...base, ...state } });
  const groups: OrphanGroup[] = [
    grp("a", "1112223333", 3, {}),                                   // audited this run
    grp("paused", "4445556666", 3, { clientStatus: "paused", mappingAccountId: "444-555-6666" }),
    grp("off", "7778889999", 2, { mappingEnabled: false, mappingAccountId: "777-888-9999" }),
    grp("moved", "1010101010", 2, { mappingAccountId: "2020202020" }),
    grp("none", "3030303030", 1, { mappingExists: false, mappingAccountId: null }),
    grp("race", "5050505050", 1, { mappingAccountId: "505-050-5050" }), // mapped, on, active: not an orphan
  ];
  const audited = new Set(["google_ads\u0000a\u00001112223333"]);
  const plan = planOrphanClosures(groups, audited, 40, norm);
  const names = plan.close.map((c) => c.group.clientId).sort().join();
  ok("paused, switched off, changed number and no mapping are closed; the audited and the still-mapped are not",
    names === "moved,none,off,paused", names);
  const reasons = new Map(plan.close.map((c) => [c.group.clientId, c.reason] as const));
  ok("every reason starts with the one prefix and names the cause",
    Array.from(reasons.values()).every((r) => r.startsWith(NOT_AUDITED_PREFIX))
    && /marked paused/.test(reasons.get("paused")!) && /switched off/.test(reasons.get("off")!)
    && /number has changed/.test(reasons.get("moved")!) && /no connector/.test(reasons.get("none")!));
  ok("…and says when it was last checked and that it comes back if the condition does",
    /last checked 2026-10-01/.test(reasons.get("paused")!) && /raised again/.test(reasons.get("paused")!));
  ok("a mapped, switched-on, active account is never closed on a question the module cannot explain",
    notAuditedWhy({ ...base, mappingAccountId: "505-050-5050" }, "5050505050", norm) === "still_mapped");
  const big = planOrphanClosures(groups, audited, 10, norm);
  ok(`more than ${Math.round(ORPHAN_SWEEP_MAX_SHARE * 100)}% of a book of 10+ open rows is a broken read, so nothing closes`,
    big.refused && big.close.length === 0 && /nothing was closed/.test(big.refusal ?? ""));
  ok("a small book is not held back by a share that means nothing there",
    !planOrphanClosures([grp("paused", "4445556666", 3, { clientStatus: "paused" })], new Set(), 4, norm).refused);
  ok("nothing orphaned closes nothing and says nothing", planOrphanClosures([], audited, 10, norm).close.length === 0);
  ok("the reason line is the same function everyone reads",
    notAuditedReason("mapping_off", "active", null).startsWith(NOT_AUDITED_PREFIX));
}

section("5. A machine closure comes back; a person's dismissal does not");
{
  const sweepReason = ruleUpdateReason(8, NOW);
  ok("an audit-closed rule-update row is a machine closure", isMachineClosure(ACTOR, sweepReason, ACTOR));
  ok("an audit-closed not-audited row is a machine closure", isMachineClosure(ACTOR, notAuditedReason("mapping_off", "active", null), ACTOR));
  ok("a person's dismissal is not, even with the same words", !isMachineClosure("sam@example.test", sweepReason, ACTOR));
  ok("the old cleared sentence is not re-opened by this (a cleared row returns only if its evidence moves)",
    !isMachineClosure(ACTOR, CLEARED_REASON, ACTOR));
  ok("a superseded row, closed by name for a sharper reading, is not", !isMachineClosure(ACTOR, "Replaced by a sharper reading of the same campaign.", ACTOR));
  ok("no reason, no closure", !isMachineClosure(ACTOR, null, ACTOR));
}

section("6. The receipt: counts that reconcile, outcomes that are never a nought");
{
  const accounting: AuditAccounting = {
    promotionsBlocked: [
      { term: "cbh", campaignId: "111", campaignName: "Branded", conversions: 2, costMicros: 10_000_000, by: { text: "cbh", matchType: "PHRASE", source: "campaign" } },
      { term: "cbh hamilton", campaignId: "111", campaignName: "Branded", conversions: 1, costMicros: 5_000_000, by: { text: "cbh", matchType: "PHRASE", source: "campaign" } },
    ],
    negativesRead: true, negativeSourcesUnread: [], landing: [],
    coreSearchesNotBlocked: [{ term: "recovery centers", campaignName: "Treatment Center Search", costMicros: 20_000_000, clicks: 9, block: { service: "addiction recovery centers", relation: "part_of" } }],
    wasteRowsNotRaised: [], budgetRoutedToClient: [{ campaignName: "Brand — Core", accountMonthlyCents: 600_000, approvedMonthlyCents: 600_000 }],
    targetHeld: [{ campaignName: "Branded", conversions: 13, strategy: "MAXIMIZE_CONVERSIONS" }],
    competitorKeywords: [{ campaignName: "Competitors", count: 3 }],
    keywordsStopped: [{ campaignName: "Treatment Center Search", text: "old rehab keyword", lastSpendOn: "2026-09-01" }],
  };
  const facts: RunFacts = {
    upserts: [
      { id: "u1", title: "Budget limited", outcome: "created" },
      { id: "u2", title: "Over target", outcome: "refreshed" },
      { id: "u3", title: "Dead keyword", outcome: "reopened" },
      { id: "u4", title: "Dismissed earlier", outcome: "left_dismissed" },
      { id: "u5", title: "In flight", outcome: "left_in_flight" },
    ],
    closed: [
      { id: "c1", title: "No conversions", why: "rule_update" }, { id: "c2", title: "Rank limited", why: "rule_update" },
      { id: "c3", title: "Gone", why: "cleared" }, { id: "c4", title: "Replaced", why: "replaced" },
    ],
    accounting,
    notRechecked: [{ findingType: "dead_keyword", count: 2, why: "the keyword report came back full, so keywords behind the cut were not read" }],
  };
  const s = buildRunSummary(facts);
  ok("raised counts the rows now waiting on a person: created + refreshed + reopened",
    s.counts.raised === s.counts.created + s.counts.refreshed + s.counts.reopened && s.counts.raised === 3);
  ok("rows left because they are decided or in flight are counted apart, never as raised", s.counts.leftDecided === 2);
  ok("closed rows are counted by cause", s.counts.closedRuleUpdate === 2 && s.counts.closedCleared === 1 && s.counts.closedReplaced === 1 && s.counts.closedNotAudited === 0);
  ok("what the audit left alone is counted from the same accounting the log prints",
    s.counts.blockedByNegative === 2 && s.counts.coreSearchesHeld === 1 && s.counts.competitorKeywords === 3 && s.counts.stoppedKeywords === 1
    && s.counts.heldForClient === 1 && s.counts.targetHeld === 1);
  ok("the ids of the raised rows are kept so the dashboard can reconcile the page against the run",
    s.raisedIds.join() === "u1,u2,u3");
  ok("every list carries names, and a left-alone record says what covered it",
    s.leftAlone.some((l) => l.kind === "blocked_by_negative" && /phrase negative "cbh"/.test(l.because))
    && s.leftAlone.some((l) => l.kind === "core_search" && /addiction recovery centers/.test(l.because)));
  ok("what could not be re-checked rides on the receipt, with the reason", s.notRechecked.length === 1 && /came back full/.test(s.notRechecked[0]!.why));
  ok("the stored keys are exactly the declared keys, and every count key is present",
    JSON.stringify(Object.keys(s).sort()) === JSON.stringify([...RUN_SUMMARY_KEYS].sort())
    && RUN_COUNT_KEYS.every((k) => typeof s.counts[k] === "number"));

  const many: RunFacts = {
    ...facts,
    upserts: Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}`, outcome: "refreshed" as const })),
    closed: Array.from({ length: 60 }, (_, i) => ({ id: `k${i}`, title: `Closed ${i}`, why: "cleared" as const })),
  };
  const m = buildRunSummary(many);
  ok("names are capped but a count never is", m.raised.length === RUN_RECORD_CAP && m.counts.raised === 60 && m.closed.length === RUN_RECORD_CAP && m.counts.closedCleared === 60);
  ok("the left-alone list is capped too", buildRunSummary({
    ...facts, accounting: { ...accounting, keywordsStopped: Array.from({ length: 90 }, (_, i) => ({ campaignName: "C", text: `k${i}`, lastSpendOn: "2026-09-01" })) },
  }).leftAlone.length === RUN_LEFT_ALONE_CAP);

  const empty = buildRunSummary({ ...facts, upserts: [], closed: [], notRechecked: [], accounting: { ...accounting, promotionsBlocked: [], coreSearchesNotBlocked: [], budgetRoutedToClient: [], targetHeld: [], competitorKeywords: [], keywordsStopped: [] } });
  ok("a read that produced nothing is all noughts in a record that SAYS it read; the outcome, not the counts, tells it from a read that did not happen",
    RUN_COUNT_KEYS.every((k) => empty.counts[k] === 0));
  ok("the four outcomes are the declared ones", RUN_OUTCOMES.join() === "read,read_nothing,failed,skipped");
  ok("a failure's reason is one line, trimmed, with a credential cut",
    failureReason(new Error("Request failed\n    at stack line\nBearer ya29.abcdefghijklmnop")) === "Request failed"
    && !/ya29/.test(failureReason(new Error("token Bearer ya29.abcdefghijklmnop rejected")))
    && !/abc123def456/.test(failureReason(new Error("rejected: Bearer abc123def456")))
    && failureReason(new Error("x".repeat(900))).length <= 240 && failureReason(new Error("")) === "the read failed");
}

section("7. No two rules emit one (type, entity) key in one run");
{
  // The unique index is (client, platform, account, entity_id, finding_type), so a
  // collision inside one evaluation would make the second upsert overwrite the
  // first and the run report two rows where one exists. The rules are read for the
  // entity id each emits; two different finding types may share an id (that is
  // what section 1 is about), the same type may not use one id for two rows.
  const src = readFileSync(new URL("./ads/rules.ts", import.meta.url), "utf8");
  const bare = Array.from(src.matchAll(/entityId: c\.id,[^\n]*\n[^\n]*\n?[^\n]*findingType: "([a-z_]+)"/g)).map((m) => m[1]!);
  ok("the three rules that key a row on the bare campaign id are still the three the sweep fix is written for",
    ["budget_limited", "rank_limited", "no_conversions"].every((t) => bare.includes(t)), bare.join(", "));
  const seen = new Set<string>();
  let dup = "";
  for (const r of OPEN_BEFORE) { const k = pairKey(r.entityId, r.findingType); if (seen.has(k)) dup = k; seen.add(k); }
  ok("the fixture's pairs are unique", dup === "");
}

// ── 8. The real store, against a throwaway schema ────────────────────────────
const dbUrl = process.env.ADS_VERIFY_DATABASE_URL;
if (!dbUrl) {
  section("8. The real store functions");
  console.log("  ⏭  skipped: ADS_VERIFY_DATABASE_URL is not set. Locally: `node scripts/test-db.mjs start` in the dashboard repo prints a URL.");
  console.log("     CI runs this section in the `ads-store` job against a Postgres service container.");
} else {
  await storeSection(dbUrl);
}

async function storeSection(url: string) {
  section("8. The real store functions, on a throwaway schema");
  const schema = `ads_verify_${Math.random().toString(36).slice(2, 10)}`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await c.query(`
      CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT, aliases TEXT, seo_domain TEXT);
      CREATE TABLE connector_mappings (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT, enabled BOOLEAN NOT NULL DEFAULT true);
      CREATE TABLE ads_findings (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
        entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, entity_name TEXT, finding_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', severity TEXT NOT NULL DEFAULT 'medium', risk_level TEXT NOT NULL DEFAULT 'low',
        applicability TEXT NOT NULL DEFAULT 'vendor', title TEXT NOT NULL, summary TEXT, evidence_json TEXT, evidence_hash TEXT,
        window_start TEXT, window_end TEXT, est_impact_cents INTEGER, impact_unit TEXT DEFAULT 'usd_month', impact_assumption TEXT,
        change_payload_json TEXT, guard_note TEXT, ruleset_version INTEGER NOT NULL DEFAULT 1, narrative_engine TEXT NOT NULL DEFAULT 'rules',
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), times_seen INTEGER NOT NULL DEFAULT 1,
        proposed_at TIMESTAMPTZ, dismissed_by TEXT, dismissed_at TIMESTAMPTZ, dismissed_reason TEXT,
        rank_cents INTEGER, rank_basis TEXT, rank_why TEXT);
      CREATE UNIQUE INDEX uq_ads_findings_key ON ads_findings (client_id, platform, account_id, entity_id, finding_type);
      CREATE TABLE ads_finding_events (id TEXT PRIMARY KEY, finding_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, note TEXT, detail_json TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE ads_audit_runs (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL, ran_at TIMESTAMPTZ NOT NULL DEFAULT now(), ruleset_version INTEGER NOT NULL,
        scoped BOOLEAN NOT NULL DEFAULT false, outcome TEXT NOT NULL, reason TEXT, summary_json TEXT);
    `);

    const finding = (findingType: string, entityId: string, title: string, over: Partial<DerivedFinding> = {}): DerivedFinding => ({
      entityType: "campaign", entityId, entityName: title, findingType, severity: "medium", riskLevel: "low", applicability: "vendor",
      title, summary: "x", evidence: { metrics: { n: 1 }, windowStart: "2026-07-01", windowEnd: "2026-09-30", lines: [] },
      estImpactCents: 1000, impactUnit: "usd_month", impactAssumption: "x", changePayload: null, guardNote: "x", ...over,
    } as DerivedFinding);
    const seed = async (clientId: string, accountId: string, f: DerivedFinding, ruleset: number) => {
      const r = await upsertFinding(c, clientId, "google_ads", accountId, f, ACTOR);
      await c.query(`UPDATE ads_findings SET ruleset_version = $2 WHERE id = $1`, [r.id, ruleset]);
      return r.id;
    };
    const statusOf = async (id: string) => (await c.query<{ status: string; dismissed_reason: string | null; dismissed_by: string | null }>(
      `SELECT status, dismissed_reason, dismissed_by FROM ads_findings WHERE id = $1`, [id])).rows[0]!;

    for (const [id, name, status] of [["A", "Och Like", "active"], ["B", "Other Client", "active"], ["P", "Paused Client", "paused"], ["O", "Off Client", "active"], ["M", "Moved Client", "active"]]) {
      await c.query(`INSERT INTO clients (id, name, status) VALUES ($1,$2,$3)`, [id, name, status]);
    }
    await c.query(`INSERT INTO connector_mappings (id, client_id, source, external_id, enabled) VALUES
      ('mA','A','google_ads','111-111-1111',true), ('mB','B','google_ads','222-222-2222',true),
      ('mP','P','google_ads','333-333-3333',true), ('mO','O','google_ads','444-444-4444',false), ('mM','M','google_ads','666-666-6666',true)`);

    // A's book from before ruleset 10.
    const A = "1111111111";
    const a = {
      budget: await seed("A", A, finding("budget_limited", "111", "Brand — Core budget"), 9),
      noconv: await seed("A", A, finding("no_conversions", "111", "No conversions"), 8),
      rank: await seed("A", A, finding("rank_limited", "111", "Rank limited"), 9),
      cpa: await seed("A", A, finding("cpa_above_target", "111:cost_target", "Over target"), 9),
      waste: await seed("A", A, finding("wasted_search_term", "111:wasted_terms", "Wasted searches"), 9),
      stale: await seed("A", A, finding("low_quality_score", "1111111111:low_quality_score", "Quality scores"), NOW),
    };
    const approved = await seed("A", A, finding("thin_ad_group", "1111111111:thin_ad_groups", "Thin ad groups"), 8);
    await c.query(`UPDATE ads_findings SET status = 'approved' WHERE id = $1`, [approved]);
    const personDismissed = await seed("A", A, finding("weak_ad_strength", "1111111111:weak_ad_strength", "Ad strength"), 8);
    await c.query(`UPDATE ads_findings SET status = 'dismissed', dismissed_by = 'sam@example.test', dismissed_reason = 'not now' WHERE id = $1`, [personDismissed]);
    // B's rows must never move in A's scoped run.
    const bRow = await seed("B", "2222222222", finding("no_conversions", "222", "B no conversions"), 8);

    section("8a. The second run, after a ruleset change, on the real store");
    const present = new Set([pairKey("111", "budget_limited"), pairKey("111:cost_target", "cpa_above_target")]);
    const swept = await sweepResolved(c, "A", "google_ads", A, present, ACTOR, { currentRuleset: NOW, unrecheckable: unrecheckableTypes({ negativesRead: true }) });
    const closedIds = swept.closed.map((x) => x.id).sort();
    ok("it closes no_conversions and rank_limited although their campaign still carries a budget row",
      closedIds.includes(a.noconv) && closedIds.includes(a.rank), closedIds.length + " closed");
    ok("it closes the other rows the rules no longer raise", closedIds.includes(a.waste) && closedIds.includes(a.stale));
    ok("it leaves the two rows the rules still raise open",
      (await statusOf(a.budget)).status === "open" && (await statusOf(a.cpa)).status === "open");
    const nc = await statusOf(a.noconv);
    ok("the stored reason is the rule-update sentence and the actor is the audit",
      nc.status === "dismissed" && nc.dismissed_by === ACTOR && nc.dismissed_reason!.startsWith(`${RULE_UPDATE_PREFIX} (ruleset ${NOW})`));
    ok("a row last raised under this ruleset keeps the old cleared sentence", (await statusOf(a.stale)).dismissed_reason === CLEARED_REASON);
    ok("an approved row and a person's dismissal are not touched",
      (await statusOf(approved)).status === "approved" && (await statusOf(personDismissed)).dismissed_reason === "not now");
    ok("another client's rows are not touched by this account's sweep", (await statusOf(bRow)).status === "open");
    const ev = await c.query(`SELECT count(*)::int AS n FROM ads_finding_events WHERE finding_id = $1`, [a.noconv]);
    ok("status history stays: the detection event is still there beside the closing one", ev.rows[0].n === 2, `${ev.rows[0].n} events`);
    ok("nothing was deleted", (await c.query(`SELECT count(*)::int AS n FROM ads_findings`)).rows[0].n === 9);
    ok("the result reports the closures by cause, for the receipt",
      swept.closed.filter((x) => x.why === "rule_update").length === 3 && swept.closed.filter((x) => x.why === "cleared").length === 1);

    section("8b. A rule that could not run closes nothing");
    const w2 = await seed("A", A, finding("wasted_search_term", "222:wasted_terms", "Wasted, second campaign"), 9);
    const held = await sweepResolved(c, "A", "google_ads", A, present, ACTOR, { currentRuleset: NOW, unrecheckable: unrecheckableTypes({ negativesRead: false }) });
    ok("with the negatives unread the waste row stays open and is counted as not re-checked",
      (await statusOf(w2)).status === "open" && held.notRechecked.some((n) => n.findingType === "wasted_search_term" && n.count === 1));

    section("8c. A machine closure comes back; a person's dismissal does not");
    const back = await upsertFinding(c, "A", "google_ads", A, finding("no_conversions", "111", "No conversions"), ACTOR);
    ok("the rule raises it again and the audit's own closure does not keep it shut behind an unchanged hash", back.outcome === "reopened" && (await statusOf(a.noconv)).status === "open");
    const stay = await upsertFinding(c, "A", "google_ads", A, finding("weak_ad_strength", "1111111111:weak_ad_strength", "Ad strength"), ACTOR);
    ok("a person's dismissal with the same evidence stays dismissed", stay.outcome === "left_dismissed");

    section("8d. Accounts the audit does not read");
    const pRows = [await seed("P", "3333333333", finding("budget_limited", "p1", "P budget"), NOW), await seed("P", "3333333333", finding("no_conversions", "p1", "P noconv"), NOW)];
    const oRow = await seed("O", "4444444444", finding("budget_limited", "o1", "O budget"), NOW);
    const mRow = await seed("M", "5555555555", finding("budget_limited", "m1", "M budget under the old number"), NOW);
    const audited = new Set([`google_ads\u0000A\u0000${A}`, `google_ads\u0000B\u00002222222222`, `google_ads\u0000M\u00006666666666`]);
    // Nine open rows in the book, four of them orphans: under the breaker's minimum book, so it is not in play.
    const orphan = await sweepUnauditedAccounts(c, audited, ACTOR);
    ok("paused, switched-off and changed-number accounts are closed", !orphan.plan.refused && orphan.closedByGroup.length === 3);
    ok("each row says why, in the one prefix",
      (await statusOf(pRows[0]!)).dismissed_reason!.startsWith(NOT_AUDITED_PREFIX) && /marked paused/.test((await statusOf(pRows[0]!)).dismissed_reason!)
      && /switched off/.test((await statusOf(oRow)).dismissed_reason!) && /number has changed/.test((await statusOf(mRow)).dismissed_reason!));
    ok("an audited account's open rows are not touched", (await statusOf(bRow)).status === "open" && (await statusOf(a.budget)).status === "open");
    await c.query(`UPDATE clients SET status = 'active' WHERE id = 'P'`);
    const again = await upsertFinding(c, "P", "google_ads", "3333333333", finding("budget_limited", "p1", "P budget"), ACTOR);
    ok("when the client is active again and the condition is still there, the row is raised again", again.outcome === "reopened");

    section("8e. The breaker");
    await c.query(`UPDATE ads_findings SET status = 'open', dismissed_by = NULL, dismissed_reason = NULL WHERE client_id IN ('O','M')`);
    for (let i = 0; i < 8; i++) await seed("O", "4444444444", finding("budget_limited", `o-extra-${i}`, `O extra ${i}`), NOW);
    const tripped = await sweepUnauditedAccounts(c, new Set(), ACTOR);
    ok("when the orphans are most of the book nothing is closed and the run says why",
      tripped.plan.refused && tripped.closedByGroup.length === 0 && (await statusOf(oRow)).status === "open");

    section("8f. The receipt");
    const summary = buildRunSummary({ upserts: [{ id: a.budget, title: "Brand — Core budget", outcome: "refreshed" }], closed: swept.closed, accounting: {
      promotionsBlocked: [], negativesRead: true, negativeSourcesUnread: [], landing: [], coreSearchesNotBlocked: [], wasteRowsNotRaised: [],
      budgetRoutedToClient: [], targetHeld: [], competitorKeywords: [], keywordsStopped: [] }, notRechecked: [] });
    for (let i = 0; i < 11; i++) {
      const w = await writeRunRecord(c, { clientId: "A", platform: "google_ads", accountId: A, startedAt: new Date(Date.now() - i * 1000), outcome: "read", reason: null, scoped: i % 2 === 0, ruleset: NOW, summary });
      if (w) { ok("a record writes", false, w); break; }
    }
    const kept = await c.query(`SELECT count(*)::int AS n FROM ads_audit_runs WHERE client_id = 'A'`);
    ok("only the last eight records per account are kept", kept.rows[0].n === 8);
    const stored = (await c.query<{ summary_json: string }>(`SELECT summary_json FROM ads_audit_runs WHERE client_id = 'A' LIMIT 1`)).rows[0]!;
    ok("the stored JSON parses back to the summary", JSON.parse(stored.summary_json).counts.raised === 1);
    await writeRunRecord(c, { clientId: "A", platform: "google_ads", accountId: A, startedAt: new Date(), outcome: "failed", reason: "Request failed", scoped: false, ruleset: NOW, summary: null });
    const failedRow = (await c.query(`SELECT outcome, reason, summary_json FROM ads_audit_runs WHERE outcome = 'failed'`)).rows[0];
    ok("a failed read is a record with a reason and no summary, never a row of noughts", failedRow.reason === "Request failed" && failedRow.summary_json === null);
    await c.query(`ALTER TABLE ads_audit_runs RENAME TO ads_audit_runs_gone`);
    const missing = await writeRunRecord(c, { clientId: "A", platform: "google_ads", accountId: A, startedAt: new Date(), outcome: "read", reason: null, scoped: false, ruleset: NOW, summary });
    ok("a missing table is a sentence for the log and never throws into the audit", typeof missing === "string" && /not written/.test(missing));
    const s2 = await supersedeFindings(c, "A", "google_ads", A, [], ACTOR);
    ok("supersede with nothing to replace returns nothing", s2.length === 0);
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
}

console.log("\n" + "─".repeat(72));
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");

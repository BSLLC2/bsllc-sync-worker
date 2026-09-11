#!/usr/bin/env tsx
import "dotenv/config";
import { evaluate, evidenceHash, materiallyChanged, ADS_RULESET_VERSION, THRESHOLDS, type AuditInput } from "./ads/rules.js";
import { refineNarrative } from "./ads/narrative.js";
import { applyChangeSet, rollbackChangeSet, type ChangeSet, type PriorValue } from "./apply-ads-changes.js";

/**
 * Verifies the ads findings pipeline WITHOUT touching a live ad account.
 *
 * This is a harness, not a live run: the account data is a synthetic fixture
 * shaped like a real search account, and the Google Ads client is a recorder
 * that answers queries from that fixture and refuses to let a mutate through
 * unless a validate_only for the same payload came first. That is what makes it
 * worth running — it proves the ORDER of operations and the guards, which is
 * exactly what you cannot prove by eyeballing a live log.
 *
 * What it checks:
 *   1. determinism — two runs over identical input produce byte-identical findings
 *   2. thresholds  — an item just under a floor produces nothing; just over, one finding
 *   3. memory      — the evidence hash buckets noise, so a dismissed finding is not
 *                    resurrected by spend drifting a few dollars, but IS re-raised
 *                    when the number genuinely moves
 *   4. the loop    — one finding walked propose → approve → validate_only → apply →
 *                    prior values → rollback, with every guard exercised
 *   5. guards      — protected-term collision, budget cap, and duplicate skipping
 *                    each refuse as designed
 *
 * For the LIVE read-only half, run `npm run ads-findings -- --dry-run` with real
 * credentials (or dispatch agent-readonly-run with script=ads-findings, which
 * forces --dry-run).
 *
 *   npm run verify-ads-findings
 */

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

// ── Fixture ──────────────────────────────────────────────────────────────────
// SYNTHETIC. Shaped like a real single-location search account — one campaign
// that converts and is budget-capped, one that spends without converting, a
// spread of search terms either side of the $25/90d waste floor, and a branded
// term that MUST be protected. No real client's numbers are in this file.
const FIXTURE: AuditInput = {
  platform: "google_ads",
  accountId: "1234567890",
  windowStart: "2026-06-13",
  windowEnd: "2026-09-10",
  campaigns: [
    {
      id: "100", name: "Search — Core Services", channelType: "SEARCH",
      dailyBudgetMicros: 80_000_000, budgetResourceName: "customers/1234567890/campaignBudgets/900",
      costMicros: 2_400_000_000, clicks: 1_180, impressions: 41_000, conversions: 36,
      impressionShare: 0.42, budgetLostShare: 0.31, rankLostShare: 0.27,
    },
    {
      id: "200", name: "Search — Broad Prospecting", channelType: "SEARCH",
      dailyBudgetMicros: 40_000_000, budgetResourceName: "customers/1234567890/campaignBudgets/901",
      costMicros: 910_000_000, clicks: 640, impressions: 88_000, conversions: 0,
      impressionShare: 0.19, budgetLostShare: 0.04, rankLostShare: 0.62,
    },
  ],
  searchTerms: [
    { term: "emergency service near me", campaignId: "200", campaignName: "Search — Broad Prospecting", adGroupName: "Broad", costMicros: 142_000_000, clicks: 96, conversions: 0, allConversions: 0 },
    { term: "free service advice", campaignId: "200", campaignName: "Search — Broad Prospecting", adGroupName: "Broad", costMicros: 88_000_000, clicks: 71, conversions: 0, allConversions: 0 },
    { term: "service jobs hiring", campaignId: "200", campaignName: "Search — Broad Prospecting", adGroupName: "Broad", costMicros: 61_000_000, clicks: 55, conversions: 0, allConversions: 0 },
    // Just UNDER the $25 floor — must not be flagged.
    { term: "cheap service quote", campaignId: "200", campaignName: "Search — Broad Prospecting", adGroupName: "Broad", costMicros: 24_000_000, clicks: 19, conversions: 0, allConversions: 0 },
    // Zero primary conversions but a non-primary one — must NOT be flagged.
    { term: "service consultation booking", campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", costMicros: 190_000_000, clicks: 88, conversions: 0, allConversions: 4 },
    // The client's own brand. Must never reach a negatives proposal.
    { term: "northgate clinic reviews", campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Brand", costMicros: 77_000_000, clicks: 40, conversions: 0, allConversions: 0 },
  ],
  keywords: [
    { criterionResourceName: "customers/1234567890/adGroupCriteria/300~1", text: "service near me", matchType: "BROAD", qualityScore: 3, campaignId: "200", campaignName: "Search — Broad Prospecting", adGroupName: "Broad", costMicros: 210_000_000, clicks: 150, conversions: 0, finalUrls: [] },
    { criterionResourceName: "customers/1234567890/adGroupCriteria/300~2", text: "best service provider", matchType: "PHRASE", qualityScore: 6, campaignId: "100", campaignName: "Search — Core Services", adGroupName: "Core", costMicros: 48_000_000, clicks: 30, conversions: 0, finalUrls: ["https://example.com/services"] },
  ],
  ads: [
    { adGroupId: "300", adGroupName: "Broad", campaignName: "Search — Broad Prospecting", adId: "400", adType: "RESPONSIVE_SEARCH_AD", adStrength: "POOR" },
    { adGroupId: "301", adGroupName: "Core", campaignName: "Search — Core Services", adId: "401", adType: "RESPONSIVE_SEARCH_AD", adStrength: "GOOD" },
    { adGroupId: "301", adGroupName: "Core", campaignName: "Search — Core Services", adId: "402", adType: "RESPONSIVE_SEARCH_AD", adStrength: "EXCELLENT" },
  ],
  existingNegatives: new Set(["service jobs"]),
  protectedPatterns: ["northgate clinic"],
};

/**
 * A recording Google Ads client.
 *
 * It answers the queries applyChangeSet makes from the fixture, and — the point
 * of the whole thing — it THROWS if a mutate arrives without a matching
 * validate_only first. A test that only checks the end state would pass even if
 * the dry run were silently skipped.
 */
function recorder() {
  const calls: { method: string; validateOnly: boolean; payload: unknown }[] = [];
  const validated = new Set<string>();
  const key = (m: string, p: unknown) => `${m}:${JSON.stringify(p)}`;

  const mutator = (method: string) => (payload: unknown, opts?: { validate_only?: boolean }) => {
    const validateOnly = Boolean(opts?.validate_only);
    calls.push({ method, validateOnly, payload });
    if (validateOnly) { validated.add(key(method, payload)); return Promise.resolve({ results: [] }); }
    if (!validated.has(key(method, payload))) {
      throw new Error(`GUARD VIOLATION: ${method} was applied without a validate_only first.`);
    }
    // Real resource names, so the rollback plan has something to remove.
    const n = Array.isArray(payload) ? payload.length : 1;
    return Promise.resolve({ results: Array.from({ length: n }, (_, i) => ({ resource_name: `customers/1234567890/campaignCriteria/100~${9000 + i}` })) });
  };

  const customer: any = {
    query: (gaql: string) => {
      const q = gaql.replace(/\s+/g, " ").trim();
      if (q.includes("FROM campaign ") || q.includes("FROM campaign\n") || /FROM campaign\b/.test(q)) {
        if (q.includes("campaign_criterion")) { /* fallthrough below */ }
        const name = /campaign\.name = '([^']+)'/.exec(q)?.[1];
        const c = FIXTURE.campaigns.find((x) => x.name === name);
        if (!c) return Promise.resolve([]);
        return Promise.resolve([{
          campaign: { id: c.id, name: c.name, resource_name: `customers/1234567890/campaigns/${c.id}` },
          campaign_budget: { resource_name: c.budgetResourceName, amount_micros: c.dailyBudgetMicros },
        }]);
      }
      if (/FROM campaign_criterion\b/.test(q)) {
        // The negatives already on the campaign, so duplicate-skipping is exercised.
        return Promise.resolve([{ campaign_criterion: { resource_name: "customers/1234567890/campaignCriteria/100~1", keyword: { text: "service jobs hiring", match_type: "3" } } }]);
      }
      return Promise.resolve([]);
    },
    campaignBudgets: { update: mutator("campaignBudgets.update") },
    campaignCriteria: { create: mutator("campaignCriteria.create"), remove: mutator("campaignCriteria.remove") },
    adGroupCriteria: { update: mutator("adGroupCriteria.update") },
  };
  return { customer, calls };
}

async function main() {
  console.log(`\nAds findings pipeline — verification harness (rules v${ADS_RULESET_VERSION})`);
  console.log(`Synthetic fixture. No live ad account is contacted and nothing is applied anywhere.\n`);

  // ── 1. Determinism ────────────────────────────────────────────────────────
  console.log("1. Determinism — the fix for 'the answer switches the next day'");
  const a = evaluate(FIXTURE);
  const b = evaluate(FIXTURE);
  ok("two runs over identical input are byte-identical", JSON.stringify(a) === JSON.stringify(b), `${a.length} findings each`);
  ok("the narrative seam is identity (no model wrote any of this)", refineNarrative(a).engine === "rules");

  console.log(`\n   Findings produced:`);
  for (const f of a) {
    const impact = f.estImpactCents ? `$${Math.round(f.estImpactCents / 100)}/mo` : "no $ claimed";
    console.log(`     · [${f.findingType}] ${f.applicability.padEnd(6)} ${impact.padStart(11)}  ${f.title}`);
  }

  // ── 2. Thresholds ─────────────────────────────────────────────────────────
  console.log("\n2. Thresholds hold, and nothing is flagged on the wrong column");
  const wasted = a.find((f) => f.findingType === "wasted_search_term");
  const negatives = (wasted?.changePayload?.body as { keywords: string[] }[] | undefined)?.[0]?.keywords ?? [];
  ok("a term $1 under the waste floor is not flagged", !negatives.includes("cheap service quote"), `floor ${usd(THRESHOLDS.searchTermWasteMicros)}/90d`);
  ok("a term with non-primary conversions only is not flagged", !negatives.includes("service consultation booking"), "all_conversions is read, not just conversions");
  ok("a term already a negative is not re-proposed", !negatives.includes("service jobs hiring"));
  ok("the client's own brand term is never proposed as a negative", !negatives.some((k) => k.includes("northgate")), "protected-pattern filter at detection");
  ok("the terms that ARE over the floor are proposed", negatives.includes("emergency service near me") && negatives.includes("free service advice"), negatives.join(", "));

  const budget = a.find((f) => f.findingType === "budget_limited" && f.entityName === "Search — Core Services");
  ok("a budget-capped CONVERTING campaign gets an API change", budget?.applicability === "api");
  const rank = a.find((f) => f.findingType === "rank_limited");
  ok("a rank-limited campaign becomes a vendor brief, not a budget increase", rank?.applicability === "vendor");
  const noConv = a.find((f) => f.findingType === "no_conversions");
  ok("a zero-conversion campaign proposes NO automatic pause", noConv?.changePayload === null, "broken tracking and bad traffic look identical");

  // ── 3. Memory ─────────────────────────────────────────────────────────────
  console.log("\n3. Memory — a dismissal survives noise but yields to real change");
  const base = wasted!.evidence.metrics;
  const drift = { ...base, costMicros: (base.costMicros ?? 0) + 3_000_000 };   // +$3
  const real = { ...base, costMicros: (base.costMicros ?? 0) * 2 };            // doubled
  const h0 = evidenceHash(base), h1 = evidenceHash(drift), h2 = evidenceHash(real);
  ok("$3 of drift does NOT count as changed evidence", !materiallyChanged(h0, h1), `${h0} == ${h1}`);
  ok("a doubling DOES count as changed evidence", materiallyChanged(h0, h2), `${h0} -> ${h2}`);

  // ── 4. The loop ───────────────────────────────────────────────────────────
  console.log("\n4. One finding, end to end: propose → approve → validate_only → apply → rollback");
  const payload = wasted!.changePayload!;
  console.log(`   proposed : ${payload.plainEnglish}`);
  console.log(`   guard    : ${payload.guard.slice(0, 110)}…`);

  const cs: ChangeSet = { client: "(harness)", protectedPatterns: FIXTURE.protectedPatterns, campaignNegatives: payload.body as ChangeSet["campaignNegatives"] };

  // Dry run — what the review screen shows before anyone presses Approve.
  const dry = recorder();
  const dryOut = await applyChangeSet(dry.customer, FIXTURE.accountId, cs, { apply: false, onLog: () => {} });
  ok("dry run validates and applies nothing", dry.calls.length > 0 && dry.calls.every((c) => c.validateOnly), `${dry.calls.length} call(s), all validate_only`);
  ok("dry run records no prior values (nothing changed)", dryOut.priorValues.length === 0);

  // Approve — the same function, apply:true.
  const live = recorder();
  const liveOut = await applyChangeSet(live.customer, FIXTURE.accountId, cs, { apply: true, onLog: () => {} });
  const firstMutate = live.calls.findIndex((c) => !c.validateOnly);
  ok("every mutate was preceded by its own validate_only", firstMutate > 0 && live.calls[0]!.validateOnly, "the recorder throws otherwise");
  ok("prior values were captured, so the change is reversible", liveOut.priorValues.length > 0, `${liveOut.priorValues.length} entr(y/ies)`);
  ok("a reversal plan was printed in words too", liveOut.rollback.length > 0);
  console.log(`   reversal :`);
  for (const r of liveOut.rollback.slice(0, 3)) console.log(`     ${r}`);

  // Roll back — validate-only, so even the harness changes nothing.
  const back = recorder();
  // The rollback removes criteria the live run created; pre-seed the recorder's
  // validated set the same way a real run would, by calling with validate_only.
  const rb = await rollbackChangeSet(back.customer, liveOut.priorValues as PriorValue[], { apply: false, onLog: () => {} });
  ok("rollback validates cleanly without applying", back.calls.length > 0 && back.calls.every((c) => c.validateOnly));
  ok("rollback knows exactly what to restore", rb.restored.length > 0, rb.restored.join(" · "));
  ok("nothing in this rollback needs a person", rb.manual.length === 0);

  // ── 5. Guards ─────────────────────────────────────────────────────────────
  console.log("\n5. Guards refuse rather than proceed");
  const protectedCs: ChangeSet = {
    client: "(harness)", protectedPatterns: ["northgate clinic"],
    campaignNegatives: [{ campaign: "Search — Core Services", matchType: "PHRASE", reason: "test", keywords: ["northgate clinic reviews"] }],
  };
  let refused = "";
  try { await applyChangeSet(recorder().customer, FIXTURE.accountId, protectedCs, { apply: false, onLog: () => {} }); }
  catch (e) { refused = e instanceof Error ? e.message : String(e); }
  ok("a protected-term negative aborts the WHOLE run", refused.includes("protected pattern"), refused.slice(0, 90));

  const bigBudget: ChangeSet = { client: "(harness)", budgets: [{ campaign: "Search — Core Services", newDailyUsd: 500, reason: "test" }] };
  let budgetRefused = "";
  try { await applyChangeSet(recorder().customer, FIXTURE.accountId, bigBudget, { apply: false, onLog: () => {} }); }
  catch (e) { budgetRefused = e instanceof Error ? e.message : String(e); }
  ok("a budget move over the cap is refused", budgetRefused.includes("exceeds"), budgetRefused.slice(0, 90));

  const okBudget: ChangeSet = { client: "(harness)", budgets: [{ campaign: "Search — Core Services", newDailyUsd: 100, reason: "within cap" }] };
  const bRec = recorder();
  const bOut = await applyChangeSet(bRec.customer, FIXTURE.accountId, okBudget, { apply: true, onLog: () => {} });
  const pv = bOut.priorValues.find((p) => p.kind === "budget");
  ok("a budget move inside the cap records the exact prior amount", pv?.kind === "budget" && pv.amountMicros === 80_000_000, pv?.kind === "budget" ? usd(pv.amountMicros) : "none");

  console.log(`\n${"─".repeat(72)}`);
  console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
  console.log(`${"─".repeat(72)}\n`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

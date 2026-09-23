#!/usr/bin/env tsx
/**
 * Guard for the reversal planner.
 *
 * No database and no ad account: it drives the real functions over fixtures.
 * EVERY FIGURE, CAMPAIGN NAME AND KEYWORD HERE IS INVENTED — there is no
 * production database in this sandbox, and no address of anybody's appears in
 * a fixture at all, because this module never reads one.
 *
 *   npx tsx src/verify-ads-reversal.ts
 */
import { readFileSync } from "node:fs";
import {
  planReversal, reversalRefusalLine, REVERSAL_REFUSALS,
  MAX_BUDGET_DELTA_USD, MAX_BUDGET_FACTOR,
  type ReversalFacts, type StoredChange,
} from "./ads/change-reversal.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);

const WINDOW_START = new Date("2026-09-15T00:00:00.000Z");
const WINDOW_END = new Date("2026-09-20T23:59:59.000Z");

const ev = (over: Partial<StoredChange> = {}): StoredChange => ({
  eventKey: `k${Math.random().toString(36).slice(2, 8)}`,
  changedAt: "2026-09-17T10:00:00.000Z",
  resourceType: "CAMPAIGN_BUDGET",
  operation: "UPDATE",
  changedFields: "amount_micros",
  campaignId: "222222",
  adGroupId: null,
  oldResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "100000000" } }),
  newResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "140000000" } }),
  ...over,
});

const facts = (over: Partial<ReversalFacts> = {}): ReversalFacts => ({
  windowStart: WINDOW_START,
  windowEnd: WINDOW_END,
  events: [ev()],
  coverage: { coveredFrom: "2026-09-01", coveredTo: "2026-09-21", ok: true },
  campaignNames: { "222222": "Brand — Search" },
  ...over,
});

hr("1. A budget somebody moved goes back through the guarded path");
{
  const p = planReversal(facts());
  ok("one reversal is proposed", p.reversible.length === 1, `${p.reversible.length}`);
  const item = p.reversible[0]!;
  ok("it is a budgets op and nothing else", item.op === "budgets");
  const body = (item.body as any[])[0];
  ok("it addresses the campaign by NAME, which is what the apply path takes", body.campaign === "Brand — Search");
  ok("it puts back the value the change moved FROM", body.newDailyUsd === 100);
  ok(
    "it carries fromDailyMicros set to what the change left it AT, so the staleness guard refuses a budget somebody has moved since",
    body.fromDailyMicros === 140000000,
  );
  ok("the sentence names both figures", /\$100\.00/.test(item.what) && /\$140\.00/.test(item.what));
  ok("nothing is claimed about what it is worth", item.caution === null);
}

hr("2. Three changes to one thing collapse into ONE proposal");
{
  const p = planReversal(facts({
    events: [
      ev({ changedAt: "2026-09-16T09:00:00.000Z", oldResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "100000000" } }), newResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "110000000" } }) }),
      ev({ changedAt: "2026-09-17T09:00:00.000Z", oldResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "110000000" } }), newResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "120000000" } }) }),
      ev({ changedAt: "2026-09-18T09:00:00.000Z", oldResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "120000000" } }), newResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "130000000" } }) }),
    ],
  }));
  ok("one proposal, not three", p.reversible.length === 1, `${p.reversible.length}`);
  const body = (p.reversible[0]!.body as any[])[0];
  ok("it goes back to what the OLDEST change moved from", body.newDailyUsd === 100);
  ok("and the guard input is what the NEWEST change left it at", body.fromDailyMicros === 130000000);
  ok("the row says how many changes it covers", p.reversible[0]!.changes === 3);
}

hr("3. A change made and undone inside the window is a no-op");
{
  const p = planReversal(facts({
    events: [
      ev({ changedAt: "2026-09-16T09:00:00.000Z", oldResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "100000000" } }), newResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "200000000" } }) }),
      ev({ changedAt: "2026-09-17T09:00:00.000Z", oldResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "200000000" } }), newResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "100000000" } }) }),
    ],
  }));
  ok("nothing is proposed", p.reversible.length === 0);
  ok("and it is NAMED rather than dropped", p.blocked.some((b) => b.reason === "nets_to_nothing"));
}

hr("4. The apply path's caps are respected, never bypassed");
{
  const p = planReversal(facts({
    events: [ev({
      oldResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "500000000" } }),
      newResourceJson: JSON.stringify({ campaignBudget: { amountMicros: "50000000" } }),
    })],
  }));
  ok("a restore beyond the caps is not proposed", p.reversible.length === 0);
  ok("it is named as needing a person", p.blocked.some((b) => b.reason === "budget_cap"));
  ok("the sentence quotes the real caps", p.blocked[0]!.why.includes(`${MAX_BUDGET_FACTOR}x`) && p.blocked[0]!.why.includes(`$${MAX_BUDGET_DELTA_USD}`));

  const src = readFileSync(new URL("./ads/change-reversal.ts", import.meta.url), "utf8");
  ok("the planner never imports the apply path", !/from\s+["'].*apply-ads-changes/.test(src));
  ok("SELF-TEST: a planted import of the apply path is caught", /from\s+["'].*apply-ads-changes/.test(`import { applyChangeSet } from "../apply-ads-changes.js";`));
  const apply = readFileSync(new URL("./apply-ads-changes.ts", import.meta.url), "utf8");
  ok("the apply path still validates before every mutate", (apply.match(/validate_only: true/g) ?? []).length >= 6);
  ok("the apply path still caps a budget at 2x and $100/day", /MAX_BUDGET_FACTOR = 2/.test(apply) && /MAX_BUDGET_DELTA_USD = 100/.test(apply));
  ok("the apply path still refuses a budget with no recorded starting point", /carries no recorded starting budget — refused/.test(apply));
  ok("the apply path still aborts on a protected term", /collides with protected pattern/.test(apply));
}

hr("5. Negative keywords, both directions");
{
  const negative = (op: string, over: Partial<StoredChange> = {}): StoredChange => ev({
    resourceType: "CAMPAIGN_CRITERION",
    operation: op,
    changedFields: "keyword.text",
    oldResourceJson: op === "REMOVE" ? JSON.stringify({ campaignCriterion: { keyword: { text: "free", match_type: 3 } } }) : null,
    newResourceJson: op === "CREATE" ? JSON.stringify({ campaignCriterion: { keyword: { text: "free", match_type: 3 } } }) : null,
    ...over,
  });
  const added = planReversal(facts({ events: [negative("CREATE")] }));
  ok("a negative somebody added comes back off", added.reversible[0]?.op === "removeCampaignNegatives");
  ok("and the sentence says those searches can run again", /run again/.test(added.reversible[0]?.what ?? ""));

  const removed = planReversal(facts({ events: [negative("REMOVE")] }));
  ok("a negative somebody removed goes back on", removed.reversible[0]?.op === "campaignNegatives");
  const body = (removed.reversible[0]!.body as any[])[0];
  ok("with the match type DECODED from the enum integer, not the integer", body.matchType === "PHRASE", String(body.matchType));

  const noMatch = planReversal(facts({
    events: [negative("REMOVE", { oldResourceJson: JSON.stringify({ campaignCriterion: { keyword: { text: "free" } } }) })],
  }));
  ok("a removal with no recorded match type is refused rather than guessed", noMatch.blocked.some((b) => b.reason === "no_prior_value"));
}

hr("6. Keyword landing pages, and the shapes the apply path cannot write");
{
  const urlEv = (old: unknown): StoredChange => ev({
    resourceType: "AD_GROUP_CRITERION",
    operation: "UPDATE",
    changedFields: "final_urls",
    adGroupId: "333333",
    oldResourceJson: JSON.stringify({ adGroupCriterion: { keyword: { text: "blue widgets", match_type: 2 }, final_urls: old } }),
    newResourceJson: JSON.stringify({ adGroupCriterion: { keyword: { text: "blue widgets", match_type: 2 }, final_urls: ["https://example.invalid/new"] } }),
  });
  const one = planReversal(facts({ events: [urlEv(["https://example.invalid/old"])] }));
  ok("one previous URL goes back", one.reversible[0]?.op === "keywordFinalUrls");
  ok(
    "and the row says the apply path matches a keyword by TEXT across the account",
    /by its text/.test(one.reversible[0]?.caution ?? ""),
  );

  const inherited = planReversal(facts({ events: [urlEv([])] }));
  ok("a keyword that previously inherited the ad is refused, because the op can set a URL and not clear one", inherited.blocked.some((b) => b.reason === "url_shape_unsupported"));

  const several = planReversal(facts({ events: [urlEv(["https://example.invalid/a", "https://example.invalid/b"])] }));
  ok("more than one previous URL is refused, because the op writes exactly one", several.blocked.some((b) => b.reason === "url_shape_unsupported"));
}

hr("7. Everything the guarded path cannot write is NAMED, never skipped");
{
  const types = ["AD", "AD_GROUP", "CAMPAIGN", "AD_GROUP_BID_MODIFIER", "ASSET", "FEED"];
  const p = planReversal(facts({
    events: types.map((t) => ev({ resourceType: t, changedFields: "status", oldResourceJson: null, newResourceJson: null })),
  }));
  ok("none of them is proposed", p.reversible.length === 0);
  ok("every one appears as a refusal", p.blocked.length >= types.length - 1, `${p.blocked.length} refusals for ${types.length} kinds`);
  ok("each refusal says what to do instead", p.blocked.every((b) => /by hand|platform|cannot|already holds/i.test(b.why)));
  ok("the count of what was considered is reported", p.considered === types.length);

  const noPrior = planReversal(facts({ events: [ev({ oldResourceJson: null })] }));
  ok("a change Google recorded without a prior value is refused", noPrior.blocked.some((b) => b.reason === "no_prior_value"));
  ok("and the sentence says where the old value can still be read", /change history screen/.test(noPrior.blocked[0]!.why));

  const gone = planReversal(facts({ campaignNames: {} }));
  ok("a campaign nothing can name is refused rather than guessed", gone.blocked.some((b) => b.reason === "campaign_name_unknown"));
  ok("every refusal reason in the catalog has a sentence", REVERSAL_REFUSALS.every((r) => reversalRefusalLine(r).length > 20));
}

hr("8. COVERAGE. An uncovered window is never reported as put back");
{
  const none = planReversal(facts({ coverage: { coveredFrom: null, coveredTo: null, ok: null } }));
  ok("no captured history means the plan is incomplete", none.complete === false);
  ok("and the note says the window is unknown here", /unknown here/.test(none.coverageNote));
  ok("the summary refuses to call it a full list", /not all of it|not the same as nothing/.test(none.summary));

  const short = planReversal(facts({ coverage: { coveredFrom: "2026-09-18", coveredTo: "2026-09-21", ok: true } }));
  ok("coverage starting inside the window is incomplete", short.complete === false);
  ok("and says so in words", /does not span this window/.test(short.coverageNote));

  const failed = planReversal(facts({ coverage: { coveredFrom: "2026-09-01", coveredTo: "2026-09-21", ok: false } }));
  ok("a failed last capture is incomplete", failed.complete === false);
  ok("and names the date coverage stops at", /stops at 2026-09-21/.test(failed.coverageNote));

  const full = planReversal(facts());
  ok("full coverage is complete", full.complete === true);
  ok("SELF-TEST: reporting success over an uncovered window would be caught", planReversal(facts({ coverage: { coveredFrom: "2026-09-19", coveredTo: "2026-09-21", ok: true } })).complete === false);
}

hr("9. NO SENTENCE CLAIMS A RESTORE");
{
  // A CLAIM, not a denial. "it does not restore the account" is the sentence
  // this module is supposed to say, so the lookbehind lets that one through
  // and catches every assertion that the account has been put back.
  const RESTORE = /(?<!does not )\brestor(e|ed|es|ing)\b|\brelaunch|\brolled the account back\b|\bsnapshot\b|\bback to how it looked\b/i;
  const all = [
    planReversal(facts()).summary,
    planReversal(facts({ events: [] })).summary,
    planReversal(facts({ events: [], coverage: { coveredFrom: null, coveredTo: null, ok: null } })).summary,
    planReversal(facts()).coverageNote,
    ...planReversal(facts()).reversible.map((i) => i.what),
    ...REVERSAL_REFUSALS.map((r) => reversalRefusalLine(r)),
  ];
  ok("nothing says the account is restored", !all.some((s) => RESTORE.test(s)));
  ok("SELF-TEST: a planted restore claim is caught", RESTORE.test("The account was restored to how it looked on Tuesday."));
  ok("the complete summary names the limit out loud", /does not restore the account/.test(planReversal(facts()).summary));
  ok("SELF-TEST: the lookbehind still catches a bare claim", RESTORE.test("This restores the account."));
}

hr("10. NOTHING HERE APPLIES ANYTHING");
{
  const planner = readFileSync(new URL("./ads/change-reversal.ts", import.meta.url), "utf8");
  const cli = readFileSync(new URL("./ads-reverse-window.ts", import.meta.url), "utf8");
  ok("the planner opens no client and runs no query", !/pg\b|customer\.|GoogleAdsApi/.test(planner));
  ok("the planner is pure: no clock of its own", !/Date\.now\(\)|new Date\(\)/.test(planner));
  // The strongest verb is --propose. A flag named "apply" would be a second
  // way into a live account that nobody reviewed, which is the whole point.
  const APPLY_FLAG = /flag\(\s*["']apply["']\s*\)|includes\(\s*["']--apply["']\s*\)/;
  ok("the CLI has no apply flag", !APPLY_FLAG.test(cli));
  ok("SELF-TEST: a planted apply flag is caught", APPLY_FLAG.test(`const apply = flag("apply");`));
  ok("the CLI files findings at 'proposed' through the existing store", /upsertFinding/.test(cli) && !/status = 'approved'|"approved"/.test(cli));
  ok("the CLI never calls a mutate verb on a customer", !/\.(update|create|remove)\(/.test(cli));
  ok("SELF-TEST: a planted mutate call is caught", /\.(update|create|remove)\(/.test(`await customer.campaignBudgets.update(payload);`));
  ok("the only platform call it makes is a SELECT", (cli.match(/customer\.query\(/g) ?? []).length === 1 && /SELECT campaign\.id, campaign\.name FROM campaign/.test(cli));
  ok("nothing prints an ad account id", !/account\.account_id\}/.test(cli.replace(/\[[^\]]*account\.account_id[^\]]*\]/g, "")));
}

console.log(`\n${"─".repeat(72)}`);
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");
console.log(`${"─".repeat(72)}`);

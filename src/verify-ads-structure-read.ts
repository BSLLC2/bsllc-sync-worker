#!/usr/bin/env tsx
/**
 * The structure read keeps the campaigns when anything optional is refused (2026-11-11).
 *
 * The campaign query used to carry `campaign.start_date`, which the API version in use does not have. The platform refused
 * the whole query, the campaign kind was "not read", and a live account's snapshot held no campaign. Drives `readAccount`
 * with a fake customer (no network, no ad account, no credential) shaped like that account.
 *
 *   npm run verify-ads-structure-read
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_KINDS, readAccount } from "./ads/structure-read.js";
import {
  AD_GROUP_GAQL, BUDGET_GAQL, CAMPAIGN_BIDDING_GAQL, CAMPAIGN_DATES_GAQL, CAMPAIGN_GAQL, normalizeCampaign,
} from "./ads/structure-snapshot.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n${s}`);
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");

// An account shaped like the one that showed no campaign: two enabled search campaigns, a budget each.
const CAMPAIGNS = [
  { campaign: { id: "11", name: "Brand Search", status: 2, advertising_channel_type: 2 }, campaign_budget: { id: "901", amount_micros: "50000000" } },
  { campaign: { id: "12", name: "Parts Search", status: 2, advertising_channel_type: 2 }, campaign_budget: { id: "902", amount_micros: "54000000" } },
];
const BIDDING = [
  { campaign: { id: "11", bidding_strategy_type: 11, target_cpa: { target_cpa_micros: "85000000" } } },
  { campaign: { id: "12", bidding_strategy_type: 10 } },
];
const DATES = [
  { campaign: { id: "11", start_date_time: "2025-03-04 00:00:00", end_date_time: "2037-12-30 23:59:59" } },
  { campaign: { id: "12", start_date_time: "2025-06-01 00:00:00", end_date_time: "2037-12-30 23:59:59" } },
];
const BUDGETS = [
  { campaign_budget: { id: "901", name: "Brand", amount_micros: "50000000", explicitly_shared: false, status: 2 } },
  { campaign_budget: { id: "902", name: "Parts", amount_micros: "54000000", explicitly_shared: false, status: 2 } },
];
/** A customer whose queries answer by exact text; a text in `refuse` throws as the platform does for a field it does not have. */
function customer(refuse: string[] = []) {
  const rows = new Map<string, any[]>([[CAMPAIGN_GAQL, CAMPAIGNS], [CAMPAIGN_BIDDING_GAQL, BIDDING], [CAMPAIGN_DATES_GAQL, DATES], [BUDGET_GAQL, BUDGETS]]);
  return {
    async query(q: string): Promise<any[]> {
      if (refuse.includes(q)) throw Object.assign(new Error("Unrecognized field in the query"), { errors: [{ message: "Unrecognized field in the query: 'campaign.start_date'" }] });
      return rows.get(q) ?? [];
    },
  };
}

section("1. The campaign query asks for nothing optional");
ok("the campaign query names no date and no bidding field", !/start_date|end_date|bidding|target_/.test(CAMPAIGN_GAQL), CAMPAIGN_GAQL.replace(/\s+/g, " ").trim());
ok("the dates are read as start_date_time and end_date_time", /start_date_time/.test(CAMPAIGN_DATES_GAQL) && /end_date_time/.test(CAMPAIGN_DATES_GAQL) && !/campaign\.start_date\b/.test(CAMPAIGN_DATES_GAQL));
ok("the query for campaigns is still a SELECT over non-removed campaigns", /^\s*SELECT\b/i.test(CAMPAIGN_GAQL) && /campaign\.status != 'REMOVED'/.test(CAMPAIGN_GAQL));

section("2. Everything works: campaigns carry their bidding, dates and budget");
{
  const r = await readAccount(customer());
  const camps = r.entities.filter((e) => e.kind === "campaign");
  ok("both campaigns are read, with names", camps.length === 2 && camps.map((c) => c.name).join() === "Brand Search,Parts Search");
  ok("each campaign carries its budget id and daily budget in micros", camps[0]!.attrs.budget_id === "901" && camps[0]!.attrs.budget_amount_micros === 50_000_000);
  ok("bidding is merged on (type and target)", camps[0]!.attrs.bid_strategy_type != null && camps[0]!.attrs.target_cpa_micros === 85_000_000);
  ok("dates are merged on as dates", camps[0]!.attrs.start_date === "2025-03-04" && camps[0]!.attrs.end_date === "2037-12-30");
  ok("campaigns and budgets are complete kinds", CORE_KINDS.every((k) => r.completeKinds.includes(k)));
  ok("no problem is reported on the campaign kinds", !r.problems.some((p) => /^campaign/.test(p)), r.problems.join(" | "));
}

section("3. THE ACCOUNT THAT SHOWED NO CAMPAIGN: the optional queries are refused");
{
  const r = await readAccount(customer([CAMPAIGN_BIDDING_GAQL, CAMPAIGN_DATES_GAQL]));
  const camps = r.entities.filter((e) => e.kind === "campaign");
  ok("the campaigns are still read", camps.length === 2, `${camps.length}`);
  ok("the campaign kind is complete, so nothing is closed or left unread", r.completeKinds.includes("campaign") && r.completeKinds.includes("budget"));
  ok("a campaign keeps its name, channel and budget", camps[0]!.name === "Brand Search" && camps[0]!.attrs.budget_amount_micros === 50_000_000);
  ok("the bidding and date columns are unanswered (null), never invented", camps[0]!.attrs.bid_strategy_type == null && camps[0]!.attrs.start_date == null);
  ok("each refusal is a named problem", r.problems.some((p) => /campaign bidding settings could not be read/.test(p)) && r.problems.some((p) => /campaign dates could not be read/.test(p)), r.problems.join(" | "));
}

section("4. The campaign query itself is refused: the run says so out loud");
{
  const r = await readAccount(customer([CAMPAIGN_GAQL]));
  ok("no campaign is read", r.entities.filter((e) => e.kind === "campaign").length === 0);
  ok("the campaign kind is NOT complete (so nothing is closed on an empty list)", !r.completeKinds.includes("campaign"));
  const failed = CORE_KINDS.filter((k) => !r.completeKinds.includes(k));
  ok("the job's core-kind test sees it", failed.join() === "campaign");
  ok("the problem names the campaigns", r.problems.some((p) => /^campaigns could not be read/.test(p)), r.problems.join(" | "));
  const r2 = await readAccount(customer([BUDGET_GAQL]));
  ok("a refused budget query is a core failure too", CORE_KINDS.filter((k) => !r2.completeKinds.includes(k)).join() === "budget");
}

section("5. A single combined row still normalizes (older callers, the other verifier)");
{
  const c = normalizeCampaign({
    campaign: { id: "1", name: "X", status: 2, advertising_channel_type: 2, bidding_strategy_type: 11, start_date_time: "2026-01-02 00:00:00", target_cpa: { target_cpa_micros: "9000000" } },
    campaign_budget: { id: "5", amount_micros: "40000000" },
  })!;
  ok("all groups are applied from one row", c.attrs.target_cpa_micros === 9_000_000 && c.attrs.start_date === "2026-01-02" && c.attrs.budget_id === "5");
  ok("a core-only row leaves the optional groups null", normalizeCampaign({ campaign: { id: "2", name: "Y" } })!.attrs.bid_strategy_type == null);
}

section("6. The job says it out loud");
{
  const job = read("ads-structure-snapshot.ts");
  ok("a core kind not read is written into the scan note", /COULD NOT READ/.test(job));
  ok("…and into the heartbeat note", /CAMPAIGNS OR BUDGETS NOT READ/.test(job));
  ok("…and makes the run exit non-zero", /coreFailures\.length\) process\.exitCode = 1/.test(job));
  ok("the job reads through readAccount (not a copy)", /from "\.\/ads\/structure-read\.js"/.test(job));
  ok("nothing in the read writes to an ad platform", !/\.mutate\s*\(/.test(read("ads/structure-read.ts")));
  ok("the structure query is not in the job file", !/AD_GROUP_GAQL/.test(job) && AD_GROUP_GAQL.length > 0);
}

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll checks passed.");

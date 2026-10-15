#!/usr/bin/env tsx
/**
 * "Limited by search volume" (ruleset 12): a campaign that cannot spend its
 * budget because there is not enough to spend it on.
 *
 * Drives the pure reading and the real rules over an invented Franklin-shaped
 * book (Brazing, Assembly and Annealing under-spend and Google calls each
 * limited by search volume; four controls that must stay silent) and proves
 * the refusals first: the reading says nothing it cannot back, never fires
 * beside a budget row, and names what it could not read.
 *
 * EVERY CAMPAIGN, DATE AND FIGURE HERE IS INVENTED. The shape comes from the
 * owner's brief (gaps found on Franklin Brazing, 14 October). Nothing here ran
 * against an ad account.
 *
 *   npm run verify-ads-volume-limited
 */
import { readFileSync } from "node:fs";
import {
  evaluateAudit, ADS_RULESET_VERSION, type AuditInput, type CampaignRow,
} from "./ads/rules.js";
import {
  volumeLimitReading, lastWeekdays, accountDay, addDaysYmd, decodeStatusReasons, decodePrimaryStatus, statusFactsFromRow,
  PRIMARY_STATUS_REASON, SPEND_SHARE_FLOOR, WEEKDAYS_READ,
  type VolumeLimitFacts, type CampaignVolumeFacts, type DailySpend,
} from "./ads/volume-limited.js";
import { FINDING_STAGE } from "./ads/sequence.js";
import { accountingLines } from "./ads/run-accounting.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n${s}`);

// ── The calendar: Friday 9 October 2026 is the last complete day ────────────
const THROUGH = "2026-10-09";
const THRESHOLD_JUST_OVER = 0.1001;
const WEEK = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];

section("1. The seven weekdays");
{
  ok("2026-10-09 is a Friday", new Date(`${THROUGH}T00:00:00Z`).getUTCDay() === 5);
  ok("the last seven weekdays through that Friday are the ones expected, oldest first", lastWeekdays(THROUGH, 7).join() === WEEK.join());
  ok("a Sunday through-date reaches back past the weekend to the same seven", lastWeekdays("2026-10-11", 7).join() === WEEK.join());
  ok("no weekend day is ever in the week", lastWeekdays("2026-10-14", 7).every((d) => { const n = new Date(`${d}T00:00:00Z`).getUTCDay(); return n !== 0 && n !== 6; }));
  ok("a bad date gives no week, not a guess", lastWeekdays("not a date", 7).length === 0 && lastWeekdays("2026-13-45", 7).length === 0);
  ok("addDaysYmd walks a month end", addDaysYmd("2026-10-01", -1) === "2026-09-30" && addDaysYmd("2026-02-28", 1) === "2026-03-01");
  ok("the account's own calendar day comes from its time zone, not the server's",
    accountDay(new Date("2026-10-10T03:30:00Z"), "America/Los_Angeles") === "2026-10-09"
    && accountDay(new Date("2026-10-10T03:30:00Z"), "America/New_York") === "2026-10-09"
    && accountDay(new Date("2026-10-10T03:30:00Z"), "Asia/Tokyo") === "2026-10-10");
  ok("a time zone nothing knows is unanswered", accountDay(new Date(), "Mars/Olympus") === null && accountDay(new Date(), null) === null);
}

section("2. The platform's own words");
{
  ok("13 is SEARCH_VOLUME_LIMITED in the platform's published enum", PRIMARY_STATUS_REASON["13"] === "SEARCH_VOLUME_LIMITED");
  ok("11 is BUDGET_CONSTRAINED", PRIMARY_STATUS_REASON["11"] === "BUDGET_CONSTRAINED");
  ok("an integer, a numeric string and the name itself all decode", decodeStatusReasons([13, "13", "SEARCH_VOLUME_LIMITED"])!.join() === "SEARCH_VOLUME_LIMITED,SEARCH_VOLUME_LIMITED,SEARCH_VOLUME_LIMITED");
  ok("a value this build has never heard of is kept as text, not dropped", decodeStatusReasons([999])!.join() === "999");
  ok("an absent field is NOT an empty list", decodeStatusReasons(undefined) === null && decodeStatusReasons(null) === null);
  ok("the status decodes", decodePrimaryStatus(8) === "LIMITED" && decodePrimaryStatus(2) === "ELIGIBLE");
  const withStatus = statusFactsFromRow({ campaign: { primary_status: 2, start_date: "2026-01-02" }, campaign_budget: { explicitly_shared: false } });
  ok("a returned status with no reasons field is an empty list (the platform omits an empty repeated field)", withStatus.reasons !== null && withStatus.reasons.length === 0);
  const nothing = statusFactsFromRow({ campaign: {} });
  ok("a row that returned neither is unreadable, not empty", nothing.reasons === null && nothing.primaryStatus === null);
  ok("sharing: false is an answer, absent is not", withStatus.budgetShared === false && nothing.budgetShared === null);
  ok("a start date that is not a date is not trusted", statusFactsFromRow({ campaign: { start_date: "soon" } }).startDate === null);
}

// ── A Franklin-shaped account ───────────────────────────────────────────────
const status = (over: Partial<CampaignVolumeFacts> = {}): CampaignVolumeFacts => ({
  primaryStatus: "LIMITED", reasons: ["SEARCH_VOLUME_LIMITED"], startDate: "2026-01-05", budgetShared: false, ...over,
});
const spendOn = (days: string[], microsPerDay: number): DailySpend[] => days.map((date) => ({ date, costMicros: microsPerDay }));

const camp = (id: string, name: string, over: Partial<CampaignRow> = {}): CampaignRow => ({
  id, name, channelType: "SEARCH", resourceName: `customers/1/campaigns/${id}`, bidStrategyType: "MANUAL_CPC", hasBidTarget: false,
  dailyBudgetMicros: 60_000_000, budgetResourceName: `customers/1/campaignBudgets/${id}`, costMicros: 540_000_000, clicks: 400,
  impressions: 9_000, conversions: 20, impressionShare: 0.62, budgetLostShare: 0.02, rankLostShare: 0.05, ...over,
} as CampaignRow);

const volume = (over: Partial<VolumeLimitFacts> = {}): VolumeLimitFacts => ({
  throughDate: THROUGH,
  status: {
    "1": status(), "2": status(), "3": status(),                                    // the three
    "4": status({ primaryStatus: "ELIGIBLE", reasons: [] }),                        // spending its budget
    "5": status({ primaryStatus: "LIMITED", reasons: ["BUDGET_CONSTRAINED"] }),     // budget's, not ours
    "6": status({ primaryStatus: "ELIGIBLE", reasons: [] }),                        // under-spends, Google gives no volume reason
    "7": status({ budgetShared: true }),                                            // shared budget
    "8": status({ startDate: "2026-10-06" }),                                       // started mid-week
    "9": status(),                                                                  // volume-limited, but spending two thirds
  },
  dailySpend: {
    "1": spendOn(WEEK, 18_000_000),          // 30%
    "2": spendOn(WEEK, 30_000_000),          // 50%
    "3": spendOn(WEEK, 24_000_000),          // 40%
    "4": spendOn(WEEK, 55_000_000),          // 92%
    "5": spendOn(WEEK, 20_000_000),
    "6": spendOn(WEEK, 12_000_000),
    "7": spendOn(WEEK, 12_000_000),
    "8": spendOn(WEEK, 12_000_000),
    "9": spendOn(WEEK, 40_000_000),          // 67%: above the 60% line, below any line that would catch it by accident
  },
  ...over,
});

const franklin = (v: VolumeLimitFacts | null | undefined, extra: CampaignRow[] = []): AuditInput => ({
  platform: "google_ads", accountId: "5550001111", windowStart: "2026-07-12", windowEnd: THROUGH,
  campaigns: [
    camp("1", "Brazing"), camp("2", "Assembly"), camp("3", "Annealing"),
    camp("4", "Heat Treating"),
    camp("5", "Brand", { budgetLostShare: 0.31 }),
    camp("6", "Inspection"),
    camp("7", "Shared Pool"),
    camp("8", "New Launch"),
    camp("9", "Well Spent"),
    ...extra,
  ],
  searchTerms: [], keywords: [], ads: [], existingNegatives: new Set(), negativesByCampaign: new Map(),
  protectedPatterns: [], tracking: { status: "CONVERSION_TRACKING_MANAGED_BY_SELF", actions: [] },
  existingKeywords: [], conversionLag: [], dailyConversions: [],
  ...(v === undefined ? {} : { volumeLimit: v }),
} as unknown as AuditInput);

const rowsFor = (input: AuditInput) => {
  const { findings, accounting } = evaluateAudit(input);
  return { findings, accounting, vol: findings.filter((f) => f.findingType === "volume_limited") };
};

section("3. Franklin: it fires for Brazing, Assembly and Annealing, and for nobody else");
{
  const { vol, findings, accounting } = rowsFor(franklin(volume()));
  ok("exactly three rows", vol.length === 3, vol.map((f) => f.entityName).join(", "));
  ok("they are the three campaigns Google calls limited by search volume", ["Brazing", "Assembly", "Annealing"].every((n) => vol.some((f) => f.entityName === n)));
  ok("each is keyed on its own campaign", vol.every((f) => f.campaignId === f.entityId && f.entityType === "campaign"));
  ok("no change payload, vendor applicability (ours: nothing for the guarded path to apply)", vol.every((f) => f.changePayload === null && f.applicability === "vendor"));
  ok("no money claimed", vol.every((f) => f.estImpactCents === 0 && /No impact claimed/.test(f.impactAssumption)));
  ok("severity is low or medium, never high", vol.every((f) => f.severity === "low" || f.severity === "medium"));
  const byName = Object.fromEntries(vol.map((f) => [f.entityName, f]));
  ok("under a third of the budget is medium, above it low", byName.Brazing!.severity === "medium" && byName.Assembly!.severity === "low");
  ok("the spend is the sum over the seven weekdays", byName.Brazing!.evidence.metrics.weekdaySpendMicros === 7 * 18_000_000 && byName.Brazing!.evidence.metrics.weekdayBudgetMicros === 7 * 60_000_000);
  ok("the share is on the row and rounds to what the title says", byName.Brazing!.evidence.metrics.spendShare === 0.3 && /about 30%/.test(byName.Brazing!.title));
  ok("the evidence window is the seven weekdays, not the 90 days", byName.Brazing!.evidence.windowStart === "2026-10-01" && byName.Brazing!.evidence.windowEnd === "2026-10-09");
  ok("the floor is said to be ours", byName.Brazing!.evidence.lines.some((l) => /that line is ours/.test(l)));
  ok("weekends and the nought-day rule are said", byName.Brazing!.evidence.lines.some((l) => /Weekends are left out/.test(l) && /counts as nought/.test(l)));
  ok("Google's own status and reasons are quoted", byName.Brazing!.evidence.lines.some((l) => /LIMITED/.test(l) && /SEARCH_VOLUME_LIMITED/.test(l)));
  ok("the summary points at the services check, not at a budget", /services check/.test(byName.Brazing!.summary) && /More budget would change nothing/.test(byName.Brazing!.summary));
  ok("it is placed in the grow stage", FINDING_STAGE.volume_limited === "grow");
  ok("none of them is also a budget row", !findings.some((f) => f.findingType === "budget_limited" && vol.some((v) => v.campaignId === f.campaignId)));
  ok("the run says which campaigns it raised", (accounting.volumeRaised ?? []).length === 3);
}

section("4. The controls stay silent, each for its own reason");
{
  const { vol, findings, accounting } = rowsFor(franklin(volume()));
  const names = vol.map((f) => f.entityName);
  ok("a campaign spending 92% of its budget is silent", !names.includes("Heat Treating"));
  ok("a campaign Google calls volume-limited that still spends two thirds of its budget is silent", !names.includes("Well Spent"));
  ok("a campaign Google calls BUDGET_CONSTRAINED is silent, and it keeps its budget row", !names.includes("Brand") && findings.some((f) => f.findingType === "budget_limited" && f.entityName === "Brand"));
  ok("an under-spender Google gives no volume reason for is SILENT, not guessed at", !names.includes("Inspection"));
  ok("a campaign on a shared budget is not compared to it, and the run names it", !names.includes("Shared Pool")
    && (accounting.volumeUnread ?? []).some((u) => u.campaignName === "Shared Pool" && u.why === "budget_shared"));
  ok("a campaign that started mid-week is not read, and the run names it", !names.includes("New Launch")
    && (accounting.volumeUnread ?? []).some((u) => u.campaignName === "New Launch" && u.why === "campaign_too_new"));
  const lines = accountingLines(accounting).join("\n");
  ok("the run's output names both and says why", /"Shared Pool": not checked/.test(lines) && /"New Launch": not checked/.test(lines));
  ok("…and says what it raised", /Brazing: limited by search volume, spending about 30%/.test(lines));
}

section("5. It never fires beside a budget row");
{
  // A campaign the platform calls volume-limited AND that loses 20% of its
  // impressions to budget has a budget_limited row; this rule steps aside.
  const c = camp("1", "Brazing", { budgetLostShare: 0.2 });
  const input = franklin(volume());
  input.campaigns = [c];
  const { findings } = rowsFor(input);
  ok("budget_limited is raised for it", findings.some((f) => f.findingType === "budget_limited" && f.campaignId === "1"));
  ok("volume_limited is not", !findings.some((f) => f.findingType === "volume_limited"));
  // Even where the lost-budget share is under the threshold, a budget_limited row
  // for the campaign is enough to keep this one out.
  const edge = franklin(volume());
  edge.campaigns = [camp("1", "Brazing", { budgetLostShare: THRESHOLD_JUST_OVER })];
  ok("a campaign just over the budget threshold is budget's", !rowsFor(edge).vol.length);
  const under = franklin(volume());
  under.campaigns = [camp("1", "Brazing", { budgetLostShare: 0.05 })];
  ok("control: a small budget loss does not keep it out", rowsFor(under).vol.length === 1);
}

section("6. Refusals: what it will not read");
{
  const firesFor = (v: VolumeLimitFacts | null | undefined) => rowsFor(franklin(v, [])).vol.length;
  ok("an adapter that does not read it at all (absent) raises nothing and names nothing",
    firesFor(undefined) === 0 && (rowsFor(franklin(undefined)).accounting.volumeUnread ?? []).length === 0);
  const nullRun = rowsFor(franklin(null));
  ok("a read that failed (null) raises nothing and the run says so ONCE for the account",
    nullRun.vol.length === 0 && (nullRun.accounting.volumeUnread ?? []).filter((u) => u.campaignName === null && u.why === "not_read").length === 1);
  const noStatus = rowsFor(franklin(volume({ status: null })));
  ok("the status query failing raises nothing and is said once", noStatus.vol.length === 0
    && (noStatus.accounting.volumeUnread ?? []).filter((u) => u.why === "status_unreadable").length === 1);
  const noTz = rowsFor(franklin(volume({ throughDate: null })));
  ok("an unreadable time zone raises nothing, because a day still in progress would read as under-spending",
    noTz.vol.length === 0 && (noTz.accounting.volumeUnread ?? []).some((u) => u.why === "account_day_unknown"));
  const noSpend = rowsFor(franklin(volume({ dailySpend: null })));
  ok("the daily spend failing raises nothing", noSpend.vol.length === 0 && (noSpend.accounting.volumeUnread ?? []).some((u) => u.why === "spend_unreadable"));
  const noReasons = volume();
  noReasons.status!["1"] = status({ reasons: null });
  const nr = rowsFor(franklin(noReasons));
  ok("a campaign whose reasons came back absent is named, not read as 'no reason'",
    !nr.vol.some((f) => f.entityName === "Brazing") && (nr.accounting.volumeUnread ?? []).some((u) => u.campaignName === "Brazing" && u.why === "reasons_unreadable"));
  const unknownShare = volume();
  unknownShare.status!["1"] = status({ budgetShared: null });
  ok("whether the budget is shared being unreadable is the same silence as shared", !rowsFor(franklin(unknownShare)).vol.some((f) => f.entityName === "Brazing"));
  const noBudget = franklin(volume());
  noBudget.campaigns = [camp("1", "Brazing", { dailyBudgetMicros: 0 })];
  ok("a campaign with no daily budget is named", rowsFor(noBudget).vol.length === 0 && (rowsFor(noBudget).accounting.volumeUnread ?? []).some((u) => u.why === "budget_unreadable"));
  const display = franklin(volume());
  display.campaigns = [camp("1", "Brazing", { channelType: "DISPLAY" })];
  ok("a campaign that is not a search campaign is skipped without comment", rowsFor(display).vol.length === 0 && (rowsFor(display).accounting.volumeUnread ?? []).length === 0);
}

section("7. The spend arithmetic");
{
  const base = (spend: DailySpend[], over: Partial<CampaignVolumeFacts> = {}) => volumeLimitReading({
    campaignId: "1", campaignName: "Brazing", channelType: "SEARCH", dailyBudgetMicros: 60_000_000,
    volume: { throughDate: THROUGH, status: { "1": status(over) }, dailySpend: { "1": spend } },
  });
  ok("exactly at the floor is spending enough (the line is 'under')", base(spendOn(WEEK, 60_000_000 * SPEND_SHARE_FLOOR)).verdict === "not_limited");
  ok("a hair under the floor fires", base(spendOn(WEEK, 60_000_000 * SPEND_SHARE_FLOOR - 1_000)).verdict === "limited");
  const weekendOnly = base([{ date: "2026-10-03", costMicros: 500_000_000 }, { date: "2026-10-04", costMicros: 500_000_000 }]);
  ok("spend on a weekend never counts toward the week", weekendOnly.verdict === "limited" && weekendOnly.spendMicros === 0);
  const holes = base(spendOn(["2026-10-09", "2026-10-08"], 60_000_000));
  ok("days with no row count as nought", holes.verdict === "limited" && holes.spendMicros === 120_000_000 && holes.share < 0.3);
  const outside = base([...spendOn(WEEK, 10_000_000), { date: "2026-09-28", costMicros: 900_000_000 }]);
  ok("a day outside the seven is ignored", outside.verdict === "limited" && outside.spendMicros === 70_000_000);
  ok("the window has exactly seven days", WEEKDAYS_READ === 7 && lastWeekdays(THROUGH, WEEKDAYS_READ).length === 7);
  ok("a start date AFTER the first weekday is too new; ON it is not", base(spendOn(WEEK, 1_000_000), { startDate: "2026-10-02" }).verdict === "cant_tell"
    && base(spendOn(WEEK, 1_000_000), { startDate: "2026-10-01" }).verdict === "limited");
  const noVol = volumeLimitReading({ campaignId: "1", campaignName: "x", channelType: "SEARCH", dailyBudgetMicros: 60_000_000, volume: { throughDate: THROUGH, status: { "1": status({ reasons: ["BIDDING_STRATEGY_LEARNING"] }) }, dailySpend: { "1": [] } } });
  ok("a campaign Google gives only a learning reason is silent", noVol.verdict === "not_limited");
  const both = volumeLimitReading({ campaignId: "1", campaignName: "x", channelType: "SEARCH", dailyBudgetMicros: 60_000_000, volume: { throughDate: THROUGH, status: { "1": status({ reasons: ["SEARCH_VOLUME_LIMITED", "BUDGET_CONSTRAINED"] }) }, dailySpend: { "1": spendOn(WEEK, 1) } } });
  ok("a campaign carrying BOTH reasons is budget's", both.verdict === "not_limited");
}

section("8. The adapter reads what the rule needs, and the registrations hold");
{
  const adapter = readFileSync(new URL("./ads/google-ads-adapter.ts", import.meta.url), "utf8");
  ok("the status and its reasons are asked for in a query of their own", /campaign\.primary_status_reasons/.test(adapter) && /campaign_budget\.explicitly_shared/.test(adapter));
  ok("…and that query is not the campaign query every other rule stands on", !/campaign 30d`[\s\S]{0,900}primary_status/.test(adapter));
  ok("the account's time zone is read", /customer\.time_zone/.test(adapter));
  ok("the daily spend is read by campaign and date", /segments\.date[\s\S]{0,200}metrics\.cost_micros[\s\S]{0,80}FROM campaign|FROM campaign[\s\S]{0,200}segments\.date BETWEEN/.test(adapter));
  ok("a failed read goes through tryQuery (null), never safeQuery (empty)", /readVolumeLimit[\s\S]*?tryQuery\(customer, "campaign status reasons"/.test(adapter) && /tryQuery\(customer, "daily spend by campaign"/.test(adapter));
  ok("the adapter hands it to the rules", /volumeLimit,/.test(adapter));
  ok("the ruleset moved to 12", ADS_RULESET_VERSION === 12);
  const rules = readFileSync(new URL("./ads/rules.ts", import.meta.url), "utf8");
  ok("the rule checks for a budget_limited row before it writes", /budgetRowFor[\s\S]{0,200}budget_limited/.test(rules));
  ok("it writes no change payload", !/findingType: "volume_limited"[\s\S]{0,2400}changePayload: \{/.test(rules));
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);

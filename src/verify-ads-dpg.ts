#!/usr/bin/env tsx
/**
 * What the audit missed on a Diesel Power Group account (ruleset 11).
 *
 * Drives the pure modules and the real rules over invented books and proves, for
 * each of the things the owner's review found the OS should have picked up:
 *
 *   1. a budget change names no campaign, so it could not be tied to one
 *      (change capture: the budget id, the campaign lookup, a full window split)
 *   3. a quiet weekend on an account whose calls run Monday to Friday is not an
 *      outage (same-weekday baseline, a settled-days rule, a converting-days rule)
 *   4. an outage on an account that bids on nothing is a low-severity note
 *   6. quality score is split by Google's three components
 *   7. a Repeat Phone Call action counted as primary is named
 *   8. one lead rule, in one place, with the count of what it left out
 *   9. the closed-sales tracker is read, labelled as BS LLC's own match
 *  10. forms and calls are told apart for the click-id blocker
 *
 * EVERY CAMPAIGN, KEYWORD, DATE AND FIGURE HERE IS INVENTED. The shapes come from
 * the owner's brief; nothing here ran against an ad account or a database.
 *
 *   npm run verify-ads-dpg
 */
import {
  evaluate, ADS_RULESET_VERSION, outcomeReadiness, MIN_FORMS_FOR_CLICK_ID_VERDICT,
  type AuditInput, type CampaignRow, type KeywordRow, type OutcomeFeedFacts, type ConversionActionRow,
} from "./ads/rules.js";
import {
  findTrackingOutage, dayKindOf, MIN_QUIET_DAYS, type DailyConversionRow,
} from "./ads/tracking-outage.js";
import { repeatCallReading, REPEAT_CALL_NAME } from "./ads/repeat-call.js";
import { splitByComponent, decodeQsBucket, QS_COMPONENT_MIN_KEYWORDS, type QsKeywordFact } from "./ads/qs-components.js";
import { COUNTED_LEAD_SQL, LEAD_EXCLUDED_STATUSES, LEAD_INTERNAL_DOMAIN } from "./ads/lead-filter.js";
import { parseTrackerWins } from "./ads/store.js";
import {
  normalizeChangeEvent, attachBudgetCampaigns, budgetCampaignMap, budgetIdOfEvent, readChangeWindow,
  CHANGE_GAQL_FIELDS, type CapturedChange,
} from "./ads/change-history.js";
import type { ExistingKeyword } from "./ads/query-promotion.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n${s}`);

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ── 1. Change capture: a budget change finds its campaign ───────────────────
section("1. A budget change names no campaign; the capture finds it");
{
  const raw = (over: Record<string, unknown> = {}) => ({
    change_event: {
      resource_name: "customers/1/changeEvents/111~1~1", change_date_time: "2026-10-08 09:12:00.000000",
      user_email: "ben@bsllc.biz", change_resource_type: 6, resource_change_operation: 3, client_type: 2,
      changed_fields: { paths: ["amount_micros"] },
      change_resource_name: "customers/1/campaignBudgets/777",
      new_resource: { campaign_budget: { amount_micros: 104_000_000 } },
      ...over,
    },
  });
  const e = normalizeChangeEvent(raw())!;
  ok("the event keeps the resource it is ABOUT", e.changeResourceName === "customers/1/campaignBudgets/777");
  ok("…and it is asked for", /change_event\.change_resource_name/.test(CHANGE_GAQL_FIELDS));
  ok("the budget id comes off that name", budgetIdOfEvent(e) === "777");
  ok("…or, failing that, off the resource body an older row carries",
    budgetIdOfEvent({ changeResourceName: null, oldResourceJson: null, newResourceJson: '{"resource_name":"customers/1/campaignBudgets/778"}' }) === "778");
  ok("…and a row naming neither is unanswered, never a guess",
    budgetIdOfEvent({ changeResourceName: null, oldResourceJson: null, newResourceJson: "{}" }) === null);

  const map = budgetCampaignMap([
    { campaign: { id: 10, campaign_budget: "customers/1/campaignBudgets/777" } },
    { campaign: { id: 11, campaign_budget: "customers/1/campaignBudgets/888" } },
    { campaign: { id: 12, campaign_budget: "customers/1/campaignBudgets/888" } },
  ]);
  const solo = normalizeChangeEvent(raw())!;
  const shared = normalizeChangeEvent(raw({ resource_name: "customers/1/changeEvents/112~1~1", change_resource_name: "customers/1/campaignBudgets/888" }))!;
  const lost = normalizeChangeEvent(raw({ resource_name: "customers/1/changeEvents/113~1~1", change_resource_name: "customers/1/campaignBudgets/999" }))!;
  const named = normalizeChangeEvent(raw({ resource_name: "customers/1/changeEvents/114~1~1", campaign: "customers/1/campaigns/55" }))!;
  const r = attachBudgetCampaigns([solo, shared, lost, named], map);
  ok("a budget used by exactly one campaign is stamped with it", solo.campaignId === "10");
  ok("a budget SHARED by several is left unstamped, not guessed", shared.campaignId == null && r.shared === 1);
  ok("a budget no campaign uses is counted unplaced", lost.campaignId == null && r.unresolved === 1);
  ok("an event that already names a campaign is never rewritten", named.campaignId === "55");
}

section("1b. A window that comes back full is split, not stored as whole");
{
  const day = (d: string, n: number) => Array.from({ length: n }, (_, i) => ({ d, i }));
  let reads = 0;
  // Ten rows a day for ten days against a cap of 40: the whole window is full.
  const read = async (from: string, to: string) => {
    reads += 1;
    const out: { d: string; i: number }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(...day(d, 10));
    return out.slice(0, 40);   // oldest first, then cut, exactly as the platform does
  };
  const res = await readChangeWindow(read, "2026-10-01", "2026-10-10", 40);
  ok("every day is read in full once the window is halved", res.rows.length === 100 && res.capped.length === 0, `${res.rows.length} rows, ${reads} reads`);
  ok("the NEWEST day is in what came back, which an oldest-first cut loses", res.rows.some((x) => (x as any).d === "2026-10-10"));
  const dense = await readChangeWindow(async (f, t) => Array.from({ length: 50 }, (_, i) => ({ f, t, i })), "2026-10-01", "2026-10-02", 40);
  ok("a single day still at the cap is the one thing reported", dense.capped.length >= 1 && dense.capped.every((c) => c.split("..")[0] === c.split("..")[1]), dense.capped.join(","));
  const nothing = await readChangeWindow(async () => null, "2026-10-01", "2026-10-02", 40);
  ok("a null read is an empty window, not a crash", nothing.rows.length === 0 && nothing.capped.length === 0);
}

// ── 3 & 4. The conversion outage ────────────────────────────────────────────
section("3. A weekend on an account that converts Monday to Friday is not an outage");
const weekdayAccount = (start: string, days: number, over: (d: string, kind: string) => Partial<DailyConversionRow> = () => ({})): DailyConversionRow[] =>
  Array.from({ length: days }, (_, i) => {
    const date = addDays(start, i);
    const kind = dayKindOf(date);
    const weekday = kind === "weekday";
    return { date, clicks: weekday ? 40 : 30, conversions: weekday ? 4 : 0, costMicros: 8_000_000, ...over(date, kind) };
  });
{
  // 2026-09-01 is a Tuesday. Forty days takes the series to Tuesday 2026-10-10? find a series ending on Sunday 2026-10-11.
  const start = addDays("2026-10-11", -41);
  const series = weekdayAccount(start, 42);
  ok("the last day of the series is the Sunday", dayKindOf(series[series.length - 1]!.date) === "weekend" && new Date(`${series[series.length - 1]!.date}T00:00:00Z`).getUTCDay() === 0);
  const o = findTrackingOutage(series);
  ok("the Saturday and the Sunday are NOT called a break", o.verdict === "none", `${o.verdict}: ${o.lines.join(" | ").slice(0, 160)}`);
  ok("…and the reason is on the reading, not silent", o.lines.length > 0);

  // The same account with a real break: Monday to Thursday quiet.
  const broken = weekdayAccount(addDays("2026-10-08", -41), 42, (d) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return d >= "2026-10-05" && dow >= 1 && dow <= 4 ? { conversions: 0 } : {};
  });
  const b = findTrackingOutage(broken);
  ok("control: four quiet WEEKDAYS on that account are still found", b.verdict === "found" && b.startDate! <= "2026-10-05" && b.endDate === "2026-10-07", `${b.verdict} ${b.startDate} ${b.days}d`);
  ok("…counted on days the account converts", b.convertingDaysInRun >= 2);
}
section("3b. The newest day is not final, and a short run is not a break");
{
  const base = (n: number) => weekdayAccount("2026-08-03", n);
  const trailingQuiet = (quiet: number) => {
    const s = weekdayAccount("2026-08-03", 40);
    for (let i = 0; i < quiet; i++) s[s.length - 1 - i] = { ...s[s.length - 1 - i]!, clicks: 40, conversions: 0 };
    return s;
  };
  // Make every day a weekday-style converting day so only the run length decides.
  const flat = (n: number, quiet: number): DailyConversionRow[] =>
    Array.from({ length: n }, (_, i) => ({ date: addDays("2026-08-01", i), clicks: 40, conversions: i >= n - quiet ? 0 : 4, costMicros: 8_000_000 }));
  const three = findTrackingOutage(flat(40, 3));
  ok("three quiet days where the newest is still reporting is two settled days: not a break", three.verdict === "none" && three.days === 2, `${three.verdict} ${three.days}d, left out ${three.recentDaysLeftOut}`);
  const four = findTrackingOutage(flat(40, 4));
  ok("four quiet days leave three settled: a break", four.verdict === "found" && four.days === MIN_QUIET_DAYS, `${four.verdict} ${four.days}d`);
  ok("…and the run ends the day before the newest", four.endDate === addDays("2026-08-01", 38));
  ok("the reading says it left the newest day out", four.recentDaysLeftOut === 1);
  void base; void trailingQuiet;
  ok("a series of one day is judged on that day, not emptied", findTrackingOutage([{ date: "2026-10-01", clicks: 5, conversions: 0, costMicros: 1 }]).verdict !== "found");
  ok("a series never read is unread", findTrackingOutage(null).verdict === "unread");
}

section("4. A break on an account that bids on nothing is a low-severity note");
{
  const campaign = (id: string, over: Partial<CampaignRow> = {}): CampaignRow => ({
    id, name: `Campaign ${id}`, channelType: "SEARCH", resourceName: `customers/1/campaigns/${id}`,
    bidStrategyType: "MANUAL_CPC", hasBidTarget: false, dailyBudgetMicros: 50_000_000, budgetResourceName: `customers/1/campaignBudgets/${id}`,
    costMicros: 900_000_000, clicks: 600, impressions: 12_000, conversions: 40, impressionShare: 0.6, budgetLostShare: 0.02, rankLostShare: 0.05,
    ...over,
  } as CampaignRow);
  const action = (over: Partial<ConversionActionRow>): ConversionActionRow => ({
    id: "1", name: "Calls from ads", status: "ENABLED", category: "PHONE_CALL_LEAD", actionType: "AD_CALL",
    primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 60, defaultValue: null, alwaysUseDefaultValue: null, ...over,
  });
  const quiet = (n: number): DailyConversionRow[] =>
    Array.from({ length: 40 }, (_, i) => ({ date: addDays("2026-08-01", i), clicks: 40, conversions: i >= 40 - n ? 0 : 4, costMicros: 8_000_000 }));
  const input = (campaigns: CampaignRow[], actions: ConversionActionRow[], over: Partial<AuditInput> = {}): AuditInput => ({
    platform: "google_ads", accountId: "1234567890", windowStart: "2026-07-14", windowEnd: "2026-10-11",
    campaigns, searchTerms: [], keywords: [], ads: [], existingNegatives: new Set(), negativesByCampaign: new Map(),
    protectedPatterns: [], tracking: { status: "CONVERSION_TRACKING_MANAGED_BY_SELF", actions },
    dailyConversions: quiet(8), conversionLag: [],
    ...over,
  } as AuditInput);
  const manual = evaluate(input([campaign("1"), campaign("2")], [action({})]));
  const row = manual.find((f) => f.findingType === "bidding_data_exclusion");
  ok("nothing bids on conversions: the row is raised, as a note", row != null, row?.title ?? "none");
  ok("…LOW severity, not the top of the queue", row?.severity === "low", String(row?.severity));
  ok("…with no change to apply and no instruction to add an exclusion", row?.changePayload == null && !/add (a|the) (data )?exclusion|exclude those/i.test(`${row?.summary} ${row?.evidence.lines.join(" ")}`));
  ok("…and it says it is for the record", /no campaign|nothing bids|record/i.test(`${row?.title} ${row?.summary}`), row?.title);
  const smart = evaluate(input([campaign("1", { bidStrategyType: "TARGET_CPA", hasBidTarget: true })], [action({})]));
  const sRow = smart.find((f) => f.findingType === "bidding_data_exclusion");
  ok("control: a campaign that DOES bid on conversions keeps the severity and the exclusion", sRow != null && sRow.severity !== "low" && sRow.changePayload != null, `${sRow?.severity} ${sRow?.changePayload ? "payload" : "no payload"}`);
}

// ── 6. Quality score by component ───────────────────────────────────────────
section("6. Quality score is split by what Google says is wrong");
{
  ok("Google's bucket integers decode", decodeQsBucket(2) === "below" && decodeQsBucket("3") === "average" && decodeQsBucket(4) === "above");
  ok("UNKNOWN and UNSPECIFIED are not an answer", decodeQsBucket(0) === null && decodeQsBucket(1) === null && decodeQsBucket("UNKNOWN") === null && decodeQsBucket(null) === null);
  const kw = (text: string, score: number, lp: any, ctr: any, rel: any): QsKeywordFact => ({
    text, campaignName: "Search", score, costMicros: 10_000_000, conversions: 0, landingPage: lp, expectedCtr: ctr, adRelevance: rel,
  });
  const dpg: QsKeywordFact[] = [
    ...Array.from({ length: 85 }, (_, i) => kw(`kw lp ${i}`, 3, "below", i < 70 ? "below" : "average", "average")),
    kw("fine 1", 7, "average", "average", "above"), kw("fine 2", 7, "average", "average", "above"), kw("fine 3", 6, "above", "average", "average"),
  ];
  const sp = splitByComponent(dpg, 5);
  ok("landing page and expected click-through are raised, ad relevance is not",
    sp.groups.map((g) => g.component).join() === "landing_page,expected_ctr", sp.groups.map((g) => `${g.component}:${g.keywords.length}`).join(" "));
  ok("a keyword below on two parts is listed under each", sp.groups[0]!.keywords.length === 85 && sp.groups[1]!.keywords.length === 70);
  ok("the old row keeps only what no component covers", sp.remainder.length === 0);
  const two = splitByComponent([kw("a", 3, "below", "average", "average"), kw("b", 3, "below", "average", "average"), kw("c", 7, "average", "average", "average")], 5);
  ok(`under ${QS_COMPONENT_MIN_KEYWORDS} keywords is not a pattern, so the old row stands`, two.groups.length === 0 && two.remainder.length === 2);
  const unreadable = splitByComponent([kw("a", 3, null, null, null), kw("b", 2, null, null, null)], 5);
  ok("with no component reported nothing is split and the old row is raised as before", !unreadable.readable && unreadable.remainder.length === 2);
  ok("a null component is never read as below", splitByComponent(Array.from({ length: 5 }, (_, i) => kw(`n${i}`, 3, null, "below", null)), 5).groups.map((g) => g.component).join() === "expected_ctr");

  // Through the real rules.
  const ek = (text: string, over: Partial<ExistingKeyword>): ExistingKeyword => ({
    text, matchType: "PHRASE", adGroupName: "Core", campaignName: "Search", campaignId: "1",
    criterionStatus: "ENABLED", adGroupStatus: "ENABLED", campaignStatus: "ENABLED", qualityScore: 3,
    criterionResourceName: `customers/1/adGroupCriteria/5~${text}`, finalUrls: [], ...over,
  });
  const keywords = Array.from({ length: 9 }, (_, i) => ek(`diesel part ${i}`, { qsLandingPage: "below", qsExpectedCtr: i < 4 ? "below" : "average", qsAdRelevance: "average" }));
  const c: CampaignRow = {
    id: "1", name: "Search", channelType: "SEARCH", resourceName: "customers/1/campaigns/1", bidStrategyType: "MANUAL_CPC", hasBidTarget: false,
    dailyBudgetMicros: 50_000_000, budgetResourceName: "customers/1/campaignBudgets/1", costMicros: 900_000_000, clicks: 600, impressions: 12_000,
    conversions: 40, impressionShare: 0.6, budgetLostShare: 0.02, rankLostShare: 0.05,
  } as CampaignRow;
  const fs = evaluate({
    platform: "google_ads", accountId: "1234567890", windowStart: "2026-07-14", windowEnd: "2026-10-11",
    campaigns: [c], searchTerms: [], keywords: [], ads: [], existingNegatives: new Set(), negativesByCampaign: new Map(),
    protectedPatterns: [], tracking: { status: "CONVERSION_TRACKING_MANAGED_BY_SELF", actions: [] },
    existingKeywords: keywords, conversionLag: [], dailyConversions: [],
  } as unknown as AuditInput);
  const lq = fs.filter((f) => f.findingType === "low_quality_score");
  ok("two rows come out, one per raised component, each keyed on its component",
    lq.length === 2 && lq.some((f) => f.entityId.endsWith(":low_quality_score:landing_page")) && lq.some((f) => f.entityId.endsWith(":low_quality_score:expected_ctr")),
    lq.map((f) => f.entityId).join(" , "));
  ok("each carries its component as a recorded number, never to be read back from the title",
    lq.every((f) => typeof f.evidence.metrics.qsComponent === "number"));
  ok("every keyword is listed on its row, not a sample", lq.find((f) => f.entityId.endsWith("landing_page"))!.evidence.lines.filter((l) => l.startsWith("QS ")).length === 9);
}

// ── 7. Repeat calls ─────────────────────────────────────────────────────────
section("7. A repeat-call action that counts is named");
{
  const act = (name: string, over: Partial<ConversionActionRow> = {}): ConversionActionRow => ({
    id: name, name, status: "ENABLED", category: "PHONE_CALL_LEAD", actionType: "AD_CALL",
    primaryForGoal: true, countsIntoConversionsColumn: true, conversionsInWindow: 12, defaultValue: null, alwaysUseDefaultValue: null, ...over,
  });
  ok("the name is matched on 'repeat' then 'call'", ["Repeat Phone Call", "repeat call", "Repeated calls", "REPEAT_CALLER"].every((n) => REPEAT_CALL_NAME.test(n)));
  ok("…and not on a name that only has both words apart", !REPEAT_CALL_NAME.test("Call from ads, repeat visitors") && !REPEAT_CALL_NAME.test("Phone calls"));
  const open = repeatCallReading([act("Calls from ads"), act("Repeat Phone Call")]);
  ok("a counting repeat-call action is open, and names what it doubles",
    open.state === "open" && open.counting.length === 1 && open.otherCounting.map((a) => a.name).join() === "Calls from ads");
  ok("a secondary one (not counted) is clear", repeatCallReading([act("Repeat Phone Call", { countsIntoConversionsColumn: false, primaryForGoal: false })]).state === "clear");
  ok("one the platform did not say about is undecided, never counted", (() => {
    const r = repeatCallReading([act("Repeat Phone Call", { countsIntoConversionsColumn: null, primaryForGoal: null })]);
    return r.state === "clear" && r.undecided.length === 1;
  })());
  ok("a removed action is ignored", repeatCallReading([act("Repeat Phone Call", { status: "REMOVED" })]).state === "clear");
  ok("actions never read are cant_tell, not clear", repeatCallReading(null).state === "cant_tell");
  ok("no value is ever put on an action by this reading", !Object.keys(open).some((k) => /value|cents/i.test(k)));
}

// ── 8. One lead rule ────────────────────────────────────────────────────────
section("8. One lead rule, in one place");
{
  ok("the statuses are the dashboard's", LEAD_EXCLUDED_STATUSES.join() === "junk,internal_test");
  ok("our own domain is out", LEAD_INTERNAL_DOMAIN === "bsllc.biz" && COUNTED_LEAD_SQL.includes("%@bsllc.biz"));
  ok("the personal address used while integrating a form is out", COUNTED_LEAD_SQL.includes("sebastienhue@gmail.com"));
  ok("a row with no email is NOT thrown away (a call has none)", /email IS NULL/.test(COUNTED_LEAD_SQL));
  const src = (await import("node:fs")).readFileSync(new URL("./ads/store.ts", import.meta.url), "utf8");
  const uses = (src.match(/COUNTED_LEAD_SQL/g) ?? []).length;
  ok("both lead counts in the store read it (the outcome feed and the phone demand)", uses >= 3, `${uses} mentions`);
  ok("nothing in the store restates the status list by hand", !/status\s*(<>|NOT IN|!=)\s*(ALL\()?\(?\s*'junk'/.test(src.replace(/COUNTED_LEAD_SQL/g, "")));
}

// ── 9 & 10. The closed-sales tracker, forms and calls ───────────────────────
section("9. The closed-sales tracker is read and labelled");
{
  const raw = JSON.stringify({ v: 1, countedDeals: 5, countedCents: 15_313_700, newestClosed: "2026-10-02", windowStart: "2026-09-03" });
  const t = parseTrackerWins(raw);
  ok("a v1 summary parses into counts", t?.deals === 5 && t.cents === 15_313_700 && t.newestClosed === "2026-10-02" && t.windowStart === "2026-09-03");
  ok("anything else is no tracker, not a nought",
    parseTrackerWins(null) === null && parseTrackerWins("not json") === null
    && parseTrackerWins(JSON.stringify({ v: 2, countedDeals: 5, countedCents: 1 })) === null
    && parseTrackerWins(JSON.stringify({ v: 1, countedDeals: "x", countedCents: 1 })) === null
    && parseTrackerWins(JSON.stringify({ v: 1, countedDeals: -1, countedCents: 1 })) === null);
  const facts = (over: Partial<OutcomeFeedFacts> = {}): OutcomeFeedFacts => ({
    leadsInWindow: 244, gclidLeadsInWindow: 12, newestGclidLeadOn: "2026-10-09",
    split: { forms: 33, calls: 211, unclassified: 0, gclidForms: 0, gclidCalls: 12, gclidUnclassified: 0 },
    windowStart: "2026-07-14", windowEnd: "2026-10-11",
    crmRowsInWindow: 0, wonInWindow: 0, wonWindowMonths: 3, measuredWonValueCents: null, uploadsEver: 0, newestUploadOn: null,
    leftOut: 4, tracker: t,
    ...over,
  });
  const r = outcomeReadiness(facts(), null)!;
  ok("with no CRM outcome and a tracker the verdict is tracker_only", r.verdict === "tracker_only", r.verdict);
  const all = `${r.lines.join(" ")} ${r.blockers.join(" ")}`;
  ok("the tracker line says whose match it is and that the client has not confirmed it",
    /BS LLC's own tracker holds 5 closed sale/.test(all) && /\$153,137/.test(all) && /has not confirmed/.test(all));
  ok("…and that it carries no click id", /no click id/.test(all));
  ok("it is never merged with the CRM's count", r.metrics.won === 0 && r.metrics.trackerWon === 5);
  const noTracker = outcomeReadiness(facts({ tracker: null }), null)!;
  ok("control: without a tracker it is no_outcomes, as before", noTracker.verdict === "no_outcomes");
  ok("the lead count says what it left out", /4 more lead\(s\) .* left out/.test(r.lines.join(" ")));

  section("10. Forms and calls are told apart");
  ok("the form blocker names forms and what to add", r.blockers.some((b) => /None of the 33 site forms carries a click id/.test(b) && /hidden Google click id field/.test(b)), r.blockers.join(" | ").slice(0, 160));
  ok("calls are described once, as the tracker's setting, not as a fix for the forms",
    r.lines.some((l) => /Calls carry a click id only where the call tracker passes it on \(12 of 211 do\)/.test(l)));
  ok("no blocker nags about calls", !r.blockers.some((b) => /call/i.test(b) && !/call tracker|tracker/i.test(b) && !/BS LLC's own/.test(b)));
  const few = outcomeReadiness(facts({ split: { forms: MIN_FORMS_FOR_CLICK_ID_VERDICT - 1, calls: 211, unclassified: 0, gclidForms: 0, gclidCalls: 12, gclidUnclassified: 0 }, tracker: null }), null)!;
  ok("under the form floor, no verdict is read from a handful of forms", !few.blockers.some((b) => /site forms carries/.test(b)));
  const none = outcomeReadiness(facts({ gclidLeadsInWindow: 0, newestGclidLeadOn: null, split: { forms: 33, calls: 211, unclassified: 0, gclidForms: 0, gclidCalls: 0, gclidUnclassified: 0 } }), null)!;
  ok("no click id anywhere is still the old blocker", none.verdict === "no_click_ids");
}

section("Ruleset");
ok("the ruleset version moved with the rules", ADS_RULESET_VERSION === 11);

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
// KeywordRow is imported for the type only.
export type _Unused = KeywordRow;

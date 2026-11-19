#!/usr/bin/env tsx
/**
 * Meta ads in depth: the Graph door, the daily ad / placement / settings store, and
 * the rules over them.
 *
 * Proves, over INVENTED rows (no Meta account, no token, no network beyond a pretend
 * server on this machine):
 *
 *   1. it only READS: one `fetch`, a GET, no method, no body, no write edge, and every
 *      request the fake server sees is a GET
 *   2. the normalisers: micros once, link clicks not Clicks (All), one lead counted
 *      once, null versus zero, an unplaceable row refuses the part
 *   3. windows and entity reconcile (a type not read in full closes nothing)
 *   4. the rules, REFUSALS FIRST: each one fires on its fixture and stays silent on its
 *      control; a stale, failed or missing record makes every type unrecheckable
 *   5. the job against a pretend Graph server: paging, a rate limit, a failure, the
 *      ceiling that refuses to write, a token that never reaches an error
 *   6. the workflow and the registrations
 *   7. the real store, on a throwaway schema (when ADS_VERIFY_DATABASE_URL is set)
 *   8. self-tests: every regex instrument here bites on a planted failure
 *
 *   npm run verify-meta-depth
 */
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ADS_RULESET_VERSION } from "./ads/rules.js";
import { FINDING_STAGE } from "./ads/sequence.js";
import {
  AD_DAY_FIELDS, SEGMENT_FIELDS, buildAdDayRows, buildSegmentRows, metaDaysWindow, minorToMicros, normalizeAd, normalizeAdSet, normalizeCampaign,
  reconcileEntities, sliceWindow, targetingSummary, metaEntityHash, type MetaEntityRow, type OpenEntity,
} from "./meta/depth.js";
import { graphGetUrl, graphList, scrubToken } from "./meta/graph.js";
import { runAccount } from "./meta/depth-run.js";
import { ensureMetaDepthTables, loadMetaDepthInput, recordMetaFailure } from "./meta/depth-store.js";
import {
  META_FINDING_TYPES, META_FLOORS, evaluateMetaDepth, frequencyLowerBound, type DepthEntity, type MetaDepthInput,
} from "./meta/rules.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n${s}`);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(here, rel), "utf8");
const codeOnly = (src: string) => src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

// ── 1. It only reads ─────────────────────────────────────────────────────────
section("1. It only reads: nothing here is written to Meta");
const DEPTH_FILES = ["meta/graph.ts", "meta/depth.ts", "meta/depth-store.ts", "meta/depth-run.ts", "meta/rules.ts", "ads-meta-days.ts"];
export function writeFaults(rel: string, src: string): string[] {
  const code = codeOnly(src);
  const out: string[] = [];
  if (/\bmethod\s*:/.test(code)) out.push("names a request method");
  if (/\bbody\s*:/.test(code)) out.push("sends a body");
  if (/["'`](POST|PUT|PATCH|DELETE)["'`]/.test(code)) out.push("names a write verb");
  const fetches = (code.match(/\bfetch\s*\(/g) ?? []).length;
  if (rel === "meta/graph.ts" ? fetches !== 1 : fetches !== 0) out.push(`${fetches} fetch call(s)`);
  if (/\/(adcreatives|adimages|advideos|customaudiences|ads_volume|copies|reportstats)\b/i.test(code)) out.push("names a write edge");
  if (/\bUPDATE\s+ads_findings|\bINSERT\s+INTO\s+ads_findings|\bad_account_mutate|\bapply[A-Z]\w*Change/.test(code)) out.push("writes findings or applies a change");
  return out;
}
for (const f of DEPTH_FILES) {
  const bad = writeFaults(f, read(f));
  ok(`${f} makes no write call and names no write edge`, bad.length === 0, bad.join("; "));
}
ok("the Graph door is one GET", /fetch\(url\)/.test(codeOnly(read("meta/graph.ts"))) && !/fetch\([^)]*,/.test(codeOnly(read("meta/graph.ts"))));
ok("no workflow sets the test seam", readdirSync(join(root, ".github/workflows")).every((w) => !/META_FAKE_BASE/.test(readFileSync(join(root, ".github/workflows", w), "utf8"))));
ok("link clicks are requested and Clicks (All) is not", /inline_link_clicks/.test(AD_DAY_FIELDS) && !/(^|,)clicks(,|$)/.test(AD_DAY_FIELDS) && !/(^|,)clicks(,|$)/.test(SEGMENT_FIELDS));
ok("Meta's own ctr is not requested (it is over Clicks (All))", !/(^|,)ctr(,|$)/.test(AD_DAY_FIELDS));

// ── 2. Normalisers ───────────────────────────────────────────────────────────
section("2. Normalisers: micros once, link clicks, one lead once, null versus zero");
const raw = (over: Record<string, unknown> = {}) => ({
  campaign_id: "7001", campaign_name: "Leads", adset_id: "8001", adset_name: "Set", ad_id: "9001", ad_name: "Ad", date_start: "2026-11-10", date_stop: "2026-11-10",
  spend: "12.505", impressions: "1000", reach: "800", frequency: "1.25", inline_link_clicks: "20", clicks: "55",
  actions: [{ action_type: "lead", value: "2" }, { action_type: "offsite_conversion.fb_pixel_lead", value: "2" }, { action_type: "link_click", value: "20" }],
  ...over,
});
{
  const b = buildAdDayRows([raw()]);
  const r = b.rows[0]!;
  ok("spend is micros, once", r.spendMicros === 12_505_000);
  ok("link clicks are the link-click figure, not Clicks (All)", r.linkClicks === 20);
  ok("one lead reported under two names counts once", r.conversions === 2);
  ok("reach and frequency are stored as returned", r.reach === 800 && r.frequency === 1.25);
  const none = buildAdDayRows([raw({ inline_link_clicks: undefined, reach: undefined, frequency: undefined, actions: [] })]).rows[0]!;
  ok("no link-click figure is null, with no fallback to clicks", none.linkClicks === null);
  ok("no reach or frequency is null, not nought", none.reach === null && none.frequency === null);
  ok("no conversion anywhere in the window is null, not nought", none.conversions === null);
  const mixed = buildAdDayRows([raw({ date_start: "2026-11-10", date_stop: "2026-11-10" }), raw({ date_start: "2026-11-11", date_stop: "2026-11-11", actions: [] })]).rows;
  ok("a day with none beside a day with some is a real nought", mixed[1]!.conversions === 0 && mixed[0]!.conversions === 2);
  ok("a row with no spend is unplaceable", buildAdDayRows([raw({ spend: undefined })]).unplaceable === 1);
  ok("a row with no ad id is unplaceable", buildAdDayRows([raw({ ad_id: "abc" })]).unplaceable === 1);
  ok("a date range instead of a day is unplaceable", buildAdDayRows([raw({ date_stop: "2026-11-12" })]).unplaceable === 1);
  const dup = buildAdDayRows([raw(), raw()]).rows;
  ok("a repeated ad-day sums the additive figures and nulls reach and frequency", dup.length === 1 && dup[0]!.impressions === 2000 && dup[0]!.reach === null && dup[0]!.frequency === null);
  const seg = buildSegmentRows([{ ...raw(), publisher_platform: "instagram", platform_position: "story" }], "placement");
  ok("a placement segment is platform/position", seg.rows[0]?.segment === "instagram/story");
  ok("a segment row without its breakdown is unplaceable", buildSegmentRows([raw()], "age").unplaceable === 1);
  ok("age and gender are labels of delivery, no person", buildSegmentRows([{ ...raw(), age: "25-34" }], "age").rows[0]?.segment === "25-34");
}
{
  ok("a budget in minor units is micros (cents x 10,000)", minorToMicros("5000") === 50_000_000);
  ok("a missing or zero budget is null", minorToMicros(undefined) === null && minorToMicros("0") === null);
  const t = targetingSummary({ geo_locations: { countries: ["US"], cities: [{ key: "1" }, { key: "2" }] }, flexible_spec: [{ interests: [{ id: 1, name: "SECRET" }, { id: 2, name: "TWO" }] }], custom_audiences: [{ id: "c" }], age_min: 25 });
  ok("targeting is counts only", t.countries === 1 && t.cities === 2 && t.interests === 2 && t.custom_audiences === 1 && !JSON.stringify(t).includes("SECRET"));
  const e = normalizeAdSet({ id: "8001", name: "S", campaign_id: "7001", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "5000", optimization_goal: "LEAD_GENERATION", learning_stage_info: { status: "LEARNING", attribution_windows: ["x"], conversions: 17 }, targeting: {} })!;
  ok("the learning status is kept and the daily-changing event count is not", e.attrs.learning_status === "LEARNING" && !("conversions" in e.attrs) && !JSON.stringify(e.attrs).includes("17"));
  ok("an entity with no numeric id is dropped", normalizeCampaign({ id: "x" }) === null && normalizeAd({ id: "" }) === null);
}

// ── 3. Windows and reconcile ─────────────────────────────────────────────────
section("3. Windows and the entity snapshot");
{
  ok("the window ends yesterday and a first run is 60 days", (() => { const w = metaDaysWindow("2026-11-20", true); return w.end === "2026-11-19" && w.start === "2026-09-21"; })());
  ok("a refresh is 14 days", (() => { const w = metaDaysWindow("2026-11-20", false); return w.end === "2026-11-19" && w.start === "2026-11-06"; })());
  ok("a nonsense or huge days value is clamped", metaDaysWindow("2026-11-20", false, 5000).start === "2026-08-22" && metaDaysWindow("2026-11-20", false, 0).start === "2026-11-19");
  const sl = sliceWindow({ start: "2026-09-21", end: "2026-11-19" });
  ok("a window is cut into 14-day slices that tile it", sl.length === 5 && sl[0]!.start === "2026-09-21" && sl[4]!.end === "2026-11-19" && sl.every((s, i) => i === 0 || s.start > sl[i - 1]!.end));
  const mk = (id: string, name: string, status = "ACTIVE"): MetaEntityRow => normalizeAdSet({ id, name, campaign_id: "7001", status, effective_status: status })!;
  const open = (e: MetaEntityRow, vf: string, ls: string): OpenEntity => ({ id: `row-${e.entityId}`, entityType: e.entityType, entityId: e.entityId, contentHash: metaEntityHash(e), validFrom: vf, lastSeenOn: ls });
  const a = mk("1", "A"), b = mk("2", "B");
  const same = reconcileEntities({ open: [open(a, "2026-11-01", "2026-11-18")], read: [a], on: "2026-11-19", completeTypes: ["adset"] });
  ok("an unchanged entity only moves last_seen_on", same.touches.length === 1 && same.opens.length === 0 && same.closes.length === 0);
  const changed = reconcileEntities({ open: [open(a, "2026-11-01", "2026-11-18")], read: [mk("1", "A2")], on: "2026-11-19", completeTypes: ["adset"] });
  ok("a changed entity closes on the date it was last confirmed and opens a new interval", changed.closes[0]?.validTo === "2026-11-18" && changed.opens.length === 1);
  const sameDay = reconcileEntities({ open: [open(a, "2026-11-19", "2026-11-19")], read: [mk("1", "A2")], on: "2026-11-19", completeTypes: ["adset"] });
  ok("a change on the day an interval opened replaces it in place", sameDay.replaces.length === 1 && sameDay.closes.length === 0);
  const gone = reconcileEntities({ open: [open(a, "2026-11-01", "2026-11-18"), open(b, "2026-11-01", "2026-11-18")], read: [a], on: "2026-11-19", completeTypes: ["adset"] });
  ok("an entity missing from a COMPLETE read is closed on its last-seen date", gone.closes.length === 1 && gone.closes[0]!.validTo === "2026-11-18");
  const partial = reconcileEntities({ open: [open(a, "2026-11-01", "2026-11-18"), open(b, "2026-11-01", "2026-11-18")], read: [a], on: "2026-11-19", completeTypes: [] });
  ok("a type not read in full closes NOTHING", partial.closes.length === 0 && partial.incompleteTypes.includes("adset"));
  const both = reconcileEntities({ open: [open(a, "2026-11-01", "2026-11-18")], read: [], on: "2026-11-19", completeTypes: ["campaign", "ad"] });
  ok("completing other types does not close this one", both.closes.length === 0);
}

// ── 4. The rules ─────────────────────────────────────────────────────────────
section("4. The rules: refusals first, then each rule on its fixture and its control");
const TODAY = "2026-11-20";
const ANCHOR = "2026-11-18"; // covered to 11-19, one day held back
const days = (from: string, n: number): string[] => Array.from({ length: n }, (_, i) => { const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
const back = (n: number) => { const d = new Date(`${ANCHOR}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
type Day = { adId: string; adsetId: string; campaignId: string; day: string; spend: number; imp: number; reach: number | null; clicks: number | null; conv: number | null };
const toRows = (ds: Day[]) => ds.map((d) => ({
  campaignId: d.campaignId, adsetId: d.adsetId, adId: d.adId, campaignName: "C", adsetName: `Set ${d.adsetId}`, adName: `Ad ${d.adId}`, day: d.day,
  spendMicros: d.spend, impressions: d.imp, reach: d.reach, frequency: null, linkClicks: d.clicks, conversions: d.conv, conversionValue: null,
}));
const mkInput = (ds: Day[], over: Partial<MetaDepthInput> = {}): MetaDepthInput => ({
  today: TODAY, accountId: "act_1", accountName: "Acct", adDays: toRows(ds), segments: [], entities: [], cplCeilingCents: null,
  scans: {
    ad_days: { present: true, ok: true, coveredFrom: "2026-10-01", coveredTo: "2026-11-19" },
    segments: { present: true, ok: true, coveredFrom: "2026-10-01", coveredTo: "2026-11-19" },
    entities: { present: true, ok: true, coveredFrom: "2026-11-19", coveredTo: "2026-11-19" },
  },
  ...over,
});
const ent = (type: DepthEntity["entityType"], id: string, over: Partial<DepthEntity> = {}): DepthEntity => ({
  entityType: type, entityId: id, parentId: null, name: `${type} ${id}`, effectiveStatus: "ACTIVE", dailyBudgetMicros: null, lifetimeBudgetMicros: null,
  optimizationGoal: null, validFrom: "2026-10-01", attrs: {}, ...over,
});
const of = (r: ReturnType<typeof evaluateMetaDepth>, t: string) => r.findings.filter((f) => f.findingType === t);
const range = (a: number, b: number) => days(back(a), a - b + 1);

// Refusals: the data is not there.
{
  const ds: Day[] = range(13, 0).map((d) => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 10e6, imp: 1000, reach: 100, clicks: 1, conv: 1 }));
  const none = evaluateMetaDepth(mkInput(ds, { scans: { ...mkInput([]).scans, ad_days: { present: false, ok: false, coveredFrom: "x", coveredTo: "y" } } }));
  ok("no ad-day record: no finding, and every type is unrecheckable", none.findings.length === 0 && META_FINDING_TYPES.every((t) => none.accounting.unrecheckable.has(t)));
  const failed = evaluateMetaDepth(mkInput(ds, { scans: { ...mkInput([]).scans, ad_days: { present: true, ok: false, coveredFrom: "2026-10-01", coveredTo: "2026-11-19" } } }));
  ok("a failed last read: no finding and every type unrecheckable", failed.findings.length === 0 && META_FINDING_TYPES.every((t) => failed.accounting.unrecheckable.has(t)));
  const stale = evaluateMetaDepth(mkInput(ds, { scans: { ...mkInput([]).scans, ad_days: { present: true, ok: true, coveredFrom: "2026-10-01", coveredTo: "2026-11-10" } } }));
  ok("a record last read ten days ago: no finding, and the reason names the date", stale.findings.length === 0 && /2026-11-10/.test(stale.accounting.unrecheckable.get("meta_creative_fatigue") ?? ""));
  const noSeg = evaluateMetaDepth(mkInput(ds, { scans: { ...mkInput([]).scans, segments: { present: false, ok: false, coveredFrom: "x", coveredTo: "y" } } }));
  ok("a missing placement record makes only the placement type unrecheckable", noSeg.accounting.unrecheckable.has("meta_placement_waste") && !noSeg.accounting.unrecheckable.has("meta_creative_fatigue"));
  const noEnt = evaluateMetaDepth(mkInput(ds, { scans: { ...mkInput([]).scans, entities: { present: true, ok: false, coveredFrom: "2026-11-19", coveredTo: "2026-11-19" } } }));
  ok("a failed settings snapshot makes the settings-dependent types unrecheckable", ["meta_thin_signal", "meta_budget_pacing", "meta_winner_scale", "meta_loser_pause"].every((t) => noEnt.accounting.unrecheckable.has(t)));
  const short = evaluateMetaDepth(mkInput(ds, { scans: { ...mkInput([]).scans, ad_days: { present: true, ok: true, coveredFrom: back(3), coveredTo: "2026-11-19" } } }));
  ok("a record that does not reach back far enough runs no windowed rule and says so", short.findings.length === 0 && short.accounting.silent.length > 0);
}

// 1 creative fatigue
{
  const mkAd = (recentReach: number | null, recentClicks: number | null) => [
    ...range(13, 7).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 10e6, imp: 1000, reach: 900, clicks: 20, conv: 1 })),
    ...range(6, 0).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 10e6, imp: 1000, reach: recentReach, clicks: recentClicks, conv: 1 })),
  ];
  const fire = of(evaluateMetaDepth(mkInput(mkAd(300, 10))), "meta_creative_fatigue");
  ok("fatigue: fires when link clicks per impression fell 30%+ and frequency is at least 3", fire.length === 1 && fire[0]!.entityType === "ad" && /at least/i.test(fire[0]!.summary));
  ok("fatigue: is a vendor proposal with no payload and no money", fire[0]!.applicability === "vendor" && fire[0]!.changePayload === null && fire[0]!.estImpactCents === 0);
  ok("fatigue: says it is a comparison, not a reason, and that the floors are ours", /not a reason/.test(fire[0]!.summary) && fire[0]!.evidence.lines.some((l) => /our own line/.test(l)));
  ok("fatigue: silent when the audience is not seeing it often (reach high)", of(evaluateMetaDepth(mkInput(mkAd(900, 10))), "meta_creative_fatigue").length === 0);
  ok("fatigue: silent when the click rate held", of(evaluateMetaDepth(mkInput(mkAd(300, 20))), "meta_creative_fatigue").length === 0);
  ok("fatigue: silent when reach is unanswered (null), never read as nought", of(evaluateMetaDepth(mkInput(mkAd(null, 10))), "meta_creative_fatigue").length === 0);
  ok("fatigue: silent when link clicks are unanswered", of(evaluateMetaDepth(mkInput(mkAd(300, null))), "meta_creative_fatigue").length === 0);
  const thin = [...range(13, 7).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 1e6, imp: 50, reach: 40, clicks: 2, conv: 1 })), ...range(6, 0).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 1e6, imp: 50, reach: 10, clicks: 0, conv: 1 }))];
  ok("fatigue: silent under the impression floor", of(evaluateMetaDepth(mkInput(thin)), "meta_creative_fatigue").length === 0);
  ok("frequency is a LOWER bound: impressions over the sum of daily reach", frequencyLowerBound({ impressions: 7000, reach: 2100 })!.toFixed(2) === "3.33" && frequencyLowerBound({ impressions: 10, reach: null }) === null && frequencyLowerBound({ impressions: 10, reach: 0 }) === null);
}

// 2 audience saturation
{
  const mk = (recentConv: number) => [
    ...range(27, 14).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 50e6, imp: 600, reach: 100, clicks: 10, conv: 1 })),
    ...range(13, 0).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 50e6, imp: 600, reach: 100, clicks: 10, conv: recentConv })),
  ];
  const f = of(evaluateMetaDepth(mkInput(mk(0.6))), "meta_audience_saturation");
  ok("saturation: fires when cost per result rose 25%+ at a frequency of at least 4", f.length === 1 && f[0]!.entityType === "ad_group");
  ok("saturation: silent when the cost per result held", of(evaluateMetaDepth(mkInput(mk(1))), "meta_audience_saturation").length === 0);
  const few = [...range(27, 14).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 50e6, imp: 600, reach: 100, clicks: 10, conv: 0.2 })), ...range(13, 0).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 50e6, imp: 600, reach: 100, clicks: 10, conv: 0.1 }))];
  ok("saturation: silent under five results a side", of(evaluateMetaDepth(mkInput(few)), "meta_audience_saturation").length === 0);
  const nul = mk(0.6).map((d) => ({ ...d, conv: null }));
  ok("saturation: silent when results are unanswered (null)", of(evaluateMetaDepth(mkInput(nul)), "meta_audience_saturation").length === 0);
}

// 3 placement waste
{
  const seg = (placement: string, spend: number, conv: number | null, adset = "8"): MetaDepthInput["segments"][number][] =>
    range(13, 0).map((d) => ({ campaignId: "7", adsetId: adset, day: d, kind: "placement" as const, segment: placement, spendMicros: spend, impressions: 100, linkClicks: 1, conversions: conv }));
  const withSegs = (s: MetaDepthInput["segments"]) => mkInput([], { segments: s });
  const good = [...seg("facebook/feed", 9e6, 1), ...seg("facebook/story", 5e6, 0)];
  const f = of(evaluateMetaDepth(withSegs(good)), "meta_placement_waste");
  ok("placement: fires on a placement with a real share of spend and no results while the ad set had results", f.length === 1 && f[0]!.evidence.lines.some((l) => /facebook\/story/.test(l)));
  ok("placement: silent when the placement's results are unanswered (null)", of(evaluateMetaDepth(withSegs([...seg("facebook/feed", 9e6, 1), ...seg("facebook/story", 5e6, null)])), "meta_placement_waste").length === 0);
  ok("placement: silent when the ad set itself returned too little to compare", of(evaluateMetaDepth(withSegs([...seg("facebook/feed", 9e6, 0.2), ...seg("facebook/story", 5e6, 0)])), "meta_placement_waste").length === 0);
  ok("placement: silent when the placement is a small share", of(evaluateMetaDepth(withSegs([...seg("facebook/feed", 14e6, 1), ...seg("facebook/story", 0.4e6, 0)])), "meta_placement_waste").length === 0);
  const seg2 = mkInput([], { segments: good, scans: { ...mkInput([]).scans, segments: { present: true, ok: true, coveredFrom: "2026-11-10", coveredTo: "2026-11-19" } } });
  ok("placement: does not run when the record does not reach back the whole window", of(evaluateMetaDepth(seg2), "meta_placement_waste").length === 0 && evaluateMetaDepth(seg2).accounting.silent.some((s) => /placement/.test(s)));
}

// 4 thin signal
{
  const ds = range(6, 0).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 50e6, imp: 1000, reach: 900, clicks: 10, conv: 2 }));
  const set = (over: Partial<DepthEntity>) => [ent("adset", "8", { parentId: "7", optimizationGoal: "OFFSITE_CONVERSIONS", attrs: { learning_status: "LEARNING" }, ...over })];
  ok("thin signal: fires under the weekly events line", of(evaluateMetaDepth(mkInput(ds, { entities: set({}) })), "meta_thin_signal").length === 1);
  ok("thin signal: silent when the platform already marked the ad set limited (its own finding says so)", of(evaluateMetaDepth(mkInput(ds, { entities: set({ attrs: { learning_status: "LEARNING_LIMITED" } }) })), "meta_thin_signal").length === 0);
  ok("thin signal: silent for a goal that is not a result (reach)", of(evaluateMetaDepth(mkInput(ds, { entities: set({ optimizationGoal: "REACH" }) })), "meta_thin_signal").length === 0);
  ok("thin signal: silent for a paused ad set", of(evaluateMetaDepth(mkInput(ds, { entities: set({ effectiveStatus: "PAUSED" }) })), "meta_thin_signal").length === 0);
  ok("thin signal: silent when results are unanswered", of(evaluateMetaDepth(mkInput(ds.map((d) => ({ ...d, conv: null })), { entities: set({}) })), "meta_thin_signal").length === 0);
  const enough = ds.map((d) => ({ ...d, conv: 10 }));
  ok("thin signal: silent at the line", of(evaluateMetaDepth(mkInput(enough, { entities: set({}) })), "meta_thin_signal").length === 0);
  ok("thin signal: the guidance figure is stated as unverified and ours", /unverified/.test(of(evaluateMetaDepth(mkInput(ds, { entities: set({}) })), "meta_thin_signal")[0]!.summary));
}

// 5 budget pacing
{
  const ds = (spend: number) => range(6, 0).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend, imp: 1000, reach: 900, clicks: 10, conv: 1 }));
  const camp = (over: Partial<DepthEntity>) => [ent("campaign", "7", { dailyBudgetMicros: 100e6, ...over })];
  ok("pacing: fires when a live campaign spends under 60% of its daily budget", of(evaluateMetaDepth(mkInput(ds(30e6), { entities: camp({}) })), "meta_budget_pacing").length === 1);
  ok("pacing: silent near the budget", of(evaluateMetaDepth(mkInput(ds(90e6), { entities: camp({}) })), "meta_budget_pacing").length === 0);
  ok("pacing: silent when the budget changed inside the window", of(evaluateMetaDepth(mkInput(ds(30e6), { entities: camp({ validFrom: back(2) }) })), "meta_budget_pacing").length === 0);
  ok("pacing: silent for a paused campaign", of(evaluateMetaDepth(mkInput(ds(30e6), { entities: camp({ effectiveStatus: "PAUSED" }) })), "meta_budget_pacing").length === 0);
  ok("pacing: silent for a lifetime budget (no daily figure)", of(evaluateMetaDepth(mkInput(ds(30e6), { entities: [ent("campaign", "7", { lifetimeBudgetMicros: 900e6 })] })), "meta_budget_pacing").length === 0);
  const abo = [ent("campaign", "7"), ent("adset", "8", { parentId: "7", dailyBudgetMicros: 100e6 })];
  ok("pacing: reads an ad-set budget when the campaign carries none", of(evaluateMetaDepth(mkInput(ds(30e6), { entities: abo })), "meta_budget_pacing").length === 1);
}

// 6 winner and 7 loser
{
  const set = (adsetId: string, adId: string, spend: number, conv: number, reach = 600): Day[] =>
    range(13, 0).map((d) => ({ adId, adsetId, campaignId: "7", day: d, spend, imp: 1000, reach, clicks: 10, conv }));
  // W1: 28 results for $280 ($10 each). W2 and W3: 14 results for $840 ($60 each). Peers: $60.
  const base6 = (w1reach = 600) => [...set("W1", "1", 20e6, 2, w1reach), ...set("W2", "2", 60e6, 1), ...set("W3", "3", 60e6, 1)];
  const ents = [ent("adset", "W1"), ent("adset", "W2"), ent("adset", "W3"), ent("ad", "1"), ent("ad", "2"), ent("ad", "3")];
  const f = of(evaluateMetaDepth(mkInput(base6(), { entities: ents })), "meta_winner_scale");
  ok("winner: fires for one ad set well under its peers with room in its audience", f.length === 1 && f[0]!.entityId === "W1");
  ok("winner: silent when the audience is already seen often", of(evaluateMetaDepth(mkInput(base6(200), { entities: ents })), "meta_winner_scale").length === 0);
  ok("winner: silent without enough peers to compare against", of(evaluateMetaDepth(mkInput([...set("W1", "1", 20e6, 2), ...set("W2", "2", 60e6, 1)], { entities: ents })), "meta_winner_scale").length === 0);
  ok("winner: a recorded cost ceiling the ad set exceeds blocks it", of(evaluateMetaDepth(mkInput(base6(), { entities: ents, cplCeilingCents: 500 })), "meta_winner_scale").length === 0);
  ok("winner: a ceiling it is under leaves it", of(evaluateMetaDepth(mkInput(base6(), { entities: ents, cplCeilingCents: 5_000 })), "meta_winner_scale").length === 1);
  const withLoser = [...base6(), ...set("W2", "bad", 11e6, 0)];
  const l = of(evaluateMetaDepth(mkInput(withLoser, { entities: [...ents, ent("ad", "bad")] })), "meta_loser_pause");
  ok("loser: fires for a live ad with real spend and no result while its ad set returned results", l.length === 1 && l[0]!.entityId === "bad" && l[0]!.entityType === "ad");
  const nul = withLoser.map((d) => (d.adId === "bad" ? { ...d, conv: null } : d));
  ok("loser: silent when the ad's results are unanswered (null is not nought)", of(evaluateMetaDepth(mkInput(nul, { entities: [...ents, ent("ad", "bad")] })), "meta_loser_pause").length === 0);
  ok("loser: silent for a paused ad", of(evaluateMetaDepth(mkInput(withLoser, { entities: [...ents, ent("ad", "bad", { effectiveStatus: "PAUSED" })] })), "meta_loser_pause").length === 0);
  const tiny = withLoser.map((d) => (d.adId === "bad" ? { ...d, spend: 1e6 } : d));
  ok("loser: silent under the spend floor", of(evaluateMetaDepth(mkInput(tiny, { entities: [...ents, ent("ad", "bad")] })), "meta_loser_pause").length === 0);
}

// 8 tracking gap
{
  const mk = (conv: number | null, clicks: number | null) => range(13, 0).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 30e6, imp: 1000, reach: 900, clicks, conv }));
  const camp = (objective: string) => [ent("campaign", "7", { attrs: { objective } })];
  const none = of(evaluateMetaDepth(mkInput(mk(null, 20), { entities: camp("OUTCOME_LEADS") })), "meta_tracking_gap");
  ok("tracking gap: fires when no result of any kind was ever reported and money was spent", none.length === 1 && none[0]!.entityType === "account" && none[0]!.severity === "high");
  ok("tracking gap: fires when results read zero on every day while link clicks continued", of(evaluateMetaDepth(mkInput(mk(0, 20), { entities: camp("OUTCOME_LEADS") })), "meta_tracking_gap").length === 1);
  ok("tracking gap: silent when results were counted", of(evaluateMetaDepth(mkInput(mk(1, 20), { entities: camp("OUTCOME_LEADS") })), "meta_tracking_gap").length === 0);
  const aware = evaluateMetaDepth(mkInput(mk(null, 20), { entities: camp("OUTCOME_AWARENESS") }));
  ok("tracking gap: silent when every live campaign asks for awareness, and the run says why", of(aware, "meta_tracking_gap").length === 0 && aware.accounting.silent.some((s) => /awareness/.test(s)));
  ok("tracking gap: silent under the spend floor", of(evaluateMetaDepth(mkInput(range(13, 0).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 1e6, imp: 100, reach: 90, clicks: 5, conv: null })), { entities: camp("OUTCOME_LEADS") })), "meta_tracking_gap").length === 0);
}

// The shape every finding must have
{
  const ds: Day[] = [...range(13, 7).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 10e6, imp: 1000, reach: 900, clicks: 20, conv: 1 })), ...range(6, 0).map((d): Day => ({ adId: "9", adsetId: "8", campaignId: "7", day: d, spend: 10e6, imp: 1000, reach: 300, clicks: 10, conv: 1 }))];
  const all = evaluateMetaDepth(mkInput(ds, { entities: [ent("campaign", "7", { dailyBudgetMicros: 900e6 })] })).findings;
  ok("every finding is a proposal: vendor, no payload, no impact figure", all.length > 0 && all.every((f) => f.applicability === "vendor" && f.changePayload === null && f.estImpactCents === 0));
  ok("no finding claims a cause", all.every((f) => !/\b(because|due to|caused|is why|the reason is)\b/i.test(`${f.title} ${f.summary}`)));
  ok("every finding type is a registered stage", META_FINDING_TYPES.every((t) => FINDING_STAGE[t] != null));
  ok("the ruleset version is 13", ADS_RULESET_VERSION === 13);
  ok("every floor is declared in one object", typeof META_FLOORS.fatigue.ctrFall === "number" && typeof META_FLOORS.thin.learnEvents === "number");
}

// ── 5. The job against a pretend Graph server ────────────────────────────────
section("5. The job against a pretend Graph server");
interface Seen { method: string; path: string; token: boolean; query: URLSearchParams }
const seen: Seen[] = [];
let mode: "ok" | "rate" | "err400" | "forever" | "unplaceable" | "adsetDown" | "adsetRenamed" = "ok";
let rateLeft = 1;
let baseUrl = "";
const TOKEN = "EAAB" + "x".repeat(40);
const PAGE = 10;
function insightRows(q: URLSearchParams): Record<string, unknown>[] {
  const tr = JSON.parse(q.get("time_range") ?? "{}") as { since: string; until: string };
  const level = q.get("level"), bd = q.get("breakdowns") ?? "";
  const ds = days(tr.since, Math.round((Date.parse(tr.until) - Date.parse(tr.since)) / 86_400_000) + 1);
  const rows: Record<string, unknown>[] = [];
  for (const d of ds) {
    if (level === "ad") {
      for (const ad of ["9001", "9002"]) rows.push({ campaign_id: "7001", campaign_name: "Leads", adset_id: "8001", adset_name: "Set", ad_id: ad, ad_name: `Ad ${ad}`, date_start: d, date_stop: d, spend: "10.00", impressions: "1000", reach: "800", frequency: "1.25", inline_link_clicks: "20", actions: [{ action_type: "lead", value: "1" }] });
    } else {
      const segs = bd.includes("publisher_platform") ? [{ publisher_platform: "facebook", platform_position: "feed" }, { publisher_platform: "instagram", platform_position: "story" }]
        : bd === "age" ? [{ age: "25-34" }, { age: "35-44" }] : [{ gender: "female" }, { gender: "male" }];
      for (const s of segs) rows.push({ campaign_id: "7001", adset_id: "8001", date_start: d, date_stop: d, spend: "5.00", impressions: "500", inline_link_clicks: "10", actions: [{ action_type: "lead", value: "1" }], ...s });
    }
  }
  if (mode === "unplaceable") rows[0] = { ...rows[0], spend: undefined };
  return rows;
}
const entities = (edge: string): Record<string, unknown>[] => {
  if (edge === "campaigns") return [{ id: "7001", name: "Leads", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "10000", objective: "OUTCOME_LEADS" }];
  if (edge === "adsets") return [{ id: "8001", name: mode === "adsetRenamed" ? "Set renamed" : "Set", campaign_id: "7001", status: mode === "adsetDown" ? "PAUSED" : "ACTIVE", effective_status: mode === "adsetDown" ? "PAUSED" : "ACTIVE", optimization_goal: "LEAD_GENERATION", daily_budget: "10000" }];
  return [{ id: "9001", name: "Ad 9001", adset_id: "8001", campaign_id: "7001", status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "5001" } }, { id: "9002", name: "Ad 9002", adset_id: "8001", campaign_id: "7001", status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "5002" } }];
};
const nextUrl = (u: URL, page: number): string => { const n = new URL(`${baseUrl}${u.pathname}`); u.searchParams.forEach((v, k) => n.searchParams.set(k, v)); n.searchParams.set("after", String(page)); return n.toString(); };
const server: Server = createServer((req: IncomingMessage, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  seen.push({ method: req.method ?? "", path: u.pathname, token: u.searchParams.get("access_token") === TOKEN, query: u.searchParams });
  const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (mode === "rate" && rateLeft > 0) { rateLeft--; return send(429, { error: { message: "Too many calls", code: 17 } }); }
  if (mode === "err400") return send(400, { error: { message: `bad request for access_token=${TOKEN}`, code: 100 } });
  const m = u.pathname.match(/^\/act_111\/(insights|campaigns|adsets|ads)$/);
  if (!m) return send(404, { error: { message: "no such edge", code: 803 } });
  const edge = m[1]!;
  const all = edge === "insights" ? insightRows(u.searchParams) : entities(edge);
  const page = Number(u.searchParams.get("after") ?? 0);
  if (mode === "forever") { return send(200, { data: [all[0]], paging: { next: nextUrl(u, page + 1) } }); }
  const slice = all.slice(page * PAGE, (page + 1) * PAGE);
  const body: Record<string, unknown> = { data: slice };
  if ((page + 1) * PAGE < all.length) body.paging = { next: nextUrl(u, page + 1) };
  send(200, body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.META_FAKE_BASE = baseUrl;
process.env.META_RETRY_MS = "0";
const target = { clientId: "CL", clientName: "Client", accountId: "act_111" };
try {
  const run = await runAccount(null, TOKEN, target, TODAY, { write: false });
  ok("all three parts are read", run.parts.ad_days.ok && run.parts.segments.ok && run.parts.entities.ok, JSON.stringify({ a: run.parts.ad_days.rows, s: run.parts.segments.rows, e: run.parts.entities.rows }));
  ok("a first run reads 60 days of two ads", run.parts.ad_days.rows === 120);
  ok("segments read all three breakdowns across 60 days", run.parts.segments.rows === 60 * (2 + 2 + 2));
  ok("entities are one campaign, one ad set, two ads", run.parts.entities.rows === 4);
  ok("paging was followed (a page of ten rows, 28 rows a slice)", seen.some((s) => s.query.get("after") === "2") && run.parts.ad_days.rows === 120);
  ok("every request was a GET", seen.length > 0 && seen.every((s) => s.method === "GET"));
  ok("every request carried the token, in the query", seen.every((s) => s.token));
  ok("ad-level insights asked for daily increments and the ad fields", seen.some((s) => s.query.get("level") === "ad" && s.query.get("time_increment") === "1" && s.query.get("fields") === AD_DAY_FIELDS));
  ok("the breakdown passes asked for placement, age and gender", ["publisher_platform,platform_position", "age", "gender"].every((b) => seen.some((s) => s.query.get("breakdowns") === b)));
  ok("no request names a mutation edge", seen.every((s) => !/\/(adcreatives|adimages|customaudiences)$/.test(s.path)));

  seen.length = 0; mode = "rate"; rateLeft = 2;
  const rate = await runAccount(null, TOKEN, target, TODAY, { write: false, days: 14 });
  ok("a rate limit is retried and the read still completes", rate.parts.ad_days.ok && seen.some((s) => s.path.endsWith("/insights")));

  seen.length = 0; mode = "err400";
  const err = await runAccount(null, TOKEN, target, TODAY, { write: false });
  ok("a refusal fails each part and says so", !err.parts.ad_days.ok && !err.parts.segments.ok && !err.parts.entities.ok);
  ok("the token never reaches an error message", err.problems.every((p) => !p.includes(TOKEN) && !/EAAB/.test(p)), err.problems[0] ?? "");
  const raw400 = await graphGetUrl(`${baseUrl}/act_111/insights?access_token=${TOKEN}`).then(() => "", (e: Error) => e.message);
  ok("the Graph door's own error never carries the token", raw400.length > 0 && !raw400.includes(TOKEN) && !/EAAB/.test(raw400), raw400);
  ok("scrubToken removes a token from any text", !scrubToken(`x access_token=${TOKEN} y ${TOKEN}`).includes("EAAB"));

  mode = "forever";
  const cut = await runAccount(null, TOKEN, target, TODAY, { write: false, pageCeiling: 3 });
  ok("a read cut by the page ceiling is a failure, not a partial write", !cut.parts.ad_days.ok && /not complete/.test(cut.parts.ad_days.note));
  const list = await graphList(TOKEN, "act_111/insights", { time_range: JSON.stringify({ since: "2026-11-01", until: "2026-11-01" }) }, { rowCeiling: 5 });
  ok("graphList reports a list cut at the row ceiling as incomplete", list.complete === false && /ceiling/.test(list.why ?? ""));

  mode = "unplaceable";
  const bad = await runAccount(null, TOKEN, target, TODAY, { write: false });
  ok("a row that cannot be placed refuses its whole part", !bad.parts.ad_days.ok && /could not be placed/.test(bad.parts.ad_days.note));
  mode = "ok";
} finally {
  // keep the server for the SQL section
}

// ── 6. Workflow and registrations ────────────────────────────────────────────
section("6. The workflow and where the job is registered");
const wf = readFileSync(join(root, ".github/workflows/ads-meta-days.yml"), "utf8");
const pkg = readFileSync(join(root, "package.json"), "utf8");
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const ops = read("ads-operability.ts");
ok("it runs daily at 06:25 UTC", /cron: "25 6 \* \* \*"/.test(wf));
ok("a dispatched run is a dry one unless told otherwise", /dry_run:[\s\S]{0,200}default: "true"/.test(wf));
ok("dispatch inputs are client, days and dry_run", /client:/.test(wf) && /days:/.test(wf) && /dry_run:/.test(wf));
ok("inputs go through the environment, never into the command line", /IN_CLIENT: \$\{\{ inputs\.client \}\}/.test(wf) && !/run:[^\n]*\$\{\{ inputs\./.test(wf));
ok("the heartbeat runs on `if: always()` and is skipped for a dry or one-client run", /if: always\(\) && inputs\.dry_run != 'true' && inputs\.client == ''/.test(wf));
ok("the heartbeat job name is ads_meta_days", /--job=ads_meta_days /.test(wf));
ok("the run cannot overlap itself", /concurrency:[\s\S]{0,80}cancel-in-progress: false/.test(wf));
ok("only the Meta token and the database are given to the job", /META_ACCESS_TOKEN: \$\{\{ secrets\.META_ACCESS_TOKEN \}\}/.test(wf) && !/GOOGLE_ADS/.test(wf));
ok("package.json has the job and the guard", /"ads-meta-days": "tsx src\/ads-meta-days\.ts"/.test(pkg) && /"verify-meta-depth": "tsx src\/verify-meta-depth\.ts"/.test(pkg));
ok("CI runs the guard in the pure job and the SQL job", (ci.match(/npm run verify-meta-depth/g) ?? []).length === 2);
ok("the job is registered for Data health", /job: "ads_meta_days"/.test(ops) && /ads-meta-days\.yml/.test(ops));
ok("the Meta finding types are staged in the sequence", META_FINDING_TYPES.every((t) => new RegExp(`${t}: "`).test(read("ads/sequence.ts"))));
ok("the findings run reads the depth rules for Meta and merges the unrecheckable types", /evaluateMetaDepth/.test(read("ads-findings-run.ts")) && /metaUnrecheckable/.test(read("ads-findings-run.ts")));

// ── 7. The real store ────────────────────────────────────────────────────────
const dbUrl = process.env.ADS_VERIFY_DATABASE_URL;
if (!dbUrl) {
  section("7. The real store functions");
  console.log("  ⏭  skipped: ADS_VERIFY_DATABASE_URL is not set. Locally: `node scripts/test-db.mjs start` in the dashboard repo prints a URL.");
  console.log("     CI runs this section in the `ads-store` job against a Postgres service container.");
} else {
  await storeSection(dbUrl);
}

async function storeSection(url: string) {
  section("7. The real store, on a throwaway schema");
  const schema = `meta_depth_${Math.random().toString(36).slice(2, 10)}`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const count = async (sql: string) => Number((await c.query<{ n: string }>(sql)).rows[0]!.n);
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await ensureMetaDepthTables(c);
    await ensureMetaDepthTables(c);
    ok("the tables are created, twice, without error", true);

    const r1 = await runAccount(c, TOKEN, target, TODAY, { write: true });
    ok("a first run writes all three parts", r1.parts.ad_days.ok && r1.parts.segments.ok && r1.parts.entities.ok);
    ok("120 ad-days are stored", (await count(`SELECT count(*) AS n FROM meta_ad_days`)) === 120);
    ok("360 segment-days are stored", (await count(`SELECT count(*) AS n FROM meta_segment_days`)) === 360);
    ok("four entities are open", (await count(`SELECT count(*) AS n FROM meta_entities WHERE valid_to IS NULL`)) === 4);
    ok("each part has a scan row, ok", (await count(`SELECT count(*) AS n FROM meta_scans WHERE ok`)) === 3);
    const sample = (await c.query(`SELECT spend_micros, link_clicks, conversions, reach FROM meta_ad_days LIMIT 1`)).rows[0] as Record<string, string>;
    ok("spend is stored as micros and link clicks as link clicks", Number(sample.spend_micros) === 10_000_000 && Number(sample.link_clicks) === 20 && Number(sample.conversions) === 1);
    const cols = (await c.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'meta_ad_days'`, [schema])).rows.map((r) => r.column_name);
    ok("no column could hold a person", !cols.some((n) => /name_of|email|phone|gender|age_|person|user/.test(n)));

    // A second run (the span now exists): 14 days re-read, the window replaced, entities only touched.
    const r2 = await runAccount(c, TOKEN, target, TODAY, { write: true });
    ok("a second run is a refresh: ad-days are replaced in the window, not doubled", r2.parts.ad_days.ok && (await count(`SELECT count(*) AS n FROM meta_ad_days`)) === 120);
    ok("an unchanged snapshot writes no new interval", (await count(`SELECT count(*) AS n FROM meta_entities`)) === 4);
    ok("the span stayed continuous (covered_from not restarted)", (await c.query<{ f: string }>(`SELECT to_char(covered_from,'YYYY-MM-DD') AS f FROM meta_scans WHERE part='ad_days'`)).rows[0]!.f === "2026-09-21");

    // A change closes the old interval and opens a new one.
    mode = "adsetDown";
    await runAccount(c, TOKEN, target, "2026-11-21", { write: true });
    const intervals = (await c.query<{ n: string; open: string }>(`SELECT count(*) AS n, count(*) FILTER (WHERE valid_to IS NULL) AS open FROM meta_entities WHERE entity_id = '8001'`)).rows[0]!;
    ok("a changed ad set closes its interval and opens another", intervals.n === "2" && intervals.open === "1");
    const closed = (await c.query<{ vt: string }>(`SELECT to_char(valid_to,'YYYY-MM-DD') AS vt FROM meta_entities WHERE entity_id = '8001' AND valid_to IS NOT NULL`)).rows[0]!.vt;
    ok("the closed interval ends on the date it was last confirmed, not on the day the change was noticed", closed === TODAY, closed);
    mode = "ok";

    // A failure keeps the earlier span and the earlier rows.
    const before = await count(`SELECT count(*) AS n FROM meta_ad_days`);
    mode = "err400";
    const f = await runAccount(c, TOKEN, target, "2026-11-22", { write: true });
    mode = "ok";
    ok("a failed read writes a failure row for each part", !f.parts.ad_days.ok && (await count(`SELECT count(*) AS n FROM meta_scans WHERE NOT ok`)) === 3);
    ok("a failed read keeps the earlier rows", (await count(`SELECT count(*) AS n FROM meta_ad_days`)) === before);
    ok("a failed read keeps the covered span", (await c.query<{ t: string }>(`SELECT to_char(covered_to,'YYYY-MM-DD') AS t FROM meta_scans WHERE part='ad_days'`)).rows[0]!.t === "2026-11-20");
    ok("a failed read's detail carries no token", (await c.query<{ d: string }>(`SELECT detail AS d FROM meta_scans WHERE part='ad_days'`)).rows[0]!.d.includes("EAAB") === false);

    // A first-ever failure writes an empty span that covers nothing.
    await recordMetaFailure(c, "OTHER", "act_999", "ad_days", "2026-11-22", "boom");
    const empty = (await c.query<{ f: string; t: string; ok: boolean }>(`SELECT to_char(covered_from,'YYYY-MM-DD') AS f, to_char(covered_to,'YYYY-MM-DD') AS t, ok FROM meta_scans WHERE client_id='OTHER'`)).rows[0]!;
    ok("a first-ever failure is dated and covers nothing", empty.f > empty.t && empty.ok === false);

    // A refused part writes nothing, and the rules then refuse to run on it.
    await c.query(`DELETE FROM meta_ad_days; DELETE FROM meta_segment_days; DELETE FROM meta_entities; DELETE FROM meta_scans;`);
    mode = "unplaceable";
    await runAccount(c, TOKEN, target, TODAY, { write: true });
    mode = "ok";
    ok("an unplaceable row writes no rows for the part", (await count(`SELECT count(*) AS n FROM meta_ad_days`)) === 0);
    const input0 = await loadMetaDepthInput(c, "CL", "act_111", TODAY, "Client", null);
    const out0 = evaluateMetaDepth(input0);
    ok("the rules refuse to run on a failed record and make every type unrecheckable", out0.findings.length === 0 && META_FINDING_TYPES.every((t) => out0.accounting.unrecheckable.has(t)));

    // End to end: stored rows into the loader into the rules.
    await c.query(`DELETE FROM meta_scans`);
    await runAccount(c, TOKEN, target, TODAY, { write: true });
    const input1 = await loadMetaDepthInput(c, "CL", "act_111", TODAY, "Client", null);
    ok("the loader returns the stored days, segments, entities and three ok scans", input1.adDays.length === 120 && input1.segments.length === 360 && input1.entities.length === 4 && input1.scans.ad_days.ok && input1.scans.segments.ok && input1.scans.entities.ok);
    ok("dates come back as plain days (no timezone shift)", /^\d{4}-\d{2}-\d{2}$/.test(input1.adDays[0]!.day));
    const out1 = evaluateMetaDepth(input1);
    ok("the rules run on the stored record without error", Array.isArray(out1.findings));
    ok("a second ensure after data exists is harmless", await ensureMetaDepthTables(c).then(() => true, () => false));
  } finally {
    await c.query(`SET search_path TO public`).catch(() => {});
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
}

server.close();

// ── 8. The instruments bite on a planted failure ─────────────────────────────
section("8. Self-tests: each instrument fails on a planted fault");
ok("the write scan sees a method", writeFaults("meta/depth.ts", `await fetch(u, { method: "POST" })`).length > 0);
ok("the write scan sees a body", writeFaults("meta/depth.ts", `const x = { body: JSON.stringify(y) }`).length > 0);
ok("the write scan sees a second fetch", writeFaults("meta/depth-run.ts", `await fetch(u)`).length > 0);
ok("the write scan sees a write verb", writeFaults("meta/depth.ts", `const v = "DELETE";`).length > 0);
ok("the write scan sees a write edge", writeFaults("meta/depth.ts", `const p = "act_1/adcreatives";`).length > 0);
ok("the write scan passes a clean file", writeFaults("meta/depth.ts", `export const x = 1;`).length === 0);
ok("the workflow check sees an input in a command line", /run:[^\n]*\$\{\{ inputs\./.test(`run: npm run x -- \${{ inputs.client }}`));
ok("the frequency instrument is a lower bound, not an upper one", (frequencyLowerBound({ impressions: 1000, reach: 400 })! <= 1000 / 400) && frequencyLowerBound({ impressions: 1000, reach: 400 }) === 2.5);

console.log(failures === 0 ? "\n✅ Meta depth guard passed" : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

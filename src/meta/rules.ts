/**
 * Meta findings from the depth store (src/meta/depth.ts). PURE: no I/O, no clock;
 * `today` is an argument. Every figure comes from rows the depth job stored, and
 * every rule says what it compared and never why.
 *
 * ── THE RULES THIS FILE FOLLOWS ─────────────────────────────────────────────
 *
 *  · A COMPARISON, NEVER A CAUSE. "Link clicks per impression fell 41% against the
 *    week before" is a measurement. Why it fell (a tired ad, a season, a holiday, a
 *    competitor) is not in the data and no sentence here says it.
 *  · EVERY FLOOR IS OUR OWN LINE. No source publishes one. `META_FLOORS_ARE_OURS`
 *    is printed on every finding that rests on a floor, and the numbers are in one
 *    object so a change is a change in one place. Meta's own ~50 results a week
 *    guidance for learning is cited as guidance, not as a standard, and is treated
 *    as our line too (UNVERIFIED live).
 *  · A NULL IS UNANSWERED. A figure the store holds as null (reach, link clicks,
 *    conversions) never counts as a nought: a rule that needs it does not run, and
 *    the run output says which rule did not and why.
 *  · FREQUENCY IS A LOWER BOUND. Daily reach is not additive (the same person seen
 *    on two days is counted on both), so impressions ÷ Σ daily reach is at or BELOW
 *    the true frequency over the window. The rules fire on the lower bound, so a
 *    claim of "at least N" is safe, and every sentence says "at least".
 *  · A RULE THAT COULD NOT RUN IS NOT A RULE THAT FOUND NOTHING. When the depth
 *    data is missing, old or failed, every type this file owns goes into the
 *    `unrecheckable` map, so the sweep leaves their open rows alone and says so.
 *  · PROPOSALS ONLY. Every finding is `vendor` with no change payload: nothing here
 *    can write to Meta, and the propose/approve split is untouched.
 *  · The platform's OWN learning verdict already has a finding (`learning_limited`,
 *    src/ads/rules.ts). `meta_thin_signal` never duplicates it: it stays silent for
 *    an ad set the platform has already called limited.
 *
 * Finding types (registered in src/ads/sequence.ts FINDING_STAGE; ruleset 13):
 *   meta_creative_fatigue · meta_audience_saturation · meta_placement_waste ·
 *   meta_thin_signal · meta_budget_pacing · meta_winner_scale · meta_loser_pause ·
 *   meta_tracking_gap
 */
import { addDays, daysBetween } from "../ads/daily-metrics.js";
import type { DerivedFinding } from "../ads/rules.js";
import type { AdDayRow, EntityType, SegmentDayRow } from "./depth.js";

export const META_FINDING_TYPES = [
  "meta_creative_fatigue", "meta_audience_saturation", "meta_placement_waste", "meta_thin_signal",
  "meta_budget_pacing", "meta_winner_scale", "meta_loser_pause", "meta_tracking_gap",
] as const;
export type MetaFindingType = (typeof META_FINDING_TYPES)[number];

export const META_FLOORS_ARE_OURS =
  "Every threshold on this row is our own line. No source publishes one, and the same row can read differently under a different line.";
export const META_NO_CAUSE = "This is a comparison of two stretches of days, not a reason. Nothing here says why the figure moved.";

/** All the lines in one place. Money in micros; shares and rates as fractions. */
export const META_FLOORS = {
  /** The newest day is held back: attribution is late and the newest day is the least settled. */
  holdBackDays: 1,
  /** The depth data must reach to within this many days of today or no rule runs. */
  staleAfterDays: 3,
  fatigue: { windowDays: 7, minImpressions: 1_000, ctrFall: 0.30, minFrequencyLB: 3 },
  saturation: { windowDays: 14, minFrequencyLB: 4, minConversions: 5, cprRise: 0.25 },
  placement: { windowDays: 14, minAdsetSpendMicros: 100_000_000, minShare: 0.15, minPlacementSpendMicros: 50_000_000, minAdsetConversions: 10 },
  /** Meta's published guidance is about 50 optimisation events a week for an ad set to leave learning. UNVERIFIED live; treated as our line. */
  thin: { windowDays: 7, learnEvents: 50, minSpendMicros: 50_000_000 },
  pacing: { windowDays: 7, minDaysWithRows: 5, underShare: 0.60 },
  winner: { windowDays: 14, minConversions: 10, cprBelow: 0.70, minPeers: 2, maxFrequencyLB: 2.5 },
  loser: { windowDays: 14, minSpendMicros: 100_000_000, minAdsetConversions: 10, minAdConversionsForCost: 3, cprMultiple: 2 },
  tracking: { windowDays: 14, minSpendMicros: 200_000_000, minLinkClicks: 100 },
} as const;

/** Optimisation goals and objectives that do not ask for a conversion. NAMES UNVERIFIED LIVE: docs/META-DEPTH-UNVERIFIED.md. */
export const NON_CONVERSION_GOALS = new Set([
  "REACH", "IMPRESSIONS", "LINK_CLICKS", "LANDING_PAGE_VIEWS", "POST_ENGAGEMENT", "PAGE_LIKES", "THRUPLAY", "TWO_SECOND_CONTINUOUS_VIDEO_VIEWS",
  "VIDEO_VIEWS", "AD_RECALL_LIFT", "EVENT_RESPONSES", "REPLIES",
]);
export const NON_CONVERSION_OBJECTIVES = new Set([
  "OUTCOME_AWARENESS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "REACH", "BRAND_AWARENESS", "LINK_CLICKS", "POST_ENGAGEMENT", "VIDEO_VIEWS", "PAGE_LIKES",
]);

// ── Input ───────────────────────────────────────────────────────────────────
export interface DepthEntity {
  entityType: EntityType; entityId: string; parentId: string | null; name: string | null;
  effectiveStatus: string | null; dailyBudgetMicros: number | null; lifetimeBudgetMicros: number | null;
  optimizationGoal: string | null; validFrom: string;
  attrs: Record<string, string | number | boolean | null>;
}
export interface PartState { present: boolean; ok: boolean; coveredFrom: string; coveredTo: string }
export interface MetaDepthInput {
  today: string;
  accountId: string;
  accountName: string;
  adDays: AdDayRow[];
  segments: SegmentDayRow[];
  entities: DepthEntity[];
  scans: { ad_days: PartState; segments: PartState; entities: PartState };
  /** The client's recorded cost-per-lead ceiling in cents, or null. Never invented. */
  cplCeilingCents: number | null;
}

export interface MetaDepthAccounting {
  /** One line per rule that did not run, and why. Printed by the run: a silent rule is the failure. */
  silent: string[];
  /** Counts of findings raised per type. */
  raised: Record<string, number>;
  /** Types whose open rows must NOT be swept this run, with the reason. */
  unrecheckable: Map<string, string>;
}

// ── Small helpers ───────────────────────────────────────────────────────────
const usd = (micros: number) => `$${Math.round(micros / 1_000_000).toLocaleString("en-US")}`;
const pct = (f: number) => `${Math.round(f * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Agg {
  days: number; spend: number; impressions: number;
  linkClicks: number | null; conversions: number | null; reach: number | null;
  /** Rows with a stored reach figure / without. */
  rowsN: number;
}
function agg(rows: readonly { spendMicros: number; impressions: number; linkClicks: number | null; conversions: number | null; reach?: number | null; day: string }[]): Agg {
  const a: Agg = { days: new Set(rows.map((r) => r.day)).size, spend: 0, impressions: 0, linkClicks: 0, conversions: 0, reach: 0, rowsN: rows.length };
  for (const r of rows) {
    a.spend += r.spendMicros; a.impressions += r.impressions;
    a.linkClicks = a.linkClicks == null || r.linkClicks == null ? null : a.linkClicks + r.linkClicks;
    a.conversions = a.conversions == null || r.conversions == null ? null : a.conversions + r.conversions;
    a.reach = a.reach == null || r.reach == null ? null : a.reach + r.reach;
  }
  return a;
}
/** Impressions ÷ Σ daily reach: a LOWER BOUND on the window's frequency. Null where any day carried no reach, or the reach is nought. */
export function frequencyLowerBound(a: { impressions: number; reach: number | null }): number | null {
  return a.reach != null && a.reach > 0 ? a.impressions / a.reach : null;
}
const ctrOf = (a: Agg): number | null => (a.linkClicks != null && a.impressions > 0 ? a.linkClicks / a.impressions : null);
const cprOf = (a: Agg): number | null => (a.conversions != null && a.conversions > 0 ? a.spend / a.conversions : null);

const between = (day: string, from: string, to: string) => day >= from && day <= to;
const isActive = (e: DepthEntity | undefined) => e != null && (e.effectiveStatus ?? "").toUpperCase() === "ACTIVE";

function winOf(anchor: string, n: number) { return { start: addDays(anchor, -(n - 1)), end: anchor }; }
function priorOf(w: { start: string; end: string }, n: number) { const e = addDays(w.start, -1); return { start: addDays(e, -(n - 1)), end: e }; }

const win = (w: { start: string; end: string }) => ({ windowStart: w.start, windowEnd: w.end });
const base = (f: Pick<DerivedFinding, "entityType" | "entityId" | "entityName" | "findingType" | "title" | "summary" | "evidence"> & { campaignId?: string | null; severity?: DerivedFinding["severity"] }): DerivedFinding => ({
  campaignId: null,
  severity: "medium", riskLevel: "low",
  // PROPOSALS ONLY: no change payload exists, and nothing here can write to Meta.
  applicability: "vendor",
  estImpactCents: 0, impactUnit: "usd_month",
  impactAssumption: "No figure claimed. This is a comparison of two stretches of days; nothing here can see what a change would return.",
  changePayload: null,
  guardNote: "Proposal only. Nothing is written to Meta by this system.",
  ...f,
});

// ── The rules ───────────────────────────────────────────────────────────────
export function evaluateMetaDepth(input: MetaDepthInput): { findings: DerivedFinding[]; accounting: MetaDepthAccounting } {
  const acct: MetaDepthAccounting = { silent: [], raised: {}, unrecheckable: new Map() };
  const out: DerivedFinding[] = [];
  const stop = (types: readonly MetaFindingType[], why: string) => { for (const t of types) if (!acct.unrecheckable.has(t)) acct.unrecheckable.set(t, why); };
  const note = (m: string) => acct.silent.push(m);
  const push = (f: DerivedFinding) => { out.push(f); acct.raised[f.findingType] = (acct.raised[f.findingType] ?? 0) + 1; };

  // ── Is the data there? ──
  const ad = input.scans.ad_days;
  if (!ad.present) { stop(META_FINDING_TYPES, "no Meta ad-day record has been stored for this account"); note("no rule ran: no ad-day record is stored for this account"); return { findings: out, accounting: acct }; }
  if (!ad.ok) { stop(META_FINDING_TYPES, "the last Meta ad-day read failed"); note("no rule ran: the last ad-day read failed"); return { findings: out, accounting: acct }; }
  if (daysBetween(ad.coveredTo, input.today) > META_FLOORS.staleAfterDays) {
    stop(META_FINDING_TYPES, `the Meta ad-day record was last read to ${ad.coveredTo}`);
    note(`no rule ran: the ad-day record reaches only to ${ad.coveredTo}`);
    return { findings: out, accounting: acct };
  }
  const anchor = addDays(ad.coveredTo, -META_FLOORS.holdBackDays);
  const covers = (days: number) => ad.coveredFrom <= addDays(anchor, -(days - 1) * 2 - 1); // the window AND the one before it
  const coversWin = (w: { start: string }) => ad.coveredFrom <= w.start;
  const segOk = input.scans.segments.present && input.scans.segments.ok
    && daysBetween(input.scans.segments.coveredTo, input.today) <= META_FLOORS.staleAfterDays;
  const entOk = input.scans.entities.present && input.scans.entities.ok
    && daysBetween(input.scans.entities.coveredTo, input.today) <= META_FLOORS.staleAfterDays;
  if (!segOk) stop(["meta_placement_waste"], "the Meta placement record is missing, old or failed");
  if (!entOk) stop(["meta_thin_signal", "meta_budget_pacing", "meta_winner_scale", "meta_loser_pause"], "the Meta ad set and ad settings snapshot is missing, old or failed");

  const adsets = new Map<string, DepthEntity>(); const campaigns = new Map<string, DepthEntity>(); const ads = new Map<string, DepthEntity>();
  for (const e of input.entities) (e.entityType === "adset" ? adsets : e.entityType === "campaign" ? campaigns : ads).set(e.entityId, e);

  const rowsBy = <K extends string>(rows: readonly AdDayRow[], key: (r: AdDayRow) => K) => {
    const m = new Map<K, AdDayRow[]>();
    for (const r of rows) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
    return m;
  };
  const inWin = (w: { start: string; end: string }) => input.adDays.filter((r) => between(r.day, w.start, w.end));
  const adsetName = (id: string, rows: AdDayRow[]) => adsets.get(id)?.name ?? rows.find((r) => r.adsetName)?.adsetName ?? `Ad set ${id}`;
  const adName = (id: string, rows: AdDayRow[]) => ads.get(id)?.name ?? rows.find((r) => r.adName)?.adName ?? `Ad ${id}`;
  const campaignOf = (rows: AdDayRow[]) => rows[0]?.campaignId ?? null;

  // ── 1. creative fatigue: one ad, link-click rate fell while the audience sees it often ──
  {
    const n = META_FLOORS.fatigue.windowDays;
    if (!covers(n)) note("meta_creative_fatigue did not run: the record does not reach back two full weeks");
    else {
      const w = winOf(anchor, n), p = priorOf(w, n);
      const now = rowsBy(inWin(w), (r) => r.adId), before = rowsBy(inWin(p), (r) => r.adId);
      for (const [id, rows] of now) {
        const a = agg(rows), b = agg(before.get(id) ?? []);
        const ctrA = ctrOf(a), ctrB = ctrOf(b), fq = frequencyLowerBound(a);
        if (ctrA == null || ctrB == null || fq == null) continue;
        if (a.impressions < META_FLOORS.fatigue.minImpressions || b.impressions < META_FLOORS.fatigue.minImpressions) continue;
        const fall = ctrB > 0 ? (ctrB - ctrA) / ctrB : 0;
        if (fall < META_FLOORS.fatigue.ctrFall || fq < META_FLOORS.fatigue.minFrequencyLB) continue;
        const nm = adName(id, rows);
        push(base({
          entityType: "ad", entityId: id, entityName: nm, campaignId: campaignOf(rows), findingType: "meta_creative_fatigue",
          title: `"${nm}" is clicked less per showing while people see it more often`,
          summary: `Link clicks per impression on this ad were ${(ctrA * 100).toFixed(2)}% in the ${n} days to ${w.end} against ${(ctrB * 100).toFixed(2)}% in the ${n} days before, a fall of ${pct(fall)}. `
            + `Over the same days it was shown to people at least ${fq.toFixed(1)} times each on average. ${META_NO_CAUSE}`,
          evidence: {
            metrics: { impressions: a.impressions, linkClicks: a.linkClicks ?? 0, ctrRate: ctrA, priorCtrRate: ctrB, frequencyLB: fq },
            ...win(w),
            lines: [
              `Link clicks per impression: ${(ctrA * 100).toFixed(2)}% against ${(ctrB * 100).toFixed(2)}% (${p.start} to ${p.end}).`,
              `Impressions: ${a.impressions.toLocaleString("en-US")} against ${b.impressions.toLocaleString("en-US")}.`,
              `Frequency is at least ${fq.toFixed(1)} (impressions divided by the sum of each day's reach, which can only understate it).`,
              META_FLOORS_ARE_OURS,
            ],
          },
        }));
      }
    }
  }

  // ── 2. audience saturation: one ad set, seen often, and each result costs more ──
  {
    const n = META_FLOORS.saturation.windowDays;
    if (!covers(n)) note("meta_audience_saturation did not run: the record does not reach back four full weeks");
    else {
      const w = winOf(anchor, n), p = priorOf(w, n);
      const now = rowsBy(inWin(w), (r) => r.adsetId), before = rowsBy(inWin(p), (r) => r.adsetId);
      for (const [id, rows] of now) {
        const a = agg(rows), b = agg(before.get(id) ?? []);
        const fq = frequencyLowerBound(a), cA = cprOf(a), cB = cprOf(b);
        if (fq == null || cA == null || cB == null) continue;
        if ((a.conversions ?? 0) < META_FLOORS.saturation.minConversions || (b.conversions ?? 0) < META_FLOORS.saturation.minConversions) continue;
        const rise = cB > 0 ? (cA - cB) / cB : 0;
        if (fq < META_FLOORS.saturation.minFrequencyLB || rise < META_FLOORS.saturation.cprRise) continue;
        const nm = adsetName(id, rows);
        push(base({
          entityType: "ad_group", entityId: id, entityName: nm, campaignId: campaignOf(rows), findingType: "meta_audience_saturation",
          title: `"${nm}" shows to the same people often while each result costs more`,
          summary: `Over the ${n} days to ${w.end} this ad set's cost per result was ${usd(cA)}, up ${pct(rise)} on ${usd(cB)} in the ${n} days before, and people saw its ads at least ${fq.toFixed(1)} times each on average. ${META_NO_CAUSE}`,
          evidence: {
            metrics: { costMicros: a.spend, conversions: a.conversions ?? 0, costPerResultMicros: cA, priorCostPerResultMicros: cB, frequencyLB: fq },
            ...win(w),
            lines: [
              `Cost per result: ${usd(cA)} against ${usd(cB)} (${p.start} to ${p.end}).`,
              `Results: ${a.conversions} against ${b.conversions}.`,
              `Frequency is at least ${fq.toFixed(1)}.`,
              META_FLOORS_ARE_OURS,
            ],
          },
        }));
      }
    }
  }

  // ── 3. placement waste: a placement took a share of the ad set's money and produced nothing the ad set otherwise produces ──
  if (segOk) {
    const f = META_FLOORS.placement;
    const w = winOf(anchor, f.windowDays);
    if (input.scans.segments.coveredFrom > w.start) note("meta_placement_waste did not run: the placement record does not reach back the whole window");
    else {
      const segs = input.segments.filter((s) => s.kind === "placement" && between(s.day, w.start, w.end));
      const byAdset = new Map<string, SegmentDayRow[]>();
      for (const s of segs) (byAdset.get(s.adsetId) ?? byAdset.set(s.adsetId, []).get(s.adsetId)!).push(s);
      for (const [id, rows] of byAdset) {
        const total = rows.reduce((t, r) => t + r.spendMicros, 0);
        if (total < f.minAdsetSpendMicros) continue;
        const adsetConv = rows.reduce<number | null>((t, r) => (t == null || r.conversions == null ? null : t + r.conversions), 0);
        if (adsetConv == null || adsetConv < f.minAdsetConversions) continue;
        const byPlacement = new Map<string, SegmentDayRow[]>();
        for (const r of rows) (byPlacement.get(r.segment) ?? byPlacement.set(r.segment, []).get(r.segment)!).push(r);
        const wasted: { seg: string; spend: number; share: number; clicks: number | null }[] = [];
        for (const [seg, rs] of byPlacement) {
          const spend = rs.reduce((t, r) => t + r.spendMicros, 0);
          const conv = rs.reduce<number | null>((t, r) => (t == null || r.conversions == null ? null : t + r.conversions), 0);
          if (conv !== 0) continue; // null is unanswered, never nought
          if (spend < f.minPlacementSpendMicros || spend / total < f.minShare) continue;
          wasted.push({ seg, spend, share: spend / total, clicks: rs.reduce<number | null>((t, r) => (t == null || r.linkClicks == null ? null : t + r.linkClicks), 0) });
        }
        if (!wasted.length) continue;
        wasted.sort((a, b) => b.spend - a.spend);
        const nm = adsetName(id, input.adDays.filter((r) => r.adsetId === id));
        const spendAll = wasted.reduce((t, x) => t + x.spend, 0);
        push(base({
          entityType: "ad_group", entityId: id, entityName: nm, campaignId: rows[0]!.campaignId, findingType: "meta_placement_waste",
          title: `"${nm}" spends in ${plural(wasted.length, "place")} that returned nothing while the ad set returned results`,
          summary: `In the ${f.windowDays} days to ${w.end} this ad set returned ${adsetConv} result${adsetConv === 1 ? "" : "s"}, and ${plural(wasted.length, "placement")} that took ${pct(spendAll / total)} of its spend returned none. ${META_NO_CAUSE}`,
          evidence: {
            metrics: { costMicros: total, wastedCostMicros: spendAll, conversions: adsetConv, placements: wasted.length },
            ...win(w),
            lines: [
              ...wasted.slice(0, 6).map((x) => `${x.seg}: ${usd(x.spend)}, ${pct(x.share)} of the ad set's spend, no results${x.clicks != null ? `, ${x.clicks} link clicks` : ""}.`),
              ...(wasted.length > 6 ? [`…and ${wasted.length - 6} more.`] : []),
              META_FLOORS_ARE_OURS,
            ],
          },
        }));
      }
    }
  }

  // ── 4. thin signal: an ad set optimising for a result gets too few of them to settle (and the platform has not said so) ──
  if (entOk) {
    const f = META_FLOORS.thin;
    const w = winOf(anchor, f.windowDays);
    if (!coversWin(w)) note("meta_thin_signal did not run: the record does not reach back a full week");
    else {
      const now = rowsBy(inWin(w), (r) => r.adsetId);
      for (const [id, rows] of now) {
        const e = adsets.get(id);
        if (!isActive(e)) continue;
        const goal = (e!.optimizationGoal ?? "").toUpperCase();
        if (!goal || NON_CONVERSION_GOALS.has(goal)) continue;
        if (String(e!.attrs.learning_status ?? "").toUpperCase() === "LEARNING_LIMITED") continue; // the platform's own finding says it already
        const a = agg(rows);
        if (a.conversions == null || a.spend < f.minSpendMicros || a.conversions >= f.learnEvents) continue;
        const nm = adsetName(id, rows);
        push(base({
          entityType: "ad_group", entityId: id, entityName: nm, campaignId: campaignOf(rows), findingType: "meta_thin_signal",
          title: `"${nm}" had ${a.conversions} result${a.conversions === 1 ? "" : "s"} in a week, short of what Meta's guidance asks for`,
          summary: `In the ${f.windowDays} days to ${w.end} this ad set optimising for ${goal.toLowerCase().replace(/_/g, " ")} returned ${a.conversions}. Meta's guidance is about ${f.learnEvents} a week for an ad set to settle; that figure is unverified here and treated as our own line. The platform has not itself marked this ad set as limited. ${META_NO_CAUSE}`,
          evidence: {
            metrics: { conversions: a.conversions, costMicros: a.spend, learnEvents: f.learnEvents },
            ...win(w),
            lines: [`Results in the week: ${a.conversions}. Spend in the week: ${usd(a.spend)}.`, `Optimisation goal: ${goal}.`, META_FLOORS_ARE_OURS],
          },
        }));
      }
    }
  }

  // ── 5. budget pacing: a campaign that is on and spends well under its daily budget ──
  if (entOk) {
    const f = META_FLOORS.pacing;
    const w = winOf(anchor, f.windowDays);
    if (!coversWin(w)) note("meta_budget_pacing did not run: the record does not reach back a full week");
    const byCampaign = coversWin(w) ? rowsBy(inWin(w), (r) => r.campaignId) : new Map<string, AdDayRow[]>();
    for (const [id, rows] of byCampaign) {
      const c = campaigns.get(id);
      if (!isActive(c)) continue;
      const active = Array.from(adsets.values()).filter((s) => s.parentId === id && isActive(s));
      let budget: number | null = null; let from = w.start; let how = "campaign";
      if (c!.dailyBudgetMicros != null) { budget = c!.dailyBudgetMicros; from = c!.validFrom; }
      else if (active.length && active.every((s) => s.dailyBudgetMicros != null)) { budget = active.reduce((t, s) => t + s.dailyBudgetMicros!, 0); from = active.map((s) => s.validFrom).sort().pop()!; how = "ad set"; }
      if (budget == null || budget <= 0) continue; // lifetime or unreadable: named below, never guessed
      if (from > w.start) continue; // the budget changed inside the window: today's figure is not the one it ran on
      const a = agg(rows);
      if (a.days < f.minDaysWithRows) continue;
      const perDay = a.spend / f.windowDays;
      if (perDay / budget >= f.underShare) continue;
      const nm = c!.name ?? `Campaign ${id}`;
      push(base({
        entityType: "campaign", entityId: id, entityName: nm, campaignId: id, findingType: "meta_budget_pacing", severity: "low",
        title: `"${nm}" is spending well under its daily budget`,
        summary: `In the ${f.windowDays} days to ${w.end} this campaign spent ${usd(perDay)} a day on average against a ${how} daily budget of ${usd(budget)}, ${pct(perDay / budget)} of it. ${META_NO_CAUSE}`,
        evidence: {
          metrics: { costMicros: a.spend, dailyBudgetMicros: budget, perDayMicros: perDay, spendShare: perDay / budget },
          ...win(w),
          lines: [`Average a day ${usd(perDay)} against ${usd(budget)}.`, `The budget read is today's; it was not changed inside these days.`, META_FLOORS_ARE_OURS],
        },
      }));
    }
  }

  // ── 6 and 7. winner to scale, loser to pause: set against the account's own other ad sets and ads ──
  if (entOk) {
    const f = META_FLOORS.winner;
    const w = winOf(anchor, f.windowDays);
    if (!coversWin(w)) note("meta_winner_scale and meta_loser_pause did not run: the record does not reach back two full weeks");
    const now = coversWin(w) ? rowsBy(inWin(w), (r) => r.adsetId) : new Map<string, AdDayRow[]>();
    const sets = Array.from(now.entries()).filter(([id]) => isActive(adsets.get(id))).map(([id, rows]) => ({ id, rows, a: agg(rows) }));
    const withCpr = sets.filter((s) => (s.a.conversions ?? 0) >= f.minConversions && cprOf(s.a) != null);
    const totalSpend = withCpr.reduce((t, s) => t + s.a.spend, 0), totalConv = withCpr.reduce((t, s) => t + (s.a.conversions ?? 0), 0);
    if (withCpr.length >= f.minPeers + 1 && totalConv > 0) {
      for (const s of withCpr) {
        const peersSpend = totalSpend - s.a.spend, peersConv = totalConv - (s.a.conversions ?? 0);
        if (peersConv <= 0) continue;
        const own = cprOf(s.a)!, peers = peersSpend / peersConv;
        const fq = frequencyLowerBound(s.a);
        if (fq == null || fq >= f.maxFrequencyLB || own > peers * f.cprBelow) continue;
        if (input.cplCeilingCents != null && own > input.cplCeilingCents * 10_000) continue; // under the recorded ceiling or not a winner
        const nm = adsetName(s.id, s.rows);
        push(base({
          entityType: "ad_group", entityId: s.id, entityName: nm, campaignId: campaignOf(s.rows), findingType: "meta_winner_scale", severity: "low",
          title: `"${nm}" returns results at well under the account's other ad sets, with room in its audience`,
          summary: `In the ${f.windowDays} days to ${w.end} this ad set's cost per result was ${usd(own)} against ${usd(peers)} across the account's other ad sets that returned at least ${f.minConversions}, and people saw its ads at least ${fq.toFixed(1)} times each on average. ${META_NO_CAUSE}`,
          evidence: {
            metrics: { costMicros: s.a.spend, conversions: s.a.conversions ?? 0, costPerResultMicros: own, peerCostPerResultMicros: peers, frequencyLB: fq },
            ...win(w),
            lines: [`Cost per result ${usd(own)} against ${usd(peers)} for the other ad sets.`, `${s.a.conversions} results in the window.`,
              ...(input.cplCeilingCents != null ? [`Under the recorded cost ceiling of ${usd(input.cplCeilingCents * 10_000)}.`] : []), META_FLOORS_ARE_OURS],
          },
        }));
      }
    }
    const L = META_FLOORS.loser;
    const byAd = coversWin(w) ? rowsBy(inWin(w), (r) => r.adId) : new Map<string, AdDayRow[]>();
    for (const [id, rows] of byAd) {
      const e = ads.get(id);
      if (!isActive(e)) continue;
      const set = sets.find((s) => s.id === rows[0]!.adsetId);
      if (!set || (set.a.conversions ?? 0) < L.minAdsetConversions) continue;
      const a = agg(rows);
      if (a.conversions == null || a.spend < L.minSpendMicros) continue;
      const setCpr = cprOf(set.a);
      let line: string | null = null;
      if (a.conversions === 0) line = `${usd(a.spend)} spent in the window and no result, while its ad set returned ${set.a.conversions}.`;
      else if (setCpr != null && a.conversions >= L.minAdConversionsForCost && cprOf(a)! >= setCpr * L.cprMultiple) {
        line = `Cost per result ${usd(cprOf(a)!)} against ${usd(setCpr)} for its ad set.`;
      }
      if (!line) continue;
      const nm = adName(id, rows);
      push(base({
        entityType: "ad", entityId: id, entityName: nm, campaignId: campaignOf(rows), findingType: "meta_loser_pause",
        title: `"${nm}" takes spend and returns little against its ad set`,
        summary: `${line} This is the ${f.windowDays} days to ${w.end}. ${META_NO_CAUSE}`,
        evidence: {
          metrics: { costMicros: a.spend, conversions: a.conversions, setConversions: set.a.conversions ?? 0 },
          ...win(w),
          lines: [line, META_FLOORS_ARE_OURS],
        },
      }));
    }
  }

  // ── 8. conversion tracking gap: money is going out and no result is being counted ──
  {
    const f = META_FLOORS.tracking;
    const w = winOf(anchor, f.windowDays);
    if (!coversWin(w)) note("meta_tracking_gap did not run: the record does not reach back two full weeks");
    const rows = coversWin(w) ? inWin(w) : [];
    const a = agg(rows);
    let wantsResults = true;
    if (entOk) {
      const live = Array.from(campaigns.values()).filter((c) => isActive(c) && c.attrs.objective);
      wantsResults = live.length === 0 ? true : live.some((c) => !NON_CONVERSION_OBJECTIVES.has(String(c.attrs.objective).toUpperCase()));
    }
    if (rows.length && a.spend >= f.minSpendMicros && wantsResults) {
      const none = rows.every((r) => r.conversions == null);
      const zero = !none && rows.every((r) => r.conversions === 0) && (a.linkClicks ?? 0) >= f.minLinkClicks;
      if (none || zero) {
        push(base({
          entityType: "account", entityId: input.accountId, entityName: input.accountName, findingType: "meta_tracking_gap", severity: "high",
          title: none ? "Meta reported no result of any kind on this account in two weeks" : "Meta counted no results while link clicks continued for two weeks",
          summary: none
            ? `In the ${f.windowDays} days to ${w.end} this account spent ${usd(a.spend)} on Meta and the platform reported no result on any day, so every figure that depends on results is blank. ${META_NO_CAUSE}`
            : `In the ${f.windowDays} days to ${w.end} this account spent ${usd(a.spend)} and had ${a.linkClicks} link clicks, and the platform counted no result on any day. ${META_NO_CAUSE}`,
          evidence: {
            metrics: { costMicros: a.spend, linkClicks: a.linkClicks ?? 0 },
            ...win(w),
            lines: [none ? "No result was reported on any day in the window." : "Results counted: none on any day in the window.", `Spend ${usd(a.spend)}.`, META_FLOORS_ARE_OURS],
          },
        }));
      }
    } else if (rows.length && a.spend >= f.minSpendMicros && !wantsResults) {
      note("meta_tracking_gap did not run: every active campaign has an awareness, traffic or engagement objective, which does not ask for a result");
    }
  }

  return { findings: out, accounting: acct };
}

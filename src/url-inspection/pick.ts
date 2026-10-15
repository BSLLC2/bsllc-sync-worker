/**
 * Which pages to ask Google about, and how many we may.
 *
 * PURE: stats in, a short ordered list out. The quota is spent on the pages whose
 * answer would explain something: first the ones that FELL (fewer clicks or a
 * clear drop in impressions than the 28 days before), then the home page, then the
 * busiest. A page whose stats are missing in either window is skipped, not read as
 * a fall: a null is unanswered.
 *
 * The fall test is OURS and says so on the page: any lost click, or at least 50
 * impressions and a fifth of them gone.
 */
import { INSPECT_DAILY_CAP, INSPECT_RUN_MAX, REINSPECT_DAYS, REINSPECT_FELL_DAYS, type PickedFor } from "./types.js";

export interface PageStat {
  path: string;
  clicksNow: number | null;
  clicksPrior: number | null;
  impressionsNow: number | null;
  impressionsPrior: number | null;
}
export interface Picked { path: string; pickedFor: PickedFor; lostClicks: number | null; lostImpressions: number | null }

export const FELL_MIN_IMPRESSIONS = 50;
export const FELL_IMPRESSION_SHARE = 0.2;

const diff = (prior: number | null, now: number | null): number | null => (prior == null || now == null ? null : prior - now);

export function fell(s: PageStat): boolean {
  const lc = diff(s.clicksPrior, s.clicksNow);
  const li = diff(s.impressionsPrior, s.impressionsNow);
  if (lc != null && lc >= 1) return true;
  return li != null && s.impressionsPrior != null && li >= FELL_MIN_IMPRESSIONS && li / Math.max(1, s.impressionsPrior) >= FELL_IMPRESSION_SHARE;
}

/** Up to `max` pages: fallen first (biggest loss first), the home page, then the busiest. */
export function pickPages(stats: readonly PageStat[], max: number, homePath = "/"): Picked[] {
  const out: Picked[] = [];
  const seen = new Set<string>();
  const add = (p: Picked) => { if (out.length < max && !seen.has(p.path)) { seen.add(p.path); out.push(p); } };
  // Leave room for the home page and a few of the busiest, so a bad week does not crowd them out.
  const fellMax = Math.max(0, max - 6);
  const fallen = stats.filter(fell).map((s) => ({ s, lc: diff(s.clicksPrior, s.clicksNow), li: diff(s.impressionsPrior, s.impressionsNow) }))
    .sort((a, b) => (b.lc ?? 0) - (a.lc ?? 0) || (b.li ?? 0) - (a.li ?? 0) || a.s.path.localeCompare(b.s.path));
  for (const f of fallen.slice(0, fellMax)) add({ path: f.s.path, pickedFor: "fell", lostClicks: f.lc, lostImpressions: f.li });
  add({ path: homePath, pickedFor: "home", lostClicks: null, lostImpressions: null });
  const busiest = [...stats].filter((s) => s.clicksNow != null).sort((a, b) => (b.clicksNow ?? 0) - (a.clicksNow ?? 0) || a.path.localeCompare(b.path));
  for (const s of busiest) add({ path: s.path, pickedFor: "top", lostClicks: null, lostImpressions: null });
  return out;
}

/**
 * Drop pages inspected recently. `lastOk` maps a page path to the time of its last
 * GOOD inspection (a failed one does not count, so a failure is retried). A fallen
 * page is allowed again sooner.
 */
export function dueOnly(picked: readonly Picked[], lastOk: ReadonlyMap<string, Date>, now: Date): Picked[] {
  return picked.filter((p) => {
    const last = lastOk.get(p.path);
    if (!last) return true;
    const days = (now.getTime() - last.getTime()) / 86_400_000;
    return days >= (p.pickedFor === "fell" ? REINSPECT_FELL_DAYS : REINSPECT_DAYS);
  });
}

/** How many inspections this run may make for a property: the smaller of the run limit and what is left today. */
export function allowance(usedToday: number, cap = INSPECT_DAILY_CAP, runMax = INSPECT_RUN_MAX): number {
  return Math.max(0, Math.min(runMax, cap - Math.max(0, usedToday)));
}

/**
 * WHERE SOURCES AGREE AND DISAGREE. Joins Google Analytics to Search Console on exact
 * keys only (a month, a page group, an advisor's name), and says for each join whether
 * the two sources tell the same story.
 *
 *   agree       both sources moved the same way (or both held), above the floors
 *   disagree    they moved opposite ways, or one is larger than the other can be
 *   one_source  only one source holds the thing, so nothing can be compared
 *   cant_tell   a figure is missing, a window is not covered, or a base is too small
 *
 * A disagreement is the useful result: it points at tracking, a filter or a page problem.
 * It is never a cause. Every hypothesis is labelled inference and carries the test that
 * would settle it. Floors are OURS and printed with the findings. Pure over figures the
 * audit already read, plus one GA4 question (organic landing pages), so the guard drives
 * it with invented data.
 */
import { and, eq, CHANNEL, type Filter } from "./filters.js";
import type { Reader } from "./ga4.js";
import { classifyPath, advisorName, type AuditConfig } from "./classify.js";
import type { GscReading } from "./gsc.js";
import { change, column, fmt, fmtChange, ratio, table, type Basis, type Table, type Unit } from "./metrics.js";
import { label, periodsFor, priorName, type Window } from "./periods.js";
import type { AdvisorReading } from "./advisors.js";

export type Agreement = "agree" | "disagree" | "one_source" | "cant_tell";
export type SourceName = "Google Analytics" | "Search Console";

/** Floors. OURS: no source publishes them, and the report says so. */
export const FINDING_FLOORS = {
  /** Fewer clicks or sessions than this in the earlier period and a percentage is not read. */
  base: 100,
  /** A move smaller than this is called "held". */
  held: 0.05,
  /** Both sources must move at least this far, in opposite directions, to disagree. */
  opposite: 0.1,
  /** One source held and the other moved at least this far: a divergence worth showing. */
  divergent: 0.2,
  /** Group: clicks fell at least this much. */
  clicksFell: 0.2,
  /** Group: impressions held if they fell less than this. */
  impressionsHeld: 0.1,
  /** Advisor: search clicks above analytics visits by more than this share. */
  advisorOver: 0.1,
  /** Advisor: fewer clicks than this and the comparison is not read. */
  advisorMin: 30,
} as const;

export interface Evidence {
  source: SourceName;
  what: string;
  now: number | null;
  before: number | null;
  unit: Unit;
  basis: Basis;
  range: string;
  filter: string;
}

export interface Finding {
  id: string;
  claim: string;
  agreement: Agreement;
  evidence: Evidence[];
  /** A guess at why, always labelled inference, or null when there is nothing to say. */
  hypothesis: string | null;
  /** The check that would settle it. */
  settleBy: string;
  /** What to do next, or null when nothing is needed. */
  action: string | null;
}

export interface NotJoined { source: string; why: string }
export interface Findings {
  items: Finding[];
  summary: string;
  notJoined: NotJoined[];
  tables: Table[];
  floors: string;
}

export const NOT_JOINED: NotJoined[] = [
  { source: "Bing Webmaster Tools", why: "Read by the dashboard worker into its own tables, not by this audit. Bing clicks are not set beside Google's here." },
  { source: "Keyword rank history (DataForSEO)", why: "Stored by the weekly rank check, not read by this audit, so a fall in search clicks is not tied to tracked searches here." },
  { source: "AI-answer prompts", why: "Kept by the platform for the account, not read by this audit. AI traffic is only seen as visits from known assistant addresses." },
  { source: "Airtable leads", why: "Not readable by this audit. It is the one count of real leads, and the form submit events here are not that count." },
  { source: "Call tracking (CallTrackingMetrics)", why: "Not read here. Phone calls are not form events and are not in any figure." },
  { source: "Microsoft Clarity", why: "Not read here. Page behaviour (rage clicks, scroll depth) is not joined to the figures." },
];

export const FLOORS_LINE = `Our own lines, not Google's: a base under ${FINDING_FLOORS.base} is not read; under ${Math.round(FINDING_FLOORS.held * 100)}% is held; two sources disagree only when they move opposite ways by at least ${Math.round(FINDING_FLOORS.opposite * 100)}% each, or one holds while the other moves ${Math.round(FINDING_FLOORS.divergent * 100)}% or more; clicks falling ${Math.round(FINDING_FLOORS.clicksFell * 100)}% or more is a fall; impressions falling less than ${Math.round(FINDING_FLOORS.impressionsHeld * 100)}% held; advisor clicks must exceed visits by more than ${Math.round(FINDING_FLOORS.advisorOver * 100)}% and be at least ${FINDING_FLOORS.advisorMin}.`;

type Dir = "up" | "down" | "held" | "unread";
export function direction(now: number | null, before: number | null): Dir {
  if (now == null || before == null || before < FINDING_FLOORS.base) return "unread";
  const c = change(now, before);
  if (c == null) return "unread";
  if (Math.abs(c) < FINDING_FLOORS.held) return "held";
  return c > 0 ? "up" : "down";
}

/** The agreement between two sources' direction of movement. Pure. */
export function compareDirections(a: { now: number | null; before: number | null }, b: { now: number | null; before: number | null }): Agreement {
  const da = direction(a.now, a.before), db = direction(b.now, b.before);
  if (da === "unread" || db === "unread") return "cant_tell";
  if (da === db) return "agree";
  const ca = change(a.now, a.before) ?? 0, cb = change(b.now, b.before) ?? 0;
  const oppositeWays = (ca > 0 && cb < 0) || (ca < 0 && cb > 0);
  if (oppositeWays && Math.abs(ca) >= FINDING_FLOORS.opposite && Math.abs(cb) >= FINDING_FLOORS.opposite) return "disagree";
  // One source held and the other moved a long way: they cannot both be describing the same visitors.
  const heldAndFar = (da === "held" && Math.abs(cb) >= FINDING_FLOORS.divergent) || (db === "held" && Math.abs(ca) >= FINDING_FLOORS.divergent);
  if (heldAndFar) return "disagree";
  // A smaller difference (both moved, or one held and the other moved a little): not a contradiction.
  return "cant_tell";
}

export type GroupReading = "snippet_or_position" | "fewer_seen" | "page_problem" | "clicks_held" | "clicks_up" | "unread";

/** What a page group's search figures say, from impressions, clicks and (when read) engagement. Inference, never a cause. */
export function readGroup(g: { clicksNow: number | null; clicksBefore: number | null; imprNow: number | null; imprBefore: number | null; engNow?: number | null; engBefore?: number | null }): GroupReading {
  const cd = direction(g.clicksNow, g.clicksBefore);
  if (cd === "unread") return "unread";
  if (cd === "up") return "clicks_up";
  const cc = change(g.clicksNow, g.clicksBefore) ?? 0;
  const en = g.engNow != null && g.engBefore != null ? g.engNow - g.engBefore : null;
  const ic = change(g.imprNow, g.imprBefore);
  // Clicks fell a little while impressions held and engagement fell by 10 points or more: the visits that arrive are doing less on the page.
  if (cd === "down" && cc > -FINDING_FLOORS.clicksFell) {
    return en != null && en <= -0.1 && ic != null && ic >= -FINDING_FLOORS.impressionsHeld ? "page_problem" : "clicks_held";
  }
  if (cd === "held") return "clicks_held";
  if (ic == null) return "unread";
  if (ic < -FINDING_FLOORS.impressionsHeld) return "fewer_seen";
  // Impressions held, clicks fell: people saw it and chose it less (title, snippet, or a lower slot on the page).
  return "snippet_or_position";
}

const GROUP_TEXT: Record<GroupReading, { say: string; hypothesis: string | null; settleBy: string; action: string | null }> = {
  snippet_or_position: { say: "Search clicks fell while impressions held.", hypothesis: "People still saw the page in results and clicked it less. Possible causes: the title or description reads weaker, a rival result sits above it, or an answer box takes the click.", settleBy: "Compare average position now and before in Search Console for these pages; if it held, read the title and description as a searcher would; if it slipped, it is a ranking change.", action: "Review the title and description of the page group's top pages." },
  fewer_seen: { say: "Search clicks fell and impressions fell with them.", hypothesis: "Fewer people were shown the page. Possible causes: lower ranking for its searches, or less demand for them.", settleBy: "Look at average position and at the top searches in Search Console for these pages across the two periods.", action: "Check which searches lost position for the page group." },
  page_problem: { say: "Search clicks fell a little and engagement on the same pages fell more.", hypothesis: "The visits that arrive may be less well matched to the page, or the page changed. Possible causes: a layout change, a slower page, or a shift in which searches bring people.", settleBy: "Compare the top landing searches and the page's load and layout between the two periods.", action: "Open the group's top landing page and check what changed on it." },
  clicks_held: { say: "Search clicks held.", hypothesis: null, settleBy: "Nothing to settle.", action: null },
  clicks_up: { say: "Search clicks rose.", hypothesis: null, settleBy: "Nothing to settle.", action: null },
  unread: { say: "Not enough data to read this group.", hypothesis: null, settleBy: "A base of at least " + FINDING_FLOORS.base + " clicks in the earlier period and impressions in both.", action: null },
};

interface GroupFacts { group: string; clicksNow: number | null; clicksBefore: number | null; imprNow: number | null; imprBefore: number | null; ctrNow: number | null; posNow: number | null; sessNow: number | null; sessBefore: number | null; engNow: number | null; engBefore: number | null }

const gscNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface FindingsInput {
  read: Reader;
  window: Window;
  cfg: AuditConfig;
  gsc: GscReading | null;
  advisors: AdvisorReading;
  organicFilter: Filter | null;
}

export async function buildFindings(i: FindingsInput): Promise<Findings> {
  const items: Finding[] = [];
  const tables: Table[] = [];
  const p = periodsFor(i.window);
  const cur = label(p.current), pri = label(p.prior);
  const prName = priorName(i.window);

  if (!i.gsc) {
    return { items: [{ id: "no-gsc", claim: "No cross-source findings: Search Console was not read.", agreement: "cant_tell", evidence: [], hypothesis: null, settleBy: "Give the service account access to the site's Search Console property, then run again.", action: null }], summary: "Search Console was not read, so nothing could be set beside Analytics.", notJoined: NOT_JOINED, tables, floors: FLOORS_LINE };
  }
  const g = i.gsc;
  const overview = g.tables.find((t) => t.id === "gsc-overview");
  const clicks: [number | null, number | null] = [gscNum(overview?.rows[0]?.clicks), gscNum(overview?.rows[1]?.clicks)];
  const orgFilter = and(eq(CHANNEL, "Organic Search"), i.organicFilter ?? undefined) ?? null;
  const organicFilterText = "channel Organic Search" + (i.organicFilter ? ", country rule applied" : "");

  // 1. Organic sessions against search clicks, window against prior.
  const orgTotals = await i.read({ dims: [], metrics: ["sessions", "engagedSessions"], ranges: [p.current, p.prior], filter: orgFilter });
  const sums = (r: number) => orgTotals.rows.filter((x) => x.range === r).reduce((a, x) => ({ s: a.s + (x.m.sessions ?? 0), e: a.e + (x.m.engagedSessions ?? 0), has: a.has || x.m.sessions != null }), { s: 0, e: 0, has: false });
  const o0 = sums(0), o1 = sums(1);
  const sess: [number | null, number | null] = [o0.has ? o0.s : null, o1.has ? o1.s : null];
  const bothAvail = g.available[0] && g.available[1];
  const org: Finding = {
    id: "organic-vs-clicks",
    claim: "Organic Search visits in Analytics against clicks in Search Console",
    agreement: bothAvail ? compareDirections({ now: sess[0], before: sess[1] }, { now: clicks[0], before: clicks[1] }) : "cant_tell",
    evidence: [
      { source: "Google Analytics", what: "Organic Search sessions", now: sess[0], before: sess[1], unit: "count", basis: "confirmed from data", range: `${cur} against ${pri}`, filter: organicFilterText },
      { source: "Search Console", what: "Clicks from Google search", now: clicks[0], before: clicks[1], unit: "count", basis: "confirmed from data", range: `${cur} against ${pri}`, filter: "all queries, pages, countries and devices" },
    ],
    hypothesis: null,
    settleBy: "",
    action: null,
  };
  if (!bothAvail) { org.settleBy = `Search Console does not cover both periods (${g.reasons.filter(Boolean).join(" ") || "no reason given"}). Choose dates it covers.`; }
  else if (org.agreement === "agree") { org.settleBy = "Nothing to settle: both sources moved the same way."; }
  else if (org.agreement === "disagree") {
    const upGa = (change(sess[0], sess[1]) ?? 0) > 0;
    org.hypothesis = upGa
      ? "Analytics counts more organic visits while Google reports fewer clicks. Possible causes: automated visits still arriving as Organic Search, a tag counting twice, or a change in how visits are grouped."
      : "Analytics counts fewer organic visits while Google reports more clicks. Possible causes: a consent banner or script blocker hiding visitors from the tag, tracking lost on some pages, or an exclusion removing real visits.";
    org.settleBy = "Compare sessions per click by month in the cross-check table; then check the tag fires on the pages that gained clicks, and that no country or channel exclusion is removing real organic visits.";
    org.action = "Run the tag check on the top landing pages and review the exclusions.";
  } else {
    org.settleBy = `Needs at least ${FINDING_FLOORS.base} sessions and clicks in the earlier period, and both sources moving at least ${Math.round(FINDING_FLOORS.opposite * 100)}% to call a disagreement.`;
  }
  items.push(org);

  // 2. Page groups: Search Console against Analytics organic sessions by landing page group.
  const gscGroups = g.tables.find((t) => t.id === "gsc-groups");
  if (gscGroups && gscGroups.rows.length && g.available[0] && g.available[1]) {
    const land = await i.read({ dims: ["landingPage"], metrics: ["sessions", "engagedSessions"], ranges: [p.current, p.prior], filter: orgFilter, orderBy: "sessions" });
    const by = new Map<string, { s: [number | null, number | null]; e: [number | null, number | null] }>();
    for (const r of land.rows) {
      const path = (r.dims[0] ?? "").split("?")[0] || "/";
      const grp = classifyPath(path, i.cfg).group;
      const cell = by.get(grp) ?? { s: [null, null], e: [null, null] };
      cell.s[r.range] = (cell.s[r.range] ?? 0) + (r.m.sessions ?? 0);
      cell.e[r.range] = (cell.e[r.range] ?? 0) + (r.m.engagedSessions ?? 0);
      by.set(grp, cell);
    }
    const priorImpr = await priorGroupImpressions(g);
    const facts: GroupFacts[] = gscGroups.rows.map((r) => {
      const grp = String(r.group);
      const cell = by.get(grp);
      return { group: grp, clicksNow: gscNum(r.clicks), clicksBefore: gscNum(r.prior), imprNow: gscNum(r.impr), imprBefore: priorImpr.get(grp) ?? null, ctrNow: gscNum(r.ctr), posNow: gscNum(r.pos), sessNow: cell?.s[0] ?? null, sessBefore: cell?.s[1] ?? null, engNow: ratio(cell?.e[0] ?? null, cell?.s[0] ?? null), engBefore: ratio(cell?.e[1] ?? null, cell?.s[1] ?? null) };
    });
    const rowsOut: Array<Record<string, string | number | null>> = [];
    for (const f of facts.slice(0, 8)) {
      const reading = readGroup({ clicksNow: f.clicksNow, clicksBefore: f.clicksBefore, imprNow: f.imprNow, imprBefore: f.imprBefore, engNow: f.engNow, engBefore: f.engBefore });
      const agree = compareDirections({ now: f.sessNow, before: f.sessBefore }, { now: f.clicksNow, before: f.clicksBefore });
      const t = GROUP_TEXT[reading];
      rowsOut.push({ group: f.group, clicks: f.clicksNow, clicksChg: change(f.clicksNow, f.clicksBefore), impr: f.imprNow, imprChg: change(f.imprNow, f.imprBefore), sess: f.sessNow, sessChg: change(f.sessNow, f.sessBefore), agree: agree === "agree" ? "agree" : agree === "disagree" ? "disagree" : "cannot tell", reading: t.say });
      if (reading === "unread" && agree !== "disagree") continue;
      if (reading === "clicks_held" || reading === "clicks_up") { if (agree !== "disagree") continue; }
      items.push({
        id: `group-${f.group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        claim: `${f.group}: ${t.say}`,
        agreement: agree,
        evidence: [
          { source: "Search Console", what: "Clicks", now: f.clicksNow, before: f.clicksBefore, unit: "count", basis: "confirmed from data", range: `${cur} against ${pri}`, filter: `page group ${f.group}` },
          { source: "Search Console", what: "Impressions", now: f.imprNow, before: f.imprBefore, unit: "count", basis: "confirmed from data", range: `${cur} against ${pri}`, filter: `page group ${f.group}` },
          { source: "Google Analytics", what: "Organic Search sessions landing in the group", now: f.sessNow, before: f.sessBefore, unit: "count", basis: "confirmed from data", range: `${cur} against ${pri}`, filter: organicFilterText },
        ],
        hypothesis: t.hypothesis,
        settleBy: t.settleBy,
        action: t.action,
      });
    }
    tables.push(table({
      id: "findings-groups", title: "Page groups: Search Console against Analytics organic landings", range: `${cur} against ${pri}`, filter: `page group is our classification of the page address; Analytics counts ${organicFilterText} sessions by landing page; Search Console counts all clicks to the group's pages`,
      columns: [column("group", "Page group", "inference", "text"), column("clicks", "Search clicks", "confirmed from data"), column("clicksChg", `Change on ${prName}`, "confirmed from data", "percent"), column("impr", "Impressions", "confirmed from data"), column("imprChg", "Change", "confirmed from data", "percent"), column("sess", "Organic landings", "confirmed from data"), column("sessChg", "Change", "confirmed from data", "percent"), column("agree", "Sources agree?", "inference", "text"), column("reading", "Reading", "inference", "text")],
      rows: rowsOut,
      note: "A group is read only when its clicks base is large enough. 'Reading' is our inference from impressions, clicks and engagement, not a cause. Landings and clicks are counted differently, so the numbers are not expected to match; their direction is.",
    }));
  }

  // 3. Advisors: Search Console clicks to the advisor's pages against Analytics visits to the advisor's main page.
  const gscAdv = g.tables.find((t) => t.id === "gsc-advisors");
  if (gscAdv && gscAdv.rows.length && g.available[0]) {
    const visits = new Map(i.advisors.advisors.map((a) => [a.name, a.periods[0].sessions]));
    const rowsOut: Array<Record<string, string | number | null>> = [];
    for (const r of gscAdv.rows) {
      const name = String(r.advisor);
      const c = gscNum(r.clicks);
      if (c == null || c < FINDING_FLOORS.advisorMin) continue;
      const v = visits.has(name) ? visits.get(name)! : undefined;
      let agreement: Agreement; let say: string;
      if (v === undefined) { agreement = "one_source"; say = "Search Console lists this advisor's page; Analytics has no visits to it in the window."; }
      else if (v == null) { agreement = "cant_tell"; say = "Analytics did not return visits for this advisor."; }
      else if (c > v * (1 + FINDING_FLOORS.advisorOver)) { agreement = "disagree"; say = "Search sent more clicks than Analytics counted visits."; }
      else { agreement = "agree"; say = "Visits are at least as many as search clicks."; }
      rowsOut.push({ advisor: name, clicks: c, visits: v === undefined ? null : v, agree: agreement === "agree" ? "agree" : agreement === "disagree" ? "disagree" : agreement === "one_source" ? "one source" : "cannot tell", reading: say });
      if (agreement === "agree") continue;
      items.push({
        id: `advisor-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        claim: `${name}: ${say}`,
        agreement,
        evidence: [
          { source: "Search Console", what: "Clicks to the advisor's pages", now: c, before: null, unit: "count", basis: "confirmed from data", range: cur, filter: "pages under the advisor's address" },
          { source: "Google Analytics", what: "Visits to the advisor's main page", now: v === undefined ? null : v, before: null, unit: "count", basis: "confirmed from data", range: cur, filter: "headline rule applied; main page only" },
        ],
        hypothesis: agreement === "disagree" ? "Some visitors who clicked from Google were not counted by Analytics. Possible causes: a consent banner or script blocker, the page redirecting before the tag fires, or the headline rule removing real visits." : "The page is listed in search but the tag may not fire on it, or visits are filed under a different address.",
        settleBy: "Open the advisor's page in a clean browser with the Analytics debug view on and check that a page view is recorded; compare the address Search Console lists with the one Analytics records.",
        action: "Check that the tag fires on this advisor's page.",
      });
    }
    tables.push(table({
      id: "findings-advisors", title: "Advisors: Search Console clicks against Analytics visits", range: cur, filter: `advisors with at least ${FINDING_FLOORS.advisorMin} search clicks; Analytics counts visits to the main page under the headline rule, Search Console counts clicks to all of the advisor's pages`,
      columns: [column("advisor", "Advisor", "confirmed from data", "text"), column("clicks", "Search clicks", "confirmed from data"), column("visits", "Analytics visits", "confirmed from data"), column("agree", "Sources agree?", "inference", "text"), column("reading", "Reading", "inference", "text")],
      rows: rowsOut,
      note: "Visits should be at least as many as clicks: every click that lands is a visit. Clicks well above visits is the sign of lost tracking. Clicks to an advisor's sub-pages are in the clicks, not in the visits, so a small excess is not read as a problem.",
    }));
  }

  const order: Record<Agreement, number> = { disagree: 0, one_source: 1, cant_tell: 2, agree: 3 };
  items.sort((a, b) => order[a.agreement] - order[b.agreement]);
  const n = (a: Agreement) => items.filter((x) => x.agreement === a).length;
  const summary = `${n("disagree")} place${n("disagree") === 1 ? "" : "s"} where the sources disagree, ${n("one_source")} found in only one source, ${n("cant_tell")} that could not be read, ${n("agree")} that agree.`;
  return { items, summary, notJoined: NOT_JOINED, tables, floors: FLOORS_LINE };
}

/** Prior-period impressions by group, from the page rows the Search Console reading kept for the groups table (clicks only there), so they are re-derived from the stored groups table's prior-impression column when present. */
async function priorGroupImpressions(g: GscReading): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const t = g.tables.find((x) => x.id === "gsc-groups");
  for (const r of t?.rows ?? []) { const v = gscNum(r.priorImpr); if (v != null) m.set(String(r.group), v); }
  return m;
}

export { fmt, fmtChange, advisorName };

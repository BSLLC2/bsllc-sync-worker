/**
 * Headline figures and the reconciliation. For one window, the prior period and the
 * prior year: raw sessions, then the effect of each rule one by one, then the combined
 * rule the report uses. Every rule is a GA4 filter, so the figures come from Google, not
 * from arithmetic on the page.
 *
 * Sessions, engaged sessions, engagement rate and average engagement time are read
 * with ONE definition and used everywhere else in the report (see DEFINITIONS).
 */
import { and, begins, eq, inList, not, notChannels, notCountries, or, CHANNEL, type Filter } from "./filters.js";
import { totalsByRange, type Reader } from "./ga4.js";
import { column, fmt, fmtChange, change, ratio, table, type Table } from "./metrics.js";
import { label, periodsFor, touches, type Window } from "./periods.js";

export const SESSION_METRICS = ["sessions", "engagedSessions", "userEngagementDuration"] as const;
export const HEAD_METRICS = [...SESSION_METRICS, "activeUsers"] as const;

export interface Rule { key: string; title: string; filter: Filter | null; note: string }

export interface BotConfig {
  excludeCountries: string[];
  excludeChannels: string[];
  /** Landing paths (begins-with) the flood used. */
  floodPaths: string[];
  /** Countries the flood came from, for the narrow rule. */
  floodCountries: string[];
}

export const DEFAULT_FLOOD_PATHS = ["/plan-your-trip/advisor", "/hotel-destinations/"];

/** The stretch the flood ran through, from the stored facts. A window touching it is not comparable unfiltered. */
export const FLOOD_WINDOW: Window = { start: "2025-11-01", end: "2026-08-31" };

export function rulesFor(cfg: BotConfig): Rule[] {
  const direct = eq(CHANNEL, "Direct");
  const floodLanding = or(...cfg.floodPaths.map((p) => begins("landingPage", p)));
  const rules: Rule[] = [];
  if (cfg.excludeChannels.length) {
    rules.push({ key: "channels", title: `Leave out ${cfg.excludeChannels.join(" and ")}`, filter: notChannels(cfg.excludeChannels), note: "Whole channels. Takes real visitors who arrive untagged along with the flood." });
  }
  if (cfg.excludeCountries.length) {
    rules.push({ key: "countries", title: `Leave out ${cfg.excludeCountries.join(", ")}`, filter: notCountries(cfg.excludeCountries), note: "Whole countries, whatever the channel." });
  }
  if (floodLanding) {
    rules.push({ key: "flood_paths", title: "Leave out Direct visits that landed on the flood paths", filter: not(and(direct, floodLanding)!), note: `Direct only, and only the paths the flood used (${cfg.floodPaths.join(", ")}). Keeps Direct visitors who landed anywhere else.` });
    if (cfg.floodCountries.length) {
      rules.push({ key: "flood_paths_country", title: `Leave out Direct visits to the flood paths from ${cfg.floodCountries.join(", ")}`, filter: not(and(direct, floodLanding, inList("country", cfg.floodCountries))!), note: "The narrowest rule: Direct, flood paths and the flood's country together." });
    }
  }
  return rules;
}

/** The combined rule the report's headline uses: every typed exclusion at once. */
export function headlineFilter(cfg: BotConfig): Filter | undefined {
  return and(notCountries(cfg.excludeCountries), notChannels(cfg.excludeChannels));
}

export const headlineFilterText = (cfg: BotConfig): string => {
  const parts: string[] = [];
  if (cfg.excludeChannels.length) parts.push(`channels left out: ${cfg.excludeChannels.join(", ")}`);
  if (cfg.excludeCountries.length) parts.push(`countries left out: ${cfg.excludeCountries.join(", ")}`);
  return parts.length ? parts.join("; ") : "no exclusions";
};

export interface Headline {
  sessions: number | null; engaged: number | null; seconds: number | null;
  users: number | null;
  rate: number | null; avgSeconds: number | null;
  /** Seconds per active user: Google's own "average engagement time" in its reports. */
  avgPerUser: number | null;
}
const head = (t: Record<string, number | null>): Headline => ({
  sessions: t.sessions ?? null, engaged: t.engagedSessions ?? null, seconds: t.userEngagementDuration ?? null, users: t.activeUsers ?? null,
  avgPerUser: ratio(t.userEngagementDuration, t.activeUsers),
  rate: ratio(t.engagedSessions, t.sessions),
  // GA4's own definition: engagement time per session (userEngagementDuration / sessions).
  avgSeconds: ratio(t.userEngagementDuration, t.sessions),
});

export interface Scenario { rule: Rule | null; title: string; periods: [Headline, Headline, Headline] }

export async function readHeadline(read: Reader, w: Window, filter: Filter | undefined): Promise<[Headline, Headline, Headline]> {
  const p = periodsFor(w);
  const res = await read({ dims: [], metrics: HEAD_METRICS, ranges: [p.current, p.prior, p.priorYear], filter: filter ?? null });
  const t = totalsByRange(res.rows, HEAD_METRICS, 3);
  return [head(t[0]!), head(t[1]!), head(t[2]!)];
}

export interface Reconciliation {
  window: Window;
  raw: [Headline, Headline, Headline];
  scenarios: Scenario[];
  headline: [Headline, Headline, Headline];
  headlineFilter: string;
  comparable: { current: boolean; prior: boolean; priorYear: boolean };
  warning: string | null;
}

export async function reconcile(read: Reader, w: Window, cfg: BotConfig, extraRules: Rule[] = []): Promise<Reconciliation> {
  const raw = await readHeadline(read, w, undefined);
  const scenarios: Scenario[] = [];
  for (const rule of [...rulesFor(cfg), ...extraRules]) scenarios.push({ rule, title: rule.title, periods: await readHeadline(read, w, rule.filter ?? undefined) });
  const hf = headlineFilter(cfg);
  const headline = hf ? await readHeadline(read, w, hf) : raw;
  const p = periodsFor(w);
  const comparable = { current: !touches(p.current, FLOOD_WINDOW), prior: !touches(p.prior, FLOOD_WINDOW), priorYear: !touches(p.priorYear, FLOOD_WINDOW) };
  const touching = (["current", "prior", "priorYear"] as const).filter((k) => !comparable[k]);
  const warning = touching.length
    ? `The ${touching.map((k) => (k === "priorYear" ? "same dates a year earlier" : k === "prior" ? "period before" : "chosen window")).join(" and the ")} ${touching.length > 1 ? "touch" : "touches"} Nov 2025 to Aug 2026, when a flood of automated visits ran through Direct. Totals that include those days are not comparable with other periods unless the flood is left out. The rule used here is "${headlineFilterText(cfg)}".`
    : null;
  return { window: w, raw, scenarios, headline, headlineFilter: headlineFilterText(cfg), comparable, warning };
}

/** The effect of every rule, as a table: what it removes and what is left, for the chosen window. */
export function effectTable(r: Reconciliation): Table {
  const rows = [
    [`Everything Analytics counted (no rule)`, r.raw[0]],
    ...r.scenarios.map((s) => [s.title, s.periods[0]] as const),
    [`Headline rule (${r.headlineFilter})`, r.headline[0]],
  ] as Array<readonly [string, Headline]>;
  return table({
    id: "effect-of-rules", title: "What each rule removes, chosen window",
    range: label(r.window), filter: "each row is one rule applied on its own, except the last, which is the report's headline rule",
    columns: [
      column("rule", "Rule", "confirmed from data", "text"), column("sessions", "Sessions left", "confirmed from data"),
      column("removed", "Removed against all", "confirmed from data"), column("share", "Share removed", "confirmed from data", "percent"),
      column("engaged", "Engaged sessions", "confirmed from data"), column("rate", "Engagement rate", "confirmed from data", "percent"),
      column("avg", "Average engagement time", "confirmed from data", "seconds"),
    ],
    rows: rows.map(([title, h]) => {
      const removed = r.raw[0].sessions != null && h.sessions != null ? r.raw[0].sessions - h.sessions : null;
      return { rule: title, sessions: h.sessions, removed, share: ratio(removed, r.raw[0].sessions), engaged: h.engaged, rate: h.rate, avg: h.avgSeconds };
    }),
  });
}

export function headlineTable(r: Reconciliation, p = periodsFor(r.window)): Table {
  const cols: Array<[string, Window, Headline, boolean]> = [
    ["Chosen window", p.current, r.headline[0], r.comparable.current], [r.window.compare ? "Comparison period" : "Period before", p.prior, r.headline[1], r.comparable.prior], ["Same dates a year earlier", p.priorYear, r.headline[2], r.comparable.priorYear],
  ];
  return table({
    id: "headline", title: "Headline, filtered basis", range: `${label(p.current)} against ${label(p.prior)} and ${label(p.priorYear)}`, filter: r.headlineFilter,
    columns: [column("period", "Period", "confirmed from data", "text"), column("dates", "Dates", "confirmed from data", "text"), column("sessions", "Sessions", "confirmed from data"), column("engaged", "Engaged sessions", "confirmed from data"), column("rate", "Engagement rate", "confirmed from data", "percent"), column("avg", "Average engagement time", "confirmed from data", "seconds"), column("note", "Comparable?", "confirmed from data", "text")],
    rows: cols.map(([name, w, h, ok]) => ({ period: name, dates: label(w), sessions: h.sessions, engaged: h.engaged, rate: h.rate, avg: h.avgSeconds, note: ok ? "yes" : "touches the flood months" })),
  });
}

export const changeLine = (now: number | null, before: number | null): string => fmtChange(change(now, before));
export { fmt };

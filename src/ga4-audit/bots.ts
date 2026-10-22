/**
 * The bot and quality watch. Finds where automated-looking traffic sits by landing
 * path, country, city and source, using the engagement rate GA4 itself reports, and
 * builds the NARROWEST rule that removes it, so a rule can be chosen that does not
 * throw real visitors out with the flood.
 *
 * Everything flagged here is an INFERENCE: GA4 does not say a visit was a robot. A
 * path with plenty of sessions and almost none engaged looks automated; it is a
 * reason to look, not proof. The flag floors are ours and printed with every table.
 */
import { and, eq, inList, not, CHANNEL } from "./filters.js";
import { keyed, type Reader } from "./ga4.js";
import { column, ratio, table, type Table } from "./metrics.js";
import { label, periodsFor, type Window } from "./periods.js";
import type { Rule } from "./reconcile.js";

/** A row is automated-looking when it has at least this many sessions in the window and engages under this share. OURS. */
export const FLAG_MIN_SESSIONS = 500;
export const FLAG_MAX_RATE = 0.1;
export const WATCH_ROWS = 15;
const M = ["sessions", "engagedSessions"] as const;

export interface WatchRow {
  key: string; sessions: number; engaged: number; rate: number | null;
  shareOfAll: number | null; flagged: boolean; priorSessions: number | null; priorYearSessions: number | null;
}

export interface Watch { title: string; dimension: string; rows: WatchRow[]; flaggedKeys: string[]; table: Table }

async function watch(read: Reader, w: Window, title: string, dims: string[], keyOf: (d: string[]) => string, filter: ReturnType<typeof eq> | null, filterText: string): Promise<Watch> {
  const p = periodsFor(w);
  const res = await read({ dims, metrics: M, ranges: [p.current, p.prior, p.priorYear], filter, orderBy: "sessions" });
  const [cur, pri, yr] = keyed(res.rows, keyOf, 3);
  let all = 0;
  for (const v of cur.values()) all += v.sessions ?? 0;
  const rows: WatchRow[] = [];
  for (const [key, v] of cur) {
    const sessions = v.sessions ?? 0;
    const engaged = v.engagedSessions ?? 0;
    const rate = ratio(engaged, sessions);
    rows.push({ key, sessions, engaged, rate, shareOfAll: ratio(sessions, all), flagged: sessions >= FLAG_MIN_SESSIONS && rate != null && rate < FLAG_MAX_RATE, priorSessions: pri.get(key)?.sessions ?? null, priorYearSessions: yr.get(key)?.sessions ?? null });
  }
  rows.sort((a, b) => b.sessions - a.sessions);
  const flaggedKeys = rows.filter((r) => r.flagged).map((r) => r.key);
  const top = rows.slice(0, WATCH_ROWS);
  return {
    title, dimension: dims.join(" / "), rows, flaggedKeys,
    table: table({
      id: `bot-${dims.join("-")}`, title, range: label(w), filter: filterText,
      columns: [column("key", title.replace(/^By /, ""), "confirmed from data", "text"), column("sessions", "Sessions", "confirmed from data"), column("share", "Share of the window", "confirmed from data", "percent"), column("rate", "Engagement rate", "confirmed from data", "percent"), column("prior", "Sessions, period before", "confirmed from data"), column("flag", "Automated-looking?", "inference", "text")],
      rows: top.map((r) => ({ key: r.key, sessions: r.sessions, share: r.shareOfAll, rate: r.rate, prior: r.priorSessions, flag: r.flagged ? `yes: over ${FLAG_MIN_SESSIONS} sessions and under ${FLAG_MAX_RATE * 100}% engaged` : "no" })),
      note: `The ${WATCH_ROWS} busiest of ${rows.length} rows. "Automated-looking" is our reading of low engagement on many sessions, not a finding that a visit was a robot.`,
    }),
  };
}

export interface BotWatch {
  landing: Watch; country: Watch; city: Watch; source: Watch;
  /** Landing paths flagged inside Direct, exact. */
  floodPaths: string[];
  autoRule: Rule | null;
}

export async function botWatch(read: Reader, w: Window): Promise<BotWatch> {
  const direct = eq(CHANNEL, "Direct");
  const landing = await watch(read, w, "By landing path, Direct only", ["landingPage"], (d) => d[0] ?? "", direct, "Direct channel only");
  const country = await watch(read, w, "By country", ["country"], (d) => d[0] ?? "", null, "all channels, no rule applied");
  const city = await watch(read, w, "By city, Direct only", ["country", "city"], (d) => `${d[1] ?? ""}, ${d[0] ?? ""}`, direct, "Direct channel only");
  const source = await watch(read, w, "By source / medium", ["sessionSourceMedium"], (d) => d[0] ?? "", null, "all channels, no rule applied");
  const floodPaths = landing.flaggedKeys;
  const autoRule: Rule | null = floodPaths.length
    ? { key: "auto_flood", title: `Leave out Direct visits to the ${floodPaths.length} automated-looking landing paths found in this window`, filter: not(and(direct, inList("landingPage", floodPaths))!), note: "Found from this window's own data: Direct, and only the landing paths with over 500 sessions and under 10% engaged. Keeps every other Direct visitor." }
    : null;
  return { landing, country, city, source, floodPaths, autoRule };
}

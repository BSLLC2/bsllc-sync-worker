/**
 * The facts this audit was built on, re-checked every run against live data. A fact
 * that no longer holds is reported FIRST, before any other figure, because everything
 * after it may rest on it. A fact the data cannot settle says "cannot verify", never
 * "holds".
 *
 * Tolerances are ours. "Holds" means within the tolerance written beside the fact;
 * outside it the fact is reported as changed with the numbers found.
 */
import { addDays } from "../page-behaviour/paths.js";
import { and, begins, eq, inList, or, CHANNEL } from "./filters.js";
import { totalsByRange, type Reader } from "./ga4.js";
import { ratio } from "./metrics.js";
import { notChannels } from "./filters.js";
import type { Window } from "./periods.js";

export type CheckStatus = "holds" | "changed" | "cannot verify";
export interface Check { id: string; claim: string; expected: string; found: string; status: CheckStatus; tolerance: string; basis: "confirmed from data" | "inference"; range: string; filter: string }

export interface Baseline {
  looker: { window: Window; sessions: number; engaged: number; rate: number; avgSeconds: number; excludes: string[] };
  forms: { window: Window; total: number; homepage: number; formEvent: string };
  flood: { window: Window; sessions: number; engagementRate: number; paths: string[] };
  singapore: { window: Window; share: number; country: string };
  throttle: { date: string };
  ga4First: string;
  gscFirst: string;
  gscQueryCoverage: number;
  after: { window: Window; sessions: number; forms: number };
  airtableLeads: number;
  floodCountry: string;
}

export const BROWNELL_BASELINE: Baseline = {
  looker: { window: { start: "2026-01-01", end: "2026-09-30" }, sessions: 37_863, engaged: 25_072, rate: 0.6622, avgSeconds: 68, excludes: ["Direct", "Unassigned"] },
  forms: { window: { start: "2026-07-01", end: "2026-09-30" }, total: 616, homepage: 270, formEvent: "form_submit" },
  flood: { window: { start: "2025-11-01", end: "2026-08-31" }, sessions: 591_000, engagementRate: 0.028, paths: ["/plan-your-trip/advisor", "/hotel-destinations/"] },
  singapore: { window: { start: "2026-07-01", end: "2026-09-30" }, share: 0.44, country: "Singapore" },
  throttle: { date: "2026-07-30" },
  ga4First: "2022-11",
  gscFirst: "2025-06-09",
  gscQueryCoverage: 0.4,
  after: { window: { start: "2026-07-01", end: "2026-09-30" }, sessions: 11_000, forms: 440 },
  airtableLeads: 800,
  floodCountry: "Singapore",
};

const within = (found: number | null, want: number, relTol: number): boolean => found != null && Math.abs(found - want) <= want * relTol;
const f = (n: number | null) => (n == null ? "n/a" : n >= 1 && Number.isInteger(n) ? n.toLocaleString("en-US") : String(Math.round(n * 1000) / 1000));
const rngText = (w: Window) => `${w.start} to ${w.end}`;
const status = (ok: boolean | null): CheckStatus => (ok == null ? "cannot verify" : ok ? "holds" : "changed");

export interface BaselineInputs { gscFirstDay: string | null; gscCoverage: number | null; formEvent: string }

export async function verifyBaseline(read: Reader, b: Baseline, inp: BaselineInputs): Promise<Check[]> {
  const out: Check[] = [];
  const one = async (w: Window, metrics: readonly string[], filter: ReturnType<typeof eq> | undefined) => totalsByRange((await read({ dims: [], metrics, ranges: [w], filter: filter ?? null })).rows, metrics, 1)[0]!;

  // 1. The Looker figure, to the stored numbers.
  {
    const t = await one(b.looker.window, ["sessions", "engagedSessions", "userEngagementDuration", "activeUsers"], notChannels(b.looker.excludes)!);
    const rate = ratio(t.engagedSessions, t.sessions);
    const perSession = ratio(t.userEngagementDuration, t.sessions), perUser = ratio(t.userEngagementDuration, t.activeUsers);
    const ok = within(t.sessions ?? null, b.looker.sessions, 0.005) && within(t.engagedSessions ?? null, b.looker.engaged, 0.005) && rate != null && Math.abs(rate - b.looker.rate) <= 0.003;
    const secs = [perSession, perUser].filter((x): x is number => x != null).some((x) => Math.abs(x - b.looker.avgSeconds) <= 3);
    out.push({
      id: "looker", claim: `Looker Studio "Real traffic" for ${rngText(b.looker.window)}: ${f(b.looker.sessions)} sessions, ${f(b.looker.engaged)} engaged, ${(b.looker.rate * 100).toFixed(2)}%, average engagement time ${Math.floor(b.looker.avgSeconds / 60)}:${String(b.looker.avgSeconds % 60).padStart(2, "0")}`,
      expected: `within 0.5% on counts, 0.3 points on the rate, 3 seconds on time`,
      found: `${f(t.sessions ?? null)} sessions, ${f(t.engagedSessions ?? null)} engaged, ${rate == null ? "n/a" : (rate * 100).toFixed(2) + "%"}; time per session ${perSession == null ? "n/a" : Math.round(perSession) + "s"}, per active user ${perUser == null ? "n/a" : Math.round(perUser) + "s"}${secs ? "" : " (neither matches the stored time)"}`,
      status: status(ok && secs), tolerance: "0.5% counts, 0.3 point rate, 3 seconds", basis: "confirmed from data", range: rngText(b.looker.window), filter: `channels left out: ${b.looker.excludes.join(", ")}`,
    });
  }
  // 2. Key events: form_submit is, form_start is not.
  {
    const end = addDays(b.forms.window.end, 0), start = addDays(end, -89);
    const res = await read({ dims: ["eventName", "isKeyEvent"], metrics: ["eventCount"], ranges: [{ start, end }], filter: inList("eventName", [inp.formEvent, "form_start"]) });
    const get = (n: string, k: string) => res.rows.filter((r) => r.dims[0] === n && r.dims[1] === k).reduce((s, r) => s + (r.m.eventCount ?? 0), 0);
    const submitKey = get(inp.formEvent, "true"), submitNot = get(inp.formEvent, "false"), startKey = get("form_start", "true"), startNot = get("form_start", "false");
    const seen = submitKey + submitNot > 0;
    out.push({ id: "key-events", claim: `${inp.formEvent} is the only key event and form_start is not a key event`, expected: `${inp.formEvent} counted as a key event, form_start not`, found: seen ? `${inp.formEvent}: ${f(submitKey)} as key event, ${f(submitNot)} not; form_start: ${f(startKey)} as key event, ${f(startNot)} not` : `no ${inp.formEvent} events in the last 90 days`, status: status(seen ? submitKey > 0 && submitNot === 0 && startKey === 0 : null), tolerance: "exact", basis: "confirmed from data", range: `${start} to ${end}`, filter: `events ${inp.formEvent} and form_start, split by the isKeyEvent dimension. The Admin API is disabled, so the list of all key events cannot be read; this checks these two only` });
  }
  // 3. form_submit in Jul-Sep: total and the homepage's share.
  {
    const res = await read({ dims: ["pagePath"], metrics: ["eventCount"], ranges: [b.forms.window], filter: eq("eventName", inp.formEvent) });
    let total = 0, home = 0;
    for (const r of res.rows) { const v = r.m.eventCount ?? 0; total += v; if ((r.dims[0] ?? "") === "/") home += v; }
    out.push({ id: "forms-jul-sep", claim: `${inp.formEvent} fired ${f(b.forms.total)} times ${rngText(b.forms.window)}, ${f(b.forms.homepage)} of them on the homepage`, expected: "within 1%", found: `${f(total)} in all, ${f(home)} on the homepage (${total ? ((home / total) * 100).toFixed(1) : "n/a"}%)`, status: status(res.truncated ? null : within(total, b.forms.total, 0.01) && within(home, b.forms.homepage, 0.02)), tolerance: "1% total, 2% homepage", basis: "confirmed from data", range: rngText(b.forms.window), filter: "no exclusions" });
  }
  // 4. The flood.
  {
    const t = await one(b.flood.window, ["sessions", "engagedSessions"], and(eq(CHANNEL, "Direct"), or(...b.flood.paths.map((p) => begins("landingPage", p))))!);
    const rate = ratio(t.engagedSessions, t.sessions);
    out.push({ id: "flood", claim: `About ${f(b.flood.sessions)} Direct sessions landed on ${b.flood.paths.join(" and ")} ${rngText(b.flood.window)}, ${(b.flood.engagementRate * 100).toFixed(1)}% engaged`, expected: "within 5% on sessions, 0.5 points on the rate", found: `${f(t.sessions ?? null)} sessions, ${rate == null ? "n/a" : (rate * 100).toFixed(1) + "%"} engaged`, status: status(t.sessions == null ? null : within(t.sessions, b.flood.sessions, 0.05) && rate != null && Math.abs(rate - b.flood.engagementRate) <= 0.005), tolerance: "5% sessions, 0.5 point rate", basis: "confirmed from data", range: rngText(b.flood.window), filter: `Direct channel, landing page begins with ${b.flood.paths.join(" or ")}` });
  }
  // 5. Singapore's share.
  {
    const all = await one(b.singapore.window, ["sessions"], undefined);
    const sg = await one(b.singapore.window, ["sessions"], eq("country", b.singapore.country));
    const share = ratio(sg.sessions, all.sessions);
    out.push({ id: "singapore", claim: `${b.singapore.country} was ${(b.singapore.share * 100).toFixed(0)}% of sessions ${rngText(b.singapore.window)}`, expected: "within 2 points", found: share == null ? "n/a" : `${(share * 100).toFixed(1)}% (${f(sg.sessions ?? null)} of ${f(all.sessions ?? null)})`, status: status(share == null ? null : Math.abs(share - b.singapore.share) <= 0.02), tolerance: "2 points", basis: "confirmed from data", range: rngText(b.singapore.window), filter: "no exclusions" });
  }
  // 6. The throttle: the flood paths' Direct sessions fall after the date.
  {
    const d = b.throttle.date;
    const before: Window = { start: addDays(d, -14), end: addDays(d, -1) }, after: Window = { start: d, end: addDays(d, 13) };
    const fl = and(eq(CHANNEL, "Direct"), or(...b.flood.paths.map((p) => begins("landingPage", p))))!;
    const r = await read({ dims: [], metrics: ["sessions"], ranges: [before, after], filter: fl });
    const t = totalsByRange(r.rows, ["sessions"], 2);
    const a = t[0]!.sessions, c = t[1]!.sessions;
    out.push({ id: "throttle", claim: `A site-level throttle began ${d}: automated Direct sessions on the flood paths fall`, expected: "the 14 days from that date have under half the sessions of the 14 days before", found: a == null || c == null ? "n/a" : `${f(a)} sessions in the 14 days before, ${f(c)} in the 14 days from ${d}`, status: status(a == null || c == null || a < 100 ? null : c < a * 0.5), tolerance: "under half", basis: "inference", range: `${rngText(before)} against ${rngText(after)}`, filter: "Direct channel, flood landing paths" });
  }
  // 7. Where GA4's history starts.
  {
    const r = await read({ dims: ["yearMonth"], metrics: ["sessions"], ranges: [{ start: "2020-01-01", end: addDays(b.looker.window.end, 0) }] });
    const months = r.rows.filter((x) => (x.m.sessions ?? 0) > 0).map((x) => x.dims[0] ?? "").filter(Boolean).sort();
    const first = months[0] ? `${months[0].slice(0, 4)}-${months[0].slice(4, 6)}` : null;
    out.push({ id: "ga4-first", claim: `Analytics data starts in ${b.ga4First}`, expected: b.ga4First, found: first ?? "no data", status: status(first == null ? null : first === b.ga4First), tolerance: "exact month", basis: "confirmed from data", range: "Jan 1, 2020 to the end of the Looker window", filter: "no exclusions" });
  }
  // 8 and 9. Search Console facts, if the Search Console half ran.
  out.push({ id: "gsc-first", claim: `Search Console history starts ${b.gscFirst}`, expected: b.gscFirst, found: inp.gscFirstDay ?? "Search Console was not read", status: status(inp.gscFirstDay == null ? null : inp.gscFirstDay === b.gscFirst), tolerance: "exact day", basis: "confirmed from data", range: "the longest history Search Console keeps", filter: "all queries" });
  out.push({ id: "gsc-coverage", claim: `Search Console reports about ${(b.gscQueryCoverage * 100).toFixed(0)}% of clicks by query`, expected: "between 30% and 50%", found: inp.gscCoverage == null ? "not worked out" : `${(inp.gscCoverage * 100).toFixed(0)}%`, status: status(inp.gscCoverage == null ? null : inp.gscCoverage >= 0.3 && inp.gscCoverage <= 0.5), tolerance: "10 points either side", basis: "confirmed from data", range: "the chosen window", filter: "clicks with a query against all clicks" });
  // 10. What the report should show after leaving Direct and Unassigned out, Jul-Sep.
  {
    const w = b.after.window;
    const nf = notChannels(["Direct", "Unassigned"])!;
    const s = await one(w, ["sessions"], nf);
    const fm = await one(w, ["eventCount"], and(nf, eq("eventName", inp.formEvent)));
    const ok = s.sessions != null && fm.eventCount != null && within(s.sessions, b.after.sessions, 0.1) && within(fm.eventCount, b.after.forms, 0.1);
    out.push({ id: "after-exclusion", claim: `With Direct and Unassigned left out, ${rngText(w)} is about ${f(b.after.sessions)} sessions and ${f(b.after.forms)} ${inp.formEvent} events`, expected: "within 10% on each", found: `${f(s.sessions ?? null)} sessions, ${f(fm.eventCount ?? null)} ${inp.formEvent} events`, status: status(s.sessions == null || fm.eventCount == null ? null : ok), tolerance: "10%", basis: "confirmed from data", range: rngText(w), filter: "channels left out: Direct, Unassigned" });
  }
  out.push({ id: "airtable", claim: `The Airtable holds about ${f(b.airtableLeads)} real leads year to date`, expected: "n/a", found: "The audit cannot read the Airtable. Compare by hand.", status: "cannot verify", tolerance: "not applicable", basis: "inference", range: "year to date", filter: "not read" });
  return out;
}

/** Changed facts first, then facts that cannot be verified, then those that hold. */
export const orderChecks = (c: readonly Check[]): Check[] => [...c].sort((a, b) => ["changed", "cannot verify", "holds"].indexOf(a.status) - ["changed", "cannot verify", "holds"].indexOf(b.status));

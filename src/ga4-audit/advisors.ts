/**
 * Advisor microsites: views, visits, form submit events, submits per visit and
 * engagement, per advisor, with the directory and the homepage kept OUT of every
 * advisor figure.
 *
 * "Visits" for an advisor is the number of sessions that viewed that advisor's MAIN
 * page (an exact path, so one session counts once). Views is page views across all of
 * the advisor's pages. Sub-pages are in views and form events, not in visits, because
 * a session that looked at two sub-pages would otherwise count twice.
 */
import { and, begins, eq, type Filter } from "./filters.js";
import { keyed, type Reader } from "./ga4.js";
import { column, change, ratio, table, type Table } from "./metrics.js";
import { advisorName, advisorSlug, type AuditConfig } from "./classify.js";
import { label, periodsFor, type Window } from "./periods.js";

/** Fewer visits than this in a period and a rate or a ratio is not read for that advisor. OURS. */
export const ADVISOR_MIN_SESSIONS = 30;
/** Fewer than this many movers need a base this big in the earlier period to be named. OURS. */
export const ADVISOR_MOVER_BASE = 30;
const TOP = 10;

export interface AdvisorPeriod { views: number | null; sessions: number | null; engaged: number | null; submits: number | null }
export interface Advisor {
  slug: string; name: string;
  periods: [AdvisorPeriod, AdvisorPeriod, AdvisorPeriod];
}

const blank = (): AdvisorPeriod => ({ views: null, sessions: null, engaged: null, submits: null });

export interface AdvisorReading {
  advisors: Advisor[];
  tables: { leaders: Table; risers: Table; fallers: Table };
  /** Advisor pages the visit queries returned that were left out because they are not an advisor (directory, homepage). */
  note: string;
  directoryNote: string;
}

const add = (a: number | null, b: number | null | undefined) => (b == null ? a : (a ?? 0) + b);

export async function readAdvisors(read: Reader, w: Window, cfg: AuditConfig, formEvent: string, headline: Filter | undefined): Promise<AdvisorReading> {
  const p = periodsFor(w);
  const ranges = [p.current, p.prior, p.priorYear];
  const pageFilter = and(begins("pagePath", cfg.advisorPrefix), headline);
  const pages = await read({ dims: ["pagePath"], metrics: ["screenPageViews", "sessions", "engagedSessions"], ranges, filter: pageFilter ?? null, orderBy: "screenPageViews" });
  const forms = await read({ dims: ["pagePath"], metrics: ["eventCount"], ranges, filter: and(begins("pagePath", cfg.advisorPrefix), eq("eventName", formEvent), headline) ?? null, orderBy: "eventCount" });
  const byAdvisor = new Map<string, Advisor>();
  const get = (slug: string): Advisor => byAdvisor.get(slug) ?? (byAdvisor.set(slug, { slug, name: advisorName(slug), periods: [blank(), blank(), blank()] }), byAdvisor.get(slug)!);
  const mainPath = (slug: string) => `${cfg.advisorPrefix}${slug}`;
  const isMain = (path: string, slug: string) => path.replace(/\/+$/, "").toLowerCase() === mainPath(slug).replace(/\/+$/, "");
  for (const r of pages.rows) {
    const path = r.dims[0] ?? "";
    const slug = advisorSlug(path, cfg);
    if (!slug) continue; // the directory and anything that is not an advisor
    const a = get(slug).periods[r.range]!;
    a.views = add(a.views, r.m.screenPageViews);
    if (isMain(path, slug)) { a.sessions = add(a.sessions, r.m.sessions); a.engaged = add(a.engaged, r.m.engagedSessions); }
  }
  for (const r of forms.rows) {
    const slug = advisorSlug(r.dims[0] ?? "", cfg);
    if (!slug) continue;
    get(slug).periods[r.range]!.submits = add(get(slug).periods[r.range]!.submits, r.m.eventCount);
  }
  const advisors = [...byAdvisor.values()];
  const rng = `${label(p.current)} against ${label(p.prior)}`;
  const filt = `advisor microsite pages only (the directory and the homepage are left out); ${headline ? "headline rule applied" : "no rule applied"}`;
  const cols = [
    column("name", "Advisor", "confirmed from data", "text"), column("sessions", "Visits to the main page", "confirmed from data"), column("views", "Page views, all their pages", "confirmed from data"),
    column("submits", "Form submit events", "confirmed from data"), column("per", "Submit events per visit", "confirmed from data", "ratio"), column("rate", "Engagement rate", "confirmed from data", "percent"), column("flag", "Enough visits to read?", "confirmed from data", "text"),
  ];
  const row = (a: Advisor) => {
    const c = a.periods[0];
    const enough = (c.sessions ?? 0) >= ADVISOR_MIN_SESSIONS;
    return { name: a.name, sessions: c.sessions, views: c.views, submits: c.submits, per: enough ? ratio(c.submits, c.sessions) : null, rate: enough ? ratio(c.engaged, c.sessions) : null, flag: enough ? "yes" : `no: under ${ADVISOR_MIN_SESSIONS} visits` };
  };
  const leaders = [...advisors].sort((a, b) => (b.periods[0].sessions ?? 0) - (a.periods[0].sessions ?? 0)).slice(0, TOP);
  const moving = advisors.filter((a) => (a.periods[1].sessions ?? 0) >= ADVISOR_MOVER_BASE && a.periods[0].sessions != null);
  const delta = (a: Advisor) => change(a.periods[0].sessions, a.periods[1].sessions) ?? 0;
  const moverCols = [column("name", "Advisor", "confirmed from data", "text"), column("now", "Visits now", "confirmed from data"), column("before", "Visits, period before", "confirmed from data"), column("chg", "Change", "confirmed from data", "percent"), column("note", "What this does not say", "inference", "text")];
  const moverRow = (a: Advisor) => ({ name: a.name, now: a.periods[0].sessions, before: a.periods[1].sessions, chg: delta(a), note: "A change in visits. It does not say why. Ask the advisor whether they promoted their page or changed it." });
  const risers = [...moving].filter((a) => delta(a) > 0).sort((a, b) => delta(b) - delta(a)).slice(0, 5);
  const fallers = [...moving].filter((a) => delta(a) < 0).sort((a, b) => delta(a) - delta(b)).slice(0, 5);
  return {
    advisors,
    tables: {
      leaders: table({ id: "advisor-leaders", title: "Advisors with the most visits", range: label(p.current), filter: filt, columns: cols, rows: leaders.map(row), note: `${advisors.length} advisor microsites had page views. A visit is counted once, on the advisor's main page.` }),
      risers: table({ id: "advisor-risers", title: "Advisors whose visits rose most", range: rng, filter: `${filt}; only advisors with at least ${ADVISOR_MOVER_BASE} visits in the period before`, columns: moverCols, rows: risers.map(moverRow) }),
      fallers: table({ id: "advisor-fallers", title: "Advisors whose visits fell most", range: rng, filter: `${filt}; only advisors with at least ${ADVISOR_MOVER_BASE} visits in the period before`, columns: moverCols, rows: fallers.map(moverRow) }),
    },
    note: `Visits are sessions that viewed the advisor's main page, so one session counts once per advisor. A session that viewed two advisors counts for both, so advisor visits do not add to the site total.`,
    directoryNote: `The directory (${cfg.advisorPrefix}) and the homepage are not advisors and are not in any figure above. Form submit events that fire there are searches and are shown on their own in the funnel.`,
  };
}

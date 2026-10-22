/**
 * Sources and movers. Search, social (Facebook and Instagram apart), AI assistants,
 * referral, email; then what moved most across channels, landing pages, page groups
 * and countries, each with a likely driver written as a HYPOTHESIS and the test that
 * would confirm it. A driver is never stated as fact.
 */
import { and, type Filter } from "./filters.js";
import { keyed, type Reader } from "./ga4.js";
import { classifyPath, classifySource, SOURCE_LABEL, type AuditConfig, type SourceClass } from "./classify.js";
import { column, change, ratio, table, type Table } from "./metrics.js";
import { label, periodsFor, type Window } from "./periods.js";

const SM = ["sessions", "engagedSessions"] as const;
type Rec = Record<string, number | null>;

export interface SourceReading { tables: { byClass: Table; ai: Table }; notes: string[] }

export async function readSources(read: Reader, w: Window, headline: Filter | undefined, formEvent: string, countriesOnly: Filter | undefined): Promise<SourceReading> {
  const p = periodsFor(w);
  const ranges = [p.current, p.prior, p.priorYear];
  const res = await read({ dims: ["sessionSourceMedium"], metrics: SM, ranges, filter: headline ?? null, orderBy: "sessions" });
  const forms = await read({ dims: ["sessionSourceMedium"], metrics: ["eventCount"], ranges, filter: and({ filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: formEvent } } }, headline) ?? null, orderBy: "eventCount" });
  const sum = (rows: typeof res.rows, key: string) => {
    const out = new Map<SourceClass, [number | null, number | null, number | null]>();
    for (const r of rows) {
      const c = classifySource(r.dims[0] ?? "");
      const a = out.get(c) ?? [null, null, null];
      const v = r.m[key];
      if (v != null) a[r.range] = (a[r.range] ?? 0) + v;
      out.set(c, a);
    }
    return out;
  };
  const sess = sum(res.rows, "sessions"), eng = sum(res.rows, "engagedSessions"), ev = sum(forms.rows, "eventCount");
  const classes = [...sess.keys()].sort((a, b) => (sess.get(b)![0] ?? 0) - (sess.get(a)![0] ?? 0));
  const byClass = table({
    id: "sources-by-class", title: "Visits by kind of source", range: `${label(p.current)} against ${label(p.prior)} and ${label(p.priorYear)}`, filter: `headline rule applied; source kind is our classification from the source and medium Analytics reports`,
    columns: [column("kind", "Source kind", "inference", "text"), column("sessions", "Sessions", "confirmed from data"), column("rate", "Engagement rate", "confirmed from data", "percent"), column("submits", "Form submit events", "confirmed from data"), column("prior", "Sessions, period before", "confirmed from data"), column("chg", "Change", "confirmed from data", "percent"), column("yr", "Sessions, year earlier", "confirmed from data"), column("chgYr", "Change on year", "confirmed from data", "percent")],
    rows: classes.map((c) => {
      const s = sess.get(c)!;
      return { kind: SOURCE_LABEL[c], sessions: s[0], rate: ratio(eng.get(c)?.[0], s[0]), submits: ev.get(c)?.[0] ?? null, prior: s[1], chg: change(s[0], s[1]), yr: s[2], chgYr: change(s[0], s[2]) };
    }),
  });
  // AI assistants: combined and each one separately.
  const ai = new Map<string, [number | null, number | null, number | null]>();
  for (const r of res.rows) {
    if (classifySource(r.dims[0] ?? "") !== "ai_assistant") continue;
    const k = (r.dims[0] ?? "").split(" / ")[0]!.trim().toLowerCase();
    const a = ai.get(k) ?? [null, null, null];
    if (r.m.sessions != null) a[r.range] = (a[r.range] ?? 0) + r.m.sessions;
    ai.set(k, a);
  }
  const combined: [number | null, number | null, number | null] = [null, null, null];
  for (const a of ai.values()) for (let i = 0; i < 3; i++) if (a[i] != null) combined[i] = (combined[i] ?? 0) + a[i]!;
  const aiRows = [{ who: "All AI assistants together", s0: combined[0], s1: combined[1], s2: combined[2] }, ...[...ai.entries()].sort((a, b) => (b[1][0] ?? 0) - (a[1][0] ?? 0)).map(([k, a]) => ({ who: k, s0: a[0], s1: a[1], s2: a[2] }))];
  const aiTable = table({
    id: "sources-ai", title: "Visits from AI assistants", range: `${label(p.current)} against ${label(p.prior)} and ${label(p.priorYear)}`, filter: "headline rule applied; assistants identified by exact host",
    columns: [column("who", "Assistant", "inference", "text"), column("s0", "Sessions", "confirmed from data"), column("s1", "Sessions, period before", "confirmed from data"), column("chg", "Change", "confirmed from data", "percent"), column("s2", "Sessions, year earlier", "confirmed from data")],
    rows: aiRows.map((r) => ({ ...r, chg: change(r.s0, r.s1) })),
    note: "Only visits where the assistant passed its address are counted. An assistant that does not pass one lands in Direct, so these are floors.",
  });
  return {
    tables: { byClass, ai: aiTable },
    notes: [
      "Instagram links without tracking codes arrive as Direct, and so does most traffic from messaging and email apps. If Direct is left out of the headline, those visitors are left out with it. They cannot be told apart from other Direct traffic in this data.",
    ],
  };
}

/* ───────────── movers ───────────── */

export type MoverKind = "channel" | "landing" | "group" | "country";
export interface Mover { key: string; now: number; before: number; delta: number; pct: number | null }

export const HYPOTHESES: Record<MoverKind, { driver: string; test: string }> = {
  channel: { driver: "A campaign started or stopped, a tracking tag on links changed, or a platform changed how it sends visitors.", test: "Compare the date it changed with the campaign calendar, and check that links in that channel still carry the tracking parameters." },
  landing: { driver: "The page was edited, moved or linked from a new place, or its search position changed.", test: "Check the site's change history for that date, and the page's Search Console clicks and position for the same weeks." },
  group: { driver: "A change to how visitors reach that section, such as a navigation change or a new link from the homepage.", test: "Compare the weekly series for the section with the date of any site or navigation change." },
  country: { driver: "Travel season, a campaign aimed at that country, or automated traffic.", test: "Compare the country's engagement rate and its landing pages. Automated traffic engages under a few percent; real visitors do not." },
};

const MOVER_BASE = 100;
const MOVER_N = 5;

export function movers(cur: Map<string, Rec>, prior: Map<string, Rec>, metric: string): { up: Mover[]; down: Mover[] } {
  const keys = new Set([...cur.keys(), ...prior.keys()]);
  const all: Mover[] = [];
  for (const k of keys) {
    const now = cur.get(k)?.[metric] ?? 0, before = prior.get(k)?.[metric] ?? 0;
    if (Math.max(now, before) < MOVER_BASE) continue;
    all.push({ key: k, now, before, delta: now - before, pct: before === 0 ? null : (now - before) / before });
  }
  return { up: all.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, MOVER_N), down: all.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, MOVER_N) };
}

function moverTable(title: string, kind: MoverKind, ups: Mover[], downs: Mover[], range: string, filter: string, unit: string): Table {
  const h = HYPOTHESES[kind];
  const rows = [...ups.map((m) => ({ dir: "up", ...m })), ...downs.map((m) => ({ dir: "down", ...m }))];
  return table({
    id: `movers-${kind}`, title, range, filter,
    columns: [column("dir", "Direction", "confirmed from data", "text"), column("key", kind === "channel" ? "Channel" : kind === "country" ? "Country" : kind === "group" ? "Page group" : "Landing page", "confirmed from data", "text"), column("now", `${unit}, chosen window`, "confirmed from data"), column("before", `${unit}, period before`, "confirmed from data"), column("delta", "Change in count", "confirmed from data"), column("pct", "Change", "confirmed from data", "percent"), column("driver", "Possible driver (hypothesis)", "inference", "text"), column("test", "Test that would confirm it", "inference", "text")],
    rows: rows.map((m) => ({ dir: m.dir, key: m.key, now: m.now, before: m.before, delta: m.delta, pct: m.pct, driver: h.driver, test: h.test })),
    note: `Only rows with at least ${MOVER_BASE} sessions in one of the two periods. A mover is a change in a count. The driver column is a hypothesis; the test column says how to check it.`,
  });
}

export interface MoverReading { tables: Table[] }

export async function readMovers(read: Reader, w: Window, cfg: AuditConfig, headline: Filter | undefined, countriesOnly: Filter | undefined, channelsOnly: Filter | undefined): Promise<MoverReading> {
  const p = periodsFor(w);
  const ranges = [p.current, p.prior, p.priorYear];
  const rng = `${label(p.current)} against ${label(p.prior)}`;
  const out: Table[] = [];
  const chan = await read({ dims: ["sessionDefaultChannelGroup"], metrics: SM, ranges, filter: countriesOnly ?? null, orderBy: "sessions" });
  { const [c, pr] = keyed(chan.rows, (d) => d[0] ?? "", 3); const m = movers(c, pr, "sessions"); out.push(moverTable("Channels that moved most", "channel", m.up, m.down, rng, "only the country rule applied, so no channel is hidden", "Sessions")); }
  const land = await read({ dims: ["landingPage"], metrics: SM, ranges, filter: headline ?? null, orderBy: "sessions" });
  { const [c, pr] = keyed(land.rows, (d) => d[0] ?? "", 3); const m = movers(c, pr, "sessions"); out.push(moverTable("Landing pages that moved most", "landing", m.up, m.down, rng, "headline rule applied", "Sessions"));
    const g = (map: Map<string, Rec>) => { const o = new Map<string, Rec>(); for (const [k, v] of map) { const n = classifyPath(k, cfg).group; const cur = o.get(n) ?? { sessions: 0 }; cur.sessions = (cur.sessions ?? 0) + (v.sessions ?? 0); o.set(n, cur); } return o; };
    const gm = movers(g(c), g(pr), "sessions"); out.push(moverTable("Page groups that moved most (visits that started in the group)", "group", gm.up, gm.down, rng, "headline rule applied; a group is our classification of the landing page", "Sessions")); }
  const ctry = await read({ dims: ["country"], metrics: SM, ranges, filter: channelsOnly ?? null, orderBy: "sessions" });
  { const [c, pr] = keyed(ctry.rows, (d) => d[0] ?? "", 3); const m = movers(c, pr, "sessions"); out.push(moverTable("Countries that moved most", "country", m.up, m.down, rng, "only the channel rule applied, so no country is hidden", "Sessions")); }
  return { tables: out };
}

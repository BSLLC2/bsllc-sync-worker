/**
 * The audit, assembled. Pure over a Reader (GA4) and an optional GscReader, so the guard
 * drives the whole thing with a pretend property. Writes nothing anywhere: the caller
 * decides where the report goes.
 */
import { and, eq, notCountries, notChannels, CHANNEL } from "./filters.js";
import { readAdvisors, type AdvisorReading } from "./advisors.js";
import { project, flagWeeks, stepChange, toWeeks, type Flag, type Step, type Projection } from "./anomaly.js";
import { verifyBaseline, orderChecks, BROWNELL_BASELINE, type Baseline, type Check } from "./baseline.js";
import { botWatch, type BotWatch } from "./bots.js";
import type { AuditConfig } from "./classify.js";
import { readFunnel, type Funnel } from "./funnel.js";
import type { Reader } from "./ga4.js";
import { readGsc, type GscReader, type GscReading } from "./gsc.js";
import { column, ratio, table, type Table } from "./metrics.js";
import { FLOOD_WINDOW, headlineFilter, reconcile, type BotConfig, type Reconciliation } from "./reconcile.js";
import { addDays } from "../page-behaviour/paths.js";
import { label, periodsFor, touches, type Window } from "./periods.js";
import { readMovers, readSources, type MoverReading, type SourceReading } from "./traffic.js";

export interface AuditOptions {
  client: string;
  today: string;
  window: Window;
  cfg: AuditConfig;
  bots: BotConfig;
  formEvent: string;
  startEvent: string;
  baseline: Baseline | null;
  gsc: { read: GscReader; property: string; permission: string } | null;
}

export interface Series { name: string; unit: string; weeks: number; flags: Flag[]; step: Step | null; range: string; filter: string }

export interface Audit {
  generatedOn: string; client: string; window: Window; options: AuditOptions;
  checks: Check[];
  reconciliation: Reconciliation;
  bots: BotWatch;
  advisors: AdvisorReading;
  funnel: Funnel;
  sources: SourceReading;
  movers: MoverReading;
  series: Series[];
  projection: Projection;
  gsc: GscReading | null;
  cross: Table | null;
  quality: string[];
}

const ymdFromGa = (s: string) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s);

async function daily(read: Reader, range: Window, metric: string, filter: ReturnType<typeof and> | null): Promise<{ days: Map<string, number>; truncated: boolean }> {
  const res = await read({ dims: ["date"], metrics: [metric], ranges: [range], filter: filter ?? null });
  const days = new Map<string, number>();
  for (const r of res.rows) { const d = ymdFromGa(r.dims[0] ?? ""); days.set(d, (days.get(d) ?? 0) + (r.m[metric] ?? 0)); }
  return { days, truncated: res.truncated };
}

export async function runAudit(read: Reader, o: AuditOptions): Promise<Audit> {
  const quality: string[] = [];
  const hf = headlineFilter(o.bots);
  const countriesOnly = notCountries(o.bots.excludeCountries) ?? undefined;
  const channelsOnly = notChannels(o.bots.excludeChannels) ?? undefined;
  const p = periodsFor(o.window);

  // Bot watch first: it finds the narrow rule the reconciliation then tests.
  const bots = await botWatch(read, o.window);
  const reconciliation = await reconcile(read, o.window, o.bots, bots.autoRule ? [bots.autoRule] : []);
  const advisors = await readAdvisors(read, o.window, o.cfg, o.formEvent, hf);
  const funnel = await readFunnel(read, o.window, o.cfg, o.formEvent, o.startEvent, hf, countriesOnly);
  const sources = await readSources(read, o.window, hf, o.formEvent, countriesOnly);
  const movers = await readMovers(read, o.window, o.cfg, hf, countriesOnly, channelsOnly);

  // Weekly series for anomalies, on the headline basis.
  const seriesStart = p.priorYear.start < p.prior.start ? p.priorYear.start : p.prior.start;
  const range: Window = { start: seriesStart, end: o.window.end };
  const formsDaily = await daily(read, range, "eventCount", and(eq("eventName", o.formEvent), hf));
  const sessDaily = await daily(read, range, "sessions", hf ?? null);
  const rawDaily = await daily(read, range, "sessions", null);
  const filtText = reconciliation.headlineFilter;
  const mkSeries = (name: string, unit: string, days: Map<string, number>, filter: string): Series => {
    const weeks = toWeeks(days, range.start, range.end);
    return { name, unit, weeks: weeks.length, flags: flagWeeks(weeks), step: stepChange(weeks), range: label(range), filter };
  };
  const series: Series[] = [
    mkSeries("Form submit events", "events", formsDaily.days, `event ${o.formEvent}; ${filtText}`),
    mkSeries("Sessions, headline rule", "sessions", sessDaily.days, filtText),
    mkSeries("Sessions, no rule", "sessions", rawDaily.days, "no exclusions"),
  ];
  if ([formsDaily, sessDaily, rawDaily].some((d) => d.truncated)) quality.push("A daily series hit the row ceiling, so its weekly figures may be partial.");

  // Projection: clean months only (no overlap with the flood), from the full history, no rule applied.
  const hist = await read({ dims: ["yearMonth"], metrics: ["sessions"], ranges: [{ start: "2020-01-01", end: o.window.end }] });
  const clean = new Map<string, number>();
  for (const r of hist.rows) {
    const ym = r.dims[0] ?? "";
    if (!/^\d{6}$/.test(ym) || (r.m.sessions ?? 0) <= 0) continue;
    const key = `${ym.slice(0, 4)}-${ym.slice(4, 6)}`;
    const first = `${key}-01`;
    const last = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(4, 6)), 0)).toISOString().slice(0, 10);
    if (last > o.window.end) continue; // not a complete month
    if (touches({ start: first, end: last }, FLOOD_WINDOW)) continue; // not clean
    clean.set(key, r.m.sessions ?? 0);
  }
  const nextMonth = (() => { const y = Number(o.window.end.slice(0, 4)), m = Number(o.window.end.slice(5, 7)); const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1; return `${ny}-${String(nm).padStart(2, "0")}`; })();
  const projection = project(clean, nextMonth);

  // Search Console.
  let gsc: GscReading | null = null;
  let cross: Table | null = null;
  if (o.gsc) {
    try {
      gsc = await readGsc(o.gsc.read, { property: o.gsc.property, permission: o.gsc.permission, window: o.window, today: o.today, cfg: o.cfg, advisorSlugs: advisors.advisors.map((a) => a.slug) });
      const monthsAvail = [...gsc.monthlyClicks.keys()].sort();
      if (monthsAvail.length) {
        const first = `${monthsAvail[0]}-01`;
        const org = await read({ dims: ["yearMonth"], metrics: ["sessions"], ranges: [{ start: first, end: o.window.end }], filter: and(eq(CHANNEL, "Organic Search"), countriesOnly) ?? null });
        const rows = org.rows.map((r) => ({ ym: `${(r.dims[0] ?? "").slice(0, 4)}-${(r.dims[0] ?? "").slice(4, 6)}`, s: r.m.sessions ?? 0 })).filter((r) => gsc!.monthlyClicks.has(r.ym)).sort((a, b) => a.ym.localeCompare(b.ym));
        const ratios = rows.map((r) => ratio(r.s, gsc!.monthlyClicks.get(r.ym) ?? null)).filter((x): x is number => x != null).sort((a, b) => a - b);
        const med = ratios.length ? ratios[Math.floor(ratios.length / 2)]! : null;
        cross = table({
          id: "cross-check", title: "Cross-check: Analytics organic sessions against Search Console clicks, by month", range: `${first} to ${o.window.end}, complete and part months Search Console has`, filter: "Analytics: channel Organic Search, country rule applied. Search Console: all clicks.",
          columns: [column("month", "Month", "confirmed from data", "text"), column("sessions", "Organic Search sessions", "confirmed from data"), column("clicks", "Search Console clicks", "confirmed from data"), column("ratio", "Sessions per click", "confirmed from data", "ratio"), column("flag", "Away from the usual ratio?", "inference", "text")],
          rows: rows.map((r) => { const rt = ratio(r.s, gsc!.monthlyClicks.get(r.ym) ?? null); const off = med != null && rt != null && Math.abs(rt - med) / med > 0.25; return { month: r.ym, sessions: r.s, clicks: gsc!.monthlyClicks.get(r.ym) ?? null, ratio: rt, flag: off ? "yes: more than 25% from the median ratio" : "no" }; }),
          note: `Median ratio ${med == null ? "n/a" : med.toFixed(2)}. Search Console is not affected by automated visits. A month whose Analytics organic sessions run far above the usual ratio suggests organic still holds automated traffic; far below suggests lost tracking. Neither proves it. The ratio is not 1 because the two tools count different things.`,
        });
      }
    } catch (e) { quality.push(`Search Console could not be read: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`); }
  } else quality.push("Search Console was not read: no property was available to this service account.");

  const checks = o.baseline ? orderChecks(await verifyBaseline(read, o.baseline, { gscFirstDay: gsc?.firstDay ?? null, gscCoverage: gsc?.branded.coverage[0] ?? null, formEvent: o.formEvent })) : [];
  if (reconciliation.warning) quality.push(reconciliation.warning);
  quality.push("form_submit is the only conversion-like event Analytics holds for this site, and it counts searches and repeats. No count of enquiries can be taken from this data.");
  if (!o.baseline) quality.push("No stored baseline was supplied, so the stored facts were not re-checked.");
  return { generatedOn: o.today, client: o.client, window: o.window, options: o, checks, reconciliation, bots, advisors, funnel, sources, movers, series, projection, gsc, cross, quality };
}

export { BROWNELL_BASELINE, addDays };

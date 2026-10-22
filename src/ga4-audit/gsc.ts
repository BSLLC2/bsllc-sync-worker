/**
 * Search Console half of the audit. READ-ONLY. Search Console is not touched by
 * automated visits, so it is the independent check on whether the GA4 bot rule is
 * right, and the only place to see whether a fall in forms follows a fall in search.
 *
 * Facts about the property, re-verified every run: it is a domain property, its history
 * starts where it starts (the earliest day returned), and it reports clicks by query for
 * only part of all clicks (anonymised queries are left out). Neither is assumed.
 */
import { getJson, postJson, HttpError } from "../page-behaviour/http.js";
import type { FetchLike } from "../page-behaviour/types.js";
import { addDays } from "../page-behaviour/paths.js";
import { advisorName, advisorSlug, classifyPath, type AuditConfig } from "./classify.js";
import { column, change, ratio, table, type Table } from "./metrics.js";
import { inWindow, label, periodsFor, type Window } from "./periods.js";

export const GSC_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
export const GSC_LAG_DAYS = 3;
export const GSC_ROW_LIMIT = 25_000;
/** Safety stop on rows read for one question. A question that would pass it is called too big and not used. */
export const GSC_ROW_CEILING = 200_000;

export interface GscRow { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }
export interface GscQuery { range: Window; dimensions: readonly string[] }
export type GscReader = (q: GscQuery) => Promise<{ rows: GscRow[]; truncated: boolean }>;

export function gscReader(f: FetchLike, token: string, site: string): GscReader {
  const url = `${GSC_BASE}/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  return async (q) => {
    const rows: GscRow[] = [];
    for (let start = 0; ; start += GSC_ROW_LIMIT) {
      const body = { startDate: q.range.start, endDate: q.range.end, dimensions: q.dimensions, rowLimit: GSC_ROW_LIMIT, startRow: start, dataState: "final" };
      const res = (await postJson(f, url, { Authorization: `Bearer ${token}` }, body, "Search Console query")) as { rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }> };
      const got = res.rows ?? [];
      for (const r of got) rows.push({ keys: (r.keys ?? []).map(String), clicks: Number(r.clicks ?? 0), impressions: Number(r.impressions ?? 0), ctr: Number(r.ctr ?? 0), position: Number(r.position ?? 0) });
      if (got.length < GSC_ROW_LIMIT) return { rows, truncated: false };
      if (rows.length >= GSC_ROW_CEILING) return { rows, truncated: true };
    }
  };
}

export interface SiteEntry { siteUrl: string; permissionLevel: string }

/** The properties the service account can see. Never writes. */
export async function listSites(f: FetchLike, token: string): Promise<SiteEntry[]> {
  const res = (await getJson(f, `${GSC_BASE}/sites`, { Authorization: `Bearer ${token}` }, "Search Console sites")) as { siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> };
  return (res.siteEntry ?? []).map((s) => ({ siteUrl: String(s.siteUrl ?? ""), permissionLevel: String(s.permissionLevel ?? "") }));
}

/** The property for a site address: the domain property when the account has it, else the URL-prefix property. Null when the account sees neither. */
export function pickProperty(sites: readonly SiteEntry[], host: string): SiteEntry | null {
  const bare = host.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();
  const usable = sites.filter((s) => s.permissionLevel !== "siteUnverifiedUser");
  return usable.find((s) => s.siteUrl.toLowerCase() === `sc-domain:${bare}`) ?? usable.find((s) => s.siteUrl.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") === bare) ?? null;
}

export { HttpError };

/* ───────────── aggregation ───────────── */

export interface Agg { clicks: number; impressions: number; posWeighted: number }
const emptyAgg = (): Agg => ({ clicks: 0, impressions: 0, posWeighted: 0 });
const addRow = (a: Agg, r: GscRow) => { a.clicks += r.clicks; a.impressions += r.impressions; a.posWeighted += r.position * r.impressions; };
export const ctrOf = (a: Agg) => ratio(a.clicks, a.impressions);
/** Average position as Search Console gives it: weighted by impressions. */
export const posOf = (a: Agg) => (a.impressions > 0 ? a.posWeighted / a.impressions : null);
const total = (rows: readonly GscRow[]): Agg => { const a = emptyAgg(); for (const r of rows) addRow(a, r); return a; };

export interface GscPeriods { current: Window; prior: Window; priorYear: Window }
export interface PeriodRead { available: boolean; reason: string | null; rows: Record<string, GscRow[]>; truncated: boolean }

export interface GscReading {
  property: string; permission: string; firstDay: string | null; lastDay: string | null;
  periods: GscPeriods; available: [boolean, boolean, boolean]; reasons: Array<string | null>;
  tables: Table[]; branded: { clicks: [number | null, number | null, number | null]; nonBranded: [number | null, number | null, number | null]; coverage: [number | null, number | null, number | null] };
  monthlyClicks: Map<string, number>;
  advisorSearchClicks: Array<{ advisor: string; clicks: number }>;
  notes: string[];
}

export function isBranded(query: string, brandTerms: readonly string[]): boolean {
  const q = query.toLowerCase();
  return brandTerms.some((t) => t && q.includes(t.toLowerCase()));
}

const fix = (n: number | null) => n;

export async function readGsc(read: GscReader, o: { property: string; permission: string; window: Window; today: string; cfg: AuditConfig; advisorSlugs: readonly string[] }): Promise<GscReading> {
  const p = periodsFor(o.window);
  const periods: GscPeriods = { current: p.current, prior: p.prior, priorYear: p.priorYear };
  const lastOk = addDays(o.today, -GSC_LAG_DAYS);
  // Daily series over a span a little longer than Search Console keeps (16 months), so its real first day is never cut by our own window, to find where its history starts and to cross-check by month.
  const span: Window = { start: addDays(o.today, -17 * 31), end: lastOk };
  const daily = await read({ range: span, dimensions: ["date"] });
  const days = daily.rows.map((r) => r.keys[0]!).sort();
  const firstDay = days[0] ?? null;
  const lastDay = days[days.length - 1] ?? null;
  const monthlyClicks = new Map<string, number>();
  for (const r of daily.rows) { const m = (r.keys[0] ?? "").slice(0, 7); monthlyClicks.set(m, (monthlyClicks.get(m) ?? 0) + r.clicks); }
  const ranges: Window[] = [periods.current, periods.prior, periods.priorYear];
  const available: [boolean, boolean, boolean] = [true, true, true];
  const reasons: Array<string | null> = [null, null, null];
  ranges.forEach((w, i) => {
    if (!firstDay) { available[i] = false; reasons[i] = "Search Console returned no days."; }
    else if (w.start < firstDay) { available[i] = false; reasons[i] = `Search Console history starts ${firstDay}, after the start of this period.`; }
    else if (w.end > lastOk) { available[i] = false; reasons[i] = `This period runs past the days Search Console has settled (${lastOk}).`; }
  });
  const dimsList: Array<[string, readonly string[]]> = [["page", ["page"]], ["query", ["query"]], ["device", ["device"]], ["country", ["country"]], ["date", ["date"]]];
  const reads: Array<Record<string, GscRow[]>> = [{}, {}, {}];
  let truncated = false;
  for (let i = 0; i < 3; i++) {
    if (!available[i]) continue;
    for (const [name, dims] of dimsList) {
      const res = await read({ range: ranges[i]!, dimensions: dims });
      if (res.truncated) truncated = true;
      reads[i]![name] = res.rows;
    }
  }
  const aggOf = (i: number, name: string) => (available[i] ? total(reads[i]![name] ?? []) : null);
  const rng = `${label(periods.current)} against ${label(periods.prior)} and ${label(periods.priorYear)}`;
  const names = ["Chosen window", "Period before", "Same dates a year earlier"];
  const dateAgg = [0, 1, 2].map((i) => aggOf(i, "date"));
  const overview = table({
    id: "gsc-overview", title: "Search Console: clicks, impressions, click-through rate and position", range: rng, filter: "all queries, all pages, all countries, all devices; Search Console data, not affected by automated visits",
    columns: [column("period", "Period", "confirmed from data", "text"), column("clicks", "Clicks", "confirmed from data"), column("impr", "Impressions", "confirmed from data"), column("ctr", "Click-through rate", "confirmed from data", "percent"), column("pos", "Average position", "confirmed from data", "position"), column("note", "Note", "confirmed from data", "text")],
    rows: [0, 1, 2].map((i) => { const a = dateAgg[i]; return { period: names[i]!, clicks: a?.clicks ?? null, impr: a?.impressions ?? null, ctr: a ? ctrOf(a) : null, pos: a ? posOf(a) : null, note: available[i] ? "" : reasons[i] }; }),
  });
  const tables: Table[] = [overview];
  // Query coverage and branded split.
  const brandedClicks: [number | null, number | null, number | null] = [null, null, null], nonBranded: [number | null, number | null, number | null] = [null, null, null], coverage: [number | null, number | null, number | null] = [null, null, null];
  for (let i = 0; i < 3; i++) {
    if (!available[i]) continue;
    let b = 0, nb = 0;
    for (const r of reads[i]!.query ?? []) (isBranded(r.keys[0] ?? "", o.cfg.brandTerms) ? (b += r.clicks) : (nb += r.clicks));
    brandedClicks[i] = b; nonBranded[i] = nb; coverage[i] = ratio(b + nb, dateAgg[i]?.clicks ?? null);
  }
  tables.push(table({
    id: "gsc-branded", title: "Branded and non-branded search clicks", range: rng, filter: `only clicks Search Console reports by query; branded means the search contains ${o.cfg.brandTerms.map((t) => `"${t}"`).join(" or ")}`,
    columns: [column("period", "Period", "confirmed from data", "text"), column("branded", "Branded clicks", "inference"), column("non", "Non-branded clicks", "inference"), column("cov", "Share of all clicks that carry a query", "confirmed from data", "percent"), column("chg", "Non-branded change on period before", "inference", "percent")],
    rows: [0, 1, 2].map((i) => ({ period: names[i]!, branded: brandedClicks[i], non: nonBranded[i], cov: coverage[i], chg: i === 0 ? change(nonBranded[0], nonBranded[1]) : null })),
    note: "Search Console leaves out searches it anonymises, so these two columns together are only part of all clicks. The share is shown so the gap is not hidden.",
  }));
  // By page group and by advisor.
  const groupAgg = (i: number) => { const m = new Map<string, Agg>(); for (const r of reads[i]!.page ?? []) { const g = classifyPath(new URL(r.keys[0] ?? "https://x/", "https://x").pathname, o.cfg).group; const a = m.get(g) ?? emptyAgg(); addRow(a, r); m.set(g, a); } return m; };
  if (available[0]) {
    const g0 = groupAgg(0), g1 = available[1] ? groupAgg(1) : null;
    tables.push(table({
      id: "gsc-groups", title: "Search clicks by page group", range: `${label(periods.current)} against ${label(periods.prior)}`, filter: "page group is our classification of the page address",
      columns: [column("group", "Page group", "inference", "text"), column("clicks", "Clicks", "confirmed from data"), column("impr", "Impressions", "confirmed from data"), column("ctr", "Click-through rate", "confirmed from data", "percent"), column("pos", "Average position", "confirmed from data", "position"), column("prior", "Clicks, period before", "confirmed from data"), column("chg", "Change", "confirmed from data", "percent")],
      rows: [...g0.entries()].sort((a, b) => b[1].clicks - a[1].clicks).map(([k, a]) => ({ group: k, clicks: a.clicks, impr: a.impressions, ctr: ctrOf(a), pos: posOf(a), prior: g1?.get(k)?.clicks ?? null, chg: g1 ? change(a.clicks, g1.get(k)?.clicks ?? null) : null })),
    }));
    const adv = new Map<string, Agg>();
    for (const r of reads[0]!.page ?? []) { const s = advisorSlug(new URL(r.keys[0] ?? "https://x/", "https://x").pathname, o.cfg); if (!s) continue; const a = adv.get(s) ?? emptyAgg(); addRow(a, r); adv.set(s, a); }
    tables.push(table({
      id: "gsc-advisors", title: "Search clicks by advisor page (top 10)", range: label(periods.current), filter: "advisor microsite pages only; the directory and homepage are not included",
      columns: [column("advisor", "Advisor", "confirmed from data", "text"), column("clicks", "Clicks", "confirmed from data"), column("impr", "Impressions", "confirmed from data"), column("ctr", "Click-through rate", "confirmed from data", "percent"), column("pos", "Average position", "confirmed from data", "position")],
      rows: [...adv.entries()].sort((a, b) => b[1].clicks - a[1].clicks).slice(0, 10).map(([s, a]) => ({ advisor: advisorName(s), clicks: a.clicks, impr: a.impressions, ctr: ctrOf(a), pos: posOf(a) })),
    }));
  }
  // Device and country.
  for (const [name, title, cols] of [["device", "Search clicks by device", "Device"], ["country", "Search clicks by country (top 10)", "Country"]] as const) {
    if (!available[0]) continue;
    const mk = (i: number) => { const m = new Map<string, Agg>(); for (const r of reads[i]![name] ?? []) { const a = m.get(r.keys[0] ?? "") ?? emptyAgg(); addRow(a, r); m.set(r.keys[0] ?? "", a); } return m; };
    const c0 = mk(0), c1 = available[1] ? mk(1) : null;
    tables.push(table({
      id: `gsc-${name}`, title, range: `${label(periods.current)} against ${label(periods.prior)}`, filter: "all queries and pages",
      columns: [column("key", cols, "confirmed from data", "text"), column("clicks", "Clicks", "confirmed from data"), column("impr", "Impressions", "confirmed from data"), column("ctr", "Click-through rate", "confirmed from data", "percent"), column("pos", "Average position", "confirmed from data", "position"), column("prior", "Clicks, period before", "confirmed from data")],
      rows: [...c0.entries()].sort((a, b) => b[1].clicks - a[1].clicks).slice(0, name === "country" ? 10 : 5).map(([k, a]) => ({ key: k, clicks: a.clicks, impr: a.impressions, ctr: ctrOf(a), pos: posOf(a), prior: c1?.get(k)?.clicks ?? null })),
    }));
  }
  // Searches that name an advisor.
  const advisorSearch: Array<{ advisor: string; clicks: number }> = [];
  if (available[0]) {
    const words = o.advisorSlugs.map((s) => ({ s, w: s.split("-").filter((x) => x.length > 1) })).filter((x) => x.w.length >= 2);
    const by = new Map<string, number>();
    for (const r of reads[0]!.query ?? []) { const q = (r.keys[0] ?? "").toLowerCase(); for (const a of words) if (a.w.every((x) => q.includes(x))) by.set(a.s, (by.get(a.s) ?? 0) + r.clicks); }
    for (const [s, c] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) advisorSearch.push({ advisor: advisorName(s), clicks: c });
    tables.push(table({
      id: "gsc-advisor-names", title: "Searches that contain an advisor's name", range: label(periods.current), filter: "queries that contain every word of an advisor's name taken from their page address; only queries Search Console reports",
      columns: [column("advisor", "Advisor", "inference", "text"), column("clicks", "Clicks from searches with their name", "confirmed from data")],
      rows: advisorSearch.map((a) => ({ advisor: a.advisor, clicks: a.clicks })),
      note: "A name search that did not reach an advisor page is not visible here.",
    }));
  }
  const notes = [
    `Search Console history starts ${firstDay ?? "(no days returned)"}. ${reasons.filter(Boolean).join(" ")}`.trim(),
    coverage[0] != null ? `Searches Search Console reports by query cover ${(coverage[0]! * 100).toFixed(0)}% of all clicks in the chosen window. The rest are anonymised and cannot be split by query.` : "Query coverage could not be worked out.",
    "AI Overviews may take some clicks from classic results. Nothing in this data measures that, so it is a possibility and nothing more.",
    ...(truncated ? ["At least one Search Console question hit the row ceiling, so some lists are partial."] : []),
  ];
  return { property: o.property, permission: o.permission, firstDay, lastDay, periods, available, reasons, tables, branded: { clicks: brandedClicks, nonBranded, coverage }, monthlyClicks, advisorSearchClicks: advisorSearch, notes: notes.map(fix as never) as string[] };
}

export { inWindow };

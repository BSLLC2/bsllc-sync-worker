/**
 * The audit's printing. PURE: structured findings in, markdown out. Prints
 * counts, names of events, channels, campaigns and conversion actions, and money
 * totals only; the types here have no field that could hold a person.
 */
import {
  AUDIT_KEYS, centsToDollars, howCalculated, microsToDollars,
  type Flag, type Pick, type Reading,
} from "./headline.js";
import type { ConvAction, ConvSetting, DailyCoverage } from "./db.js";
import type { Ga4Out, MetaOut } from "./live.js";

const usd = (d: number): string => `$${d.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: d % 1 ? 2 : 0 })}`;

/** One stored value in words, in the unit its key declares. null is "not stored", never zero. */
export function formatValue(unit: "micros" | "cents" | "dollars" | "count" | "ratio", v: number | null): string {
  if (v == null) return "not stored";
  if (unit === "micros") return usd(microsToDollars(v));
  if (unit === "cents") return usd(centsToDollars(v));
  if (unit === "dollars") return usd(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** The daily record against the monthly snapshot for one month's spend. A difference over 5% is worth reading. */
export function dailyDiffers(snapMicros: number | null, dailyMicros: number | null): string | null {
  if (snapMicros == null || dailyMicros == null) return null;
  const hi = Math.max(snapMicros, dailyMicros);
  if (hi === 0 || Math.abs(snapMicros - dailyMicros) / hi <= 0.05) return null;
  return `The daily ad record sums to ${usd(microsToDollars(dailyMicros))} but the monthly snapshot stores ${usd(microsToDollars(snapMicros))}. They were written by two different jobs; find out which window each covers.`;
}

export interface MonthAudit {
  ym: string;
  inProgress: boolean;
  stored: Array<{ source: string; metricKey: string; unit: "micros" | "cents" | "dollars" | "count" | "ratio"; value: number | null; state: string }>;
  rollingIgnored: number;
  conversions: Pick;
  revenue: Pick;
  flags: Flag[];
  dailySpendMicros: number | null;
  dailyNote: string | null;
  spendMicros: number | null;
  roas: string[];
}

export interface ClientAudit {
  name: string;
  months: MonthAudit[];
  daily: { stored: boolean; scans: DailyCoverage[] };
  convActions: { stored: boolean; rows: ConvAction[]; windowStart: string | null; windowEnd: string | null };
  convSettings: { stored: boolean; rows: ConvSetting[] };
  ga4: { skipped: string } | { window: { start: string; end: string }; out: Ga4Out };
  meta: { skipped: string } | { window: { start: string; end: string }; out: MetaOut };
  notes: string[];
}

export function storedRows(byKey: ReadonlyMap<string, Reading>): MonthAudit["stored"] {
  const out: MonthAudit["stored"] = [];
  for (const k of AUDIT_KEYS) {
    const r = byKey.get(`${k.source}:${k.metricKey}`);
    if (r) out.push({ source: k.source, metricKey: k.metricKey, unit: k.unit, value: r.value, state: r.dataState });
  }
  return out;
}

const tableRow = (cells: Array<string | number>): string => `| ${cells.join(" | ")} |`;
const orNR = (v: number | null): string | number => (v == null ? "not returned" : v);

export function renderMarkdown(audits: readonly ClientAudit[], meta: { generatedOn: string; sinceYm: string }): string {
  const L: string[] = [];
  L.push(`# Conversions and dollars audit`, ``, `Generated ${meta.generatedOn}. Months from ${meta.sinceYm}. READ-ONLY: nothing was written anywhere.`);
  L.push(``, `Money units: ads.cost_micros and ads.cost_per_conversion are micros; ads.conversion_value and meta.conversion_value are account-currency dollars; keys ending _cents are cents. "not stored" is unanswered, never zero. Compare each figure with the platform by eye.`);
  for (const a of audits) {
    L.push(``, `## ${a.name}`);
    for (const n of a.notes) L.push(`- ${n}`);
    L.push(``, `### What the OS stores, month by month`);
    for (const m of a.months) {
      L.push(``, `#### ${m.ym}${m.inProgress ? " (month so far, not final)" : ""}`);
      if (m.stored.length === 0) L.push(`Nothing stored for this month under the keys this audit reads.`);
      else {
        L.push(tableRow(["metric key", "source", "stored value", "state"]), tableRow(["---", "---", "---", "---"]));
        for (const s of m.stored) L.push(tableRow([s.metricKey, s.source, formatValue(s.unit, s.value), s.state]));
      }
      if (m.rollingIgnored) L.push(``, `${m.rollingIgnored} rolling-window row(s) for this month were set aside (they do not cover a calendar month).`);
      if (m.dailySpendMicros != null) L.push(``, `Daily ad record for this month: spend ${usd(microsToDollars(m.dailySpendMicros))}.${m.dailyNote ? ` ${m.dailyNote}` : ""}`);
      L.push(``, `How the tiles are calculated:`, `- ${howCalculated("conversions", m.conversions, m.spendMicros === 0)}`, `- ${howCalculated("revenue", m.revenue, m.spendMicros === 0)}`);
      for (const r of m.roas) L.push(`- ${r}`);
      if (m.flags.length) { L.push(``, `Flags:`); for (const f of m.flags) L.push(`- ${f.text}`); }
    }
    L.push(``, `### Ads daily record (coverage)`);
    if (!a.daily.stored) L.push(`not stored (the daily ads tables are not in this database).`);
    else if (a.daily.scans.length === 0) L.push(`No scan on record for this client.`);
    else for (const s of a.daily.scans) L.push(`- ${s.platform} ${s.accountId}: ${s.from} to ${s.to}, ${s.ok ? "last read ok" : "LAST READ FAILED"}, ${s.rows} rows, read ${s.at.slice(0, 10)}.`);
    L.push(``, `### Conversion actions (last stored 30-day window)`);
    if (!a.convActions.stored) L.push(`not stored.`);
    else if (a.convActions.rows.length === 0) L.push(`No rows stored.`);
    else {
      const set = new Map(a.convSettings.rows.map((r) => [(r.name ?? "").toLowerCase(), r]));
      L.push(`Window ${a.convActions.windowStart} to ${a.convActions.windowEnd}.`, tableRow(["conversion action", "category", "primary", "counted in Conversions", "conversions", "value (dollars)", "all conversions"]), tableRow(["---", "---", "---", "---", "---", "---", "---"]));
      const byAction = new Map<string, { conversions: number; value: number; all: number }>();
      for (const r of a.convActions.rows) { const c = byAction.get(r.action) ?? { conversions: 0, value: 0, all: 0 }; c.conversions += r.conversions; c.value += r.value; c.all += r.all; byAction.set(r.action, c); }
      for (const [name, c] of byAction) {
        const s = set.get(name.toLowerCase());
        L.push(tableRow([name, s?.category ?? "not stored", s?.primary == null ? "not stored" : s.primary ? "primary" : "secondary", s?.included == null ? "not stored" : s.included ? "yes" : "no", Math.round(c.conversions * 100) / 100, usd(c.value), Math.round(c.all * 100) / 100]));
      }
    }
    L.push(``, `### Google Analytics 4 (live read)`);
    if ("skipped" in a.ga4) L.push(`Skipped: ${a.ga4.skipped}`);
    else {
      L.push(`Window ${a.ga4.window.start} to ${a.ga4.window.end}.`);
      if (a.ga4.out.eventsNote) L.push(a.ga4.out.eventsNote);
      if (a.ga4.out.events.length) {
        L.push(tableRow(["event name", "event count", "key event"]), tableRow(["---", "---", "---"]));
        for (const e of a.ga4.out.events.slice(0, 60)) L.push(tableRow([e.name, orNR(e.count), e.keyEvent == null ? "unknown" : e.keyEvent ? "yes" : "no"]));
      }
      if (a.ga4.out.channelsNote) L.push(a.ga4.out.channelsNote);
      if (a.ga4.out.channels.length) {
        L.push(``, tableRow(["channel group", "sessions", "key events", "purchase revenue", "total revenue", "purchases"]), tableRow(["---", "---", "---", "---", "---", "---"]));
        for (const c of a.ga4.out.channels) L.push(tableRow([c.channel, orNR(c.sessions), orNR(c.keyEvents), c.purchaseRevenue == null ? "not returned" : usd(c.purchaseRevenue), c.totalRevenue == null ? "not returned" : usd(c.totalRevenue), orNR(c.purchases)]));
      }
    }
    L.push(``, `### Meta (live read)`);
    if ("skipped" in a.meta) L.push(`Skipped: ${a.meta.skipped}`);
    else {
      L.push(`Window ${a.meta.window.start} to ${a.meta.window.end}.`);
      if (a.meta.out.note) L.push(a.meta.out.note);
      for (const c of a.meta.out.campaigns) {
        L.push(``, `**${c.campaign}** (objective ${c.objective ?? "not returned"}; attribution setting ${c.attributionSetting ?? "not returned"}): spend ${c.spendMicros == null ? "not returned" : usd(microsToDollars(c.spendMicros))}, link clicks ${c.linkClicks ?? "not returned"}. The OS would count ${c.osConversions ?? "no countable"} conversion(s) and ${c.osConversionValueDollars == null ? "no" : usd(c.osConversionValueDollars)} conversion value.`);
        const win = (x: { byWindow: Record<string, number> }) => (Object.keys(x.byWindow).length ? ` (${Object.entries(x.byWindow).map(([w, v]) => `${w} ${v}`).join(", ")})` : "");
        if (c.actions.length) { L.push(`Actions by type (windows asked: 1d_click, 7d_click, 1d_view):`); for (const x of c.actions) L.push(`- ${x.actionType}: ${x.value ?? "n/a"}${win(x)}`); }
        if (c.actionValues.length) { L.push(`Action values by type:`); for (const x of c.actionValues) L.push(`- ${x.actionType}: ${x.value ?? "n/a"}${win(x)}`); }
      }
    }
  }
  return L.join("\n") + "\n";
}

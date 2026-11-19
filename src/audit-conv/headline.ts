/**
 * How the dashboard's two headline tiles (Conversions and Revenue) pick their
 * figure, copied so the audit can show which stored figure each month's tile
 * would read. PURE: no network, no database, no clock.
 *
 * THE SOURCE OF TRUTH IS THE DASHBOARD REPO: `HEADLINE_SNAPSHOT_METRICS` in
 * bsllc-account-health/shared/schema.ts (about line 13326) and the revenue
 * summing branch in `getSnapshotTiles` (server/storage.ts, about line 9996).
 * The repos cannot import from each other, so the ORDER below is a copy. If
 * the dashboard's order changes, change it here in the same pass.
 *
 * Rules copied from there:
 *  - The first candidate that is live with a non-null value wins. A manual
 *    candidate always beats an automated one.
 *  - Revenue only: when the winner is not manual and two or more DIFFERENT
 *    sources are each live (each source contributes its own first live
 *    candidate), the tile shows their SUM, labelled context, not ad revenue.
 *
 * UNITS: ads.cost_micros is micros; ads.conversion_value and meta.conversion_value
 * are account-currency dollars; keys ending _cents are cents. A null is
 * unanswered, never zero.
 */

export interface Candidate { source: string; metricKey: string }

/** COPY of HEADLINE_SNAPSHOT_METRICS[revenue].candidates (shared/schema.ts). */
export const HEADLINE_REVENUE: readonly Candidate[] = [
  { source: "manual", metricKey: "manual.revenue_confirmed_cents" },
  { source: "manual", metricKey: "manual.revenue_system_cents" },
  { source: "manual", metricKey: "manual.revenue_cents" },
  { source: "d365", metricKey: "d365.cw_revenue_bsllc_cents" },
  { source: "d365", metricKey: "d365.revenue_cents" },
  { source: "hubspot", metricKey: "hubspot.cw_revenue_bsllc_cents" },
  { source: "hubspot", metricKey: "hubspot.revenue_cents" },
  { source: "ga4", metricKey: "ga4.revenue_cents" },
  { source: "square", metricKey: "square.revenue_cents" },
];

/** COPY of HEADLINE_SNAPSHOT_METRICS[conversions].candidates (shared/schema.ts). */
export const HEADLINE_CONVERSIONS: readonly Candidate[] = [
  { source: "manual", metricKey: "manual.admissions_marketing" },
  { source: "manual", metricKey: "manual.leads" },
  { source: "google_ads", metricKey: "ads.verified_conversions" },
  { source: "google_ads", metricKey: "ads.conversions" },
  { source: "hubspot", metricKey: "hubspot.leads" },
  { source: "ga4", metricKey: "ga4.conversions" },
  { source: "meta", metricKey: "meta.conversions" },
];

/** Every key the audit prints, with the source it is stored under and its unit. */
export const AUDIT_KEYS: ReadonlyArray<{ source: string; metricKey: string; unit: "micros" | "cents" | "dollars" | "count" | "ratio" }> = [
  { source: "google_ads", metricKey: "ads.cost_micros", unit: "micros" },
  { source: "google_ads", metricKey: "ads.clicks", unit: "count" },
  { source: "google_ads", metricKey: "ads.conversions", unit: "count" },
  { source: "google_ads", metricKey: "ads.verified_conversions", unit: "count" },
  { source: "google_ads", metricKey: "ads.conversion_value", unit: "dollars" },
  { source: "google_ads", metricKey: "ads.cost_per_conversion", unit: "micros" },
  { source: "ga4", metricKey: "ga4.conversions", unit: "count" },
  { source: "ga4", metricKey: "ga4.revenue_cents", unit: "cents" },
  { source: "square", metricKey: "square.revenue_cents", unit: "cents" },
  { source: "hubspot", metricKey: "hubspot.revenue_cents", unit: "cents" },
  { source: "hubspot", metricKey: "hubspot.cw_revenue_bsllc_cents", unit: "cents" },
  { source: "d365", metricKey: "d365.revenue_cents", unit: "cents" },
  { source: "d365", metricKey: "d365.cw_revenue_bsllc_cents", unit: "cents" },
  { source: "manual", metricKey: "manual.revenue_confirmed_cents", unit: "cents" },
  { source: "manual", metricKey: "manual.revenue_system_cents", unit: "cents" },
  { source: "manual", metricKey: "manual.revenue_cents", unit: "cents" },
  { source: "manual", metricKey: "manual.leads", unit: "count" },
  { source: "manual", metricKey: "manual.admissions_marketing", unit: "count" },
  { source: "meta", metricKey: "meta.cost_micros", unit: "micros" },
  { source: "meta", metricKey: "meta.clicks", unit: "count" },
  { source: "meta", metricKey: "meta.conversions", unit: "count" },
  { source: "meta", metricKey: "meta.conversion_value", unit: "dollars" },
  { source: "hubspot", metricKey: "hubspot.leads", unit: "count" },
];

export interface Reading {
  source: string;
  metricKey: string;
  /** null is unanswered, never zero. */
  value: number | null;
  dataState: string;
  periodStart: string | null;
  periodEnd: string | null;
  syncedAt: string;
}

const isLive = (r: Reading | undefined): r is Reading => !!r && r.dataState === "live" && r.value != null;

/** YYYY-MM of a stored period start, read in UTC after a 12 hour nudge so a midnight in a US zone lands on its own day. */
export function ymOf(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t + 12 * 3600_000).toISOString().slice(0, 7);
}

/** Days a stored period spans (inclusive), or null when either end is missing. */
export function spanDays(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start), b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** A row is a calendar-month row when it starts on the 1st and spans no more than a month. Anything else is a rolling window. */
export function isMonthRow(r: Reading): boolean {
  const start = r.periodStart ? new Date(Date.parse(r.periodStart) + 12 * 3600_000) : null;
  const span = spanDays(r.periodStart, r.periodEnd);
  return !!start && start.getUTCDate() === 1 && span != null && span <= 32;
}

/** For one month: the newest-synced calendar-month row of every key. Rolling rows are counted and left out. */
export function monthReadings(all: readonly Reading[], ym: string): { byKey: Map<string, Reading>; rollingIgnored: number } {
  const byKey = new Map<string, Reading>();
  let rollingIgnored = 0;
  for (const r of all) {
    if (ymOf(r.periodStart) !== ym) continue;
    if (!isMonthRow(r)) { rollingIgnored++; continue; }
    const k = `${r.source}:${r.metricKey}`;
    const cur = byKey.get(k);
    if (!cur || Date.parse(r.syncedAt) > Date.parse(cur.syncedAt)) byKey.set(k, r);
  }
  return { byKey, rollingIgnored };
}

export interface Pick {
  chosen: Reading | null;
  /** Revenue only: the 2+ sources the tile adds together. Empty when it is a single figure. */
  summed: Reading[];
  /** What the tile would print, in the key's own unit (cents for revenue). null when nothing is live. */
  value: number | null;
}

/** Which stored figure the tile reads this month. */
export function pickHeadline(kind: "revenue" | "conversions", byKey: ReadonlyMap<string, Reading>): Pick {
  const cands = kind === "revenue" ? HEADLINE_REVENUE : HEADLINE_CONVERSIONS;
  let chosen: Reading | null = null;
  for (const c of cands) {
    const hit = byKey.get(`${c.source}:${c.metricKey}`);
    if (isLive(hit)) { chosen = hit; break; }
  }
  if (!chosen) return { chosen: null, summed: [], value: null };
  if (kind === "revenue" && chosen.source !== "manual") {
    const seen = new Set<string>();
    const parts: Reading[] = [];
    for (const c of cands) {
      if (c.source === "manual" || seen.has(c.source)) continue;
      const hit = byKey.get(`${c.source}:${c.metricKey}`);
      if (!isLive(hit)) continue;
      seen.add(c.source);
      parts.push(hit);
    }
    if (parts.length > 1) return { chosen, summed: parts, value: parts.reduce((s, r) => s + (r.value as number), 0) };
  }
  return { chosen, summed: [], value: chosen.value };
}

export const AD_SOURCES = new Set(["google_ads", "meta"]);

export type FlagKind =
  | "conversions_not_from_ads"
  | "conversions_not_from_ads_ads_off"
  | "revenue_summed"
  | "revenue_while_ads_off"
  | "clicks_without_conversions"
  | "cost_per_conversion_differs"
  | "daily_record_differs";

export interface Flag { kind: FlagKind; text: string }

const num = (m: ReadonlyMap<string, Reading>, k: string): number | null => {
  const r = [...m.values()].find((x) => x.metricKey === k);
  return isLive(r) ? (r.value as number) : null;
};

/** The micros-to-dollars conversion, written once. */
export const microsToDollars = (v: number): number => v / 1_000_000;
export const centsToDollars = (v: number): number => v / 100;

const money = (d: number): string => `$${d.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: d % 1 ? 2 : 0 })}`;

export interface MonthInput {
  ym: string;
  byKey: ReadonlyMap<string, Reading>;
  /** True when any ad-platform figure is stored for the client in the range. */
  clientHasAds: boolean;
}

export function flagsForMonth(m: MonthInput): { conversions: Pick; revenue: Pick; flags: Flag[]; spendDollars: number | null } {
  const conversions = pickHeadline("conversions", m.byKey);
  const revenue = pickHeadline("revenue", m.byKey);
  const flags: Flag[] = [];
  const gSpend = num(m.byKey, "ads.cost_micros");
  const mSpend = num(m.byKey, "meta.cost_micros");
  const spendMicros = gSpend == null && mSpend == null ? null : (gSpend ?? 0) + (mSpend ?? 0);
  const spendDollars = spendMicros == null ? null : microsToDollars(spendMicros);
  const adsOff = spendMicros === 0;

  // Conversions tile chosen from a non-ad source while ads exist for this client.
  if (conversions.chosen && !AD_SOURCES.has(conversions.chosen.source) && m.clientHasAds) {
    const label = `${conversions.chosen.metricKey} (${conversions.chosen.source})`;
    if (adsOff) {
      flags.push({ kind: "conversions_not_from_ads_ads_off", text: `Ad spend is $0 this month, yet the Conversions tile shows ${conversions.value} from ${label}. That figure cannot be ad results.` });
    } else {
      flags.push({ kind: "conversions_not_from_ads", text: `The Conversions tile shows ${conversions.value} from ${label}, not from an ad platform, while ads ran${spendDollars != null ? ` (${money(spendDollars)} spent)` : ""}.` });
    }
  }
  if (revenue.summed.length > 1) {
    const parts = revenue.summed.map((r) => `${r.metricKey} ${money(centsToDollars(r.value as number))}`).join(" + ");
    flags.push({ kind: "revenue_summed", text: `The Revenue tile adds ${revenue.summed.length} sources: ${parts} = ${money(centsToDollars(revenue.value as number))}. Context, not ad revenue.` });
  }
  if (adsOff && revenue.value != null && revenue.value > 0) {
    flags.push({ kind: "revenue_while_ads_off", text: `Ad spend is $0 yet the Revenue tile reads ${money(centsToDollars(revenue.value))}. Whatever drives it is not these ads.` });
  }
  // Clicks with no conversions: possible broken tracking.
  for (const [click, conv, name] of [["ads.clicks", "ads.conversions", "Google Ads"], ["meta.clicks", "meta.conversions", "Meta"]] as const) {
    const clicks = num(m.byKey, click);
    if (clicks != null && clicks > 0) {
      const c = num(m.byKey, conv);
      if (c == null || c === 0) {
        flags.push({ kind: "clicks_without_conversions", text: `${name} recorded ${clicks} clicks and ${c == null ? "no conversion figure at all" : "0 conversions"}. That can be broken conversion tracking or a window with no sales; check before reading it as no results.` });
      }
    }
  }
  // Stored cost per conversion against spend divided by conversions.
  const cpc = num(m.byKey, "ads.cost_per_conversion");
  const gConv = num(m.byKey, "ads.conversions");
  if (cpc != null && gSpend != null && gConv != null && gConv > 0) {
    const derived = gSpend / gConv;
    if (Math.abs(derived - cpc) / Math.max(derived, 1) > 0.1) {
      flags.push({ kind: "cost_per_conversion_differs", text: `Stored cost per conversion is ${money(microsToDollars(cpc))} but spend divided by stored conversions is ${money(microsToDollars(derived))}. The two were not computed from the same conversion set or period.` });
    }
  }
  return { conversions, revenue, flags, spendDollars };
}

/** The "how this figure is calculated" sentences, one per tile. Plain words. */
export function howCalculated(kind: "revenue" | "conversions", p: Pick, adsOff: boolean): string {
  if (!p.chosen) return kind === "revenue"
    ? "Revenue tile: nothing live is stored for this month, so the tile is empty."
    : "Conversions tile: nothing live is stored for this month, so the tile is empty.";
  if (kind === "conversions") {
    const k = p.chosen.metricKey;
    const why = k.startsWith("ads.") || k.startsWith("meta.")
      ? "an ad platform's own count"
      : k.startsWith("ga4.") ? "GA4 key events, counted across the whole site, not only ad visits"
      : k.startsWith("hubspot.") ? "CRM leads"
      : "a figure typed or imported by hand";
    const earlier = adsOff && !AD_SOURCES.has(p.chosen.source) ? " No ad conversions were stored for this month, so the tile fell through to the next source." : "";
    return `Conversions tile = ${k} (${p.chosen.source}): ${why}.${earlier}`;
  }
  if (p.summed.length > 1) {
    return `Revenue tile = ${p.summed.map((r) => r.metricKey).join(" + ")} (summed, labelled context, NOT ad revenue).`;
  }
  const k = p.chosen.metricKey;
  const kind2 = k.startsWith("manual.") ? "a figure a person typed or the client's own sheet"
    : k.includes("cw_revenue_bsllc") ? "CRM revenue the dashboard attributes to our channels"
    : "the whole business's figure from that system, not only what ads drove";
  return `Revenue tile = ${k} (${p.chosen.source}): ${kind2}.`;
}

/** ROAS only where spend and conversion value exist for the SAME platform and period. Platform-reported. */
export function roasLine(platform: "google_ads" | "meta", byKey: ReadonlyMap<string, Reading>): string | null {
  const costK = platform === "google_ads" ? "ads.cost_micros" : "meta.cost_micros";
  const valK = platform === "google_ads" ? "ads.conversion_value" : "meta.conversion_value";
  const cost = num(byKey, costK), val = num(byKey, valK);
  if (cost == null || val == null || cost <= 0) return null;
  const spend = microsToDollars(cost);
  return `${platform === "google_ads" ? "Google Ads" : "Meta"} reported ${money(val)} conversion value on ${money(spend)} spend = ${(val / spend).toFixed(2)}x (platform-reported, not revenue).`;
}

/** Calendar months from `from` (YYYY-MM) to the month containing `todayYmd`, inclusive. */
export function monthsBetween(from: string, todayYmd: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = todayYmd.slice(0, 7).split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * The audit's optional LIVE reads. Each is skipped with a clear line when its
 * credential is absent, and a failure of one never stops the others.
 *
 * READ-ONLY. Meta is a GET to the Graph API. The Google Analytics Data API's
 * `runReport` is a POST by design (the question is the body); it reads, it never
 * writes, and it goes through the same helper every other GA4 reader here uses
 * (`postAll` in ../ga4-report/ga4.ts), so this file builds no POST of its own and
 * opens no second auth path.
 *
 * EVERY REQUEST SHAPE HERE WAS WRITTEN FROM DOCUMENTATION AND HAS NOT BEEN RUN
 * AGAINST A LIVE ACCOUNT. docs/AUDIT-CONVERSIONS-DOLLARS.md lists them.
 *
 * Nothing printed carries a person: event names, channel names, campaign names,
 * action types and money totals only.
 */
import { postAll, type Io } from "../ga4-report/ga4.js";
import { HttpError, getJson, safeMessage } from "../page-behaviour/http.js";
import type { FetchLike } from "../ga4-report/types.js";
import {
  META_GRAPH, countMetaConversions, metaSpendToMicros, sumMetaActionValues,
} from "../meta/insights.js";

export interface GaRowsOut { dims: string[]; m: Record<string, number | null> }
const n = (v: string | undefined): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function parse(report: { dimensionHeaders?: Array<{ name?: string }>; metricHeaders?: Array<{ name?: string }>; rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }> }): GaRowsOut[] {
  const metricNames = (report.metricHeaders ?? []).map((h) => String(h.name ?? ""));
  return (report.rows ?? []).map((r) => {
    const m: Record<string, number | null> = {};
    metricNames.forEach((name, i) => { m[name] = n(r.metricValues?.[i]?.value); });
    return { dims: (r.dimensionValues ?? []).map((d) => String(d.value ?? "")), m };
  });
}

/** Tries each rung of a metric or dimension ladder; only a 400 moves down (a property that does not know a field). */
async function ladder<T>(rungs: ReadonlyArray<() => Promise<T>>): Promise<{ value: T; rung: number }> {
  let last: unknown = null;
  for (let i = 0; i < rungs.length; i++) {
    try { return { value: await rungs[i]!(), rung: i }; }
    catch (e) { last = e; if (!(e instanceof HttpError) || e.status !== 400) throw e; }
  }
  throw last;
}

export interface Ga4Out {
  events: Array<{ name: string; count: number | null; keyEvent: boolean | null }>;
  eventsNote: string | null;
  channels: Array<{ channel: string; sessions: number | null; keyEvents: number | null; purchaseRevenue: number | null; totalRevenue: number | null; purchases: number | null }>;
  channelsNote: string | null;
}

/** Event names with counts and the key-event flag, and revenue by channel group, for one window. */
export async function readGa4(io: Io, win: { start: string; end: string }): Promise<Ga4Out> {
  const dateRanges = [{ startDate: win.start, endDate: win.end }];
  const out: Ga4Out = { events: [], eventsNote: null, channels: [], channelsNote: null };
  try {
    const { value, rung } = await ladder([
      async () => ({ withFlag: true, p: await postAll(io, { dateRanges, dimensions: [{ name: "eventName" }, { name: "isKeyEvent" }], metrics: [{ name: "eventCount" }], orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], keepEmptyRows: false }, "ga4 events") }),
      async () => ({ withFlag: false, p: await postAll(io, { dateRanges, dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], keepEmptyRows: false }, "ga4 events") }),
    ]);
    out.events = parse(value.p.report).map((r) => ({ name: r.dims[0] ?? "", count: r.m.eventCount ?? null, keyEvent: value.withFlag ? (r.dims[1] === "true" ? true : r.dims[1] === "false" ? false : null) : null }));
    out.eventsNote = value.p.truncated ? "The event list was cut at the row ceiling." : rung === 1 ? "This property did not accept the key-event flag, so key events are not marked." : null;
  } catch (e) { out.eventsNote = `Events could not be read: ${safeMessage(e)}`; }
  try {
    const sets: ReadonlyArray<readonly string[]> = [
      ["sessions", "keyEvents", "purchaseRevenue", "totalRevenue", "ecommercePurchases"],
      ["sessions", "keyEvents", "totalRevenue"],
      ["sessions", "conversions", "totalRevenue"],
      ["sessions"],
    ];
    const { value, rung } = await ladder(sets.map((ms) => async () => ({ ms, p: await postAll(io, { dateRanges, dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: ms.map((name) => ({ name })), keepEmptyRows: false }, "ga4 channels") })));
    out.channels = parse(value.p.report).map((r) => ({ channel: r.dims[0] ?? "", sessions: r.m.sessions ?? null, keyEvents: r.m.keyEvents ?? r.m.conversions ?? null, purchaseRevenue: r.m.purchaseRevenue ?? null, totalRevenue: r.m.totalRevenue ?? null, purchases: r.m.ecommercePurchases ?? null }));
    out.channelsNote = value.p.truncated ? "The channel list was cut at the row ceiling." : rung > 0 ? `This property rejected some revenue metrics; the report used: ${value.ms.join(", ")}. A blank column is "not returned", never zero.` : null;
  } catch (e) { out.channelsNote = `Channels could not be read: ${safeMessage(e)}`; }
  return out;
}

/* ───────────────────────── Meta ───────────────────────── */

export const META_AUDIT_FIELDS = "campaign_name,objective,spend,impressions,inline_link_clicks,actions,action_values,attribution_setting";
/** The windows asked for, so each action type reports its own figure under each window. */
export const META_ATTRIBUTION_WINDOWS = ["1d_click", "7d_click", "1d_view"] as const;

export interface MetaActionLine { actionType: string; value: number | null; byWindow: Record<string, number> }
export interface MetaCampaignOut {
  campaign: string; objective: string | null; attributionSetting: string | null;
  spendMicros: number | null; impressions: number | null; linkClicks: number | null;
  actions: MetaActionLine[]; actionValues: MetaActionLine[];
  osConversions: number | null; osConversionValueDollars: number | null;
}
export interface MetaOut { campaigns: MetaCampaignOut[]; note: string | null }

function lines(raw: unknown): MetaActionLine[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((a: Record<string, unknown>) => {
    const byWindow: Record<string, number> = {};
    for (const w of META_ATTRIBUTION_WINDOWS) { const v = Number(a[w]); if (a[w] != null && Number.isFinite(v)) byWindow[w] = v; }
    const v = Number(a.value);
    return { actionType: String(a.action_type ?? ""), value: a.value != null && Number.isFinite(v) ? v : null, byWindow };
  }).filter((l) => l.actionType);
}

/** Per campaign for the window: spend, objective, and every action and action value by type, per attribution window. GET only. */
export async function readMeta(f: FetchLike, token: string, act: string, win: { start: string; end: string }): Promise<MetaOut> {
  const qs = new URLSearchParams({
    level: "campaign",
    time_range: JSON.stringify({ since: win.start, until: win.end }),
    fields: META_AUDIT_FIELDS,
    action_attribution_windows: JSON.stringify([...META_ATTRIBUTION_WINDOWS]),
    limit: "200",
    access_token: token,
  });
  const campaigns: MetaCampaignOut[] = [];
  let url: string | null = `${META_GRAPH}/${act}/insights?${qs}`;
  try {
    for (let page = 0; url && page < 10; page++) {
      const body = (await getJson(f, url, {}, "meta insights")) as { data?: Record<string, unknown>[]; paging?: { next?: string } };
      for (const r of body.data ?? []) {
        const conv = countMetaConversions(r as { actions?: unknown });
        const val = sumMetaActionValues(r as { action_values?: unknown });
        campaigns.push({
          campaign: String(r.campaign_name ?? "(unnamed)"), objective: r.objective == null ? null : String(r.objective),
          attributionSetting: r.attribution_setting == null ? null : String(r.attribution_setting),
          spendMicros: metaSpendToMicros(r.spend), impressions: n(r.impressions as string | undefined), linkClicks: n(r.inline_link_clicks as string | undefined),
          actions: lines(r.actions), actionValues: lines(r.action_values),
          osConversions: conv.basis === "none" ? null : conv.conversions, osConversionValueDollars: val.basis === "none" ? null : val.value,
        });
      }
      url = body.paging?.next ?? null;
    }
    return { campaigns, note: null };
  } catch (e) {
    return { campaigns, note: `Meta could not be read: ${safeMessage(e, [token])}` };
  }
}

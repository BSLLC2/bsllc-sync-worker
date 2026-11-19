/**
 * The audit's database reads. SELECT ONLY: the session is also put in read-only
 * mode, so even a mistaken statement here could not write. No lead name, phone,
 * email or click id is ever selected.
 */
import pg from "pg";
import { withVerifyFull } from "../db-url.js";
import type { Reading } from "./headline.js";

export interface ClientRow { id: string; name: string; slug: string; status: string }
export const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: withVerifyFull(url) });
  await c.connect();
  // A pooler that refuses this still gets only SELECTs from this file.
  await c.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY").catch(() => {});
  return c;
}

/** One client by id, slug or name prefix, or every non-internal client up to the cap. */
export async function resolveClients(c: pg.Client, want: string, cap: number): Promise<{ clients: ClientRow[]; note: string | null }> {
  const rows = (await c.query<{ id: string; name: string; status: string }>(`SELECT id, name, status FROM clients WHERE is_internal = false ORDER BY name`)).rows
    .map((r) => ({ id: r.id, name: r.name, slug: slugify(r.name), status: r.status }));
  if (want.toLowerCase() === "all") {
    const live = rows.filter((r) => r.status !== "churned");
    return { clients: live.slice(0, cap), note: live.length > cap ? `All ${live.length} live clients matched; the first ${cap} are audited (cap). Raise it with max.` : null };
  }
  const w = slugify(want);
  const exact = rows.filter((r) => r.id === want || r.slug === w);
  const hit = exact.length ? exact : rows.filter((r) => r.slug.startsWith(w));
  if (hit.length === 0) throw new Error(`No client matches "${want}".`);
  if (hit.length > 1 && !exact.length) throw new Error(`More than one client matches "${want}": ${hit.map((h) => h.name).join(", ")}. Use the full name.`);
  return { clients: [hit[0]!], note: null };
}

export async function tableExists(c: pg.Client, name: string): Promise<boolean> {
  const r = await c.query<{ t: string | null }>(`SELECT to_regclass($1) AS t`, [`public.${name}`]);
  return r.rows[0]?.t != null;
}

export interface Mapping { source: string; externalId: string; enabled: boolean }
export async function mappings(c: pg.Client, clientId: string): Promise<Mapping[]> {
  return (await c.query<{ source: string; external_id: string | null; enabled: boolean }>(
    `SELECT source, external_id, enabled FROM connector_mappings WHERE client_id = $1`, [clientId],
  )).rows.map((r) => ({ source: r.source, externalId: (r.external_id ?? "").trim(), enabled: r.enabled }));
}

/** Every stored snapshot row for the audited keys since a date. Values only; no row carries a person. */
export async function snapshotReadings(c: pg.Client, clientId: string, sinceIso: string, keys: readonly string[]): Promise<Reading[]> {
  const rows = (await c.query<{ source: string; metric_key: string; value_numeric: number | null; data_state: string; period_start: Date | string | null; period_end: Date | string | null; synced_at: Date | string }>(
    `SELECT source, metric_key, value_numeric, data_state, period_start, period_end, synced_at
       FROM metric_snapshots
      WHERE client_id = $1 AND metric_key = ANY($2::text[]) AND period_start >= $3::timestamptz
      ORDER BY synced_at`, [clientId, keys, sinceIso],
  )).rows;
  const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());
  return rows.map((r) => ({ source: r.source, metricKey: r.metric_key, value: r.value_numeric == null ? null : Number(r.value_numeric), dataState: r.data_state, periodStart: iso(r.period_start), periodEnd: iso(r.period_end), syncedAt: iso(r.synced_at) as string }));
}

export interface DailyCoverage { platform: string; accountId: string; from: string; to: string; ok: boolean; rows: number; at: string }
export async function dailyCoverage(c: pg.Client, clientId: string): Promise<{ stored: boolean; scans: DailyCoverage[]; spendByMonth: Map<string, { cost: number; clicks: number; conv: number | null }> }> {
  if (!(await tableExists(c, "ads_daily_scans")) || !(await tableExists(c, "ads_daily_metrics"))) return { stored: false, scans: [], spendByMonth: new Map() };
  const scans = (await c.query<{ platform: string; account_id: string; covered_from: string; covered_to: string; ok: boolean; rows_read: number; last_scan_at: Date | string }>(
    `SELECT platform, account_id, covered_from, covered_to, ok, rows_read, last_scan_at FROM ads_daily_scans WHERE client_id = $1 ORDER BY platform, account_id`, [clientId],
  )).rows.map((r) => ({ platform: r.platform, accountId: r.account_id, from: r.covered_from, to: r.covered_to, ok: r.ok, rows: Number(r.rows_read), at: new Date(r.last_scan_at).toISOString() }));
  const m = (await c.query<{ ym: string; cost: string; clicks: string; conv: number | null; unreported: string }>(
    `SELECT substr(metric_date, 1, 7) AS ym, sum(cost_micros)::text AS cost, sum(clicks)::text AS clicks, sum(conversions) AS conv,
            count(*) FILTER (WHERE conversions IS NULL)::text AS unreported
       FROM ads_daily_metrics WHERE client_id = $1 GROUP BY 1 ORDER BY 1`, [clientId],
  )).rows;
  const spendByMonth = new Map<string, { cost: number; clicks: number; conv: number | null }>();
  for (const r of m) spendByMonth.set(r.ym, { cost: Number(r.cost), clicks: Number(r.clicks), conv: r.conv == null || Number(r.unreported) > 0 ? null : Number(r.conv) });
  return { stored: true, scans, spendByMonth };
}

export interface ConvAction { campaignId: string; action: string; conversions: number; value: number; all: number; windowEnd: string }
export async function conversionActions(c: pg.Client, clientId: string): Promise<{ stored: boolean; rows: ConvAction[]; windowStart: string | null; windowEnd: string | null }> {
  if (!(await tableExists(c, "ads_campaign_conversion_actions"))) return { stored: false, rows: [], windowStart: null, windowEnd: null };
  const w = (await c.query<{ ws: string | null; we: string | null }>(`SELECT max(window_start) AS ws, max(window_end) AS we FROM ads_campaign_conversion_actions WHERE client_id = $1`, [clientId])).rows[0];
  if (!w?.we) return { stored: true, rows: [], windowStart: null, windowEnd: null };
  const rows = (await c.query<{ campaign_id: string; conversion_action_name: string | null; conversion_action_id: string; conversions: number; conversions_value: number; all_conversions: number; window_end: string }>(
    `SELECT campaign_id, conversion_action_name, conversion_action_id, conversions, conversions_value, all_conversions, window_end
       FROM ads_campaign_conversion_actions WHERE client_id = $1 AND window_end = $2 ORDER BY conversions DESC`, [clientId, w.we],
  )).rows.map((r) => ({ campaignId: r.campaign_id, action: r.conversion_action_name ?? `action ${r.conversion_action_id}`, conversions: Number(r.conversions), value: Number(r.conversions_value), all: Number(r.all_conversions), windowEnd: r.window_end }));
  return { stored: true, rows, windowStart: w.ws, windowEnd: w.we };
}

export interface ConvSetting { id: string; name: string | null; status: string | null; category: string | null; primary: boolean | null; included: boolean | null; counting: string | null; defaultValue: number | null; alwaysDefault: boolean | null }
/** The live conversion_action rows of the daily structure snapshot: how each action is set up (category, primary, counted in Conversions). */
export async function conversionSettings(c: pg.Client, clientId: string): Promise<{ stored: boolean; rows: ConvSetting[] }> {
  if (!(await tableExists(c, "ads_structure_entities"))) return { stored: false, rows: [] };
  const rows = (await c.query<{ entity_id: string; name: string | null; status: string | null; attrs_json: string | null }>(
    `SELECT entity_id, name, status, attrs_json FROM ads_structure_entities WHERE client_id = $1 AND entity_kind = 'conversion_action' AND valid_to IS NULL ORDER BY name`, [clientId],
  )).rows;
  return {
    stored: true,
    rows: rows.map((r) => {
      let a: Record<string, unknown> = {};
      try { a = JSON.parse(r.attrs_json ?? "{}") as Record<string, unknown>; } catch { /* a broken blob reads as unanswered */ }
      const b = (v: unknown) => (typeof v === "boolean" ? v : null);
      return { id: r.entity_id, name: r.name, status: r.status, category: typeof a.category === "string" ? a.category : null, primary: b(a.primary_for_goal), included: b(a.include_in_conversions_metric), counting: typeof a.counting_type === "string" ? a.counting_type : null, defaultValue: typeof a.default_value_account_currency === "number" ? a.default_value_account_currency : null, alwaysDefault: b(a.always_use_default_value) };
    }),
  };
}

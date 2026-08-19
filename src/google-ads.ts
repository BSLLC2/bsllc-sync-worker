import { GoogleAdsApi } from "google-ads-api";
import type { Config } from "./config.js";

/**
 * Aggregated window totals for one account, mapped to the dashboard's metric
 * keys. `null` on a metric means "genuinely not applicable" (e.g. cost per
 * conversion with zero conversions) — the dashboard downgrades a null in a
 * live entry to no_data for that one metric rather than reading it as zero.
 */
export type AdsMetrics = Record<string, number | null>;

export interface WindowResult {
  state: "live" | "no_data";
  metrics: AdsMetrics;
}

/**
 * Aggregated totals for the window — no segments.date in the SELECT, so the
 * API returns a single summary row for the whole period per account.
 */
const GAQL = `
  SELECT
    metrics.cost_micros,
    metrics.impressions,
    metrics.clicks,
    metrics.conversions,
    metrics.conversions_value,
    metrics.cost_per_conversion,
    metrics.ctr,
    metrics.average_cpc
  FROM customer
  WHERE segments.date BETWEEN '{{start}}' AND '{{end}}'
`;

export function makeAdsApi(cfg: Config): GoogleAdsApi {
  return new GoogleAdsApi({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    developer_token: cfg.developerToken,
  });
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pull one trailing window for one account. Throws on API failure — the caller
 * turns that into a data_state='error' entry so one bad account never sinks the
 * whole run. The google-ads-api client handles ret/backoff internally.
 */
export async function pullWindow(
  api: GoogleAdsApi,
  cfg: Config,
  customerId: string,
  queryStart: string,
  queryEnd: string,
): Promise<WindowResult> {
  const query = GAQL.replace("{{start}}", queryStart).replace("{{end}}", queryEnd);
  // Accounts reach us two ways: some are under the BS LLC manager (MCC), others
  // are shared directly with the authenticated user. Try the MCC login-customer-id
  // first, and on a permission/authorization error fall back to a direct call (no
  // manager header) — the same dual path verify-all/verify-och use. Without this
  // fallback, directly-shared accounts (e.g. OCH) fail with authorization_error=2
  // "the manager's customer id must be set", even though they're reachable directly.
  const runQuery = async () => {
    try {
      return await api
        .Customer({ customer_id: customerId, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken })
        .query(query);
    } catch (mccErr) {
      // The google-ads-api error object doesn't surface the reason on `.message`,
      // so don't try to classify it — just retry directly (no manager header).
      // If the direct call also fails, throw THAT error (the more relevant one).
      try {
        return await api
          .Customer({ customer_id: customerId, refresh_token: cfg.refreshToken })
          .query(query);
      } catch {
        throw mccErr;
      }
    }
  };
  const rows = await runQuery();

  if (!rows.length) return { state: "no_data", metrics: {} };
  const m = (rows[0]?.metrics ?? {}) as Record<string, unknown>;

  const cost = num(m.cost_micros);
  const impressions = num(m.impressions);
  const clicks = num(m.clicks);
  const conversions = num(m.conversions);

  // Nothing served in the window → treat as no_data, not a row of zeros.
  if (cost === 0 && impressions === 0 && clicks === 0) {
    return { state: "no_data", metrics: {} };
  }

  return {
    state: "live",
    metrics: {
      "ads.cost_micros": cost,
      "ads.impressions": impressions,
      "ads.clicks": clicks,
      "ads.conversions": conversions,
      // Dollar value Google Ads attributes to those conversions (account
      // currency, not micros). Powers real revenue + ROAS on the Marketing tab.
      // Null when there are no conversions so scoring/revenue skips it.
      "ads.conversion_value": conversions > 0 ? num(m.conversions_value) : null,
      // Undefined at zero conversions — send null so scoring skips it.
      "ads.cost_per_conversion": conversions > 0 ? num(m.cost_per_conversion) : null,
      "ads.ctr": num(m.ctr),
      "ads.average_cpc": num(m.average_cpc),
    },
  };
}

/**
 * "ads.conversions" above is `metrics.conversions` at the CUSTOMER level —
 * summed across every conversion action in the account (form fills, calls,
 * page views, whatever's configured). For accounts running the offline-
 * conversion loop (see import-offline-conversions.ts), that number is not the
 * one to trust: it isn't the count of real, sheet-verified admissions, and
 * mixing it into revenue/CPL overstates both. This pulls the SAME window but
 * scoped to one specific conversion action by name (e.g. "Admission
 * (offline)") — the action that only gets uploaded when a real admission from
 * the client's sheet is matched to a click. Returns null when that action
 * doesn't exist on the account or had no conversions in the window, so the
 * caller can fall back to not emitting a verified figure at all rather than a
 * false zero.
 */
// `conversion_action` as a FROM resource only exposes the action's own
// attributes (name, id, status…) — GAQL rejects performance metrics there
// ("could not support requested resources: 'CONVERSION_ACTION'"). Per-action
// performance has to come from `customer` segmented by conversion action
// name instead; filter to the one we want client-side.
const CONVERSION_ACTION_GAQL = `
  SELECT segments.conversion_action_name, metrics.conversions, metrics.conversions_value
  FROM customer
  WHERE segments.date BETWEEN '{{start}}' AND '{{end}}'
`;

export async function pullVerifiedConversions(
  api: GoogleAdsApi,
  cfg: Config,
  customerId: string,
  queryStart: string,
  queryEnd: string,
  conversionActionName: string,
): Promise<{ conversions: number; value: number } | null> {
  const query = CONVERSION_ACTION_GAQL
    .replace("{{start}}", queryStart)
    .replace("{{end}}", queryEnd);
  const runQuery = async () => {
    try {
      return await api
        .Customer({ customer_id: customerId, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken })
        .query(query);
    } catch (mccErr) {
      try {
        return await api
          .Customer({ customer_id: customerId, refresh_token: cfg.refreshToken })
          .query(query);
      } catch {
        throw mccErr;
      }
    }
  };
  const rows = await runQuery();
  if (!rows.length) return null;
  // One row per conversion action active in the window — keep only the one
  // we're after (name match is case-sensitive and exact, same as how the
  // offline-conversion importer creates it).
  let conversions = 0;
  let value = 0;
  for (const r of rows) {
    const seg = (r.segments ?? {}) as Record<string, unknown>;
    if (seg.conversion_action_name !== conversionActionName) continue;
    const m = (r.metrics ?? {}) as Record<string, unknown>;
    conversions += num(m.conversions);
    value += num(m.conversions_value);
  }
  if (conversions === 0) return null;
  return { conversions, value };
}

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
  const customer = api.Customer({
    customer_id: customerId,
    login_customer_id: cfg.loginCustomerId,
    refresh_token: cfg.refreshToken,
  });

  const query = GAQL.replace("{{start}}", queryStart).replace("{{end}}", queryEnd);
  const rows = await customer.query(query);

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
      // Undefined at zero conversions — send null so scoring skips it.
      "ads.cost_per_conversion": conversions > 0 ? num(m.cost_per_conversion) : null,
      "ads.ctr": num(m.ctr),
      "ads.average_cpc": num(m.average_cpc),
    },
  };
}

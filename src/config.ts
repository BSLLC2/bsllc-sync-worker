import "dotenv/config";

/**
 * Loads and validates worker configuration from the environment. Every secret
 * lives in .env on the VPS — this module is the single place it is read, so a
 * missing value fails loudly at startup instead of surfacing as a confusing
 * API error three calls deep.
 */
export interface Config {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  refreshToken: string;
  /** MCC id, digits only. */
  loginCustomerId: string;
  databaseUrl: string;
  /** Path to the dashboard checkout that owns `npm run sync`. */
  dashboardDir: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v.trim();
}

/** Google Ads wants customer ids as digits only — strip dashes/spaces defensively. */
export function digitsOnly(id: string): string {
  return id.replace(/[^0-9]/g, "");
}

export function loadConfig(): Config {
  return {
    clientId: req("GOOGLE_ADS_CLIENT_ID"),
    clientSecret: req("GOOGLE_ADS_CLIENT_SECRET"),
    developerToken: req("GOOGLE_ADS_DEVELOPER_TOKEN"),
    refreshToken: req("GOOGLE_ADS_REFRESH_TOKEN"),
    loginCustomerId: digitsOnly(req("GOOGLE_ADS_LOGIN_CUSTOMER_ID")),
    databaseUrl: req("DATABASE_URL"),
    dashboardDir: req("DASHBOARD_DIR"),
  };
}

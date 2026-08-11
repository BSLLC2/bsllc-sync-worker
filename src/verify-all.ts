#!/usr/bin/env tsx
import "dotenv/config";
import { GoogleAdsApi } from "google-ads-api";
import pg from "pg";

/**
 * Roster-wide reachability audit (read-only). For every client that has an
 * enabled Google Ads connector mapping, confirms our sync credentials can
 * actually reach the account — via the MCC login header, then directly. This is
 * the dimension the in-app Account QA can't see (it reads Postgres; only the
 * worker holds the Ads creds). It's how we caught OCH's "permission denied"
 * blocker — this runs the same check across everyone at once, plus a freshness
 * read per client so stale/never-synced accounts surface too.
 */
const digits = (s: string) => (s ?? "").replace(/[^0-9]/g, "");
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const pgc = new pg.Client({ connectionString: env("DATABASE_URL") });
  await pgc.connect();
  try {
    const cfg = {
      clientId: env("GOOGLE_ADS_CLIENT_ID"), clientSecret: env("GOOGLE_ADS_CLIENT_SECRET"),
      developerToken: env("GOOGLE_ADS_DEVELOPER_TOKEN"), refreshToken: env("GOOGLE_ADS_REFRESH_TOKEN"),
      loginCustomerId: digits(env("GOOGLE_ADS_LOGIN_CUSTOMER_ID")),
    };
    const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });

    // Clients + their enabled Google Ads account id + freshest live metric age.
    const { rows } = await pgc.query<{ id: string; name: string; external_id: string | null; last_synced: string | null }>(
      `SELECT c.id, c.name,
              cm.external_id,
              (SELECT max(ms.synced_at) FROM metric_snapshots ms
                WHERE ms.client_id = c.id AND ms.data_state='live') AS last_synced
         FROM clients c
         LEFT JOIN connector_mappings cm
           ON cm.client_id = c.id AND cm.source='google_ads' AND cm.enabled = true AND cm.external_id IS NOT NULL
        ORDER BY c.name`,
    );

    const q = `SELECT customer.id FROM customer LIMIT 1`;
    // google-ads-api throws structured error objects, not Error instances.
    // Serialize the REAL reason (and its error code) so we can tell an
    // account-level access problem (USER_PERMISSION_DENIED → link/grant in the
    // Google Ads UI) apart from a credential problem (invalid_grant / bad token
    // / developer-token or client mismatch → re-mint the refresh token). Those
    // need opposite fixes; a bare catch that always prints "PERMISSION DENIED"
    // hides which one you're actually hitting.
    const reason = (e: any): string => {
      const code = e?.errors?.[0]?.error_code ? Object.values(e.errors[0].error_code)[0] : null;
      const msg =
        e?.errors?.map((x: any) => x.message).filter(Boolean).join("; ") ||
        e?.response?.data?.error_description ||
        e?.response?.data?.error ||
        e?.message ||
        (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
      return code ? `${code}: ${msg}` : msg;
    };
    // Classify so the summary counts genuine access denials separately from
    // credential failures — a credential failure hits every account, so lumping
    // them as "denied" wrongly implies a per-account linking problem.
    const isAuth = (s: string) => /invalid_grant|invalid_client|unauthorized_client|invalid_scope|access_denied|DEVELOPER_TOKEN|NOT_ADMIN|token/i.test(s);

    let reachable = 0, denied = 0, authFail = 0, unmapped = 0;
    console.log(`\n=== Roster reachability (Google Ads) — ${rows.length} clients ===\n`);
    for (const r of rows) {
      const ageDays = r.last_synced ? Math.round((Date.now() - new Date(r.last_synced).getTime()) / 86_400_000) : null;
      const fresh = ageDays == null ? "never synced" : ageDays <= 10 ? `fresh ${ageDays}d` : `STALE ${ageDays}d`;
      if (!r.external_id) { unmapped++; console.log(`  ·  ${r.name}: no Google Ads connector mapped · ${fresh}`); continue; }
      const cid = digits(r.external_id);
      let ok = false, how = "", err = "";
      try { await api.Customer({ customer_id: cid, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken }).query(q); ok = true; how = "MCC"; }
      catch (e1: any) {
        try { await api.Customer({ customer_id: cid, refresh_token: cfg.refreshToken }).query(q); ok = true; how = "direct"; }
        catch (e2: any) { ok = false; err = reason(e2) || reason(e1); }
      }
      if (ok) { reachable++; console.log(`  ✅ ${r.name} [${cid}]: reachable (${how}) · ${fresh}`); }
      else if (isAuth(err)) { authFail++; console.log(`  🔑 ${r.name} [${cid}]: CREDENTIAL FAILURE — ${err} · ${fresh}`); }
      else { denied++; console.log(`  🚫 ${r.name} [${cid}]: ${err || "PERMISSION DENIED (link under MCC " + cfg.loginCustomerId + " or grant access)"} · ${fresh}`); }
    }
    console.log(`\nSummary: ${reachable} reachable · ${denied} access-denied · ${authFail} credential-failure · ${unmapped} no Ads mapping · ${rows.length} total`);
    if (authFail > 0 && reachable === 0) {
      console.log(`\n⚠️  Every mapped account failed on CREDENTIALS, not per-account access. Fix the token/client, not the account links: re-mint GOOGLE_ADS_REFRESH_TOKEN for a user with access, using THIS OAuth client, with scope https://www.googleapis.com/auth/adwords.`);
    } else if (denied > 0 && reachable === 0) {
      console.log(`\n⚠️  Auth works (token is valid) but this user can't see any account. Grant this Google user access to MCC ${cfg.loginCustomerId} (or link the accounts under it) in the Google Ads UI.`);
    }
  } finally {
    await pgc.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

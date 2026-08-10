#!/usr/bin/env tsx
import "dotenv/config";
import { GoogleAdsApi } from "google-ads-api";
import pg from "pg";

/**
 * Read-only end-to-end verification for OCH. Answers two questions with real
 * data, no assumptions:
 *   A) CLIENT DASHBOARD — are the admissions/revenue/conversion figures the
 *      board reads actually present, current-month-correct, fresh, and do they
 *      have enough history to show deltas?
 *   B) RECURSIVE GOOGLE MODEL — can we reach OCH's Google Ads account, does the
 *      "Admission (offline)" conversion action exist, are web inquiries carrying
 *      gclids, and how many admissions have been uploaded so far?
 *
 * Mutates nothing (find-only on Google Ads). Prints a PASS / GAP checklist.
 */

const SHEET_CLIENT_SLUG = "ohio-community-health-och";
const CONVERSION_ACTION_NAME = "Admission (offline)";
const digits = (s: string) => (s ?? "").replace(/[^0-9]/g, "");
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const PASS = (m: string) => console.log(`  ✅ ${m}`);
const GAP = (m: string) => console.log(`  ⚠️  ${m}`);

async function main() {
  const pgc = new pg.Client({ connectionString: env("DATABASE_URL") });
  await pgc.connect();
  try {
    // Resolve OCH.
    const { rows: clients } = await pgc.query<{ id: string; name: string; customer_value_cents: number | null; contract_start: string | null }>(
      "SELECT id, name, customer_value_cents, contract_start FROM clients",
    );
    const och = clients.find((c) => slugify(c.name) === SHEET_CLIENT_SLUG || /ohio community/i.test(c.name));
    if (!och) { console.log("❌ OCH client not found."); return; }
    console.log(`\n=== A) CLIENT DASHBOARD (OCH: ${och.name}, id ${och.id}) ===`);

    // Latest complete-month figure the board resolves (mirrors getLatestMetrics).
    for (const key of ["manual.admissions", "manual.admissions_marketing", "manual.revenue_cents"]) {
      const { rows } = await pgc.query(
        `SELECT value_numeric, period_end, synced_at FROM metric_snapshots
          WHERE client_id=$1 AND metric_key=$2 AND data_state='live' AND value_numeric IS NOT NULL
            AND (period_end IS NULL OR period_end <= now())
          ORDER BY synced_at DESC, period_end DESC NULLS LAST LIMIT 1`,
        [och.id, key],
      );
      const { rows: allPeriods } = await pgc.query(
        `SELECT count(DISTINCT period_end) AS n FROM metric_snapshots
          WHERE client_id=$1 AND metric_key=$2 AND data_state='live' AND (period_end IS NULL OR period_end<=now())`,
        [och.id, key],
      );
      const { rows: future } = await pgc.query(
        `SELECT count(*) AS n FROM metric_snapshots WHERE client_id=$1 AND metric_key=$2 AND period_end > now()`,
        [och.id, key],
      );
      if (!rows.length) { GAP(`${key}: NO current value`); continue; }
      const r = rows[0];
      const pe = r.period_end ? new Date(r.period_end).toISOString().slice(0, 10) : "n/a";
      const ageDays = Math.round((Date.now() - new Date(r.synced_at).getTime()) / 86_400_000);
      const nPeriods = Number(allPeriods[0].n);
      const nFuture = Number(future[0].n);
      const val = key === "manual.revenue_cents" ? `$${(Number(r.value_numeric) / 100).toLocaleString()}` : r.value_numeric;
      const deltaOk = nPeriods >= 2 ? "deltas OK" : "NO deltas (need 2+ periods)";
      const freshOk = ageDays <= 10 ? `fresh (${ageDays}d)` : `STALE (${ageDays}d)`;
      const futureWarn = nFuture > 0 ? ` ⚠️ ${nFuture} FUTURE-dated rows still present!` : "";
      (nFuture === 0 && nPeriods >= 2 ? PASS : GAP)(`${key}: ${val} · period ${pe} · ${freshOk} · ${nPeriods} periods (${deltaOk})${futureWarn}`);
    }
    const cv = och.customer_value_cents != null ? `$${(och.customer_value_cents / 100).toLocaleString()}` : "UNSET (using $8,000 default)";
    console.log(`  Customer value (drives revenue): ${cv}`);

    console.log(`\n=== B) RECURSIVE GOOGLE MODEL ===`);
    const { rows: inq } = await pgc.query(`SELECT count(*) AS total, count(gclid) FILTER (WHERE gclid IS NOT NULL AND gclid<>'') AS with_gclid FROM web_inquiries WHERE client_slug=$1`, [SHEET_CLIENT_SLUG]);
    const total = Number(inq[0].total), withGclid = Number(inq[0].with_gclid);
    (withGclid > 0 ? PASS : GAP)(`Web inquiries: ${total} total, ${withGclid} with a gclid ${withGclid === 0 ? "→ loop has nothing to upload until the form feeds gclids" : ""}`);
    const { rows: up } = await pgc.query(`SELECT count(*) AS n FROM offline_conversion_uploads WHERE client_slug=$1`, [SHEET_CLIENT_SLUG]);
    console.log(`  Offline conversions uploaded so far: ${Number(up[0].n)}`);

    // Google Ads reachability (find-only).
    try {
      const cfg = { clientId: env("GOOGLE_ADS_CLIENT_ID"), clientSecret: env("GOOGLE_ADS_CLIENT_SECRET"), developerToken: env("GOOGLE_ADS_DEVELOPER_TOKEN"), refreshToken: env("GOOGLE_ADS_REFRESH_TOKEN"), loginCustomerId: digits(env("GOOGLE_ADS_LOGIN_CUSTOMER_ID")) };
      const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });
      let customerId = process.env.OCH_ADS_CUSTOMER_ID ? digits(process.env.OCH_ADS_CUSTOMER_ID) : null;
      // Preferred: the exact account id the daily sync uses (Admin → Connectors).
      // Accessing it through the MCC login header works; querying the MCC itself
      // for discovery does not (the token isn't a manager-level user).
      if (!customerId) {
        const { rows: cm } = await pgc.query<{ external_id: string | null }>(
          "SELECT external_id FROM connector_mappings WHERE client_id=$1 AND source='google_ads' AND enabled=true AND external_id IS NOT NULL LIMIT 1",
          [och.id],
        );
        if (cm[0]?.external_id) { customerId = digits(String(cm[0].external_id)); PASS(`OCH Ads account from Admin → Connectors: ${customerId}`); }
        else GAP("OCH has NO enabled Google Ads connector in Admin → Connectors — map it there (or set OCH_ADS_CUSTOMER_ID) so the loop knows the account.");
      }
      if (!customerId) {
        const mcc = api.Customer({ customer_id: cfg.loginCustomerId, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
        const cc = await mcc.query(`SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager FROM customer_client`);
        const hit = cc.find((c: any) => !c.customer_client?.manager && /ohio community|och/i.test(c.customer_client?.descriptive_name ?? ""));
        customerId = hit?.customer_client?.id ? digits(String(hit.customer_client.id)) : null;
        if (customerId) PASS(`Discovered OCH Ads account under MCC: ${customerId} (${hit?.customer_client?.descriptive_name ?? "?"})`);
        else { GAP(`Could NOT auto-find OCH's Ads account. Accounts under MCC: ${cc.map((c: any) => `${c.customer_client?.descriptive_name} (${c.customer_client?.id})`).join(", ")}. Set OCH_ADS_CUSTOMER_ID.`); return; }
      } else PASS(`OCH Ads account (from OCH_ADS_CUSTOMER_ID): ${customerId}`);

      const q = `SELECT conversion_action.name, conversion_action.status FROM conversion_action WHERE conversion_action.name = '${CONVERSION_ACTION_NAME}'`;
      // Try through the MCC first; if the account isn't under that manager,
      // retry accessing it DIRECTLY (works when the OAuth user has direct
      // access). This tells "the loop is reachable" apart from "the account
      // needs linking in Google Ads".
      let actions: any[] | null = null;
      let reachedVia = "";
      try {
        actions = await api.Customer({ customer_id: customerId, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken }).query(q);
        reachedVia = `via MCC ${cfg.loginCustomerId}`;
      } catch {
        try {
          actions = await api.Customer({ customer_id: customerId, refresh_token: cfg.refreshToken }).query(q);
          reachedVia = "directly (no manager header)";
        } catch (e2: any) {
          const d = e2?.errors?.map((x: any) => x.message).join("; ") || e2?.message || "unknown";
          GAP(`Cannot reach OCH's Ads account ${customerId} either via the MCC or directly: ${d}. Likely OCH's account is not linked under MCC ${cfg.loginCustomerId} and this OAuth user has no direct access — link it in Google Ads (or grant access), then the daily Ads sync AND this loop both work.`);
        }
      }
      if (actions) {
        PASS(`Reachable ${reachedVia}. ${actions.length > 0 ? `Conversion action "${CONVERSION_ACTION_NAME}" exists (status ${actions[0].conversion_action.status}).` : `Conversion action not created yet — the loop creates it on first upload.`}`);
      }
    } catch (e: any) {
      // google-ads-api throws structured error objects, not Error instances —
      // serialize so the real reason is visible instead of "[object Object]".
      const detail =
        e?.errors?.map((x: any) => x.message || JSON.stringify(x)).join("; ") ||
        e?.message ||
        (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
      GAP(`Google Ads check failed: ${detail}`);
    }

    console.log("\nDone.");
  } finally {
    await pgc.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

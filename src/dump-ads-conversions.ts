#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";

/**
 * Read-only dump of an account's CONVERSION CONFIGURATION -- not its performance.
 *
 * Reporting tells you how many conversions were counted. It cannot tell you what
 * a conversion IS: which actions exist, which are primary (and therefore what
 * Smart Bidding optimises toward), whether a flat default value is being stamped
 * on actions that carry no real revenue, and how long the lookback windows run.
 * Those settings are the difference between "we booked 3 events worth $828 each"
 * and "3 people filled in a form and someone typed 828 into a box".
 *
 *   npm run dump-ads-conversions -- --client=Tablespoon
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const usd = (m: unknown) => `$${(Number(m ?? 0) / 1_000_000).toFixed(2)}`;

/** Google returns enums as integers over REST; only the ones that change a decision. */
const CATEGORY: Record<string, string> = {
  "0":"UNSPECIFIED","1":"UNKNOWN","2":"DEFAULT","3":"PAGE_VIEW","4":"PURCHASE","5":"SIGNUP",
  "6":"LEAD","7":"DOWNLOAD","8":"ADD_TO_CART","9":"BEGIN_CHECKOUT","10":"SUBSCRIBE_PAID",
  "11":"PHONE_CALL_LEAD","12":"IMPORTED_LEAD","13":"SUBMIT_LEAD_FORM","14":"BOOK_APPOINTMENT",
  "15":"REQUEST_QUOTE","16":"GET_DIRECTIONS","17":"OUTBOUND_CLICK","18":"CONTACT",
  "19":"ENGAGEMENT","20":"STORE_VISIT","21":"STORE_SALE","22":"QUALIFIED_LEAD","23":"CONVERTED_LEAD",
};
const STATUS: Record<string, string> = { "2":"ENABLED","3":"REMOVED","4":"HIDDEN" };
const COUNTING: Record<string, string> = { "2":"ONE_PER_CLICK","3":"MANY_PER_CLICK" };
const TYPE: Record<string, string> = {
  "2":"AD_CALL","3":"CLICK_TO_CALL","4":"GOOGLE_PLAY_DOWNLOAD","5":"GOOGLE_PLAY_IN_APP_PURCHASE",
  "6":"UPLOAD_CALLS","7":"UPLOAD_CLICKS","8":"WEBPAGE","9":"WEBSITE_CALL",
  "10":"STORE_SALES_DIRECT_UPLOAD","11":"STORE_SALES","12":"FIREBASE_ANDROID_FIRST_OPEN",
  "16":"GOOGLE_ANALYTICS_4_CUSTOM","17":"GOOGLE_ANALYTICS_4_PURCHASE",
};
const nm = (m: Record<string,string>, v: unknown) => m[String(v ?? "")] ?? String(v ?? "—");
const d = (off: number) => new Date(Date.now() - off * 86_400_000).toISOString().slice(0, 10);

async function main() {
  const only = (process.argv.slice(2).find((a) => a.startsWith("--client="))?.slice(9) || "").trim();
  const days = Number(process.argv.slice(2).find((a) => a.startsWith("--days="))?.slice(7) ?? 90);
  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });

  const pgc = new pg.Client({ connectionString: cfg.databaseUrl });
  await pgc.connect();
  let customerId = "", clientName = "";
  try {
    const { rows } = await pgc.query<{ name: string; external_id: string }>(
      `SELECT c.name, cm.external_id FROM clients c
         JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source='google_ads' AND cm.enabled = true
        WHERE cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''`);
    const want = slugify(only);
    const hit = rows.find((r) => !only || slugify(r.name).startsWith(want));
    if (!hit) throw new Error(`No mapped Ads account matched "${only}". Have: ${rows.map((r) => slugify(r.name)).join(", ")}`);
    customerId = digitsOnly(hit.external_id); clientName = hit.name;
  } finally { await pgc.end(); }

  let customer: any;
  try {
    customer = api.Customer({ customer_id: customerId, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
    await customer.query(`SELECT customer.id FROM customer LIMIT 1`);
  } catch {
    customer = api.Customer({ customer_id: customerId, refresh_token: cfg.refreshToken });
  }
  console.log(`\n${clientName} [${customerId}] — CONVERSION CONFIGURATION (read only)\n${"=".repeat(78)}`);

  // ── Every conversion action and how it is configured ──────────────────────
  const actions = await customer.query(`
    SELECT conversion_action.id, conversion_action.name, conversion_action.category,
           conversion_action.type, conversion_action.status,
           conversion_action.primary_for_goal, conversion_action.counting_type,
           conversion_action.value_settings.default_value,
           conversion_action.value_settings.always_use_default_value,
           conversion_action.click_through_lookback_window_days,
           conversion_action.view_through_lookback_window_days
      FROM conversion_action
     WHERE conversion_action.status = 'ENABLED'`);

  console.log(`\n-- Conversion actions (${actions.length} enabled) --`);
  for (const a of actions) {
    const c = a.conversion_action ?? {};
    const v = c.value_settings ?? {};
    // Do NOT default an absent primary_for_goal to "yes". Google omits the field
    // in some responses, and guessing it turns a missing value into a confident
    // claim about what Smart Bidding chases. The authoritative signal is the
    // metrics split below: metrics.conversions counts primary actions only, so
    // an action with all_conversions but zero conversions is NOT primary.
    const primary = c.primary_for_goal === true ? "YES"
      : c.primary_for_goal === false ? "no (secondary, observation only)"
      : "NOT REPORTED — read the conversions vs all_conversions split below";
    console.log(`\n  ${c.name}   [id ${c.id}]`);
    console.log(`     category ${nm(CATEGORY, c.category)} · type ${nm(TYPE, c.type)} · ${nm(COUNTING, c.counting_type)}`);
    console.log(`     PRIMARY FOR BIDDING: ${primary}`);
    console.log(`     default value ${usd(Number(v.default_value ?? 0) * 1_000_000)}` +
                `${v.always_use_default_value ? "  <-- ALWAYS_USE_DEFAULT: a flat value replaces real revenue" : ""}`);
    console.log(`     lookback: ${c.click_through_lookback_window_days ?? "?"}d click / ${c.view_through_lookback_window_days ?? "?"}d view`);
  }

  // ── What the account is actually bidding to ───────────────────────────────
  try {
    const goals = await customer.query(`
      SELECT customer_conversion_goal.category, customer_conversion_goal.origin,
             customer_conversion_goal.biddable FROM customer_conversion_goal`);
    const biddable = goals.filter((g: any) => g.customer_conversion_goal?.biddable);
    console.log(`\n-- Account-level conversion goals (${biddable.length} biddable of ${goals.length}) --`);
    for (const g of biddable) console.log(`     BIDDABLE: ${nm(CATEGORY, g.customer_conversion_goal?.category)}`);
  } catch (e) { console.log(`\n-- Account-level goals unavailable: ${(e as Error).message.slice(0, 120)}`); }

  // ── Per-action performance, so config can be read against outcomes ────────
  const perf = await customer.query(`
    SELECT segments.conversion_action_name, metrics.conversions, metrics.conversions_value,
           metrics.all_conversions, metrics.all_conversions_value
      FROM customer
     WHERE segments.date BETWEEN '${d(days)}' AND '${d(1)}'`);
  const byName: Record<string, { c: number; v: number; ac: number; av: number }> = {};
  for (const p of perf) {
    const n = p.segments?.conversion_action_name ?? "(unnamed)";
    const t = (byName[n] ??= { c: 0, v: 0, ac: 0, av: 0 });
    t.c += Number(p.metrics?.conversions ?? 0); t.v += Number(p.metrics?.conversions_value ?? 0);
    t.ac += Number(p.metrics?.all_conversions ?? 0); t.av += Number(p.metrics?.all_conversions_value ?? 0);
  }
  // Which campaign's conversions are which action -- the question behind
  // "are the private-events conversions ticket sales or form fills?"
  const byCampaign = await customer.query(`
    SELECT campaign.name, segments.conversion_action_name,
           metrics.conversions, metrics.conversions_value,
           metrics.all_conversions, metrics.all_conversions_value
      FROM campaign
     WHERE segments.date BETWEEN '${d(days)}' AND '${d(1)}'`);
  const cmap: Record<string, Record<string, { c: number; v: number; ac: number; av: number }>> = {};
  for (const r of byCampaign) {
    const cn = r.campaign?.name ?? "(none)";
    const an = r.segments?.conversion_action_name ?? "(unnamed)";
    const t = ((cmap[cn] ??= {})[an] ??= { c: 0, v: 0, ac: 0, av: 0 });
    t.c += Number(r.metrics?.conversions ?? 0); t.v += Number(r.metrics?.conversions_value ?? 0);
    t.ac += Number(r.metrics?.all_conversions ?? 0); t.av += Number(r.metrics?.all_conversions_value ?? 0);
  }
  console.log(`\n-- Which action each campaign's conversions actually are (last ${days} days) --`);
  for (const [cn, acts] of Object.entries(cmap)) {
    const rows = Object.entries(acts).filter(([, t]) => t.ac > 0 || t.c > 0);
    if (!rows.length) continue;
    console.log(`\n  ${cn}`);
    for (const [an, t] of rows.sort((a, b) => b[1].ac - a[1].ac))
      console.log(`     ${an.slice(0, 44).padEnd(44)} conv ${t.c.toFixed(1).padStart(7)} ($${t.v.toFixed(2)})` +
                  `   all ${t.ac.toFixed(1).padStart(8)} ($${t.av.toFixed(2)})`);
  }

  console.log(`\n-- Performance by action (last ${days} days) --`);
  console.log(`  ${"action".padEnd(42)}${"conv".padStart(9)}${"value".padStart(13)}${"all_conv".padStart(10)}${"all_value".padStart(13)}`);
  for (const [n, t] of Object.entries(byName).sort((a, b) => b[1].v - a[1].v)) {
    console.log(`  ${n.slice(0, 42).padEnd(42)}${t.c.toFixed(1).padStart(9)}${("$" + t.v.toFixed(2)).padStart(13)}` +
                `${t.ac.toFixed(1).padStart(10)}${("$" + t.av.toFixed(2)).padStart(13)}`);
  }
  console.log("");
}

main().catch((e) => {
  const msg = e?.errors?.map((x: any) => x.message).join("; ") || (e instanceof Error ? e.message : String(e));
  console.error(msg); process.exit(1);
});

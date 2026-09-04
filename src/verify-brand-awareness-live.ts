#!/usr/bin/env tsx
import "dotenv/config";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig } from "./config.js";

/**
 * READ-ONLY re-verification, prompted by a direct challenge: is Brand Awareness
 * actually paused? Also re-checks the other headline claims made this session
 * (main campaign budget, branded post-rollback CPL) directly against the account.
 */

const CUSTOMER_ID = "8350689003";
const TCS = "23249502120";   // Treatment Center Search
const BRAND = "24018792925"; // OHC - Branded Search
const AWARE = "23174695410"; // OCH Brand Awareness

const usd = (m: unknown) => Number(m ?? 0) / 1_000_000;
const $ = (n: number) => `$${n.toFixed(2)}`;
const n1 = (v: unknown) => Number(v ?? 0).toFixed(1);
const hr = (t: string) => console.log(`\n${"=".repeat(88)}\n${t}\n${"=".repeat(88)}`);
const CAMPSTATUS: Record<string,string> = {"2":"ENABLED","3":"PAUSED","4":"REMOVED"};
const ADGROUPSTATUS: Record<string,string> = {"2":"ENABLED","3":"PAUSED","4":"REMOVED"};
const ADSTATUS: Record<string,string> = {"2":"ENABLED","3":"PAUSED","4":"REMOVED"};
const nm = (m: Record<string,string>, v: unknown) => m[String(v ?? "")] ?? String(v ?? "—");

async function main() {
  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });
  let c: any;
  try {
    c = api.Customer({ customer_id: CUSTOMER_ID, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
    await c.query(`SELECT customer.id FROM customer LIMIT 1`);
  } catch { c = api.Customer({ customer_id: CUSTOMER_ID, refresh_token: cfg.refreshToken }); }
  const q = async (gaql: string) => { try { return await c.query(gaql); } catch (e: any) {
    const msg = e?.errors?.map((x: any) => x.message).join("; ") || e?.message || String(e);
    console.log(`   [UNAVAILABLE] ${msg.slice(0, 300)}`); return null; } };

  console.log(`\nLIVE RE-VERIFICATION — account ${CUSTOMER_ID} — read only`);

  hr("1. ALL CAMPAIGNS — status, budget, right now");
  const camps = await q(`SELECT campaign.id, campaign.name, campaign.status,
      campaign_budget.amount_micros, campaign.serving_status
      FROM campaign ORDER BY campaign.name`);
  if (camps) for (const r of camps) {
    console.log(`  [${r.campaign?.id}] ${String(r.campaign?.name).padEnd(28)} status=${nm(CAMPSTATUS, r.campaign?.status)}  serving=${r.campaign?.serving_status}  budget=${$(usd(r.campaign_budget?.amount_micros))}/day`);
  }

  hr("2. OCH BRAND AWARENESS (23174695410) — ad groups + ads, direct");
  const awareCamp = await q(`SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros
      FROM campaign WHERE campaign.id = ${AWARE}`);
  if (awareCamp?.[0]) {
    const r = awareCamp[0];
    console.log(`  Campaign status: ${nm(CAMPSTATUS, r.campaign?.status)}  budget: ${$(usd(r.campaign_budget?.amount_micros))}/day`);
  } else {
    console.log(`  Campaign ${AWARE} did not return from a direct campaign.id query.`);
  }
  const groups = await q(`SELECT ad_group.id, ad_group.name, ad_group.status
      FROM ad_group WHERE ad_group.campaign = 'customers/${CUSTOMER_ID}/campaigns/${AWARE}'`);
  if (groups) {
    console.log(`  Ad groups (${groups.length}):`);
    for (const r of groups) console.log(`    [${r.ad_group?.id}] ${r.ad_group?.name}  status=${nm(ADGROUPSTATUS, r.ad_group?.status)}`);
  }
  const ads = await q(`SELECT ad_group_ad.ad.id, ad_group_ad.status, ad_group.name, ad_group_ad.ad.type
      FROM ad_group_ad WHERE campaign.id = ${AWARE}`);
  if (ads) {
    console.log(`  Ads (${ads.length}):`);
    for (const r of ads) console.log(`    ad ${r.ad_group_ad?.ad?.id}  status=${nm(ADSTATUS, r.ad_group_ad?.status)}  type=${r.ad_group_ad?.ad?.type}  group="${r.ad_group?.name}"`);
    if (ads.length === 0) console.log(`    (none returned)`);
  }
  const awareSpend = await q(`SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.all_conversions
      FROM campaign WHERE campaign.id = ${AWARE} AND segments.date BETWEEN '2026-08-05' AND '2026-09-03'`);
  if (awareSpend) {
    const totalCost = awareSpend.reduce((s: number, r: any) => s + usd(r.metrics?.cost_micros), 0);
    const totalClicks = awareSpend.reduce((s: number, r: any) => s + Number(r.metrics?.clicks ?? 0), 0);
    const totalImpr = awareSpend.reduce((s: number, r: any) => s + Number(r.metrics?.impressions ?? 0), 0);
    const totalConv = awareSpend.reduce((s: number, r: any) => s + Number(r.metrics?.all_conversions ?? 0), 0);
    console.log(`  Last 30d (8/5-9/3): cost=${$(totalCost)}  clicks=${totalClicks}  impressions=${totalImpr}  all_conversions=${n1(totalConv)}`);
    const activeDays = awareSpend.filter((r: any) => usd(r.metrics?.cost_micros) > 0).length;
    console.log(`  Days with any spend in that window: ${activeDays} of ${awareSpend.length}`);
  }

  hr("3. TREATMENT CENTER SEARCH (main campaign) budget, right now");
  const tcsBud = await q(`SELECT campaign.name, campaign.status, campaign_budget.amount_micros
      FROM campaign WHERE campaign.id = ${TCS}`);
  if (tcsBud?.[0]) console.log(`  ${tcsBud[0].campaign?.name}: status=${nm(CAMPSTATUS, tcsBud[0].campaign?.status)}  budget=${$(usd(tcsBud[0].campaign_budget?.amount_micros))}/day`);

  hr("4. BRANDED SEARCH — post-rollback CPL, re-pull (8/26-9/3)");
  const brandRows = await q(`SELECT segments.date, metrics.cost_micros, metrics.all_conversions
      FROM campaign WHERE campaign.id = ${BRAND} AND segments.date BETWEEN '2026-08-26' AND '2026-09-03'`);
  if (brandRows) {
    const cost = brandRows.reduce((s: number, r: any) => s + usd(r.metrics?.cost_micros), 0);
    const conv = brandRows.reduce((s: number, r: any) => s + Number(r.metrics?.all_conversions ?? 0), 0);
    console.log(`  cost=${$(cost)}  all_conversions=${n1(conv)}  CPL=${conv > 0 ? $(cost/conv) : "n/a"}`);
  }

  console.log(`\nDONE — read only, no changes made.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig } from "./config.js";

/**
 * OCH Brand Awareness (23174695410) is a Performance Max campaign, not Search.
 * The earlier ad_group/ad_group_ad check returned 0 because PMax doesn't use
 * that structure — it uses asset_group / asset_group_asset. Check the real
 * resource so "restart Brand Awareness" is scoped correctly: is there existing
 * creative to re-enable, or does it need to be rebuilt from scratch?
 */

const CUSTOMER_ID = "8350689003";
const AWARE = "23174695410";

const hr = (t: string) => console.log(`\n${"=".repeat(88)}\n${t}\n${"=".repeat(88)}`);
const usd = (m: unknown) => Number(m ?? 0) / 1_000_000;
const $ = (n: number) => `$${n.toFixed(2)}`;
const n1 = (v: unknown) => Number(v ?? 0).toFixed(1);
const ASSETGROUPSTATUS: Record<string,string> = {"2":"ENABLED","3":"PAUSED","4":"REMOVED"};
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

  hr("OCH BRAND AWARENESS (23174695410) — Performance Max asset groups");
  const groups = await q(`SELECT asset_group.id, asset_group.name, asset_group.status
      FROM asset_group WHERE asset_group.campaign = 'customers/${CUSTOMER_ID}/campaigns/${AWARE}'`);
  if (groups) {
    console.log(`  Asset groups (${groups.length}):`);
    for (const r of groups) console.log(`    [${r.asset_group?.id}] ${r.asset_group?.name}  status=${nm(ASSETGROUPSTATUS, r.asset_group?.status)}`);
  }

  hr("ASSETS LINKED TO EACH ASSET GROUP (headlines, images, logos, etc.)");
  const linked = await q(`SELECT asset_group_asset.asset_group, asset_group_asset.field_type,
      asset_group_asset.status, asset.type, asset.name
      FROM asset_group_asset WHERE campaign.id = ${AWARE}`);
  if (linked) {
    console.log(`  Linked assets (${linked.length}):`);
    const byType: Record<string, number> = {};
    for (const r of linked) {
      const t = String(r.asset?.type ?? "UNKNOWN");
      byType[t] = (byType[t] ?? 0) + 1;
    }
    for (const [t, n] of Object.entries(byType)) console.log(`    ${t}: ${n}`);
  }

  hr("LIFETIME PERFORMANCE (all-time, not just last 30d)");
  const perf = await q(`SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.all_conversions
      FROM campaign WHERE campaign.id = ${AWARE} AND segments.date BETWEEN '2025-01-01' AND '2026-09-04'`);
  if (perf) {
    const impr = perf.reduce((s:number,r:any)=>s+Number(r.metrics?.impressions??0),0);
    const clicks = perf.reduce((s:number,r:any)=>s+Number(r.metrics?.clicks??0),0);
    const cost = perf.reduce((s:number,r:any)=>s+usd(r.metrics?.cost_micros),0);
    const conv = perf.reduce((s:number,r:any)=>s+Number(r.metrics?.all_conversions??0),0);
    console.log(`  Since 2025-01-01: impressions=${impr}  clicks=${clicks}  cost=${$(cost)}  all_conversions=${n1(conv)}  CPL=${conv>0?$(cost/conv):"n/a"}`);
  }

  hr("AUDIENCE/TARGETING SIGNALS — is this actually redundant with Branded Search?");
  console.log(`  Branded Search only captures people already typing the brand name into Search.`);
  console.log(`  PMax spans Search + Display + YouTube + Discover + Gmail. Whether it's redundant`);
  console.log(`  depends on what signal Google was given to steer it — brand-only vs broader intent.`);
  const signals = await q(`SELECT asset_group_signal.asset_group, asset_group_signal.audience.audience,
      asset_group_signal.search_theme.text
      FROM asset_group_signal WHERE campaign.id = ${AWARE}`);
  if (signals) {
    console.log(`  Signals configured (${signals.length}):`);
    for (const r of signals) {
      const ags = r.asset_group_signal ?? {};
      if (ags.search_theme?.text) console.log(`    SEARCH THEME: "${ags.search_theme.text}"`);
      else if (ags.audience?.audience) console.log(`    AUDIENCE: ${ags.audience.audience}`);
      else console.log(`    ${JSON.stringify(ags)}`);
    }
    if (!signals.length) console.log(`    None configured — PMax is running on Google's automatic signals only.`);
  }
  const geo = await q(`SELECT campaign_criterion.type, campaign_criterion.negative, campaign.name
      FROM campaign_criterion WHERE campaign.id = ${AWARE} AND campaign_criterion.type = 'KEYWORD'`);
  if (geo) console.log(`  Keyword-type criteria on this campaign: ${geo.length}`);

  hr("WHEN WAS IT PAUSED? (change_event, last 30 days only per API limit)");
  const changes = await q(`SELECT change_event.change_date_time, change_event.user_email,
      change_event.resource_change_operation, change_event.changed_fields
      FROM change_event
      WHERE change_event.change_date_time >= '2026-08-06' AND change_event.change_date_time <= '2026-09-05 00:00:00'
        AND change_event.campaign = 'customers/${CUSTOMER_ID}/campaigns/${AWARE}'
      ORDER BY change_event.change_date_time ASC LIMIT 50`);
  if (changes) {
    if (!changes.length) console.log(`  No changes to this campaign in the last 30 days — pause predates 8/6.`);
    for (const r of changes) console.log(`  ${r.change_event?.change_date_time}  ${r.change_event?.user_email}  ${r.change_event?.resource_change_operation}  fields=${(r.change_event?.changed_fields?.paths ?? []).join(",")}`);
  }

  console.log(`\nDONE — read only, no changes made.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

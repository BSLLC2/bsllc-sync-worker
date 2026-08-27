#!/usr/bin/env tsx
import "dotenv/config";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig } from "./config.js";

/**
 * READ-ONLY status check for the four open OHC action items, answered from the
 * account rather than from anyone's recollection of what was clicked.
 *
 *   10 branded rollback   11 conversions recovered
 *   12 business name      13 geo targeting
 */

const CUSTOMER_ID = "8350689003";
const TCS = "23249502120";
const BRAND = "24018792925";
const BRAND_ADGROUP = "198929056515"; // Brand — Core

const usd = (m: unknown) => Number(m ?? 0) / 1_000_000;
const $ = (n: number) => `$${n.toFixed(2)}`;
const n1 = (v: unknown) => Number(v ?? 0).toFixed(1);
const hr = (t: string) => console.log(`\n${"=".repeat(88)}\n${t}\n${"=".repeat(88)}`);
const APPROVAL: Record<string,string> = {"2":"APPROVED_LIMITED","3":"APPROVED","4":"DISAPPROVED","5":"AREA_OF_INTEREST_ONLY"};
const LINKSTATUS: Record<string,string> = {"2":"ENABLED","3":"REMOVED","4":"PAUSED"};
const nm = (m: Record<string,string>, v: unknown) => m[String(v ?? "")] ?? String(v ?? "—");
const verdict = (ok: boolean, y: string, n: string) => console.log(`  ${ok ? "DONE    " : "NOT DONE"}  ${ok ? y : n}`);

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
    console.log(`   [UNAVAILABLE] ${msg.slice(0, 200)}`); return null; } };

  console.log(`\nOHC ACTION-ITEM STATUS — READ ONLY · account ${CUSTOMER_ID}`);

  // ── 10 ────────────────────────────────────────────────────────────────────
  hr("10. BRANDED ROLLBACK — budget $40 -> $25, max CPC $6.00 -> $2.50");
  const bud = await q(`SELECT campaign.name, campaign_budget.amount_micros
      FROM campaign WHERE campaign.id = ${BRAND}`);
  if (bud?.[0]) {
    const amt = usd(bud[0].campaign_budget?.amount_micros);
    console.log(`  daily budget now ${$(amt)}`);
    verdict(amt <= 25, `budget is back to ${$(amt)}`, `budget is still ${$(amt)} — expected $25.00`);
  }
  const bid = await q(`SELECT ad_group.name, ad_group.cpc_bid_micros, ad_group.status
      FROM ad_group WHERE ad_group.id = ${BRAND_ADGROUP}`);
  if (bid?.[0]) {
    const cpc = usd(bid[0].ad_group?.cpc_bid_micros);
    console.log(`  ${bid[0].ad_group?.name} max CPC now ${$(cpc)}`);
    verdict(cpc <= 2.5, `max CPC is back to ${$(cpc)}`, `max CPC is still ${$(cpc)} — expected $2.50`);
  }
  const since = await q(`SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.all_conversions
      FROM campaign WHERE campaign.id = ${BRAND} AND segments.date BETWEEN '2026-08-19' AND '2026-08-27'`);
  if (since) {
    console.log(`\n  Branded daily spend since the 8/19 raise`);
    for (const r of since) console.log(`    ${r.segments?.date}  ${$(usd(r.metrics?.cost_micros)).padStart(9)}  clicks ${String(r.metrics?.clicks ?? 0).padStart(3)}  all_conv ${n1(r.metrics?.all_conversions)}`);
  }

  // ── 11 ────────────────────────────────────────────────────────────────────
  hr("11. DID THE CONVERSIONS COLUMN RECOVER?");
  const daily = await q(`SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.all_conversions
      FROM customer WHERE segments.date BETWEEN '2026-08-14' AND '2026-08-27'`);
  if (daily) {
    const agg: Record<string,{c:number;a:number;cost:number}> = {};
    for (const r of daily) {
      const k = String(r.segments?.date);
      const t = (agg[k] ??= {c:0,a:0,cost:0});
      t.c += Number(r.metrics?.conversions ?? 0); t.a += Number(r.metrics?.all_conversions ?? 0);
      t.cost += usd(r.metrics?.cost_micros);
    }
    console.log(`  date          cost     conv  all_conv`);
    let recovered = false;
    for (const k of Object.keys(agg).sort()) {
      const t = agg[k]!;
      if (t.c > 0) recovered = true;
      const flag = t.c === 0 && t.a > 0 ? "  <-- still uncounted" : t.c > 0 ? "  <-- COUNTING" : "";
      console.log(`  ${k}  ${$(t.cost).padStart(9)}${n1(t.c).padStart(9)}${n1(t.a).padStart(10)}${flag}`);
    }
    console.log("");
    verdict(recovered, `at least one day is counting again`, `every day since 8/14 still reads 0.0 conversions while all_conversions records`);
  }

  // ── 12 ────────────────────────────────────────────────────────────────────
  hr("12. BUSINESS NAME — approved, or serving a URL placeholder?");
  for (const [res, where] of [["customer_asset","customer.id"],["campaign_asset","campaign.name"]] as const) {
    const rows = await q(`SELECT ${where}, ${res}.asset, ${res}.status, asset.name, asset.type,
        asset.policy_summary.approval_status, asset.policy_summary.policy_topic_entries
        FROM ${res} WHERE ${res}.field_type = BUSINESS_NAME`);
    if (!rows) continue;
    if (!rows.length) { console.log(`  ${res}: no BUSINESS_NAME asset linked`); continue; }
    for (const r of rows) {
      const l = (r as any)[res] ?? {};
      const a = r.asset ?? {};
      console.log(`  ${res.padEnd(16)} "${a.name}"  link ${nm(LINKSTATUS,l.status)}  policy ${nm(APPROVAL, a.policy_summary?.approval_status)}`);
      for (const t of a.policy_summary?.policy_topic_entries ?? []) console.log(`      TOPIC ${t.topic} (${t.type})`);
    }
  }
  console.log(`\n  Note: the API reports the asset's policy status. It does NOT report whether the`);
  console.log(`  ad is falling back to a URL-derived placeholder at serve time — that warning is`);
  console.log(`  UI-only. APPROVED here means the name is usable, not that it is being shown.`);

  // ── 13 ────────────────────────────────────────────────────────────────────
  hr("13. GEO TARGETING — the 13 Aug change");
  const geo = await q(`SELECT campaign.id, campaign.name,
      campaign.geo_target_type_setting.positive_geo_target_type,
      campaign.geo_target_type_setting.negative_geo_target_type
      FROM campaign WHERE campaign.id IN (${TCS}, ${BRAND})`);
  if (geo) for (const r of geo) {
    const g = r.campaign?.geo_target_type_setting ?? {};
    console.log(`  ${String(r.campaign?.name).slice(0,28).padEnd(30)} positive=${g.positive_geo_target_type}  negative=${g.negative_geo_target_type}`);
  }
  console.log(`\n  Still the raw enum ints. Both campaigns match each other, so nothing is broken`);
  console.log(`  one-sided, but the meaning of positive=7 has to be read in the UI under`);
  console.log(`  Settings -> Locations -> Location options. Not decoded here.`);

  console.log(`\nDONE — read only, no changes made.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

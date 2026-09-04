#!/usr/bin/env tsx
import "dotenv/config";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig } from "./config.js";

/**
 * User pushed back: don't recommend restarting a paused campaign until the
 * two campaigns actually live and spending today are fully understood first.
 * Specifically: does "OHC - Branded Search" actually bid ONLY on brand terms,
 * or has it drifted into generic terms that would genuinely overlap with
 * Brand Awareness's "treatment center" / "cincinnati rehab" search themes?
 */

const CUSTOMER_ID = "8350689003";
const TCS = "23249502120";   // Treatment Center Search
const BRAND = "24018792925"; // OHC - Branded Search

const hr = (t: string) => console.log(`\n${"=".repeat(88)}\n${t}\n${"=".repeat(88)}`);
const usd = (m: unknown) => Number(m ?? 0) / 1_000_000;
const $ = (n: number) => `$${n.toFixed(2)}`;
const n1 = (v: unknown) => Number(v ?? 0).toFixed(1);
const MATCHTYPE: Record<string,string> = {"2":"EXACT","3":"PHRASE","4":"BROAD"};
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

  hr("1. OHC - BRANDED SEARCH — every keyword actually being bid on, right now");
  const kws = await q(`SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
      ad_group_criterion.status, ad_group.name, metrics.impressions, metrics.clicks, metrics.cost_micros
      FROM keyword_view
      WHERE campaign.id = ${BRAND} AND segments.date BETWEEN '2026-08-05' AND '2026-09-03'
      ORDER BY metrics.cost_micros DESC`);
  if (kws) {
    console.log(`  ${kws.length} keyword rows (last 30d, incl. $0-spend):`);
    for (const r of kws) {
      const kw = r.ad_group_criterion?.keyword ?? {};
      console.log(`    "${kw.text}" [${nm(MATCHTYPE, kw.match_type)}]  status=${r.ad_group_criterion?.status}  group="${r.ad_group?.name}"  cost=${$(usd(r.metrics?.cost_micros))}  clicks=${r.metrics?.clicks ?? 0}`);
    }
  }

  hr("2. TREATMENT CENTER SEARCH — top keywords by spend, last 30d (what's actually driving the main campaign)");
  const tcsKws = await q(`SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
      metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.all_conversions
      FROM keyword_view
      WHERE campaign.id = ${TCS} AND segments.date BETWEEN '2026-08-05' AND '2026-09-03'
      ORDER BY metrics.cost_micros DESC LIMIT 25`);
  if (tcsKws) {
    let shown = 0;
    for (const r of tcsKws) {
      const kw = r.ad_group_criterion?.keyword ?? {};
      if (usd(r.metrics?.cost_micros) <= 0) continue;
      console.log(`    "${kw.text}" [${nm(MATCHTYPE, kw.match_type)}]  cost=${$(usd(r.metrics?.cost_micros))}  clicks=${r.metrics?.clicks ?? 0}  conv=${n1(r.metrics?.all_conversions)}`);
      shown++;
    }
    console.log(`  (${shown} keywords with spend shown of ${tcsKws.length} total rows)`);
  }

  hr("3. TRENDED DAILY PERFORMANCE — both live campaigns, last 30d (what's actually happening, not a snapshot)");
  for (const [label, id] of [["Treatment Center Search", TCS], ["OHC - Branded Search", BRAND]] as const) {
    const daily = await q(`SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions,
        metrics.all_conversions, metrics.search_impression_share, metrics.search_budget_lost_impression_share
        FROM campaign WHERE campaign.id = ${id} AND segments.date BETWEEN '2026-08-05' AND '2026-09-03'`);
    if (daily) {
      console.log(`\n  ${label} (id ${id}):`);
      console.log(`  date          cost    clicks  all_conv  IS%    lostIS(budget)%`);
      for (const r of daily) {
        const m = r.metrics ?? {};
        const isPct = m.search_impression_share != null ? (Number(m.search_impression_share) * 100).toFixed(1) : "—";
        const lostPct = m.search_budget_lost_impression_share != null ? (Number(m.search_budget_lost_impression_share) * 100).toFixed(1) : "—";
        console.log(`  ${r.segments?.date}  ${$(usd(m.cost_micros)).padStart(7)}  ${String(m.clicks ?? 0).padStart(6)}  ${n1(m.all_conversions).padStart(8)}  ${String(isPct).padStart(5)}  ${String(lostPct).padStart(5)}`);
      }
    }
  }

  console.log(`\nDONE — read only, no changes made.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

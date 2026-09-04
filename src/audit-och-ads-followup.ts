#!/usr/bin/env tsx
import "dotenv/config";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig } from "./config.js";

/**
 * READ-ONLY follow-up audit for OHC Google Ads, one week after the client was
 * briefed on: phone answer-rate findings, the branded rollback, and a 4-part
 * Priority 2 (Brand Awareness restart, $500/mo reinvestment, +25% main
 * campaign, structure rebuild). Answers one question: is any of that still
 * accurate, and did the recommended changes actually get made?
 *
 *   npm run audit-och-ads-followup
 */

const CUSTOMER_ID = "8350689003";
const TCS = "23249502120";   // Treatment Center Search (the "main campaign")
const BRAND = "24018792925"; // OHC - Branded Search
const AWARE = "23174695410"; // OCH Brand Awareness

const CUR = { from: "2026-08-05", to: "2026-09-03" };   // trailing 30d, ending yesterday
const PRIOR = { from: "2026-07-06", to: "2026-08-04" }; // prior 30d
const CHANGE_FROM = "2026-08-05"; // covers the branded rollback + anything since the brief

const usd = (m: unknown) => Number(m ?? 0) / 1_000_000;
const $ = (n: number) => `$${n.toFixed(2)}`;
const n1 = (v: unknown) => Number(v ?? 0).toFixed(1);
const hr = (t: string) => console.log(`\n${"=".repeat(94)}\n${t}\n${"=".repeat(94)}`);
const CAMPSTATUS: Record<string,string> = {"2":"ENABLED","3":"PAUSED","4":"REMOVED"};
const CHANGE_RES: Record<string,string> = {"2":"AD","3":"AD_GROUP","4":"AD_GROUP_CRITERION","5":"CAMPAIGN","6":"CAMPAIGN_BUDGET","7":"AD_GROUP_BID_MODIFIER","8":"CAMPAIGN_CRITERION","13":"AD_GROUP_AD","14":"ASSET"};
const CHANGE_OP: Record<string,string> = {"2":"CREATE","3":"UPDATE","4":"REMOVE"};
const nm = (m: Record<string,string>, v: unknown) => m[String(v ?? "")] ?? String(v ?? "—");

async function main() {
  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });
  let c: any;
  try {
    c = api.Customer({ customer_id: CUSTOMER_ID, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
    await c.query(`SELECT customer.id FROM customer LIMIT 1`);
  } catch { c = api.Customer({ customer_id: CUSTOMER_ID, refresh_token: cfg.refreshToken }); }
  const q = async (g: string) => { try { return await c.query(g); } catch (e: any) {
    console.log(`   [UNAVAILABLE] ${(e?.errors?.map((x:any)=>x.message).join("; ") || e?.message || String(e)).slice(0,220)}`); return null; } };

  console.log(`\nOHC ADS — ONE-WEEK FOLLOW-UP AUDIT · READ ONLY · account ${CUSTOMER_ID}`);
  console.log(`Reconciling against the client brief sent ~2026-08-28.`);

  // ── A. Every campaign, current state ────────────────────────────────────
  hr("A. ALL CAMPAIGNS — current status, budget, spend trailing 30d");
  const camps = await q(`SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros,
      metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.all_conversions
      FROM campaign WHERE segments.date BETWEEN '${CUR.from}' AND '${CUR.to}'`);
  if (camps) {
    const agg: Record<string, any> = {};
    for (const r of camps) {
      const k = String(r.campaign?.name);
      const t = (agg[k] ??= { id: r.campaign?.id, status: r.campaign?.status, bud: usd(r.campaign_budget?.amount_micros), cost: 0, cl: 0, cv: 0, ac: 0 });
      t.cost += usd(r.metrics?.cost_micros); t.cl += Number(r.metrics?.clicks ?? 0);
      t.cv += Number(r.metrics?.conversions ?? 0); t.ac += Number(r.metrics?.all_conversions ?? 0);
    }
    for (const [k, t] of Object.entries(agg).sort((a: any, b: any) => b[1].cost - a[1].cost)) {
      console.log(`\n  ${k}  [${t.id}]  ${nm(CAMPSTATUS, t.status)}`);
      console.log(`    daily budget ${$(t.bud)}   30d spend ${$(t.cost)}   clicks ${t.cl}   conv ${n1(t.cv)}   all_conv ${n1(t.ac)}   CPL(all) ${t.ac ? $(t.cost/t.ac) : "n/a"}`);
    }
    const total = Object.values(agg).reduce((s: number, t: any) => s + t.cost, 0);
    console.log(`\n  TOTAL 30d spend: ${$(total)}`);
    console.log(`  Brief said ~$6,000/mo ($4,300 calls + $1,600 forms). Compare against the total above.`);
  }

  // ── B. Brand Awareness — was it restarted? ──────────────────────────────
  hr("B. OCH BRAND AWARENESS — restarted per Priority 2 item 1?");
  const awareAds = await q(`SELECT ad_group.name, ad_group.status, ad_group_ad.status, ad_group_ad.ad.id
      FROM ad_group_ad WHERE campaign.id = ${AWARE}`);
  if (awareAds) {
    console.log(`  ${awareAds.length} ad rows returned.`);
    for (const r of awareAds) console.log(`    ${r.ad_group?.name}  adgroup ${nm(CAMPSTATUS,r.ad_group?.status)}  ad ${nm(CAMPSTATUS,r.ad_group_ad?.status)}`);
    if (!awareAds.length) console.log(`  STILL NO ADS. Not restarted.`);
  }
  const awareSpend = await q(`SELECT metrics.impressions, metrics.cost_micros, metrics.all_conversions
      FROM campaign WHERE campaign.id = ${AWARE} AND segments.date BETWEEN '${CUR.from}' AND '${CUR.to}'`);
  if (awareSpend) {
    const imp = awareSpend.reduce((s: number, r: any) => s + Number(r.metrics?.impressions ?? 0), 0);
    const cost = awareSpend.reduce((s: number, r: any) => s + usd(r.metrics?.cost_micros), 0);
    console.log(`  Trailing 30d: impressions ${imp}, spend ${$(cost)}.`);
  }

  // ── C. Branded campaign — the piece the user says "was not successful" ──
  hr("C. OHC - BRANDED SEARCH — did the rollback help, and was there a separate 'branded keyword' change?");
  for (const [label, w] of [["PRIOR 30d", PRIOR], ["CURRENT 30d", CUR]] as const) {
    const rows = await q(`SELECT campaign_budget.amount_micros, metrics.cost_micros, metrics.clicks,
        metrics.all_conversions, metrics.search_impression_share
        FROM campaign WHERE campaign.id = ${BRAND} AND segments.date BETWEEN '${w.from}' AND '${w.to}'`);
    if (!rows) continue;
    const cost = rows.reduce((s: number, r: any) => s + usd(r.metrics?.cost_micros), 0);
    const cl = rows.reduce((s: number, r: any) => s + Number(r.metrics?.clicks ?? 0), 0);
    const ac = rows.reduce((s: number, r: any) => s + Number(r.metrics?.all_conversions ?? 0), 0);
    const isAvg = rows.length ? rows.reduce((s: number, r: any) => s + Number(r.metrics?.search_impression_share ?? 0), 0) / rows.length : 0;
    console.log(`  ${label} (${w.from}..${w.to}): spend ${$(cost)}  clicks ${cl}  all_conv ${n1(ac)}  CPL ${ac ? $(cost/ac) : "n/a"}  IS ${(isAvg*100).toFixed(1)}%`);
  }
  const brandKw = await q(`SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
      ad_group_criterion.status, metrics.cost_micros, metrics.clicks, metrics.all_conversions
      FROM keyword_view WHERE campaign.id = ${BRAND} AND segments.date BETWEEN '${CUR.from}' AND '${CUR.to}'`);
  if (brandKw) {
    console.log(`\n  Branded keywords, trailing 30d:`);
    for (const r of brandKw) {
      const c = r.ad_group_criterion?.keyword ?? {};
      console.log(`    [${nm({"2":"EXACT","3":"PHRASE","4":"BROAD"}, c.match_type)}] ${c.text}   ${nm(CAMPSTATUS, r.ad_group_criterion?.status)}   cost ${$(usd(r.metrics?.cost_micros))}   clicks ${r.metrics?.clicks ?? 0}   all_conv ${n1(r.metrics?.all_conversions)}`);
    }
  }

  // ── D. Main campaign — was it increased 25%? ────────────────────────────
  hr("D. TREATMENT CENTER SEARCH ('the main campaign') — budget history + performance");
  const tcsBudNow = await q(`SELECT campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${TCS}`);
  if (tcsBudNow?.[0]) console.log(`  Current daily budget: ${$(usd(tcsBudNow[0].campaign_budget?.amount_micros))}`);
  for (const [label, w] of [["PRIOR 30d", PRIOR], ["CURRENT 30d", CUR]] as const) {
    const rows = await q(`SELECT metrics.cost_micros, metrics.clicks, metrics.all_conversions,
        metrics.search_impression_share, metrics.search_budget_lost_impression_share
        FROM campaign WHERE campaign.id = ${TCS} AND segments.date BETWEEN '${w.from}' AND '${w.to}'`);
    if (!rows) continue;
    const cost = rows.reduce((s: number, r: any) => s + usd(r.metrics?.cost_micros), 0);
    const ac = rows.reduce((s: number, r: any) => s + Number(r.metrics?.all_conversions ?? 0), 0);
    const bl = rows.length ? rows.reduce((s: number, r: any) => s + Number(r.metrics?.search_budget_lost_impression_share ?? 0), 0) / rows.length : 0;
    console.log(`  ${label}: spend ${$(cost)}  all_conv ${n1(ac)}  CPL ${ac ? $(cost/ac) : "n/a"}  IS lost to budget ${(bl*100).toFixed(1)}%`);
  }

  // ── E. Change log since the brief ───────────────────────────────────────
  hr(`E. EVERY CHANGE SINCE ${CHANGE_FROM} — what actually got implemented`);
  const changes = await q(`SELECT change_event.change_date_time, change_event.user_email,
      change_event.change_resource_type, change_event.resource_change_operation,
      change_event.changed_fields, change_event.old_resource, change_event.new_resource,
      change_event.campaign
      FROM change_event
     WHERE change_event.change_date_time >= '${CHANGE_FROM}' AND change_event.change_date_time <= '2026-09-04 00:00:00'
     ORDER BY change_event.change_date_time ASC LIMIT 500`);
  if (changes) {
    if (!changes.length) console.log(`  NO CHANGES LOGGED since ${CHANGE_FROM}. Nothing from the brief has been implemented yet.`);
    const cid = (rn: unknown) => String(rn ?? "").split("/").pop() ?? "";
    for (const r of changes) {
      const e = r.change_event ?? {};
      const res = nm(CHANGE_RES, e.change_resource_type);
      const cf = e.changed_fields?.paths ?? e.changed_fields ?? [];
      const fields = Array.isArray(cf) ? cf.join(",") : String(cf);
      console.log(`  ${String(e.change_date_time).slice(0,16)}  ${nm(CHANGE_OP, e.resource_change_operation).padEnd(6)} ${res.padEnd(16)} ${String(e.user_email ?? "?").padEnd(22)} camp:${cid(e.campaign).padEnd(12)} ${fields.slice(0,80)}`);
      if (res === "CAMPAIGN_BUDGET" || res === "CAMPAIGN") {
        if (e.old_resource) console.log(`      OLD: ${JSON.stringify(e.old_resource).slice(0,220)}`);
        if (e.new_resource) console.log(`      NEW: ${JSON.stringify(e.new_resource).slice(0,220)}`);
      }
    }
  }

  // ── F. Conversion counting — still trustworthy? ─────────────────────────
  hr("F. CONVERSION COLUMN — still counting correctly since the 8/26 recovery?");
  const daily = await q(`SELECT segments.date, metrics.conversions, metrics.all_conversions, metrics.cost_micros
      FROM customer WHERE segments.date BETWEEN '2026-08-26' AND '${CUR.to}'`);
  if (daily) {
    const agg: Record<string, {c:number;a:number;cost:number}> = {};
    for (const r of daily) {
      const k = String(r.segments?.date);
      const t = (agg[k] ??= {c:0,a:0,cost:0});
      t.c += Number(r.metrics?.conversions ?? 0); t.a += Number(r.metrics?.all_conversions ?? 0);
      t.cost += usd(r.metrics?.cost_micros);
    }
    let brokenDays = 0;
    for (const k of Object.keys(agg).sort()) {
      const t = agg[k]!;
      const flag = t.c === 0 && t.a > 0 ? "  <-- still uncounted" : "";
      if (flag) brokenDays++;
      console.log(`    ${k}  cost ${$(t.cost).padStart(9)}  conv ${n1(t.c).padStart(6)}  all_conv ${n1(t.a).padStart(6)}${flag}`);
    }
    console.log(`\n  ${brokenDays} of ${Object.keys(agg).length} days since 8/26 still show conv=0 while all_conv>0.`);
  }

  console.log(`\nDONE — read only, no changes made.\n`);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

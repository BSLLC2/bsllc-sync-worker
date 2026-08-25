#!/usr/bin/env tsx
import "dotenv/config";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig } from "./config.js";

/**
 * READ-ONLY diagnostic for OHC's Google Ads account. Answers a specific
 * 13-part question about whether paid performance degraded or measurement
 * changed. Runs no mutates of any kind.
 *
 * The customer id is pinned rather than resolved from connector_mappings so a
 * mis-mapped connector cannot silently point this at the wrong account.
 *
 *   npm run diagnose-och-ads
 */

const CUSTOMER_ID = "8350689003";
const CUR = { from: "2026-07-26", to: "2026-08-24" };
const PRIOR = { from: "2026-06-26", to: "2026-07-25" };
const SERIES = { from: "2026-06-26", to: "2026-08-24" };
const D90 = { from: "2026-05-27", to: "2026-08-24" };  // trailing 90 days; GAQL has no LAST_90_DAYS literal
const TCS = "23249502120";   // Treatment Center Search
const BRAND = "24018792925"; // OHC - Branded Search

const usd = (m: unknown) => Number(m ?? 0) / 1_000_000;
const $ = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: unknown) => `${(Number(n ?? 0) * 100).toFixed(1)}%`;
const n1 = (v: unknown) => Number(v ?? 0).toFixed(1);
const d = (v: unknown, digits = 2) => Number(v ?? 0).toFixed(digits);
function delta(cur: number, prior: number, money = false): string {
  const diff = cur - prior;
  const p = prior === 0 ? "n/a" : `${diff >= 0 ? "+" : ""}${((diff / prior) * 100).toFixed(1)}%`;
  const v = money ? `${diff >= 0 ? "+" : "-"}$${Math.abs(diff).toFixed(2)}` : `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}`;
  return `${v} (${p})`;
}
/**
 * Section gating. The full run is far longer than a retrievable log tail, so
 * SECTION=a prints items 1-7 and SECTION=b prints items 8-13. Every query still
 * runs (all read-only); only the printing is gated, which keeps the numbered
 * blocks untouched. Preamble output is section 0 and always prints.
 */
const WANT: Set<number> = (() => {
  const s = String(process.env.SECTION ?? "").trim().toLowerCase();
  const nums = s.match(/\d+/g);
  if (nums) return new Set([0, ...nums.map(Number)]);
  if (s === "a") return new Set([0,1,2,3,4,5,6,7]);
  if (s === "b") return new Set([0,8,9,10,11,12,13]);
  return new Set([0,1,2,3,4,5,6,7,8,9,10,11,12,13]);
})();
const realLog = console.log.bind(console);
let SEC = 0;
console.log = ((...a: unknown[]) => { if (WANT.has(SEC)) realLog(...a); }) as typeof console.log;
const hr = (t: string) => { const m = /^\s*(\d+)\./.exec(t); if (m) SEC = Number(m[1]); console.log(`\n${"=".repeat(96)}\n${t}\n${"=".repeat(96)}`); };
const note = (t: string) => console.log(`   ${t}`);

/** Enum ints come back over REST; only decode the ones that change a reading. */
const CATEGORY: Record<string,string> = {"2":"DEFAULT","3":"PAGE_VIEW","4":"PURCHASE","5":"SIGNUP","6":"LEAD","7":"DOWNLOAD","8":"ADD_TO_CART","9":"BEGIN_CHECKOUT","11":"PHONE_CALL_LEAD","12":"IMPORTED_LEAD","13":"SUBMIT_LEAD_FORM","14":"BOOK_APPOINTMENT","15":"REQUEST_QUOTE","16":"GET_DIRECTIONS","17":"OUTBOUND_CLICK","18":"CONTACT","19":"ENGAGEMENT","20":"STORE_VISIT","22":"QUALIFIED_LEAD","23":"CONVERTED_LEAD"};
const CSTATUS: Record<string,string> = {"2":"ENABLED","3":"REMOVED","4":"HIDDEN"};
const COUNTING: Record<string,string> = {"2":"ONE_PER_CLICK","3":"MANY_PER_CLICK"};
const ATTR: Record<string,string> = {"2":"EXTERNALLY_ATTRIBUTED","3":"GOOGLE_ADS_LAST_CLICK","4":"GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN","5":"GOOGLE_SEARCH_ATTRIBUTION_FIRST_CLICK","6":"GOOGLE_SEARCH_ATTRIBUTION_LINEAR","7":"GOOGLE_SEARCH_ATTRIBUTION_TIME_DECAY","8":"GOOGLE_SEARCH_ATTRIBUTION_POSITION_BASED"};
const MATCH: Record<string,string> = {"2":"EXACT","3":"PHRASE","4":"BROAD"};
const APPROVAL: Record<string,string> = {"2":"APPROVED_LIMITED","3":"APPROVED","4":"DISAPPROVED","5":"AREA_OF_INTEREST_ONLY"};
const CHANGE_RES: Record<string,string> = {"2":"AD","3":"AD_GROUP","4":"AD_GROUP_CRITERION","5":"CAMPAIGN","6":"CAMPAIGN_BUDGET","7":"AD_GROUP_BID_MODIFIER","8":"CAMPAIGN_CRITERION","9":"FEED","10":"FEED_ITEM","11":"CAMPAIGN_FEED","12":"AD_GROUP_FEED","13":"AD_GROUP_AD","14":"ASSET","15":"CUSTOMER_ASSET","16":"CAMPAIGN_ASSET","17":"AD_GROUP_ASSET","18":"ASSET_SET","19":"ASSET_SET_ASSET","20":"CAMPAIGN_ASSET_SET"};
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
  const who = await c.query(`SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1`);
  const cu = who[0]?.customer ?? {};
  console.log(`\nOHC Google Ads — READ ONLY DIAGNOSTIC`);
  console.log(`account ${cu.id} · ${cu.descriptive_name} · ${cu.currency_code} · ${cu.time_zone}`);
  console.log(`CURRENT ${CUR.from}..${CUR.to}   PRIOR ${PRIOR.from}..${PRIOR.to}`);

  const q = async (gaql: string) => { try { return await c.query(gaql); } catch (e: any) {
    const msg = e?.errors?.map((x: any) => x.message).join("; ") || e?.message || String(e);
    console.log(`   [QUERY UNAVAILABLE] ${msg.slice(0, 240)}`); return null; } };

  // ── 1. CHANGE HISTORY ────────────────────────────────────────────────────
  hr("1. CHANGE HISTORY  (change_event, 2026-07-01 .. 2026-08-24)");
  note(`Range: 2026-07-01 to 2026-08-24. change_event is capped at 30 days by the API,`);
  note(`so this is queried in windows and merged. Ordered oldest first.`);
  const windows = [["2026-07-01","2026-07-28"],["2026-07-29","2026-08-24"]];
  let anyChange = false;
  for (const [f,t] of windows) {
    const rows = await q(`
      SELECT change_event.change_date_time, change_event.user_email, change_event.change_resource_type,
             change_event.resource_change_operation, change_event.changed_fields,
             change_event.old_resource, change_event.new_resource, change_event.client_type,
             change_event.campaign, change_event.ad_group
        FROM change_event
       WHERE change_event.change_date_time >= '${f}' AND change_event.change_date_time <= '${t} 23:59:59'
       ORDER BY change_event.change_date_time ASC
       LIMIT 10000`);
    if (!rows) continue;
    if (!rows.length) { note(`(no change events ${f}..${t})`); continue; }
    anyChange = true;
    console.log(`\n  --- ${f} .. ${t} : ${rows.length} events ---`);
    for (const r of rows) {
      const e = r.change_event ?? {};
      console.log(`\n  ${e.change_date_time}  ${nm(CHANGE_OP, e.resource_change_operation)}  ${nm(CHANGE_RES, e.change_resource_type)}`);
      console.log(`     user: ${e.user_email ?? "(none)"}   client: ${e.client_type ?? "?"}`);
      if (e.campaign) console.log(`     campaign: ${e.campaign}`);
      if (e.ad_group) console.log(`     ad_group: ${e.ad_group}`);
      const cf = e.changed_fields?.paths ?? e.changed_fields ?? null;
      if (cf) console.log(`     changed_fields: ${JSON.stringify(cf).slice(0, 400)}`);
      if (e.old_resource) console.log(`     OLD: ${JSON.stringify(e.old_resource).slice(0, 500)}`);
      if (e.new_resource) console.log(`     NEW: ${JSON.stringify(e.new_resource).slice(0, 500)}`);
    }
  }
  if (!anyChange) note(`No change events returned for the whole range.`);

  // ── 2. CONVERSION ACTION AUDIT ───────────────────────────────────────────
  hr("2. CONVERSION ACTION AUDIT");
  note(`Config as of today (not period-scoped).`);
  const actions = await q(`
    SELECT conversion_action.id, conversion_action.name, conversion_action.category,
           conversion_action.status, conversion_action.type, conversion_action.primary_for_goal,
           conversion_action.counting_type,
           conversion_action.attribution_model_settings.attribution_model,
           conversion_action.attribution_model_settings.data_driven_model_status,
           conversion_action.click_through_lookback_window_days,
           conversion_action.view_through_lookback_window_days,
           conversion_action.value_settings.default_value,
           conversion_action.value_settings.always_use_default_value,
           conversion_action.include_in_conversions_metric
      FROM conversion_action`);
  if (actions) {
    console.log(`\n  ${"name".padEnd(38)}${"category".padEnd(20)}${"status".padEnd(10)}${"primary".padEnd(10)}${"counting".padEnd(16)}${"attribution".padEnd(42)}${"ctc win".padEnd(9)}`);
    for (const a of actions) {
      const x = a.conversion_action ?? {};
      const prim = x.primary_for_goal === true ? "YES" : x.primary_for_goal === false ? "no" : "NOT RPTD";
      console.log(`  ${String(x.name).slice(0,37).padEnd(38)}${nm(CATEGORY,x.category).padEnd(20)}${nm(CSTATUS,x.status).padEnd(10)}${prim.padEnd(10)}` +
        `${nm(COUNTING,x.counting_type).padEnd(16)}${nm(ATTR,x.attribution_model_settings?.attribution_model).padEnd(42)}${String(x.click_through_lookback_window_days ?? "?").padEnd(9)}`);
      const v = x.value_settings ?? {};
      if (v.always_use_default_value) console.log(`      ^ ALWAYS_USE_DEFAULT_VALUE = ${usd(Number(v.default_value ?? 0)*1_000_000).toFixed(2)}`);
      if (x.include_in_conversions_metric === false) console.log(`      ^ include_in_conversions_metric = FALSE (excluded from the Conversions column)`);
    }
  }
  for (const [label, p] of [["CURRENT", CUR], ["PRIOR", PRIOR]] as const) {
    const rows = await q(`
      SELECT segments.conversion_action_name, segments.conversion_action_category,
             metrics.conversions, metrics.all_conversions, metrics.conversions_value, metrics.all_conversions_value
        FROM customer WHERE segments.date BETWEEN '${p.from}' AND '${p.to}'`);
    if (!rows) continue;
    const agg: Record<string, {c:number;a:number}> = {};
    for (const r of rows) {
      const k = r.segments?.conversion_action_name ?? "(unnamed)";
      const t = (agg[k] ??= {c:0,a:0});
      t.c += Number(r.metrics?.conversions ?? 0); t.a += Number(r.metrics?.all_conversions ?? 0);
    }
    console.log(`\n  ${label} ${p.from}..${p.to} — conversions / all_conversions by action`);
    if (!Object.keys(agg).length) console.log(`    (none)`);
    for (const [k,t] of Object.entries(agg).sort((x,y)=>y[1].a-x[1].a))
      console.log(`    ${k.slice(0,50).padEnd(52)} conv ${n1(t.c).padStart(8)}   all_conv ${n1(t.a).padStart(8)}`);
  }

  // ── 3. CONVERSION LAG ────────────────────────────────────────────────────
  hr("3. CONVERSION LAG");
  note(`Distribution from the account's own lag buckets, last 90 days of click dates.`);
  const lag = await q(`
    SELECT customer.id, segments.conversion_lag_bucket, metrics.conversions, metrics.all_conversions
      FROM customer WHERE segments.date BETWEEN '${D90.from}' AND '${D90.to}'`);
  if (lag) {
    const agg: Record<string,{c:number;a:number}> = {};
    for (const r of lag) {
      const k = String(r.segments?.conversion_lag_bucket ?? "?");
      const t = (agg[k] ??= {c:0,a:0});
      t.c += Number(r.metrics?.conversions ?? 0); t.a += Number(r.metrics?.all_conversions ?? 0);
    }
    const tot = Object.values(agg).reduce((s,t)=>s+t.a,0);
    console.log(`\n  ${"lag bucket (enum)".padEnd(30)}${"conversions".padStart(13)}${"all_conv".padStart(12)}${"share".padStart(9)}`);
    for (const [k,t] of Object.entries(agg).sort((a,b)=>Number(a[0])-Number(b[0])))
      console.log(`  ${k.padEnd(30)}${n1(t.c).padStart(13)}${n1(t.a).padStart(12)}${(tot? (t.a/tot*100).toFixed(1)+"%":"—").padStart(9)}`);
    note(`\n  Bucket enum ordering is ascending by lag. Decode against the API reference`);
    note(`  before quoting exact day thresholds — the integers are not day counts.`);
  }
  // Same-period restatement check: conversions by click date for the current window.
  const byday = await q(`
    SELECT segments.date, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.all_conversions
      FROM customer WHERE segments.date BETWEEN '${SERIES.from}' AND '${SERIES.to}' ORDER BY segments.date`);
  if (byday) {
    console.log(`\n  DAILY SERIES ${SERIES.from}..${SERIES.to} (conversions are dated to the CLICK)`);
    console.log(`  ${"date".padEnd(12)}${"cost".padStart(10)}${"clicks".padStart(8)}${"conv".padStart(8)}${"all_conv".padStart(10)}`);
    const agg: Record<string,{cost:number;cl:number;cv:number;ac:number}> = {};
    for (const r of byday) {
      const k = r.segments?.date; const t = (agg[k] ??= {cost:0,cl:0,cv:0,ac:0});
      t.cost += usd(r.metrics?.cost_micros); t.cl += Number(r.metrics?.clicks ?? 0);
      t.cv += Number(r.metrics?.conversions ?? 0); t.ac += Number(r.metrics?.all_conversions ?? 0);
    }
    for (const [k,t] of Object.entries(agg).sort())
      console.log(`  ${k.padEnd(12)}${$(t.cost).padStart(10)}${String(t.cl).padStart(8)}${n1(t.cv).padStart(8)}${n1(t.ac).padStart(10)}`);
  }

  // ── 4. CAMPAIGN PERFORMANCE ──────────────────────────────────────────────
  hr("4. CAMPAIGN PERFORMANCE, BOTH PERIODS");
  const camp: Record<string, Record<string, any>> = {};
  for (const [label,p] of [["CUR",CUR],["PRI",PRIOR]] as const) {
    const rows = await q(`
      SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions,
             metrics.all_conversions, metrics.average_cpc, metrics.ctr,
             metrics.search_impression_share, metrics.search_budget_lost_impression_share,
             metrics.search_rank_lost_impression_share, metrics.top_impression_percentage,
             metrics.absolute_top_impression_percentage
        FROM campaign WHERE segments.date BETWEEN '${p.from}' AND '${p.to}'`);
    if (!rows) continue;
    for (const r of rows) {
      const id = String(r.campaign?.id); const m = r.metrics ?? {};
      const t = ((camp[id] ??= {}) [label] ??= { name: r.campaign?.name, imp:0, cl:0, cost:0, cv:0, ac:0, is:0, bl:0, rl:0, top:0, atop:0 });
      t.imp += Number(m.impressions ?? 0); t.cl += Number(m.clicks ?? 0); t.cost += usd(m.cost_micros);
      t.cv += Number(m.conversions ?? 0); t.ac += Number(m.all_conversions ?? 0);
      t.is = Number(m.search_impression_share ?? 0); t.bl = Number(m.search_budget_lost_impression_share ?? 0);
      t.rl = Number(m.search_rank_lost_impression_share ?? 0);
      t.top = Number(m.top_impression_percentage ?? 0); t.atop = Number(m.absolute_top_impression_percentage ?? 0);
    }
  }
  for (const [id, per] of Object.entries(camp)) {
    const cur = per.CUR ?? {imp:0,cl:0,cost:0,cv:0,ac:0,is:0,bl:0,rl:0,top:0,atop:0,name:"(no data current)"};
    const pri = per.PRI ?? {imp:0,cl:0,cost:0,cv:0,ac:0,is:0,bl:0,rl:0,top:0,atop:0,name:cur.name};
    console.log(`\n  ${cur.name ?? pri.name}  [${id}]`);
    const row = (lbl: string, a: number, b: number, fmt: (n:number)=>string, money=false) =>
      console.log(`    ${lbl.padEnd(34)}${fmt(a).padStart(12)}${fmt(b).padStart(12)}   ${delta(a,b,money)}`);
    console.log(`    ${"metric".padEnd(34)}${"CURRENT".padStart(12)}${"PRIOR".padStart(12)}   delta`);
    row("impressions", cur.imp, pri.imp, (n)=>String(n));
    row("clicks", cur.cl, pri.cl, (n)=>String(n));
    row("cost", cur.cost, pri.cost, $, true);
    row("conversions", cur.cv, pri.cv, n1);
    row("all_conversions", cur.ac, pri.ac, n1);
    row("cost / conversion", cur.cv? cur.cost/cur.cv:0, pri.cv? pri.cost/pri.cv:0, $, true);
    row("cost / all_conversion", cur.ac? cur.cost/cur.ac:0, pri.ac? pri.cost/pri.ac:0, $, true);
    row("avg CPC", cur.cl? cur.cost/cur.cl:0, pri.cl? pri.cost/pri.cl:0, $, true);
    row("CTR", cur.imp? cur.cl/cur.imp*100:0, pri.imp? pri.cl/pri.imp*100:0, (n)=>`${n.toFixed(2)}%`);
    row("search impression share", cur.is*100, pri.is*100, (n)=>`${n.toFixed(1)}%`);
    row("IS lost (budget)", cur.bl*100, pri.bl*100, (n)=>`${n.toFixed(1)}%`);
    row("IS lost (rank)", cur.rl*100, pri.rl*100, (n)=>`${n.toFixed(1)}%`);
    row("top-of-page rate", cur.top*100, pri.top*100, (n)=>`${n.toFixed(1)}%`);
    row("abs top-of-page rate", cur.atop*100, pri.atop*100, (n)=>`${n.toFixed(1)}%`);
  }

  // ── 5. WHERE THE INCREMENTAL SPEND WENT ──────────────────────────────────
  hr("5. WHERE THE INCREMENTAL SPEND WENT");
  const spendBy = async (level: "campaign"|"ad_group"|"keyword") => {
    const sel = level === "campaign"
      ? `campaign.name` : level === "ad_group"
      ? `campaign.name, ad_group.name`
      : `campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type`;
    const from = level === "keyword" ? "keyword_view" : level === "ad_group" ? "ad_group" : "campaign";
    const out: Record<string, {cur:number;pri:number;ccv:number;pcv:number;cac:number;pac:number}> = {};
    for (const [label,p] of [["cur",CUR],["pri",PRIOR]] as const) {
      const rows = await q(`SELECT ${sel}, metrics.cost_micros, metrics.conversions, metrics.all_conversions
        FROM ${from} WHERE segments.date BETWEEN '${p.from}' AND '${p.to}'`);
      if (!rows) return null;
      for (const r of rows) {
        const key = level === "campaign" ? r.campaign?.name
          : level === "ad_group" ? `${r.campaign?.name} › ${r.ad_group?.name}`
          : `${r.campaign?.name} › ${r.ad_group?.name} › [${nm(MATCH, r.ad_group_criterion?.keyword?.match_type)}] ${r.ad_group_criterion?.keyword?.text}`;
        const t = (out[key] ??= {cur:0,pri:0,ccv:0,pcv:0,cac:0,pac:0});
        const cost = usd(r.metrics?.cost_micros), cv = Number(r.metrics?.conversions ?? 0), ac = Number(r.metrics?.all_conversions ?? 0);
        if (label === "cur") { t.cur += cost; t.ccv += cv; t.cac += ac; } else { t.pri += cost; t.pcv += cv; t.pac += ac; }
      }
    }
    return out;
  };
  for (const level of ["campaign","ad_group","keyword"] as const) {
    const out = await spendBy(level);
    if (!out) continue;
    console.log(`\n  BY ${level.toUpperCase()} — sorted by absolute dollar change`);
    console.log(`  ${"".padEnd(74)}${"CUR $".padStart(11)}${"PRIOR $".padStart(11)}${"Δ$".padStart(11)}${"Δconv".padStart(9)}${"Δallcv".padStart(9)}`);
    const rows = Object.entries(out).sort((a,b)=>Math.abs(b[1].cur-b[1].pri)-Math.abs(a[1].cur-a[1].pri));
    let sum = 0;
    for (const [k,t] of rows.slice(0, 40)) {
      sum += (t.cur - t.pri);
      console.log(`  ${k.slice(0,73).padEnd(74)}${$(t.cur).padStart(11)}${$(t.pri).padStart(11)}${((t.cur-t.pri>=0?"+":"-")+"$"+Math.abs(t.cur-t.pri).toFixed(2)).padStart(11)}${n1(t.ccv-t.pcv).padStart(9)}${n1(t.cac-t.pac).padStart(9)}`);
    }
    const total = rows.reduce((s,[,t])=>s+(t.cur-t.pri),0);
    console.log(`  ${"TOTAL CHANGE (all rows)".padEnd(74)}${"".padStart(22)}${((total>=0?"+":"-")+"$"+Math.abs(total).toFixed(2)).padStart(11)}`);
  }

  // ── 6 & 7. WINDOW COMPARISONS ────────────────────────────────────────────
  const windowCompare = async (label: string, campaignId: string, a: {from:string;to:string}, b: {from:string;to:string}) => {
    const grab = async (p: {from:string;to:string}) => {
      const rows = await q(`SELECT campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros,
        metrics.conversions, metrics.all_conversions, metrics.search_impression_share,
        metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
        FROM campaign WHERE campaign.id = ${campaignId} AND segments.date BETWEEN '${p.from}' AND '${p.to}'`);
      if (!rows) return null;
      const t = {imp:0,cl:0,cost:0,cv:0,ac:0,is:0,bl:0,rl:0};
      for (const r of rows) { const m = r.metrics ?? {};
        t.imp+=Number(m.impressions??0); t.cl+=Number(m.clicks??0); t.cost+=usd(m.cost_micros);
        t.cv+=Number(m.conversions??0); t.ac+=Number(m.all_conversions??0);
        t.is=Number(m.search_impression_share??0); t.bl=Number(m.search_budget_lost_impression_share??0);
        t.rl=Number(m.search_rank_lost_impression_share??0); }
      return t;
    };
    const A = await grab(a), B = await grab(b);
    if (!A || !B) return;
    console.log(`\n  ${label}`);
    console.log(`  AFTER  ${a.from}..${a.to}   BEFORE ${b.from}..${b.to}`);
    const row = (lbl:string, x:number, y:number, fmt:(n:number)=>string, money=false) =>
      console.log(`    ${lbl.padEnd(30)}${fmt(x).padStart(12)}${fmt(y).padStart(12)}   ${delta(x,y,money)}`);
    console.log(`    ${"metric".padEnd(30)}${"AFTER".padStart(12)}${"BEFORE".padStart(12)}   delta`);
    row("spend", A.cost, B.cost, $, true);
    row("clicks", A.cl, B.cl, (n)=>String(n));
    row("conversions", A.cv, B.cv, n1);
    row("all_conversions", A.ac, B.ac, n1);
    row("cost / conversion", A.cv?A.cost/A.cv:0, B.cv?B.cost/B.cv:0, $, true);
    row("cost / all_conversion", A.ac?A.cost/A.ac:0, B.ac?B.cost/B.ac:0, $, true);
    row("impression share", A.is*100, B.is*100, (n)=>`${n.toFixed(1)}%`);
    row("IS lost (budget)", A.bl*100, B.bl*100, (n)=>`${n.toFixed(1)}%`);
    row("IS lost (rank)", A.rl*100, B.rl*100, (n)=>`${n.toFixed(1)}%`);
  };
  hr("6. EFFECT OF THE 8/19 NEGATIVES — Treatment Center Search");
  await windowCompare("Treatment Center Search", TCS, {from:"2026-08-19",to:"2026-08-24"}, {from:"2026-08-13",to:"2026-08-18"});
  console.log(`\n  Do the 9 negatives block terms that CONVERTED in the prior 90 days? (all_conversions)`);
  const NEGS = ["methadone","methadone clinic","sober living","halfway house","oxford house","detox","detoxification","inpatient","residential treatment"];
  const st90 = await q(`SELECT search_term_view.search_term, campaign.name, metrics.cost_micros, metrics.clicks,
      metrics.conversions, metrics.all_conversions FROM search_term_view WHERE segments.date BETWEEN '${D90.from}' AND '${D90.to}' LIMIT 5000`);
  if (st90) {
    for (const neg of NEGS) {
      const hits = st90.filter((r:any)=> String(r.search_term_view?.search_term??"").toLowerCase().includes(neg));
      const ac = hits.reduce((s:number,r:any)=>s+Number(r.metrics?.all_conversions??0),0);
      const cost = hits.reduce((s:number,r:any)=>s+usd(r.metrics?.cost_micros),0);
      const flag = ac > 0 ? "  <-- BLOCKS CONVERTING TERMS" : "";
      console.log(`    ${("\""+neg+"\"").padEnd(26)} ${String(hits.length).padStart(3)} terms  ${$(cost).padStart(10)}  all_conv ${n1(ac).padStart(6)}${flag}`);
      for (const h of hits.filter((x:any)=>Number(x.metrics?.all_conversions??0)>0).slice(0,6))
        console.log(`        converting: "${h.search_term_view?.search_term}"  ${$(usd(h.metrics?.cost_micros))}  all_conv ${n1(h.metrics?.all_conversions)}`);
    }
  }
  hr("7. EFFECT OF THE BRANDED RAISE — OHC - Branded Search");
  await windowCompare("OHC - Branded Search ($25 -> $40 on 2026-08-19)", BRAND, {from:"2026-08-19",to:"2026-08-24"}, {from:"2026-08-13",to:"2026-08-18"});

  // ── 8. SEARCH TERMS ──────────────────────────────────────────────────────
  hr("8. SEARCH TERMS, CURRENT PERIOD");
  const stFor = async (p:{from:string;to:string}) => {
    const rows = await q(`SELECT search_term_view.search_term, campaign.name, ad_group.name,
      metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.all_conversions
      FROM search_term_view WHERE segments.date BETWEEN '${p.from}' AND '${p.to}' LIMIT 5000`);
    if (!rows) return null;
    const agg: Record<string,{imp:number;cl:number;cost:number;cv:number;ac:number;camp:string}> = {};
    for (const r of rows) {
      const k = String(r.search_term_view?.search_term ?? "");
      const t = (agg[k] ??= {imp:0,cl:0,cost:0,cv:0,ac:0,camp:r.campaign?.name ?? ""});
      t.imp+=Number(r.metrics?.impressions??0); t.cl+=Number(r.metrics?.clicks??0);
      t.cost+=usd(r.metrics?.cost_micros); t.cv+=Number(r.metrics?.conversions??0); t.ac+=Number(r.metrics?.all_conversions??0);
    }
    return agg;
  };
  const stCur = await stFor(CUR), stPri = await stFor(PRIOR);
  if (stCur) {
    const PROTECTED = ["ccat","cat house","center for chemical addictions"];
    console.log(`  Range: ${CUR.from}..${CUR.to}. NEW = absent from ${PRIOR.from}..${PRIOR.to}.`);
    console.log(`\n  ${"search term".padEnd(52)}${"imp".padStart(7)}${"clicks".padStart(8)}${"cost".padStart(10)}${"conv".padStart(7)}${"allcv".padStart(7)}  flags`);
    // Only terms that actually took money. The zero-cost tail is thousands of rows
    // of competitor-name impressions and would bury every paid term.
    const all = Object.entries(stCur).sort((a,b)=>b[1].cost-a[1].cost);
    const paid = all.filter(([,t])=>t.cost > 0);
    const zero = all.length - paid.length;
    for (const [k,t] of paid) {
      const isNew = stPri && !(k in stPri) ? "NEW" : "";
      const prot = PROTECTED.some(p=>k.toLowerCase().includes(p)) ? "PROTECTED" : "";
      console.log(`  ${k.slice(0,51).padEnd(52)}${String(t.imp).padStart(7)}${String(t.cl).padStart(8)}${$(t.cost).padStart(10)}${n1(t.cv).padStart(7)}${n1(t.ac).padStart(7)}  ${[isNew,prot].filter(Boolean).join(" ")}`);
    }
    const paidCost = paid.reduce((x,[,t])=>x+t.cost,0);
    const paidAc = paid.reduce((x,[,t])=>x+t.ac,0);
    console.log(`\n  ${paid.length} terms took spend (${$(paidCost)}, all_conv ${n1(paidAc)}). ${zero} further terms had impressions but $0.00 cost and are not listed.`);
    const newPaid = paid.filter(([k])=> stPri && !(k in stPri));
    console.log(`  Of the paid terms, ${newPaid.length} are NEW vs the prior period, costing ${$(newPaid.reduce((x,[,t])=>x+t.cost,0))} for all_conv ${n1(newPaid.reduce((x,[,t])=>x+t.ac,0))}.`);
  }

  // ── 9. QUALITY SCORE ─────────────────────────────────────────────────────
  hr("9. QUALITY SCORE COMPONENTS — enabled keywords");
  note(`Quality Score is a current snapshot, not period-scoped.`);
  const qs = await q(`SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type, ad_group_criterion.quality_info.quality_score,
      ad_group_criterion.quality_info.creative_quality_score,
      ad_group_criterion.quality_info.post_click_quality_score,
      ad_group_criterion.quality_info.search_predicted_ctr
    FROM keyword_view
   WHERE ad_group_criterion.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'`);
  if (qs) {
    console.log(`\n  ${"keyword".padEnd(42)}${"match".padEnd(8)}${"QS".padStart(4)}  ${"ad relevance".padEnd(16)}${"landing page".padEnd(16)}${"expected CTR".padEnd(16)}`);
    for (const r of qs) {
      const k = r.ad_group_criterion ?? {}; const qi = k.quality_info ?? {};
      const star = ["treatment center","iop near me"].includes(String(k.keyword?.text).toLowerCase()) ? "  <<<" : "";
      console.log(`  ${String(k.keyword?.text).slice(0,41).padEnd(42)}${nm(MATCH,k.keyword?.match_type).padEnd(8)}${String(qi.quality_score ?? "—").padStart(4)}  ` +
        `${String(qi.creative_quality_score ?? "—").padEnd(16)}${String(qi.post_click_quality_score ?? "—").padEnd(16)}${String(qi.search_predicted_ctr ?? "—").padEnd(16)}${star}`);
    }
  }

  // ── 10. FINAL URLS ───────────────────────────────────────────────────────
  hr("10. FINAL URLS ACTUALLY SERVING");
  const kwUrls = await q(`SELECT campaign.name, ad_group.id, ad_group.name,
      ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.final_urls
    FROM keyword_view
   WHERE ad_group_criterion.status='ENABLED' AND ad_group.status='ENABLED' AND campaign.status='ENABLED'`);
  const adUrls = await q(`SELECT campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id,
      ad_group_ad.ad.final_urls, ad_group_ad.ad.type
    FROM ad_group_ad WHERE ad_group_ad.status='ENABLED' AND ad_group.status='ENABLED' AND campaign.status='ENABLED'`);
  const adDefault: Record<string,string[]> = {};
  if (adUrls) for (const a of adUrls) {
    const g = String(a.ad_group?.id);
    (adDefault[g] ??= []).push(...(a.ad_group_ad?.ad?.final_urls ?? []));
  }
  const EXPECT: Record<string,string> = {
    "php cincinnati": "https://ohiorecoverycenters.com/services/partial-hospitalization-program/",
    "php near me": "https://ohiorecoverycenters.com/services/partial-hospitalization-program/",
    "iop near me": "https://ohiorecoverycenters.com/services/intensive-outpatient-program/",
    "iop cincinnati": "https://ohiorecoverycenters.com/services/intensive-outpatient-program/",
    "intensive outpatient program cincinnati": "https://ohiorecoverycenters.com/services/intensive-outpatient-program/",
  };
  if (kwUrls) {
    console.log(`\n  ${"keyword".padEnd(42)}${"source".padEnd(16)}effective final URL`);
    for (const r of kwUrls) {
      const k = r.ad_group_criterion ?? {}; const kw = String(k.keyword?.text ?? "");
      const own = k.final_urls ?? [];
      const inherited = adDefault[String(r.ad_group?.id)] ?? [];
      const eff: string[] = own.length ? own : Array.from(new Set<string>(inherited));
      const src = own.length ? "keyword-level" : "inherited(ad)";
      console.log(`  ${kw.slice(0,41).padEnd(42)}${src.padEnd(16)}${eff.join(" | ") || "(none resolved)"}`);
      const want = EXPECT[kw.toLowerCase()];
      if (want && !eff.some((u: string) => u === want)) console.log(`      MISMATCH: expected ${want}`);
    }
  }
  if (adUrls) {
    console.log(`\n  Enabled ads and their final URLs`);
    for (const a of adUrls)
      console.log(`  ${String(a.campaign?.name).slice(0,28).padEnd(30)}${String(a.ad_group?.name).slice(0,26).padEnd(28)}ad ${a.ad_group_ad?.ad?.id}  ${(a.ad_group_ad?.ad?.final_urls ?? []).join(" | ")}`);
  }

  // ── 11 & 12. POLICY ──────────────────────────────────────────────────────
  hr("11 & 12. POLICY STATE — ads and assets (selected by carrying a policy topic, not by approval label)");
  const ads = await q(`SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.status,
      ad_group_ad.ad.final_urls, ad_group_ad.policy_summary.approval_status,
      ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.policy_topic_entries,
      metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.all_conversions
    FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND segments.date BETWEEN '${CUR.from}' AND '${CUR.to}'`);
  if (ads) {
    console.log(`\n  Ad performance ${CUR.from}..${CUR.to}`);
    console.log(`  ${"campaign › ad group".padEnd(52)}${"ad".padEnd(14)}${"imp".padStart(7)}${"clicks".padStart(8)}${"cost".padStart(10)}${"conv".padStart(7)}  approval`);
    for (const a of ads) {
      const s = a.ad_group_ad ?? {}; const m = a.metrics ?? {};
      console.log(`  ${`${a.campaign?.name} › ${a.ad_group?.name}`.slice(0,51).padEnd(52)}${String(s.ad?.id).padEnd(14)}${String(m.impressions??0).padStart(7)}${String(m.clicks??0).padStart(8)}${$(usd(m.cost_micros)).padStart(10)}${n1(m.conversions).padStart(7)}  ${nm(APPROVAL,s.policy_summary?.approval_status)}`);
      for (const e of s.policy_summary?.policy_topic_entries ?? []) {
        console.log(`      POLICY TOPIC: ${e?.topic}  (${e?.type})`);
        for (const ev of e?.evidences ?? []) {
          const dn = ev?.destination_not_working;
          if (dn) console.log(`         DESTINATION_NOT_WORKING url=${dn.expanded_url ?? dn.url ?? "?"} dns=${dn.dns_error_type ?? "-"} http=${dn.http_error_code ?? "-"} lastChecked=${dn.last_checked_date_time ?? "-"}`);
          if (ev?.text_list?.texts?.length) console.log(`         text: ${ev.text_list.texts.join(" | ")}`);
        }
      }
    }
  }
  const assets = await q(`SELECT asset.id, asset.name, asset.type, asset.final_urls,
      asset.sitelink_asset.link_text, asset.policy_summary.approval_status,
      asset.policy_summary.review_status, asset.policy_summary.policy_topic_entries FROM asset`);
  if (assets) {
    // An asset with no policy_summary at all is not evidence of a problem — it is
    // evidence the API returned no policy data. Require positive evidence, or the
    // clean assets bury the findings.
    const flagged = assets.filter((a:any)=>{
      const ps = a.asset?.policy_summary;
      if (!ps) return false;
      const st = nm(APPROVAL, ps.approval_status);
      return (ps.policy_topic_entries ?? []).length > 0 || st === "DISAPPROVED" || st === "APPROVED_LIMITED";
    });
    const noPolicyData = assets.length - assets.filter((a:any)=>a.asset?.policy_summary).length;
    if (noPolicyData) console.log(`\n  (${noPolicyData} of ${assets.length} assets returned no policy_summary from the API — not counted either way.)`);
    console.log(`\n  Assets carrying a policy topic or not plainly approved: ${flagged.length} of ${assets.length}`);
    for (const a of flagged) {
      const s = a.asset ?? {};
      console.log(`\n    asset ${s.id} · ${s.sitelink_asset?.link_text || s.name || s.type} · ${nm(APPROVAL,s.policy_summary?.approval_status)}`);
      for (const u of s.final_urls ?? []) console.log(`       url: ${u}`);
      for (const e of s.policy_summary?.policy_topic_entries ?? []) {
        console.log(`       POLICY TOPIC: ${e?.topic} (${e?.type})`);
        for (const ev of e?.evidences ?? []) {
          const dn = ev?.destination_not_working;
          if (dn) console.log(`          DESTINATION_NOT_WORKING url=${dn.expanded_url ?? dn.url ?? "?"} dns=${dn.dns_error_type ?? "-"} http=${dn.http_error_code ?? "-"} lastChecked=${dn.last_checked_date_time ?? "-"}`);
        }
      }
    }
  }

  // ── 13. AUCTION PRESSURE ─────────────────────────────────────────────────
  hr("13. AUCTION PRESSURE — already reported per campaign in item 4 (avg CPC, top / abs-top rates)");
  note(`Reference average CPC year to date: $4.03 (client-supplied, not re-derived here).`);
  console.log("\nDIAGNOSTIC COMPLETE — no changes were made to the account.\n");
}

main().catch((e) => {
  const msg = e?.errors?.map((x: any) => x.message).join("; ") || (e instanceof Error ? e.message : String(e));
  console.error("FATAL:", msg); process.exit(1);
});

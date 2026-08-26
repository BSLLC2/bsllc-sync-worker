#!/usr/bin/env tsx
import "dotenv/config";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig } from "./config.js";

/**
 * READ-ONLY follow-up to diagnose-och-ads.ts. Answers the specific questions
 * left open by that report, plus re-reads conversion state after the 2026-08-26
 * changes so we can tell whether the Conversions column started counting again.
 * Performs no mutates.
 *
 *   npm run verify-och-ads
 */

const CUSTOMER_ID = "8350689003";
const TCS = "23249502120";   // Treatment Center Search
const BRAND = "24018792925"; // OHC - Branded Search
const AWARE = "23174695410"; // OCH Brand Awareness
const SMART = "20254303385"; // Our Addiction Treatment Center (Smart)
const RSA_IDS = ["783590930631", "797710465889"];
const DISAPPROVED = ["89218796438","110694160228","110947363210","115293645680","115293645683",
  "115293645686","121069684308","122485798853","184720570800","306288895514",
  "407325551015","407424666544","407500528530"];

const TRAIL30 = { from: "2026-07-27", to: "2026-08-25" }; // true trailing 30 days
const REPORT  = { from: "2026-07-26", to: "2026-08-24" }; // window used in the diagnostic
const RECENT  = { from: "2026-08-05", to: "2026-08-26" }; // spans the break + today

const usd = (m: unknown) => Number(m ?? 0) / 1_000_000;
const $ = (n: number) => `$${n.toFixed(2)}`;
const n1 = (v: unknown) => Number(v ?? 0).toFixed(1);
/**
 * Section gating. The full run is longer than a retrievable log tail, so
 * ONLY=A,B,C,D prints just those sections. Queries still run; only printing is
 * gated, which keeps the lettered blocks untouched.
 */
const WANT = (() => {
  const raw = String(process.env.ONLY ?? "").toUpperCase().replace(/[^A-G]/g, "");
  return raw ? new Set(raw.split("")) : null;
})();
const realLog = console.log.bind(console);
let SEC = "";
console.log = ((...a: unknown[]) => { if (!WANT || SEC === "" || WANT.has(SEC)) realLog(...a); }) as typeof console.log;
const hr = (t: string) => {
  const m = /^\s*([A-G])\./.exec(t);
  if (m) SEC = m[1]!;
  console.log(`\n${"=".repeat(92)}\n${t}\n${"=".repeat(92)}`);
};

const CATEGORY: Record<string,string> = {"2":"DEFAULT","3":"PAGE_VIEW","4":"PURCHASE","5":"SIGNUP","6":"LEAD","7":"DOWNLOAD","8":"ADD_TO_CART","9":"BEGIN_CHECKOUT","11":"PHONE_CALL_LEAD","12":"IMPORTED_LEAD","13":"SUBMIT_LEAD_FORM","14":"BOOK_APPOINTMENT","15":"REQUEST_QUOTE","16":"GET_DIRECTIONS","17":"OUTBOUND_CLICK","18":"CONTACT","19":"ENGAGEMENT","20":"STORE_VISIT","22":"QUALIFIED_LEAD","23":"CONVERTED_LEAD"};
const CSTATUS: Record<string,string> = {"2":"ENABLED","3":"REMOVED","4":"HIDDEN"};
const CAMPSTATUS: Record<string,string> = {"2":"ENABLED","3":"PAUSED","4":"REMOVED"};
const APPROVAL: Record<string,string> = {"2":"APPROVED_LIMITED","3":"APPROVED","4":"DISAPPROVED","5":"AREA_OF_INTEREST_ONLY"};
const ASSETTYPE: Record<string,string> = {"2":"YOUTUBE_VIDEO","3":"MEDIA_BUNDLE","4":"IMAGE","5":"TEXT","6":"LEAD_FORM","7":"BOOK_ON_GOOGLE","8":"PROMOTION","9":"CALLOUT","10":"STRUCTURED_SNIPPET","11":"SITELINK","12":"PAGE_FEED","13":"DYNAMIC_EDUCATION","14":"MOBILE_APP","15":"HOTEL_CALLOUT","16":"CALL","17":"PRICE","18":"CALL_TO_ACTION","19":"DYNAMIC_REAL_ESTATE","20":"LOCATION","21":"HOTEL_PROPERTY","26":"DYNAMIC_TRAVEL","27":"DISCOVERY_CAROUSEL_CARD"};
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
    console.log(`   [QUERY UNAVAILABLE] ${msg.slice(0, 220)}`); return null; } };

  console.log(`\nOHC Google Ads — READ ONLY VERIFICATION · account ${CUSTOMER_ID}`);

  // ── A. Did today's changes restore the Conversions column? ────────────────
  hr("A. CONVERSION STATE AFTER THE 2026-08-26 CHANGES");
  const acts = await q(`SELECT conversion_action.id, conversion_action.name, conversion_action.category,
      conversion_action.status, conversion_action.primary_for_goal, conversion_action.origin
      FROM conversion_action`);
  if (acts) {
    console.log(`  ${"action".padEnd(38)}${"category".padEnd(20)}${"status".padEnd(10)}primary`);
    for (const r of acts) {
      const x = r.conversion_action ?? {};
      if (nm(CSTATUS, x.status) === "REMOVED") continue;
      const p = x.primary_for_goal === true ? "YES" : x.primary_for_goal === false ? "no" : "NOT REPORTED";
      console.log(`  ${String(x.name).slice(0,37).padEnd(38)}${nm(CATEGORY,x.category).padEnd(20)}${nm(CSTATUS,x.status).padEnd(10)}${p}`);
    }
  }
  // The two actions that carry all the volume. Printed again, on their own, at the
  // end of this section: in the full list they scroll out of a truncated log, and
  // these two flags are the whole question.
  const VOLUME = ["Calls from Ads", "Form Submission"];
  const verdict: string[] = [];
  if (acts) for (const r of acts) {
    const x = r.conversion_action ?? {};
    if (!VOLUME.includes(String(x.name))) continue;
    verdict.push(`    ${String(x.name).padEnd(20)} status ${nm(CSTATUS,x.status).padEnd(9)} primary_for_goal = ${x.primary_for_goal === true ? "TRUE  (counts in Conversions)" : x.primary_for_goal === false ? "FALSE (does NOT count)" : "NOT REPORTED"}`);
  }

  console.log(`\n  ACCOUNT-DEFAULT goals now`);
  const cg = await q(`SELECT customer_conversion_goal.category, customer_conversion_goal.origin,
      customer_conversion_goal.biddable FROM customer_conversion_goal`);
  if (cg) for (const r of cg) {
    const g = r.customer_conversion_goal ?? {};
    if (g.biddable !== true) continue;
    console.log(`    BIDDABLE: ${nm(CATEGORY,g.category).padEnd(20)} origin ${g.origin}`);
  }
  console.log(`\n  PER-CAMPAIGN biddable goals now`);
  const cpg = await q(`SELECT campaign.name, campaign_conversion_goal.category, campaign_conversion_goal.origin,
      campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign.id IN (${TCS}, ${BRAND})`);
  if (cpg) for (const r of cpg) {
    const g = r.campaign_conversion_goal ?? {};
    if (g.biddable !== true) continue;
    console.log(`    ${String(r.campaign?.name).slice(0,26).padEnd(28)} BIDDABLE: ${nm(CATEGORY,g.category).padEnd(20)} origin ${g.origin}`);
  }

  console.log(`\n  DAILY conv vs all_conv ${RECENT.from}..${RECENT.to} — has counting resumed?`);
  const daily = await q(`SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.conversions,
      metrics.all_conversions FROM customer WHERE segments.date BETWEEN '${RECENT.from}' AND '${RECENT.to}'`);
  if (daily) {
    const agg: Record<string,{c:number;a:number;cost:number;cl:number}> = {};
    for (const r of daily) {
      const k = String(r.segments?.date);
      const t = (agg[k] ??= {c:0,a:0,cost:0,cl:0});
      t.c += Number(r.metrics?.conversions ?? 0); t.a += Number(r.metrics?.all_conversions ?? 0);
      t.cost += usd(r.metrics?.cost_micros); t.cl += Number(r.metrics?.clicks ?? 0);
    }
    console.log(`    date          cost  clicks    conv  all_conv`);
    for (const k of Object.keys(agg).sort()) {
      const t = agg[k]!;
      const flag = t.c === 0 && t.a > 0 ? "   <-- still uncounted" : "";
      console.log(`    ${k}  ${$(t.cost).padStart(9)}${String(t.cl).padStart(8)}${n1(t.c).padStart(8)}${n1(t.a).padStart(10)}${flag}`);
    }
  }

  console.log(`\n  >>> THE TWO ACTIONS THAT CARRY ALL THE VOLUME <<<`);
  for (const v of verdict) console.log(v);
  if (!verdict.length) console.log(`    (neither action was returned by the conversion_action query)`);

  // ── B. Treatment Center Search on its own ─────────────────────────────────
  hr("B. TREATMENT CENTER SEARCH — ITS OWN CONVERSION COUNT");
  for (const [label, p] of [["trailing 30d", TRAIL30], ["diagnostic window", REPORT]] as const) {
    const rows = await q(`SELECT campaign.name, metrics.cost_micros, metrics.clicks, metrics.conversions,
        metrics.all_conversions FROM campaign WHERE campaign.id = ${TCS}
        AND segments.date BETWEEN '${p.from}' AND '${p.to}'`);
    if (!rows) continue;
    const cost = rows.reduce((s:number,r:any)=>s+usd(r.metrics?.cost_micros),0);
    const cl = rows.reduce((s:number,r:any)=>s+Number(r.metrics?.clicks??0),0);
    const cv = rows.reduce((s:number,r:any)=>s+Number(r.metrics?.conversions??0),0);
    const ac = rows.reduce((s:number,r:any)=>s+Number(r.metrics?.all_conversions??0),0);
    console.log(`\n  ${label} ${p.from}..${p.to}`);
    console.log(`    cost ${$(cost)}   clicks ${cl}   conversions ${n1(cv)}   all_conversions ${n1(ac)}`);
    console.log(`    cost/conv ${cv?$(cost/cv):"n/a"}   cost/all_conv ${ac?$(cost/ac):"n/a"}`);
  }
  const byAct = await q(`SELECT segments.conversion_action_name, metrics.conversions, metrics.all_conversions
      FROM campaign WHERE campaign.id = ${TCS} AND segments.date BETWEEN '${TRAIL30.from}' AND '${TRAIL30.to}'`);
  if (byAct) {
    const agg: Record<string,{c:number;a:number}> = {};
    for (const r of byAct) {
      const k = r.segments?.conversion_action_name ?? "(unnamed)";
      const t = (agg[k] ??= {c:0,a:0});
      t.c += Number(r.metrics?.conversions ?? 0); t.a += Number(r.metrics?.all_conversions ?? 0);
    }
    console.log(`\n  TCS by conversion action, ${TRAIL30.from}..${TRAIL30.to}`);
    for (const [k,t] of Object.entries(agg).sort((x,y)=>y[1].a-x[1].a))
      console.log(`    ${k.slice(0,44).padEnd(46)} conv ${n1(t.c).padStart(7)}   all_conv ${n1(t.a).padStart(7)}`);
  }

  // ── C. Geo targeting ──────────────────────────────────────────────────────
  hr("C. GEO TARGETING ON THE TWO LIVE CAMPAIGNS");
  const geo = await q(`SELECT campaign.id, campaign.name,
      campaign.geo_target_type_setting.positive_geo_target_type,
      campaign.geo_target_type_setting.negative_geo_target_type
      FROM campaign WHERE campaign.id IN (${TCS}, ${BRAND})`);
  if (geo) for (const r of geo) {
    const g = r.campaign?.geo_target_type_setting ?? {};
    console.log(`  ${String(r.campaign?.name).slice(0,28).padEnd(30)} positive=${g.positive_geo_target_type}  negative=${g.negative_geo_target_type}`);
  }
  const locs = await q(`SELECT campaign.name, campaign_criterion.location.geo_target_constant,
      campaign_criterion.negative, campaign_criterion.proximity.radius,
      campaign_criterion.proximity.radius_units, campaign_criterion.type
      FROM campaign_criterion WHERE campaign.id IN (${TCS}, ${BRAND})
      AND campaign_criterion.type IN (LOCATION, PROXIMITY)`);
  if (locs) {
    console.log(`\n  Location / proximity criteria`);
    for (const r of locs) {
      const cc = r.campaign_criterion ?? {};
      const neg = cc.negative === true ? "EXCLUDED" : "targeted";
      const loc = cc.location?.geo_target_constant ?? (cc.proximity ? `proximity ${cc.proximity.radius} (units ${cc.proximity.radius_units})` : "?");
      console.log(`    ${String(r.campaign?.name).slice(0,26).padEnd(28)} ${neg.padEnd(9)} ${loc}`);
    }
  }

  // ── D. OCH Brand Awareness ────────────────────────────────────────────────
  hr("D. OCH BRAND AWARENESS — WHY IT STOPPED");
  const aware = await q(`SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status,
      campaign.start_date, campaign.end_date, campaign.advertising_channel_type,
      campaign_budget.amount_micros, campaign_budget.status, campaign.bidding_strategy_type,
      campaign.primary_status, campaign.primary_status_reasons
      FROM campaign WHERE campaign.id = ${AWARE}`);
  if (aware) for (const r of aware) {
    const x = r.campaign ?? {};
    console.log(`  name             ${x.name}`);
    console.log(`  status           ${nm(CAMPSTATUS, x.status)}   serving_status ${x.serving_status}`);
    console.log(`  primary_status   ${x.primary_status}   reasons ${JSON.stringify(x.primary_status_reasons ?? [])}`);
    console.log(`  dates            ${x.start_date} -> ${x.end_date}`);
    console.log(`  channel          ${x.advertising_channel_type}   bidding ${x.bidding_strategy_type}`);
    console.log(`  budget           ${$(usd(r.campaign_budget?.amount_micros))}/day  status ${r.campaign_budget?.status}`);
  }
  const lastServe = await q(`SELECT segments.date, metrics.impressions, metrics.cost_micros
      FROM campaign WHERE campaign.id = ${AWARE} AND segments.date BETWEEN '2026-06-01' AND '2026-08-26'
      AND metrics.impressions > 0 ORDER BY segments.date DESC LIMIT 6`);
  if (lastServe) {
    console.log(`\n  Last days with impressions`);
    if (!lastServe.length) console.log(`    (none since 2026-06-01)`);
    for (const r of lastServe) console.log(`    ${r.segments?.date}  impr ${r.metrics?.impressions}  cost ${$(usd(r.metrics?.cost_micros))}`);
  }
  const awareAds = await q(`SELECT ad_group.name, ad_group.status, ad_group_ad.status,
      ad_group_ad.ad.id, ad_group_ad.policy_summary.approval_status
      FROM ad_group_ad WHERE campaign.id = ${AWARE}`);
  if (awareAds) {
    console.log(`\n  Ad groups / ads`);
    if (!awareAds.length) console.log(`    (no ads returned — campaign has no ads)`);
    for (const r of awareAds)
      console.log(`    ${String(r.ad_group?.name).slice(0,26).padEnd(28)} adgroup ${nm(CAMPSTATUS,r.ad_group?.status).padEnd(9)} ad ${nm(CAMPSTATUS,r.ad_group_ad?.status).padEnd(9)} ${nm(APPROVAL, r.ad_group_ad?.policy_summary?.approval_status)}`);
  }

  // ── E. Smart campaign ─────────────────────────────────────────────────────
  hr("E. SMART CAMPAIGN — 'Our Addiction Treatment Center'");
  const smart = await q(`SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status,
      campaign.advertising_channel_type, campaign.advertising_channel_sub_type,
      campaign_budget.amount_micros, campaign.primary_status, campaign.primary_status_reasons
      FROM campaign WHERE campaign.id = ${SMART}`);
  if (smart) for (const r of smart) {
    const x = r.campaign ?? {};
    console.log(`  ${x.name}  [${x.id}]`);
    console.log(`  status ${nm(CAMPSTATUS,x.status)}  serving_status ${x.serving_status}  primary_status ${x.primary_status}`);
    console.log(`  channel ${x.advertising_channel_type} sub ${x.advertising_channel_sub_type}  budget ${$(usd(r.campaign_budget?.amount_micros))}/day`);
  }
  const smartSpend = await q(`SELECT metrics.impressions, metrics.clicks, metrics.cost_micros,
      metrics.all_conversions FROM campaign WHERE campaign.id = ${SMART}
      AND segments.date BETWEEN '2026-05-27' AND '2026-08-26'`);
  if (smartSpend) {
    const imp = smartSpend.reduce((s:number,r:any)=>s+Number(r.metrics?.impressions??0),0);
    const cost = smartSpend.reduce((s:number,r:any)=>s+usd(r.metrics?.cost_micros),0);
    const ac = smartSpend.reduce((s:number,r:any)=>s+Number(r.metrics?.all_conversions??0),0);
    console.log(`  Last 90 days: impressions ${imp}  cost ${$(cost)}  all_conversions ${n1(ac)}`);
    console.log(`  ^ if impressions are 0 it is NOT serving, whatever its status says.`);
  }

  // ── F. The 13 disapproved assets ──────────────────────────────────────────
  hr("F. THE 13 DISAPPROVED ASSETS");
  const assets = await q(`SELECT asset.id, asset.name, asset.type, asset.text_asset.text,
      asset.callout_asset.callout_text, asset.sitelink_asset.link_text, asset.call_asset.phone_number,
      asset.structured_snippet_asset.header, asset.final_urls,
      asset.policy_summary.approval_status, asset.policy_summary.policy_topic_entries
      FROM asset WHERE asset.id IN (${DISAPPROVED.join(", ")})`);
  if (assets) for (const r of assets) {
    const a = r.asset ?? {};
    const text = a.text_asset?.text || a.callout_asset?.callout_text || a.sitelink_asset?.link_text
      || a.call_asset?.phone_number || a.structured_snippet_asset?.header || a.name || "(no text returned)";
    console.log(`\n  asset ${a.id}  type ${nm(ASSETTYPE, a.type)}  ${nm(APPROVAL, a.policy_summary?.approval_status)}`);
    console.log(`     content: ${String(text).slice(0,110)}`);
    for (const u of a.final_urls ?? []) console.log(`     url: ${u}`);
    for (const t of a.policy_summary?.policy_topic_entries ?? [])
      console.log(`     TOPIC: ${t.topic}  (${t.type})`);
  }
  console.log(`\n  Where they are attached`);
  for (const [res, where] of [["campaign_asset","campaign.name"],["ad_group_asset","ad_group.name"],["customer_asset","customer.id"]] as const) {
    const links = await q(`SELECT ${where}, ${res}.asset, ${res}.status, ${res}.field_type
        FROM ${res} WHERE ${res}.asset IN (${DISAPPROVED.map(id=>`"customers/${CUSTOMER_ID}/assets/${id}"`).join(", ")})`);
    if (!links) continue;
    if (!links.length) { console.log(`    ${res}: none`); continue; }
    for (const r of links) {
      const l = (r as any)[res] ?? {};
      const owner = r.campaign?.name ?? r.ad_group?.name ?? r.customer?.id ?? "?";
      console.log(`    ${res.padEnd(16)} ${String(owner).slice(0,28).padEnd(30)} asset ${String(l.asset).split("/").pop()}  status ${nm(CAMPSTATUS,l.status)}  field ${l.field_type}`);
    }
  }

  // ── G. Current RSA copy, so a rewrite starts from what is actually live ───
  hr("G. CURRENT RSA COPY — Treatment Center Search / Treatment & Rehab Keywords");
  const rsas = await q(`SELECT ad_group.name, ad_group_ad.ad.id, ad_group_ad.status,
      ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines,
      ad_group_ad.ad.responsive_search_ad.descriptions,
      ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2,
      ad_group_ad.ad_strength, ad_group_ad.policy_summary.approval_status
      FROM ad_group_ad WHERE ad_group_ad.ad.id IN (${RSA_IDS.join(", ")})`);
  if (rsas) for (const r of rsas) {
    const a = r.ad_group_ad?.ad ?? {};
    const rsa = a.responsive_search_ad ?? {};
    console.log(`\n  ad ${a.id} · ${r.ad_group?.name} · ${nm(CAMPSTATUS, r.ad_group_ad?.status)} · strength ${r.ad_group_ad?.ad_strength} · ${nm(APPROVAL, r.ad_group_ad?.policy_summary?.approval_status)}`);
    console.log(`     final_urls: ${(a.final_urls ?? []).join(", ")}   paths: /${rsa.path1 ?? ""}/${rsa.path2 ?? ""}`);
    console.log(`     HEADLINES (${(rsa.headlines ?? []).length}):`);
    for (const h of rsa.headlines ?? []) console.log(`       [${String(h.text).length.toString().padStart(2)}] ${h.text}${h.pinned_field ? `  (PINNED ${h.pinned_field})` : ""}`);
    console.log(`     DESCRIPTIONS (${(rsa.descriptions ?? []).length}):`);
    for (const d of rsa.descriptions ?? []) console.log(`       [${String(d.text).length.toString().padStart(2)}] ${d.text}${d.pinned_field ? `  (PINNED ${d.pinned_field})` : ""}`);
  }

  console.log(`\nVERIFICATION COMPLETE — no changes were made to the account.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

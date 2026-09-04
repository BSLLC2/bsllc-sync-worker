#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig } from "./config.js";

/**
 * READ-ONLY. Revenue-focused, keyword/query/hour/device/location-level audit of
 * the two OHC campaigns that are actually live. Answers "where, specifically"
 * rather than "increase budget".
 *
 * Revenue signal: the "Admission (offline)" conversion action (real admissions
 * uploaded against the gclid that produced them) plus offline_conversion_uploads
 * and web_inquiries in the dashboard DB.
 */

const CUSTOMER_ID = "8350689003";
const CLIENT = "ohio-community-health-och";
const TCS = "23249502120";
const BRAND = "24018792925";
const LIVE = [TCS, BRAND];
const NAME: Record<string,string> = { [TCS]: "TCS", [BRAND]: "Brand" };
const D90 = { from: "2026-06-06", to: "2026-09-03" };
const D30 = { from: "2026-08-05", to: "2026-09-03" };

const usd = (m: unknown) => Number(m ?? 0) / 1_000_000;
const $ = (n: number) => `$${n.toFixed(0)}`;
const $2 = (n: number) => `$${n.toFixed(2)}`;
const n1 = (v: unknown) => Number(v ?? 0).toFixed(1);
const pct = (v: unknown) => v == null ? "—" : `${(Number(v) * 100).toFixed(0)}%`;
const hr = (t: string) => console.log(`\n${"=".repeat(96)}\n${t}\n${"=".repeat(96)}`);
const DOW: Record<string,string> = {"2":"Mon","3":"Tue","4":"Wed","5":"Thu","6":"Fri","7":"Sat","8":"Sun"};
const DEV: Record<string,string> = {"2":"MOBILE","3":"TABLET","4":"DESKTOP","5":"OTHER","6":"CTV"};
const MATCH: Record<string,string> = {"2":"EXACT","3":"PHRASE","4":"BROAD"};
const STRENGTH: Record<string,string> = {"2":"PENDING","3":"NO_ADS","4":"POOR","5":"AVERAGE","6":"GOOD","7":"EXCELLENT"};
const APPROVAL: Record<string,string> = {"2":"APPROVED_LIMITED","3":"APPROVED","4":"DISAPPROVED","5":"AREA_OF_INTEREST_ONLY"};
const CAT: Record<string,string> = {"2":"DEFAULT","6":"LEAD","11":"PHONE_CALL_LEAD","12":"IMPORTED_LEAD","13":"SUBMIT_LEAD_FORM","18":"CONTACT","22":"QUALIFIED_LEAD","23":"CONVERTED_LEAD","4":"PURCHASE","3":"PAGE_VIEW"};
const LOCTYPE: Record<string,string> = {"2":"AREA_OF_INTEREST","3":"LOCATION_OF_PRESENCE"};
const nm = (m: Record<string,string>, v: unknown) => m[String(v ?? "")] ?? String(v ?? "—");
const cpl = (cost: number, conv: number) => conv > 0 ? $2(cost / conv) : "—";

type Agg = { cost: number; clicks: number; impr: number; conv: number; value: number; byAct: Record<string, number> };
const newAgg = (): Agg => ({ cost: 0, clicks: 0, impr: 0, conv: 0, value: 0, byAct: {} });
function isAdmission(name: string) { return /admission/i.test(name); }
function isCall(name: string) { return /call/i.test(name); }
function actSummary(a: Agg) {
  const calls = Object.entries(a.byAct).filter(([k]) => isCall(k)).reduce((s, [, v]) => s + v, 0);
  const adm = Object.entries(a.byAct).filter(([k]) => isAdmission(k)).reduce((s, [, v]) => s + v, 0);
  const forms = a.conv - calls - adm;
  return { calls, forms: Math.max(forms, 0), adm };
}

async function main() {
  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });
  let c: any;
  try {
    c = api.Customer({ customer_id: CUSTOMER_ID, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
    await c.query(`SELECT customer.id FROM customer LIMIT 1`);
  } catch { c = api.Customer({ customer_id: CUSTOMER_ID, refresh_token: cfg.refreshToken }); }
  const q = async (g: string): Promise<any[] | null> => { try { return await c.query(g); } catch (e: any) {
    console.log(`   [UNAVAILABLE] ${(e?.errors?.map((x:any)=>x.message).join("; ") || e?.message || String(e)).slice(0, 260)}`); return null; } };
  const inLive = `campaign.id IN (${LIVE.join(",")})`;

  console.log(`\nOHC REVENUE AUDIT — READ ONLY · live campaigns only · 90d ${D90.from}..${D90.to} · 30d ${D30.from}..${D30.to}`);

  // ── A. What counts as a conversion, and what is revenue ─────────────────
  hr("A. CONVERSION ACTIONS — what 'lead' and 'revenue' mean in this account");
  const acts = await q(`SELECT conversion_action.name, conversion_action.category, conversion_action.status,
      conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric,
      conversion_action.phone_call_duration_seconds, conversion_action.value_settings.default_value,
      conversion_action.click_through_lookback_window_days
      FROM conversion_action WHERE conversion_action.status = 'ENABLED'`);
  if (acts) for (const r of acts) {
    const a = r.conversion_action ?? {};
    console.log(`  ${String(a.name).padEnd(40)} cat=${nm(CAT, a.category).padEnd(17)} primary=${a.primary_for_goal ? "Y" : "n"} inConv=${a.include_in_conversions_metric ? "Y" : "n"}` +
      `${a.phone_call_duration_seconds != null ? `  callMin=${a.phone_call_duration_seconds}s` : ""}` +
      `${a.value_settings?.default_value ? `  defaultValue=$${a.value_settings.default_value}` : ""}  lookback=${a.click_through_lookback_window_days}d`);
  }
  for (const [label, w] of [["90d", D90], ["30d", D30]] as const) {
    const rows = await q(`SELECT segments.conversion_action_name, metrics.all_conversions, metrics.all_conversions_value
        FROM campaign WHERE ${inLive} AND segments.date BETWEEN '${w.from}' AND '${w.to}'`);
    if (!rows) continue;
    const agg: Record<string, { n: number; v: number }> = {};
    for (const r of rows) { const k = r.segments?.conversion_action_name ?? "?"; const t = (agg[k] ??= { n: 0, v: 0 }); t.n += Number(r.metrics?.all_conversions ?? 0); t.v += Number(r.metrics?.all_conversions_value ?? 0); }
    console.log(`\n  ${label} volume by action (live campaigns):`);
    for (const [k, t] of Object.entries(agg).sort((a, b) => b[1].n - a[1].n)) console.log(`    ${k.padEnd(40)} ${n1(t.n).padStart(7)}   value $${t.v.toFixed(0)}`);
  }

  // ── B. Admissions from the DB ────────────────────────────────────────────
  hr("B. ADMISSIONS ↔ ADS — dashboard DB (offline_conversion_uploads, web_inquiries)");
  const pool = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.connect();
    const up = await pool.query(`SELECT substr(admission_date,1,7) AS ym, count(*)::int AS n, sum(value_cents)::bigint AS v, string_agg(DISTINCT matched_by, ',') AS via
        FROM offline_conversion_uploads WHERE client_slug=$1 GROUP BY 1 ORDER BY 1`, [CLIENT]);
    console.log(`  Admissions matched to an ad click and uploaded to Google Ads, by admission month:`);
    if (!up.rows.length) console.log(`    (none — no gclid-matched admissions have been uploaded yet)`);
    for (const r of up.rows) console.log(`    ${r.ym}  ${String(r.n).padStart(3)} admissions  $${(Number(r.v) / 100).toLocaleString()}  matched_by=${r.via}`);
    const inq = await pool.query(`SELECT to_char(submitted_at,'YYYY-MM') AS ym, count(*)::int AS n,
        count(*) FILTER (WHERE gclid IS NOT NULL AND gclid<>'')::int AS g
        FROM web_inquiries WHERE client_slug=$1 AND submitted_at >= '2026-05-01' GROUP BY 1 ORDER BY 1`, [CLIENT]);
    console.log(`\n  Web inquiries (form fills the site logged), by month — total / with gclid:`);
    for (const r of inq.rows) console.log(`    ${r.ym}  ${String(r.n).padStart(4)} / ${String(r.g).padStart(3)} gclid`);
    const kw = await pool.query(`SELECT coalesce(nullif(utm_term,''),'(no utm_term)') AS term, coalesce(nullif(utm_campaign,''),'(no utm_campaign)') AS camp, count(*)::int AS n
        FROM web_inquiries WHERE client_slug=$1 AND gclid IS NOT NULL AND gclid<>'' AND submitted_at >= $2::date
        GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15`, [CLIENT, D90.from]);
    console.log(`\n  gclid inquiries (90d) by utm_term / utm_campaign:`);
    for (const r of kw.rows) console.log(`    ${String(r.n).padStart(3)}  "${r.term}"  · ${r.camp}`);
    const admKw = await pool.query(`SELECT o.admission_date, coalesce(nullif(w.utm_term,''),'(no utm_term)') AS term, coalesce(nullif(w.utm_campaign,''),'?') AS camp, w.submitted_at::date AS inquired
        FROM offline_conversion_uploads o JOIN web_inquiries w ON w.gclid=o.gclid AND w.client_slug=o.client_slug
        WHERE o.client_slug=$1 ORDER BY o.admission_date DESC LIMIT 40`, [CLIENT]);
    console.log(`\n  Each uploaded admission → the inquiry's keyword/campaign (${admKw.rows.length} rows):`);
    for (const r of admKw.rows) console.log(`    admitted ${r.admission_date}  inquired ${String(r.inquired).slice(0,10)}  "${r.term}"  · ${r.camp}`);
  } catch (e: any) { console.log(`   [DB UNAVAILABLE] ${String(e?.message ?? e).slice(0, 200)}`); }
  finally { try { await pool.end(); } catch {} }

  // ── C. Search terms — what the money actually buys ───────────────────────
  hr("C. SEARCH TERMS (90d) — what the broad/phrase keywords actually match");
  const negRows = await q(`SELECT campaign.id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
      FROM campaign_criterion WHERE ${inLive} AND campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'`);
  const negatives = new Set((negRows ?? []).map((r: any) => String(r.campaign_criterion?.keyword?.text ?? "").toLowerCase()));
  const shared = await q(`SELECT shared_criterion.keyword.text, shared_set.name FROM shared_criterion WHERE shared_criterion.type = 'KEYWORD'`);
  for (const r of shared ?? []) negatives.add(String(r.shared_criterion?.keyword?.text ?? "").toLowerCase());
  console.log(`  Negatives in place: ${negRows?.length ?? 0} campaign-level + ${shared?.length ?? 0} in shared lists`);
  if (negRows?.length) console.log(`    campaign-level: ${negRows.map((r: any) => `"${r.campaign_criterion?.keyword?.text}"`).join(", ")}`);

  const st = await q(`SELECT search_term_view.search_term, campaign.id, ad_group.name, segments.keyword.info.text,
      metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.all_conversions, metrics.all_conversions_value
      FROM search_term_view WHERE ${inLive} AND segments.date BETWEEN '${D90.from}' AND '${D90.to}' LIMIT 20000`);
  const stAct = await q(`SELECT search_term_view.search_term, campaign.id, segments.conversion_action_name, metrics.all_conversions
      FROM search_term_view WHERE ${inLive} AND segments.date BETWEEN '${D90.from}' AND '${D90.to}' LIMIT 20000`);
  const terms = new Map<string, Agg & { camp: string; kw: string }>();
  for (const r of st ?? []) {
    const k = `${r.campaign?.id}|${String(r.search_term_view?.search_term).toLowerCase()}`;
    const t = terms.get(k) ?? { ...newAgg(), camp: String(r.campaign?.id), kw: String(r.segments?.keyword?.info?.text ?? "") };
    t.cost += usd(r.metrics?.cost_micros); t.clicks += Number(r.metrics?.clicks ?? 0); t.impr += Number(r.metrics?.impressions ?? 0);
    t.conv += Number(r.metrics?.all_conversions ?? 0); t.value += Number(r.metrics?.all_conversions_value ?? 0);
    terms.set(k, t);
  }
  for (const r of stAct ?? []) {
    const k = `${r.campaign?.id}|${String(r.search_term_view?.search_term).toLowerCase()}`;
    const t = terms.get(k); if (!t) continue;
    const a = String(r.segments?.conversion_action_name ?? "?"); t.byAct[a] = (t.byAct[a] ?? 0) + Number(r.metrics?.all_conversions ?? 0);
  }
  const list = [...terms.entries()].map(([k, t]) => ({ term: k.split("|")[1]!, ...t }));
  const total = list.reduce((s, t) => s + t.cost, 0);
  console.log(`  ${list.length} distinct search terms, ${$(total)} total (90d)`);
  const line = (t: any) => { const s = actSummary(t); return `${$(t.cost).padStart(6)}  ${String(t.clicks).padStart(4)}c  conv ${n1(t.conv).padStart(5)} (calls ${n1(s.calls)}, forms ${n1(s.forms)}, ADM ${n1(s.adm)})  CPL ${cpl(t.cost, t.conv).padStart(8)}  [${NAME[t.camp]}] "${t.term}"  ← kw "${t.kw}"`; };
  console.log(`\n  TOP 30 BY SPEND:`);
  for (const t of [...list].sort((a, b) => b.cost - a.cost).slice(0, 30)) console.log(`    ${line(t)}`);
  const waste = list.filter(t => t.conv === 0 && t.cost >= 15 && !negatives.has(t.term)).sort((a, b) => b.cost - a.cost);
  console.log(`\n  WASTE — $15+ spend, ZERO conversions of any kind, NOT already a negative (${waste.length} terms, ${$(waste.reduce((s, t) => s + t.cost, 0))}):`);
  for (const t of waste.slice(0, 40)) console.log(`    ${$(t.cost).padStart(6)}  ${String(t.clicks).padStart(4)}c  [${NAME[t.camp]}] "${t.term}"  ← kw "${t.kw}"`);
  const adm = list.filter(t => actSummary(t).adm > 0).sort((a, b) => actSummary(b).adm - actSummary(a).adm);
  console.log(`\n  TERMS THAT PRODUCED AN ADMISSION (${adm.length}):`);
  for (const t of adm) console.log(`    ${line(t)}`);
  const conv = list.filter(t => t.conv >= 2 && actSummary(t).adm === 0).sort((a, b) => (a.cost / a.conv) - (b.cost / b.conv));
  console.log(`\n  BEST CPL, 2+ conversions, no admission yet (${conv.length}) — top 20 cheapest:`);
  for (const t of conv.slice(0, 20)) console.log(`    ${line(t)}`);
  const lowSignal = list.filter(t => /job|career|hiring|salary|free|what is|definition|near me for dogs|vet|hair|skin|dental|cancer|physical therapy|water/i.test(t.term));
  console.log(`\n  OFF-INTENT PATTERN MATCHES (jobs/free/definition/medical-not-addiction): ${lowSignal.length} terms, ${$(lowSignal.reduce((s, t) => s + t.cost, 0))}`);
  for (const t of lowSignal.sort((a, b) => b.cost - a.cost).slice(0, 15)) console.log(`    ${$(t.cost).padStart(6)}  conv ${n1(t.conv)}  "${t.term}"`);

  // ── D. Keywords — CPL, cost per admission, quality score ─────────────────
  hr("D. KEYWORDS (90d) — CPL, cost per admission, quality score");
  const kws = await q(`SELECT campaign.id, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
      ad_group_criterion.status, ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.creative_quality_score,
      ad_group_criterion.quality_info.post_click_quality_score, ad_group_criterion.quality_info.search_predicted_ctr,
      metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.all_conversions, metrics.all_conversions_value,
      metrics.search_impression_share, metrics.search_rank_lost_impression_share
      FROM keyword_view WHERE ${inLive} AND segments.date BETWEEN '${D90.from}' AND '${D90.to}'`);
  const kwAct = await q(`SELECT campaign.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, segments.conversion_action_name, metrics.all_conversions
      FROM keyword_view WHERE ${inLive} AND segments.date BETWEEN '${D90.from}' AND '${D90.to}'`);
  const kwMap = new Map<string, any>();
  for (const r of kws ?? []) {
    const k = `${r.campaign?.id}|${r.ad_group_criterion?.keyword?.text}|${r.ad_group_criterion?.keyword?.match_type}`;
    const t = kwMap.get(k) ?? { ...newAgg(), camp: String(r.campaign?.id), text: r.ad_group_criterion?.keyword?.text, match: r.ad_group_criterion?.keyword?.match_type,
      qs: r.ad_group_criterion?.quality_info?.quality_score, cq: r.ad_group_criterion?.quality_info?.creative_quality_score, lp: r.ad_group_criterion?.quality_info?.post_click_quality_score, ctr: r.ad_group_criterion?.quality_info?.search_predicted_ctr,
      is: r.metrics?.search_impression_share, lostB: r.metrics?.search_budget_lost_impression_share, lostR: r.metrics?.search_rank_lost_impression_share, status: r.ad_group_criterion?.status };
    t.cost += usd(r.metrics?.cost_micros); t.clicks += Number(r.metrics?.clicks ?? 0); t.impr += Number(r.metrics?.impressions ?? 0); t.conv += Number(r.metrics?.all_conversions ?? 0);
    kwMap.set(k, t);
  }
  for (const r of kwAct ?? []) {
    const t = kwMap.get(`${r.campaign?.id}|${r.ad_group_criterion?.keyword?.text}|${r.ad_group_criterion?.keyword?.match_type}`); if (!t) continue;
    const a = String(r.segments?.conversion_action_name ?? "?"); t.byAct[a] = (t.byAct[a] ?? 0) + Number(r.metrics?.all_conversions ?? 0);
  }
  console.log(`  cost   clicks  conv  (calls/forms/ADM)   CPL      $/ADM    QS(ad,lp,ctr)  IS  lost:budget/rank  keyword`);
  for (const t of [...kwMap.values()].sort((a, b) => b.cost - a.cost)) {
    if (t.cost < 1) continue;
    const s = actSummary(t);
    console.log(`  ${$(t.cost).padStart(6)} ${String(t.clicks).padStart(5)}  ${n1(t.conv).padStart(5)} (${n1(s.calls)}/${n1(s.forms)}/${n1(s.adm)})  ${cpl(t.cost, t.conv).padStart(8)}  ${(s.adm > 0 ? $(t.cost / s.adm) : "—").padStart(7)}  ${String(t.qs ?? "—").padStart(2)}(${t.cq ?? "-"},${t.lp ?? "-"},${t.ctr ?? "-"})  ${pct(t.is).padStart(4)}  ${pct(t.lostB)}/${pct(t.lostR)}  [${NAME[t.camp]}] "${t.text}" ${nm(MATCH, t.match)}`);
  }

  // ── E. Hour × day — where conversions and budget-loss actually happen ────
  hr("E. TREATMENT CENTER SEARCH — day of week & hour (90d)");
  const dow = await q(`SELECT segments.day_of_week, metrics.cost_micros, metrics.clicks, metrics.all_conversions,
      metrics.search_impression_share, metrics.search_budget_lost_impression_share
      FROM campaign WHERE campaign.id = ${TCS} AND segments.date BETWEEN '${D90.from}' AND '${D90.to}'`);
  const dowAct = await q(`SELECT segments.day_of_week, segments.conversion_action_name, metrics.all_conversions
      FROM campaign WHERE campaign.id = ${TCS} AND segments.date BETWEEN '${D90.from}' AND '${D90.to}'`);
  if (dow) {
    const agg: Record<string, Agg & { is: number; lost: number }> = {};
    for (const r of dow) { const k = String(r.segments?.day_of_week); const t = (agg[k] ??= { ...newAgg(), is: 0, lost: 0 }); t.cost += usd(r.metrics?.cost_micros); t.clicks += Number(r.metrics?.clicks ?? 0); t.conv += Number(r.metrics?.all_conversions ?? 0); t.is = Number(r.metrics?.search_impression_share ?? 0); t.lost = Number(r.metrics?.search_budget_lost_impression_share ?? 0); }
    for (const r of dowAct ?? []) { const t = agg[String(r.segments?.day_of_week)]; if (!t) continue; const a = String(r.segments?.conversion_action_name ?? "?"); t.byAct[a] = (t.byAct[a] ?? 0) + Number(r.metrics?.all_conversions ?? 0); }
    console.log(`  day   cost    clicks  conv (calls/forms/ADM)   CPL     IS   lostIS(budget)`);
    for (const k of ["2","3","4","5","6","7","8"]) { const t = agg[k]; if (!t) continue; const s = actSummary(t);
      console.log(`  ${DOW[k]}  ${$(t.cost).padStart(6)}  ${String(t.clicks).padStart(5)}  ${n1(t.conv).padStart(5)} (${n1(s.calls)}/${n1(s.forms)}/${n1(s.adm)})  ${cpl(t.cost, t.conv).padStart(8)}  ${pct(t.is).padStart(4)}  ${pct(t.lost)}`); }
  }
  const hour = await q(`SELECT segments.hour, metrics.cost_micros, metrics.clicks, metrics.all_conversions
      FROM campaign WHERE campaign.id = ${TCS} AND segments.date BETWEEN '${D90.from}' AND '${D90.to}'`);
  const hourAct = await q(`SELECT segments.hour, segments.conversion_action_name, metrics.all_conversions
      FROM campaign WHERE campaign.id = ${TCS} AND segments.date BETWEEN '${D90.from}' AND '${D90.to}'`);
  if (hour) {
    const agg: Record<string, Agg> = {};
    for (const r of hour) { const k = String(r.segments?.hour); const t = (agg[k] ??= newAgg()); t.cost += usd(r.metrics?.cost_micros); t.clicks += Number(r.metrics?.clicks ?? 0); t.conv += Number(r.metrics?.all_conversions ?? 0); }
    for (const r of hourAct ?? []) { const t = agg[String(r.segments?.hour)]; if (!t) continue; const a = String(r.segments?.conversion_action_name ?? "?"); t.byAct[a] = (t.byAct[a] ?? 0) + Number(r.metrics?.all_conversions ?? 0); }
    console.log(`\n  hour  cost    clicks  conv (calls/forms/ADM)   CPL   (account time)`);
    for (let h = 0; h < 24; h++) { const t = agg[String(h)]; if (!t) continue; const s = actSummary(t);
      console.log(`  ${String(h).padStart(2)}:00 ${$(t.cost).padStart(6)}  ${String(t.clicks).padStart(5)}  ${n1(t.conv).padStart(5)} (${n1(s.calls)}/${n1(s.forms)}/${n1(s.adm)})  ${cpl(t.cost, t.conv).padStart(8)}`); }
  }
  const sched = await q(`SELECT campaign.id, campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour,
      campaign_criterion.ad_schedule.end_hour, campaign_criterion.bid_modifier FROM campaign_criterion WHERE ${inLive} AND campaign_criterion.type = 'AD_SCHEDULE'`);
  console.log(`\n  Ad schedule rules in place: ${sched?.length ?? 0}`);
  for (const r of sched ?? []) { const s = r.campaign_criterion?.ad_schedule ?? {}; console.log(`    [${NAME[String(r.campaign?.id)]}] ${nm(DOW, s.day_of_week)} ${s.start_hour}:00-${s.end_hour}:00  bid x${r.campaign_criterion?.bid_modifier ?? 1}`); }

  // ── F. Device ────────────────────────────────────────────────────────────
  hr("F. DEVICE (90d, both live campaigns)");
  const dev = await q(`SELECT campaign.id, segments.device, metrics.cost_micros, metrics.clicks, metrics.all_conversions
      FROM campaign WHERE ${inLive} AND segments.date BETWEEN '${D90.from}' AND '${D90.to}'`);
  const devAct = await q(`SELECT campaign.id, segments.device, segments.conversion_action_name, metrics.all_conversions
      FROM campaign WHERE ${inLive} AND segments.date BETWEEN '${D90.from}' AND '${D90.to}'`);
  if (dev) {
    const agg: Record<string, Agg> = {};
    for (const r of dev) { const k = `${r.campaign?.id}|${r.segments?.device}`; const t = (agg[k] ??= newAgg()); t.cost += usd(r.metrics?.cost_micros); t.clicks += Number(r.metrics?.clicks ?? 0); t.conv += Number(r.metrics?.all_conversions ?? 0); }
    for (const r of devAct ?? []) { const t = agg[`${r.campaign?.id}|${r.segments?.device}`]; if (!t) continue; const a = String(r.segments?.conversion_action_name ?? "?"); t.byAct[a] = (t.byAct[a] ?? 0) + Number(r.metrics?.all_conversions ?? 0); }
    for (const [k, t] of Object.entries(agg).sort((a, b) => b[1].cost - a[1].cost)) { const [cid, d] = k.split("|"); const s = actSummary(t);
      console.log(`  [${NAME[cid!]}] ${nm(DEV, d).padEnd(8)} ${$(t.cost).padStart(6)}  ${String(t.clicks).padStart(5)}c  conv ${n1(t.conv).padStart(5)} (calls ${n1(s.calls)}, forms ${n1(s.forms)}, ADM ${n1(s.adm)})  CPL ${cpl(t.cost, t.conv)}`); }
  }
  const devMod = await q(`SELECT campaign.id, campaign_criterion.device.type, campaign_criterion.bid_modifier FROM campaign_criterion WHERE ${inLive} AND campaign_criterion.type = 'DEVICE'`);
  console.log(`  Device bid modifiers: ${(devMod ?? []).map((r: any) => `[${NAME[String(r.campaign?.id)]}] ${nm(DEV, r.campaign_criterion?.device?.type)} x${r.campaign_criterion?.bid_modifier ?? 1}`).join("; ") || "none"}`);

  // ── G. Location ──────────────────────────────────────────────────────────
  hr("G. LOCATION (90d) — targeted areas and where converters are physically located");
  const locTargets = await q(`SELECT campaign.id, campaign_criterion.location.geo_target_constant, campaign_criterion.negative, campaign_criterion.bid_modifier,
      campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units, campaign_criterion.type
      FROM campaign_criterion WHERE ${inLive} AND campaign_criterion.type IN ('LOCATION','PROXIMITY')`);
  const geoIds = new Set<string>();
  for (const r of locTargets ?? []) { const g = String(r.campaign_criterion?.location?.geo_target_constant ?? ""); const id = g.split("/").pop(); if (id) geoIds.add(id); }
  const locPerf = await q(`SELECT campaign.id, campaign_criterion.location.geo_target_constant, metrics.cost_micros, metrics.clicks, metrics.all_conversions
      FROM location_view WHERE ${inLive} AND segments.date BETWEEN '${D90.from}' AND '${D90.to}'`);
  const geoPres = await q(`SELECT campaign.id, geographic_view.location_type, segments.geo_target_city, segments.geo_target_metro, metrics.cost_micros, metrics.clicks, metrics.all_conversions
      FROM geographic_view WHERE ${inLive} AND segments.date BETWEEN '${D90.from}' AND '${D90.to}'`);
  for (const r of geoPres ?? []) for (const f of ["geo_target_city", "geo_target_metro"]) { const id = String(r.segments?.[f] ?? "").split("/").pop(); if (id) geoIds.add(id); }
  const names: Record<string, string> = {};
  const ids = [...geoIds].filter(Boolean);
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await q(`SELECT geo_target_constant.id, geo_target_constant.canonical_name FROM geo_target_constant WHERE geo_target_constant.id IN (${ids.slice(i, i + 200).join(",")})`);
    for (const r of rows ?? []) names[String(r.geo_target_constant?.id)] = String(r.geo_target_constant?.canonical_name);
  }
  const gname = (res: unknown) => { const id = String(res ?? "").split("/").pop() ?? ""; return names[id] ?? id; };
  console.log(`  Targeting rules:`);
  for (const r of locTargets ?? []) { const cc = r.campaign_criterion ?? {};
    if (cc.proximity?.radius) console.log(`    [${NAME[String(r.campaign?.id)]}] RADIUS ${cc.proximity.radius} ${cc.proximity.radius_units}`);
    else console.log(`    [${NAME[String(r.campaign?.id)]}] ${cc.negative ? "EXCLUDE" : "target "} ${gname(cc.location?.geo_target_constant)}  bid x${cc.bid_modifier ?? 1}`); }
  const geoSetting = await q(`SELECT campaign.id, campaign.geo_target_type_setting.positive_geo_target_type FROM campaign WHERE ${inLive}`);
  for (const r of geoSetting ?? []) console.log(`    [${NAME[String(r.campaign?.id)]}] positive_geo_target_type=${r.campaign?.geo_target_type_setting?.positive_geo_target_type} (5=PRESENCE_OR_INTEREST, 6=SEARCH_INTEREST, 7=PRESENCE)`);
  if (locPerf?.length) {
    console.log(`\n  Performance by TARGETED location:`);
    const agg: Record<string, Agg> = {};
    for (const r of locPerf) { const k = `${r.campaign?.id}|${gname(r.campaign_criterion?.location?.geo_target_constant)}`; const t = (agg[k] ??= newAgg()); t.cost += usd(r.metrics?.cost_micros); t.clicks += Number(r.metrics?.clicks ?? 0); t.conv += Number(r.metrics?.all_conversions ?? 0); }
    for (const [k, t] of Object.entries(agg).sort((a, b) => b[1].cost - a[1].cost)) { const [cid, n] = k.split("|"); console.log(`    [${NAME[cid!]}] ${$(t.cost).padStart(6)}  ${String(t.clicks).padStart(5)}c  conv ${n1(t.conv).padStart(5)}  CPL ${cpl(t.cost, t.conv).padStart(8)}  ${n}`); }
  }
  if (geoPres?.length) {
    console.log(`\n  Where converters ACTUALLY ARE (location of presence), by city — top 25 by spend:`);
    const agg: Record<string, Agg> = {};
    for (const r of geoPres) { if (String(r.geographic_view?.location_type) !== "3" && nm(LOCTYPE, r.geographic_view?.location_type) !== "LOCATION_OF_PRESENCE") continue;
      const k = `${r.campaign?.id}|${gname(r.segments?.geo_target_city) || "(unknown city)"}`; const t = (agg[k] ??= newAgg()); t.cost += usd(r.metrics?.cost_micros); t.clicks += Number(r.metrics?.clicks ?? 0); t.conv += Number(r.metrics?.all_conversions ?? 0); }
    for (const [k, t] of Object.entries(agg).sort((a, b) => b[1].cost - a[1].cost).slice(0, 25)) { const [cid, n] = k.split("|"); console.log(`    [${NAME[cid!]}] ${$(t.cost).padStart(6)}  ${String(t.clicks).padStart(5)}c  conv ${n1(t.conv).padStart(5)}  CPL ${cpl(t.cost, t.conv).padStart(8)}  ${n}`); }
    const zero = Object.entries(agg).filter(([, t]) => t.conv === 0 && t.cost >= 20).sort((a, b) => b[1].cost - a[1].cost);
    console.log(`\n  Cities with $20+ spend and ZERO conversions (${zero.length}, ${$(zero.reduce((s, [, t]) => s + t.cost, 0))}):`);
    for (const [k, t] of zero.slice(0, 20)) console.log(`    ${$(t.cost).padStart(6)}  ${String(t.clicks).padStart(4)}c  ${k.split("|")[1]}`);
  }

  // ── H. Ads — policy limitation, strength, landing pages ──────────────────
  hr("H. ADS — 'All ads limited by policy', ad strength, landing pages (30d)");
  const ads = await q(`SELECT campaign.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.ad_strength,
      ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.policy_topic_entries,
      ad_group_ad.ad.final_urls, metrics.cost_micros, metrics.clicks, metrics.all_conversions
      FROM ad_group_ad WHERE ${inLive} AND ad_group_ad.status != 'REMOVED' AND segments.date BETWEEN '${D30.from}' AND '${D30.to}'`);
  const seen = new Set<string>();
  for (const r of ads ?? []) { const a = r.ad_group_ad ?? {}; const id = String(a.ad?.id); if (seen.has(id)) continue; seen.add(id);
    const topics = (a.policy_summary?.policy_topic_entries ?? []).map((t: any) => `${t.topic}:${t.type}`).join(", ");
    console.log(`  [${NAME[String(r.campaign?.id)]}] ad ${id}  ${String(r.ad_group?.name).slice(0, 22).padEnd(22)} strength=${nm(STRENGTH, a.ad_strength).padEnd(9)} policy=${nm(APPROVAL, a.policy_summary?.approval_status).padEnd(16)} ${topics ? `topics=[${topics}]` : ""}`);
    console.log(`        ${$(usd(r.metrics?.cost_micros))} ${r.metrics?.clicks}c conv ${n1(r.metrics?.all_conversions)}  → ${(a.ad?.final_urls ?? []).join(" ")}`); }
  const lp = await q(`SELECT campaign.id, landing_page_view.unexpanded_final_url, metrics.cost_micros, metrics.clicks, metrics.all_conversions
      FROM landing_page_view WHERE ${inLive} AND segments.date BETWEEN '${D90.from}' AND '${D90.to}'`);
  if (lp?.length) {
    const agg: Record<string, Agg> = {};
    for (const r of lp) { const k = `${r.campaign?.id}|${r.landing_page_view?.unexpanded_final_url}`; const t = (agg[k] ??= newAgg()); t.cost += usd(r.metrics?.cost_micros); t.clicks += Number(r.metrics?.clicks ?? 0); t.conv += Number(r.metrics?.all_conversions ?? 0); }
    console.log(`\n  Landing pages (90d):`);
    for (const [k, t] of Object.entries(agg).sort((a, b) => b[1].cost - a[1].cost)) { const [cid, u] = k.split("|"); console.log(`    [${NAME[cid!]}] ${$(t.cost).padStart(6)}  ${String(t.clicks).padStart(5)}c  conv ${n1(t.conv).padStart(5)}  CPL ${cpl(t.cost, t.conv).padStart(8)}  conv/click ${t.clicks ? (t.conv / t.clicks * 100).toFixed(1) : "0"}%  ${u}`); }
  }

  // ── I. Bidding + which conversions the bidding is optimizing toward ──────
  hr("I. BIDDING CONFIG — what Smart Bidding is actually optimizing for");
  const bid = await q(`SELECT campaign.id, campaign.bidding_strategy_type, campaign.maximize_conversions.target_cpa_micros,
      campaign.target_cpa.target_cpa_micros, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network,
      campaign.network_settings.target_partner_search_network, campaign_budget.amount_micros, campaign_budget.delivery_method
      FROM campaign WHERE ${inLive}`);
  for (const r of bid ?? []) { const cp = r.campaign ?? {};
    console.log(`  [${NAME[String(cp.id)]}] strategy=${cp.bidding_strategy_type}  tCPA(maxconv)=${cp.maximize_conversions?.target_cpa_micros ? $2(usd(cp.maximize_conversions.target_cpa_micros)) : "none"}  tCPA=${cp.target_cpa?.target_cpa_micros ? $2(usd(cp.target_cpa.target_cpa_micros)) : "none"}  searchPartners=${cp.network_settings?.target_search_network}  display=${cp.network_settings?.target_content_network}  budget=${$2(usd(r.campaign_budget?.amount_micros))}/day`); }
  const goals = await q(`SELECT campaign.id, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable
      FROM campaign_conversion_goal WHERE ${inLive}`);
  console.log(`  Campaign conversion goals (biddable = bidding optimizes toward it):`);
  for (const r of goals ?? []) { const g = r.campaign_conversion_goal ?? {}; if (!g.biddable) continue; console.log(`    [${NAME[String(r.campaign?.id)]}] ${nm(CAT, g.category)} origin=${g.origin} biddable=${g.biddable}`); }
  const custGoals = await q(`SELECT customer_conversion_goal.category, customer_conversion_goal.origin, customer_conversion_goal.biddable FROM customer_conversion_goal`);
  console.log(`  Account-default biddable goals: ${(custGoals ?? []).filter((r: any) => r.customer_conversion_goal?.biddable).map((r: any) => `${nm(CAT, r.customer_conversion_goal?.category)}/${r.customer_conversion_goal?.origin}`).join(", ")}`);
  console.log(`  Is "Admission (offline)" primary (used for bidding)? see section A primary= flag.`);

  // ── J. Phones — when calls are missed ────────────────────────────────────
  hr("J. CALLS — missed calls by day/hour (call_view, whatever Google still retains)");
  const raw = await q(`SELECT call_view.call_duration_seconds, call_view.call_status, call_view.start_call_date_time, campaign.id FROM call_view`);
  if (raw) {
    const calls = raw.filter((r: any) => { const d = String(r.call_view?.start_call_date_time ?? "").slice(0, 10); return d >= D90.from && d <= D90.to; });
    console.log(`  ${calls.length} calls in window (of ${raw.length} retained)`);
    const byHour: Record<string, { n: number; missed: number; short: number }> = {};
    const byDow: Record<string, { n: number; missed: number; short: number }> = {};
    for (const r of calls) { const ts = String(r.call_view?.start_call_date_time ?? ""); const h = ts.slice(11, 13); const d = new Date(ts.replace(" ", "T")); const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()] ?? "?";
      const missed = String(r.call_view?.call_status) === "2" ? 1 : 0; const short = Number(r.call_view?.call_duration_seconds ?? 0) < 60 ? 1 : 0;
      const th = (byHour[h] ??= { n: 0, missed: 0, short: 0 }); th.n++; th.missed += missed; th.short += short;
      const td = (byDow[dow] ??= { n: 0, missed: 0, short: 0 }); td.n++; td.missed += missed; td.short += short; }
    console.log(`  hour   calls  missed  under60s`);
    for (const h of Object.keys(byHour).sort()) { const t = byHour[h]!; console.log(`  ${h}:00  ${String(t.n).padStart(5)}  ${String(t.missed).padStart(6)}  ${String(t.short).padStart(8)}${t.n >= 3 && (t.missed + t.short) / t.n >= 0.6 ? "   <-- majority lost" : ""}`); }
    console.log(`  day    calls  missed  under60s`);
    for (const d of ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]) { const t = byDow[d]; if (!t) continue; console.log(`  ${d}    ${String(t.n).padStart(5)}  ${String(t.missed).padStart(6)}  ${String(t.short).padStart(8)}`); }
  }

  console.log(`\nDONE — read only, no changes made.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

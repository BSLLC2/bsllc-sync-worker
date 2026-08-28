#!/usr/bin/env tsx
import "dotenv/config";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig } from "./config.js";

/**
 * READ-ONLY. What can actually be pulled to raise OHC lead volume this month,
 * sized from the account rather than asserted.
 *
 * Every lead count here uses all_conversions. The Conversions column was blind
 * from 2026-08-11 to 2026-08-25 and understates the month by design.
 */

const CUSTOMER_ID = "8350689003";
const TCS = "23249502120";
const BRAND = "24018792925";
const MTD = { from: "2026-08-01", to: "2026-08-27" };
const L30 = { from: "2026-07-29", to: "2026-08-27" };

const usd = (m: unknown) => Number(m ?? 0) / 1_000_000;
const $ = (n: number) => `$${n.toFixed(2)}`;
const n1 = (v: unknown) => Number(v ?? 0).toFixed(1);
const hr = (t: string) => console.log(`\n${"=".repeat(92)}\n${t}\n${"=".repeat(92)}`);
const DOW: Record<string,string> = {"2":"Monday","3":"Tuesday","4":"Wednesday","5":"Thursday","6":"Friday","7":"Saturday","8":"Sunday"};

async function main() {
  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });
  let c: any;
  try {
    c = api.Customer({ customer_id: CUSTOMER_ID, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
    await c.query(`SELECT customer.id FROM customer LIMIT 1`);
  } catch { c = api.Customer({ customer_id: CUSTOMER_ID, refresh_token: cfg.refreshToken }); }
  const q = async (g: string) => { try { return await c.query(g); } catch (e: any) {
    console.log(`   [UNAVAILABLE] ${(e?.errors?.map((x:any)=>x.message).join("; ") || e?.message || String(e)).slice(0,200)}`); return null; } };

  // ── What the month actually did ───────────────────────────────────────────
  hr(`MONTH TO DATE ${MTD.from}..${MTD.to} — what the CEO is looking at vs what happened`);
  const mtd = await q(`SELECT metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.all_conversions
      FROM customer WHERE segments.date BETWEEN '${MTD.from}' AND '${MTD.to}'`);
  if (mtd) {
    const s = mtd.reduce((a: any, r: any) => ({
      cost: a.cost + usd(r.metrics?.cost_micros), cl: a.cl + Number(r.metrics?.clicks ?? 0),
      cv: a.cv + Number(r.metrics?.conversions ?? 0), ac: a.ac + Number(r.metrics?.all_conversions ?? 0),
    }), { cost: 0, cl: 0, cv: 0, ac: 0 });
    console.log(`  spend            ${$(s.cost)}`);
    console.log(`  clicks           ${s.cl}`);
    console.log(`  REPORTED leads   ${n1(s.cv)}   ->  CPL ${s.cv ? $(s.cost / s.cv) : "n/a"}   <- the broken column he is reading`);
    console.log(`  ACTUAL leads     ${n1(s.ac)}   ->  CPL ${s.ac ? $(s.cost / s.ac) : "n/a"}   <- all_conversions, intact throughout`);
    console.log(`  leads he thinks he did not get: ${n1(s.ac - s.cv)}`);
  }

  // ── Headroom: impressions we are choosing not to buy ──────────────────────
  hr(`LEVER 1 — HEADROOM ALREADY PAID FOR. Where budget, not demand, is the cap`);
  const camps = await q(`SELECT campaign.id, campaign.name, campaign_budget.amount_micros,
      metrics.cost_micros, metrics.all_conversions, metrics.search_impression_share,
      metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
      FROM campaign WHERE campaign.id IN (${TCS}, ${BRAND})
      AND segments.date BETWEEN '${L30.from}' AND '${L30.to}'`);
  if (camps) {
    const agg: Record<string, any> = {};
    for (const r of camps) {
      const k = String(r.campaign?.name);
      const t = (agg[k] ??= { cost: 0, ac: 0, is: 0, bl: 0, rl: 0, n: 0, bud: usd(r.campaign_budget?.amount_micros) });
      t.cost += usd(r.metrics?.cost_micros); t.ac += Number(r.metrics?.all_conversions ?? 0);
      t.is += Number(r.metrics?.search_impression_share ?? 0);
      t.bl += Number(r.metrics?.search_budget_lost_impression_share ?? 0);
      t.rl += Number(r.metrics?.search_rank_lost_impression_share ?? 0);
      t.n++;
    }
    for (const [k, t] of Object.entries(agg)) {
      const bl = t.n ? t.bl / t.n : 0, is = t.n ? t.is / t.n : 0, rl = t.n ? t.rl / t.n : 0;
      const cpl = t.ac ? t.cost / t.ac : 0;
      console.log(`\n  ${k}   (${L30.from}..${L30.to})`);
      console.log(`    daily budget ${$(t.bud)}   spend ${$(t.cost)}   leads ${n1(t.ac)}   CPL ${cpl ? $(cpl) : "n/a"}`);
      console.log(`    impression share ${(is*100).toFixed(1)}%   lost to BUDGET ${(bl*100).toFixed(1)}%   lost to RANK ${(rl*100).toFixed(1)}%`);
      if (bl > 0.05 && cpl > 0) {
        // Impressions lost to budget are demand already qualified by the auction.
        // Recovering them is the only volume lever that needs no new creative,
        // no new keywords and no policy review.
        const extraSpend = t.cost * (bl / Math.max(is, 0.0001));
        const extraLeads = t.ac * (bl / Math.max(is, 0.0001));
        console.log(`    -> recovering the budget-lost share implies roughly +${extraLeads.toFixed(0)} leads`);
        console.log(`       for roughly +${$(extraSpend)} over 30 days, at the CPL this campaign already runs.`);
        console.log(`       ESTIMATE. It assumes the unbought auctions convert like the bought ones.`);
      } else if (bl <= 0.05) {
        console.log(`    -> budget is not the binding constraint here. More money buys little.`);
      }
    }
  }

  // ── When leads actually happen ────────────────────────────────────────────
  hr(`LEVER 2 — TIMING. When leads happen vs when money is spent (TCS, last 30d)`);
  const dow = await q(`SELECT segments.day_of_week, metrics.cost_micros, metrics.clicks, metrics.all_conversions
      FROM campaign WHERE campaign.id = ${TCS} AND segments.date BETWEEN '${L30.from}' AND '${L30.to}'`);
  if (dow) {
    const agg: Record<string, { cost: number; cl: number; ac: number }> = {};
    for (const r of dow) {
      const k = String(r.segments?.day_of_week);
      const t = (agg[k] ??= { cost: 0, cl: 0, ac: 0 });
      t.cost += usd(r.metrics?.cost_micros); t.cl += Number(r.metrics?.clicks ?? 0); t.ac += Number(r.metrics?.all_conversions ?? 0);
    }
    console.log(`\n  ${"day".padEnd(12)}${"spend".padStart(10)}${"clicks".padStart(8)}${"leads".padStart(8)}${"CPL".padStart(11)}`);
    for (const k of Object.keys(agg).sort()) {
      const t = agg[k]!;
      console.log(`  ${(DOW[k] ?? k).padEnd(12)}${$(t.cost).padStart(10)}${String(t.cl).padStart(8)}${n1(t.ac).padStart(8)}${(t.ac ? $(t.cost/t.ac) : "NO LEADS").padStart(11)}`);
    }
  }
  const hod = await q(`SELECT segments.hour, metrics.cost_micros, metrics.clicks, metrics.all_conversions
      FROM campaign WHERE campaign.id = ${TCS} AND segments.date BETWEEN '${L30.from}' AND '${L30.to}'`);
  if (hod) {
    const agg: Record<number, { cost: number; cl: number; ac: number }> = {};
    for (const r of hod) {
      const k = Number(r.segments?.hour ?? 0);
      const t = (agg[k] ??= { cost: 0, cl: 0, ac: 0 });
      t.cost += usd(r.metrics?.cost_micros); t.cl += Number(r.metrics?.clicks ?? 0); t.ac += Number(r.metrics?.all_conversions ?? 0);
    }
    console.log(`\n  ${"hour".padEnd(12)}${"spend".padStart(10)}${"clicks".padStart(8)}${"leads".padStart(8)}${"CPL".padStart(11)}`);
    let dead = 0, deadSpend = 0;
    for (let h = 0; h < 24; h++) {
      const t = agg[h]; if (!t) continue;
      if (t.ac === 0) { dead++; deadSpend += t.cost; }
      console.log(`  ${`${String(h).padStart(2,"0")}:00`.padEnd(12)}${$(t.cost).padStart(10)}${String(t.cl).padStart(8)}${n1(t.ac).padStart(8)}${(t.ac ? $(t.cost/t.ac) : "NO LEADS").padStart(11)}`);
    }
    console.log(`\n  ${dead} hours of the day produced ZERO leads and consumed ${$(deadSpend)} over 30 days.`);
    console.log(`  Phone is the dominant conversion path on this account, so hours with clicks but`);
    console.log(`  no leads are worth checking against when intake staff actually answer.`);
  }

  // ── Where leads come from ─────────────────────────────────────────────────
  hr(`LEVER 3 — WHICH PATH THE LEADS USE (last 30d, all campaigns)`);
  const byAct = await q(`SELECT segments.conversion_action_name, metrics.all_conversions
      FROM customer WHERE segments.date BETWEEN '${L30.from}' AND '${L30.to}'`);
  if (byAct) {
    const agg: Record<string, number> = {};
    for (const r of byAct) agg[r.segments?.conversion_action_name ?? "(unnamed)"] = (agg[r.segments?.conversion_action_name ?? "(unnamed)"] ?? 0) + Number(r.metrics?.all_conversions ?? 0);
    const tot = Object.values(agg).reduce((a, b) => a + b, 0);
    for (const [k, v] of Object.entries(agg).sort((a, b) => b[1] - a[1]))
      console.log(`  ${k.padEnd(40)} ${n1(v).padStart(7)}  ${tot ? ((v/tot)*100).toFixed(0) : 0}%`);
  }

  console.log(`\nDONE — read only, no changes made.\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });

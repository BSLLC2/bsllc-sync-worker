#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly, type Config } from "./config.js";

/**
 * Read-only Google Ads optimisation audit. Pulls the resources where waste
 * actually lives — search terms, budgets, keywords, ad strength — and prints a
 * findings report. Makes NO changes: every call is a GAQL SELECT.
 *
 * The weekly `incremental` sync only pulls customer-level aggregates (eight
 * numbers per account), which is enough to report performance and useless for
 * improving it. This is the other half.
 *
 *   npm run ads-audit -- --client=ohio-community-health
 *   npm run ads-audit                 (every mapped client)
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Cost floor (micros) before a zero-conversion item is worth flagging. */
const WASTE_FLOOR = 25_000_000;   // $25 over 90 days

/** GAQL's DURING literals stop at LAST_30_DAYS — there is no LAST_90_DAYS — so
 *  the 90-day windows are expressed as an explicit BETWEEN range. */
function last90(): { start: string; end: string } {
  const d = (offsetDays: number) => new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
  return { start: d(90), end: d(1) };
}
const KEYWORD_FLOOR = 50_000_000; // $50 over 90 days

interface Finding {
  severity: "high" | "medium" | "low";
  category: string;
  detail: string;
  monthlyWasteMicros?: number;
}

/** Run a GAQL query, returning [] and logging rather than throwing — one
 *  unsupported field must not sink the whole audit. */
async function safeQuery(customer: any, label: string, gaql: string): Promise<any[]> {
  try {
    return await customer.query(gaql);
  } catch (e: any) {
    const msg = e?.errors?.map((x: any) => x.message).join("; ") || e?.message || String(e);
    console.log(`    ⚠ ${label} query failed: ${msg.slice(0, 160)}`);
    return [];
  }
}

async function auditAccount(api: GoogleAdsApi, cfg: Config, name: string, customerId: string) {
  console.log(`\n${"═".repeat(72)}\n${name}  [${customerId}]\n${"═".repeat(72)}`);
  let customer: any;
  try {
    customer = api.Customer({ customer_id: customerId, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
    await customer.query(`SELECT customer.id FROM customer LIMIT 1`);
  } catch {
    customer = api.Customer({ customer_id: customerId, refresh_token: cfg.refreshToken });
  }

  const findings: Finding[] = [];
  const { start: d90, end: dEnd } = last90();

  // ── 1. Campaign shape + budget pressure (last 30 days) ──────────────────
  const campaigns = await safeQuery(customer, "campaign", `
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
           campaign_budget.amount_micros,
           metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions,
           metrics.search_impression_share, metrics.search_budget_lost_impression_share,
           metrics.search_rank_lost_impression_share
      FROM campaign
     WHERE segments.date DURING LAST_30_DAYS AND campaign.status = 'ENABLED'`);

  let spend30 = 0, conv30 = 0, clicks30 = 0;
  console.log(`\n── Campaigns (last 30 days) ──`);
  for (const r of campaigns) {
    const cost = Number(r.metrics?.cost_micros ?? 0);
    const conv = Number(r.metrics?.conversions ?? 0);
    const clicks = Number(r.metrics?.clicks ?? 0);
    spend30 += cost; conv30 += conv; clicks30 += clicks;
    const budgetLost = Number(r.metrics?.search_budget_lost_impression_share ?? 0);
    const rankLost = Number(r.metrics?.search_rank_lost_impression_share ?? 0);
    const is = Number(r.metrics?.search_impression_share ?? 0);
    console.log(
      `  ${r.campaign?.name}: ${usd(cost)} · ${clicks} clicks · ${conv.toFixed(1)} conv` +
      ` · IS ${pct(is)} · budget-lost ${pct(budgetLost)} · rank-lost ${pct(rankLost)}`);

    if (budgetLost > 0.10) {
      findings.push({
        severity: budgetLost > 0.25 ? "high" : "medium",
        category: "budget-limited",
        detail: `"${r.campaign?.name}" loses ${pct(budgetLost)} of impression share to budget. ` +
                `Daily budget ${usd(Number(r.campaign_budget?.amount_micros ?? 0))}. ` +
                (conv > 0 ? `It is converting (${conv.toFixed(1)} in 30d) — raising budget buys more of what already works.`
                          : `It is NOT converting — fix relevance before adding budget.`),
      });
    }
    if (rankLost > 0.40) {
      findings.push({
        severity: "medium", category: "ad-rank",
        detail: `"${r.campaign?.name}" loses ${pct(rankLost)} of impression share to Ad Rank — a bid, quality, or relevance problem, not a budget one.`,
      });
    }
    if (clicks >= 100 && conv === 0) {
      findings.push({
        severity: "high", category: "no-conversions",
        detail: `"${r.campaign?.name}" took ${clicks} clicks and ${usd(cost)} in 30 days with zero recorded conversions. Either conversion tracking is broken or the traffic is wrong.`,
        monthlyWasteMicros: cost,
      });
    }
  }
  console.log(`  TOTAL: ${usd(spend30)} · ${clicks30} clicks · ${conv30.toFixed(1)} conversions` +
    (conv30 > 0 ? ` · ${usd(spend30 / conv30)}/conv` : ""));

  // ── 2. Existing negatives (so we don't propose duplicates) ──────────────
  const negRows = await safeQuery(customer, "negative keywords", `
    SELECT campaign.name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
      FROM campaign_criterion
     WHERE campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'`);
  const negatives = new Set(negRows.map((r: any) => (r.campaign_criterion?.keyword?.text ?? "").toLowerCase()));
  console.log(`\n── Negative keywords in place: ${negatives.size} ──`);

  // ── 3. Search terms — the biggest single source of waste ────────────────
  const terms = await safeQuery(customer, "search terms", `
    SELECT search_term_view.search_term, campaign.name, ad_group.name,
           metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
      FROM search_term_view
     WHERE segments.date BETWEEN '${d90}' AND '${dEnd}' AND metrics.cost_micros > 0
     ORDER BY metrics.cost_micros DESC
     LIMIT 500`);

  const waste = terms
    .filter((r: any) => Number(r.metrics?.conversions ?? 0) === 0 && Number(r.metrics?.cost_micros ?? 0) >= WASTE_FLOOR)
    .filter((r: any) => !negatives.has((r.search_term_view?.search_term ?? "").toLowerCase()));
  const wasteTotal = waste.reduce((s: number, r: any) => s + Number(r.metrics?.cost_micros ?? 0), 0);

  console.log(`\n── Search terms: ${terms.length} with spend · ${waste.length} converting nothing at ≥$25/90d ──`);
  for (const r of waste.slice(0, 30)) {
    console.log(`  ${usd(Number(r.metrics.cost_micros))} · ${r.metrics.clicks} clicks · "${r.search_term_view?.search_term}" (${r.campaign?.name})`);
  }
  if (waste.length) {
    findings.push({
      severity: "high", category: "wasted-spend",
      detail: `${waste.length} search terms spent ${usd(wasteTotal)} over 90 days with zero conversions and are not yet negatives. ` +
              `That is ${usd(wasteTotal / 3)}/month recoverable, before judging whether each term is genuinely irrelevant.`,
      monthlyWasteMicros: Math.round(wasteTotal / 3),
    });
  }

  // ── 4. Keywords — spend without return, and quality problems ────────────
  const kws = await safeQuery(customer, "keywords", `
    SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
           ad_group_criterion.quality_info.quality_score,
           campaign.name, ad_group.name,
           metrics.cost_micros, metrics.clicks, metrics.conversions
      FROM keyword_view
     WHERE segments.date BETWEEN '${d90}' AND '${dEnd}' AND metrics.cost_micros > 0
     ORDER BY metrics.cost_micros DESC
     LIMIT 300`);

  const deadKws = kws.filter((r: any) => Number(r.metrics?.conversions ?? 0) === 0 && Number(r.metrics?.cost_micros ?? 0) >= KEYWORD_FLOOR);
  const deadTotal = deadKws.reduce((s: number, r: any) => s + Number(r.metrics?.cost_micros ?? 0), 0);
  const lowQs = kws.filter((r: any) => {
    const qs = Number(r.ad_group_criterion?.quality_info?.quality_score ?? 0);
    return qs > 0 && qs < 5;
  });
  const broad = kws.filter((r: any) => r.ad_group_criterion?.keyword?.match_type === "BROAD");

  console.log(`\n── Keywords: ${kws.length} with spend · ${deadKws.length} zero-conversion ≥$50 · ${lowQs.length} quality score <5 · ${broad.length} broad match ──`);
  for (const r of deadKws.slice(0, 20)) {
    console.log(`  ${usd(Number(r.metrics.cost_micros))} · ${r.metrics.clicks} clicks · "${r.ad_group_criterion?.keyword?.text}" [${r.ad_group_criterion?.keyword?.match_type}] (${r.campaign?.name})`);
  }
  if (deadKws.length) {
    findings.push({
      severity: "high", category: "dead-keywords",
      detail: `${deadKws.length} keywords spent ${usd(deadTotal)} over 90 days with zero conversions (${usd(deadTotal / 3)}/month). Candidates for pausing or bid reduction.`,
      monthlyWasteMicros: Math.round(deadTotal / 3),
    });
  }
  if (lowQs.length) {
    findings.push({
      severity: "medium", category: "quality-score",
      detail: `${lowQs.length} keywords carry a quality score below 5 — you are paying a premium per click on every one. Usually an ad-copy or landing-page relevance mismatch: ` +
              lowQs.slice(0, 5).map((r: any) => `"${r.ad_group_criterion?.keyword?.text}" (QS ${r.ad_group_criterion?.quality_info?.quality_score})`).join(", "),
    });
  }

  // ── 5. Ad strength / RSA coverage ───────────────────────────────────────
  const ads = await safeQuery(customer, "ads", `
    SELECT campaign.name, ad_group.id, ad_group.name,
           ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad_strength, ad_group_ad.status
      FROM ad_group_ad
     WHERE ad_group_ad.status = 'ENABLED'`);
  const byGroup = new Map<string, any[]>();
  for (const r of ads) {
    const k = `${r.campaign?.name} › ${r.ad_group?.name}`;
    byGroup.set(k, [...(byGroup.get(k) ?? []), r]);
  }
  const thinGroups = Array.from(byGroup.entries()).filter(([, v]) => v.length < 2);
  const weakAds = ads.filter((r: any) => ["POOR", "AVERAGE"].includes(String(r.ad_group_ad?.ad_strength ?? "")));
  console.log(`\n── Ads: ${ads.length} enabled across ${byGroup.size} ad groups · ${thinGroups.length} groups with <2 ads · ${weakAds.length} rated Poor/Average ──`);
  if (thinGroups.length) {
    findings.push({
      severity: "medium", category: "ad-coverage",
      detail: `${thinGroups.length} ad groups run fewer than 2 enabled ads, so Google has nothing to test against: ${thinGroups.slice(0, 5).map(([k]) => k).join(", ")}`,
    });
  }
  if (weakAds.length) {
    findings.push({
      severity: "low", category: "ad-strength",
      detail: `${weakAds.length} enabled ads are rated Poor or Average by Google. Improving strength usually lifts impression share at the same bid.`,
    });
  }

  // ── Report ──────────────────────────────────────────────────────────────
  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const recoverable = findings.reduce((s, f) => s + (f.monthlyWasteMicros ?? 0), 0);

  console.log(`\n${"─".repeat(72)}\nFINDINGS — ${findings.length} for ${name}`);
  if (recoverable > 0) console.log(`Identified recoverable spend: ~${usd(recoverable)}/month of ${usd(spend30)} monthly spend`);
  console.log(`${"─".repeat(72)}`);
  for (const f of findings) {
    const tag = f.severity === "high" ? "🔴" : f.severity === "medium" ? "🟠" : "🟡";
    console.log(`\n${tag} [${f.category}] ${f.detail}`);
  }
  if (!findings.length) console.log("\n  No findings at current thresholds.");
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyClient = (argv.find((a) => a.startsWith("--client="))?.slice(9) || "").trim();
  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });

  const pgc = new pg.Client({ connectionString: cfg.databaseUrl });
  await pgc.connect();
  try {
    const { rows } = await pgc.query<{ name: string; external_id: string }>(
      `SELECT c.name, cm.external_id
         FROM clients c
         JOIN connector_mappings cm
           ON cm.client_id = c.id AND cm.source='google_ads' AND cm.enabled = true
        WHERE cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''
        ORDER BY c.name`);

    // Match on slug prefix as well as exact: client names carry suffixes ("Ohio
    // Community Health (OCH)" slugifies to ohio-community-health-och), and having
    // to guess the suffix to run an audit is friction for no benefit.
    const want = slugify(onlyClient);
    const targets = rows.filter((r) => !onlyClient || slugify(r.name).startsWith(want) || digitsOnly(r.external_id) === digitsOnly(onlyClient));
    if (!targets.length) {
      console.log(`No mapped Google Ads accounts matched${onlyClient ? ` --client=${onlyClient}` : ""}.`);
      console.log(`Available: ${rows.map((r) => slugify(r.name)).join(", ")}`);
      return;
    }
    console.log(`Auditing ${targets.length} account(s) — READ ONLY, no changes are made.`);
    for (const t of targets) await auditAccount(api, cfg, t.name, digitsOnly(t.external_id));
  } finally {
    await pgc.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

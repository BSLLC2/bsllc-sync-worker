#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";

/**
 * Read-only dump of what an account actually claims: live ad headlines and
 * descriptions, the landing pages they point at, and every enabled keyword.
 *
 * The point is verification, not optimisation. An advertiser's own ad copy and
 * bid list are public service claims they are paying to make, which makes them
 * better evidence of what a client offers than a marketing page — and far
 * better than asking the client to answer something we can already look up.
 *
 * Also scans served search terms for a probe list, so "are people searching
 * this and reaching us" is answerable without a second tool.
 *
 *   npm run dump-ads-copy -- --client=ohio-community-health
 *   npm run dump-ads-copy -- --client=ohio-community-health --probe=brixadi,medicare
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const usd = (micros: number) => `$${(Number(micros ?? 0) / 1_000_000).toFixed(2)}`;

const DEFAULT_PROBES = [
  "brixadi", "sublocade", "vivitrol", "naltrexone", "suboxone", "buprenorphine",
  "antabuse", "disulfiram", "campral", "acamprosate",
  "medicare", "medicaid",
  "telehealth", "virtual", "online",
];

const MATCH: Record<string, string> = { "2": "EXACT", "3": "PHRASE", "4": "BROAD" };

async function main() {
  const argv = process.argv.slice(2);
  const onlyClient = (argv.find((a) => a.startsWith("--client="))?.slice(9) || "").trim();
  const probes = (argv.find((a) => a.startsWith("--probe="))?.slice(8) || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const probeList = probes.length ? probes : DEFAULT_PROBES;

  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });

  const pgc = new pg.Client({ connectionString: cfg.databaseUrl });
  await pgc.connect();
  let customerId = "", clientName = "";
  try {
    const { rows } = await pgc.query<{ name: string; external_id: string }>(
      `SELECT c.name, cm.external_id FROM clients c
         JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source='google_ads' AND cm.enabled = true
        WHERE cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''`);
    const want = slugify(onlyClient);
    const hit = rows.find((r) => !onlyClient || slugify(r.name).startsWith(want));
    if (!hit) throw new Error(`No mapped account matched. Have: ${rows.map((r) => slugify(r.name)).join(", ")}`);
    customerId = digitsOnly(hit.external_id); clientName = hit.name;
  } finally { await pgc.end(); }

  let customer: any;
  try {
    customer = api.Customer({ customer_id: customerId, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
    await customer.query(`SELECT customer.id FROM customer LIMIT 1`);
  } catch {
    customer = api.Customer({ customer_id: customerId, refresh_token: cfg.refreshToken });
  }
  console.log(`\n${clientName} [${customerId}] — READ ONLY\n${"═".repeat(72)}`);

  // ── Live ads: what the account claims, and where it sends people ────────
  const ads = await customer.query(`
    SELECT campaign.name, ad_group.name,
           ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls,
           ad_group_ad.ad.responsive_search_ad.headlines,
           ad_group_ad.ad.responsive_search_ad.descriptions
      FROM ad_group_ad
     WHERE ad_group_ad.status = 'ENABLED'
       AND ad_group.status = 'ENABLED'
       AND campaign.status = 'ENABLED'`);

  console.log(`\n── Live ads (${ads.length}) ──`);
  const urls = new Set<string>();
  for (const a of ads) {
    const ad = a.ad_group_ad?.ad ?? {};
    console.log(`\n  ${a.campaign?.name} › ${a.ad_group?.name}  [ad ${ad.id}]`);
    for (const u of ad.final_urls ?? []) { urls.add(u); console.log(`    → ${u}`); }
    const heads = (ad.responsive_search_ad?.headlines ?? []).map((h: any) => h?.text).filter(Boolean);
    const descs = (ad.responsive_search_ad?.descriptions ?? []).map((d: any) => d?.text).filter(Boolean);
    for (const h of heads) console.log(`    H: ${h}`);
    for (const d of descs) console.log(`    D: ${d}`);
  }

  console.log(`\n── Distinct landing pages (${urls.size}) ──`);
  for (const u of Array.from(urls).sort()) console.log(`  ${u}`);

  // ── Enabled keywords: what the account is paying to be found for ────────
  const kws = await customer.query(`
    SELECT campaign.name, ad_group.name,
           ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
      FROM ad_group_criterion
     WHERE ad_group_criterion.type = 'KEYWORD'
       AND ad_group_criterion.negative = FALSE
       AND ad_group_criterion.status = 'ENABLED'
       AND ad_group.status = 'ENABLED'
       AND campaign.status = 'ENABLED'`);
  console.log(`\n── Enabled keywords (${kws.length}) ──`);
  for (const k of kws) {
    const kw = k.ad_group_criterion?.keyword;
    console.log(`  [${MATCH[String(kw?.match_type)] ?? kw?.match_type}] ${kw?.text}   (${k.campaign?.name})`);
  }

  // ── Probe the served search terms ───────────────────────────────────────
  const d = (off: number) => new Date(Date.now() - off * 86_400_000).toISOString().slice(0, 10);
  // Segment by ad group: which ad group actually served a query is the only way
  // to tell a starved ad group apart from one being cannibalised by a broad-match
  // keyword in a sibling ad group under the same Smart Bidding campaign.
  const terms = await customer.query(`
    SELECT search_term_view.search_term, campaign.name, ad_group.name,
           metrics.cost_micros, metrics.clicks, metrics.impressions,
           metrics.conversions, metrics.all_conversions
      FROM search_term_view
     WHERE segments.date BETWEEN '${d(90)}' AND '${d(1)}'
     ORDER BY metrics.cost_micros DESC
     LIMIT 2000`);

  console.log(`\n── Probe: served search terms containing each word (last 90 days) ──`);
  for (const p of probeList) {
    const hits = terms.filter((t: any) => String(t.search_term_view?.search_term ?? "").toLowerCase().includes(p));
    if (!hits.length) { console.log(`\n  "${p}": no served search terms`); continue; }
    const cost = hits.reduce((s: number, t: any) => s + Number(t.metrics?.cost_micros ?? 0), 0);
    const conv = hits.reduce((s: number, t: any) => s + Number(t.metrics?.all_conversions ?? 0), 0);
    console.log(`\n  "${p}": ${hits.length} term(s) · ${usd(cost)} · ${conv.toFixed(1)} conv (all_conversions)`);
    for (const t of hits.slice(0, 12)) {
      console.log(`     ${usd(t.metrics?.cost_micros)} · ${t.metrics?.clicks} clicks · ${Number(t.metrics?.all_conversions ?? 0).toFixed(1)} conv · "${t.search_term_view?.search_term}"  →  ${t.ad_group?.name}`);
    }
  }
  console.log("");
}

main().catch((e) => {
  const msg = e?.errors?.map((x: any) => x.message).join("; ") || (e instanceof Error ? e.message : String(e));
  console.error(msg); process.exit(1);
});

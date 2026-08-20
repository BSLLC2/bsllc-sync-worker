#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";

/**
 * Read-only policy state for an account: which assets and ads are disapproved
 * or limited, the exact policy topic behind each, and the destination URL when
 * there is one.
 *
 * Google's disapproval emails name a count and a policy label but not the asset
 * or the URL, which is the only part you can act on. This prints both.
 *
 *   npm run dump-ads-policy -- --client=ohio-community-health
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Google returns enums as integers over REST; these are the ones that matter. */
const APPROVAL: Record<string, string> = {
  "2": "APPROVED_LIMITED", "3": "APPROVED", "4": "DISAPPROVED", "5": "AREA_OF_INTEREST_ONLY",
};
const REVIEW: Record<string, string> = {
  "2": "REVIEW_IN_PROGRESS", "3": "REVIEWED", "4": "UNDER_APPEAL", "5": "ELIGIBLE_MAY_SERVE",
};
const name = (m: Record<string, string>, v: unknown) => m[String(v ?? "")] ?? String(v ?? "?");

function printTopics(entries: any[], indent = "     ") {
  for (const e of entries ?? []) {
    console.log(`${indent}topic: ${e?.topic ?? "?"}  (${e?.type ?? "?"})`);
    for (const c of e?.evidences ?? []) {
      const urls = c?.destination_not_working?.expanded_url || c?.destination_not_working?.url;
      if (urls) console.log(`${indent}  broken destination: ${urls}`);
      if (c?.destination_not_working?.dns_error_type) console.log(`${indent}  dns: ${c.destination_not_working.dns_error_type}`);
      if (c?.destination_not_working?.http_error_code) console.log(`${indent}  http: ${c.destination_not_working.http_error_code}`);
      if (c?.text_list?.texts?.length) console.log(`${indent}  text: ${c.text_list.texts.join(" | ")}`);
      if (c?.destination_text_list?.destination_texts?.length) console.log(`${indent}  destination text: ${c.destination_text_list.destination_texts.join(" | ")}`);
    }
  }
}

async function main() {
  const onlyClient = (process.argv.slice(2).find((a) => a.startsWith("--client="))?.slice(9) || "").trim();
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
  console.log(`\n${clientName} [${customerId}] — POLICY STATE (read only)\n${"═".repeat(72)}`);

  // ── Assets ──────────────────────────────────────────────────────────────
  const assets = await customer.query(`
    SELECT asset.id, asset.name, asset.type, asset.final_urls,
           asset.sitelink_asset.link_text,
           asset.sitelink_asset.description1,
           asset.callout_asset.callout_text,
           asset.structured_snippet_asset.header,
           asset.policy_summary.approval_status,
           asset.policy_summary.review_status,
           asset.policy_summary.policy_topic_entries
      FROM asset`);

  const badAssets = assets.filter((a: any) => {
    const s = name(APPROVAL, a.asset?.policy_summary?.approval_status);
    return s === "DISAPPROVED" || s === "APPROVED_LIMITED";
  });

  console.log(`\n── Assets: ${assets.length} total · ${badAssets.length} disapproved or limited ──`);
  for (const a of badAssets) {
    const s = a.asset ?? {};
    const label = s.sitelink_asset?.link_text || s.callout_asset?.callout_text || s.structured_snippet_asset?.header || s.name || `asset ${s.id}`;
    console.log(`\n  ${name(APPROVAL, s.policy_summary?.approval_status)} · ${name(REVIEW, s.policy_summary?.review_status)}`);
    console.log(`     asset ${s.id} · type ${s.type} · "${label}"`);
    for (const u of s.final_urls ?? []) console.log(`     url: ${u}`);
    printTopics(s.policy_summary?.policy_topic_entries);
  }

  // ── Ads ─────────────────────────────────────────────────────────────────
  const ads = await customer.query(`
    SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.final_urls,
           ad_group_ad.status,
           ad_group_ad.policy_summary.approval_status,
           ad_group_ad.policy_summary.review_status,
           ad_group_ad.policy_summary.policy_topic_entries
      FROM ad_group_ad
     WHERE ad_group_ad.status != 'REMOVED'`);

  const badAds = ads.filter((a: any) => {
    const s = name(APPROVAL, a.ad_group_ad?.policy_summary?.approval_status);
    return s === "DISAPPROVED" || s === "APPROVED_LIMITED";
  });
  console.log(`\n── Ads: ${ads.length} total · ${badAds.length} disapproved or limited ──`);
  for (const a of badAds) {
    const s = a.ad_group_ad ?? {};
    console.log(`\n  ${name(APPROVAL, s.policy_summary?.approval_status)} · ${name(REVIEW, s.policy_summary?.review_status)}`);
    console.log(`     ${a.campaign?.name} › ${a.ad_group?.name} · ad ${s.ad?.id} · ${s.status}`);
    for (const u of s.ad?.final_urls ?? []) console.log(`     url: ${u}`);
    printTopics(s.policy_summary?.policy_topic_entries);
  }

  if (!badAssets.length && !badAds.length) console.log(`\n  Nothing disapproved or limited right now.`);
  console.log("");
}

main().catch((e) => {
  const msg = e?.errors?.map((x: any) => x.message).join("; ") || (e instanceof Error ? e.message : String(e));
  console.error(msg); process.exit(1);
});

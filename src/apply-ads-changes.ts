#!/usr/bin/env tsx
import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";

/**
 * Applies a reviewed change set to one Google Ads account.
 *
 * This is deliberately NOT a general-purpose mutation tool. It reads a checked-in
 * JSON change set and supports a fixed, narrow set of operations -- campaign
 * daily budget, campaign-level negative keywords (add and remove), keyword-level
 * final URLs, and detaching assets. Every mutate is validated with validate_only
 * before it is applied, and the prior value of anything changed is printed so the
 * change can be reversed by hand.
 *
 * Guards, all of which abort the run rather than proceed:
 *   - budget moves are capped in both percent and absolute dollars
 *   - negatives matching a protected pattern are refused (a partner or brand
 *     term blocked by accident is far more expensive than the spend it saves)
 *   - a negative already present is skipped, not duplicated
 *   - ad copy is out of scope entirely: OCH runs under LegitScript certification
 *     and ad text changes can put it at risk
 *
 *   npm run apply-ads-changes -- --file=data/och-ads-changes.json            (dry run)
 *   npm run apply-ads-changes -- --file=data/och-ads-changes.json --apply    (live)
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/** A budget may not more than double, nor move more than $100/day, in one run. */
const MAX_BUDGET_FACTOR = 2;
const MAX_BUDGET_DELTA_USD = 100;

/** Enums arrive as integers over REST, so record the readable name in rollback. */
const MATCH_TYPE_NAME: Record<string, string> = { "2": "EXACT", "3": "PHRASE", "4": "BROAD" };

interface ChangeSet {
  client: string;
  note?: string;
  protectedPatterns?: string[];
  /** URLs known to be failing policy review. Refuse to point anything at them. */
  brokenUrls?: string[];
  budgets?: { campaign: string; newDailyUsd: number; reason: string }[];
  campaignNegatives?: { campaign: string; matchType: string; reason: string; keywords: string[] }[];
  removeCampaignNegatives?: { campaign: string; reason: string; keywords: string[] }[];
  keywordFinalUrls?: { reason: string; map: { keyword: string; url: string }[] }[];
  removeAssets?: { assetId: string; label: string; reason: string }[];
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const file = argv.find((a) => a.startsWith("--file="))?.slice(7);
  if (!file) throw new Error("Pass --file=<path to change set json>.");
  const cs: ChangeSet = JSON.parse(readFileSync(file, "utf8"));
  const protectedPatterns = (cs.protectedPatterns ?? []).map((p) => p.toLowerCase());

  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });

  const pgc = new pg.Client({ connectionString: cfg.databaseUrl });
  await pgc.connect();
  let customerId = "";
  let clientName = "";
  try {
    const { rows } = await pgc.query<{ name: string; external_id: string }>(
      `SELECT c.name, cm.external_id FROM clients c
         JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source='google_ads' AND cm.enabled = true
        WHERE cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''`);
    const want = slugify(cs.client);
    const hit = rows.find((r) => slugify(r.name).startsWith(want));
    if (!hit) throw new Error(`No mapped Google Ads account for "${cs.client}". Have: ${rows.map((r) => slugify(r.name)).join(", ")}`);
    customerId = digitsOnly(hit.external_id);
    clientName = hit.name;
  } finally {
    await pgc.end();
  }

  let customer: any;
  try {
    customer = api.Customer({ customer_id: customerId, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
    await customer.query(`SELECT customer.id FROM customer LIMIT 1`);
  } catch {
    customer = api.Customer({ customer_id: customerId, refresh_token: cfg.refreshToken });
  }

  console.log(`\n${clientName} [${customerId}] — ${apply ? "APPLYING" : "DRY RUN (nothing will be changed)"}`);
  if (cs.note) console.log(`${cs.note}\n`);

  const rollback: string[] = [];

  // ── Campaign daily budgets ───────────────────────────────────────────────
  for (const b of cs.budgets ?? []) {
    const rows = await customer.query(`
      SELECT campaign.id, campaign.name, campaign.status,
             campaign_budget.resource_name, campaign_budget.amount_micros
        FROM campaign
       WHERE campaign.name = '${b.campaign.replace(/'/g, "\\'")}' AND campaign.status = 'ENABLED'`);
    if (!rows.length) { console.log(`  ⚠ budget: no enabled campaign named "${b.campaign}" — skipped`); continue; }

    const cur = Number(rows[0].campaign_budget?.amount_micros ?? 0);
    const next = Math.round(b.newDailyUsd * 1_000_000);
    if (cur === next) { console.log(`  ·  budget: "${b.campaign}" already ${usd(cur)} — no change`); continue; }
    if (next > cur * MAX_BUDGET_FACTOR) throw new Error(`Guard: ${usd(cur)} → ${usd(next)} on "${b.campaign}" exceeds ${MAX_BUDGET_FACTOR}x.`);
    if ((next - cur) / 1_000_000 > MAX_BUDGET_DELTA_USD) throw new Error(`Guard: ${usd(cur)} → ${usd(next)} on "${b.campaign}" exceeds $${MAX_BUDGET_DELTA_USD}/day.`);

    const payload = [{ resource_name: rows[0].campaign_budget.resource_name, amount_micros: next }];
    await customer.campaignBudgets.update(payload, { validate_only: true });
    console.log(`  ✅ budget: "${b.campaign}" ${usd(cur)} → ${usd(next)}/day — validated`);
    console.log(`     ${b.reason}`);
    if (apply) {
      await customer.campaignBudgets.update(payload);
      console.log(`     APPLIED`);
      rollback.push(`campaign budget "${b.campaign}": set amount_micros back to ${cur} (${usd(cur)}/day)`);
    }
  }

  // ── Campaign-level negative keywords ─────────────────────────────────────
  for (const n of cs.campaignNegatives ?? []) {
    const rows = await customer.query(`
      SELECT campaign.id, campaign.resource_name, campaign.name
        FROM campaign
       WHERE campaign.name = '${n.campaign.replace(/'/g, "\\'")}' AND campaign.status = 'ENABLED'`);
    if (!rows.length) { console.log(`  ⚠ negatives: no enabled campaign named "${n.campaign}" — skipped`); continue; }
    const campaignRn = rows[0].campaign.resource_name;

    const existingRows = await customer.query(`
      SELECT campaign_criterion.keyword.text
        FROM campaign_criterion
       WHERE campaign_criterion.negative = TRUE
         AND campaign_criterion.type = 'KEYWORD'
         AND campaign.id = ${rows[0].campaign.id}`);
    const existing = new Set(existingRows.map((r: any) => (r.campaign_criterion?.keyword?.text ?? "").toLowerCase()));

    const toAdd: string[] = [];
    for (const kw of n.keywords) {
      const k = kw.toLowerCase().trim();
      const clash = protectedPatterns.find((p) => k.includes(p) || p.includes(k));
      if (clash) throw new Error(`Guard: negative "${kw}" collides with protected pattern "${clash}". Refusing the whole run.`);
      if (existing.has(k)) { console.log(`  ·  negative: "${kw}" already on "${n.campaign}" — skipped`); continue; }
      toAdd.push(kw);
    }
    if (!toAdd.length) { console.log(`  ·  negatives: nothing new for "${n.campaign}"`); continue; }

    const payload = toAdd.map((kw) => ({
      campaign: campaignRn,
      negative: true,
      keyword: { text: kw, match_type: n.matchType },
    }));
    await customer.campaignCriteria.create(payload, { validate_only: true });
    console.log(`  ✅ negatives: ${toAdd.length} ${n.matchType} on "${n.campaign}" — validated`);
    console.log(`     ${toAdd.map((k) => `"${k}"`).join(", ")}`);
    console.log(`     ${n.reason}`);
    if (apply) {
      const res: any = await customer.campaignCriteria.create(payload);
      const names: string[] = (res?.results ?? []).map((r: any) => r.resource_name).filter(Boolean);
      console.log(`     APPLIED — ${names.length} criteria created`);
      for (const rn of names) rollback.push(`negative keyword: remove ${rn}`);
    }
  }

  // ── Remove campaign-level negative keywords ──────────────────────────────
  // The counterpart to adding them. A negative that turns out to block traffic the
  // client actually wants is more expensive than the spend it saved, so removal
  // needs to be as easy as addition -- and recorded the same way.
  for (const n of cs.removeCampaignNegatives ?? []) {
    const rows = await customer.query(`
      SELECT campaign.id, campaign.name
        FROM campaign
       WHERE campaign.name = '${n.campaign.replace(/'/g, "\\'")}' AND campaign.status = 'ENABLED'`);
    if (!rows.length) { console.log(`  ⚠ remove negatives: no enabled campaign named "${n.campaign}" — skipped`); continue; }

    const want = new Set(n.keywords.map((k) => k.toLowerCase().trim()));
    const existing = await customer.query(`
      SELECT campaign_criterion.resource_name, campaign_criterion.keyword.text,
             campaign_criterion.keyword.match_type
        FROM campaign_criterion
       WHERE campaign_criterion.negative = TRUE
         AND campaign_criterion.type = 'KEYWORD'
         AND campaign.id = ${rows[0].campaign.id}`);
    const hits = existing.filter((r: any) => want.has(String(r.campaign_criterion?.keyword?.text ?? "").toLowerCase()));
    const missing = Array.from(want).filter((k) => !hits.some((h: any) => String(h.campaign_criterion.keyword.text).toLowerCase() === k));
    for (const m of missing) console.log(`  ·  remove negative: "${m}" not present on "${n.campaign}" — nothing to do`);
    if (!hits.length) continue;

    const names = hits.map((h: any) => h.campaign_criterion.resource_name);
    await customer.campaignCriteria.remove(names, { validate_only: true });
    console.log(`  ✅ remove negatives: ${hits.length} from "${n.campaign}" — validated`);
    console.log(`     ${hits.map((h: any) => `"${h.campaign_criterion.keyword.text}"`).join(", ")}`);
    console.log(`     ${n.reason}`);
    if (apply) {
      await customer.campaignCriteria.remove(names);
      console.log(`     APPLIED`);
      for (const h of hits as any[]) {
        rollback.push(`negative "${h.campaign_criterion.keyword.text}": re-add to "${n.campaign}" as ${MATCH_TYPE_NAME[String(h.campaign_criterion.keyword.match_type)] ?? h.campaign_criterion.keyword.match_type}`);
      }
    }
  }

  // ── Keyword-level final URLs ─────────────────────────────────────────────
  // A keyword's own final URL overrides the ad's, so this lands the click on the
  // page that answers the search without touching ad copy — which matters here:
  // editing an ad resubmits it for policy review, and this account has an open
  // certificate question we do not want to trip.
  for (const group of cs.keywordFinalUrls ?? []) {
    const rows = await customer.query(`
      SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text,
             ad_group_criterion.final_urls, campaign.name, ad_group.name
        FROM ad_group_criterion
       WHERE ad_group_criterion.type = 'KEYWORD'
         AND ad_group_criterion.negative = FALSE
         AND ad_group_criterion.status = 'ENABLED'
         AND ad_group.status = 'ENABLED'
         AND campaign.status = 'ENABLED'`);
    const byText = new Map<string, any>();
    for (const r of rows) byText.set(String(r.ad_group_criterion?.keyword?.text ?? "").toLowerCase(), r);

    const payload: any[] = [];
    for (const m of group.map) {
      if ((cs.brokenUrls ?? []).some((b) => m.url.startsWith(b))) {
        throw new Error(`Guard: "${m.url}" is on the broken-URL list. Refusing the whole run.`);
      }
      const row = byText.get(m.keyword.toLowerCase());
      if (!row) { console.log(`  ⚠ keyword url: no enabled keyword "${m.keyword}" — skipped`); continue; }
      const cur: string[] = row.ad_group_criterion?.final_urls ?? [];
      if (cur.length === 1 && cur[0] === m.url) { console.log(`  ·  keyword url: "${m.keyword}" already → ${m.url}`); continue; }
      console.log(`  ✅ keyword url: "${m.keyword}" ${cur.length ? cur.join(", ") : "(inherits ad)"} → ${m.url}`);
      payload.push({ resource_name: row.ad_group_criterion.resource_name, final_urls: [m.url], _kw: m.keyword, _cur: cur });
    }
    if (!payload.length) { console.log(`  ·  keyword urls: nothing to change`); continue; }
    console.log(`     ${group.reason}`);
    const clean = payload.map(({ _kw, _cur, ...rest }) => rest);
    await customer.adGroupCriteria.update(clean, { validate_only: true });
    console.log(`     validated (${clean.length})`);
    if (apply) {
      await customer.adGroupCriteria.update(clean);
      console.log(`     APPLIED`);
      for (const p of payload) {
        rollback.push(p._cur.length
          ? `keyword "${p._kw}": restore final_urls to ${p._cur.join(", ")}`
          : `keyword "${p._kw}": clear final_urls so it inherits the ad again (${p.resource_name})`);
      }
    }
  }

  // ── Detach assets ────────────────────────────────────────────────────────
  // Removes the asset's links (campaign / ad group / account level) rather than
  // the asset itself — Google keeps assets around, and detaching is what stops
  // it serving. Reversible by re-linking the same asset id.
  for (const a of cs.removeAssets ?? []) {
    const rn = `customers/${customerId}/assets/${a.assetId}`;
    const links: { resource_name: string; level: string }[] = [];
    for (const [table, field, level] of [
      ["campaign_asset", "campaign_asset", "campaign"],
      ["ad_group_asset", "ad_group_asset", "ad group"],
      ["customer_asset", "customer_asset", "account"],
    ] as const) {
      const rows = await customer.query(
        `SELECT ${field}.resource_name FROM ${table} WHERE ${field}.asset = '${rn}' AND ${field}.status != 'REMOVED'`);
      for (const r of rows) links.push({ resource_name: (r as any)[field].resource_name, level });
    }
    if (!links.length) { console.log(`  ·  asset "${a.label}" (${a.assetId}): not linked anywhere — nothing to do`); continue; }
    console.log(`  ✅ detach asset: "${a.label}" from ${links.length} place(s) — ${links.map((l) => l.level).join(", ")}`);
    console.log(`     ${a.reason}`);
    for (const l of links) {
      const api = l.level === "campaign" ? customer.campaignAssets : l.level === "ad group" ? customer.adGroupAssets : customer.customerAssets;
      await api.remove([l.resource_name], { validate_only: true });
      if (apply) {
        await api.remove([l.resource_name]);
        rollback.push(`asset "${a.label}": re-link asset ${a.assetId} at ${l.level} level (was ${l.resource_name})`);
      }
    }
    console.log(apply ? `     APPLIED` : `     validated`);
  }

  console.log(apply ? `\n── To reverse ──` : `\n── Dry run complete. Re-run with --apply to make these changes. ──`);
  for (const r of rollback) console.log(`  ${r}`);
  if (apply && !rollback.length) console.log(`  (nothing was changed)`);
  console.log("");
}

main().catch((e) => {
  const msg = e?.errors?.map((x: any) => x.message).join("; ") || (e instanceof Error ? e.message : String(e));
  console.error(msg);
  process.exit(1);
});

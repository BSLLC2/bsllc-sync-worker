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
 * JSON change set, supports exactly two operations (campaign daily budget, and
 * campaign-level negative keywords), validates every mutate with validate_only
 * before applying it, and prints the prior value of anything it changes so the
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

interface ChangeSet {
  client: string;
  note?: string;
  protectedPatterns?: string[];
  budgets?: { campaign: string; newDailyUsd: number; reason: string }[];
  campaignNegatives?: { campaign: string; matchType: string; reason: string; keywords: string[] }[];
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

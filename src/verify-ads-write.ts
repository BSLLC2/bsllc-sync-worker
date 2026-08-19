#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";

/**
 * Proves whether this token can WRITE to each mapped account — without writing.
 *
 * verify-all.ts runs `SELECT customer.id`, which only proves read access; a
 * read-only manager link or a Read-only MCC user passes it cleanly and then
 * fails on the first mutate. Google validates permissions on a mutate submitted
 * with validate_only, then returns without applying anything, so this submits a
 * no-op campaign update (setting each campaign's name to the name it already
 * has) and reports what came back.
 *
 *   npm run verify-ads-write -- --client=ohio-community-health
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function main() {
  const argv = process.argv.slice(2);
  const onlyClient = (argv.find((a) => a.startsWith("--client="))?.slice(9) || "").trim();
  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });

  const pgc = new pg.Client({ connectionString: cfg.databaseUrl });
  await pgc.connect();
  try {
    const { rows } = await pgc.query<{ name: string; external_id: string }>(
      `SELECT c.name, cm.external_id FROM clients c
         JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source='google_ads' AND cm.enabled = true
        WHERE cm.external_id IS NOT NULL AND btrim(cm.external_id) <> '' ORDER BY c.name`);
    const targets = rows.filter((r) => !onlyClient || slugify(r.name) === onlyClient);

    console.log(`\n=== Google Ads WRITE capability (validate_only — nothing is changed) ===\n`);
    for (const t of targets) {
      const cid = digitsOnly(t.external_id);
      let customer: any;
      try {
        customer = api.Customer({ customer_id: cid, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
        await customer.query(`SELECT customer.id FROM customer LIMIT 1`);
      } catch {
        customer = api.Customer({ customer_id: cid, refresh_token: cfg.refreshToken });
      }

      let campaigns: any[] = [];
      try {
        campaigns = await customer.query(`SELECT campaign.resource_name, campaign.name FROM campaign WHERE campaign.status != 'REMOVED' LIMIT 1`);
      } catch (e: any) {
        console.log(`  ❓ ${t.name} [${cid}]: could not read campaigns — ${(e?.message ?? e).toString().slice(0, 120)}`);
        continue;
      }
      if (!campaigns.length) { console.log(`  ·  ${t.name} [${cid}]: no campaigns to test against`); continue; }

      // No-op: set the name to the name it already has, validate only.
      const c0 = campaigns[0];
      try {
        await customer.campaigns.update(
          [{ resource_name: c0.campaign.resource_name, name: c0.campaign.name }],
          { validate_only: true },
        );
        console.log(`  ✅ ${t.name} [${cid}]: WRITE OK (validated, not applied)`);
      } catch (e: any) {
        const code = e?.errors?.[0]?.error_code ? Object.values(e.errors[0].error_code)[0] : null;
        const msg = e?.errors?.map((x: any) => x.message).join("; ") || e?.message || String(e);
        const denied = /PERMISSION|NOT_ADMIN|USER_PERMISSION_DENIED|READ_ONLY/i.test(`${code} ${msg}`);
        console.log(`  ${denied ? "🚫" : "⚠️ "} ${t.name} [${cid}]: ${denied ? "WRITE DENIED" : "validate failed"} — ${code ? code + ": " : ""}${msg.slice(0, 160)}`);
      }
    }
    console.log("");
  } finally {
    await pgc.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

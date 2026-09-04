#!/usr/bin/env tsx
import "dotenv/config";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig } from "./config.js";

/**
 * User disputes that Brand Awareness is paused, based on their own UI view
 * showing only 2 campaigns. Before assuming a UI filter, rule out the more
 * fundamental explanation: multiple accounts under this MCC, one of which
 * may have a live "Brand Awareness" campaign we haven't been querying.
 */

const hr = (t: string) => console.log(`\n${"=".repeat(88)}\n${t}\n${"=".repeat(88)}`);
const usd = (m: unknown) => Number(m ?? 0) / 1_000_000;
const $ = (n: number) => `$${n.toFixed(2)}`;
const CAMPSTATUS: Record<string,string> = {"2":"ENABLED","3":"PAUSED","4":"REMOVED"};
const nm = (m: Record<string,string>, v: unknown) => m[String(v ?? "")] ?? String(v ?? "—");

async function main() {
  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });

  hr("1. ALL ACCOUNTS ACCESSIBLE UNDER THIS MCC (login_customer_id)");
  const mcc = api.Customer({ customer_id: cfg.loginCustomerId!, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
  let clients: any[] = [];
  try {
    clients = await mcc.query(`SELECT customer_client.id, customer_client.descriptive_name,
        customer_client.status, customer_client.manager, customer_client.level
        FROM customer_client`);
    for (const r of clients) {
      const cc = r.customer_client ?? {};
      console.log(`  [${cc.id}] "${cc.descriptive_name}"  manager=${cc.manager}  level=${cc.level}  status=${cc.status}`);
    }
  } catch (e: any) {
    console.log(`  [UNAVAILABLE] ${(e?.errors?.map((x:any)=>x.message).join("; ") || e?.message || String(e)).slice(0,300)}`);
  }

  hr("2. SEARCH EVERY ACCESSIBLE CLIENT ACCOUNT FOR A CAMPAIGN NAMED LIKE 'Brand Awareness'");
  for (const r of clients) {
    const cc = r.customer_client ?? {};
    if (cc.manager) continue; // skip sub-manager nodes, only query real accounts
    const id = String(cc.id);
    try {
      const c = api.Customer({ customer_id: id, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
      const camps = await c.query(`SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros
          FROM campaign WHERE campaign.name LIKE '%Brand Awareness%' OR campaign.name LIKE '%OCH%' OR campaign.name LIKE '%OHC%'`);
      if (camps.length) {
        console.log(`  Account ${id} ("${cc.descriptive_name}"):`);
        for (const cr of camps) {
          console.log(`    [${cr.campaign?.id}] ${cr.campaign?.name}  status=${nm(CAMPSTATUS, cr.campaign?.status)}  budget=${$(usd(cr.campaign_budget?.amount_micros))}/day`);
        }
      }
    } catch (e: any) {
      const msg = e?.errors?.map((x:any)=>x.message).join("; ") || e?.message || String(e);
      console.log(`  Account ${id} ("${cc.descriptive_name}"): [UNAVAILABLE] ${msg.slice(0,150)}`);
    }
  }

  console.log(`\nDONE — read only, no changes made.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

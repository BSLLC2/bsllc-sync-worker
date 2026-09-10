#!/usr/bin/env tsx
import "dotenv/config";
import { loadD365Config, getToken } from "./d365.js";

/**
 * Read-only: now that field-level security on leadsourcecode/new_firsttouchsource
 * is off, confirm there's no real backfill gap for leads created since
 * 2026-09-03 (when listing-management changes started) -- every one of
 * them should already carry a real classification since the write itself
 * was landing correctly the whole time; security was only hiding the read.
 *
 *   npm run debug-dpg-leadsourcecode-since-sep3
 */
async function main() {
  const cfg = loadD365Config();
  const token = await getToken(cfg);
  const base = cfg.resourceUrl.replace(/\/$/, "");

  const url =
    `${base}/api/data/v9.2/leads?$select=leadid,fullname,emailaddress1,leadsourcecode,createdon` +
    `&$filter=createdon ge 2026-09-03T00:00:00Z&$orderby=createdon asc`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", Prefer: 'odata.maxpagesize=500' },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = (await res.json()) as { value: Array<{ leadid: string; fullname: string; emailaddress1: string | null; leadsourcecode: number | null; createdon: string }> };

  console.log(`${data.value.length} lead(s) created since 2026-09-03T00:00:00Z.\n`);
  const nulls = data.value.filter((l) => l.leadsourcecode == null);
  console.log(`${nulls.length} of them still have leadsourcecode: null.\n`);
  if (nulls.length > 0) {
    console.log("Leads still null (need investigation):");
    for (const l of nulls) console.log(`  ${l.fullname} <${l.emailaddress1 ?? "no email"}> — created ${l.createdon} — leadid ${l.leadid}`);
  } else {
    console.log("No gap -- every lead since Sep 3 already carries a real classification.");
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

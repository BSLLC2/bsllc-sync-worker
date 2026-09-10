#!/usr/bin/env tsx
import "dotenv/config";
import { loadD365Config, getToken, type OppRow } from "./d365.js";

/**
 * READ-ONLY. What is one won DPG customer worth? Pulls every Closed Won
 * opportunity since --since (default: 12 months ago) straight from Dynamics
 * and prints count, total, median, trimmed mean, p90 and the largest deals,
 * so the client's base customer value can be set from real deals instead of
 * a guess. Reads across ALL sources on purpose — this is about deal size,
 * not attribution. The billable-since rule in import-d365 is untouched.
 *
 *   npm run debug-d365-won-deal-stats -- --since=2025-09-01
 */
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? process.env[k.toUpperCase()] ?? d).trim();

async function main() {
  const since = arg("since") || new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const cfg = loadD365Config();
  const filter = `statecode eq 1 and actualvalue ne null and actualclosedate ge ${since}T00:00:00Z`;
  let url = `${cfg.resourceUrl}/api/data/v9.2/opportunities?$select=opportunityid,name,actualvalue,actualclosedate&$expand=parentcontactid($select=contactid,fullname,createdon)&$filter=${encodeURIComponent(filter)}`;
  const rows: OppRow[] = [];
  while (url) {
    const token = await getToken(cfg);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0", Prefer: "odata.maxpagesize=500" } });
    if (!res.ok) throw new Error(`D365 query failed (${res.status}): ${await res.text()}`);
    const j = (await res.json()) as { value?: OppRow[]; ["@odata.nextLink"]?: string };
    rows.push(...(j.value ?? []));
    url = j["@odata.nextLink"] ?? "";
  }
  const vals = rows.map((r) => Number(r.actualvalue ?? 0)).filter((v) => v > 0).sort((a, b) => a - b);
  const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] ?? 0;
  const trim = Math.floor(vals.length * 0.1);
  const trimmed = vals.slice(trim, vals.length - trim);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  console.log(`Closed Won since ${since}: ${rows.length} deals, ${vals.length} with a value`);
  if (!vals.length) return;
  console.log(`  total     ${usd(vals.reduce((s, x) => s + x, 0))}`);
  console.log(`  median    ${usd(q(0.5))}   ← base customer value candidate`);
  console.log(`  trimmed   ${usd(mean(trimmed))}   (mean, top/bottom 10% dropped)`);
  console.log(`  mean      ${usd(mean(vals))}`);
  console.log(`  p25/p75   ${usd(q(0.25))} / ${usd(q(0.75))}   p90 ${usd(q(0.9))}`);
  // Per-customer cumulative (a customer with three tickets is one customer)
  const byCust = new Map<string, number>();
  for (const r of rows) { const k = r.parentcontactid?.fullname?.trim() || r.name?.trim() || r.opportunityid; byCust.set(k, (byCust.get(k) ?? 0) + Number(r.actualvalue ?? 0)); }
  const cv = [...byCust.values()].filter((v) => v > 0).sort((a, b) => a - b);
  console.log(`  customers ${cv.length} · median cumulative per customer ${usd(cv[Math.floor(cv.length / 2)] ?? 0)}`);
  console.log(`\nLargest deals (named-win candidates above 10× median = ${usd(q(0.5) * 10)}):`);
  for (const r of [...rows].sort((a, b) => Number(b.actualvalue ?? 0) - Number(a.actualvalue ?? 0)).slice(0, 8)) {
    console.log(`  ${(r.actualclosedate ?? "").slice(0, 10)}  ${usd(Number(r.actualvalue ?? 0)).padStart(12)}  ${(r.parentcontactid?.fullname ?? "").slice(0, 28).padEnd(28)}  ${(r.name ?? "").slice(0, 40)}`);
  }
  const months = new Map<string, number>();
  for (const r of rows) { const m = (r.actualclosedate ?? "").slice(0, 7); if (m) months.set(m, (months.get(m) ?? 0) + 1); }
  console.log(`\nDeals per month: ${[...months.entries()].sort().map(([m, n]) => `${m}:${n}`).join("  ")}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

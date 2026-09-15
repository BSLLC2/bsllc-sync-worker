#!/usr/bin/env tsx
import "dotenv/config";
import { loadD365Config, getToken, type OppRow } from "./d365.js";
import { detectSampleRecords, verdictFor, type CrmRecordShape } from "./sample-detect.js";

/**
 * READ-ONLY. What is one won DPG customer worth? Pulls every Closed Won
 * opportunity since --since (default: 12 months ago) straight from Dynamics
 * and prints count, total, median, trimmed mean, p90 and the largest deals,
 * so the client's base customer value can be set from real deals instead of
 * a guess. Reads across ALL sources on purpose — this is about deal size,
 * not attribution. The billable-since rule in import-d365 is untouched.
 *
 * IT MUST EXCLUDE DEMO DATA, AND IT DID NOT. Every other reader of this org
 * runs sample-detect.ts; this one applied no filter at all, and its output is
 * what a base customer value gets set from. Over DPG's 29 Closed Won it printed
 * median $37,000, total $2,081,897, mean $71,790 — and five of those rows,
 * 60% of the value, are the CRM's stock demo records. Without them: 24 deals,
 * $830,697, mean $34,612. The printed mean was 2.1x the truth, and somebody
 * quoted it.
 *
 * So it prints BOTH figures now — the clean set first, because that is the one
 * a customer value comes from — and NAMES every row it excluded with the
 * reason, so the contaminated figure can never be quoted by accident again.
 * Confirmed samples and suspected-import rows are both held out here: a value
 * per customer is an average, and one migrated batch moves an average as hard
 * as demo data does. The attribution chain still COUNTS suspects (they are
 * equally the shape of a client's own migrated history) — this is a different
 * question, and the "all rows" block is right there for comparison.
 *
 *   npm run debug-d365-won-deal-stats -- --since=2025-09-01
 */
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? process.env[k.toUpperCase()] ?? d).trim();

async function main() {
  const since = arg("since") || new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const cfg = loadD365Config();
  const filter = `statecode eq 1 and actualvalue ne null and actualclosedate ge ${since}T00:00:00Z`;
  // The arrival columns are what sample-detect.ts actually reads — a row's NAME
  // is the weakest signal and the one the demo data here defeated.
  let url = `${cfg.resourceUrl}/api/data/v9.2/opportunities?$select=opportunityid,name,actualvalue,actualclosedate,createdon,importsequencenumber,overriddencreatedon,_createdby_value&$expand=parentcontactid($select=contactid,fullname,createdon)&$filter=${encodeURIComponent(filter)}`;
  const rows: OppRow[] = [];
  while (url) {
    const token = await getToken(cfg);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0", Prefer: "odata.maxpagesize=500" } });
    if (!res.ok) throw new Error(`D365 query failed (${res.status}): ${await res.text()}`);
    const j = (await res.json()) as { value?: OppRow[]; ["@odata.nextLink"]?: string };
    rows.push(...(j.value ?? []));
    url = j["@odata.nextLink"] ?? "";
  }
  const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

  // The same detector every other reader of this org runs (src/sample-detect.ts):
  // how a row ARRIVED, not what it is called. Leads are not in this query, so
  // the batch rule sees opportunities only — which is why the per-record
  // imported-and-backdated signal matters here.
  const verdicts = detectSampleRecords(
    rows.map((r): CrmRecordShape => ({
      id: r.opportunityid,
      text: [r.name, r.parentcontactid?.fullname],
      writtenAt: r.createdon ?? null,
      writtenBy: r._createdby_value ?? null,
      importSequenceNumber: r.importsequencenumber ?? null,
      overriddenCreatedOn: r.overriddencreatedon ?? null,
      businessDate: (r.actualclosedate ?? r.overriddencreatedon ?? r.createdon ?? "").slice(0, 10) || null,
    })),
  );
  const excluded = rows.filter((r) => { const v = verdictFor(verdicts, r.opportunityid); return v.confirmed || v.suspect; });
  const clean = rows.filter((r) => !excluded.includes(r));

  const stats = (label: string, set: OppRow[], markBase: boolean) => {
    const vals = set.map((r) => Number(r.actualvalue ?? 0)).filter((v) => v > 0).sort((a, b) => a - b);
    console.log(`\n${label}: ${set.length} deals, ${vals.length} with a value`);
    if (!vals.length) { console.log("  (nothing to summarize)"); return; }
    const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] ?? 0;
    const trim = Math.floor(vals.length * 0.1);
    const trimmed = vals.slice(trim, vals.length - trim);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    console.log(`  total     ${usd(vals.reduce((s, x) => s + x, 0))}`);
    console.log(`  median    ${usd(q(0.5))}${markBase ? "   ← base customer value candidate" : ""}`);
    console.log(`  trimmed   ${usd(mean(trimmed))}   (mean, top/bottom 10% dropped)`);
    console.log(`  mean      ${usd(mean(vals))}`);
    console.log(`  p25/p75   ${usd(q(0.25))} / ${usd(q(0.75))}   p90 ${usd(q(0.9))}`);
    // Per-customer cumulative (a customer with three tickets is one customer)
    const byCust = new Map<string, number>();
    for (const r of set) { const k = r.parentcontactid?.fullname?.trim() || r.name?.trim() || r.opportunityid; byCust.set(k, (byCust.get(k) ?? 0) + Number(r.actualvalue ?? 0)); }
    const cv = [...byCust.values()].filter((v) => v > 0).sort((a, b) => a - b);
    console.log(`  customers ${cv.length} · median cumulative per customer ${usd(cv[Math.floor(cv.length / 2)] ?? 0)}`);
    console.log(`  Largest deals (named-win candidates above 10× median = ${usd(q(0.5) * 10)}):`);
    for (const r of [...set].sort((a, b) => Number(b.actualvalue ?? 0) - Number(a.actualvalue ?? 0)).slice(0, 8)) {
      console.log(`    ${(r.actualclosedate ?? "").slice(0, 10)}  ${usd(Number(r.actualvalue ?? 0)).padStart(12)}  ${(r.parentcontactid?.fullname ?? "").slice(0, 28).padEnd(28)}  ${(r.name ?? "").slice(0, 40)}`);
    }
  };

  console.log(`Closed Won since ${since}: ${rows.length} deals pulled`);
  if (!rows.length) return;

  // Clean first and marked as the base, because this is the figure a customer
  // value is set from. The contaminated one is printed underneath so the two
  // can be compared, never quoted in isolation.
  stats("REAL BUSINESS (demo / imported rows held out)", clean, true);

  console.log(`\nHELD OUT — ${excluded.length} row(s), ${usd(excluded.reduce((s, r) => s + Number(r.actualvalue ?? 0), 0))}:`);
  if (!excluded.length) console.log("  none — nothing in this window arrived like demo data or an import.");
  for (const r of [...excluded].sort((a, b) => Number(b.actualvalue ?? 0) - Number(a.actualvalue ?? 0))) {
    const v = verdictFor(verdicts, r.opportunityid);
    console.log(`  ${(r.actualclosedate ?? "").slice(0, 10)}  ${usd(Number(r.actualvalue ?? 0)).padStart(12)}  ${(r.parentcontactid?.fullname ?? "").slice(0, 28).padEnd(28)}  ${(r.name ?? "").slice(0, 32).padEnd(32)}  ${v.confirmed ? "DEMO" : "looks imported"} — ${v.reason ?? ""}`);
  }

  stats("ALL ROWS (contaminated — for comparison only, never quote this)", rows, false);
  if (excluded.length) {
    console.log("\n⚠ The two blocks above differ. Quote the first one. The second includes the rows listed as held out.");
  }

  const months = new Map<string, number>();
  for (const r of clean) { const m = (r.actualclosedate ?? "").slice(0, 7); if (m) months.set(m, (months.get(m) ?? 0) + 1); }
  console.log(`\nDeals per month (real business only): ${[...months.entries()].sort().map(([m, n]) => `${m}:${n}`).join("  ")}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

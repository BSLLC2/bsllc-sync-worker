#!/usr/bin/env tsx
import "dotenv/config";
import { loadD365Config, fetchClosedWon, classify, FIRST_TOUCH_GOLIVE, type Bucket } from "./d365.js";

/**
 * Read-only D365 connectivity + attribution check. Mints a token, pulls Closed
 * Won opportunities, and prints the bucket breakdown + a few samples. Writes
 * nothing to the database — run this first to confirm credentials and the
 * service principal's read access before enabling the importer/cron.
 *
 *   npm run verify-d365
 */
async function main() {
  const cfg = loadD365Config();
  console.log(`Verifying D365 at ${cfg.resourceUrl} (field go-live ${FIRST_TOUCH_GOLIVE})…\n`);

  const opps = await fetchClosedWon(cfg);
  console.log(`✅ Auth OK. Fetched ${opps.length} Closed Won opportunit${opps.length === 1 ? "y" : "ies"}.\n`);

  const rev: Record<Bucket, number> = { bsllc: 0, other: 0, manual: 0, unknown: 0 };
  const cnt: Record<Bucket, number> = { bsllc: 0, other: 0, manual: 0, unknown: 0 };
  let noContact = 0, noSource = 0;
  for (const o of opps) {
    const c = o.parentcontactid ?? null;
    if (!c) noContact++;
    if (c && c.new_firsttouchsource == null) noSource++;
    const b = classify(c?.new_firsttouchsource ?? null, c?.createdon ?? null);
    rev[b] += Math.round((o.actualvalue ?? 0) * 100);
    cnt[b] += 1;
  }
  const usd = (cents: number) => "$" + Math.round(cents / 100).toLocaleString("en-US");
  console.log("Attribution breakdown:");
  console.log(`  BS LLC-driven   ${String(cnt.bsllc).padStart(4)} deals · ${usd(rev.bsllc)}`);
  console.log(`  Other tracked   ${String(cnt.other).padStart(4)} deals · ${usd(rev.other)}`);
  console.log(`  Unknown (pre)   ${String(cnt.unknown).padStart(4)} deals · ${usd(rev.unknown)}`);
  console.log(`  Manual (excl.)  ${String(cnt.manual).padStart(4)} deals · ${usd(rev.manual)}`);
  console.log(`  → Billable (BS LLC + other): ${usd(rev.bsllc + rev.other)}\n`);
  if (noContact) console.log(`  ⚠ ${noContact} opportunit(ies) had no related Contact (parentcontactid null) — check whether reps use customerid instead.`);
  if (noSource) console.log(`  ℹ ${noSource} Contact(s) had a blank first-touch source (expected for pre-go-live Contacts).`);

  console.log("\nSample (up to 5):");
  for (const o of opps.slice(0, 5)) {
    const c = o.parentcontactid ?? null;
    console.log(
      `  ${o.actualclosedate?.slice(0, 10) ?? "?"} · ${(o.name ?? "").slice(0, 32).padEnd(32)} ` +
        `· $${o.actualvalue ?? 0} · src=${c?.new_firsttouchsource ?? "∅"} → ${classify(c?.new_firsttouchsource ?? null, c?.createdon ?? null)}`,
    );
  }
  console.log("\nDone (nothing written).");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

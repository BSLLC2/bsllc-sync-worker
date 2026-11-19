#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";
import { NO_ACCOUNTS_NOTE } from "./meta/depth.js";
import { runAccount } from "./meta/depth-run.js";
import { ensureMetaDepthTables, metaTargets } from "./meta/depth-store.js";

/**
 * Meta ads in depth: each ad by day, each ad set by placement, age and gender,
 * and the campaign, ad set and ad settings as a daily snapshot. READ-ONLY: every
 * request is a GET; nothing is written to Meta. The reasoning is in src/meta/depth.ts.
 *
 *   npm run ads-meta-days                      (every mapped account)
 *   npm run ads-meta-days -- --client=slug     (one account; stamps no book-wide heartbeat)
 *   npm run ads-meta-days -- --days=14         (a shorter window)
 *   npm run ads-meta-days -- --dry-run         (read and print, write nothing)
 */
function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}
const hasFlag = (name: string) => process.argv.slice(2).includes(`--${name}`);

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Missing DATABASE_URL.");
  const onlyClient = arg("client") ?? "";
  const dryRun = hasFlag("dry-run");
  const daysArg = arg("days") ? Number(arg("days")) : undefined;
  if (daysArg != null && !(Number.isFinite(daysArg) && daysArg >= 1)) {
    console.error(`--days must be a number of days, 1 or more (got "${arg("days")}").`);
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    if (!dryRun) await ensureMetaDepthTables(c);
    const targets = (await metaTargets(c, onlyClient || undefined)).filter((t) => t.accountId);
    if (!targets.length) {
      console.log(`No mapped Meta accounts${onlyClient ? ` for ${onlyClient}` : ""}.`);
      emitJobSummary(formatJobSummary({ accounts: 0, read: 0, ads: 0, segments: 0, entities: 0 }, NO_ACCOUNTS_NOTE));
      return;
    }
    const token = process.env.META_ACCESS_TOKEN?.trim() ?? "";
    if (!token) {
      // A green run over a job that can never read is the "stopped, or retired?" confusion Data health exists to end.
      console.error(`${targets.length} Meta ad account(s) are mapped and META_ACCESS_TOKEN is not set on the worker, so none of them can be read.`);
      emitJobSummary(formatJobSummary({ accounts: targets.length, read: 0, failed: targets.length }, "META_ACCESS_TOKEN is not set on the worker"));
      process.exit(1);
    }
    console.log(`Meta ads in depth · ${targets.length} account(s)`);
    console.log(`READ-ONLY — every request is a GET. Nothing is written to Meta.\n`);

    let read = 0, failed = 0, ads = 0, segments = 0, entities = 0;
    const problems: string[] = [];
    for (const t of targets) {
      const r = await runAccount(c, token, t, today, { days: daysArg, write: !dryRun });
      const okParts = Object.values(r.parts).filter((p) => p.ok).length;
      if (okParts > 0) read += 1;
      failed += 3 - okParts;
      ads += r.parts.ad_days.rows; segments += r.parts.segments.rows; entities += r.parts.entities.rows;
      problems.push(...r.problems);
      console.log(`  ${t.clientName}: ad-days ${r.parts.ad_days.ok ? r.parts.ad_days.rows : "FAILED"}, segments ${r.parts.segments.ok ? r.parts.segments.rows : "FAILED"}, entities ${r.parts.entities.ok ? r.parts.entities.rows : "partial or FAILED"}${dryRun ? " (dry run, nothing written)" : ""}`);
    }
    console.log(`\n${"─".repeat(72)}`);
    console.log(`${read}/${targets.length} account(s) read · ${ads} ad-days · ${segments} segment-days · ${entities} entities${failed ? ` · ${failed} part(s) failed` : ""}`);
    for (const p of problems) console.log(`  · ${p}`);
    if (dryRun) { console.log(`\nDry run complete — nothing written.`); return; }
    emitJobSummary(formatJobSummary(
      { accounts: targets.length, read, ads, segments, entities, failed },
      read === 0 ? "no account could be read — no Meta ad figure was captured for any client today" : `${read}/${targets.length} account(s) read`,
    ));
    if (read === 0) process.exit(1);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

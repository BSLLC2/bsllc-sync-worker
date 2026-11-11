#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { openCustomer } from "./apply-ads-changes.js";
import { mappedAccounts } from "./ads/store.js";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";
import {
  ENTITY_KINDS, FIRST_SNAPSHOT_NOTE, NO_ACCOUNTS_NOTE,
  accountLine, applySnapshotPlan, loadOpenIntervals,
  planCounts, reconcile, recordSnapshotFailure, recordSnapshotScan,
  type UnrecognisedEnum,
} from "./ads/structure-snapshot.js";
import { CORE_KINDS, readAccount } from "./ads/structure-read.js";

/**
 * Take a structural snapshot of every mapped ad account.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
 *
 * `ads-change-history` records what somebody DID. This records what the
 * account IS, on a date, so any two dates can be diffed — and so a stretch the
 * change job missed still has an answer at both ends of it. The reasoning in
 * full is in src/ads/structure-snapshot.ts.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 *
 * Every query is a SELECT. This writes nothing to any ad account, proposes
 * nothing and applies nothing.
 *
 * ── DAILY ──────────────────────────────────────────────────────────────────
 *
 * The question is "what was live on this date", and a date has one answer a
 * day. A change made and undone inside one day is invisible here and is in the
 * change log with its hour, which is the division of labour on purpose.
 *
 *   npm run ads-structure-snapshot
 *   npm run ads-structure-snapshot -- --client=some-client-slug
 *   npm run ads-structure-snapshot -- --dry-run   (read and print, write nothing)
 */

const PLATFORM = "google_ads";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}
const hasFlag = (name: string) => process.argv.slice(2).includes(`--${name}`);

/** Distinct field/value pairs, so one unknown enum on 400 keywords is one
 *  line rather than four hundred. */
function summariseUnrecognised(list: UnrecognisedEnum[]): string[] {
  const counts = new Map<string, number>();
  for (const u of list) {
    const k = `${u.field} = ${u.raw}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([k, n]) => `${k} on ${n} row(s) — stored as UNRECOGNISED, not as its digits`);
}

async function main() {
  const cfg = loadConfig();
  const onlyClient = arg("client") ?? "";
  const dryRun = hasFlag("dry-run");
  // TODAY, and there is no flag to change it. A snapshot is a reading of the
  // account as it is now, so writing it under a past date would file today's
  // state as an answer to a question about a day nobody looked at — the exact
  // fabrication the whole interval design refuses. A day that was missed stays
  // missed, and the gap between the intervals either side is what says so.
  const on = new Date().toISOString().slice(0, 10);
  const api = new GoogleAdsApi({
    client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken,
  });

  const c = new pg.Client({ connectionString: cfg.databaseUrl });
  await c.connect();
  try {
    const targets = await mappedAccounts(c, PLATFORM, onlyClient || undefined);
    if (!targets.length) {
      console.log(`No mapped ${PLATFORM} accounts${onlyClient ? ` for ${onlyClient}` : ""}.`);
      // A run that succeeded across ZERO accounts is green, recent and
      // meaningless. It has to read as the fault it is.
      emitJobSummary(formatJobSummary({ accounts: 0, read: 0, entities: 0, changed: 0 }, NO_ACCOUNTS_NOTE));
      return;
    }

    console.log(`Structure snapshot · ${targets.length} account(s) · ${on} · grain: ${ENTITY_KINDS.join(", ")}`);
    console.log(`READ-ONLY — every query is a SELECT. Nothing is written to any ad account.\n`);

    let read = 0, totalEntities = 0, totalChanged = 0, totalUnrecognised = 0;
    const problems: string[] = [];
    const coreFailures: string[] = [];

    for (const t of targets) {
      const accountId = digitsOnly(t.accountId);
      try {
        const customer = await openCustomer(api, cfg, accountId);
        const { entities, completeKinds, problems: kindProblems, unrecognised } = await readAccount(customer);
        const open = await loadOpenIntervals(c, PLATFORM, accountId);
        const plan = reconcile({ open, read: entities, on, completeKinds });
        const counts = planCounts(plan);
        read += 1;
        totalEntities += counts.read;
        totalChanged += counts.changed;
        totalUnrecognised += unrecognised.length;

        // A campaign or a budget that was not read is not a quiet account: the dashboard's campaign, pacing and by-day
        // tables are drawn from them. It is said in the scan row, the heartbeat note and the exit code, not only in a log line.
        const coreFailed = CORE_KINDS.filter((k) => !completeKinds.includes(k));
        const notes: string[] = [];
        if (!open.length) notes.push(FIRST_SNAPSHOT_NOTE);
        if (plan.replaces.length) notes.push(`${plan.replaces.length} row(s) re-taken for today`);
        if (plan.incompleteKinds.length) notes.push(`not read in full: ${plan.incompleteKinds.join(", ")}`);
        console.log(accountLine(t.clientName, counts, notes));
        for (const p of kindProblems) problems.push(`${t.clientName}: ${p}`);
        if (coreFailed.length) {
          coreFailures.push(`${t.clientName}: ${coreFailed.join(" and ")}`);
          problems.push(`${t.clientName}: ${coreFailed.join(" and ")} could not be read, so the dashboard shows no ${coreFailed.join(" or ")} for this account. ${kindProblems.find((p) => /^(campaigns|budgets) /.test(p)) ?? ""}`.trim());
        }
        for (const u of summariseUnrecognised(unrecognised)) problems.push(`${t.clientName}: ${u}`);

        if (dryRun) { console.log(`      (dry run, nothing written)`); continue; }
        await applySnapshotPlan(c, t.clientId, PLATFORM, accountId, plan, on);
        await recordSnapshotScan(
          c, t.clientId, PLATFORM, accountId, on, counts, unrecognised.length, true,
          `${counts.read} entities, ${counts.changed} changed, ${counts.opened} new, ${counts.closed} gone`
          + (plan.incompleteKinds.length ? `; not read in full: ${plan.incompleteKinds.join(",")}` : "")
          + (coreFailed.length ? `; COULD NOT READ ${coreFailed.join(",").toUpperCase()}: ${(kindProblems.find((p) => /^(campaigns|budgets) /.test(p)) ?? "").slice(0, 160)}` : ""),
        );
      } catch (e) {
        // One account's credentials or API hiccup must not take the run down
        // for every other client, and must never be recorded as a clean
        // snapshot — the scan row says the read failed, so a reading over this
        // date knows it is looking at a gap rather than at an empty account.
        const msg = e instanceof Error ? e.message : String(e);
        problems.push(`${t.clientName} failed: ${msg.slice(0, 200)}`);
        console.log(`  ⚠ ${t.clientName}: ${msg.slice(0, 200)}`);
        if (!dryRun) await recordSnapshotFailure(c, t.clientId, PLATFORM, accountId, on, msg).catch(() => {});
      }
    }

    console.log(`\n${"─".repeat(72)}`);
    console.log(
      `${read}/${targets.length} account(s) read · ${totalEntities} entit${totalEntities === 1 ? "y" : "ies"} · ${totalChanged} changed since the last snapshot`
      + `${totalChanged === 0 && read > 0 ? " — nothing moved, which is what a stable account looks like" : ""}`,
    );
    if (totalUnrecognised) console.log(`${totalUnrecognised} enum value(s) this build does not recognise — each named above.`);
    for (const p of problems) console.log(`  · ${p}`);
    if (dryRun) { console.log(`\nDry run complete — nothing written.`); return; }

    emitJobSummary(formatJobSummary(
      { accounts: targets.length, read, entities: totalEntities, changed: totalChanged, unrecognised: totalUnrecognised, core_failed: coreFailures.length },
      read === 0
        ? "no account could be read — no structure was captured for any client today"
        : coreFailures.length
          ? `CAMPAIGNS OR BUDGETS NOT READ for ${coreFailures.join("; ").slice(0, 120)}`
          : `${read}/${targets.length} account(s) read, ${totalEntities} entities, ${totalChanged} changed`,
    ));
    // A run that could not read the campaigns of an account is a failed run for that account, not a green one.
    if (coreFailures.length) process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

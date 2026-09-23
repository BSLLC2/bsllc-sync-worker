#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { openCustomer } from "./apply-ads-changes.js";
import { mappedAccounts } from "./ads/store.js";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";
import {
  AD_GROUP_GAQL, AD_GROUP_KEYWORD_GAQL, BID_STRATEGY_GAQL, BUDGET_GAQL,
  CAMPAIGN_GAQL, CAMPAIGN_KEYWORD_GAQL, ENTITY_KINDS, FIRST_SNAPSHOT_NOTE,
  MAX_ENTITIES_PER_KIND, NO_ACCOUNTS_NOTE,
  accountLine, applySnapshotPlan, loadOpenIntervals, normalizeAdGroup,
  normalizeAdGroupKeyword, normalizeBidStrategy, normalizeBudget, normalizeCampaign,
  normalizeCampaignKeyword, planCounts, reconcile, recordSnapshotFailure, recordSnapshotScan,
  type EntityKind, type SnapshotEntity, type UnrecognisedEnum,
} from "./ads/structure-snapshot.js";

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

interface KindRead {
  entities: SnapshotEntity[];
  /** True only where the whole list came back: not a failed query, not a
   *  response sitting at the row cap. Only a complete kind may close. */
  complete: boolean;
  problem: string | null;
}

/**
 * One kind, read and normalized.
 *
 * A QUERY THAT THREW RETURNS `complete: false` AND AN EMPTY LIST, which is not
 * the same as an account with none of that kind — the difference is the whole
 * point, and it is what stops a permissions hiccup closing every keyword on a
 * live account.
 */
async function readKind(
  customer: any,
  label: string,
  gaql: string,
  normalize: (row: any, report?: UnrecognisedEnum[]) => SnapshotEntity | null,
  report: UnrecognisedEnum[],
): Promise<KindRead> {
  let rows: any[];
  try {
    rows = await customer.query(gaql);
  } catch (e: any) {
    const msg = e?.errors?.map((x: any) => x.message).join("; ") || e?.message || String(e);
    return { entities: [], complete: false, problem: `${label} could not be read (${msg.slice(0, 160)}) — nothing of that kind was closed` };
  }
  const list = Array.isArray(rows) ? rows : [];
  const capped = list.length >= MAX_ENTITIES_PER_KIND;
  const entities = list.map((r) => normalize(r, report)).filter((e): e is SnapshotEntity => e !== null);
  return {
    entities,
    complete: !capped,
    problem: capped
      ? `${label} came back at the ${MAX_ENTITIES_PER_KIND}-row ceiling, so this run cannot say it read them all — nothing of that kind was closed. Raise MAX_ENTITIES_PER_KIND once somebody has read this line.`
      : null,
  };
}

async function readAccount(customer: any): Promise<{
  entities: SnapshotEntity[];
  completeKinds: EntityKind[];
  problems: string[];
  unrecognised: UnrecognisedEnum[];
}> {
  const report: UnrecognisedEnum[] = [];
  const campaigns = await readKind(customer, "campaigns", CAMPAIGN_GAQL, normalizeCampaign, report);
  const adGroups = await readKind(customer, "ad groups", AD_GROUP_GAQL, normalizeAdGroup, report);
  const agKeywords = await readKind(customer, "ad group keywords", AD_GROUP_KEYWORD_GAQL, normalizeAdGroupKeyword, report);
  const campKeywords = await readKind(customer, "campaign negative keywords", CAMPAIGN_KEYWORD_GAQL, normalizeCampaignKeyword, report);
  const budgets = await readKind(customer, "budgets", BUDGET_GAQL, normalizeBudget, report);
  const strategies = await readKind(customer, "bid strategies", BID_STRATEGY_GAQL, normalizeBidStrategy, report);

  const completeKinds: EntityKind[] = [];
  if (campaigns.complete) completeKinds.push("campaign");
  if (adGroups.complete) completeKinds.push("ad_group");
  // ONE KIND, TWO QUERIES. `keyword` covers ad group criteria and campaign
  // negatives, so it is complete only where BOTH came back in full — a
  // half-read kind that closed on the half it did read would remove every
  // campaign negative in the account on a morning the second query failed.
  if (agKeywords.complete && campKeywords.complete) completeKinds.push("keyword");
  if (budgets.complete) completeKinds.push("budget");
  if (strategies.complete) completeKinds.push("bid_strategy");

  const reads = [campaigns, adGroups, agKeywords, campKeywords, budgets, strategies];
  return {
    entities: reads.flatMap((r) => r.entities),
    completeKinds,
    problems: reads.map((r) => r.problem).filter((p): p is string => p !== null),
    unrecognised: report,
  };
}

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

        const notes: string[] = [];
        if (!open.length) notes.push(FIRST_SNAPSHOT_NOTE);
        if (plan.replaces.length) notes.push(`${plan.replaces.length} row(s) re-taken for today`);
        if (plan.incompleteKinds.length) notes.push(`not read in full: ${plan.incompleteKinds.join(", ")}`);
        console.log(accountLine(t.clientName, counts, notes));
        for (const p of kindProblems) problems.push(`${t.clientName}: ${p}`);
        for (const u of summariseUnrecognised(unrecognised)) problems.push(`${t.clientName}: ${u}`);

        if (dryRun) { console.log(`      (dry run, nothing written)`); continue; }
        await applySnapshotPlan(c, t.clientId, PLATFORM, accountId, plan, on);
        await recordSnapshotScan(
          c, t.clientId, PLATFORM, accountId, on, counts, unrecognised.length, true,
          `${counts.read} entities, ${counts.changed} changed, ${counts.opened} new, ${counts.closed} gone`
          + (plan.incompleteKinds.length ? `; not read in full: ${plan.incompleteKinds.join(",")}` : ""),
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
      { accounts: targets.length, read, entities: totalEntities, changed: totalChanged, unrecognised: totalUnrecognised },
      read === 0
        ? "no account could be read — no structure was captured for any client today"
        : `${read}/${targets.length} account(s) read, ${totalEntities} entities, ${totalChanged} changed`,
    ));
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

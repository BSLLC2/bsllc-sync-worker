#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { openCustomer } from "./apply-ads-changes.js";
import { upsertFinding } from "./ads/store.js";
import type { DerivedFinding } from "./ads/rules.js";
import {
  planReversal, type ReversalFacts, type ReversalItem, type StoredChange,
} from "./ads/change-reversal.js";

/**
 * Propose putting a window of recorded changes back.
 *
 * ── WHAT THIS IS, SAID PLAINLY ─────────────────────────────────────────────
 *
 * It is NOT a restore and it must never be described as one. Google Ads keeps
 * no snapshots and offers nothing that takes an account back to how it looked
 * on a given day. What exists is `change_event`, a thirty-day log of what
 * changed, which the v194 capture job copies into `ads_change_events` before
 * the platform deletes it.
 *
 * So this reads those stored rows for one account between two times, works out
 * which of them our own guarded apply path is able to write back, and files
 * each one as an ordinary finding at status `proposed`. A person approves them
 * in the dashboard, one at a time, and `ads-apply-approved` performs them
 * through exactly the same guards as any other change.
 *
 * ── IT APPLIES NOTHING ─────────────────────────────────────────────────────
 *
 * There is no `--apply`. The strongest verb here is `--propose`, which writes
 * rows into a review queue. Nothing in this file mutates an ad account, and
 * the one live call it makes is a SELECT for campaign names.
 *
 *   npm run ads-reverse-window -- --client=<name> --from=2026-09-15           (dry run)
 *   npm run ads-reverse-window -- --client=<name> --from=2026-09-15 --propose
 *
 * `--to` defaults to now. `--no-live` skips the campaign-name lookup and works
 * from what the database already holds, which is what a sandbox can run.
 */

const ACTOR = "ads-reverse-window";
const arg = (name: string) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

interface AccountRow {
  client_id: string; client_name: string; platform: string; account_id: string;
}

/**
 * Campaign id → NAME.
 *
 * The guarded apply path addresses a campaign by name and the change feed
 * carries only an id, so this is the one piece the stored rows cannot supply.
 * It is read from the account where credentials allow it, and from what the
 * findings table already recorded otherwise — a campaign that is in neither is
 * REFUSED by the planner rather than guessed at.
 */
async function campaignNames(
  c: pg.Client, account: AccountRow, live: boolean,
): Promise<{ names: Record<string, string>; from: string }> {
  const names: Record<string, string> = {};
  // Whatever the findings table already knows, first and free.
  const { rows } = await c.query<{ entity_id: string; entity_name: string | null }>(
    `SELECT DISTINCT entity_id, entity_name FROM ads_findings
      WHERE client_id = $1 AND platform = $2 AND entity_type = 'campaign' AND entity_name IS NOT NULL`,
    [account.client_id, account.platform],
  );
  for (const r of rows) {
    const id = String(r.entity_id).split(":")[0] ?? "";
    if (/^\d+$/.test(id) && r.entity_name) names[id] = r.entity_name;
  }
  if (!live || account.platform !== "google_ads") {
    return { names, from: `${Object.keys(names).length} campaign name(s) from what the findings table already recorded` };
  }
  // A SELECT. Nothing here writes to an ad account.
  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });
  const customer = await openCustomer(api, cfg, digitsOnly(account.account_id));
  const live_rows = await customer.query(`SELECT campaign.id, campaign.name FROM campaign`);
  for (const r of live_rows as any[]) {
    if (r?.campaign?.id != null) names[String(r.campaign.id)] = String(r.campaign.name ?? "");
  }
  return { names, from: `${Object.keys(names).length} campaign name(s), read from the account` };
}

/**
 * A reversal, as a finding the existing queue understands.
 *
 * `entity_id` carries the WINDOW and the THING, so reversing a later window
 * files its own row rather than colliding with an earlier one under
 * `uq_ads_findings_key`, and re-running the same window writes nothing new.
 *
 * It is keyed on the entity's own label rather than its position in the plan,
 * because the plan is sorted newest-change-first: a change landing between two
 * runs would shift every position after it and file a second row for work
 * already on the queue.
 *
 * `upsertFinding`'s own lifecycle rules then do the rest: a reversal somebody
 * dismissed stays dismissed, and one already approved or applied is left
 * exactly where it is.
 */
const keySlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

function asFinding(item: ReversalItem, windowStart: Date, windowEnd: Date): DerivedFinding {
  return {
    entityType: "campaign",
    entityId: `revert:${ymd(windowStart)}:${item.op}:${keySlug(item.entity)}`,
    entityName: item.entity,
    findingType: "change_reversal",
    severity: "medium",
    riskLevel: "medium",
    // OUR OWN APPLY PATH MAKES THIS CHANGE, so it is an `api` row and is never
    // handed to a vendor: shared/ads-vendor-send.ts refuses an api finding
    // from a hand-over, and the brief generator only ever selects `vendor`.
    applicability: "api",
    title: `Put back: ${item.entity}`,
    summary: item.what + (item.caution ? ` ${item.caution}` : ""),
    evidence: {
      metrics: { changes: item.changes },
      windowStart: ymd(windowStart),
      windowEnd: ymd(windowEnd),
      lines: [
        item.what,
        `${item.changes} recorded change${item.changes === 1 ? "" : "s"} to this between ${ymd(windowStart)} and ${ymd(windowEnd)}.`,
        ...(item.caution ? [item.caution] : []),
      ],
    },
    // A REVERSAL CARRIES NO ESTIMATE. What putting a value back is worth is
    // whatever the change that moved it cost, and nothing here can measure
    // that. An invented figure would rank this row against real ones.
    estImpactCents: 0,
    impactUnit: "usd_month",
    impactAssumption: "Not estimated. This puts a recorded value back; what that is worth depends on what moving it cost, which is not measured here.",
    changePayload: {
      op: item.op,
      body: item.body,
      plainEnglish: item.what,
      guard: "Validated against the live account first, and refused if somebody has moved this since the recorded change.",
    },
    guardNote: "A reversal is a change: it passes validate_only, the budget caps, the staleness guard and the protected terms like any other, and its own prior values are captured before it is written.",
    rank: { cents: null, basis: "unpriced", why: "A reversal puts a value back; what that is worth is not measured here.", blockedBy: null },
  } as DerivedFinding;
}

async function main() {
  const clientArg = arg("client");
  const fromArg = arg("from");
  if (!clientArg || !fromArg) {
    console.error("Pass --client=<name or slug> and --from=<YYYY-MM-DD>. Add --propose to file the reversals for review.");
    process.exit(1);
  }
  const propose = flag("propose");
  const live = !flag("no-live");
  const windowStart = new Date(`${fromArg}T00:00:00Z`);
  const windowEnd = arg("to") ? new Date(`${arg("to")}T23:59:59Z`) : new Date();
  if (!Number.isFinite(windowStart.getTime()) || !Number.isFinite(windowEnd.getTime())) {
    console.error("--from and --to are YYYY-MM-DD.");
    process.exit(1);
  }

  const cfg = loadConfig();
  const c = new pg.Client({ connectionString: cfg.databaseUrl });
  await c.connect();
  try {
    const { rows: accounts } = await c.query<AccountRow>(
      `SELECT DISTINCT e.client_id, cl.name AS client_name, e.platform, e.account_id
         FROM ads_change_events e
         JOIN clients cl ON cl.id = e.client_id
        WHERE lower(cl.name) = lower($1) OR cl.id = $1`,
      [clientArg],
    );
    if (!accounts.length) {
      console.log(`No captured change history for "${clientArg}". Nothing before the first capture run exists anywhere — the platform keeps thirty days and deletes the rest.`);
      return;
    }

    for (const account of accounts) {
      const { rows: events } = await c.query<StoredChange>(
        `SELECT event_key AS "eventKey", changed_at AS "changedAt", resource_type AS "resourceType",
                operation, changed_fields AS "changedFields", campaign_id AS "campaignId",
                ad_group_id AS "adGroupId", old_resource_json AS "oldResourceJson",
                new_resource_json AS "newResourceJson"
           FROM ads_change_events
          WHERE platform = $1 AND account_id = $2 AND changed_at BETWEEN $3 AND $4
          ORDER BY changed_at ASC`,
        [account.platform, account.account_id, windowStart.toISOString(), windowEnd.toISOString()],
      );
      const { rows: scans } = await c.query<{ covered_from: string; covered_to: string; ok: boolean }>(
        `SELECT covered_from, covered_to, ok FROM ads_change_scans WHERE platform = $1 AND account_id = $2`,
        [account.platform, account.account_id],
      );
      const { names, from } = await campaignNames(c, account, live).catch((e) => {
        console.log(`   (campaign names could not be read: ${e instanceof Error ? e.message : String(e)})`);
        return { names: {} as Record<string, string>, from: "no campaign names" };
      });

      const facts: ReversalFacts = {
        windowStart, windowEnd,
        events: events.map((e) => ({ ...e, changedAt: new Date(e.changedAt as unknown as string).toISOString() })),
        coverage: scans[0]
          ? { coveredFrom: scans[0].covered_from, coveredTo: scans[0].covered_to, ok: scans[0].ok }
          : { coveredFrom: null, coveredTo: null, ok: null },
        campaignNames: names,
      };
      const plan = planReversal(facts);

      // The account id is never printed. The client's name is enough to say
      // which account this is about, and an ad account id is a credential-
      // adjacent identifier this repo does not put in output.
      console.log(`\n${account.client_name} · ${account.platform}`);
      console.log(`  ${from}`);
      console.log(`  ${plan.coverageNote}`);
      console.log(`  ${plan.summary}`);
      if (!plan.complete) {
        console.log(`  ⚠ INCOMPLETE. Approving everything below does not put this window back, because part of it was never recorded here.`);
      }
      for (const item of plan.reversible) {
        console.log(`  ↩ ${item.entity} — ${item.what}`);
        if (item.caution) console.log(`     ${item.caution}`);
      }
      for (const b of plan.blocked) {
        console.log(`  ✖ ${b.entity} — ${b.what}. ${b.why}`);
      }
      if (!propose) {
        console.log(`  (dry run — nothing filed. Re-run with --propose to put these in the review queue.)`);
        continue;
      }
      let filed = 0;
      for (const item of plan.reversible) {
        const out = await upsertFinding(
          c, account.client_id, account.platform, account.account_id,
          asFinding(item, windowStart, windowEnd), ACTOR,
        );
        if (out.outcome === "created") filed += 1;
      }
      console.log(`  ${filed} filed for review, ${plan.reversible.length - filed} already there.`);
      console.log(`  Nothing has been changed in the account. Each one waits for a person to approve it.`);
    }
  } finally {
    await c.end();
  }
}

const isEntry = process.argv[1] && /ads-reverse-window\.[tj]s$/.test(process.argv[1]);
if (isEntry) {
  main().catch((e) => {
    const msg = e?.errors?.map((x: any) => x.message).join("; ") || (e instanceof Error ? e.message : String(e));
    console.error(msg);
    process.exit(1);
  });
}

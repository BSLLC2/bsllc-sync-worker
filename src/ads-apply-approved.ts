#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { GoogleAdsAdapter } from "./ads/google-ads-adapter.js";
import { MetaAdapter, loadMetaConfig } from "./ads/meta-adapter.js";
import { logEvent, protectedPatternsFor } from "./ads/store.js";

/**
 * Drains human-approved findings, and human-requested rollbacks.
 *
 * THE ONLY WAY A CHANGE REACHES A LIVE AD ACCOUNT. Nothing in this file decides
 * anything: it acts on a status a person set by pressing Approve in the
 * dashboard, and on a rollback a person requested. An agent cannot put a row
 * into 'approved' — that route is session-authenticated and role-gated.
 *
 * The sequence for each approved finding, and every step is load-bearing:
 *   1. re-run validate_only against the live account. The evidence is days old
 *      by now; if the campaign was renamed or the budget already moved, this is
 *      where we find out instead of writing something wrong.
 *   2. snapshot the BEFORE metrics, so the 14/28-day check has something to
 *      compare against. Taken before the mutate, never reconstructed after.
 *   3. apply through the guarded path shared with the hand-run CLI.
 *   4. record the prior values. If the adapter cannot produce them, the change
 *      is treated as FAILED, not as applied — an irreversible change is not one
 *      we make unattended.
 *   5. schedule the after-checks and write the audit row.
 *
 *   npm run ads-apply-approved                (live — this is the applying job)
 *   npm run ads-apply-approved -- --dry-run   (validate only, apply nothing)
 */

const ACTOR = "ads-apply-approved";

/** Window length used for the before/after comparison, in days. */
const MEASURE_DAYS = 28;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 86_400_000));

interface Pending {
  id: string; client_id: string; platform: string; account_id: string;
  entity_type: string; entity_id: string; title: string;
  change_payload_json: string | null; rollback_json: string | null;
  approved_by: string | null;
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });
  const google = new GoogleAdsAdapter(api, cfg);
  const meta = new MetaAdapter(loadMetaConfig());
  const adapterFor = (platform: string) => (platform === "meta" ? meta : google);

  const c = new pg.Client({ connectionString: cfg.databaseUrl });
  await c.connect();
  try {
    console.log(dryRun ? "DRY RUN — validating only, nothing will be applied.\n" : "Applying human-approved ads changes.\n");

    // ── 1. Rollbacks first ──────────────────────────────────────────────────
    // A person asking to undo something is more urgent than a person asking to
    // do something new, and doing rollbacks first means a bad apply from this
    // same run can be reversed on the next one without queueing behind it.
    const { rows: rollbacks } = await c.query<Pending>(
      `SELECT f.id, f.client_id, f.platform, f.account_id, f.entity_type, f.entity_id, f.title,
              f.change_payload_json, f.rollback_json, f.approved_by
         FROM ads_findings f
        WHERE f.status IN ('applied','verifying','won','lost')
          AND f.rollback_json IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ads_finding_events e
             WHERE e.finding_id = f.id AND e.action = 'rollback_requested'
               AND e.at > COALESCE((SELECT max(e2.at) FROM ads_finding_events e2
                                     WHERE e2.finding_id = f.id AND e2.action = 'rolled_back'), 'epoch'::timestamptz))`,
    );
    for (const r of rollbacks) {
      const adapter = adapterFor(r.platform);
      const accountId = r.platform === "google_ads" ? digitsOnly(r.account_id) : r.account_id;
      (adapter as GoogleAdsAdapter | MetaAdapter).bindAccount(accountId);
      console.log(`↩ rollback: ${r.title}`);
      if (dryRun) { console.log(`   (dry run — skipped)`); continue; }
      const out = await adapter.rollback(JSON.parse(r.rollback_json ?? "[]"));
      if (!out.ok) {
        console.log(`   ✖ failed: ${out.message.slice(0, 300)}`);
        await logEvent(c, r.id, "apply_failed", ACTOR, `Rollback failed: ${out.message.slice(0, 500)}`, null);
        continue;
      }
      await c.query(
        `UPDATE ads_findings SET status = 'reverted', reverted_by = $2, reverted_at = now() WHERE id = $1`,
        [r.id, ACTOR],
      );
      await logEvent(c, r.id, "rolled_back", ACTOR, "Prior values restored.", JSON.stringify(out.result));
      console.log(`   ✅ restored`);
      if (out.rollbackPlan.length) {
        console.log(`   ⚠ needs a person: ${out.rollbackPlan.join(" · ")}`);
      }
    }

    // ── 2. Approved changes ─────────────────────────────────────────────────
    const { rows: approved } = await c.query<Pending>(
      `SELECT id, client_id, platform, account_id, entity_type, entity_id, title,
              change_payload_json, rollback_json, approved_by
         FROM ads_findings
        WHERE status = 'approved' AND change_payload_json IS NOT NULL
        ORDER BY est_impact_cents DESC NULLS LAST`,
    );
    if (!approved.length && !rollbacks.length) { console.log("Nothing approved and nothing to roll back."); return; }

    for (const r of approved) {
      const payload = JSON.parse(r.change_payload_json ?? "null") as { op: string; body: unknown } | null;
      if (!payload?.op) {
        await logEvent(c, r.id, "apply_failed", ACTOR, "No change payload on an approved finding.", null);
        continue;
      }
      const adapter = adapterFor(r.platform);
      const accountId = r.platform === "google_ads" ? digitsOnly(r.account_id) : r.account_id;
      (adapter as GoogleAdsAdapter | MetaAdapter).bindAccount(accountId);
      console.log(`\n▶ ${r.title}`);
      console.log(`   approved by ${r.approved_by ?? "?"} · ${r.platform} [${accountId}] · op ${payload.op}`);

      // 1. Re-validate against the live account.
      const v = await adapter.validate(payload.op, payload.body);
      if (!v.ok) {
        console.log(`   ✖ validation failed: ${v.message.slice(0, 400)}`);
        await logEvent(c, r.id, "apply_failed", ACTOR, `Validation failed: ${v.message.slice(0, 500)}`, null);
        // Back to proposed, not dismissed: the account changed under us and a
        // person should see the refreshed evidence, not lose the finding.
        await c.query(`UPDATE ads_findings SET status = 'proposed', approved_by = NULL, approved_at = NULL WHERE id = $1`, [r.id]);
        continue;
      }
      console.log(`   ✅ validated${v.serverValidated ? " by the platform" : " locally only (platform has no dry-run endpoint)"}`);

      if (dryRun) { console.log(`   (dry run — not applied)`); continue; }

      // 2. Before-metrics, taken BEFORE the mutate.
      const before = await adapter.verify(r.entity_type, r.entity_id, daysAgo(MEASURE_DAYS + 1), daysAgo(1));

      // 3 + 4. Apply, and insist on prior values.
      const protectedPatterns = await protectedPatternsFor(c, r.client_id);
      const out = r.platform === "google_ads"
        ? await (adapter as GoogleAdsAdapter).apply(payload.op, payload.body, protectedPatterns)
        : await adapter.apply(payload.op, payload.body);

      if (!out.ok || !out.priorValues) {
        console.log(`   ✖ apply failed: ${out.message.slice(0, 400)}`);
        await logEvent(c, r.id, "apply_failed", ACTOR, out.priorValues ? out.message.slice(0, 500) : "No prior values were recorded, so the change was not treated as applied.", null);
        await c.query(`UPDATE ads_findings SET status = 'proposed', approved_by = NULL, approved_at = NULL WHERE id = $1`, [r.id]);
        continue;
      }

      // 5. Record everything, and schedule the after-checks.
      await c.query(
        `UPDATE ads_findings SET
           status = 'verifying', applied_by = $2, applied_at = now(),
           applied_result_json = $3, rollback_json = $4, before_metrics_json = $5,
           verify_at_14 = now() + interval '14 days', verify_at_28 = now() + interval '28 days'
         WHERE id = $1`,
        [r.id, ACTOR, JSON.stringify(out.result), JSON.stringify(out.priorValues), JSON.stringify(before)],
      );
      await logEvent(
        c, r.id, "applied", ACTOR,
        `Applied. Reversal recorded; 14- and 28-day checks scheduled.`,
        JSON.stringify({ rollbackPlan: out.rollbackPlan, log: out.message.split("\n").slice(0, 40) }),
      );
      console.log(`   ✅ APPLIED — reversible, after-checks scheduled`);
      for (const line of out.rollbackPlan) console.log(`      reverse: ${line}`);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  const msg = e?.errors?.map((x: any) => x.message).join("; ") || (e instanceof Error ? e.message : String(e));
  console.error(msg);
  process.exit(1);
});

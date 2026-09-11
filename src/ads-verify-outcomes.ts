#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { GoogleAdsAdapter } from "./ads/google-ads-adapter.js";
import { MetaAdapter, loadMetaConfig } from "./ads/meta-adapter.js";
import { logEvent } from "./ads/store.js";

/**
 * The after-check. This is the part that turns a pile of recommendations into
 * an institutional record of what actually works.
 *
 * When a change is applied, the apply job snapshots the 28 days BEFORE it and
 * schedules two checks, at 14 and 28 days. This job re-reads the same entity
 * over the equivalent window after the change and writes the comparison onto
 * the finding. Over a few months that accumulates into the thing no chat
 * session can have: a per-client, per-tactic history of what moved the number
 * and what didn't.
 *
 * A LOSS IS AS VALUABLE AS A WIN and is recorded exactly as plainly. The whole
 * point is to stop re-recommending something that has already been tried and
 * failed here.
 *
 * Read-only against the platforms.
 *
 *   npm run ads-verify-outcomes
 */

const ACTOR = "ads-verify-outcomes";
const MEASURE_DAYS = 28;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 86_400_000));
const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;

/**
 * Did it work?
 *
 * Judged on the metric the finding was ABOUT, not on a generic "did things get
 * better", because an account improving for unrelated reasons is not evidence
 * that our change did anything.
 *  - waste findings (negatives, dead keywords): spend on the entity should FALL
 *    without conversions falling with it.
 *  - budget findings: conversions should RISE.
 * Anything that moves less than 10% either way is inconclusive rather than
 * forced into a verdict — a coin-flip recorded as a win is worse than no record.
 */
function judge(
  findingType: string,
  before: Record<string, number>,
  after: Record<string, number>,
  predictedCents: number | null,
): { verdict: "won" | "lost" | "inconclusive"; observedCents: number | null; note: string } {
  const bCost = before.costMicros ?? 0;
  const aCost = after.costMicros ?? 0;
  const bConv = before.conversions ?? 0;
  const aConv = after.conversions ?? 0;
  const costDelta = bCost - aCost;                     // positive = we spent less
  const convDelta = aConv - bConv;                     // positive = more conversions
  const relCost = bCost > 0 ? costDelta / bCost : 0;
  const relConv = bConv > 0 ? convDelta / bConv : (aConv > 0 ? 1 : 0);

  if (findingType === "budget_limited") {
    if (relConv > 0.10) {
      return {
        verdict: "won", observedCents: Math.round(convDelta * 100),
        note: `Conversions rose from ${bConv.toFixed(1)} to ${aConv.toFixed(1)} (+${(relConv * 100).toFixed(0)}%) after the budget increase. Predicted ${predictedCents ? usd(predictedCents) : "no figure"}/mo of extra reach.`,
      };
    }
    if (relConv < -0.10) {
      return {
        verdict: "lost", observedCents: Math.round(convDelta * 100),
        note: `Conversions fell from ${bConv.toFixed(1)} to ${aConv.toFixed(1)} after the budget increase. More spend bought worse traffic — do not repeat this on this account.`,
      };
    }
    return { verdict: "inconclusive", observedCents: null, note: `Conversions moved ${(relConv * 100).toFixed(0)}% — inside the noise band, so no verdict.` };
  }

  // Waste-reduction findings.
  if (relCost > 0.10 && relConv >= -0.10) {
    return {
      verdict: "won", observedCents: Math.round(costDelta / 10_000),
      note: `Spend fell ${usd(Math.round(costDelta / 10_000))} (${(relCost * 100).toFixed(0)}%) with conversions holding (${bConv.toFixed(1)} → ${aConv.toFixed(1)}). Predicted ${predictedCents ? usd(predictedCents) : "no figure"}/mo.`,
    };
  }
  if (relConv < -0.10) {
    return {
      verdict: "lost", observedCents: Math.round(costDelta / 10_000),
      note: `Conversions fell from ${bConv.toFixed(1)} to ${aConv.toFixed(1)}. The saving cost us business — this blocked traffic we wanted. Roll back and do not re-propose.`,
    };
  }
  return { verdict: "inconclusive", observedCents: null, note: `Spend moved ${(relCost * 100).toFixed(0)}% and conversions ${(relConv * 100).toFixed(0)}% — inside the noise band, so no verdict.` };
}

async function main() {
  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });
  const google = new GoogleAdsAdapter(api, cfg);
  const meta = new MetaAdapter(loadMetaConfig());

  const c = new pg.Client({ connectionString: cfg.databaseUrl });
  await c.connect();
  try {
    // Both horizons in one pass: a row is due at 14 days and again at 28, and
    // outcomes_json holds one entry per horizon so both are kept.
    const { rows } = await c.query<{
      id: string; platform: string; account_id: string; entity_type: string; entity_id: string;
      finding_type: string; title: string; est_impact_cents: number | null;
      before_metrics_json: string | null; outcomes_json: string | null;
      verify_at_14: Date | null; verify_at_28: Date | null;
    }>(
      `SELECT id, platform, account_id, entity_type, entity_id, finding_type, title, est_impact_cents,
              before_metrics_json, outcomes_json, verify_at_14, verify_at_28
         FROM ads_findings
        WHERE status IN ('verifying','won','lost')
          AND (verify_at_14 <= now() OR verify_at_28 <= now())`,
    );
    if (!rows.length) { console.log("No after-checks are due."); return; }
    console.log(`${rows.length} finding(s) with an after-check due. READ-ONLY — nothing is changed in any account.\n`);

    for (const r of rows) {
      const existing: any[] = r.outcomes_json ? JSON.parse(r.outcomes_json) : [];
      const done = new Set(existing.map((o) => o.horizonDays));
      const due: number[] = [];
      if (r.verify_at_14 && r.verify_at_14 <= new Date() && !done.has(14)) due.push(14);
      if (r.verify_at_28 && r.verify_at_28 <= new Date() && !done.has(28)) due.push(28);
      if (!due.length) continue;

      const adapter = r.platform === "meta" ? meta : google;
      const accountId = r.platform === "google_ads" ? digitsOnly(r.account_id) : r.account_id;
      adapter.bindAccount(accountId);

      const before = r.before_metrics_json ? JSON.parse(r.before_metrics_json).metrics ?? {} : {};
      console.log(`▶ ${r.title}`);

      for (const horizon of due) {
        // Compare like with like: the same number of days, immediately before
        // the change and immediately after it. A 14-day after-window against a
        // 28-day before-window would report a halving that is pure arithmetic.
        const after = await adapter.verify(r.entity_type, r.entity_id, daysAgo(horizon), daysAgo(1));
        const beforeScaled: Record<string, number> = {};
        for (const [k, v] of Object.entries(before)) beforeScaled[k] = (v as number) * (horizon / MEASURE_DAYS);

        const { verdict, observedCents, note } = judge(r.finding_type, beforeScaled, after.metrics, r.est_impact_cents);
        existing.push({
          checkedAt: new Date().toISOString(), horizonDays: horizon,
          before: beforeScaled, after: after.metrics,
          predictedCents: r.est_impact_cents, observedCents, verdict, note,
        });
        console.log(`   ${horizon}d: ${verdict.toUpperCase()} — ${note}`);
        await logEvent(c, r.id, "verified", ACTOR, `${horizon}-day check: ${verdict}. ${note}`, JSON.stringify({ horizon, before: beforeScaled, after: after.metrics }));
      }

      // The 28-day verdict is the one that settles it; before that a 14-day
      // read is a progress note, not a conclusion.
      const settled = existing.find((o) => o.horizonDays === 28);
      const status = settled ? (settled.verdict === "inconclusive" ? "applied" : settled.verdict) : "verifying";
      await c.query(`UPDATE ads_findings SET outcomes_json = $2, status = $3 WHERE id = $1`, [r.id, JSON.stringify(existing), status]);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

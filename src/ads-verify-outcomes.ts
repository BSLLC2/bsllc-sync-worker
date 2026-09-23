#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { GoogleAdsAdapter } from "./ads/google-ads-adapter.js";
import type { PlatformAdapter } from "./ads/platform.js";
import { MetaAdapter, loadMetaConfig } from "./ads/meta-adapter.js";
import { logEvent } from "./ads/store.js";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";
import { changeWindowReading, OBSERVATIONAL_CAVEAT } from "./ads/change-window.js";
import {
  episodesFrom, episodeKey, episodeDue, outcomeWindows, outcomeReading, noiseBand, noiseBandLine,
  OUTCOME_HORIZONS, outcomeYmd, type OutcomeEventFact,
} from "./ads/outcome-record.js";

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
 * ── TWO ENTRY POINTS, ONE MEASUREMENT (2026-09-23) ─────────────────────────
 *
 * The paragraph above described a job that had never measured anything. The
 * three statuses it selects on — verifying, won, lost — are written in exactly
 * one place, `src/ads-apply-approved.ts`, after a successful apply, which
 * first asks `adsWriteAuthorityFor`. `clients.ads_write_authority` has no
 * default and is null on every client, so nothing has ever been applied that
 * way and pass one has always found nothing due.
 *
 * `ads_change_events` (v194) records EVERY change to an account, whoever made
 * it, so pass two measures what happened after a change we did not have to
 * make. It is a SECOND PASS OF THIS JOB rather than a second job: the verdict
 * words, the noise band and the caveat all come out of
 * `src/ads/outcome-record.ts`, so the two cannot drift into measuring the same
 * thing differently. Pass one keeps its own before-snapshot, which is better
 * evidence than a window read back off the feed, and it now judges against the
 * same band.
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
 *
 * THE BAND IS `noiseBand()` (2026-09-23), not the flat tenth this used to
 * carry. A tenth of twelve conversions is one conversion, and a coin-flip
 * recorded as a win is worse than no record. `noiseBand` is the Poisson sizing
 * in `src/ads/outcome-record.ts` with the old tenth kept as a floor, so a busy
 * account reaches exactly the verdicts it always did and a small one stops
 * reporting noise as a result. The same function judges the change-feed pass,
 * which is what makes this one job rather than two.
 *
 * A before window holding less than one conversion has no denominator at all —
 * `ads.conversions` is a float — so the verdict is inconclusive and the note
 * says why rather than printing a percentage of nothing.
 *
 * SPEND IS NOT GIVEN A BAND. It is not a sample; it is what was spent. It
 * still gets no causal claim.
 */
const SPEND_MOVE_BAND = 0.10;

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
  const band = noiseBand(bConv);

  // Nothing to divide by. Said as its own answer rather than folded into the
  // noise sentence, because "too small to measure" and "measured, no move" are
  // different facts about the account.
  if (band === null) {
    return {
      verdict: "inconclusive",
      observedCents: null,
      note: `This entity recorded ${bConv.toFixed(1)} conversions before the change, which is too few to compare anything against — no percentage is produced.`,
    };
  }
  const relConv = convDelta / bConv;
  const noise = noiseBandLine(bConv, band);

  if (findingType === "budget_limited") {
    if (relConv > band) {
      return {
        verdict: "won", observedCents: Math.round(convDelta * 100),
        note: `Conversions rose from ${bConv.toFixed(1)} to ${aConv.toFixed(1)} (+${(relConv * 100).toFixed(0)}%) after the budget increase. Predicted ${predictedCents ? usd(predictedCents) : "no figure"}/mo of extra reach. ${noise}`,
      };
    }
    if (relConv < -band) {
      return {
        verdict: "lost", observedCents: Math.round(convDelta * 100),
        note: `Conversions fell from ${bConv.toFixed(1)} to ${aConv.toFixed(1)} after the budget increase. More spend bought worse traffic — do not repeat this on this account. ${noise}`,
      };
    }
    return { verdict: "inconclusive", observedCents: null, note: `Conversions moved ${(relConv * 100).toFixed(0)}%, which is inside the noise band. ${noise}` };
  }

  // Waste-reduction findings.
  if (relCost > SPEND_MOVE_BAND && relConv >= -band) {
    return {
      verdict: "won", observedCents: Math.round(costDelta / 10_000),
      note: `Spend fell ${usd(Math.round(costDelta / 10_000))} (${(relCost * 100).toFixed(0)}%) with conversions holding (${bConv.toFixed(1)} → ${aConv.toFixed(1)}). Predicted ${predictedCents ? usd(predictedCents) : "no figure"}/mo. ${noise}`,
    };
  }
  if (relConv < -band) {
    return {
      verdict: "lost", observedCents: Math.round(costDelta / 10_000),
      note: `Conversions fell from ${bConv.toFixed(1)} to ${aConv.toFixed(1)}. The saving cost us business — this blocked traffic we wanted. Roll back and do not re-propose. ${noise}`,
    };
  }
  return { verdict: "inconclusive", observedCents: null, note: `Spend moved ${(relCost * 100).toFixed(0)}% and conversions ${(relConv * 100).toFixed(0)}%, which is inside the noise band. ${noise}` };
}

/**
 * Who else worked on this thing while we were measuring it.
 *
 * Reads ads_change_events and ads_change_scans — rows the change-history
 * capture job wrote. Both halves matter: the events say what landed, the scan
 * row says whether we were capturing at all, and with no scan row the reading
 * comes back "not known" rather than "clean". See src/ads/change-window.ts.
 *
 * `verify` measures the WHOLE ACCOUNT for any entity that is not a campaign
 * (GoogleAdsAdapter.verify), so the scope widens to match rather than
 * pretending the measurement was narrower than it was.
 */
async function windowSharedWith(
  c: pg.Client,
  platform: string,
  accountId: string,
  entityType: string,
  entityId: string,
  windowStart: Date,
  windowEnd: Date,
) {
  const wholeAccount = entityType !== "campaign";
  const campaignId = wholeAccount ? null : (entityId.split(":")[0] ?? "");
  const { rows: scans } = await c.query<{ covered_from: string }>(
    `SELECT covered_from FROM ads_change_scans WHERE platform = $1 AND account_id = $2`,
    [platform, accountId],
  );
  const { rows: events } = await c.query<{
    changed_at: Date; actor_kind: string; actor_internal: boolean | null; actor_email: string | null;
  }>(
    `SELECT changed_at, actor_kind, actor_internal, actor_email
       FROM ads_change_events
      WHERE platform = $1 AND account_id = $2
        AND changed_at >= $3 AND changed_at <= $4
        AND ($5::text IS NULL OR campaign_id = $5)`,
    [platform, accountId, windowStart, windowEnd, campaignId && /^\d+$/.test(campaignId) ? campaignId : null],
  );
  return changeWindowReading({
    coveredFrom: scans[0]?.covered_from ? new Date(`${scans[0].covered_from}T00:00:00.000Z`) : null,
    windowStart,
    windowEnd,
    wholeAccount,
    events: events.map((e) => ({
      changedAt: e.changed_at,
      actorKind: e.actor_kind,
      actorInternal: e.actor_internal,
      actorEmail: e.actor_email,
    })),
  });
}

/**
 * ── PASS TWO: what happened after every change, not only after ours ────────
 *
 * How many measurements one run may take. Each is two platform reads, and a
 * first run on an account with a month of captured history could otherwise
 * try several hundred in one go. Whatever is left is REPORTED and picked up
 * tomorrow — a cap that hides its own backlog is a job that looks finished.
 */
const MAX_OUTCOME_READS = 40;

/** How far back this reads its own stored events. The platform keeps
 *  change_event for 30 days, but OUR rows persist, so the record deepens past
 *  that on its own and an episode that has just reached its 28-day horizon is
 *  still in range. */
const EPISODE_LOOKBACK_DAYS = 120;

interface OutcomeAccount { clientId: string; platform: string; accountId: string }

async function measureChangeFeed(
  c: pg.Client,
  adapterFor: (platform: string) => PlatformAdapter & { bindAccount(id: string): void },
): Promise<{ accounts: number; episodes: number; measured: number; deferred: number }> {
  const since = new Date(Date.now() - EPISODE_LOOKBACK_DAYS * 86_400_000);
  const { rows: accounts } = await c.query<OutcomeAccount>(
    `SELECT DISTINCT client_id AS "clientId", platform, account_id AS "accountId"
       FROM ads_change_events WHERE changed_at >= $1`,
    [since],
  );
  let episodes = 0;
  let measured = 0;
  let deferred = 0;

  for (const acct of accounts) {
    // Everything captured for the account, in one read. The episode grouping
    // is pure and lives in src/ads/outcome-record.ts.
    const { rows: evs } = await c.query<{
      changed_at: Date; campaign_id: string | null; resource_type: string | null;
      operation: string | null; actor_kind: string; actor_internal: boolean | null; actor_email: string | null;
    }>(
      `SELECT changed_at, campaign_id, resource_type, operation, actor_kind, actor_internal, actor_email
         FROM ads_change_events
        WHERE platform = $1 AND account_id = $2 AND changed_at >= $3
        ORDER BY changed_at ASC`,
      [acct.platform, acct.accountId, since],
    );
    const { rows: scans } = await c.query<{ covered_from: string }>(
      `SELECT covered_from FROM ads_change_scans WHERE platform = $1 AND account_id = $2`,
      [acct.platform, acct.accountId],
    );
    const coveredFrom = scans[0]?.covered_from ? new Date(`${scans[0].covered_from}T00:00:00.000Z`) : null;

    const facts: OutcomeEventFact[] = evs.map((e) => ({
      changedAt: e.changed_at,
      campaignId: e.campaign_id,
      resourceType: e.resource_type,
      operation: e.operation,
      actorKind: e.actor_kind,
      actorInternal: e.actor_internal,
    }));
    const eps = episodesFrom(facts);
    episodes += eps.length;

    // What we already measured, so a second run writes nothing and costs no
    // platform read at all.
    const { rows: doneRows } = await c.query<{ episode_key: string; horizon_days: number }>(
      `SELECT episode_key, horizon_days FROM ads_change_outcomes WHERE platform = $1 AND account_id = $2`,
      [acct.platform, acct.accountId],
    );
    const done = new Set(doneRows.map((d) => `${d.episode_key}|${d.horizon_days}`));

    const now = new Date();
    for (const ep of eps) {
      const key = episodeKey(acct.accountId, ep.campaignId, ep.start);
      for (const horizon of OUTCOME_HORIZONS) {
        if (done.has(`${key}|${horizon}`)) continue;
        if (!episodeDue(ep, horizon, now)) continue;
        if (measured >= MAX_OUTCOME_READS) { deferred += 1; continue; }

        const windows = outcomeWindows(ep, horizon);
        // A campaign episode measures that campaign; an account-level one
        // measures the account, which is also what the adapter does for any
        // entity that is not a campaign.
        const wholeAccount = !ep.campaignId;
        const entityType = wholeAccount ? "account" : "campaign";
        const entityId = ep.campaignId || "";

        // Every other captured change on the same entity inside the after
        // window — an account-level change touches every campaign, so it
        // counts against a campaign episode too.
        const otherAfter = facts
          .filter((e) => !ep.events.includes(e))
          .filter((e) => wholeAccount || e.campaignId === ep.campaignId || e.campaignId === null)
          .filter((e) => e.changedAt >= windows.afterStart && e.changedAt <= windows.afterEnd)
          .map((e) => ({ changedAt: e.changedAt, actorKind: e.actorKind, actorInternal: e.actorInternal, actorEmail: null }));

        // OUR OWN APPLIED FINDING IS THE SPECIAL CASE THAT KNOWS WHAT IT
        // CHANGED. Where one landed inside the episode on the same entity, the
        // record says so and names the finding, rather than reporting our own
        // work back to us as somebody else's.
        const { rows: ours } = await c.query<{ id: string; title: string }>(
          `SELECT id, title FROM ads_findings
            WHERE platform = $1 AND account_id = $2 AND applied_at IS NOT NULL
              AND applied_at >= $3 AND applied_at <= $4
              AND ($5::text = '' OR entity_id LIKE $5 || '%')
            ORDER BY applied_at ASC LIMIT 1`,
          [acct.platform, acct.accountId, ep.start, ep.end, entityId],
        );

        let before: { conversions: number; costMicros: number } | null = null;
        let after: { conversions: number; costMicros: number } | null = null;
        try {
          const adapter = adapterFor(acct.platform);
          adapter.bindAccount(acct.accountId);
          const b = await adapter.verify(entityType, entityId, outcomeYmd(windows.beforeStart), outcomeYmd(windows.beforeEnd));
          const a = await adapter.verify(entityType, entityId, outcomeYmd(windows.afterStart), outcomeYmd(windows.afterEnd));
          before = { conversions: Number(b.metrics.conversions ?? 0), costMicros: Number(b.metrics.costMicros ?? 0) };
          after = { conversions: Number(a.metrics.conversions ?? 0), costMicros: Number(a.metrics.costMicros ?? 0) };
        } catch (e) {
          // A read that failed is not a window with no figures in it. The
          // reading says it could not be measured; nothing is stored as a
          // nought, and tomorrow's run tries again because nothing was written.
          console.log(`   could not read the window: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        measured += 1;

        const reading = outcomeReading({
          episode: ep, horizonDays: horizon, windows, before, after,
          coveredFrom, otherChangesAfter: otherAfter, wholeAccount,
          ourFindingTitle: ours[0]?.title ?? null, now,
        });

        // NO ADDRESS IS STORED HERE. ads_change_events keeps actor_email
        // because the cadence sentence is made of "one person working steadily
        // against two people working past each other"; this table is a record
        // somebody may quote months later, so it holds counts and no
        // identities at all.
        await c.query(
          `INSERT INTO ads_change_outcomes (
             id, client_id, platform, account_id, episode_key, entity_type, entity_id, horizon_days,
             episode_start, episode_end, change_count, by_hand, by_api, from_outside, resource_types,
             our_finding_id, verdict, conv_before, conv_after, cost_before_micros, cost_after_micros,
             relative_change, noise_band, window_shared, other_changes_after, what, headline, basis, measured_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28, now())
           ON CONFLICT (platform, account_id, episode_key, horizon_days) DO NOTHING`,
          [
            randomUUID(), acct.clientId, acct.platform, acct.accountId, key, entityType, entityId, horizon,
            ep.start, ep.end, ep.events.length, ep.byHand, ep.byApi, ep.fromOutside,
            ep.resourceTypes.join(",") || null, ours[0]?.id ?? null, reading.verdict,
            before.conversions, after.conversions, before.costMicros, after.costMicros,
            reading.relativeChange, reading.mde, reading.shared, reading.otherChangesAfter,
            reading.what, reading.headline, reading.basis,
          ],
        );
        console.log(`   ${horizon}d ${reading.verdict.toUpperCase()} — ${reading.what} ${reading.headline}`);
      }
    }
  }
  return { accounts: accounts.length, episodes, measured, deferred };
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
    if (!rows.length) {
      // Nothing applied through our own queue is the NORMAL state and always
      // has been — see the header. It is no longer the end of the run: pass
      // two below measures what happened after every captured change.
      console.log("No finding after-check is due.");
    } else {
      console.log(`${rows.length} finding(s) with an after-check due. READ-ONLY — nothing is changed in any account.\n`);
    }

    let checked = 0;
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

        // WAS THE WINDOW OURS ALONE? A subcontractor rebuilding the account
        // inside the measured stretch moves exactly the numbers this verdict
        // is read off. The result is NOT dropped and NOT adjusted — it is
        // recorded as shared, with a count and who, so a won or a lost is
        // readable rather than quietly wrong. A null is "we could not see",
        // which is never read as a clean window.
        const shared = await windowSharedWith(
          c, r.platform, accountId, r.entity_type, r.entity_id,
          new Date(`${daysAgo(horizon)}T00:00:00.000Z`), new Date(`${daysAgo(1)}T23:59:59.000Z`),
        );
        // The caveat rides on EVERY verdict, clean window or not: a pre/post
        // comparison with nothing held back observes, it does not prove.
        const fullNote = `${note} ${shared.note} ${OBSERVATIONAL_CAVEAT}`;
        existing.push({
          checkedAt: new Date().toISOString(), horizonDays: horizon,
          before: beforeScaled, after: after.metrics,
          predictedCents: r.est_impact_cents, observedCents, verdict, note: fullNote,
          windowContaminated: shared.contaminated,
          otherChangesInWindow: shared.otherChanges,
          otherChangesByHand: shared.byHand,
          otherChangesFromOutside: shared.fromOutsideTheCompany,
          otherChangeActors: shared.actors,
        });
        console.log(`   ${horizon}d: ${verdict.toUpperCase()} — ${fullNote}`);
        await logEvent(c, r.id, "verified", ACTOR, `${horizon}-day check: ${verdict}. ${fullNote}`, JSON.stringify({ horizon, before: beforeScaled, after: after.metrics, sharedWindow: { contaminated: shared.contaminated, otherChanges: shared.otherChanges } }));
      }

      // The 28-day verdict is the one that settles it; before that a 14-day
      // read is a progress note, not a conclusion.
      const settled = existing.find((o) => o.horizonDays === 28);
      const status = settled ? (settled.verdict === "inconclusive" ? "applied" : settled.verdict) : "verifying";
      await c.query(`UPDATE ads_findings SET outcomes_json = $2, status = $3 WHERE id = $1`, [r.id, JSON.stringify(existing), status]);
      checked++;
    }
    // ── Pass two. Every captured change, not only the ones we made. ──
    const feed = await measureChangeFeed(c, (platform) => (platform === "meta" ? meta : google));
    const prose = feed.measured > 0 || checked > 0
      ? `${checked} of ${rows.length} due finding(s) given an after-check; ${feed.measured} change episode(s) measured across ${feed.accounts} account(s)`
      : feed.episodes > 0
        ? `ran; nothing was due — ${feed.episodes} captured episode(s) are either already measured or not yet old enough`
        : "ran; no change history has been captured yet, so there is nothing to measure";
    emitJobSummary(formatJobSummary({
      due: rows.length, checked,
      accounts: feed.accounts, episodes: feed.episodes, measured: feed.measured, deferred: feed.deferred,
    }, feed.deferred > 0 ? `${prose}; ${feed.deferred} left for tomorrow (one run's cap)` : prose));
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

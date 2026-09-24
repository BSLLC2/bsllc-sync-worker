#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { evaluate, platformSignals, ADS_RULESET_VERSION, type DerivedFinding } from "./ads/rules.js";
import { refineNarrative } from "./ads/narrative.js";
import { GoogleAdsAdapter } from "./ads/google-ads-adapter.js";
import { MetaAdapter, loadMetaConfig } from "./ads/meta-adapter.js";
import {
  upsertFinding, sweepResolved, supersedeFindings, mappedAccounts, protectedPatternsFor, clientEconomicsFor,
  outcomeFeedFactsFor, clientServicesFor, researchFactsFor, phoneDemandFor,
} from "./ads/store.js";
import type { PlatformAdapter } from "./ads/platform.js";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";
import { splitSeeds } from "./ads/service-seed.js";

/**
 * The cadenced deep audit — the job that gives the ads analysis a memory.
 *
 * Read-only against the platforms. It pulls evidence through each adapter, runs
 * the DETERMINISTIC rules over it, and upserts the results into ads_findings,
 * where the lifecycle rules in src/ads/store.ts decide what a re-detection
 * means: refresh an open finding, leave a dismissed one alone unless its
 * evidence genuinely moved, never disturb a change that is in flight.
 *
 * Nothing here writes to an ad account. Findings that carry a change payload
 * sit at 'proposed' until a person presses Approve in the dashboard.
 *
 *   npm run ads-findings                                  (every mapped client)
 *   npm run ads-findings -- --client=ohio-community-health
 *   npm run ads-findings -- --dry-run                     (evaluate, write nothing)
 */

const ACTOR = "ads-findings-run";
/** Findings at or above this monthly impact are worth waking someone for. */
const DIGEST_FLOOR_CENTS = 25_000;      // $250/month
/** …and at or above this, they are filed as a task, not just a notification. */
const URGENT_FLOOR_CENTS = 100_000;     // $1,000/month

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;
/** Mirrors shared/schema.ts clientSlug(): web_inquiries is keyed by it. */
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function ninetyDayWindow(): { start: string; end: string } {
  const d = (offsetDays: number) => new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
  return { start: d(90), end: d(1) };
}

async function auditOne(
  c: pg.Client,
  adapter: PlatformAdapter,
  platform: string,
  clientId: string,
  clientName: string,
  accountId: string,
  dryRun: boolean,
): Promise<{ findings: DerivedFinding[]; created: number; reopened: number; ids: string[] }> {
  const { start, end } = ninetyDayWindow();
  const protectedPatterns = await protectedPatternsFor(c, clientId);
  console.log(`\n${"═".repeat(72)}\n${clientName} · ${platform} [${accountId}]\n${"═".repeat(72)}`);
  if (protectedPatterns.length) console.log(`  protected terms: ${protectedPatterns.join(", ")}`);

  const platformInput = await adapter.read({ accountId, windowStart: start, windowEnd: end, protectedPatterns });
  // Two keyword numbers, because they are two different lists and one of them
  // used to stand in for the other. `keywords` is what SPENT in the window, cut
  // at the top spenders; `existingKeywords` is what the account HOLDS, read
  // whole. A run where the second is missing is a run where the dedupe and the
  // quality-score count are both working from the first, which is why it says
  // so rather than printing one figure.
  const held = platformInput.existingKeywords;
  console.log(`  read: ${platformInput.campaigns.length} campaigns · ${platformInput.searchTerms.length} search terms`
    + ` · ${platformInput.keywords.length} keywords with spend${platformInput.keywordsTruncated ? " (cut — the pull came back full)" : ""}`
    + ` · ${held == null ? "keyword list UNREAD" : `${held.length} keywords held`}`
    + ` · ${platformInput.ads.length} ads · ${platformInput.existingNegatives.size} negatives in place`);

  // What the CLIENT has recorded about what a customer is worth. The adapter
  // does not read it and should not: it is not the ad platform's to know, and
  // keeping it out of the adapter keeps that file one vendor's API. Merged on
  // here so the rules see one input, which is what keeps them pure.
  const economics = await clientEconomicsFor(c, clientId, end);
  // And what the record already holds about those leads becoming customers —
  // also Postgres, also nothing to do with the ad platform.
  //
  // ONLY WHERE THIS SYSTEM CAPTURES THIS PLATFORM'S CLICK IDENTIFIER.
  // `outcomeFeedFactsFor` counts `web_inquiries.gclid`, which is Google's. No
  // column anywhere holds Meta's, so gathering these facts on a Meta account
  // would hand the rules a chain that is empty because it does not exist, and
  // the reading would report "not one lead carries a click id" on every Meta
  // account and send somebody to fix the wrong platform's tagging. Not
  // gathered is the honest input and the reading already handles it.
  const signals = platformSignals(platform);
  const outcomes = signals.clickIdOnLead
    ? await outcomeFeedFactsFor(c, clientId, slugify(clientName), start, end)
    : null;
  // What this client actually SELLS, what demand has already been researched
  // for them, and how their enquiries arrive. All three are Postgres reads and
  // none of them is the ad platform's to know — the same reason `economics`
  // is merged on here rather than pulled inside an adapter.
  //
  // The services list is the gate on the keyword-gap reading: a derived
  // candidate is never returned by `clientServicesFor`, so an unconfirmed list
  // produces no gap rows and the reading says which answer is missing.
  const services = await clientServicesFor(c, clientId);
  const research = await researchFactsFor(c, clientId);
  const phone = await phoneDemandFor(c, slugify(clientName), start, end);
  const input = { ...platformInput, economics, outcomes, services, research, phone };
  console.log(
    `  goal: ${economics.cplCeilingCents != null ? `$${(economics.cplCeilingCents / 100).toFixed(2)} cost-per-lead ceiling (${economics.cplCeilingMonth})` : "no cost-per-lead ceiling recorded"}`
    + ` · ${economics.customerValueCents != null ? `$${(economics.customerValueCents / 100).toFixed(2)} a customer` : "no customer value recorded"}`
    + ` · ${economics.closeRatePct != null ? `${economics.closeRatePct}% close rate` : "no close rate recorded"}`,
  );
  console.log(
    `  outcomes: ${outcomes == null
      ? (signals.clickIdOnLead ? "not gathered" : `not asked — nothing here captures a ${platform} click id on a lead`)
      : `${outcomes.gclidLeadsInWindow}/${outcomes.leadsInWindow} leads carry a click id · ${outcomes.crmRowsInWindow} reached the CRM · ${outcomes.wonInWindow} won over ${outcomes.wonWindowMonths} month(s)`}`,
  );
  console.log(
    `  bidding: ${platformInput.conversionLag == null
      ? "conversion lag not read by this adapter"
      : `${platformInput.conversionLag.length} lag bucket row(s)`}`
    + ` · ${platformInput.dailyConversions == null
      ? "no day-by-day series, so a tracking break cannot be dated"
      : `${platformInput.dailyConversions.length} day(s) of series`}`
    + ` · ${platformInput.searchTermSpendByCampaign == null
      ? "search-term coverage unread"
      : `${Object.keys(platformInput.searchTermSpendByCampaign).length} campaign(s) with search-term spend`}`,
  );
  const t = platformInput.tracking;
  console.log(
    `  tracking: ${t == null
      ? (signals.conversionConfig
          ? "not read by this adapter"
          : "no conversion-action configuration exists on this platform to read")
      : `${t.status ?? "status unread"} · ${t.actions == null ? "conversion actions unread" : `${t.actions.length} conversion action(s)`}`}`,
  );
  if (platformInput.adSets?.length) {
    const limited = platformInput.adSets.filter((a) => /LIMITED/i.test(a.learningStatus ?? "")).length;
    console.log(`  learning: ${platformInput.adSets.length} ad set(s) read · ${limited} the platform says it does not expect to settle`);
  }

  // Deterministic first. The rules decide everything true about the account.
  console.log(
    `  services: ${services.services == null
      ? `none confirmed${services.candidatesWaiting ? ` (${services.candidatesWaiting} candidate(s) waiting to be ticked)` : ""} — no keyword-gap reading`
      : `${services.services.length} confirmed${services.confirmedBy ? ` by ${services.confirmedBy}` : ""}${services.confirmedAt ? ` on ${services.confirmedAt}` : ""}`}`,
  );
  // WHICH OF THOSE MAY SEED RESEARCH, and every one held back named. A
  // recorded service that is too broad to expand from is skipped for SEEDING
  // and for nothing else — it stays on the record and still rules out what it
  // rules out. A seed dropped with nobody told is the failure this prints
  // against.
  if (services.services != null && research?.keywords != null) {
    const split = splitSeeds(services.services, {
      accountTerms: platformInput.searchTerms.filter((t) => t.conversions > 0).map((t) => t.term),
      research: research.keywords.map((k) => ({ keyword: k.keyword, intent: k.intent, volume: k.volume })),
    });
    console.log(`  seeds: ${split.seeds.length} of ${services.services.length} recorded service(s) are worth researching from`);
    for (const sk of split.skipped) console.log(`    · skipped "${sk.service}" — ${sk.mark}: ${sk.basis}`);
  }
  console.log(
    `  research: ${research?.keywords == null
      ? "none stored for this client"
      : `${research.keywords.length} keyword(s) from the run of ${research.ranAt ?? "an unknown date"}`}`
    + ` · enquiries: ${phone == null || phone.totalLeads == null
      ? "lead feed not read"
      : `${phone.phoneLeads}/${phone.totalLeads} by phone`}`,
  );

  const rulesFindings = evaluate(input);
  // Then, and only then, the language seam — which today is identity.
  const { findings, engine } = refineNarrative(rulesFindings);
  console.log(`  rules v${ADS_RULESET_VERSION} produced ${findings.length} finding(s) · narrative engine: ${engine}`);

  const ids: string[] = [];
  let created = 0, reopened = 0;
  for (const f of findings) {
    const impact = f.estImpactCents ? ` (${usd(f.estImpactCents)}/mo)` : "";
    if (dryRun) {
      console.log(`    · [${f.findingType}] ${f.title}${impact}`);
      continue;
    }
    const r = await upsertFinding(c, clientId, platform, accountId, f, ACTOR);
    ids.push(f.entityId);
    if (r.outcome === "created") created++;
    if (r.outcome === "reopened") reopened++;
    console.log(`    · ${r.outcome.padEnd(16)} [${f.findingType}] ${f.title}${impact}`);
    if (engine !== "rules") {
      await c.query(`UPDATE ads_findings SET narrative_engine = $2 WHERE id = $1`, [r.id, engine]);
    }
  }

  // A sharper reading of a fact closes the weaker row it replaced, BY NAME and
  // BEFORE the sweep. The sweep's own sentence is "the condition cleared on its
  // own", which is false here — the condition did not clear, it got a better
  // explanation — and a row somebody is working must never disappear under a
  // reason that is not true. Going first means the sweep finds it already
  // closed and leaves it alone.
  if (!dryRun) {
    const items = findings.flatMap((f) => f.supersedes ?? []);
    if (items.length) {
      const closed = await supersedeFindings(c, clientId, platform, accountId, items, ACTOR);
      if (closed) console.log(`    · ${closed} finding(s) replaced by a sharper reading of the same campaign`);
    }
  }

  // Only sweep when we actually SAW the account. A read that returns nothing —
  // a dormant adapter, an expired token, a permissions change — is
  // indistinguishable from an account with no problems, and sweeping on it
  // would close every open finding the client has. Requiring at least one
  // campaign makes "we looked and it's clean" the only case that sweeps.
  if (!dryRun && input.campaigns.length > 0) {
    const swept = await sweepResolved(c, clientId, platform, accountId, ids, ACTOR);
    if (swept) console.log(`    · ${swept} finding(s) closed — the latest audit no longer finds them`);
  } else if (!dryRun) {
    console.log(`    · read returned no campaigns — not sweeping, since that is indistinguishable from a failed read`);
  }

  return { findings, created, reopened, ids };
}

/**
 * File the genuinely urgent ones as tasks in the same "Data readiness" project
 * the morning audit already uses, keyed so a re-run updates rather than
 * duplicates. Deliberately NOT one task per finding: the review screen is where
 * findings live, and a task is only for the ones big enough that nobody should
 * be able to not notice them.
 */
async function fileUrgentTasks(c: pg.Client, clientId: string, clientName: string): Promise<number> {
  const { rows } = await c.query<{ id: string; title: string; est_impact_cents: number; finding_type: string }>(
    // `impact_unit = 'usd_month'` is not a tidy-up: URGENT_FLOOR_CENTS is a
    // DOLLAR floor and est_impact_cents holds leads x 100 on a leads_month
    // row, so without it a growth finding would be compared against a money
    // threshold and, if it ever cleared one, described as "$N/month" below.
    // Two units in one column need the unit in the WHERE.
    `SELECT id, title, est_impact_cents, finding_type FROM ads_findings
      WHERE client_id = $1 AND status IN ('open','proposed') AND est_impact_cents >= $2
        AND impact_unit = 'usd_month'
      ORDER BY est_impact_cents DESC`,
    [clientId, URGENT_FLOOR_CENTS],
  );
  let filed = 0;
  for (const r of rows) {
    const key = `ads-finding:${r.id}`;
    const { rows: exists } = await c.query(
      `SELECT id FROM commitments WHERE client_id = $1 AND source = 'ads-audit' AND external_id = $2`,
      [clientId, key],
    );
    const title = `Ads: ${r.title}`;
    const description = `Estimated ${usd(r.est_impact_cents)}/month. Review the evidence and the proposed change on ${clientName}'s Ads tab, then Approve or Dismiss with a reason.\n\nThis task closes itself when the finding is actioned.`;
    if (exists.length) {
      await c.query(
        `UPDATE commitments SET title = $3, description = $4, last_updated_at = now()
          WHERE client_id = $1 AND source = 'ads-audit' AND external_id = $2 AND status <> 'complete'`,
        [clientId, key, title, description],
      );
      // The finding has always carried a `task_id` column and this job never
      // wrote it, so the task it filed was only ever derivable by rebuilding
      // the external_id. The dashboard's queue reads `task_id` to say who is
      // holding the work, so a row filed before this stamp reads as never
      // written up. Backfilled here on every run rather than migrated.
      await c.query(`UPDATE ads_findings SET task_id = $2 WHERE id = $1 AND task_id IS DISTINCT FROM $2`,
        [r.id, (exists[0] as { id: string }).id]);
      continue;
    }
    const taskId = randomUUID();
    await c.query(
      `INSERT INTO commitments (id, client_id, priority, title, description, owner_type, owner_name, status, category, workstream, due_date, source, external_id)
       VALUES ($1, $2, 'P1', $3, $4, 'bs_llc', 'BS LLC', 'not_started', 'ongoing', 'Paid Search', to_char(now() + interval '5 days', 'YYYY-MM-DD'), 'ads-audit', $5)`,
      [taskId, clientId, title, description, key],
    );
    await c.query(`UPDATE ads_findings SET task_id = $2 WHERE id = $1`, [r.id, taskId]);
    filed++;
  }

  // Close the task the moment its finding leaves the review queue — the same
  // self-healing the morning audit does, so nobody chases something already done.
  await c.query(
    `UPDATE commitments SET status = 'complete', completed_at = now(), last_updated_at = now(),
            description = coalesce(description,'') || E'\n\nAuto-closed: the finding has been actioned.'
      WHERE client_id = $1 AND source = 'ads-audit' AND status <> 'complete'
        -- Scoped to finding-keyed tasks only. 'ads-audit' also carries the
        -- vendor-brief tasks (external_id 'ads-brief:…'), which close on their
        -- own verification check, not on this one.
        AND external_id LIKE 'ads-finding:%'
        AND external_id NOT IN (
          SELECT 'ads-finding:' || id FROM ads_findings
           WHERE client_id = $1 AND status IN ('open','proposed'))`,
    [clientId],
  );
  return filed;
}

/**
 * Queue a digest through the team-notification path that already exists, rather
 * than inventing a second one. Never emails a client — these go to the internal
 * roster only.
 */
async function queueDigest(c: pg.Client, lines: string[]): Promise<number> {
  if (!lines.length) return 0;
  const { rows: recipients } = await c.query<{ email: string }>(
    `SELECT email FROM users WHERE role IN ('exec','am_lead') AND email IS NOT NULL AND btrim(email) <> ''`,
  );
  if (!recipients.length) return 0;
  const body = lines.join("\n");
  for (const r of recipients) {
    await c.query(
      `INSERT INTO team_notifications (id, user_email, kind, title, body, url, status)
       VALUES ($1, $2, 'digest', $3, $4, '/#/clients', 'pending')`,
      [randomUUID(), r.email, `Ads findings: ${lines.length} above ${usd(DIGEST_FLOOR_CENTS)}/mo`, body],
    );
  }
  return recipients.length;
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyClient = (argv.find((a) => a.startsWith("--client="))?.slice(9) || "").trim();
  const dryRun = argv.includes("--dry-run");
  const cfg = loadConfig();

  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });
  const google = new GoogleAdsAdapter(api, cfg);
  const meta = new MetaAdapter(loadMetaConfig());

  const c = new pg.Client({ connectionString: cfg.databaseUrl });
  await c.connect();
  try {
    console.log(dryRun
      ? "DRY RUN — evidence is pulled and rules evaluated, but nothing is written."
      : "Running the ads findings audit. READ-ONLY against every ad platform; nothing is applied.");
    console.log(`Meta adapter: ${meta.capabilities().credentialed ? "credentialed" : "dormant (no META_ACCESS_TOKEN)"}`);

    const digest: string[] = [];
    let totalCreated = 0, totalReopened = 0;
    // Counted so the heartbeat can say what this run actually looked at. A run
    // that succeeded across ZERO accounts produces the same empty screen as a
    // clean week and means nothing at all — `accounts` and `read` are what let
    // the morning audit tell those apart (src/ads-operability.ts).
    let accounts = 0, accountsRead = 0, totalFindings = 0;

    for (const [platform, adapter, source] of [
      ["google_ads", google as PlatformAdapter, "google_ads"],
      ["meta", meta as PlatformAdapter, "meta"],
    ] as const) {
      const targets = await mappedAccounts(c, source, onlyClient || undefined);
      if (!targets.length) { console.log(`\nNo mapped ${platform} accounts${onlyClient ? ` for ${onlyClient}` : ""}.`); continue; }
      accounts += targets.length;

      for (const t of targets) {
        const accountId = platform === "google_ads" ? digitsOnly(t.accountId) : t.accountId;
        try {
          const r = await auditOne(c, adapter, platform, t.clientId, t.clientName, accountId, dryRun);
          accountsRead++;
          totalCreated += r.created; totalReopened += r.reopened;
          totalFindings += r.findings.length;
          for (const f of r.findings) {
            if (f.estImpactCents >= DIGEST_FLOOR_CENTS) {
              digest.push(`${t.clientName} · ${usd(f.estImpactCents)}/mo · ${f.title}`);
            }
          }
          if (!dryRun) {
            const filed = await fileUrgentTasks(c, t.clientId, t.clientName);
            if (filed) console.log(`    · ${filed} urgent finding(s) filed as P1 tasks`);
          }
        } catch (e) {
          // One account's credentials or API hiccup must not take the whole
          // weekly run down for every other client.
          console.log(`  ⚠ ${t.clientName} [${accountId}] failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    if (!dryRun) {
      const sent = await queueDigest(c, digest);
      console.log(`\n${"─".repeat(72)}`);
      console.log(`${totalCreated} new · ${totalReopened} re-opened on changed evidence · ${digest.length} above ${usd(DIGEST_FLOOR_CENTS)}/mo · digest queued for ${sent} teammate(s)`);
      emitJobSummary(formatJobSummary(
        { accounts, read: accountsRead, findings: totalFindings, new: totalCreated, reopened: totalReopened },
        accounts === 0
          ? "no mapped ad account to read — \"no findings\" says nothing about anyone's spend"
          : `${accountsRead}/${accounts} account(s) read, ${totalFindings} finding(s)${totalFindings === 0 && accountsRead > 0 ? " — looked and found nothing" : ""}`,
      ));
    } else {
      console.log(`\n${"─".repeat(72)}\nDry run complete — nothing written.`);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

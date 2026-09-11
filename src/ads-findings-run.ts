#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { evaluate, ADS_RULESET_VERSION, type DerivedFinding } from "./ads/rules.js";
import { refineNarrative } from "./ads/narrative.js";
import { GoogleAdsAdapter } from "./ads/google-ads-adapter.js";
import { MetaAdapter, loadMetaConfig } from "./ads/meta-adapter.js";
import { upsertFinding, sweepResolved, mappedAccounts, protectedPatternsFor, logEvent } from "./ads/store.js";
import type { PlatformAdapter } from "./ads/platform.js";

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

  const input = await adapter.read({ accountId, windowStart: start, windowEnd: end, protectedPatterns });
  console.log(`  read: ${input.campaigns.length} campaigns · ${input.searchTerms.length} search terms · ${input.keywords.length} keywords · ${input.ads.length} ads · ${input.existingNegatives.size} negatives in place`);

  // Deterministic first. The rules decide everything true about the account.
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

  if (!dryRun) {
    const swept = await sweepResolved(c, clientId, platform, accountId, ids, ACTOR);
    if (swept) console.log(`    · ${swept} finding(s) closed — the condition cleared on its own`);
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
    `SELECT id, title, est_impact_cents, finding_type FROM ads_findings
      WHERE client_id = $1 AND status IN ('open','proposed') AND est_impact_cents >= $2
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
      continue;
    }
    await c.query(
      `INSERT INTO commitments (id, client_id, priority, title, description, owner_type, owner_name, status, category, workstream, due_date, source, external_id)
       VALUES ($1, $2, 'P1', $3, $4, 'bs_llc', 'BS LLC', 'not_started', 'ongoing', 'Paid Search', to_char(now() + interval '5 days', 'YYYY-MM-DD'), 'ads-audit', $5)`,
      [randomUUID(), clientId, title, description, key],
    );
    filed++;
  }

  // Close the task the moment its finding leaves the review queue — the same
  // self-healing the morning audit does, so nobody chases something already done.
  await c.query(
    `UPDATE commitments SET status = 'complete', completed_at = now(), last_updated_at = now(),
            description = coalesce(description,'') || E'\n\nAuto-closed: the finding has been actioned.'
      WHERE client_id = $1 AND source = 'ads-audit' AND status <> 'complete'
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

    for (const [platform, adapter, source] of [
      ["google_ads", google as PlatformAdapter, "google_ads"],
      ["meta", meta as PlatformAdapter, "meta"],
    ] as const) {
      const targets = await mappedAccounts(c, source, onlyClient || undefined);
      if (!targets.length) { console.log(`\nNo mapped ${platform} accounts${onlyClient ? ` for ${onlyClient}` : ""}.`); continue; }

      for (const t of targets) {
        const accountId = platform === "google_ads" ? digitsOnly(t.accountId) : t.accountId;
        try {
          const r = await auditOne(c, adapter, platform, t.clientId, t.clientName, accountId, dryRun);
          totalCreated += r.created; totalReopened += r.reopened;
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
    } else {
      console.log(`\n${"─".repeat(72)}\nDry run complete — nothing written.`);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

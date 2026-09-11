#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { logEvent } from "./ads/store.js";

/**
 * Vendor briefs — what the API cannot do, written so someone else can do it.
 *
 * Some of the highest-value work in an ad account is not API-applicable at all
 * (ad copy, landing pages, bid strategy judgement), and some of it we have put
 * out of scope on purpose: OCH runs under LegitScript certification and editing
 * an ad resubmits it for policy review, so we do not touch ad text unattended
 * however possible the API says it is.
 *
 * That work still has to happen. This job rolls those findings into a brief at
 * a cadence and, critically, files it as a TASK with an owner and a due date —
 * so it is chased like any other work rather than living in an email nobody
 * reopens. The brief CLOSES ON A VERIFICATION CHECK: the next audit re-reads
 * the account and the brief closes when the condition it describes is gone.
 * Nobody closes it by saying they did it.
 *
 * Read-only against the platforms — it only reads findings already in Postgres.
 *
 *   npm run ads-vendor-briefs
 *   npm run ads-vendor-briefs -- --client=ohio-community-health
 *   npm run ads-vendor-briefs -- --dry-run     (print, write nothing)
 */

const ACTOR = "ads-vendor-briefs";
/** How long a brief covers, and how long before the same client gets another. */
const CADENCE_DAYS = 28;
/** Who chases it by default until someone reassigns it in the OS. */
const DEFAULT_OWNER = "BS LLC";

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Stable, human-quotable id the vendor puts on their reply. */
function trackingId(clientSlug: string, platform: string, periodStart: string): string {
  const p = platform === "google_ads" ? "GA" : platform === "meta" ? "MT" : "MS";
  return `ADS-${p}-${clientSlug.slice(0, 12).toUpperCase()}-${periodStart.replace(/-/g, "")}`;
}

interface Row {
  id: string; platform: string; account_id: string; finding_type: string;
  entity_type: string; entity_name: string | null; title: string; summary: string | null;
  evidence_json: string | null; est_impact_cents: number | null; impact_assumption: string | null;
  risk_level: string; guard_note: string | null; window_start: string | null; window_end: string | null;
}

/**
 * The brief body. Every item answers the same six questions in the same order,
 * because a vendor reading the fourth one of these should not have to work out
 * the format again: WHAT to change, WHERE exactly, CURRENT value, TARGET value,
 * WHY, and the EVIDENCE — then the risk.
 */
function renderBrief(clientName: string, platform: string, tid: string, periodStart: string, periodEnd: string, rows: Row[]): string {
  const total = rows.reduce((s, r) => s + (r.est_impact_cents ?? 0), 0);
  const platformLabel = platform === "google_ads" ? "Google Ads" : platform === "meta" ? "Meta" : "Microsoft Advertising";

  const lines: string[] = [
    `# ${clientName} — ${platformLabel} change brief`,
    ``,
    `**Tracking id:** ${tid}`,
    `**Period:** ${periodStart} → ${periodEnd}`,
    `**Items:** ${rows.length}${total > 0 ? ` · estimated ${usd(total)}/month at stake` : ""}`,
    ``,
    `These are changes our API path deliberately does not make — either the platform cannot make them,`,
    `or we have put them out of scope on purpose. Each one below is a specific instruction, not a suggestion.`,
    `Quote the tracking id when you reply. We verify each item by re-reading the account, so there is nothing`,
    `to mark as done: the item closes itself once the change is live.`,
    ``,
    `---`,
    ``,
  ];

  rows.forEach((r, i) => {
    const ev = r.evidence_json ? JSON.parse(r.evidence_json) : null;
    lines.push(`## ${i + 1}. ${r.title}`);
    lines.push(``);
    lines.push(`- **What to change:** ${r.summary ?? r.title}`);
    lines.push(`- **Where exactly:** ${platformLabel} account ${r.account_id} · ${r.entity_type}${r.entity_name ? ` "${r.entity_name}"` : ""}`);
    lines.push(`- **Current value:** ${ev?.lines?.[0] ?? "see evidence below"}`);
    lines.push(`- **Target:** ${targetFor(r)}`);
    lines.push(`- **Why:** ${r.impact_assumption ?? "See the evidence."}${r.est_impact_cents ? ` Estimated ${usd(r.est_impact_cents)}/month.` : ""}`);
    lines.push(`- **Risk:** ${riskCopy(r)}`);
    if (ev?.lines?.length) {
      lines.push(`- **Evidence** (${ev.windowStart} → ${ev.windowEnd}):`);
      for (const l of ev.lines.slice(0, 10)) lines.push(`    - ${l}`);
    }
    lines.push(`- **Item id:** ${tid}-${String(i + 1).padStart(2, "0")}`);
    lines.push(``);
  });

  lines.push(`---`);
  lines.push(``);
  lines.push(`### How this gets closed`);
  lines.push(`Our weekly audit re-reads the account. Each item closes when its condition is gone from the data —`);
  lines.push(`not when anyone reports it done. If an item is wrong or cannot be actioned, reply with the item id and why,`);
  lines.push(`and we will dismiss it with that reason on the record so it is not raised at you again.`);
  return lines.join("\n");
}

/** The concrete target value, per finding type. Vague instructions come back wrong. */
function targetFor(r: Row): string {
  switch (r.finding_type) {
    case "rank_limited":
      return "Impression share lost to Ad Rank below 40%. Work the bid, the ad relevance and the landing page — adding budget will not move this.";
    case "no_conversions":
      return "Conversion tracking confirmed firing end to end, OR the campaign paused. Confirm tracking BEFORE pausing.";
    case "low_quality_score":
      return "Every listed keyword at quality score 5 or above, via ad copy and landing pages that match the search.";
    case "thin_ad_group":
      return "At least 2 enabled ads in every listed ad group.";
    case "weak_ad_strength":
      return "Ad strength Good or better on every listed ad. On a certified account this means a NEW ad plus pausing the old one, never an edit.";
    case "dead_keyword":
      return "Either paused, bid reduced, or pointed at a page that answers the search. Check the landing page before pausing.";
    case "budget_limited":
      return "Relevance fixed first — targeting, landing page or tracking — before any budget increase.";
    default:
      return "See 'What to change'.";
  }
}

function riskCopy(r: Row): string {
  const base = r.risk_level === "high"
    ? "High — read the evidence before acting."
    : r.risk_level === "medium"
      ? "Medium — reversible, but it changes what the account serves."
      : "Low — reversible.";
  return r.guard_note ? `${base} ${r.guard_note}` : base;
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyClient = (argv.find((a) => a.startsWith("--client="))?.slice(9) || "").trim();
  const dryRun = argv.includes("--dry-run");
  const cfg = loadConfig();

  const c = new pg.Client({ connectionString: cfg.databaseUrl });
  await c.connect();
  try {
    const periodEnd = ymd(new Date());
    const periodStart = ymd(new Date(Date.now() - CADENCE_DAYS * 86_400_000));

    const { rows: clients } = await c.query<{ id: string; name: string }>(
      `SELECT DISTINCT c.id, c.name
         FROM clients c JOIN ads_findings f ON f.client_id = c.id
        WHERE f.status IN ('open','proposed') AND f.applicability = 'vendor'
        ORDER BY c.name`,
    );
    const targets = clients.filter((cl) => !onlyClient || slugify(cl.name).startsWith(slugify(onlyClient)));
    if (!targets.length) { console.log("No clients have open vendor-applicable findings."); return; }

    for (const cl of targets) {
      const { rows } = await c.query<Row>(
        `SELECT id, platform, account_id, finding_type, entity_type, entity_name, title, summary,
                evidence_json, est_impact_cents, impact_assumption, risk_level, guard_note,
                window_start, window_end
           FROM ads_findings
          WHERE client_id = $1 AND status IN ('open','proposed') AND applicability = 'vendor'
            AND brief_id IS NULL
          ORDER BY est_impact_cents DESC NULLS LAST, severity`,
        [cl.id],
      );
      if (!rows.length) { console.log(`· ${cl.name}: nothing new to brief.`); continue; }

      // One brief per client per platform — a vendor works one account at a time.
      const byPlatform = new Map<string, Row[]>();
      for (const r of rows) byPlatform.set(r.platform, [...(byPlatform.get(r.platform) ?? []), r]);

      for (const [platform, items] of byPlatform) {
        const firstItem = items[0];
        if (!firstItem) continue;
        const tid = trackingId(slugify(cl.name), platform, periodStart);
        const body = renderBrief(cl.name, platform, tid, periodStart, periodEnd, items);
        const title = `${cl.name} — ${platform === "google_ads" ? "Google Ads" : platform === "meta" ? "Meta" : "Microsoft"} change brief (${items.length} items)`;

        if (dryRun) {
          console.log(`\n${"═".repeat(72)}\n${title}\n${"═".repeat(72)}\n${body}\n`);
          continue;
        }

        // A brief already exists for this period — fold the new items into it
        // rather than sending the vendor a second overlapping document.
        const { rows: existing } = await c.query<{ id: string; finding_ids_json: string | null }>(
          `SELECT id, finding_ids_json FROM ads_briefs WHERE tracking_id = $1`, [tid],
        );
        const briefId = existing[0]?.id ?? randomUUID();
        const ids = items.map((i) => i.id);
        const allIds = existing[0]
          ? Array.from(new Set([...(JSON.parse(existing[0].finding_ids_json ?? "[]") as string[]), ...ids]))
          : ids;

        if (existing[0]) {
          await c.query(
            `UPDATE ads_briefs SET title = $2, body_markdown = $3, finding_ids_json = $4, period_end = $5 WHERE id = $1`,
            [briefId, title, body, JSON.stringify(allIds), periodEnd],
          );
        } else {
          await c.query(
            `INSERT INTO ads_briefs (id, client_id, platform, account_id, tracking_id, status,
                                     period_start, period_end, title, body_markdown, finding_ids_json,
                                     owner_name, due_date)
             VALUES ($1,$2,$3,$4,$5,'sent',$6,$7,$8,$9,$10,$11, to_char(now() + interval '10 days','YYYY-MM-DD'))`,
            [briefId, cl.id, platform, firstItem.account_id, tid, periodStart, periodEnd, title, body, JSON.stringify(allIds), DEFAULT_OWNER],
          );
        }

        // File it as a task so it is chased like any other work. Keyed on the
        // tracking id, so re-running updates instead of duplicating.
        const key = `ads-brief:${tid}`;
        const { rows: task } = await c.query<{ id: string }>(
          `SELECT id FROM commitments WHERE client_id = $1 AND source = 'ads-audit' AND external_id = $2`,
          [cl.id, key],
        );
        const taskDesc = `${items.length} changes our API path deliberately does not make. Brief ${tid} is on the client's Ads tab — open it, copy the block, and send it to whoever executes.\n\nCloses on a verification check: the next audit re-reads the account and clears each item when its condition is gone. Nobody closes it by saying it is done.`;
        let taskId = task[0]?.id ?? null;
        if (taskId) {
          await c.query(
            `UPDATE commitments SET title = $2, description = $3, last_updated_at = now()
              WHERE id = $1 AND status <> 'complete'`,
            [taskId, title, taskDesc],
          );
        } else {
          taskId = randomUUID();
          await c.query(
            `INSERT INTO commitments (id, client_id, priority, title, description, owner_type, owner_name, status, category, workstream, due_date, source, external_id)
             VALUES ($1,$2,'P2',$3,$4,'bs_llc',$5,'not_started','ongoing','Paid Search', to_char(now() + interval '10 days','YYYY-MM-DD'),'ads-audit',$6)`,
            [taskId, cl.id, title, taskDesc, DEFAULT_OWNER, key],
          );
        }

        await c.query(`UPDATE ads_briefs SET task_id = $2 WHERE id = $1`, [briefId, taskId]);
        await c.query(`UPDATE ads_findings SET brief_id = $2 WHERE id = ANY($1::text[])`, [ids, briefId]);
        for (const id of ids) await logEvent(c, id, "briefed", ACTOR, `Included in vendor brief ${tid}.`, null);

        console.log(`✅ ${cl.name} · ${platform}: brief ${tid} with ${items.length} item(s), filed as a task due in 10 days.`);
      }
    }

    if (!dryRun) {
      // Close briefs whose findings have all left the queue — the verification
      // check, done by data rather than by assertion.
      const { rows: closed } = await c.query<{ tracking_id: string }>(
        `UPDATE ads_briefs b SET status = 'closed', verified_at = now(),
                verified_note = 'Every item''s condition is gone from the account.'
          WHERE b.status IN ('sent','verifying')
            AND NOT EXISTS (
              SELECT 1 FROM ads_findings f
               WHERE f.brief_id = b.id AND f.status IN ('open','proposed'))
          RETURNING b.tracking_id`,
      );
      for (const r of closed) console.log(`✅ brief ${r.tracking_id} verified closed — its conditions are gone from the account.`);

      await c.query(
        `UPDATE commitments SET status = 'complete', completed_at = now(), last_updated_at = now(),
                description = coalesce(description,'') || E'\n\nAuto-closed: a verification check confirmed every item is live.'
          WHERE source = 'ads-audit' AND status <> 'complete'
            AND external_id IN (SELECT 'ads-brief:' || tracking_id FROM ads_briefs WHERE status = 'closed')`,
      );
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

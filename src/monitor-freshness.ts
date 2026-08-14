#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Watches data freshness and Slack-alerts when a pipeline stops flowing. Reads
 * per-source last sync from metric_snapshots and per-job heartbeats, classifies
 * each against its SLA, and posts to Slack ONLY when the set of stale/failing
 * pipelines CHANGES (edge-triggered — a heads-up, not a per-run spam). Posts a
 * recovery note when everything returns to fresh.
 *
 *   npm run monitor-freshness            (alerts)
 *   npm run monitor-freshness -- --dry-run
 */
const DASH = (process.env.DASHBOARD_URL || "https://bsllc-account-health.vercel.app").replace(/\/+$/, "");

// Expected freshness per pipeline (hours) — mirrors the dashboard cockpit.
const SLA: Record<string, number> = {
  google_ads: 36, ga4: 36, gsc: 36, hubspot: 36, d365: 36, semrush: 192,
  email_import: 3, db_backup: 36, mrr_snapshot: 840, review_email: 2, comment_notify: 2, d365_import: 36, incremental_ads: 36,
};
const LABEL: Record<string, string> = {
  google_ads: "Google Ads", ga4: "GA4", gsc: "Search Console", hubspot: "HubSpot", d365: "Dynamics 365", semrush: "Semrush",
  email_import: "Email import", db_backup: "DB backup", mrr_snapshot: "MRR snapshot", review_email: "Review emails", comment_notify: "Comment alerts", d365_import: "D365 import", incremental_ads: "Ads sync",
};
const label = (s: string) => LABEL[s] ?? s;

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
  const c = new pg.Client({ connectionString: (process.env.DATABASE_URL || "").trim() });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS job_heartbeats (job TEXT PRIMARY KEY, ran_at TIMESTAMPTZ NOT NULL DEFAULT now(), ok BOOLEAN NOT NULL DEFAULT true, note TEXT)`);

    const metric = await c.query<{ source: string; last_sync: Date | null; recent_errors: string }>(
      `SELECT source, MAX(synced_at) AS last_sync,
              COUNT(*) FILTER (WHERE data_state='error' AND synced_at > now() - interval '2 days') AS recent_errors
         FROM metric_snapshots WHERE source <> 'manual' GROUP BY source`,
    );
    const beats = await c.query<{ job: string; ran_at: Date; ok: boolean }>(`SELECT job, ran_at, ok FROM job_heartbeats WHERE job <> 'freshness_monitor'`);

    const now = Date.now();
    const failing: string[] = [], stale: string[] = [];
    for (const r of metric.rows) {
      if (Number(r.recent_errors) > 0) { failing.push(r.source); continue; }
      if (r.last_sync && (now - r.last_sync.getTime()) / 3_600_000 > (SLA[r.source] ?? 36)) stale.push(r.source);
    }
    for (const b of beats.rows) {
      if (!b.ok) { failing.push(b.job); continue; }
      if (b.ran_at && (now - b.ran_at.getTime()) / 3_600_000 > (SLA[b.job] ?? 36)) stale.push(b.job);
    }

    const signature = [...failing.map((s) => `F:${s}`), ...stale.map((s) => `S:${s}`)].sort().join(",");
    const prev = (await c.query<{ note: string | null }>(`SELECT note FROM job_heartbeats WHERE job = 'freshness_monitor'`)).rows[0]?.note ?? "";
    console.log(`Freshness: ${failing.length} failing, ${stale.length} stale. signature="${signature}" prev="${prev}"`);

    if (signature === prev) { console.log("No change — no alert."); return; }

    let text: string | null = null;
    if (failing.length || stale.length) {
      const parts: string[] = [];
      if (failing.length) parts.push(`:red_circle: *Failing:* ${failing.map(label).join(", ")}`);
      if (stale.length) parts.push(`:large_yellow_circle: *Stale:* ${stale.map(label).join(", ")}`);
      text = `:satellite: *Data health changed*\n${parts.join("\n")}\n<${DASH}/#/admin/data-health|Open Data health →>`;
    } else if (prev) {
      text = `:white_check_mark: *Data pipelines recovered* — everything is flowing again.`;
    }

    if (text && !dryRun && webhook) {
      const res = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      console.log(res.ok ? "Alert posted to Slack." : `Slack post failed (${res.status}).`);
    } else if (text) {
      console.log(dryRun ? `[dry-run] would post:\n${text}` : "SLACK_WEBHOOK_URL not set — skipping post.");
    }

    // Record the new signature so we only alert on the next change.
    await c.query(
      `INSERT INTO job_heartbeats (job, ran_at, ok, note) VALUES ('freshness_monitor', now(), $1, $2)
       ON CONFLICT (job) DO UPDATE SET ran_at = now(), ok = EXCLUDED.ok, note = EXCLUDED.note`,
      [failing.length === 0, signature],
    );
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

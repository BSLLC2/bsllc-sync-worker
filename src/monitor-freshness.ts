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
  google_ads: 36, ga4: 36, gsc: 36, hubspot: 36, d365: 36, semrush: 192, seo: 192, aeo: 192,
  email_import: 3, db_backup: 36, mrr_snapshot: 840, review_email: 2, comment_notify: 2, d365_import: 36, incremental_ads: 36, seo_import: 192, aeo_import: 192, webops_import: 36,
};
const LABEL: Record<string, string> = {
  google_ads: "Google Ads", ga4: "GA4", gsc: "Search Console", hubspot: "HubSpot", d365: "Dynamics 365", semrush: "Semrush", seo: "SEO ranks", aeo: "AI visibility",
  email_import: "Email import", db_backup: "DB backup", mrr_snapshot: "MRR snapshot", review_email: "Review emails", comment_notify: "Comment alerts", d365_import: "D365 import", incremental_ads: "Ads sync", seo_import: "SEO import", aeo_import: "AEO import", webops_import: "WebOps import",
};
const label = (s: string) => LABEL[s] ?? s;

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
  const c = new pg.Client({ connectionString: (process.env.DATABASE_URL || "").trim() });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS job_heartbeats (job TEXT PRIMARY KEY, ran_at TIMESTAMPTZ NOT NULL DEFAULT now(), ok BOOLEAN NOT NULL DEFAULT true, note TEXT)`);

    // Judge each source by the LATEST reading per (client, metric) so a source
    // that errored earlier but has since synced clean isn't flagged. Two distinct
    // problems, kept separate so the alert is honest:
    //   • DOWN   — the pipeline isn't flowing: nothing fresher than its SLA, or
    //              its last job run failed. This is "an integration is broken".
    //   • ERRORS — the pipeline IS flowing (fresh) but some client accounts have
    //              an erroring latest reading, e.g. Google Ads fine for 6/8 but
    //              2 accounts can't be pulled. Real, but not a dead integration.
    const metric = await c.query<{ source: string; last_sync: Date | null; recent_errors: string; recent_total: string }>(
      `WITH latest AS (
         SELECT DISTINCT ON (client_id, metric_key) source, data_state, synced_at
           FROM metric_snapshots WHERE source <> 'manual'
          ORDER BY client_id, metric_key, synced_at DESC
       )
       SELECT source, MAX(synced_at) AS last_sync,
              -- Only recent errors count. A weeks-old error is a retired metric
              -- key no importer refreshes any more (e.g. ads.*_cents), not a live
              -- failure — otherwise it inflates the error rate forever.
              COUNT(*) FILTER (WHERE data_state='error' AND synced_at > now() - interval '8 days') AS recent_errors,
              COUNT(*) FILTER (WHERE synced_at > now() - interval '8 days') AS recent_total
         FROM latest GROUP BY source`,
    );
    // Which specific client/metric readings are erroring — printed for diagnosis.
    const errDetail = await c.query<{ source: string; client_id: string | null; metric_key: string; error_message: string | null }>(
      `SELECT source, client_id, metric_key, error_message FROM (
         SELECT DISTINCT ON (client_id, metric_key) source, client_id, metric_key, data_state, error_message, synced_at
           FROM metric_snapshots WHERE source <> 'manual'
          ORDER BY client_id, metric_key, synced_at DESC
       ) t WHERE data_state='error' AND synced_at > now() - interval '8 days' ORDER BY source, client_id`,
    );
    const beats = await c.query<{ job: string; ran_at: Date; ok: boolean }>(`SELECT job, ran_at, ok FROM job_heartbeats WHERE job <> 'freshness_monitor'`);

    // Subcontractor insurance (COI) expiring within 30 days or already lapsed —
    // so a sub never works uninsured. Table may not exist yet on older DBs.
    let coiRows: { name: string; expires_at: string; days: number }[] = [];
    try {
      coiRows = (await c.query<{ name: string; expires_at: string; days: number }>(
        `SELECT s.name, d.expires_at, (d.expires_at::date - now()::date) AS days
           FROM subcontractor_docs d JOIN subcontractors s ON s.id = d.subcontractor_id
          WHERE d.kind='coi' AND d.expires_at IS NOT NULL AND d.expires_at <> ''
            AND d.expires_at::date <= (now() + interval '30 days')::date
          ORDER BY d.expires_at`,
      )).rows;
    } catch { /* table not present yet */ }

    const now = Date.now();
    const down: string[] = [];
    const erroring: { src: string; n: number; m: number }[] = [];
    for (const r of metric.rows) {
      const ageH = r.last_sync ? (now - r.last_sync.getTime()) / 3_600_000 : Infinity;
      if (ageH > (SLA[r.source] ?? 36)) { down.push(r.source); continue; } // dark → down, regardless of errors
      const n = Number(r.recent_errors);
      if (n > 0) erroring.push({ src: r.source, n, m: Number(r.recent_total) });
    }
    for (const b of beats.rows) {
      const ageH = b.ran_at ? (now - b.ran_at.getTime()) / 3_600_000 : Infinity;
      if (!b.ok || ageH > (SLA[b.job] ?? 36)) down.push(b.job);
    }

    if (errDetail.rows.length) {
      console.log("Erroring client readings (latest per client/metric):");
      for (const e of errDetail.rows) console.log(`  ${e.source} · ${e.client_id ?? "—"} · ${e.metric_key}: ${(e.error_message ?? "").slice(0, 120)}`);
    }

    const coiAlerts = coiRows.map((r) => ({ name: r.name, days: Number(r.days) }));
    if (coiAlerts.length) {
      console.log("COI expiring/expired:");
      for (const r of coiAlerts) console.log(`  ${r.name}: ${r.days < 0 ? `EXPIRED ${-r.days}d ago` : `${r.days}d left`}`);
    }

    const signature = [
      ...down.map((s) => `D:${s}`),
      ...erroring.map((e) => `E:${e.src}`),
      ...coiAlerts.map((r) => `C:${r.name}:${r.days < 0 ? "exp" : r.days <= 7 ? "7" : "30"}`),
    ].sort().join(",");
    const prev = (await c.query<{ note: string | null }>(`SELECT note FROM job_heartbeats WHERE job = 'freshness_monitor'`)).rows[0]?.note ?? "";
    console.log(`Freshness: ${down.length} down, ${erroring.length} with errors. signature="${signature}" prev="${prev}"`);

    if (signature === prev) { console.log("No change — no alert."); return; }

    const coiLine = coiAlerts.length
      ? `:shield: *Insurance expiring:* ${coiAlerts.map((r) => `${r.name} (${r.days < 0 ? `expired ${-r.days}d ago` : `${r.days}d`})`).join(", ")}`
      : "";

    let text: string | null = null;
    if (down.length || erroring.length || coiAlerts.length) {
      const parts: string[] = [];
      if (down.length) parts.push(`:red_circle: *Not flowing:* ${down.map(label).join(", ")}`);
      if (erroring.length) parts.push(`:large_orange_circle: *Account errors:* ${erroring.map((e) => `${label(e.src)} (${e.n}/${e.m})`).join(", ")}`);
      if (coiLine) parts.push(coiLine);
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
      [down.length === 0, signature],
    );
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

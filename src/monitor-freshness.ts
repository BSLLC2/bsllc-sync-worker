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
// Keys here must match the literal --job= value each workflow's Heartbeat
// step passes (see `grep -rh "heartbeat -- --job=" .github/workflows`) — a
// mismatch doesn't error, it just silently falls back to the generic 36h
// default below, which is how several jobs (hubspot_deals, qbo_financials,
// research, send_sms, etc.) have been drifting unmapped; only the keys added
// alongside this fix are guaranteed current.
const SLA: Record<string, number> = {
  google_ads: 36, ga4: 36, gsc: 36, hubspot: 36, d365: 36, seo: 192, aeo: 192,
  email_import: 3, db_backup: 36, mrr_snapshot: 840, review_email: 2, comment_notify: 2, d365_import: 36, incremental_ads: 36, seo_import: 192, aeo_import: 192, webops_import: 36,
  import_d365: 36, import_ga4: 36, import_gsc: 36, import_hubspot: 36, import_och: 36,
  incremental_sync: 36, snapshot_plans: 2, offline_conversions: 36, publish_och_web_leads: 36,
};
const LABEL: Record<string, string> = {
  google_ads: "Google Ads", ga4: "GA4", gsc: "Search Console", hubspot: "HubSpot", d365: "Dynamics 365", seo: "SEO ranks", aeo: "AI visibility",
  email_import: "Email import", db_backup: "DB backup", mrr_snapshot: "MRR snapshot", review_email: "Review emails", comment_notify: "Comment alerts", d365_import: "D365 import", incremental_ads: "Ads sync", seo_import: "SEO import", aeo_import: "AEO import", webops_import: "WebOps import",
  import_d365: "D365 import", import_ga4: "GA4 import", import_gsc: "Search Console import", import_hubspot: "HubSpot import", import_och: "OCH admissions import",
  incremental_sync: "Google Ads sync", snapshot_plans: "Plan snapshots", offline_conversions: "Offline conversions (close-the-loop)",
  publish_och_web_leads: "OCH web-leads tab",
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

    // Website leads per client. Every importer above reports "ok" on an empty
    // input, so a client's form losing its webhook action (or a rotated
    // WEBFORM_SECRET) never showed up anywhere — OCH ran that way for weeks.
    // A client that has had leads in the last 90 days and none inside its
    // SLA is "not flowing"; the same for ad-click leads that stop turning
    // into offline-conversion uploads. Internal test submissions excluded.
    const LEAD_SLA_H: Record<string, number> = { "ohio-community-health-och": 7 * 24 };
    const LEAD_DEFAULT_SLA_H = 14 * 24;
    const UPLOAD_SLA_H = 45 * 24;
    let leadRows: { client_slug: string; last_lead: Date; n90: string; gclid30: string }[] = [];
    try {
      leadRows = (await c.query<{ client_slug: string; last_lead: Date; n90: string; gclid30: string }>(
        `SELECT client_slug, MAX(submitted_at) AS last_lead,
                COUNT(*) FILTER (WHERE submitted_at > now() - interval '90 days') AS n90,
                COUNT(*) FILTER (WHERE gclid IS NOT NULL AND gclid <> '' AND submitted_at > now() - interval '30 days') AS gclid30
           FROM web_inquiries
          WHERE email IS NULL OR (email NOT ILIKE '%@bsllc.biz' AND email NOT IN ('sebastienhue@gmail.com', 'test-inquiry@bsllc.biz'))
          GROUP BY client_slug`,
      )).rows;
    } catch { /* table not present yet */ }
    const lastUpload = new Map<string, Date>();
    try {
      const col = (await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'offline_conversion_uploads' AND column_name IN ('uploaded_at', 'created_at') ORDER BY column_name DESC LIMIT 1`,
      )).rows[0]?.column_name;
      if (col) {
        for (const r of (await c.query<{ client_slug: string; last: Date }>(`SELECT client_slug, MAX(${col}) AS last FROM offline_conversion_uploads GROUP BY client_slug`)).rows) lastUpload.set(r.client_slug, r.last);
      }
    } catch { /* table not present yet */ }
    const clientNames = new Map<string, string>();
    try {
      const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      for (const r of (await c.query<{ name: string }>(`SELECT name FROM clients`)).rows) clientNames.set(slugify(r.name), r.name);
    } catch { /* ignore */ }
    const clientLabel = (slug: string) => clientNames.get(slug) ?? slug;

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
    // Tolerance for ordinary clock skew between the runner and Postgres before a
    // future timestamp counts as bad data rather than rounding.
    const FUTURE_SKEW_H = 2;
    const down: string[] = [];
    const erroring: { src: string; n: number; m: number }[] = [];
    for (const r of metric.rows) {
      const ageH = r.last_sync ? (now - r.last_sync.getTime()) / 3_600_000 : Infinity;
      // A future-dated synced_at makes ageH negative, which is never > SLA — so a
      // single bad row would mark the source permanently healthy and silence every
      // staleness alert for it (the query takes MAX(synced_at), so one row is all
      // it takes). Treat it as down: the data cannot be trusted either way.
      if (ageH < -FUTURE_SKEW_H) { down.push(r.source); continue; }
      if (ageH > (SLA[r.source] ?? 36)) { down.push(r.source); continue; } // dark → down, regardless of errors
      const n = Number(r.recent_errors);
      if (n > 0) erroring.push({ src: r.source, n, m: Number(r.recent_total) });
    }
    for (const b of beats.rows) {
      const ageH = b.ran_at ? (now - b.ran_at.getTime()) / 3_600_000 : Infinity;
      if (!b.ok || ageH < -FUTURE_SKEW_H || ageH > (SLA[b.job] ?? 36)) down.push(b.job);
    }
    const noLeads: { slug: string; ageH: number }[] = [];
    const noUploads: { slug: string; gclid30: number; lastUpload: Date | null }[] = [];
    for (const r of leadRows) {
      if (Number(r.n90) === 0) continue; // never had leads recently — nothing to expect
      const ageH = (now - new Date(r.last_lead).getTime()) / 3_600_000;
      if (ageH < -FUTURE_SKEW_H || ageH > (LEAD_SLA_H[r.client_slug] ?? LEAD_DEFAULT_SLA_H)) noLeads.push({ slug: r.client_slug, ageH });
      const gclid30 = Number(r.gclid30);
      if (gclid30 > 0) {
        const lu = lastUpload.get(r.client_slug) ?? null;
        const upAgeH = lu ? (now - new Date(lu).getTime()) / 3_600_000 : Infinity;
        if (upAgeH > UPLOAD_SLA_H) noUploads.push({ slug: r.client_slug, gclid30, lastUpload: lu });
      }
    }
    if (noLeads.length) console.log(`No new website leads: ${noLeads.map((l) => `${clientLabel(l.slug)} (${Math.round(l.ageH / 24)}d)`).join(", ")}`);
    if (noUploads.length) console.log(`Ad-click leads without offline-conversion uploads: ${noUploads.map((u) => `${clientLabel(u.slug)} (${u.gclid30} gclid leads/30d, last upload ${u.lastUpload ? `${Math.round((now - new Date(u.lastUpload).getTime()) / 86_400_000)}d ago` : "never"})`).join(", ")}`);

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
      ...noLeads.map((l) => `L:${l.slug}`),
      ...noUploads.map((u) => `U:${u.slug}`),
    ].sort().join(",");
    const prevRow = (await c.query<{ note: string | null; ran_at: Date }>(`SELECT note, ran_at FROM job_heartbeats WHERE job = 'freshness_monitor'`)).rows[0];
    const prev = prevRow?.note ?? "";
    console.log(`Freshness: ${down.length} down, ${erroring.length} with errors. signature="${signature}" prev="${prev}"`);

    // Edge-triggered avoids per-run spam, but a genuinely unresolved outage
    // (the exact db_backup case: alerted once, then six silent days while it
    // stayed broken) needs a periodic nudge, not permanent silence just
    // because nothing about the failure changed. Re-alert on an unchanged bad
    // signature once it's been sitting for a day.
    const REMIND_AFTER_H = 24;
    const prevAgeH = prevRow?.ran_at ? (now - new Date(prevRow.ran_at).getTime()) / 3_600_000 : Infinity;
    const unchanged = signature === prev;
    const stillDown = down.length > 0 || erroring.length > 0 || coiAlerts.length > 0 || noLeads.length > 0 || noUploads.length > 0;
    const dueForReminder = unchanged && stillDown && prevAgeH >= REMIND_AFTER_H;
    if (unchanged && !dueForReminder) { console.log("No change — no alert."); return; }

    const coiLine = coiAlerts.length
      ? `:shield: *Insurance expiring:* ${coiAlerts.map((r) => `${r.name} (${r.days < 0 ? `expired ${-r.days}d ago` : `${r.days}d`})`).join(", ")}`
      : "";

    let text: string | null = null;
    if (down.length || erroring.length || coiAlerts.length || noLeads.length || noUploads.length) {
      const parts: string[] = [];
      if (down.length) parts.push(`:red_circle: *Not flowing:* ${down.map(label).join(", ")}`);
      if (erroring.length) parts.push(`:large_orange_circle: *Account errors:* ${erroring.map((e) => `${label(e.src)} (${e.n}/${e.m})`).join(", ")}`);
      if (noLeads.length) parts.push(`:mailbox_with_no_mail: *No new website leads:* ${noLeads.map((l) => `${clientLabel(l.slug)} (last ${Math.round(l.ageH / 24)}d ago — check every form on the site still posts to the webhook)`).join(", ")}`);
      if (noUploads.length) parts.push(`:repeat: *Ad-click leads not reaching Google as admissions:* ${noUploads.map((u) => `${clientLabel(u.slug)} (${u.gclid30} gclid leads in 30d, last upload ${u.lastUpload ? `${Math.round((now - new Date(u.lastUpload).getTime()) / 86_400_000)}d ago` : "never"})`).join(", ")}`);
      if (coiLine) parts.push(coiLine);
      const headline = dueForReminder ? ":satellite: *Data health — still unresolved*" : ":satellite: *Data health changed*";
      text = `${headline}\n${parts.join("\n")}\n<${DASH}/#/admin/data-health|Open Data health →>`;
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

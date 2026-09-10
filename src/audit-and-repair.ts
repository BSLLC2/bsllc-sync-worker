#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Every weekday morning, before the brief: check every heartbeat and every
 * customer integration behind the dashboards, fix what can be fixed without
 * a person, and file everything else as a task in the "Data readiness"
 * project with the exact instruction — then close that task automatically
 * the morning the condition is gone.
 *
 *   --mode=plan   inspect heartbeats; write `rerun=<jobs>` to $GITHUB_OUTPUT so
 *                 the workflow re-runs only the importers that missed or failed
 *   --mode=apply  auto-fixes + audit findings → tasks (after the re-runs)
 *
 *   npm run audit-and-repair -- --mode=apply --dry-run
 */
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d).trim();
const dryRun = process.argv.includes("--dry-run");
const PROJECT_NAME = "Data readiness";
const INTERNAL_CLIENT = "BS LLC (internal)";
const ASSIGNEE = "Sebastien";
const SA_EMAIL = "bsllc-dashboard-sync@bs-llc-internal-tools.iam.gserviceaccount.com";

// heartbeat job → workflow step key, expected cadence in hours
const DAILY: Record<string, { step: string; hours: number }> = {
  incremental_sync: { step: "ads", hours: 26 },
  import_hubspot_metrics: { step: "hubspot_metrics", hours: 26 },
  import_och: { step: "och", hours: 26 },
  import_ga4: { step: "ga4", hours: 26 },
  import_gsc: { step: "gsc", hours: 26 },
  import_d365: { step: "d365", hours: 26 },
  hubspot_deals: { step: "hubspot_deals", hours: 14 },
  qbo_invoices_sync: { step: "qbo", hours: 26 },
  seo_import: { step: "seo", hours: 8 * 24 },
  aeo_import: { step: "aeo", hours: 8 * 24 },
  domain_authority_import: { step: "authority", hours: 8 * 24 },
};
const SOURCE_LABEL: Record<string, string> = { google_ads: "Google Ads", gsc: "Search Console", ga4: "GA4", hubspot: "HubSpot", d365: "Dynamics 365", square: "Square", seo: "SEO rank tracking", aeo: "AEO", authority: "Domain authority" };
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

type Finding = { key: string; title: string; priority: "P1" | "P2" | "P3"; description: string; status?: "blocked" | "not_started" };

function fixHint(source: string, msg: string | null): string {
  const m = msg ?? "";
  if (source === "gsc" && /403|permission/i.test(m)) return `In Search Console → Settings → Users and permissions, add ${SA_EMAIL} as a Full user. If we are not an Owner, the client adds digital@bsllc.biz as Owner first.`;
  if (source === "ga4" && /403|permission/i.test(m)) return `In GA4 Admin → Property access management, add ${SA_EMAIL} as Viewer.`;
  if (source === "google_ads" && /PERMISSION|authorization|USER_PERMISSION_DENIED/i.test(m)) return "The account is not under the BS LLC manager (MCC) or the shared user lost access — re-link it under MCC 214-171-2409.";
  if (source === "hubspot" && /401|403|expired|invalid/i.test(m)) return "The HubSpot private-app token is invalid or access was removed — ask the client admin to restore the app and rotate the token secret.";
  if (source === "d365" && /403/i.test(m)) return "The service principal's security role in dpg-prod lacks read on Opportunity/Contact — flag to the D365 admin.";
  return "Re-ran this morning and it still fails; open Admin → Connectors for the full error text.";
}

async function main() {
  const mode = arg("mode", "apply");
  const c = new pg.Client({ connectionString: (process.env.DATABASE_URL || "").trim() });
  await c.connect();
  try {
    const beats = new Map((await c.query<{ job: string; ran_at: Date; ok: boolean }>(`SELECT job, ran_at, ok FROM job_heartbeats`)).rows.map((r) => [r.job, r]));
    const now = Date.now();
    const staleJobs = Object.entries(DAILY).filter(([job, cfg]) => {
      const b = beats.get(job);
      return !b || !b.ok || now - new Date(b.ran_at).getTime() > cfg.hours * 3_600_000;
    });

    if (mode === "plan") {
      const rerun = staleJobs.map(([, cfg]) => cfg.step).join(",");
      console.log(`heartbeats: ${Object.keys(DAILY).length} daily/weekly jobs, ${staleJobs.length} missed or failed → re-run: ${rerun || "(none)"}`);
      for (const [job] of staleJobs) { const b = beats.get(job); console.log(`  ${job}: ${b ? `${b.ok ? "ok" : "FAILED"} at ${new Date(b.ran_at).toISOString()}` : "never ran"}`); }
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `rerun=${rerun}\n`);
      return;
    }

    // ── Auto-fixes (safe, idempotent) ──
    const fixes: string[] = [];
    const badGsc = (await c.query<{ id: string; external_id: string; name: string }>(
      `SELECT m.id, m.external_id, c.name FROM connector_mappings m JOIN clients c ON c.id = m.client_id
        WHERE m.source = 'gsc' AND m.enabled AND m.external_id IS NOT NULL AND m.external_id <> ''
          AND m.external_id NOT LIKE 'sc-domain:%' AND m.external_id NOT LIKE 'http%'`)).rows;
    for (const r of badGsc) {
      const fixed = `sc-domain:${r.external_id.trim().replace(/^www\./, "")}`;
      fixes.push(`${r.name}: Search Console property "${r.external_id}" → "${fixed}"`);
      if (!dryRun) await c.query(`UPDATE connector_mappings SET external_id = $2 WHERE id = $1`, [r.id, fixed]);
    }
    const future = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM metric_snapshots WHERE period_start > now() + interval '1 day' OR synced_at > now() + interval '1 day'`);
    if (Number(future.rows[0]?.n ?? 0) > 0) {
      fixes.push(`deleted ${future.rows[0]!.n} future-dated metric row(s)`);
      if (!dryRun) await c.query(`DELETE FROM metric_snapshots WHERE period_start > now() + interval '1 day' OR synced_at > now() + interval '1 day'`);
    }

    // ── Findings → tasks ──
    const findings: Finding[] = [];
    // Connectors whose newest error is newer than their newest success
    const conn = (await c.query<{ name: string; source: string; error_message: string | null }>(
      `WITH latest AS (
         SELECT DISTINCT ON (client_id, source, metric_key) client_id, source, metric_key, data_state, error_message, synced_at
           FROM metric_snapshots WHERE (period_end IS NULL OR period_end <= now()) ORDER BY client_id, source, metric_key, synced_at DESC),
       live AS (SELECT client_id, source, max(synced_at) AS m FROM latest WHERE data_state = 'live' GROUP BY 1, 2),
       err AS (SELECT DISTINCT ON (client_id, source) client_id, source, error_message, synced_at FROM latest WHERE data_state = 'error' ORDER BY client_id, source, synced_at DESC)
       SELECT c.name, e.source, e.error_message FROM err e
         JOIN connector_mappings m ON m.client_id = e.client_id AND m.source = e.source AND m.enabled
         JOIN clients c ON c.id = e.client_id
         LEFT JOIN live ON live.client_id = e.client_id AND live.source = e.source
        WHERE (live.m IS NULL OR e.synced_at >= live.m) AND c.status IN ('launch', 'active')`)).rows;
    for (const r of conn) findings.push({
      key: `conn:${slugify(r.name)}:${r.source}`, priority: "P1", status: "blocked",
      title: `${r.name} — ${SOURCE_LABEL[r.source] ?? r.source} is failing`,
      description: `${fixHint(r.source, r.error_message)}\n\nLast error: ${(r.error_message ?? "").slice(0, 300)}`,
    });
    // Jobs still stale after the morning re-run
    const beats2 = new Map((await c.query<{ job: string; ran_at: Date; ok: boolean }>(`SELECT job, ran_at, ok FROM job_heartbeats`)).rows.map((r) => [r.job, r]));
    for (const [job, cfg] of Object.entries(DAILY)) {
      const b = beats2.get(job);
      if (!b || !b.ok || Date.now() - new Date(b.ran_at).getTime() > cfg.hours * 3_600_000) findings.push({
        key: `job:${job}`, priority: "P1",
        title: `Worker job "${job}" has not succeeded ${b ? `since ${new Date(b.ran_at).toISOString().slice(0, 10)}` : "yet"}`,
        description: "Re-run this morning and still failing or missing. Open the workflow's last run in GitHub Actions (bsllc-sync-worker) for the error.",
      });
    }
    // Website leads gone quiet / traffic but no leads
    const leads = (await c.query<{ client_slug: string; last_lead: Date; n90: string; n30: string }>(
      `SELECT client_slug, max(submitted_at) AS last_lead,
              count(*) FILTER (WHERE submitted_at > now() - interval '90 days')::text AS n90,
              count(*) FILTER (WHERE submitted_at > now() - interval '30 days')::text AS n30
         FROM web_inquiries WHERE email IS NULL OR (email NOT ILIKE '%@bsllc.biz' AND email NOT IN ('sebastienhue@gmail.com','test-inquiry@bsllc.biz'))
        GROUP BY client_slug`)).rows;
    const clients = (await c.query<{ id: string; name: string; status: string; contract_start: string | null; customer_value_cents: number | null; close_rate_pct: number | null; revenue_model: string | null; is_internal: boolean }>(
      `SELECT id, name, status, contract_start, customer_value_cents, close_rate_pct, revenue_model, coalesce(is_internal, false) AS is_internal FROM clients WHERE status IN ('launch','active')`)).rows;
    const bySlug = new Map(clients.map((cl) => [slugify(cl.name), cl]));
    const SLA_H: Record<string, number> = { "ohio-community-health-och": 7 * 24 };
    for (const l of leads) {
      const cl = bySlug.get(l.client_slug); if (!cl || cl.is_internal) continue;
      const ageH = (Date.now() - new Date(l.last_lead).getTime()) / 3_600_000;
      if (Number(l.n90) > 0 && ageH > (SLA_H[l.client_slug] ?? 14 * 24)) findings.push({
        key: `leads-quiet:${l.client_slug}`, priority: "P2",
        title: `${cl.name} — no website leads for ${Math.round(ageH / 24)} days (had ${l.n90} in the last 90)`,
        description: "A form probably lost its webhook action, or WEBFORM_SECRET changed. Submit a test on EACH form on the site; the setup checklist's webform_tracking item lists which forms have posted in the last 30 days.",
      });
    }
    const traffic = (await c.query<{ name: string }>(
      `SELECT c.name FROM clients c WHERE c.status IN ('launch','active') AND NOT coalesce(c.is_internal,false)
          AND EXISTS (SELECT 1 FROM metric_snapshots m WHERE m.client_id = c.id AND m.source = 'ga4' AND m.metric_key = 'ga4.sessions'
                        AND m.data_state = 'live' AND m.value_numeric > 0 AND coalesce(m.period_start, m.synced_at) > now() - interval '45 days')`)).rows;
    const n30 = new Map(leads.map((l) => [l.client_slug, Number(l.n30)]));
    for (const t of traffic) {
      const s = slugify(t.name);
      if ((n30.get(s) ?? 0) === 0) findings.push({
        key: `traffic-no-leads:${s}`, priority: "P2",
        title: `${t.name} — site traffic but zero website leads captured in 30 days`,
        description: "No form on the site posts to /api/webform, or the one that does isn't the form people use. Wire every form (Elementor: Webhook action per form; Gravity Forms: webhook feed) and test each.",
      });
    }
    // Client record gaps that make the case study / lifetime totals wrong
    const enabledBy = new Map<string, number>();
    for (const r of (await c.query<{ client_id: string; n: string }>(`SELECT client_id, count(*)::text AS n FROM connector_mappings WHERE enabled AND external_id IS NOT NULL AND external_id <> '' GROUP BY client_id`)).rows) enabledBy.set(r.client_id, Number(r.n));
    const hasData = new Set((await c.query<{ client_id: string }>(`SELECT DISTINCT client_id FROM metric_snapshots WHERE data_state = 'live'`)).rows.map((r) => r.client_id));
    for (const cl of clients) {
      if (cl.is_internal) continue;
      const s = slugify(cl.name);
      const leadFlow = (n30.get(s) ?? 0) > 0 || Number(leads.find((l) => l.client_slug === s)?.n90 ?? 0) > 0;
      if (!cl.contract_start && hasData.has(cl.id)) findings.push({ key: `contract-start:${s}`, priority: "P2", title: `${cl.name} — no contract start date`, description: "Set it on the client page. Lifetime totals, the case-study window and pre-contract lead trimming all key off it." });
      if (cl.revenue_model !== "retainer" && leadFlow && cl.customer_value_cents == null) findings.push({ key: `value:${s}`, priority: "P2", title: `${cl.name} — leads flowing but no customer value / close rate`, description: "Set Customer value (median won-customer revenue) and Close rate on the client page, or mark the client as retainer on the Marketing tab if there is no per-lead revenue to attribute." });
      if ((enabledBy.get(cl.id) ?? 0) === 0 && !cl.is_internal) findings.push({ key: `no-connectors:${s}`, priority: "P3", title: `${cl.name} — no data connectors enabled`, description: "Decide the scope: GA4 + Search Console at minimum for any site we touch; Ads / CRM where we run them. Admin → Connectors." });
    }

    // ── Upsert tasks; auto-close resolved ones ──
    const { rows: [internal] } = await c.query<{ id: string }>(`SELECT id FROM clients WHERE name = $1`, [INTERNAL_CLIENT]);
    if (!internal) throw new Error("internal client missing");
    const open = new Map((await c.query<{ external_id: string; status: string }>(`SELECT external_id, status FROM commitments WHERE client_id = $1 AND source = 'data-audit' AND status <> 'complete'`, [internal.id])).rows.map((r) => [r.external_id, r.status]));
    let created = 0, refreshed = 0, closed = 0;
    for (const f of findings) {
      if (open.has(f.key)) {
        refreshed++;
        if (!dryRun) await c.query(`UPDATE commitments SET title = $3, description = $4, priority = $5, last_updated_at = now() WHERE client_id = $1 AND source = 'data-audit' AND external_id = $2 AND status <> 'complete'`, [internal.id, f.key, f.title, f.description, f.priority]);
      } else {
        created++;
        if (!dryRun) await c.query(
          `INSERT INTO commitments (id, client_id, priority, title, description, owner_type, owner_name, assignee_name, status, category, workstream, due_date, source, external_id)
           VALUES ($1, $2, $3, $4, $5, 'bs_llc', 'BS LLC', $6, $7, 'setup', $8, to_char(now() + interval '3 days', 'YYYY-MM-DD'), 'data-audit', $9)`,
          [randomUUID(), internal.id, f.priority, f.title, f.description, ASSIGNEE, f.status ?? "not_started", PROJECT_NAME, f.key]);
      }
    }
    const live = new Set(findings.map((f) => f.key));
    for (const key of open.keys()) if (!live.has(key)) {
      closed++;
      if (!dryRun) await c.query(`UPDATE commitments SET status = 'complete', completed_at = now(), last_updated_at = now(), description = coalesce(description,'') || E'\n\nAuto-resolved by the morning audit: the condition is gone.' WHERE client_id = $1 AND source = 'data-audit' AND external_id = $2 AND status <> 'complete'`, [internal.id, key]);
    }

    console.log(`auto-fixes: ${fixes.length ? fixes.join("; ") : "none needed"}`);
    console.log(`findings: ${findings.length} (${created} new task(s), ${refreshed} refreshed, ${closed} auto-closed)${dryRun ? " — DRY RUN, nothing written" : ""}`);
    for (const f of findings) console.log(`  ${f.priority}  ${f.title}`);
    if (!dryRun) await c.query(`INSERT INTO job_heartbeats (job, ran_at, ok, note) VALUES ('morning_audit', now(), true, $1) ON CONFLICT (job) DO UPDATE SET ran_at = now(), ok = true, note = EXCLUDED.note`, [`${findings.length} findings, ${fixes.length} fixes`]);
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

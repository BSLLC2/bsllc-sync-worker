#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One Slack message every weekday morning instead of a transcript: per
 * priority client, what flowed this month (leads, conversions, revenue tier),
 * which connectors are failing, the launches still in progress, and the
 * Data-readiness tasks that are blocked, overdue, or due for Sebastien today.
 * Reads Postgres only; posts via SLACK_WEBHOOK_URL (same as monitor-freshness).
 *
 *   npm run daily-brief -- --dry-run
 */
const DASH = "https://work.bsllc.biz";
const PRIORITY = ["Franklin Brazing", "Ohio Community Health (OCH)", "Diesel Power Group", "Tablespoon"];
const PROJECT_NAME = "Data readiness";
// Same rule as the dashboard's shared/case-study.ts: only revenue traceable
// to our leads counts as a tier. Company-wide totals (d365.revenue_cents,
// hubspot.revenue_cents, ga4/square revenue) are context, never a tier.
const CONFIRMED = ["manual.revenue_confirmed_cents"];
const SYSTEM = ["d365.cw_revenue_bsllc_cents", "hubspot.cw_revenue_bsllc_cents", "manual.revenue_system_cents"];
const MODELED = ["manual.revenue_cents"];
const CONV = ["manual.admissions_marketing_current", "manual.admissions_marketing", "ads.conversions", "ga4.conversions"];
const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const usd = (c: number) => "$" + Math.round(c / 100).toLocaleString("en-US");

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
  const c = new pg.Client({ connectionString: (process.env.DATABASE_URL || "").trim() });
  await c.connect();
  try {
    const { rows: clients } = await c.query<{ id: string; name: string; customer_value_cents: number | null; close_rate_pct: number | null; contract_start: string | null }>(
      `SELECT id, name, customer_value_cents, close_rate_pct, contract_start FROM clients WHERE name = ANY($1)`, [PRIORITY]);
    const lines: string[] = [];
    for (const name of PRIORITY) {
      const cl = clients.find((x) => x.name === name);
      if (!cl) continue;
      const s = slug(name);
      const { rows: [web] } = await c.query<{ forms: string; calls: string; last: string | null }>(
        `SELECT count(*) FILTER (WHERE coalesce(form_name,'') NOT LIKE 'Phone:%')::text AS forms,
                count(*) FILTER (WHERE coalesce(form_name,'') LIKE 'Phone:%')::text AS calls,
                max(submitted_at)::text AS last
           FROM web_inquiries WHERE client_slug = $1 AND submitted_at >= date_trunc('month', now())
             AND coalesce(email,'') NOT ILIKE '%@bsllc.biz'`, [s]);
      const { rows: conv } = await c.query<{ metric_key: string; v: number }>(
        `SELECT DISTINCT ON (metric_key) metric_key, value_numeric AS v FROM metric_snapshots
          WHERE client_id = $1 AND data_state = 'live' AND value_numeric IS NOT NULL AND metric_key = ANY($2)
            AND period_start >= date_trunc('month', now()) ORDER BY metric_key, synced_at DESC`, [cl.id, CONV]);
      const convHit = CONV.map((k) => conv.find((r) => r.metric_key === k)).find(Boolean);
      const { rows: rev } = await c.query<{ metric_key: string }>(
        `SELECT DISTINCT metric_key FROM metric_snapshots WHERE client_id = $1 AND data_state = 'live' AND value_numeric > 0 AND metric_key = ANY($2)`,
        [cl.id, [...CONFIRMED, ...SYSTEM, ...MODELED]]);
      const keys = new Set(rev.map((r) => r.metric_key));
      // Named wins count only with a documented source (the client record they came from).
      const { rows: [wins] } = await c.query<{ n: string; total: string }>(`SELECT count(*)::text AS n, coalesce(sum(value_cents),0)::text AS total FROM client_named_wins WHERE client_id = $1 AND coalesce(trim(source), '') <> ''`, [cl.id]);
      const tier = CONFIRMED.some((k) => keys.has(k)) ? "client confirmed"
        : SYSTEM.some((k) => keys.has(k)) || Number(wins?.n ?? 0) > 0 ? "client records"
        : MODELED.some((k) => keys.has(k)) || (cl.customer_value_cents && (cl.close_rate_pct != null)) ? "modeled"
        : "none";
      // A connector is failing only if its newest error is at least as recent
      // as its newest success (same rule as Admin → Connectors).
      const { rows: errs } = await c.query<{ source: string; error_message: string | null }>(
        `WITH latest AS (
           SELECT DISTINCT ON (source, metric_key) source, metric_key, data_state, error_message, synced_at
             FROM metric_snapshots WHERE client_id = $1 AND (period_end IS NULL OR period_end <= now())
            ORDER BY source, metric_key, synced_at DESC),
         live AS (SELECT source, max(synced_at) AS m FROM latest WHERE data_state IN ('live', 'no_data') GROUP BY source),
         err AS (SELECT DISTINCT ON (source) source, error_message, synced_at FROM latest WHERE data_state = 'error' ORDER BY source, synced_at DESC)
         SELECT e.source, e.error_message FROM err e LEFT JOIN live ON live.source = e.source
          WHERE live.m IS NULL OR e.synced_at > live.m`, [cl.id]);
      const parts = [
        `${web?.forms ?? 0} forms · ${web?.calls ?? 0} calls this month${web?.last ? ` (last ${web.last.slice(0, 10)})` : ""}`,
        convHit ? `${Math.round(Number(convHit.v))} conversions (${convHit.metric_key.replace(/^.*\./, "").replace(/_/g, " ")})` : "conversions: none this month",
        `revenue: ${tier}${Number(wins?.n ?? 0) > 0 ? ` incl. ${wins!.n} named win(s) ${usd(Number(wins!.total))}` : ""}`,
      ];
      if (!cl.contract_start) parts.push("no contract start");
      if (errs.length) parts.push(`:warning: ${errs.map((e) => e.source).join(", ")} failing`);
      lines.push(`• *${name}* — ${parts.join(" · ")}`);
    }

    // ── Launches still open ──
    // The signal is client_setup_reminders: the dashboard's daily
    // setup-checklist cron inserts a row for any client with an outstanding
    // launch step and DELETES it the moment nothing is outstanding, having
    // recomputed every step against live evidence (connector syncs, real form
    // submissions, share-link opens) first. So a row here means "this launch
    // was genuinely unfinished as of the last run" — which is a far better
    // signal than counting client_setup_status rows, since a step that has
    // never been touched has no row at all and pending is the default.
    // created_at is when the launch first showed up as unfinished.
    const { rows: launches } = await c.query<{
      id: string; name: string; am_owner: string | null; started: string;
      reminders: number; escalations: number; done: string; blocked: string; reasons: string[] | null;
    }>(
      `SELECT cl.id, cl.name, cl.am_owner, r.created_at::text AS started,
              r.reminder_count AS reminders, r.escalation_count AS escalations,
              count(s.id) FILTER (WHERE s.status = 'done')::text    AS done,
              count(s.id) FILTER (WHERE s.status = 'blocked')::text AS blocked,
              array_remove(array_agg(s.reason) FILTER (WHERE s.status = 'blocked'), NULL) AS reasons
         FROM client_setup_reminders r
         JOIN clients cl ON cl.id = r.client_id
         LEFT JOIN client_setup_status s ON s.client_id = cl.id
        WHERE cl.status NOT IN ('churned', 'paused') AND cl.is_internal = false
        GROUP BY cl.id, cl.name, cl.am_owner, r.created_at, r.reminder_count, r.escalation_count
        ORDER BY r.created_at`);
    const launchLines = launches.slice(0, 8).map((l) => {
      const age = Math.floor((Date.now() - new Date(l.started).getTime()) / 86_400_000);
      const bits = [
        `${l.done} done`,
        Number(l.blocked) > 0 ? `${l.blocked} blocked` : "",
        `open ${age}d`,
        l.am_owner ? l.am_owner : ":warning: no AM",
        Number(l.escalations) > 0 ? `:rotating_light: escalated ${l.escalations}x` : "",
      ].filter(Boolean);
      const why = (l.reasons ?? []).filter(Boolean).slice(0, 2).join(" · ");
      return `    – <${DASH}/#/client/${l.id}/launch|${l.name}> — ${bits.join(" · ")}${why ? ` — blocked: ${why}` : ""}`;
    });

    // ── Ads decisions ──
    // Nothing routed anyone to the paid-media queue on a schedule: Home shows
    // the block only to whoever owns the account and only if they look. One
    // line, three states, and the three are deliberately different sentences:
    //
    //   • findings waiting  — how many, the biggest, and what has been sitting.
    //   • none waiting      — said ONLY when the weekly audit is healthy, with
    //                         the date it last ran. "Nothing to decide" is a
    //                         real answer; it just has to carry its evidence.
    //   • audit unhealthy   — the same empty queue, but "none waiting" would be
    //                         a lie. This is the failure mode the whole line
    //                         exists for: a job that quietly stopped looks
    //                         exactly like a clean week.
    const ADS_IGNORED_AFTER_SEEN = 4; // mirrors shared/ads-findings.ts
    let adsLine: string | null = null;
    try {
      const { rows: [ads] } = await c.query<{
        waiting: string; ignored: string; oldest_days: number | null;
        top_client: string | null; top_title: string | null; top_cents: number | null;
      }>(
        `WITH q AS (
           SELECT f.est_impact_cents, f.first_seen_at, f.times_seen, f.title, cl.name AS client
             FROM ads_findings f JOIN clients cl ON cl.id = f.client_id
            WHERE f.status IN ('open','proposed') AND cl.status NOT IN ('churned','paused'))
         SELECT count(*)::text AS waiting,
                count(*) FILTER (WHERE times_seen >= $1)::text AS ignored,
                (now()::date - min(first_seen_at)::date) AS oldest_days,
                (SELECT client FROM q ORDER BY est_impact_cents DESC NULLS LAST LIMIT 1) AS top_client,
                (SELECT title  FROM q ORDER BY est_impact_cents DESC NULLS LAST LIMIT 1) AS top_title,
                (SELECT est_impact_cents FROM q ORDER BY est_impact_cents DESC NULLS LAST LIMIT 1) AS top_cents
           FROM q`, [ADS_IGNORED_AFTER_SEEN]);
      const { rows: [beat] } = await c.query<{ ok: boolean; ran_at: Date; sla_hours: number | null }>(
        `SELECT ok, ran_at, sla_hours FROM job_heartbeats WHERE job = 'ads_findings'`);
      const staleH = beat ? (Date.now() - new Date(beat.ran_at).getTime()) / 3_600_000 : Infinity;
      const auditHealthy = Boolean(beat?.ok) && staleH <= (beat?.sla_hours || 252);
      const waiting = Number(ads?.waiting ?? 0);
      if (waiting > 0) {
        const bits = [`${waiting} waiting`];
        if (ads?.top_cents && ads.top_client) bits.push(`biggest ${usd(ads.top_cents)}/mo — ${ads.top_client}, ${(ads.top_title ?? "").slice(0, 60)}`);
        if (ads?.oldest_days != null) bits.push(`oldest ${ads.oldest_days}d`);
        if (Number(ads?.ignored ?? 0) > 0) bits.push(`${ads!.ignored} seen ${ADS_IGNORED_AFTER_SEEN}×+ with no decision`);
        adsLine = `*Ads decisions:* ${bits.join(" · ")} <${DASH}/#/ads|Open →>`;
      } else if (auditHealthy) {
        adsLine = `*Ads decisions:* none waiting · weekly audit ran ${new Date(beat!.ran_at).toISOString().slice(0, 10)}`;
      } else {
        adsLine = `*Ads decisions:* :warning: the weekly audit ${beat ? `has not succeeded since ${new Date(beat.ran_at).toISOString().slice(0, 10)}` : "has never run"} — an empty queue means nothing until it does`;
      }
    } catch { /* ads_findings not deployed yet */ }

    const { rows: tasks } = await c.query<{ title: string; status: string; priority: string; due_date: string | null; assignee_name: string | null }>(
      `SELECT title, status, priority, due_date, assignee_name FROM commitments
        WHERE source IN ('data-readiness', 'data-audit') AND workstream = $1 AND status <> 'complete' ORDER BY priority, due_date NULLS LAST`, [PROJECT_NAME]);
    const today = new Date().toISOString().slice(0, 10);
    const overdue = tasks.filter((t) => t.due_date && t.due_date < today);
    const dueToday = tasks.filter((t) => t.due_date === today);
    const blocked = tasks.filter((t) => t.status === "blocked");
    const fmt = (t: typeof tasks[number]) => `    – ${t.priority} ${t.title}${t.due_date ? ` (due ${t.due_date})` : ""}`;

    const text = [
      `:sunrise: *Morning brief — ${today}*`,
      ...lines,
      "",
      ...(launchLines.length ? [`*Launches in progress:* ${launches.length}`, ...launchLines] : []),
      ...(launchLines.length ? [""] : []),
      ...(adsLine ? [adsLine, ""] : []),
      `*${PROJECT_NAME}:* ${tasks.length} open · ${blocked.length} blocked · ${overdue.length} overdue`,
      ...(dueToday.length ? [`*Due today:*`, ...dueToday.map(fmt)] : []),
      ...(overdue.length ? [`*Overdue:*`, ...overdue.slice(0, 6).map(fmt)] : []),
      ...(blocked.length ? [`*Blocked (waiting on someone else):*`, ...blocked.slice(0, 6).map(fmt)] : []),
      `<${DASH}/#/projects|Open the project →>  ·  <${DASH}/#/marketing|Case-study gaps →>`,
    ].join("\n");

    if (!dryRun && webhook) {
      const res = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      console.log(res.ok ? "Brief posted to Slack." : `Slack post failed (${res.status}).`);
    } else console.log(dryRun ? `[dry-run] would post:\n${text}` : "SLACK_WEBHOOK_URL not set — skipping post.");
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

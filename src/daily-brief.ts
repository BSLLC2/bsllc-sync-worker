#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One Slack message every weekday morning instead of a transcript: per
 * priority client, what flowed this month (leads, conversions, revenue tier),
 * which connectors are failing, and the Data-readiness tasks that are blocked,
 * overdue, or due for Sebastien today. Reads Postgres only; posts via
 * SLACK_WEBHOOK_URL (same as monitor-freshness).
 *
 *   npm run daily-brief -- --dry-run
 */
const DASH = "https://work.bsllc.biz";
const PRIORITY = ["Franklin Brazing", "Ohio Community Health (OCH)", "Diesel Power Group", "Tablespoon"];
const PROJECT_NAME = "Data readiness";
const CONFIRMED = ["manual.revenue_confirmed_cents"];
const SYSTEM = ["d365.revenue_cents", "d365.cw_revenue_bsllc_cents", "hubspot.revenue_cents", "manual.revenue_system_cents", "ga4.revenue_cents", "square.revenue_cents"];
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
      const { rows: [wins] } = await c.query<{ n: string; total: string }>(`SELECT count(*)::text AS n, coalesce(sum(value_cents),0)::text AS total FROM client_named_wins WHERE client_id = $1`, [cl.id]);
      const tier = CONFIRMED.some((k) => keys.has(k)) ? "client confirmed"
        : SYSTEM.some((k) => keys.has(k)) || Number(wins?.n ?? 0) > 0 ? "client records"
        : MODELED.some((k) => keys.has(k)) || (cl.customer_value_cents && (cl.close_rate_pct != null)) ? "modeled"
        : "none";
      // Connector state judged on the latest run only (same rule as Admin → Connectors)
      const { rows: errs } = await c.query<{ source: string; error_message: string | null }>(
        `WITH latest AS (
           SELECT DISTINCT ON (source, metric_key) source, metric_key, data_state, error_message, synced_at
             FROM metric_snapshots WHERE client_id = $1 AND (period_end IS NULL OR period_end <= now())
            ORDER BY source, metric_key, synced_at DESC),
         mx AS (SELECT source, max(synced_at) AS m FROM latest GROUP BY source)
         SELECT DISTINCT l.source, l.error_message FROM latest l JOIN mx ON mx.source = l.source
          WHERE l.data_state = 'error' AND l.synced_at >= mx.m - interval '6 hours'`, [cl.id]);
      const parts = [
        `${web?.forms ?? 0} forms · ${web?.calls ?? 0} calls this month${web?.last ? ` (last ${web.last.slice(0, 10)})` : ""}`,
        convHit ? `${Math.round(Number(convHit.v))} conversions (${convHit.metric_key.replace(/^.*\./, "").replace(/_/g, " ")})` : "conversions: none this month",
        `revenue: ${tier}${Number(wins?.n ?? 0) > 0 ? ` incl. ${wins!.n} named win(s) ${usd(Number(wins!.total))}` : ""}`,
      ];
      if (!cl.contract_start) parts.push("no contract start");
      if (errs.length) parts.push(`:warning: ${errs.map((e) => e.source).join(", ")} failing`);
      lines.push(`• *${name}* — ${parts.join(" · ")}`);
    }

    const { rows: tasks } = await c.query<{ title: string; status: string; priority: string; due_date: string | null; assignee_name: string | null }>(
      `SELECT title, status, priority, due_date, assignee_name FROM commitments
        WHERE source = 'data-readiness' AND workstream = $1 AND status <> 'complete' ORDER BY priority, due_date NULLS LAST`, [PROJECT_NAME]);
    const today = new Date().toISOString().slice(0, 10);
    const overdue = tasks.filter((t) => t.due_date && t.due_date < today);
    const dueToday = tasks.filter((t) => t.due_date === today);
    const blocked = tasks.filter((t) => t.status === "blocked");
    const fmt = (t: typeof tasks[number]) => `    – ${t.priority} ${t.title}${t.due_date ? ` (due ${t.due_date})` : ""}`;

    const text = [
      `:sunrise: *Morning brief — ${today}*`,
      ...lines,
      "",
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

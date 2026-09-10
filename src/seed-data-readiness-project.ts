#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * The one backlog for getting every priority client's data streams (leads,
 * conversions, revenue, connectors) to "accurate and automatic". Lives in the
 * OS as a project on the internal BS LLC client so every person and agent
 * reads and writes the same list — not chat threads.
 *
 * Idempotent: the project is keyed on (client, name); each task on
 * (source='data-readiness', external_id). Re-running updates title /
 * description / priority / due on tasks that are still open and never
 * touches one that has been completed or edited to another status by a
 * human (status is only written on first insert).
 *
 *   npm run seed-data-readiness-project -- --dry-run=true
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? process.env[k.toUpperCase().replace(/-/g, "_")] ?? d).trim();

export const PROJECT_NAME = "Data readiness";
const INTERNAL_CLIENT = "BS LLC (internal)";
const ASSIGNEE = "Sebastien";

type Task = { key: string; title: string; priority: "P0" | "P1" | "P2" | "P3"; status: "not_started" | "in_progress" | "blocked" | "complete"; due?: string; description: string };
const TASKS: Task[] = [
  // ── Franklin Brazing ──
  { key: "fb-david-email", title: "Franklin — send the David Andrews email (Search Console owner, Smartsheet export, RFQ closed-won field)", priority: "P0", status: "not_started", due: "2026-09-11",
    description: "Draft is in Superhuman (draft0028e87f4d3b2242). Every ask goes to digital@bsllc.biz. Sending it unblocks fb-gsc and fb-smartsheet." },
  { key: "fb-gsc", title: "Franklin — Search Console: add bsllc-dashboard-sync@bs-llc-internal-tools.iam.gserviceaccount.com as Full user", priority: "P1", status: "blocked", due: "2026-09-12",
    description: "Connector shows 403. If Sebastien is an Owner on sc-domain:franklinbrazing.com he can add it himself; otherwise David adds digital@bsllc.biz as Owner first. Admin → Connectors shows the exact instruction under the failed row." },
  { key: "fb-smartsheet", title: "Franklin — Smartsheet RFQ log: weekly XLSX to digital@bsllc.biz, then build the importer (Tier 2 actuals)", priority: "P1", status: "blocked", due: "2026-09-17",
    description: "David shares the sheet as Admin; we build the recurring 'send as attachment' workflow. Worker importer keys on Quote Number and writes manual.revenue_system_cents + named wins. Until then revenue is seeded from the Dec 2025 export." },
  { key: "fb-ga4-aug", title: "Franklin — check the August GA4 drop (1,215 → 266 users) before any case study uses those months", priority: "P2", status: "not_started", due: "2026-09-16",
    description: "Looks like a tracking gap, not a traffic collapse. Confirm in GA4 (tag firing / property change) and note it on the case study if real." },
  { key: "fb-live-lead", title: "Franklin — live form capture proven (first non-replayed lead landed 2026-09-10)", priority: "P2", status: "complete",
    description: "Plugin v4 on franklinbrazing.com; 723 replayed rows Mar 2024 → Sep 2026 plus live hook. Nothing further to do." },
  // ── Ohio Community Health ──
  { key: "och-admission-value", title: "OCH — ask for average net revenue per admission (moves revenue from modeled to client-confirmed)", priority: "P1", status: "not_started", due: "2026-09-12",
    description: "Today: 51 attributed admissions × $8,000 agreed value = $408k modeled. A number confirmed in writing becomes customer value with tier confirmed, and the case study can use it." },
  { key: "och-ctm-fields", title: "OCH — ask their CallTrackingMetrics template to send source, tracking_source and call_id", priority: "P2", status: "not_started", due: "2026-09-19",
    description: "Calls currently arrive as bare caller-ID payloads labelled 'Phone: CallTrackingMetrics'. With the three fields we attribute each call to its campaign." },
  // ── Diesel Power Group ──
  { key: "dpg-gf-feed", title: "DPG — Kristen adds the second Gravity Forms webhook feed (forms → Website Leads)", priority: "P1", status: "blocked", due: "2026-09-12",
    description: "Phone calls flow via CallRail already; form fills still only reach D365. Check-in reminder set for 2026-09-11." },
  { key: "dpg-power-automate", title: "DPG — finish the 'CallRail Call to D365' Power Automate flow", priority: "P1", status: "in_progress", due: "2026-09-12",
    description: "Mapping: tracking_phone_number = +18663708711 → 100000003, else 100000005." },
  { key: "dpg-sample-data", title: "DPG — delete Microsoft sample data from dpg-prod Dynamics (Café A-100 espresso deals, Alex Baker, Zoltán Szabó…)", priority: "P1", status: "not_started", due: "2026-09-12",
    description: "29 Closed Won since May include ~$1.25M of demo records. They pollute deal-size stats and would enter attributed revenue if any post-Sep-3 sample deal exists. Kristen / DPG admin." },
  { key: "dpg-customer-value", title: "DPG — confirm customer value (~$50k median real engine deal) and set close rate once the first attributed deal closes", priority: "P2", status: "not_started", due: "2026-09-16",
    description: "Real deals (Cummins X15, Detroit S60, CAT C16) sit $50k–$70k. Set on the client page: Customer value + Close rate." },
  { key: "dpg-ads-running", title: "DPG — confirm whether Google Ads is actually running (account returns no data since Aug 24)", priority: "P2", status: "not_started", due: "2026-09-12",
    description: "Connector 5606779452 answers but every window is empty. Paused campaigns, or wrong account under the MCC?" },
  // ── Tablespoon ──
  { key: "tbs-jordan-email", title: "Tablespoon — send the Jordan email (HubSpot access removed Sep 8; need it back or a webhook to /api/webform/tablespoon)", priority: "P0", status: "not_started", due: "2026-09-11",
    description: "Text was approved in chat; not yet in Superhuman. Leads are blocked until access or the HubSpot workflow 'Send webhook' action exists." },
  { key: "tbs-webhook", title: "Tablespoon — HubSpot workflow 'Send webhook' → /api/webform/tablespoon?key=…", priority: "P1", status: "blocked", due: "2026-09-16",
    description: "Blocked on tbs-jordan-email. Revenue already flows from HubSpot deals; this is the lead side." },
  { key: "tbs-contract-start", title: "Tablespoon — contract start date on the client record", priority: "P2", status: "not_started", due: "2026-09-12",
    description: "Needed so lifetime totals and the case study window start at the engagement, not at the first data row." },
  // ── Cross-cutting ──
  { key: "x-values", title: "Set customer value + close rate for Brownell Travel, LBL Law, Exeter (they have lead flow and no value)", priority: "P2", status: "not_started", due: "2026-09-16",
    description: "Marketing tab flags each. Value = median won-customer revenue; close rate = leads → won customer over the same lead count." },
  { key: "x-retainer", title: "Mark retainer-only clients as revenueModel = retainer so they stop counting as 'missing revenue'", priority: "P3", status: "not_started", due: "2026-09-19",
    description: "16 Bricks, AIM MRO, American Iron Beds, Bombe, CSCH, Driveline, Empower, Integrus, Studio B1, Xspec — confirm which are performance vs retainer." },
  { key: "x-vercel-env", title: "Vercel env vars still unset: SLACK_BOT_TOKEN (app), AGENT_API_SECRET, LEAD_INTAKE_SECRET", priority: "P2", status: "not_started", due: "2026-09-12",
    description: "Without SLACK_BOT_TOKEN outbound Slack falls back to the slower worker drain; /api/agent/* and /api/web-leads are unusable until the other two are set. Redeploy after." },
  { key: "x-leads-board", title: "BS LLC internal Leads board: HubSpot form → Leads with a 'new' indicator (regression logged 2026-09-10)", priority: "P3", status: "not_started", due: "2026-09-19",
    description: "New HubSpot form submissions show no new-lead indicator on the Leads board." },
];

async function main() {
  const dryRun = arg("dry-run", "true") !== "false";
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: [client] } = await c.query<{ id: string }>(`SELECT id FROM clients WHERE name = $1 LIMIT 1`, [INTERNAL_CLIENT]);
    if (!client) throw new Error(`client "${INTERNAL_CLIENT}" not found`);
    const { rows: [existing] } = await c.query<{ id: string }>(`SELECT id FROM projects WHERE client_id = $1 AND name = $2`, [client.id, PROJECT_NAME]);
    console.log(`${PROJECT_NAME}: project ${existing ? "exists" : "will create"}; ${TASKS.length} tasks defined${dryRun ? " (DRY RUN)" : ""}`);
    const { rows: have } = await c.query<{ external_id: string; status: string }>(`SELECT external_id, status FROM commitments WHERE client_id = $1 AND source = 'data-readiness'`, [client.id]);
    const haveBy = new Map(have.map((h) => [h.external_id, h.status]));
    for (const t of TASKS) console.log(`  ${haveBy.has(t.key) ? `update (${haveBy.get(t.key)})` : `insert (${t.status})`}  ${t.priority}  ${t.title}`);
    if (dryRun) return;

    if (!existing) {
      await c.query(
        `INSERT INTO projects (id, client_id, name, status, description, owner_name, due_date, category, objective)
         VALUES ($1, $2, $3, 'active', $4, $5, '2026-09-19', 'Internal', $6)`,
        [randomUUID(), client.id, PROJECT_NAME,
          "Every priority client (Franklin Brazing, OCH, DPG, Tablespoon) shows zero blockers on the Marketing tab: leads and conversions flowing automatically, revenue at client-records tier or better, contract start set.",
          ASSIGNEE,
          "Accurate, automatic client data with no manual step on our side."]);
    }
    for (const t of TASKS) {
      if (haveBy.has(t.key)) {
        await c.query(
          `UPDATE commitments SET title = $3, description = $4, priority = $5, due_date = $6, workstream = $7, last_updated_at = now()
            WHERE client_id = $1 AND source = 'data-readiness' AND external_id = $2 AND status <> 'complete'`,
          [client.id, t.key, t.title, t.description, t.priority, t.due ?? null, PROJECT_NAME]);
      } else {
        await c.query(
          `INSERT INTO commitments (id, client_id, priority, title, description, owner_type, owner_name, assignee_name, status, category, workstream, due_date, source, external_id, completed_at)
           VALUES ($1, $2, $3, $4, $5, 'bs_llc', 'BS LLC', $6, $7, 'setup', $8, $9, 'data-readiness', $10, $11)`,
          [randomUUID(), client.id, t.priority, t.title, t.description, ASSIGNEE, t.status, PROJECT_NAME, t.due ?? null, t.key, t.status === "complete" ? new Date() : null]);
      }
    }
    console.log("done.");
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

/**
 * OFFLINE CONVERSION UPLOAD: one client's run. Decisions are in offline-upload.ts;
 * this gathers, calls Google through an injected customer, and records. Nothing
 * is logged but counts and the client's name. See offline-upload.ts first.
 */
import { randomUUID } from "node:crypto";
import {
  actionFault, planUpload, parseValueSetting, rejectedIndexes, scrub, validationAllows,
  type Plan, type RunMode, type Win, type AllowEntry,
} from "./offline-upload.js";

export interface Db { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
export interface AdsCustomer {
  query(gaql: string): Promise<any[]>;
  conversionUploads: { uploadClickConversions(req: any): Promise<any> };
}
export interface RunDeps {
  db: Db;
  today: string;
  now: Date;
  log: (line: string) => void;
  /** Opened lazily: dry runs never need Google credentials. */
  openCustomer: (accountId: string) => Promise<AdsCustomer>;
}
export interface ClientOutcome { slug: string; status: "stopped" | "dry" | "validated" | "sent"; stop: string | null; ready: number; accepted: number; rejected: number }

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const digits = (s: string) => s.replace(/\D/g, "");

async function winsFor(db: Db, clientId: string): Promise<Win[] | null> {
  const { rows } = await db.query(
    `SELECT value_text FROM metric_snapshots
      WHERE client_id = $1 AND source = 'manual' AND metric_key = 'manual.tracker_feed_summary' AND data_state = 'live'
      ORDER BY synced_at DESC LIMIT 1`, [clientId]);
  if (!rows[0]?.value_text) return null;
  try {
    const s = JSON.parse(rows[0].value_text);
    if (!s || !Array.isArray(s.counted)) return null;
    return s.counted.map((d: any) => ({ row: Number(d.row), closed: String(d.closed ?? ""), cents: Number(d.cents), gclid: typeof d.gclid === "string" ? d.gclid : null, clickOn: typeof d.clickOn === "string" ? d.clickOn : null }));
  } catch { return null; }
}

export async function runClient(slug: string, entry: AllowEntry, mode: RunMode, d: RunDeps): Promise<ClientOutcome> {
  const stop = (why: string): ClientOutcome => { d.log(`  stopped: ${why}`); return { slug, status: "stopped", stop: why, ready: 0, accepted: 0, rejected: 0 }; };
  d.log(`${slug} (${mode})`);
  const clients = (await d.db.query(`SELECT id, name FROM clients`)).rows as { id: string; name: string }[];
  const client = clients.filter((c) => slugify(c.name) === slug);
  if (client.length !== 1) return stop(client.length === 0 ? "No client has that name." : "More than one client has that name.");
  const clientId = client[0]!.id;

  const wins = await winsFor(d.db, clientId);
  if (!wins) return stop("The sales sheet has not been read, or its stored reading cannot be read.");

  const sentRows = (await d.db.query(`SELECT gclid, admission_date FROM offline_conversion_uploads WHERE client_slug = $1`, [slug])).rows as { gclid: string; admission_date: string }[];
  const sent = new Set(sentRows.map((r) => `${r.gclid}|${String(r.admission_date).slice(0, 10)}`));
  const setRow = (await d.db.query(`SELECT value FROM app_settings WHERE key = $1`, [`offline_value:${clientId}`])).rows[0];
  const plan: Plan = planUpload(wins, d.today, sent, parseValueSetting(setRow?.value));
  if (!plan.ok) return stop(plan.refusal!);
  const c = plan.counts;
  d.log(`  wins ${c.total}: ready ${c.ready}, no click id ${c.no_click_id + c.bad_click_id}, no click date ${c.no_click_date}, outside 90 days ${c.too_late + c.before_click}, closed today or later ${c.future_or_today}, already sent ${c.already_sent}, cut to ceiling ${c.cut}`);
  if (mode === "dry") { d.log("  dry run: nothing sent, nothing recorded."); return { slug, status: "dry", stop: null, ready: plan.rows.length, accepted: 0, rejected: 0 }; }
  if (plan.rows.length === 0) { d.log("  nothing is ready."); return { slug, status: mode === "validate" ? "validated" : "sent", stop: null, ready: 0, accepted: 0, rejected: 0 }; }

  const validatedKey = `offline_upload_validated:${slug}`;
  if (mode === "send") {
    const v = (await d.db.query(`SELECT value FROM app_settings WHERE key = $1`, [validatedKey])).rows[0];
    let at: string | null = null;
    try { at = v?.value ? JSON.parse(v.value).at : null; } catch { at = null; }
    if (!validationAllows(at, d.now)) return stop("No recent validate-only pass is recorded. Run mode validate first, read the answer, then send.");
  }

  const accts = (await d.db.query(
    `SELECT cm.external_id FROM clients c JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source = 'google_ads' AND cm.enabled = true
      WHERE c.id = $1 AND cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''`, [clientId])).rows as { external_id: string }[];
  if (accts.length !== 1) return stop(accts.length === 0 ? "No Google Ads account is switched on for this client." : "More than one Google Ads account is switched on, so nothing is sent.");
  const accountId = digits(accts[0]!.external_id);

  const customer = await d.openCustomer(accountId);
  const found = await customer.query(
    `SELECT conversion_action.resource_name, conversion_action.name, conversion_action.type, conversion_action.status, conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.name = '${entry.action.replace(/'/g, "")}'`);
  const action = found.length === 1 ? (found[0] as any).conversion_action : null;
  if (found.length > 1) return stop(`More than one conversion action is named "${entry.action}".`);
  const fault = actionFault(action, entry.action);
  if (fault) return stop(fault);

  const conversions = plan.rows.map((r) => ({
    gclid: r.gclid, conversion_action: action.resource_name, conversion_date_time: r.conversionTime,
    ...(r.valueCents != null ? { conversion_value: r.valueCents / 100, currency_code: "USD" } : {}),
    order_id: r.orderId,
  }));
  const validateOnly = mode === "validate";
  const resp: any = await customer.conversionUploads.uploadClickConversions({ customer_id: accountId, conversions, partial_failure: true, validate_only: validateOnly });
  const { rejected, codes, whole } = rejectedIndexes(resp);
  if (codes.length) d.log(`  Google reported: ${scrub(codes.join(", "))}`);
  if (whole) { d.log("  Google refused the whole request."); return { slug, status: "stopped", stop: "Google refused the whole request.", ready: plan.rows.length, accepted: 0, rejected: plan.rows.length }; }
  const acceptedIdx = plan.rows.map((_, i) => i).filter((i) => !rejected.has(i));
  if (validateOnly) {
    d.log(`  validate only: ${acceptedIdx.length} would be accepted, ${rejected.size} would be rejected. Nothing was sent.`);
    if (rejected.size === 0 || acceptedIdx.length > 0) {
      await d.db.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [validatedKey, JSON.stringify({ at: d.now.toISOString(), count: acceptedIdx.length })]);
    }
    return { slug, status: "validated", stop: null, ready: plan.rows.length, accepted: acceptedIdx.length, rejected: rejected.size };
  }
  const results: any[] = Array.isArray(resp?.results) ? resp.results : [];
  let recorded = 0;
  for (const i of acceptedIdx) {
    if (results.length && !(results[i]?.gclid || results[i]?.conversion_action)) continue;
    const r = plan.rows[i]!;
    await d.db.query(
      `INSERT INTO offline_conversion_uploads (id, client_slug, gclid, conversion_action, admission_date, value_cents, matched_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [randomUUID(), slug, r.gclid, action.resource_name, r.closed, r.valueCents, "tracker_sheet"]);
    recorded += 1;
  }
  d.log(`  sent ${plan.rows.length}: accepted and recorded ${recorded}, rejected ${plan.rows.length - recorded}.`);
  return { slug, status: "sent", stop: null, ready: plan.rows.length, accepted: recorded, rejected: plan.rows.length - recorded };
}

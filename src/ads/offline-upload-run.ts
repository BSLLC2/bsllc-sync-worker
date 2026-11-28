/**
 * OFFLINE CONVERSION UPLOAD: one client's run. Decisions are in offline-upload.ts;
 * this gathers, calls Google through an injected customer, and records. Nothing
 * is logged but counts and the client's name. See offline-upload.ts first.
 */
import { randomUUID } from "node:crypto";
import {
  planUpload, parseValueSetting,
  type Plan, type RunMode, type Win, type AllowEntry,
} from "./offline-upload.js";
import {
  buildIngestBody, chunk, validationAllows, actionFault, tallyBatch, scrub,
  type DmRow, type DmDestination, type DmAnswer, type IngestTally,
} from "./data-manager.js";
import { hashedIdentifiers, identifierGate, identifierCounts, identifierSummary, identifierRecord, identifierRecordKey } from "./user-identifiers.js";

export interface Db { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
export interface AdsCustomer { query(gaql: string): Promise<any[]> }
/** The Data Manager calls (src/ads/data-manager.ts), injected so the guard can run against a pretend Google. */
export interface DmCalls {
  token(): Promise<string>;
  ingest(token: string, body: Record<string, unknown>): Promise<DmAnswer>;
  requestStatus(token: string, requestId: string): Promise<{ received: number | null; failed: number | null } | null>;
}
export interface RunDeps {
  db: Db;
  today: string;
  now: Date;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** Opened lazily: dry runs never need Google credentials. Used only to read the conversion action. */
  openCustomer: (accountId: string) => Promise<AdsCustomer>;
  dm: DmCalls;
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

  const validatedKey = `dm_validated:${slug}`;
  if (mode === "send") {
    const v = (await d.db.query(`SELECT value FROM app_settings WHERE key = $1`, [validatedKey])).rows[0];
    if (!validationAllows(v?.value, d.now)) return stop("No recent validate-only pass is recorded. Run mode validate first, read the answer, then send.");
  }

  const accts = (await d.db.query(
    `SELECT cm.external_id FROM clients c JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source = 'google_ads' AND cm.enabled = true
      WHERE c.id = $1 AND cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''`, [clientId])).rows as { external_id: string }[];
  if (accts.length !== 1) return stop(accts.length === 0 ? "No Google Ads account is switched on for this client." : "More than one Google Ads account is switched on, so nothing is sent.");
  const accountId = digits(accts[0]!.external_id);

  const customer = await d.openCustomer(accountId);
  const actionName = entry.action.split(String.fromCharCode(39)).join("");
  const found = await customer.query(
    `SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.status, conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.name = '${actionName}'`);
  const action = found.length === 1 ? (found[0] as any).conversion_action : null;
  if (found.length > 1) return stop(`More than one conversion action is named "${entry.action}".`);
  const fault = actionFault(action, entry.action);
  if (fault) return stop(fault);

  // Phone and email come from the web_inquiries row of this client with the same click id. No row, no identifier.
  const gate = identifierGate(slug, mode === "send", d.env);
  const clickIds = plan.rows.map((r) => r.gclid);
  const contacts = new Map<string, { phone: unknown; email: unknown }>();
  if (gate.include) {
    const found2 = (await d.db.query(
      `SELECT gclid, phone, email FROM web_inquiries WHERE client_slug = $1 AND gclid = ANY($2) ORDER BY submitted_at DESC`, [slug, clickIds])).rows as any[];
    for (const w of found2) {
      const g = String(w.gclid ?? "").trim();
      const cur = contacts.get(g) ?? { phone: null, email: null };
      contacts.set(g, { phone: cur.phone ?? w.phone ?? null, email: cur.email ?? w.email ?? null });
    }
  }
  const hashed = plan.rows.map((r) => (gate.include ? hashedIdentifiers(contacts.get(r.gclid) ?? {}) : []));
  const rows: DmRow[] = plan.rows.map((r, i) => ({
    gclid: r.gclid, closed: r.closed, valueDollars: r.valueCents != null ? r.valueCents / 100 : null, transactionId: r.transactionId,
    ...(hashed[i]!.length ? { userIdentifiers: hashed[i] } : {}),
  }));
  const idCounts = identifierCounts(rows);
  d.log(`  ${identifierSummary(idCounts, gate)}`);

  const dest: DmDestination = { accountId, loginAccountId: digits(d.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "") || null, actionId: String(action.id) };
  const validateOnly = mode === "validate";
  const tok = await d.dm.token();
  let tally: IngestTally = { accepted: 0, refused: 0, failedBatches: 0, firstReason: null };
  const okChunks: number[] = [];
  let at = 0;
  for (const part of chunk(rows)) {
    const ans = await d.dm.ingest(tok, buildIngestBody(dest, part, validateOnly));
    if (!ans.ok) d.log(`  Data Manager refused ${part.length} row(s) (HTTP ${ans.status}): ${scrub(ans.reason ?? "no reason")}`);
    const st = ans.ok && ans.requestId ? await d.dm.requestStatus(tok, ans.requestId) : null;
    if (ans.ok && ans.requestId) d.log(`  request ${ans.requestId}: ${st ? `received ${st.received ?? "?"}, failed ${st.failed ?? "?"}` : "status not readable yet"}.`);
    tally = tallyBatch(tally, part.length, ans, st);
    if (ans.ok) for (let i = 0; i < part.length; i++) okChunks.push(at + i);
    at += part.length;
  }
  await d.db.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [identifierRecordKey(slug), identifierRecord(idCounts, gate, validateOnly ? "validate" : "send", d.now, { accepted: tally.accepted, refused: tally.refused })]);
  if (validateOnly) {
    d.log(`  validate only: Google would accept ${tally.accepted}, refuse ${tally.refused}. Nothing was sent.${tally.firstReason ? ` First reason: ${tally.firstReason}` : ""}`);
    if (tally.failedBatches === 0 && tally.refused === 0) {
      await d.db.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [validatedKey, d.now.toISOString()]);
    }
    return { slug, status: "validated", stop: null, ready: plan.rows.length, accepted: tally.accepted, rejected: tally.refused };
  }
  for (const i of okChunks) {
    const r = plan.rows[i]!;
    await d.db.query(
      `INSERT INTO offline_conversion_uploads (id, client_slug, gclid, conversion_action, admission_date, value_cents, matched_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [randomUUID(), slug, r.gclid, action.resource_name, r.closed, r.valueCents, "tracker_sheet+data_manager"]);
  }
  d.log(`  sent ${plan.rows.length}: Google accepted ${tally.accepted}, refused ${tally.refused}, ${okChunks.length} recorded.`);
  if (tally.accepted === 0) return { slug, status: "stopped", stop: "Google accepted none of the rows.", ready: plan.rows.length, accepted: 0, rejected: tally.refused };
  return { slug, status: "sent", stop: null, ready: plan.rows.length, accepted: tally.accepted, rejected: tally.refused };
}

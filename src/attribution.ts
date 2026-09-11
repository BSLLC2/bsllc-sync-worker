/**
 * Shared pieces of the "leads we sent → CRM lead / deal → won revenue" chain
 * (dashboard table lead_attributions; rule in the dashboard's
 * shared/case-study.ts). Used by match-web-leads-to-crm (writes the rows) and
 * import-hubspot-metrics (plants the our-channels monthly revenue metric), so
 * both classify a deal the same way.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { phone10 } from "./lead-keys.js";

export type Bucket = "bsllc" | "other" | "manual" | "unknown";
export type Stage = "open" | "won" | "lost" | "qualified" | "disqualified";
export type RecordType = "lead" | "opportunity" | "deal";

export interface AttributionRow {
  clientId: string;
  clientSlug: string;
  crm: "d365" | "hubspot";
  recordType: RecordType;
  recordId: string;
  recordName: string | null;
  recordCreatedOn: string | null; // YYYY-MM-DD
  sourceValue: string | null;
  bucket: Bucket;
  matchMethod: "email" | "phone" | "gclid" | null;
  webInquiryId: string | null;
  webInquiryAt: string | null; // YYYY-MM-DD
  gclid: string | null;
  stage: Stage;
  wonOn: string | null;
  valueCents: number | null;
  isSample: boolean;
}

// ── Web-inquiry index: the leads WE captured, by the keys a CRM record can carry ──
export interface WebInquiryHit { id: string; submittedAt: string; gclid: string | null }
export interface WebInquiryIndex { byEmail: Map<string, WebInquiryHit>; byPhone: Map<string, WebInquiryHit>; byGclid: Map<string, WebInquiryHit>; count: number }

/** Internal tests never count as leads we sent (same filter as the morning audit). */
const INTERNAL_TEST_EMAILS = new Set(["sebastienhue@gmail.com", "test-inquiry@bsllc.biz"]);

export async function loadWebInquiryIndex(c: pg.Client, clientSlug: string, since: string | null): Promise<WebInquiryIndex> {
  const { rows } = await c.query<{ id: string; email: string | null; phone: string | null; gclid: string | null; submitted_at: Date; status: string }>(
    `SELECT id, email, phone, gclid, submitted_at, status FROM web_inquiries
      WHERE client_slug = $1 AND ($2::date IS NULL OR submitted_at >= $2::date) ORDER BY submitted_at ASC`,
    [clientSlug, since],
  );
  const byEmail = new Map<string, WebInquiryHit>(), byPhone = new Map<string, WebInquiryHit>(), byGclid = new Map<string, WebInquiryHit>();
  let count = 0;
  for (const r of rows) {
    const email = (r.email ?? "").trim().toLowerCase();
    if (r.status === "junk" || email.endsWith("@bsllc.biz") || INTERNAL_TEST_EMAILS.has(email)) continue;
    count++;
    const hit: WebInquiryHit = { id: r.id, submittedAt: new Date(r.submitted_at).toISOString().slice(0, 10), gclid: r.gclid?.trim() || null };
    // First submission wins so the match points at the earliest lead we sent.
    if (email && !byEmail.has(email)) byEmail.set(email, hit);
    const p = phone10(r.phone);
    if (p && !byPhone.has(p)) byPhone.set(p, hit);
    if (hit.gclid && !byGclid.has(hit.gclid)) byGclid.set(hit.gclid, hit);
  }
  return { byEmail, byPhone, byGclid, count };
}

export interface MatchResult { method: "email" | "phone" | "gclid"; hit: WebInquiryHit }
/** Email, then phone, then gclid — the same trust order the OCH close-the-loop uses. */
export function matchWebInquiry(idx: WebInquiryIndex, ident: { emails?: (string | null | undefined)[]; phones?: (string | null | undefined)[]; gclid?: string | null }): MatchResult | null {
  for (const e of ident.emails ?? []) { const k = (e ?? "").trim().toLowerCase(); if (k && idx.byEmail.has(k)) return { method: "email", hit: idx.byEmail.get(k)! }; }
  for (const p of ident.phones ?? []) { const k = phone10(p); if (k && idx.byPhone.has(k)) return { method: "phone", hit: idx.byPhone.get(k)! }; }
  const g = ident.gclid?.trim();
  if (g && idx.byGclid.has(g)) return { method: "gclid", hit: idx.byGclid.get(g)! };
  return null;
}

// ── Sample / demo records ──
// Dynamics ships sample data (Fabrikam, Contoso, …) and DPG's org still has
// it. Rows that look like it are kept for the audit trail but never counted.
const SAMPLE_WORDS = [
  "fabrikam", "contoso", "litware", "adventure works", "alpine ski", "coho winery", "fourth coffee", "blue yonder", "city power",
  "northwind", "trey research", "a. datum", "adatum", "humongous insurance", "lucerne publishing", "margie's travel", "proseware",
  "school of fine art", "southridge video", "tailspin", "wide world importers", "wingtip", "woodgrove", "relecloud", "bellows college",
  "best for you organics", "munson", "sample", "test lead", "test opportunity", "example.com",
];
export function looksLikeSample(...fields: (string | null | undefined)[]): boolean {
  const text = fields.filter(Boolean).join(" ").toLowerCase();
  return SAMPLE_WORDS.some((w) => text.includes(w));
}

// ── HubSpot original-source buckets ──
// Channels BS LLC runs for the client. Everything else is a real source but
// not ours; OFFLINE is a rep-created record; blank is unknown (and then a
// match to our web lead IS the source).
const HS_OURS = new Set(["PAID_SEARCH", "ORGANIC_SEARCH"]);
const HS_MANUAL = new Set(["OFFLINE"]);
export function hubspotBucket(source: string | null | undefined): Bucket {
  const s = (source ?? "").trim().toUpperCase();
  if (!s) return "unknown";
  if (HS_OURS.has(s)) return "bsllc";
  if (HS_MANUAL.has(s)) return "manual";
  return "other";
}
/** The rule as the dashboard applies it: the CRM's own source wins; where it
 *  has none, a match to our web lead is the source. */
export function isAttributed(bucket: Bucket, matched: boolean, isSample: boolean): boolean {
  if (isSample) return false;
  return bucket === "bsllc" || (bucket === "unknown" && matched);
}

// ── HubSpot: deals with their contacts (shared by the two HubSpot jobs) ──
const HS = "https://api.hubapi.com";
export interface HSObj { id: string; properties: Record<string, string | null>; associations?: { contacts?: { results?: Array<{ id: string }> } } }
async function hsGet(token: string, path: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HS}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429 && attempt < 6) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
    if (!res.ok) { const body = await res.text().catch(() => ""); const err = new Error(`HubSpot GET ${path} → ${res.status}: ${body.slice(0, 300)}`); (err as any).status = res.status; throw err; }
    return res.json();
  }
}
async function hsPost(token: string, path: string, body: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HS}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 429 && attempt < 6) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`HubSpot POST ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
}
export async function hsFetchAll(token: string, object: string, properties: string[], associations?: string): Promise<HSObj[]> {
  const out: HSObj[] = [];
  let after: string | undefined;
  do {
    const qp = new URLSearchParams({ limit: "100" });
    properties.forEach((p) => qp.append("properties", p));
    if (associations) qp.set("associations", associations);
    if (after) qp.set("after", after);
    const data = await hsGet(token, `/crm/v3/objects/${object}?${qp.toString()}`);
    out.push(...((data.results ?? []) as HSObj[]));
    after = data.paging?.next?.after;
  } while (after);
  return out;
}
export const HS_DEAL_PROPS = ["dealname", "amount", "closedate", "createdate", "hs_is_closed_won", "hs_is_closed", "dealstage", "hs_analytics_source", "hs_analytics_source_data_1", "hs_analytics_source_data_2"];
export const HS_CONTACT_PROPS = ["email", "phone", "mobilephone", "firstname", "lastname", "createdate", "hs_analytics_source", "hs_google_click_id"];

/** Every deal with its associated contacts resolved (batch-read, 100 at a time). */
export async function fetchHubspotDealsWithContacts(token: string): Promise<{ deals: HSObj[]; contactsById: Map<string, HSObj> }> {
  const deals = await hsFetchAll(token, "deals", HS_DEAL_PROPS, "contacts");
  const ids = Array.from(new Set(deals.flatMap((d) => (d.associations?.contacts?.results ?? []).map((r) => r.id))));
  const contactsById = new Map<string, HSObj>();
  for (let i = 0; i < ids.length; i += 100) {
    const r = await hsPost(token, "/crm/v3/objects/contacts/batch/read", { properties: HS_CONTACT_PROPS, inputs: ids.slice(i, i + 100).map((id) => ({ id })) });
    for (const ct of (r.results ?? []) as HSObj[]) contactsById.set(ct.id, ct);
  }
  return { deals, contactsById };
}
export function hubspotDealStage(d: HSObj): Stage {
  if (d.properties.hs_is_closed_won === "true") return "won";
  if (d.properties.hs_is_closed === "true") return "lost";
  return "open";
}
/** The deal's own original source, else its first contact's. */
export function hubspotDealSource(d: HSObj, contactsById: Map<string, HSObj>): { value: string | null; contact: HSObj | null } {
  const contact = (d.associations?.contacts?.results ?? []).map((r) => contactsById.get(r.id)).find(Boolean) ?? null;
  const own = d.properties.hs_analytics_source?.trim() || null;
  const fromContact = contact?.properties.hs_analytics_source?.trim() || null;
  return { value: own ?? fromContact, contact };
}

/** A client's HubSpot private-app token from client_integration_tokens,
 *  seeded once from HUBSPOT_TOKEN_<CLIENT_SLUG_UPPER_SNAKE> (see import-hubspot-metrics). */
export async function resolveHubspotToken(pgc: pg.Client, clientId: string, clientName: string): Promise<string | null> {
  const { rows } = await pgc.query<{ data: string }>(`SELECT data FROM client_integration_tokens WHERE client_id = $1 AND provider = 'hubspot'`, [clientId]);
  if (rows[0]) { try { const parsed = JSON.parse(rows[0].data); if (parsed.token && String(parsed.token).trim()) return String(parsed.token).trim(); } catch { /* seed below */ } }
  const envName = `HUBSPOT_TOKEN_${clientName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
  const fromEnv = process.env[envName]?.trim();
  if (!fromEnv) return null;
  await pgc.query(
    `INSERT INTO client_integration_tokens (client_id, provider, data, updated_at) VALUES ($1, 'hubspot', $2, now())
     ON CONFLICT (client_id, provider) DO UPDATE SET data = $2, updated_at = now()`,
    [clientId, JSON.stringify({ token: fromEnv })],
  );
  return fromEnv;
}

// ── lead_attributions writes ──
/** Same idempotent DDL as the dashboard's ensureSchema v141, so the job can
 *  run before the deployed app has cold-started and applied it itself. */
export async function ensureLeadAttributionsTable(c: pg.Client): Promise<void> {
  await c.query(`CREATE TABLE IF NOT EXISTS lead_attributions (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), client_slug TEXT NOT NULL, crm TEXT NOT NULL,
    record_type TEXT NOT NULL, record_id TEXT NOT NULL, record_name TEXT, record_created_on TEXT, source_value TEXT,
    bucket TEXT NOT NULL DEFAULT 'unknown', match_method TEXT, web_inquiry_id TEXT, web_inquiry_at TEXT, gclid TEXT,
    stage TEXT NOT NULL DEFAULT 'open', won_on TEXT, value_cents INTEGER, is_sample BOOLEAN NOT NULL DEFAULT false,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_attributions_record ON lead_attributions (client_id, crm, record_type, record_id)`);
  await c.query(`CREATE INDEX IF NOT EXISTS idx_lead_attributions_client ON lead_attributions (client_id, stage)`);
}

/** Upsert every row for one (client, crm) and drop rows for records the CRM
 *  no longer has (deleted sample data disappears here the next morning). */
export async function writeAttributions(c: pg.Client, clientId: string, crm: "d365" | "hubspot", rows: AttributionRow[]): Promise<{ upserted: number; removed: number }> {
  let upserted = 0;
  for (const r of rows) {
    await c.query(
      `INSERT INTO lead_attributions (id, client_id, client_slug, crm, record_type, record_id, record_name, record_created_on, source_value, bucket,
         match_method, web_inquiry_id, web_inquiry_at, gclid, stage, won_on, value_cents, is_sample, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
       ON CONFLICT (client_id, crm, record_type, record_id) DO UPDATE SET
         record_name = EXCLUDED.record_name, record_created_on = EXCLUDED.record_created_on, source_value = EXCLUDED.source_value,
         bucket = EXCLUDED.bucket, match_method = EXCLUDED.match_method, web_inquiry_id = EXCLUDED.web_inquiry_id,
         web_inquiry_at = EXCLUDED.web_inquiry_at, gclid = EXCLUDED.gclid, stage = EXCLUDED.stage, won_on = EXCLUDED.won_on,
         value_cents = EXCLUDED.value_cents, is_sample = EXCLUDED.is_sample, synced_at = now()`,
      [randomUUID(), r.clientId, r.clientSlug, r.crm, r.recordType, r.recordId, r.recordName, r.recordCreatedOn, r.sourceValue, r.bucket,
        r.matchMethod, r.webInquiryId, r.webInquiryAt, r.gclid, r.stage, r.wonOn, r.valueCents, r.isSample],
    );
    upserted++;
  }
  const keep = rows.map((r) => `${r.recordType}:${r.recordId}`);
  const del = await c.query(
    `DELETE FROM lead_attributions WHERE client_id = $1 AND crm = $2 AND NOT (record_type || ':' || record_id = ANY($3::text[]))`,
    [clientId, crm, keep],
  );
  return { upserted, removed: del.rowCount ?? 0 };
}

export const ymd = (s: string | null | undefined): string | null => (s ? String(s).slice(0, 10) : null);

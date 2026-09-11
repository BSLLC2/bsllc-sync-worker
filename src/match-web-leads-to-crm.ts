#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { loadD365Config, getToken, classify, FTS, BILLABLE_CLOSED_WON_SINCE, type D365Config } from "./d365.js";
import {
  type AttributionRow, type Bucket, type Stage, loadWebInquiryIndex, matchWebInquiry, looksLikeSample, hubspotBucket, isAttributed,
  fetchHubspotDealsWithContacts, hsFetchAll, HS_CONTACT_PROPS, hubspotDealStage, hubspotDealSource, resolveHubspotToken,
  ensureLeadAttributionsTable, writeAttributions, ymd,
} from "./attribution.js";

/**
 * Daily: tie the leads WE captured (web_inquiries) to the client's CRM, and
 * record every CRM lead / opportunity / deal that traces to BS LLC — either
 * because the CRM's own source field says so, or because the record's email /
 * phone / gclid matches one of our web inquiries (where the CRM has no
 * source, that match IS the source). One row per CRM record lands in the
 * dashboard's lead_attributions table so a case study can list the deals
 * behind its number ("leads we sent → deals → won revenue").
 *
 * Clients: every client with an ENABLED d365 or hubspot connector. D365 is
 * one org (DPG) behind the DYNAMICS_* env; HubSpot is per-client via
 * client_integration_tokens. Sample / demo records are stored flagged and
 * never counted. Idempotent: upserts on (client, crm, record type, id) and
 * removes rows for records the CRM no longer has.
 *
 *   npm run match-web-leads-to-crm -- [--client=diesel-power-group] [--dry-run]
 */
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const onlySlug = (argv.find((a) => a.startsWith("--client="))?.slice("--client=".length) ?? "").trim();
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const usd = (cents: number) => "$" + Math.round(cents / 100).toLocaleString("en-US");

interface ClientRow { id: string; name: string; contract_start: string | null; sources: string[] }

// ── D365 ──
const FTS_LABEL = new Map<number, string>(Object.entries(FTS).map(([k, v]) => [v, k.toLowerCase().replace(/_/g, " ")]));
const LEAD_SOURCE_OURS = /\b(web|website|online|form|paid|search|google|organic|ppc|ads?|social|email campaign|call|gbp|business profile)\b/i;

async function odata(cfg: D365Config, url: string): Promise<any[]> {
  const out: any[] = [];
  let next: string | undefined = url;
  while (next) {
    const token = await getToken(cfg);
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0", Prefer: "odata.maxpagesize=500" } });
    if (!res.ok) throw new Error(`D365 query failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as { value?: any[]; ["@odata.nextLink"]?: string };
    out.push(...(j.value ?? []));
    next = j["@odata.nextLink"];
  }
  return out;
}
async function leadSourceLabels(cfg: D365Config): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const token = await getToken(cfg);
    const res = await fetch(
      `${cfg.resourceUrl}/api/data/v9.2/EntityDefinitions(LogicalName='lead')/Attributes(LogicalName='leadsourcecode')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    );
    if (!res.ok) return map;
    const j = (await res.json()) as { OptionSet?: { Options?: Array<{ Value: number; Label?: { UserLocalizedLabel?: { Label?: string } } }> } };
    for (const o of j.OptionSet?.Options ?? []) map.set(o.Value, o.Label?.UserLocalizedLabel?.Label ?? String(o.Value));
  } catch { /* labels are cosmetic; the numeric value is still stored */ }
  return map;
}
const d365Stage = (statecode: number | null, kind: "lead" | "opportunity"): Stage =>
  kind === "lead" ? (statecode === 1 ? "qualified" : statecode === 2 ? "disqualified" : "open") : statecode === 1 ? "won" : statecode === 2 ? "lost" : "open";

async function d365Rows(cfg: D365Config, client: ClientRow, idx: Awaited<ReturnType<typeof loadWebInquiryIndex>>, since: string): Promise<AttributionRow[]> {
  const base = `${cfg.resourceUrl}/api/data/v9.2`;
  const labels = await leadSourceLabels(cfg);
  const leads = await odata(cfg,
    `${base}/leads?$select=leadid,fullname,companyname,emailaddress1,telephone1,mobilephone,leadsourcecode,createdon,statecode,_qualifyingopportunityid_value` +
    `&$filter=${encodeURIComponent(`createdon ge ${since}T00:00:00Z`)}`);
  const opps = await odata(cfg,
    `${base}/opportunities?$select=opportunityid,name,statecode,estimatedvalue,actualvalue,actualclosedate,createdon,_originatingleadid_value` +
    `&$expand=parentcontactid($select=contactid,fullname,emailaddress1,telephone1,mobilephone,createdon,new_firsttouchsource)` +
    `&$filter=${encodeURIComponent(`(createdon ge ${since}T00:00:00Z) or (statecode eq 1 and actualclosedate ge ${BILLABLE_CLOSED_WON_SINCE}T00:00:00Z)`)}`);
  console.log(`  D365: ${leads.length} lead(s) since ${since}, ${opps.length} opportunit${opps.length === 1 ? "y" : "ies"} (created since ${since}, or won since ${BILLABLE_CLOSED_WON_SINCE})`);

  const rows: AttributionRow[] = [];
  const leadMatch = new Map<string, ReturnType<typeof matchWebInquiry>>();
  for (const l of leads) {
    const m = matchWebInquiry(idx, { emails: [l.emailaddress1], phones: [l.telephone1, l.mobilephone] });
    leadMatch.set(l.leadid, m);
    const code: number | null = l.leadsourcecode ?? null;
    const label = code != null ? (labels.get(code) ?? String(code)) : null;
    const bucket: Bucket = code == null ? "unknown" : LEAD_SOURCE_OURS.test(label ?? "") ? "bsllc" : "other";
    rows.push({
      clientId: client.id, clientSlug: slugify(client.name), crm: "d365", recordType: "lead", recordId: l.leadid,
      recordName: [l.fullname, l.companyname].filter(Boolean).join(" — ") || null, recordCreatedOn: ymd(l.createdon),
      sourceValue: code != null ? `leadsourcecode=${code} ${label}` : null, bucket,
      matchMethod: m?.method ?? null, webInquiryId: m?.hit.id ?? null, webInquiryAt: m?.hit.submittedAt ?? null, gclid: m?.hit.gclid ?? null,
      stage: d365Stage(l.statecode, "lead"), wonOn: null, valueCents: null,
      isSample: looksLikeSample(l.fullname, l.companyname, l.emailaddress1),
    });
  }
  for (const o of opps) {
    const ct = o.parentcontactid ?? null;
    const viaLead = o._originatingleadid_value ? leadMatch.get(o._originatingleadid_value) ?? null : null;
    const m = viaLead ?? matchWebInquiry(idx, { emails: [ct?.emailaddress1], phones: [ct?.telephone1, ct?.mobilephone] });
    const fts: number | null = ct?.new_firsttouchsource ?? null;
    const bucket = classify(fts, ct?.createdon ?? null);
    const stage = d365Stage(o.statecode, "opportunity");
    const value = stage === "won" ? o.actualvalue : o.estimatedvalue;
    rows.push({
      clientId: client.id, clientSlug: slugify(client.name), crm: "d365", recordType: "opportunity", recordId: o.opportunityid,
      recordName: [ct?.fullname, o.name].filter(Boolean).join(" — ") || null, recordCreatedOn: ymd(o.createdon),
      sourceValue: fts != null ? `first touch = ${FTS_LABEL.get(fts) ?? fts} (${fts})` : ct ? (bucket === "unknown" ? "first touch blank (contact predates the field)" : "first touch blank") : "no contact on the opportunity",
      bucket, matchMethod: m?.method ?? null, webInquiryId: m?.hit.id ?? null, webInquiryAt: m?.hit.submittedAt ?? null, gclid: m?.hit.gclid ?? null,
      stage, wonOn: stage === "won" ? ymd(o.actualclosedate) : null, valueCents: value != null ? Math.round(Number(value) * 100) : null,
      isSample: looksLikeSample(o.name, ct?.fullname, ct?.emailaddress1),
    });
  }
  return rows;
}

// ── HubSpot ──
async function hubspotRows(token: string, client: ClientRow, idx: Awaited<ReturnType<typeof loadWebInquiryIndex>>, since: string): Promise<AttributionRow[]> {
  const { deals, contactsById } = await fetchHubspotDealsWithContacts(token);
  const contacts = await hsFetchAll(token, "contacts", HS_CONTACT_PROPS);
  console.log(`  HubSpot: ${deals.length} deal(s), ${contacts.length} contact(s)`);
  const rows: AttributionRow[] = [];
  const slug = slugify(client.name);
  for (const d of deals) {
    const p = d.properties;
    const created = ymd(p.createdate);
    const stage = hubspotDealStage(d);
    const closed = ymd(p.closedate);
    if (created && created < since && !(stage === "won" && closed && closed >= since)) continue;
    const { value: source, contact } = hubspotDealSource(d, contactsById);
    const m = matchWebInquiry(idx, { emails: [contact?.properties.email], phones: [contact?.properties.phone, contact?.properties.mobilephone], gclid: contact?.properties.hs_google_click_id });
    const amount = Number(p.amount ?? 0);
    const name = [contact ? [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(" ") : "", p.dealname].filter(Boolean).join(" — ");
    rows.push({
      clientId: client.id, clientSlug: slug, crm: "hubspot", recordType: "deal", recordId: d.id, recordName: name || null, recordCreatedOn: created,
      sourceValue: source ? `original source = ${source}${p.hs_analytics_source_data_1 ? ` / ${p.hs_analytics_source_data_1}` : ""}` : null, bucket: hubspotBucket(source),
      matchMethod: m?.method ?? null, webInquiryId: m?.hit.id ?? null, webInquiryAt: m?.hit.submittedAt ?? null, gclid: contact?.properties.hs_google_click_id?.trim() || m?.hit.gclid || null,
      stage, wonOn: stage === "won" ? closed : null, valueCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
      isSample: looksLikeSample(p.dealname, contact?.properties.email),
    });
  }
  // Contacts are HubSpot's leads; keep only the ones that are OUR web leads so
  // the count "of our web leads found in the client's CRM" is real.
  for (const ct of contacts) {
    const p = ct.properties;
    const m = matchWebInquiry(idx, { emails: [p.email], phones: [p.phone, p.mobilephone], gclid: p.hs_google_click_id });
    if (!m) continue;
    const source = p.hs_analytics_source?.trim() || null;
    rows.push({
      clientId: client.id, clientSlug: slug, crm: "hubspot", recordType: "lead", recordId: ct.id,
      recordName: [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || null, recordCreatedOn: ymd(p.createdate),
      sourceValue: source ? `original source = ${source}` : null, bucket: hubspotBucket(source),
      matchMethod: m.method, webInquiryId: m.hit.id, webInquiryAt: m.hit.submittedAt, gclid: p.hs_google_click_id?.trim() || m.hit.gclid || null,
      stage: "open", wonOn: null, valueCents: null, isSample: looksLikeSample(p.email, p.lastname),
    });
  }
  return rows;
}

function summarize(rows: AttributionRow[], webCount: number, crm: "d365" | "hubspot"): string {
  const floor = crm === "d365" ? BILLABLE_CLOSED_WON_SINCE : null;
  const attributed = (r: AttributionRow) => isAttributed(r.bucket, !!r.webInquiryId, r.isSample);
  const won = rows.filter((r) => r.stage === "won" && attributed(r) && (!floor || !r.wonOn || r.wonOn >= floor));
  const pipeline = rows.filter((r) => r.recordType !== "lead" && (r.stage === "open" || r.stage === "qualified") && attributed(r));
  const matched = new Set(rows.filter((r) => r.webInquiryId && !r.isSample).map((r) => r.webInquiryId)).size;
  const leadsOurs = rows.filter((r) => r.recordType === "lead" && attributed(r)).length;
  const unsourced = rows.filter((r) => r.stage === "won" && !r.isSample && r.bucket === "unknown" && !r.webInquiryId).length;
  const conflicts = rows.filter((r) => !r.isSample && r.webInquiryId && (r.bucket === "other" || r.bucket === "manual")).length;
  const samples = rows.filter((r) => r.isSample).length;
  const sum = (xs: AttributionRow[]) => xs.reduce((s, r) => s + (r.valueCents ?? 0), 0);
  return [
    `web inquiries in window: ${webCount} · found in CRM: ${matched} · CRM leads attributed to us: ${leadsOurs}`,
    `won attributed${floor ? ` (closed ≥ ${floor})` : ""}: ${won.length} deal(s) ${usd(sum(won))} · open attributed pipeline: ${pipeline.length} ${usd(sum(pipeline))}`,
    `won with no source and no match: ${unsourced} · matched but CRM says other/manual: ${conflicts} · sample records: ${samples}`,
  ].join("\n    ");
}

async function main() {
  const c = new pg.Client({ connectionString: (process.env.DATABASE_URL || "").trim() });
  await c.connect();
  let failures = 0;
  try {
    const { rows: clients } = await c.query<ClientRow>(
      `SELECT c.id, c.name, c.contract_start, array_agg(cm.source) AS sources FROM clients c
         JOIN connector_mappings cm ON cm.client_id = c.id AND cm.enabled AND cm.source IN ('d365', 'hubspot')
        WHERE c.status IN ('launch', 'active') GROUP BY c.id, c.name, c.contract_start ORDER BY c.name`);
    const targets = clients.filter((cl) => !onlySlug || slugify(cl.name) === onlySlug);
    console.log(`match-web-leads-to-crm — ${targets.length} client(s) with a CRM connector${dryRun ? " (dry-run, nothing written)" : ""}`);
    if (!dryRun) await ensureLeadAttributionsTable(c);
    let d365cfg: D365Config | null = null;
    try { d365cfg = loadD365Config(); } catch { d365cfg = null; }

    for (const cl of targets) {
      const slug = slugify(cl.name);
      const since = cl.contract_start && /^\d{4}-\d{2}-\d{2}/.test(cl.contract_start) ? cl.contract_start.slice(0, 10) : "2026-08-01";
      const idx = await loadWebInquiryIndex(c, slug, since);
      console.log(`\n${cl.name} (${slug}) — window from ${since}; ${idx.count} web inquiries we captured`);
      for (const crm of cl.sources as ("d365" | "hubspot")[]) {
        try {
          let rows: AttributionRow[];
          if (crm === "d365") {
            if (!d365cfg) { console.error("  D365 connector enabled but DYNAMICS_* env is not set — skipped."); failures++; continue; }
            rows = await d365Rows(d365cfg, cl, idx, since);
          } else {
            const token = await resolveHubspotToken(c, cl.id, cl.name);
            if (!token) { console.error(`  HubSpot connector enabled but no token on file (HUBSPOT_TOKEN_${cl.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}) — skipped.`); failures++; continue; }
            rows = await hubspotRows(token, cl, idx, since);
          }
          console.log(`  ${crm}: ${rows.length} row(s)\n    ${summarize(rows, idx.count, crm)}`);
          if (dryRun) {
            for (const r of rows.filter((x) => x.stage === "won" || x.webInquiryId).slice(0, 25)) {
              console.log(`    · ${r.recordType} ${r.stage.padEnd(12)} ${(r.recordName ?? "(unnamed)").slice(0, 40).padEnd(40)} ${r.valueCents != null ? usd(r.valueCents).padStart(10) : "".padStart(10)}  ${r.sourceValue ?? "no source"}${r.webInquiryId ? ` · matched by ${r.matchMethod} (${r.webInquiryAt})` : ""}${r.isSample ? " · SAMPLE" : ""}`);
            }
            continue;
          }
          const w = await writeAttributions(c, cl.id, crm, rows);
          console.log(`  ${crm}: ${w.upserted} upserted, ${w.removed} removed (no longer in CRM)`);
        } catch (e) {
          failures++;
          console.error(`  ${crm}: FAILED — ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  } finally { await c.end(); }
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import pg from "pg";

/**
 * Read-only dump of a GA4 property's CONFIGURATION via the Admin API.
 *
 * The Data API answers "how many key events were there". It cannot answer "what
 * is a key event here" -- which events are marked as such, whether a flat
 * default value is stamped on them, how attribution is modelled, or which other
 * properties exist. Those live in the Admin API, and they are what has to change
 * to make the reporting mean what people think it means.
 *
 *   npm run dump-ga4-config -- --client=Tablespoon
 */

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const arg = (n: string) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const propertyId = (raw: string) => raw.trim().replace(/^properties\//i, "").trim();

async function token(): Promise<{ tok: string; email: string }> {
  const sa = JSON.parse(env("GOOGLE_SERVICE_ACCOUNT_JSON"));
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SCOPE] });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Failed to mint a GA4 Admin access token.");
  return { tok: token, email: String(sa.client_email ?? "?") };
}

/**
 * Never assert a cause on 403 without reading the body. The Admin API returns it
 * both for "not a user on this property" and for "the API is switched off on the
 * Cloud project", and those are fixed in different consoles.
 */
async function get(tok: string, path: string): Promise<any> {
  const res = await fetch(`${ADMIN}/${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 403 && /has not been used in project|is disabled/i.test(body)) {
      throw new Error(`GA4 ADMIN API IS DISABLED on the Cloud project — not a property permission.\n${body.slice(0, 300)}`);
    }
    const e = new Error(`GA4 Admin ${res.status} on ${path}: ${body.slice(0, 300)}`);
    (e as any).status = res.status; throw e;
  }
  return JSON.parse(body || "{}");
}
/** Optional sections must not sink the whole run — report and continue. */
async function tryGet(tok: string, path: string, label: string): Promise<any | null> {
  try { return await get(tok, path); }
  catch (e) { console.log(`\n-- ${label}: unavailable (${(e as Error).message.slice(0, 160)})`); return null; }
}

async function main() {
  const clientName = arg("client");
  if (!clientName) throw new Error(`Pass --client="<client name>".`);

  const pgc = new pg.Client({ connectionString: env("DATABASE_URL") });
  await pgc.connect();
  let prop = "", name = "";
  try {
    const { rows } = await pgc.query<{ name: string; external_id: string }>(
      `SELECT c.name, cm.external_id FROM clients c
         JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source='ga4' AND cm.enabled = true
        WHERE lower(trim(c.name)) LIKE lower(trim($1)) || '%'
          AND cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''`, [clientName]);
    if (!rows.length) throw new Error(`No enabled GA4 connector for a client starting "${clientName}".`);
    prop = propertyId(rows[0]!.external_id); name = rows[0]!.name;
  } finally { await pgc.end(); }

  const { tok, email } = await token();
  console.log(`\n${name} — GA4 property ${prop} — CONFIGURATION (read only)\n${"=".repeat(78)}`);
  console.log(`  service account: ${email}`);

  // Every property this account can see -- settles "is there a second property".
  const summaries = await tryGet(tok, `accountSummaries?pageSize=200`, "Account summaries");
  if (summaries) {
    console.log(`\n-- Properties visible to this service account --`);
    for (const a of summaries.accountSummaries ?? []) {
      console.log(`  account: ${a.displayName}  [${a.account}]`);
      for (const p of a.propertySummaries ?? [])
        console.log(`     ${p.displayName.padEnd(46)} ${p.property}${p.property?.endsWith(prop) ? "   <-- mapped in the dashboard" : ""}`);
    }
  }

  // THE question: which events count, and does a flat value ride along?
  const ke = await tryGet(tok, `properties/${prop}/keyEvents?pageSize=200`, "Key events");
  if (ke) {
    const list = ke.keyEvents ?? [];
    console.log(`\n-- Key events (${list.length}) --`);
    for (const k of list) {
      const v = k.defaultValue;
      console.log(`\n  ${k.eventName}${k.custom === false ? "  (built-in)" : ""}`);
      console.log(`     counting: ${k.countingMethod ?? "?"}   deletable: ${k.deletable ?? "?"}`);
      console.log(`     default value: ${v ? `${v.numericValue} ${v.currencyCode ?? ""}  <-- FLAT VALUE STAMPED ON EVERY OCCURRENCE` : "none (correct for a lead event)"}`);
    }
    if (!list.length) console.log(`  (none configured)`);
  }

  // Attribution shapes the Direct-vs-organic split more than most people expect.
  const attr = await tryGet(tok, `properties/${prop}/attributionSettings`, "Attribution settings");
  if (attr) {
    console.log(`\n-- Attribution --`);
    console.log(`  reporting model:        ${attr.reportingAttributionModel ?? "?"}`);
    console.log(`  acquisition lookback:   ${attr.acquisitionConversionEventLookbackWindow ?? "?"}`);
    console.log(`  other-event lookback:   ${attr.otherConversionEventLookbackWindow ?? "?"}`);
  }

  const streams = await tryGet(tok, `properties/${prop}/dataStreams?pageSize=50`, "Data streams");
  if (streams) {
    console.log(`\n-- Data streams --`);
    for (const s of streams.dataStreams ?? []) {
      const w = s.webStreamData ?? {};
      console.log(`  ${s.displayName}  [${s.name?.split("/").pop()}]  ${w.defaultUri ?? ""}  measurementId=${w.measurementId ?? "-"}`);
    }
  }

  const links = await tryGet(tok, `properties/${prop}/googleAdsLinks`, "Google Ads links");
  if (links) {
    console.log(`\n-- Google Ads links --`);
    for (const l of links.googleAdsLinks ?? [])
      console.log(`  customer ${l.customerId}  personalizedAdsEnabled=${l.adsPersonalizationEnabled}`);
    if (!(links.googleAdsLinks ?? []).length) console.log(`  (none)`);
  }

  const dims = await tryGet(tok, `properties/${prop}/customDimensions?pageSize=100`, "Custom dimensions");
  if (dims) {
    console.log(`\n-- Custom dimensions (${(dims.customDimensions ?? []).length}) --`);
    for (const d of dims.customDimensions ?? []) console.log(`  ${d.parameterName} -> ${d.displayName} (${d.scope})`);
  }
  console.log("");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

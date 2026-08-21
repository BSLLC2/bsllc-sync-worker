#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import pg from "pg";

/**
 * Read-only GA4 revenue breakdown for one client: by channel, by landing page
 * within organic, and by event.
 *
 * import-ga4 stores sessions and keyEvents dimensioned only by month. That
 * answers "did conversions go up" but cannot answer "which channel earned the
 * money" or "which page earned it", because revenue is never requested and no
 * channel or page dimension is ever asked for. This pulls all three.
 *
 * The landing-page report is the point. GA4 cannot see the search query behind
 * an organic session -- Google strips it -- so GA4 alone can never split
 * branded from non-branded revenue. But Search Console reports clicks per page
 * and GA4 reports revenue per landing page, so joining the two on the page URL
 * recovers the split indirectly: if the money lands on the pages that
 * non-branded queries enter through, non-branded is earning it.
 *
 *   npm run dump-ga4-revenue -- --client=Tablespoon --days=90
 */

const API = "https://analyticsdata.googleapis.com/v1beta";
const iso = (d: Date) => d.toISOString().slice(0, 10);
const arg = (n: string) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const num = (v: unknown) => Number(v ?? 0);

/**
 * GA4 property ids get pasted in both forms -- the bare number GA4's admin UI
 * shows, and the "properties/123" resource name the API docs use. The request
 * path already supplies the "properties/" prefix, so the second form silently
 * builds .../properties/properties/123 and Google answers with an HTML 404 that
 * looks nothing like an API error. Normalise instead of trusting the input.
 */
const propertyId = (raw: string) => raw.trim().replace(/^properties\//i, "").trim();
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");

async function token(): Promise<string> {
  const sa = JSON.parse(env("GOOGLE_SERVICE_ACCOUNT_JSON"));
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/analytics.readonly"] });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Failed to mint a GA4 access token.");
  return token;
}

interface Report { rows: { dims: string[]; mets: number[] }[] }

/**
 * GA4 rejects the whole request with a 400 if any single metric is invalid for
 * the property, so an unsupported metric has to be dropped and retried rather
 * than tolerated. keyEvents/conversions is the usual culprit (GA4 renamed it
 * and older properties still answer to the old name).
 */
async function report(tok: string, prop: string, body: Record<string, unknown>, metrics: string[]): Promise<Report> {
  const attempt = async (mets: string[]) => {
    const res = await fetch(`${API}/properties/${prop}:runReport`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, metrics: mets.map((name) => ({ name })) }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const e = new Error(`GA4 ${res.status}: ${t.slice(0, 400)}`); (e as any).status = res.status; throw e;
    }
    const j: any = await res.json();
    return {
      rows: (j.rows ?? []).map((r: any) => ({
        dims: (r.dimensionValues ?? []).map((d: any) => String(d.value ?? "")),
        mets: (r.metricValues ?? []).map((m: any) => num(m.value)),
      })),
    };
  };
  try { return await attempt(metrics); } catch (e) {
    if ((e as any).status !== 400 || !metrics.includes("keyEvents")) throw e;
    return attempt(metrics.map((m) => (m === "keyEvents" ? "conversions" : m)));
  }
}

async function main() {
  const clientName = arg("client");
  if (!clientName) throw new Error(`Pass --client="<client name>".`);
  const days = Number(arg("days") ?? 90);
  const top = Number(arg("top") ?? 30);

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

  const end = new Date(), start = new Date(Date.now() - days * 86_400_000);
  const range = { dateRanges: [{ startDate: iso(start), endDate: iso(end) }] };
  const tok = await token();
  console.log(`\n${name} — GA4 property ${prop} — last ${days} days (READ ONLY)\n${"═".repeat(78)}`);

  // ── 1. Which channel earns the money ────────────────────────────────────
  const MET = ["sessions", "keyEvents", "purchaseRevenue", "totalRevenue", "transactions"];
  const byChannel = await report(tok, prop, { ...range, dimensions: [{ name: "sessionDefaultChannelGroup" }] }, MET);
  const tot = (i: number) => byChannel.rows.reduce((s, r) => s + (r.mets[i] ?? 0), 0);
  const totalRev = tot(3), totalSess = tot(0);

  console.log(`\n── Revenue by channel ──`);
  console.log(`  ${"channel".padEnd(24)} ${"sessions".padStart(9)} ${"keyEvents".padStart(10)} ${"purchaseRev".padStart(13)} ${"totalRev".padStart(13)} ${"txns".padStart(6)}  share`);
  for (const r of byChannel.rows.sort((a, b) => (b.mets[3] ?? 0) - (a.mets[3] ?? 0))) {
    console.log(`  ${(r.dims[0] || "(none)").padEnd(24)} ${String(r.mets[0]).padStart(9)} ${String(r.mets[1]).padStart(10)} ` +
      `${usd(r.mets[2] ?? 0).padStart(13)} ${usd(r.mets[3] ?? 0).padStart(13)} ${String(r.mets[4] ?? 0).padStart(6)}  ${pct(r.mets[3] ?? 0, totalRev)}`);
  }
  console.log(`  ${"TOTAL".padEnd(24)} ${String(totalSess).padStart(9)} ${String(tot(1)).padStart(10)} ${usd(tot(2)).padStart(13)} ${usd(totalRev).padStart(13)} ${String(tot(4)).padStart(6)}`);

  // ── 2. Organic revenue by landing page — the join back to Search Console ─
  const organicOnly = {
    dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search", matchType: "EXACT" } } },
  };
  const byPage = await report(tok, prop, {
    ...range, ...organicOnly,
    dimensions: [{ name: "landingPagePlusQueryString" }],
    orderBys: [{ metric: { metricName: "totalRevenue" }, desc: true }],
    limit: 200,
  }, MET);
  const pageRev = byPage.rows.reduce((s, r) => s + (r.mets[3] ?? 0), 0);
  const pageSess = byPage.rows.reduce((s, r) => s + (r.mets[0] ?? 0), 0);

  console.log(`\n── ORGANIC revenue by landing page (${pageSess} sessions · ${usd(pageRev)}) ──`);
  console.log(`  ${"landing page".padEnd(52)} ${"sess".padStart(6)} ${"keyEv".padStart(7)} ${"totalRev".padStart(12)}  share`);
  for (const r of byPage.rows.slice(0, top)) {
    console.log(`  ${(r.dims[0] || "(not set)").slice(0, 52).padEnd(52)} ${String(r.mets[0]).padStart(6)} ${String(r.mets[1]).padStart(7)} ` +
      `${usd(r.mets[3] ?? 0).padStart(12)}  ${pct(r.mets[3] ?? 0, pageRev)}`);
  }

  // ── 3. Which events actually carry money ────────────────────────────────
  const byEvent = await report(tok, prop, {
    ...range, dimensions: [{ name: "eventName" }],
    orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 60,
  }, ["eventCount", "eventValue", "totalRevenue"]);

  console.log(`\n── Events (which ones represent revenue) ──`);
  console.log(`  ${"event".padEnd(38)} ${"count".padStart(9)} ${"eventValue".padStart(13)} ${"totalRev".padStart(13)}`);
  for (const r of byEvent.rows.slice(0, 40)) {
    console.log(`  ${(r.dims[0] || "?").slice(0, 38).padEnd(38)} ${String(r.mets[0]).padStart(9)} ${usd(r.mets[1] ?? 0).padStart(13)} ${usd(r.mets[2] ?? 0).padStart(13)}`);
  }
  console.log("");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

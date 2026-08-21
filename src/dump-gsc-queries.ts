#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";
import pg from "pg";

/**
 * Read-only Search Console query and page breakdown for one client, split into
 * branded and non-branded.
 *
 * import-gsc-api stores only aggregate totals (clicks, impressions, CTR,
 * position), which answers "is organic working" but not "is organic bringing us
 * anyone new". That second question is the one clients actually ask, and it can
 * only be answered per query. This pulls the query dimension directly and
 * classifies it.
 *
 * Classification is deliberately three-way rather than two. A brand whose name
 * is also an ordinary word -- Tablespoon, Apple, Shell -- produces queries that
 * merely contain the brand string without being brand searches at all
 * ("how many teaspoons in a tablespoon"). Forcing those into branded overstates
 * how much traffic is people who already knew the business. Anything matching a
 * brand term but also an exclusion term is reported separately so a human can
 * judge it instead of a regex.
 *
 *   npm run dump-gsc-queries -- --client="Tablespoon" --brand="tablespoon,tbsp" \
 *     --exclude="how many,how much,teaspoon,conversion,equals,ml,grams" --days=90
 */

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://searchconsole.googleapis.com/webmasters/v3";
const iso = (d: Date) => d.toISOString().slice(0, 10);

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");

interface Row { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }

async function gscToken(): Promise<string> {
  const raw = env("GOOGLE_SERVICE_ACCOUNT_JSON");
  let sa: any;
  try { sa = JSON.parse(raw); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON."); }
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SCOPE] });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Failed to mint a Search Console access token.");
  return token;
}

async function query(token: string, siteUrl: string, body: unknown): Promise<Row[]> {
  const res = await fetch(`${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    if (res.status === 403) throw new Error(`GSC 403 for ${siteUrl} — add the service account as a user in Search Console.`);
    throw new Error(`GSC ${res.status}: ${t.slice(0, 300)}`);
  }
  return ((await res.json()) as any).rows ?? [];
}

async function main() {
  const clientName = arg("client");
  if (!clientName) throw new Error(`Pass --client="<exact client name>".`);
  const days = Number(arg("days") ?? 90);
  const brand = list(arg("brand"));
  const exclude = list(arg("exclude"));
  const top = Number(arg("top") ?? 40);
  if (!brand.length) throw new Error(`Pass --brand="term,term" so branded traffic can be identified.`);

  const pgc = new pg.Client({ connectionString: env("DATABASE_URL") });
  await pgc.connect();
  let siteUrl = "";
  try {
    const { rows } = await pgc.query<{ id: string; name: string; external_id: string }>(
      `SELECT c.id, c.name, cm.external_id
         FROM clients c JOIN connector_mappings cm
           ON cm.client_id = c.id AND cm.source = 'gsc' AND cm.enabled = true
        WHERE lower(trim(c.name)) LIKE lower(trim($1)) || '%'
          AND cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''`, [clientName]);
    if (!rows.length) throw new Error(`No enabled GSC connector for a client starting "${clientName}".`);
    siteUrl = rows[0]!.external_id.trim();
    console.log(`\n${rows[0]!.name} — ${siteUrl} — last ${days} days (READ ONLY)\n${"═".repeat(74)}`);
  } finally { await pgc.end(); }

  const token = await gscToken();
  const end = new Date(Date.now() - 2 * 86_400_000); // GSC finalises ~2 days back
  const start = new Date(end.getTime() - days * 86_400_000);
  const window = { startDate: iso(start), endDate: iso(end), dataState: "final" as const };

  const queries = await query(token, siteUrl, { ...window, dimensions: ["query"], rowLimit: 5000 });
  const pages = await query(token, siteUrl, { ...window, dimensions: ["page"], rowLimit: 500 });

  const totalClicks = queries.reduce((s, r) => s + r.clicks, 0);
  const totalImpr = queries.reduce((s, r) => s + r.impressions, 0);

  const branded: Row[] = [], ambiguous: Row[] = [], nonBranded: Row[] = [];
  for (const r of queries) {
    const q = (r.keys[0] ?? "").toLowerCase();
    const hitsBrand = brand.some((b) => q.includes(b));
    if (!hitsBrand) { nonBranded.push(r); continue; }
    (exclude.some((x) => q.includes(x)) ? ambiguous : branded).push(r);
  }
  const clicks = (rs: Row[]) => rs.reduce((s, r) => s + r.clicks, 0);
  const impr = (rs: Row[]) => rs.reduce((s, r) => s + r.impressions, 0);

  console.log(`\n── Split by clicks (${totalClicks} clicks / ${totalImpr} impressions across ${queries.length} queries) ──`);
  for (const [label, rs] of [["BRANDED", branded], ["AMBIGUOUS (brand word, non-brand intent)", ambiguous], ["NON-BRANDED", nonBranded]] as const) {
    console.log(`  ${label.padEnd(42)} ${String(clicks(rs)).padStart(6)} clicks (${pct(clicks(rs), totalClicks).padStart(6)})  ` +
      `${String(impr(rs)).padStart(7)} impr (${pct(impr(rs), totalImpr)})  ${rs.length} queries`);
  }
  console.log(`\n  Note: GSC reports only queries above its privacy threshold, so these`);
  console.log(`  totals run below the property's true click count. The SPLIT is the number`);
  console.log(`  to trust, not the absolute figures.`);

  for (const [label, rs] of [["BRANDED", branded], ["AMBIGUOUS", ambiguous], ["NON-BRANDED", nonBranded]] as const) {
    console.log(`\n── Top ${label} queries ──`);
    for (const r of rs.sort((a, b) => b.clicks - a.clicks).slice(0, top)) {
      console.log(`  ${String(r.clicks).padStart(5)} clicks · ${String(r.impressions).padStart(6)} impr · pos ${r.position.toFixed(1).padStart(5)} · "${r.keys[0]}"`);
    }
    if (!rs.length) console.log(`  (none)`);
  }

  console.log(`\n── Landing pages by clicks ──`);
  const pageTotal = pages.reduce((s, r) => s + r.clicks, 0);
  for (const r of pages.sort((a, b) => b.clicks - a.clicks).slice(0, 30)) {
    console.log(`  ${String(r.clicks).padStart(5)} clicks (${pct(r.clicks, pageTotal).padStart(6)}) · pos ${r.position.toFixed(1).padStart(5)} · ${r.keys[0]}`);
  }
  console.log("");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

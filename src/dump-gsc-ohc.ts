#!/usr/bin/env tsx
import "dotenv/config";
import { JWT } from "google-auth-library";

/**
 * READ-ONLY Search Console pull for Ohio Community Health.
 *
 * Covers the three of the five requested items the API actually exposes:
 * sitemaps, the six-month query/page breakdown, and the Aug-vs-Jul query delta.
 *
 * The other two -- the "Why pages aren't indexed" table and Crawl stats by
 * response -- have NO API surface at all. The URL Inspection API answers one URL
 * at a time and will not aggregate; Crawl stats is UI-only. They are named in the
 * output rather than silently omitted, so nobody reads this as a complete answer.
 *
 *   npm run dump-gsc-ohc
 */

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://searchconsole.googleapis.com/webmasters/v3";
const SITE = "sc-domain:ohiorecoverycenters.com";

/**
 * End date is deliberately two days back. Search Console's last 48 hours are
 * partial, and including them renders a cliff that is an artefact of collection
 * lag rather than anything that happened to the site.
 */
const END = "2026-08-24";
const SIX_MO_START = "2026-02-25";
const AUG = { from: "2026-08-01", to: "2026-08-16" };
const JUL = { from: "2026-07-01", to: "2026-07-16" };

interface Row { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }

const n0 = (v: unknown) => Number(v ?? 0).toLocaleString("en-US");
const pc = (v: unknown) => `${(Number(v ?? 0) * 100).toFixed(2)}%`;
const p1 = (v: unknown) => Number(v ?? 0).toFixed(1);
const sgn = (n: number) => `${n >= 0 ? "+" : ""}${n}`;
/**
 * Section gating. The full pull is longer than a retrievable log tail, so
 * ONLY=34 prints sitemaps + performance and ONLY=5 prints the delta. Every query
 * still runs; only printing is gated.
 */
const WANT = (() => {
  const raw = String(process.env.ONLY ?? "").replace(/[^1-5]/g, "");
  return raw ? new Set(raw.split("")) : null;
})();
const realLog = console.log.bind(console);
let SEC = "";
console.log = ((...a: unknown[]) => { if (!WANT || SEC === "" || WANT.has(SEC)) realLog(...a); }) as typeof console.log;
const hr = (t: string) => {
  const m = /^\s*([1-5])/.exec(t);
  if (m) SEC = m[1]!;
  console.log(`\n${"=".repeat(100)}\n${t}\n${"=".repeat(100)}`);
};

function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function token(): Promise<{ token: string; email: string }> {
  const raw = env("GOOGLE_SERVICE_ACCOUNT_JSON");
  let sa: any;
  try { sa = JSON.parse(raw); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON."); }
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SCOPE] });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Failed to mint a Search Console access token.");
  return { token, email: String(sa.client_email ?? "?") };
}

/**
 * A 403 means two very different things and they have opposite fixes: the API is
 * off on the Cloud project, or this service account is not on this property.
 * Reading the body is the only way to tell them apart.
 */
function explain403(body: string, what: string): string {
  if (/has not been used in project|is disabled/i.test(body)) {
    return `Search Console API is DISABLED on the Google Cloud project — not a property permission problem. ${body.slice(0, 240)}`;
  }
  return `403 on ${what}: the service account is not a user on this property (or it is added to a different property form). ${body.slice(0, 240)}`;
}

async function get(tok: string, path: string): Promise<any | null> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${tok}` } });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.log(`   [UNAVAILABLE] ${res.status === 403 ? explain403(t, path) : `${res.status} ${t.slice(0, 240)}`}`);
    return null;
  }
  return res.json();
}

async function sa(tok: string, body: unknown, label: string): Promise<Row[] | null> {
  const res = await fetch(`${API}/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.log(`   [UNAVAILABLE] ${label}: ${res.status === 403 ? explain403(t, label) : `${res.status} ${t.slice(0, 240)}`}`);
    return null;
  }
  return ((await res.json()) as any).rows ?? [];
}

const perf = (tok: string, dim: string, from: string, to: string, limit = 500) =>
  sa(tok, { startDate: from, endDate: to, dimensions: [dim], rowLimit: limit }, `${dim} ${from}..${to}`);

function table(rows: Row[], head: string, width = 62) {
  console.log(`\n  ${head.padEnd(width)}${"clicks".padStart(9)}${"impr".padStart(11)}${"CTR".padStart(9)}${"pos".padStart(8)}`);
  for (const r of rows) {
    console.log(`  ${String(r.keys[0]).slice(0, width - 2).padEnd(width)}${n0(r.clicks).padStart(9)}${n0(r.impressions).padStart(11)}${pc(r.ctr).padStart(9)}${p1(r.position).padStart(8)}`);
  }
}

async function main() {
  const { token: tok, email } = await token();
  console.log(`\nOHC SEARCH CONSOLE — READ ONLY`);
  console.log(`property ${SITE}`);
  console.log(`service account ${email}`);
  console.log(`end date pinned to ${END} (two days back — the last 48h are partial and would show a false cliff)`);

  // Which properties are actually readable. An empty list and a rejected request
  // look identical downstream but have opposite fixes.
  const sites = await get(tok, `/sites`);
  if (sites) {
    const entries = (sites.siteEntry ?? []) as any[];
    console.log(`\n  ${entries.length} properties readable by this service account:`);
    for (const s of entries) console.log(`    ${s.permissionLevel?.padEnd(22)} ${s.siteUrl}`);
    if (!entries.some((s: any) => s.siteUrl === SITE)) {
      console.log(`\n  !! ${SITE} is NOT in that list. Everything below will 403.`);
      console.log(`     Fix: Search Console -> Settings -> Users and permissions -> add ${email} as Full or Restricted.`);
    }
  }

  // ── 3. SITEMAPS ───────────────────────────────────────────────────────────
  hr("3. SITEMAPS");
  const sm = await get(tok, `/sites/${encodeURIComponent(SITE)}/sitemaps`);
  if (sm) {
    const list = (sm.sitemap ?? []) as any[];
    if (!list.length) console.log(`  No sitemaps are submitted to this property.`);
    for (const s of list) {
      const submitted = (s.contents ?? []).reduce((a: number, c: any) => a + Number(c.submitted ?? 0), 0);
      const indexed = (s.contents ?? []).reduce((a: number, c: any) => a + Number(c.indexed ?? 0), 0);
      console.log(`\n  ${s.path}`);
      console.log(`    type ${s.type ?? "?"}   isPending ${s.isPending ?? false}   isSitemapsIndex ${s.isSitemapsIndex ?? false}`);
      console.log(`    lastSubmitted  ${s.lastSubmitted ?? "—"}`);
      console.log(`    lastDownloaded ${s.lastDownloaded ?? "NEVER DOWNLOADED"}`);
      console.log(`    warnings ${s.warnings ?? 0}   errors ${s.errors ?? 0}`);
      console.log(`    submitted URLs ${submitted}   indexed ${indexed}`);
      if (!s.lastDownloaded) console.log(`    ^^ Google has never successfully fetched this sitemap.`);
    }
  }

  // ── 4. PERFORMANCE, LAST 6 MONTHS ─────────────────────────────────────────
  hr(`4. PERFORMANCE — ${SIX_MO_START} .. ${END}`);
  const q6 = await perf(tok, "query", SIX_MO_START, END);
  const p6 = await perf(tok, "page", SIX_MO_START, END);
  if (q6) {
    const tot = q6.reduce((a, r) => ({ c: a.c + r.clicks, i: a.i + r.impressions }), { c: 0, i: 0 });
    console.log(`\n  ${q6.length} queries returned. Totals across them: ${n0(tot.c)} clicks, ${n0(tot.i)} impressions.`);
    table(q6.slice(0, 25), "TOP 25 QUERIES BY CLICKS");
  }
  if (p6) {
    const tot = p6.reduce((a, r) => ({ c: a.c + r.clicks, i: a.i + r.impressions }), { c: 0, i: 0 });
    console.log(`\n  ${p6.length} pages returned. Totals across them: ${n0(tot.c)} clicks, ${n0(tot.i)} impressions.`);
    table(p6.slice(0, 25).map((r) => ({ ...r, keys: [String(r.keys[0]).replace(/^https?:\/\/[^/]+/, "")] })), "TOP 25 PAGES BY CLICKS");
  }

  // ── 5. AUG vs JUL, BY CLICK DIFFERENCE ────────────────────────────────────
  hr(`5. QUERY DELTA — ${AUG.from}..${AUG.to} vs ${JUL.from}..${JUL.to}`);
  const [qa, qj] = [await perf(tok, "query", AUG.from, AUG.to), await perf(tok, "query", JUL.from, JUL.to)];
  if (qa && qj) {
    const map = new Map<string, { a?: Row; j?: Row }>();
    for (const r of qa) map.set(String(r.keys[0]), { ...(map.get(String(r.keys[0])) ?? {}), a: r });
    for (const r of qj) map.set(String(r.keys[0]), { ...(map.get(String(r.keys[0])) ?? {}), j: r });

    const rows = [...map.entries()].map(([k, v]) => ({
      k,
      dc: (v.a?.clicks ?? 0) - (v.j?.clicks ?? 0),
      ac: v.a?.clicks ?? 0, jc: v.j?.clicks ?? 0,
      ai: v.a?.impressions ?? 0, ji: v.j?.impressions ?? 0,
      ap: v.a?.position ?? 0, jp: v.j?.position ?? 0,
    })).sort((x, y) => x.dc - y.dc);

    const ta = qa.reduce((a, r) => a + r.clicks, 0), tj = qj.reduce((a, r) => a + r.clicks, 0);
    console.log(`\n  Aug 1-16: ${n0(ta)} clicks across ${qa.length} queries`);
    console.log(`  Jul 1-16: ${n0(tj)} clicks across ${qj.length} queries`);
    console.log(`  Net: ${sgn(ta - tj)} clicks (${tj ? (((ta - tj) / tj) * 100).toFixed(1) : "—"}%)`);

    const show = (list: typeof rows, head: string) => {
      console.log(`\n  ${head}`);
      console.log(`  ${"query".padEnd(50)}${"Δclicks".padStart(9)}${"Aug".padStart(7)}${"Jul".padStart(7)}${"Δimpr".padStart(10)}${"Aug pos".padStart(9)}${"Jul pos".padStart(9)}`);
      for (const r of list) {
        console.log(`  ${r.k.slice(0, 48).padEnd(50)}${sgn(r.dc).padStart(9)}${n0(r.ac).padStart(7)}${n0(r.jc).padStart(7)}${sgn(r.ai - r.ji).padStart(10)}${(r.ap ? p1(r.ap) : "—").padStart(9)}${(r.jp ? p1(r.jp) : "—").padStart(9)}`);
      }
    };
    show(rows.filter((r) => r.dc < 0).slice(0, 25), "BIGGEST LOSERS — this is what carried the decline");
    show(rows.filter((r) => r.dc > 0).sort((x, y) => y.dc - x.dc).slice(0, 15), "BIGGEST GAINERS");

    const lost = rows.filter((r) => r.jc > 0 && r.ac === 0);
    console.log(`\n  Queries that had clicks in July and ZERO in August: ${lost.length} (${n0(lost.reduce((a, r) => a + r.jc, 0))} clicks lost)`);
    for (const r of lost.slice(0, 15)) console.log(`    ${r.k.slice(0, 60).padEnd(62)} was ${n0(r.jc)} clicks, Jul pos ${p1(r.jp)}`);
  }

  hr("1 & 2. NOT AVAILABLE THROUGH THE API — THESE NEED THE UI");
  console.log(`  Index coverage ("Why pages aren't indexed") has no API surface. The URL Inspection`);
  console.log(`  API answers a single URL at a time and will not aggregate, so the Server error (5xx),`);
  console.log(`  Crawled - not indexed and Discovered - not indexed counts cannot be pulled here.`);
  console.log(`  Crawl stats (Settings -> Crawl stats -> By response) is likewise UI-only.`);
  console.log(`  Both must be screenshotted by a human. Not estimated here.`);

  console.log(`\nDONE — read only, nothing was submitted or changed.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

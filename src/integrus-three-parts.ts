#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, type DfsCreds } from "./dataforseo.js";

/**
 * READ-ONLY. Three parts for Integrus Partners, DataForSEO only. Nothing is written anywhere.
 * Part 1: search volume, keyword difficulty and CPC (DataForSEO Labs keyword overview, one source for all).
 * Part 2: Dallas against national volumes (Google Ads keyword data, one source for both scopes).
 * Part 3: where integruspartners.com ranks (live Google organic, top 100).
 * REFERENCE_COST (USD) is a reference, not a stop: the run reports against it.
 */
const REFERENCE_COST = Number(process.env.REFERENCE_COST || "3");
const OURS = "integruspartners.com";
const P1 = [
  "how much can you sell a vet practice for", "what is private equity in veterinary medicine", "veterinary practice sale price",
  "veterinary practice multiples", "what happens to employees when a veterinary practice is sold", "do vet techs keep their jobs when a practice is sold",
  "veterinary practice sale employees", "what do corporate buyers look for in a veterinary practice", "what do veterinary buyers look for",
  "veterinary practice rollover equity", "veterinary practice earnout", "sell side advisor veterinary practice",
  "how long does it take to sell a veterinary practice", "is now a good time to sell a veterinary practice",
];
const P2 = ["vet practice broker dallas", "m&a advisory firm dallas", "veterinary practice broker dallas", "sell side advisory firm dallas"];
const DALLAS = "Dallas,Texas,United States";
const P3: Array<{ q: string; dallas?: boolean }> = [
  "sell my veterinary practice", "selling a veterinary practice", "how to sell a veterinary practice", "how to sell my veterinary practice",
  "how do i sell my veterinary practice", "veterinary practice valuation", "vet practice valuation", "how to value a veterinary practice",
  "how do you value a veterinary practice", "veterinary practice appraisal", "how much is my veterinary practice worth",
  "how much do veterinary practices sell for", "how much can you sell a vet practice for", "what multiple of ebitda do veterinary practices sell for",
  "veterinary practice ebitda multiple", "veterinary private equity", "should i sell my veterinary practice", "veterinary consolidators",
  "how much are corporations paying for veterinary practices", "what is private equity in veterinary medicine",
].map((q) => ({ q })).concat([{ q: "vet practice broker dallas", dallas: true }, { q: "m&a advisory firm dallas", dallas: true }, { q: "integrus partners" }]);

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const csv = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const row = (...c: unknown[]) => console.log(c.map(csv).join(","));
const block = (name: string, header: string[]) => { console.log(`\n### CSV ${name}`); row(...header); };
const end = () => console.log("### END");
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let spent = 0; let calls = 0;
const parts: Record<string, { spent: number; calls: number }> = {};
let cur = "";
function part(name: string) { cur = name; parts[name] = { spent: 0, calls: 0 }; }
async function dfs(creds: DfsCreds, method: "POST" | "GET", path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, { method, headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const j: any = await res.json(); const c = n(j?.cost) ?? 0; calls++; spent += c;
  if (parts[cur]) { parts[cur]!.spent += c; parts[cur]!.calls++; }
  return j;
}
async function task(creds: DfsCreds, path: string, body: unknown, retries = 2): Promise<any> {
  for (let a = 0; ; a++) {
    try {
      const j = await dfs(creds, "POST", path, body); const t = j?.tasks?.[0];
      if (!t || t.status_code !== 20000) throw new Error(`${path}: ${t?.status_code} ${t?.status_message ?? "no task"}`);
      return t.result;
    } catch (e) { if (!/40101|50000|HTTP 5/.test(String(e)) || a >= retries) throw e; await sleep(3000 * (a + 1)); }
  }
}
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}
const bal = async (creds: DfsCreds) => dfs(creds, "GET", "/appendix/user_data").then((j) => n(j?.tasks?.[0]?.result?.[0]?.money?.balance)).catch(() => null);

(async () => {
  const creds = credsFromEnv();
  if (!creds) { console.error("DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set"); process.exit(2); }
  console.log(`RUN ${new Date().toISOString().slice(0, 10)} · Integrus three-part pull · read-only · reference cost $${REFERENCE_COST}`);
  part("balance");
  const before = await bal(creds);
  console.log(`# balance before: ${before == null ? "unreadable" : "$" + before.toFixed(4)}`);
  if (before != null && before < 1) { console.log("!! balance under $1, stopping before any call"); process.exit(4); }

  // PART 1: Labs keyword overview
  part("part1");
  const p1 = new Map<string, { vol: number | null; kd: number | null; cpc: number | null }>();
  let p1err = "";
  try {
    const res = await task(creds, "/dataforseo_labs/google/keyword_overview/live", [{ keywords: P1, location_code: 2840, language_code: "en" }]);
    for (const it of res?.[0]?.items ?? []) p1.set(norm(String(it?.keyword ?? "")), { vol: n(it?.keyword_info?.search_volume), kd: n(it?.keyword_properties?.keyword_difficulty), cpc: n(it?.keyword_info?.cpc) });
  } catch (e) { p1err = String(e).slice(0, 200); }
  block("part1", ["search", "monthly_searches", "difficulty", "cpc_usd", "note"]);
  for (const q of P1) {
    const r = p1.get(norm(q));
    if (!r) { row(q, "no data", "no data", "no data", p1err ? `call failed: ${p1err}` : "not returned by the keyword overview endpoint"); continue; }
    row(q, r.vol ?? "no data", r.kd ?? "no data", r.cpc == null ? "no data" : r.cpc.toFixed(2), "");
  }
  end();

  // PART 2: Google Ads volumes at two scopes
  part("part2");
  async function vols(scope: "dallas" | "us") {
    const m = new Map<string, number | null>(); let err = "";
    try {
      const body: any = { keywords: P2, language_name: "English" };
      if (scope === "dallas") body.location_name = DALLAS; else body.location_code = 2840;
      const res = await task(creds!, "/keywords_data/google_ads/search_volume/live", [body], 1);
      for (const it of res ?? []) m.set(norm(String(it?.keyword ?? "")), n(it?.search_volume));
    } catch (e) { err = String(e).slice(0, 220); }
    return { m, err };
  }
  const d = await vols("dallas"); const u = await vols("us");
  block("part2", ["search", "dallas_monthly_searches", "us_monthly_searches", "note"]);
  const fmt = (x: { m: Map<string, number | null>; err: string }, q: string) => (x.err ? "no data" : x.m.has(norm(q)) ? (x.m.get(norm(q)) ?? "no data") : "no data");
  for (const q of P2) {
    const notes: string[] = [];
    if (d.err) notes.push(`Dallas call failed: ${d.err}`); else if (!d.m.has(norm(q))) notes.push("Dallas: not returned"); else if (d.m.get(norm(q)) == null) notes.push("Dallas: provider returned no figure");
    if (u.err) notes.push(`US call failed: ${u.err}`); else if (!u.m.has(norm(q))) notes.push("US: not returned"); else if (u.m.get(norm(q)) == null) notes.push("US: provider returned no figure");
    row(q, fmt(d, q), fmt(u, q), notes.join("; "));
  }
  end();

  // PART 3: rankings
  part("part3");
  type R = { q: string; dallas: boolean; err: string | null; best: number | null; page: string; organic: number; others: number };
  const ranks = await pool(P3, 3, async ({ q, dallas }): Promise<R> => {
    const base: R = { q, dallas: !!dallas, err: null, best: null, page: "", organic: 0, others: 0 };
    try {
      const body: any = { keyword: q, language_name: "English", depth: 100, device: dallas ? "mobile" : "desktop" };
      if (dallas) body.location_name = DALLAS; else body.location_code = 2840;
      const res = await task(creds!, "/serp/google/organic/live/advanced", [body], 3);
      const items: any[] = (res?.[0]?.items ?? []).filter((i: any) => i?.type === "organic");
      base.organic = items.length;
      const mine = items.filter((i) => hostOf(String(i.url ?? "")) === OURS || String(i.domain ?? "").replace(/^www\./, "") === OURS);
      if (mine.length) {
        const b = mine.reduce((a: any, c: any) => ((n(c.rank_absolute) ?? 999) < (n(a.rank_absolute) ?? 999) ? c : a));
        base.best = n(b.rank_absolute) ?? n(b.rank_group); base.page = String(b.url ?? ""); base.others = mine.length - 1;
      }
      return base;
    } catch (e) { return { ...base, err: String(e).slice(0, 200) }; }
  });
  block("part3", ["search", "best_position", "page", "note"]);
  for (const r of ranks) {
    const scope = r.dallas ? "Dallas, mobile" : "US, desktop";
    if (r.err) { row(r.q, "no data", "", `${scope}; call failed: ${r.err}`); continue; }
    const notes = [scope, `${r.organic} organic results returned`];
    if (r.organic < 100) notes.push("fewer than 100 organic results came back, so 'not in the top 100' means not in those");
    if (r.best != null && r.others > 0) notes.push(`${r.others} other Integrus page(s) also rank lower`);
    row(r.q, r.best ?? "not in the top 100", r.page, notes.join("; "));
  }
  end();

  part("balance");
  const after = await bal(creds);
  console.log("\n### JSON summary");
  console.log(JSON.stringify({ before, after, spentFromCostFields: spent, calls, parts, reference: REFERENCE_COST, overReference: spent > REFERENCE_COST }));
  console.log("### END");
  console.log(`\nDONE · ${calls} calls · cost (sum of response cost fields) $${spent.toFixed(4)} · balance before ${before == null ? "n/a" : "$" + before.toFixed(4)} · after ${after == null ? "n/a" : "$" + after.toFixed(4)}`);
  for (const [k, v] of Object.entries(parts)) if (k !== "balance") console.log(`# ${k}: $${v.spent.toFixed(4)} over ${v.calls} calls`);
})().catch((e) => { console.error(`\nFAILED after ${calls} calls, $${spent.toFixed(4)}: ${e instanceof Error ? e.stack || e.message : String(e)}`); process.exit(1); });

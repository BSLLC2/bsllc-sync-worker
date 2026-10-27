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
  if (!creds) { console.error("no creds"); process.exit(2); }
  part("balance"); const before = await bal(creds);
  console.log(`# balance before: ${before == null ? "unreadable" : "$" + before.toFixed(4)}`);

  // A. Google Ads volumes for the Part 1 searches (US, English) and Labs difficulty for the same searches.
  part("A_google_ads_volume");
  block("A_google_ads_us", ["search", "monthly_searches", "cpc_usd", "competition", "note"]);
  try {
    const res = await task(creds, "/keywords_data/google_ads/search_volume/live", [{ keywords: P1, location_code: 2840, language_name: "English" }], 1);
    const m = new Map<string, any>(); for (const it of res ?? []) m.set(norm(String(it?.keyword ?? "")), it);
    for (const q of P1) { const it = m.get(norm(q)); if (!it) row(q, "no data", "no data", "no data", "not returned"); else row(q, it.search_volume ?? "no data", n(it.cpc) == null ? "no data" : n(it.cpc)!.toFixed(2), it.competition ?? "no data", it.search_volume == null ? "provider returned no figure" : ""); }
  } catch (e) { row("ALL", "no data", "", "", "call failed: " + String(e).slice(0, 200)); }
  end();
  part("B_labs_difficulty");
  block("B_labs_difficulty", ["search", "difficulty", "note"]);
  try {
    const res = await task(creds, "/dataforseo_labs/google/bulk_keyword_difficulty/live", [{ keywords: P1, location_code: 2840, language_code: "en" }], 1);
    const m = new Map<string, any>(); for (const it of res?.[0]?.items ?? []) m.set(norm(String(it?.keyword ?? "")), it);
    for (const q of P1) { const it = m.get(norm(q)); row(q, it?.keyword_difficulty ?? "no data", it ? (it.keyword_difficulty == null ? "provider returned no figure" : "") : "not returned"); }
  } catch (e) { row("ALL", "no data", "call failed: " + String(e).slice(0, 200)); }
  end();

  // C. Does the provider give a different volume at city level than at country level? Two high-volume searches as a check, not a result.
  part("C_city_check");
  block("C_city_check", ["search", "dallas", "us", "note"]);
  for (const q of ["pizza", "dentist near me"]) {
    const g = async (dallas: boolean) => { try { const b: any = { keywords: [q], language_name: "English" }; if (dallas) b.location_name = DALLAS; else b.location_code = 2840; const r = await task(creds, "/keywords_data/google_ads/search_volume/live", [b], 1); return r?.[0]?.search_volume ?? "no data"; } catch (e) { return "call failed: " + String(e).slice(0, 120); } };
    row(q, await g(true), await g(false), "check of whether city-level volumes differ from national ones");
  }
  end();

  // D. Retry the Dallas mobile ranking that failed with partial results.
  part("D_dallas_serp");
  block("D_dallas_serp", ["search", "best_position", "page", "note"]);
  for (const q of ["vet practice broker dallas"]) {
    let done = false;
    for (let a = 0; a < 4 && !done; a++) {
      try {
        const res = await task(creds, "/serp/google/organic/live/advanced", [{ keyword: q, language_name: "English", depth: 100, device: "mobile", location_name: DALLAS }], 0);
        const items: any[] = (res?.[0]?.items ?? []).filter((i: any) => i?.type === "organic");
        const mine = items.filter((i) => hostOf(String(i.url ?? "")) === OURS);
        const b = mine.length ? mine.reduce((x: any, c: any) => ((n(c.rank_absolute) ?? 999) < (n(x.rank_absolute) ?? 999) ? c : x)) : null;
        row(q, b ? (n(b.rank_absolute) ?? n(b.rank_group)) : "not in the top 100", b ? b.url : "", `Dallas, mobile; ${items.length} organic results returned; attempt ${a + 1}`);
        done = true;
      } catch (e) { if (a === 3) row(q, "no data", "", "Dallas, mobile; call failed after 4 attempts: " + String(e).slice(0, 160)); else await sleep(5000); }
    }
  }
  end();

  part("balance"); const after = await bal(creds);
  console.log(`\nDONE · ${calls} calls · cost $${spent.toFixed(4)} · balance before ${before == null ? "n/a" : "$" + before.toFixed(4)} · after ${after == null ? "n/a" : "$" + after.toFixed(4)}`);
  for (const [k, v] of Object.entries(parts)) if (k !== "balance") console.log(`# ${k}: $${v.spent.toFixed(4)} over ${v.calls} calls`);
})().catch((e) => { console.error(`FAILED: ${e instanceof Error ? e.stack || e.message : String(e)}`); process.exit(1); });

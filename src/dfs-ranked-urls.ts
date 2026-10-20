#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, type DfsCreds } from "./dataforseo.js";

/**
 * READ-ONLY: DataForSEO Labs ranked_keywords (Google, US, live) for a list of
 * page URLs. URLS env = comma-separated absolute URLs; LIMIT env = rows per URL
 * (default 30, ordered by search volume desc). Prints one CSV block.
 */
const URLS = (process.env.URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
const LIMIT = Math.max(1, Math.min(1000, Number(process.env.LIMIT ?? 30)));
const RUN = new Date().toISOString().slice(0, 10);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : "");
const csv = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const row = (...c: unknown[]) => console.log(c.map(csv).join(","));

async function dfs(creds: DfsCreds, path: string, body: unknown): Promise<any> {
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j: any = await res.json(); const t = j?.tasks?.[0];
  if (!t || t.status_code !== 20000) throw new Error(`${t?.status_code ?? "?"} ${t?.status_message ?? "no task"}`);
  return { result: t.result, cost: Number(t.cost ?? 0) };
}

async function main() {
  const creds = credsFromEnv();
  if (!URLS.length) throw new Error("URLS env is empty");
  console.log(`\nRUN ${RUN} · ranked_keywords (Labs, Google, US, live) · ${URLS.length} URLs · limit ${LIMIT}/URL`);
  console.log("\n### CSV ranked_keywords");
  row("url", "keyword", "position", "search_volume", "cpc", "keyword_difficulty", "search_intent", "ranking_url_reported", "etv", "source", "date", "note");
  let total = 0;
  for (const target of URLS) {
    try {
      const { result, cost } = await dfs(creds, "/dataforseo_labs/google/ranked_keywords/live", [{ target, location_code: 2840, language_code: "en", limit: LIMIT, order_by: ["keyword_data.keyword_info.search_volume,desc"], include_subdomains: false }]);
      total += cost;
      const items: any[] = result?.[0]?.items ?? [];
      if (!items.length) { row(target, "", "", "", "", "", "", "", "", "dataforseo_labs/google/ranked_keywords/live", RUN, "no ranked keywords returned for this URL (Labs index has no organic top-100 rows for it)"); continue; }
      for (const it of items) {
        const kd = it?.keyword_data ?? {}; const se = it?.ranked_serp_element?.serp_item ?? {};
        row(target, kd?.keyword ?? "", n(se?.rank_absolute), n(kd?.keyword_info?.search_volume), n(kd?.keyword_info?.cpc), n(kd?.keyword_properties?.keyword_difficulty), kd?.search_intent_info?.main_intent ?? "", se?.url ?? "", n(se?.etv), "dataforseo_labs/google/ranked_keywords/live", RUN, "");
      }
    } catch (e) {
      row(target, "", "", "", "", "", "", "", "", "dataforseo_labs/google/ranked_keywords/live", RUN, `ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log("### END");
  console.log(`\nDONE · ${URLS.length} URLs · DataForSEO cost $${total.toFixed(4)}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

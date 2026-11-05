#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, type DfsCreds } from "./dataforseo.js";

/** READ-ONLY. Where AI answers about remanufactured diesel engines get their sources, and whether DPG is among them. DataForSEO LLM Mentions only. */
const OURS = "dieselpowergroup.com";
const COMPS = ["reviva.com", "jasperengines.com", "capitalremanexchange.com", "highwayandheavyparts.com", "4btengines.com", "usdieselparts.com", "srcreman.com", "dieselpowerusa.com"];
const PROBES = [
  "remanufactured diesel engine", "reman engine", "cat c15 engine", "cummins n14", "detroit series 60", "remanufactured engine cost",
  "rebuilt vs remanufactured engine", "engine warranty remanufactured", "diesel engine core charge", "cat 3406e", "cummins isx", "dd15",
];
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const csv = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const row = (...c: unknown[]) => console.log(c.map(csv).join(","));
const block = (name: string, header: string[]) => { console.log(`\n### CSV ${name}`); row(...header); };
const end = () => console.log("### END");
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
let spent = 0; let calls = 0;
async function dfs(creds: DfsCreds, method: "POST" | "GET", path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, { method, headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(100000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const j: any = await res.json(); calls++; spent += n(j?.cost) ?? 0; return j;
}
async function one(creds: DfsCreds, path: string, body: unknown): Promise<any> {
  for (let a = 0; ; a++) {
    try {
      const j = await dfs(creds, "POST", path, body); const t = j?.tasks?.[0];
      if (!t || t.status_code !== 20000) throw new Error(`${path}: ${t?.status_code} ${t?.status_message ?? "no task"}`);
      return t.result;
    } catch (e) { if (!/40101|50000|HTTP 5/.test(String(e)) || a >= 2) throw e; await new Promise((r) => setTimeout(r, 3000 * (a + 1))); }
  }
}
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}
(async () => {
  const creds = credsFromEnv(); if (!creds) { console.error("no creds"); process.exit(2); }
  const b0 = await dfs(creds, "GET", "/appendix/user_data").then((j) => n(j?.tasks?.[0]?.result?.[0]?.money?.balance)).catch(() => null);
  console.log(`RUN ${new Date().toISOString().slice(0, 10)} · DPG AEO probe · read-only\n# balance before: ${b0 == null ? "unreadable" : "$" + b0.toFixed(4)}`);

  type M = { platform: string; question: string; volume: number | null; sources: string[]; urls: string[] };
  const res = await pool(PROBES, 3, async (probe) => {
    try {
      const r = await one(creds, "/ai_optimization/llm_mentions/search_mentions/live", [{ location_code: 2840, language_code: "en", target: [{ keyword: probe, search_scope: ["question"], match_type: "word_match" }], order_by: ["ai_search_volume,desc"], limit: 30 }]);
      const o = r?.[0]; const items: M[] = (o?.items ?? []).map((it: any) => ({ platform: String(it?.platform ?? ""), question: String(it?.question ?? ""), volume: n(it?.ai_search_volume), sources: [...new Set(((it?.sources ?? []) as any[]).map((s) => String(s?.domain ?? hostOf(String(s?.url ?? ""))).replace(/^www\./, "").toLowerCase()).filter(Boolean))], urls: ((it?.sources ?? []) as any[]).map((s) => String(s?.url ?? "")).filter(Boolean) }));
      return { probe, total: n(o?.total_count), items, err: "" };
    } catch (e) { return { probe, total: null, items: [] as M[], err: String(e).slice(0, 140) }; }
  });
  block("1_questions_people_ask_ai", ["probe", "total_questions_found", "question", "ai_search_volume", "platform", "cites_dpg", "sources"]);
  for (const r of res) {
    if (r.err) { row(r.probe, "no data", "", "", "", "", `error ${r.err}`); continue; }
    if (!r.items.length) { row(r.probe, r.total ?? 0, "no data", "", "", "", ""); continue; }
    for (const it of r.items.slice(0, 8)) row(r.probe, r.total ?? "", it.question, it.volume ?? "no data", it.platform, it.sources.includes(OURS) ? "yes" : "no", it.sources.slice(0, 6).join(" | "));
  }
  end();
  const tally = new Map<string, number>(); let qn = 0; let dpgQ = 0;
  for (const r of res) for (const it of r.items) { qn++; if (it.sources.includes(OURS)) dpgQ++; for (const s of it.sources) tally.set(s, (tally.get(s) ?? 0) + 1); }
  block("2_most_cited_source_domains", ["domain", "answers_citing_it", "share_of_answers_read", "is_dpg", "note"]);
  for (const [d, c] of [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) row(d, c, qn ? (c / qn).toFixed(3) : "", d === OURS ? "yes" : "", COMPS.includes(d) ? "competitor" : "");
  end();
  console.log(`# answers read: ${qn}; answers citing dieselpowergroup.com: ${dpgQ}`);

  block("3_target_metrics", ["domain", "ai_mentions", "ai_search_volume", "chatgpt_mentions", "google_ai_mentions", "top_cited_pages", "note"]);
  await pool([OURS, ...COMPS], 3, async (d) => {
    try {
      const r = (await one(creds, "/ai_optimization/llm_mentions/target_metrics/live", [{ location_code: 2840, language_code: "en", target: [{ domain: d, search_filter: "include", search_scope: ["sources"] }], internal_list_limit: 10 }]))?.[0];
      const m = r?.aggregated_metrics; const plat = (k: string) => ((m?.platform ?? []) as any[]).find((p) => p?.key === k)?.mentions ?? 0;
      let pages = "";
      try { const p = (await one(creds, "/ai_optimization/llm_mentions/top_mentioned_pages/live", [{ location_code: 2840, language_code: "en", target: [{ domain: d, search_filter: "include", search_scope: ["sources"] }], limit: 6, internal_list_limit: 3 }]))?.[0]; pages = ((p?.items ?? []) as any[]).map((x) => `${x?.page} (${x?.total?.mentions})`).join(" | "); } catch (e) { pages = `pages call failed ${String(e).slice(0, 60)}`; }
      row(d, n(m?.total?.mentions) ?? "no data", n(m?.total?.ai_search_volume) ?? "no data", plat("chat_gpt"), plat("google"), pages, "llm_mentions/target_metrics + top_mentioned_pages");
    } catch (e) { row(d, "no data", "", "", "", "", `error ${String(e).slice(0, 100)}`); }
  });
  end();
  const b1 = await dfs(creds, "GET", "/appendix/user_data").then((j) => n(j?.tasks?.[0]?.result?.[0]?.money?.balance)).catch(() => null);
  console.log(`\n# balance after: ${b1 == null ? "unreadable" : "$" + b1.toFixed(4)}`);
  console.log(`### JSON summary\n${JSON.stringify({ calls, spent: Number(spent.toFixed(4)), before: b0, after: b1 })}`);
})().catch((e) => { console.error(e); process.exit(1); });

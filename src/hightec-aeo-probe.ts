#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, type DfsCreds } from "./dataforseo.js";

/**
 * READ-ONLY. Asks AI answer engines the HighTec prompt set through DataForSEO
 * (LLM Responses for ChatGPT, Claude, Gemini, Perplexity; Google SERP for AI
 * Overviews and AI Mode) and prints every answer and every cited source.
 * Writes nothing anywhere. A cost cap stops new calls.
 *
 * MODE=models  list the models each LLM endpoint offers (no prompts asked)
 * MODE=smoke   one prompt, every engine, raw response shape printed
 * MODE=full    the whole prompt set, RUNS runs each (default 3)
 */
const MODE = (process.env.MODE || "smoke").toLowerCase();
const RUNS = Math.max(1, Number(process.env.RUNS || 3));
const CAP = Number(process.env.COST_CAP || 5);
const MAXTOK = Number(process.env.MAX_OUTPUT_TOKENS || 800);

type Loc = "US" | "Cincinnati" | "Greensburg" | "Indiana";
const LOCNAME: Record<Loc, string> = {
  US: "United States",
  Cincinnati: "Cincinnati,Ohio,United States",
  Greensburg: "Greensburg,Indiana,United States",
  Indiana: "Indiana,United States",
};
interface Prompt { id: string; text: string; loc: Loc }
const PROMPTS: Prompt[] = [
  { id: "1", text: "What is HighTec Industrial Services?", loc: "US" },
  { id: "2a", text: "Who is HighTec Industrial Services in Ohio?", loc: "US" },
  { id: "2b", text: "Who is HighTec Industrial Services in Indiana?", loc: "US" },
  { id: "3", text: "What is Advanced Vacuum Services in Greensburg, Indiana?", loc: "Greensburg" },
  { id: "4", text: "Is Advanced Vacuum Services part of HighTec?", loc: "US" },
  { id: "5a", text: "HighTec industrial cleaning company", loc: "US" },
  { id: "5b", text: "High Tec vacuum services", loc: "US" },
  { id: "5c", text: "High-Tec industrial services", loc: "US" },
  { id: "6", text: "Companies named HighTec / Hi-Tec in industrial services.", loc: "US" },
  { id: "7", text: "Best industrial vacuum service companies near Cincinnati.", loc: "Cincinnati" },
  { id: "8", text: "Industrial cleaning contractors in Indiana.", loc: "Indiana" },
  { id: "9", text: "Who provides hydro excavation / industrial vacuum / tank cleaning near Greensburg, Indiana?", loc: "Greensburg" },
  { id: "10", text: "Emergency industrial cleanup contractors in southwest Ohio.", loc: "Cincinnati" },
  { id: "11a", text: "HighTec acquisitions", loc: "US" },
  { id: "11b", text: "Companies acquired by HighTec Industrial Services.", loc: "US" },
  { id: "12", text: "What services does HighTec offer?", loc: "US" },
];

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
let spent = 0; let calls = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function dfs(creds: DfsCreds, method: "POST" | "GET", path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, { method, headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(170000) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${txt.slice(0, 200)}`);
  const j: any = JSON.parse(txt); calls++; spent += n(j?.cost) ?? 0; return j;
}
async function task(creds: DfsCreds, path: string, body: unknown): Promise<{ result: any; raw: any }> {
  for (let a = 0; ; a++) {
    try {
      const j = await dfs(creds, "POST", path, body); const t = j?.tasks?.[0];
      if (!t || t.status_code !== 20000) throw new Error(`${t?.status_code} ${t?.status_message ?? "no task"}`);
      return { result: t.result?.[0], raw: t };
    } catch (e) {
      if (!/HTTP 5|50000|40101|timeout|aborted/i.test(String(e)) || a >= 2) throw e;
      await sleep(3000 * (a + 1));
    }
  }
}
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}

interface Src { url: string; title: string }
interface Ans { prompt: string; pid: string; engine: string; run: number; loc: string; model: string; text: string; sources: Src[]; error: string; cost: number | null }

/** LLM Responses result -> text + citations. Shapes differ a little by engine, so walk it. */
function readLlm(result: any): { text: string; sources: Src[]; model: string } {
  const texts: string[] = []; const sources: Src[] = []; const seen = new Set<string>();
  const addSrc = (a: any) => { const u = a?.url || a?.link; if (typeof u === "string" && !seen.has(u)) { seen.add(u); sources.push({ url: u, title: String(a?.title ?? a?.domain ?? "") }); } };
  for (const it of Array.isArray(result?.items) ? result.items : []) {
    if (Array.isArray(it?.sections)) for (const s of it.sections) { if (typeof s?.text === "string") texts.push(s.text); for (const a of s?.annotations ?? []) addSrc(a); }
    else { if (typeof it?.text === "string") texts.push(it.text); }
    for (const k of ["annotations", "citations", "sources", "references"]) for (const a of it?.[k] ?? []) addSrc(a);
  }
  for (const k of ["sources", "references", "annotations"]) for (const a of result?.[k] ?? []) addSrc(a);
  return { text: texts.join("\n").trim(), sources, model: String(result?.model_name ?? "") };
}
/** SERP ai_overview / ai_mode item -> text + references. */
function readAi(items: any[]): { text: string; sources: Src[] } {
  const texts: string[] = []; const sources: Src[] = []; const seen = new Set<string>();
  const addSrc = (a: any) => { const u = a?.url; if (typeof u === "string" && !seen.has(u)) { seen.add(u); sources.push({ url: u, title: String(a?.title ?? a?.source ?? a?.domain ?? "") }); } };
  const walk = (o: any) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (typeof o.text === "string" && (o.type === "ai_overview_element" || o.type === "ai_overview" || o.type === "ai_mode_element" || o.type === "ai_mode" || o.type === undefined)) texts.push(o.text);
    if (Array.isArray(o.references)) o.references.forEach(addSrc);
    for (const k of ["items", "markdown"]) if (k === "items" && Array.isArray(o.items)) walk(o.items);
  };
  for (const it of items) {
    if (it?.type === "ai_overview" || it?.type === "ai_mode") {
      if (typeof it?.markdown === "string") texts.push(it.markdown);
      walk(it);
      for (const a of it?.references ?? []) addSrc(a);
    }
  }
  return { text: [...new Set(texts)].join("\n").trim(), sources };
}

const LLM: { engine: string; seg: string; model: () => string }[] = [
  { engine: "ChatGPT", seg: "chat_gpt", model: () => process.env.M_CHATGPT || "gpt-4.1-mini" },
  { engine: "Claude", seg: "claude", model: () => process.env.M_CLAUDE || "claude-sonnet-4-0" },
  { engine: "Gemini", seg: "gemini", model: () => process.env.M_GEMINI || "gemini-2.5-pro" },
  { engine: "Perplexity", seg: "perplexity", model: () => process.env.M_PERPLEXITY || "sonar" },
];

async function askLlm(creds: DfsCreds, e: (typeof LLM)[number], p: Prompt, run: number): Promise<Ans> {
  const base = { prompt: p.text, pid: p.id, engine: e.engine, run, loc: "United States (API default; no city setting)" };
  try {
    const { result, raw } = await task(creds, `/ai_optimization/${e.seg}/llm_responses/live`, [{ user_prompt: p.text, model_name: e.model(), web_search: true, max_output_tokens: MAXTOK, temperature: 0.3 }]);
    const r = readLlm(result);
    return { ...base, model: r.model || e.model(), text: r.text, sources: r.sources, error: r.text ? "" : "empty answer", cost: n(raw?.cost) };
  } catch (err) { return { ...base, model: e.model(), text: "", sources: [], error: String(err).slice(0, 220), cost: null }; }
}
async function askGoogle(creds: DfsCreds, kind: "ai_overview" | "ai_mode", p: Prompt, run: number): Promise<Ans> {
  const engine = kind === "ai_overview" ? "Google AI Overviews" : "Google AI Mode";
  const base = { prompt: p.text, pid: p.id, engine, run, loc: LOCNAME[p.loc] };
  try {
    const path = kind === "ai_overview" ? "/serp/google/organic/live/advanced" : "/serp/google/ai_mode/live/advanced";
    const body: any = { keyword: p.text, location_name: LOCNAME[p.loc], language_code: "en", device: "desktop" };
    if (kind === "ai_overview") { body.load_async_ai_overview = true; body.depth = 10; }
    const { result, raw } = await task(creds, path, [body]);
    const r = readAi(result?.items ?? []);
    return { ...base, model: kind, text: r.text, sources: r.sources, error: r.text ? "" : (kind === "ai_overview" ? "no AI Overview shown" : "no AI Mode answer returned"), cost: n(raw?.cost) };
  } catch (err) { return { ...base, model: kind, text: "", sources: [], error: String(err).slice(0, 220), cost: null }; }
}

const J = (v: unknown) => JSON.stringify(v);
(async () => {
  const creds = credsFromEnv();
  const bal = () => dfs(creds, "GET", "/appendix/user_data").then((j) => n(j?.tasks?.[0]?.result?.[0]?.money?.balance)).catch(() => null);
  const b0 = await bal();
  console.log(`RUN ${new Date().toISOString()} · HighTec AEO probe · MODE=${MODE} · read-only\n# balance before: ${b0 == null ? "unreadable" : "$" + b0.toFixed(4)} · cap $${CAP}`);

  if (MODE === "models") {
    for (const e of LLM) {
      try { const j = await dfs(creds, "GET", `/ai_optimization/${e.seg}/llm_responses/models`); console.log(`### MODELS ${e.engine}\n${J(j?.tasks?.[0]?.result ?? j?.tasks?.[0]?.status_message).slice(0, 2500)}`); }
      catch (err) { console.log(`### MODELS ${e.engine} error ${String(err).slice(0, 200)}`); }
    }
  } else if (MODE === "smoke") {
    const p = PROMPTS[0]!;
    for (const e of LLM) {
      try { const { result } = await task(creds, `/ai_optimization/${e.seg}/llm_responses/live`, [{ user_prompt: p.text, model_name: e.model(), web_search: true, max_output_tokens: 300 }]); console.log(`### RAW ${e.engine}\n${J(result).slice(0, 2500)}`); }
      catch (err) { console.log(`### RAW ${e.engine} error ${String(err).slice(0, 250)}`); }
    }
    for (const k of ["ai_overview", "ai_mode"] as const) {
      try {
        const path = k === "ai_overview" ? "/serp/google/organic/live/advanced" : "/serp/google/ai_mode/live/advanced";
        const body: any = { keyword: p.text, location_name: LOCNAME.US, language_code: "en", device: "desktop" }; if (k === "ai_overview") { body.load_async_ai_overview = true; body.depth = 10; }
        const { result } = await task(creds, path, [body]);
        const aiItems = (result?.items ?? []).filter((x: any) => /ai_/.test(String(x?.type)));
        console.log(`### RAW ${k} item types=${J((result?.items ?? []).map((x: any) => x?.type))}\n${J(aiItems).slice(0, 2500)}`);
      } catch (err) { console.log(`### RAW ${k} error ${String(err).slice(0, 250)}`); }
    }
  } else {
    const all: Ans[] = []; let stopped = false;
    for (let run = 1; run <= RUNS && !stopped; run++) {
      const jobs: (() => Promise<Ans>)[] = [];
      for (const p of PROMPTS) {
        for (const e of LLM) jobs.push(() => askLlm(creds, e, p, run));
        jobs.push(() => askGoogle(creds, "ai_overview", p, run));
        jobs.push(() => askGoogle(creds, "ai_mode", p, run));
      }
      const got = await pool(jobs, 4, async (j) => { if (spent > CAP) { stopped = true; return null; } return j(); });
      for (const a of got) if (a) all.push(a);
      console.log(`# run ${run} done · spent so far $${spent.toFixed(4)}${stopped ? " · COST CAP HIT, later calls skipped" : ""}`);
    }
    for (const a of all) {
      console.log(`### ANSWER ${a.pid} | ${a.engine} | run ${a.run} | model ${a.model} | loc ${a.loc} | ${a.error ? "ERROR: " + a.error : "ok"}`);
      console.log(`PROMPT: ${a.prompt}`);
      console.log(`TEXT: ${a.text.replace(/\s*\n\s*/g, " ⏎ ")}`);
      console.log(`SOURCES: ${a.sources.map((s) => `${s.url} [${s.title}]`).join(" ; ") || "none"}`);
      console.log("### END");
    }
  }
  const b1 = await bal();
  console.log(`\n# balance after: ${b1 == null ? "unreadable" : "$" + b1.toFixed(4)}`);
  console.log(`### JSON summary\n${J({ mode: MODE, calls, spent: Number(spent.toFixed(4)), before: b0, after: b1 })}`);
})().catch((e) => { console.error(e); process.exit(1); });

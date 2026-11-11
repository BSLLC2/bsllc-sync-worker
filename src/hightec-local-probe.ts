#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, type DfsCreds } from "./dataforseo.js";

/**
 * READ-ONLY local-search probe for HighTec Industrial Services and Advanced Vacuum
 * Services (AVS), through DataForSEO. Writes nothing anywhere. A cost cap stops new
 * calls. PHASE picks the part:
 *   discover   names -> Google Maps listings (+ business info for the matches)
 *   grid       geo-grid Maps rank for each service query, device and territory
 *   serp       branded + service SERPs: ads, local pack, knowledge panel, PAA, related, suggestions
 *   ai         service queries with each territory's location in AI engines
 *   listings   Google business-listings database sweep for similar names (radius)
 *   reviews    newest reviews for given cids (PARAMS.cids)
 * PARAMS is optional JSON overriding centers, cids, etc.
 */
const PHASE = (process.env.PHASE || "discover").toLowerCase();
const CAP = Number(process.env.COST_CAP || 10);
const PARAMS: any = (() => { try { return JSON.parse(process.env.PARAMS || "{}"); } catch { return {}; } })();
const ZOOM = String(PARAMS.zoom || "14z");
const DEPTH = Number(PARAMS.depth || 20);

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
let spent = 0; let calls = 0; let stopped = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function dfs(creds: DfsCreds, method: "POST" | "GET", path: string, body?: unknown): Promise<any> {
  const t0 = Date.now();
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, { method, headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(75000) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${txt.slice(0, 200)}`);
  const j: any = JSON.parse(txt); calls++; spent += n(j?.cost) ?? 0;
  const ms = Date.now() - t0; if (calls <= 6 || ms > 20000 || calls % 200 === 0) console.log(`# call ${calls} ${path} ${ms}ms cost ${n(j?.cost)} total $${spent.toFixed(4)}`);
  return j;
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
const J = (v: unknown) => JSON.stringify(v);
const capped = () => { if (spent > CAP) { stopped = true; } return stopped; };

// ---------- what counts as each company --------------------------------
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
type Who = "HT" | "AVS" | "HT?" | "AVS?" | null;
/** Confirmed by domain or phone; name-only matches are flagged with "?" and never counted. */
function whoIs(it: { title?: string; domain?: string; url?: string; phone?: string }): Who {
  const dom = String(it.domain || it.url || "").toLowerCase();
  const ph = digits(it.phone).slice(-10);
  const t = String(it.title || "");
  if (/hightecindustrial\.com/.test(dom) || ph === "9376671772" || ph === "8772771772") return "HT";
  if (/advancedvacuum\.com/.test(dom)) return "AVS";
  if (/\bhi[\s-]?tec(h)?\b.*(industrial|vacuum|clean)|\bhigh[\s-]?tec(h)?\b.*(industrial|vacuum|clean)|^\s*hightec\b/i.test(t)) return "HT?";
  if (/advanced\s+vacuum|\bavs\b/i.test(t)) return "AVS?";
  return null;
}
const look = (it: any) => /hi[\s-]?te(c|ch)\b|high[\s-]?te(c|ch)\b|advanced\s+vacuum|power\s*clean/i.test(String(it.title || ""));

// ---------- geometry ---------------------------------------------------
const MI = 1 / 69.0;
function gridPoints(lat: number, lng: number, size = 7, spacingMi = 5) {
  const half = (size - 1) / 2; const pts: { lat: number; lng: number; r: number; c: number }[] = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    pts.push({ lat: +(lat + (half - r) * spacingMi * MI).toFixed(5), lng: +(lng + (c - half) * spacingMi * MI / Math.cos((lat * Math.PI) / 180)).toFixed(5), r, c });
  }
  return pts;
}

// ---------- territories ------------------------------------------------
interface Terr { id: string; name: string; city: string; state: string; lat: number; lng: number }
const TERR: Terr[] = PARAMS.terr || [
  { id: "T1", name: "Greensburg IN", city: "Greensburg", state: "Indiana", lat: 39.3373, lng: -85.4836 },
  { id: "T2", name: "Huber Heights / Dayton OH", city: "Dayton", state: "Ohio", lat: 39.8439, lng: -84.1247 },
  { id: "T3", name: "Central Kentucky (provisional: Lexington)", city: "Lexington", state: "Kentucky", lat: 38.0406, lng: -84.5037 },
];
const SERVICES: string[] = PARAMS.services || ["industrial vacuum service", "vacuum truck service", "hydro excavation", "industrial tank cleaning", "industrial water blasting", "industrial pressure washing", "emergency industrial cleanup", "roof rock removal"];
const base = (s: string) => s.replace(/^industrial\s+/i, "");
function queriesFor(t: Terr): { q: string; kind: string; svc: string }[] {
  const out: { q: string; kind: string; svc: string }[] = [];
  for (const s of SERVICES) {
    out.push({ q: `${s} near me`, kind: "near-me", svc: s });
    out.push({ q: `${s} ${t.city}`, kind: "city", svc: s });
    out.push({ q: `industrial ${base(s)} ${t.state}`, kind: "state", svc: s });
  }
  return out;
}
const NAMES = ["HighTec Industrial Services", "High Tec Industrial", "hightec", "Advanced Vacuum Services", "AVS Greensburg", "advanced vacuum"];

// ---------- helpers for result lines ------------------------------------
const trim = (s: unknown, k = 160) => String(s ?? "").replace(/\s+/g, " ").slice(0, k);
const rv = (it: any) => ({ r: n(it?.rating?.value), v: n(it?.rating?.votes_count) });

async function mapsCall(creds: DfsCreds, keyword: string, lat: number, lng: number, device: string) {
  const body: any = { keyword, location_coordinate: `${lat},${lng},${ZOOM}`, language_code: "en", device, depth: DEPTH };
  if (device === "mobile") body.os = "android"; else body.os = "windows";
  const { result, raw } = await task(creds, "/serp/google/maps/live/advanced", [body]);
  return { items: (result?.items ?? []).filter((x: any) => x?.type === "maps_search"), cost: n(raw?.cost) };
}

// ---------- phases -------------------------------------------------------
async function discover(creds: DfsCreds) {
  const spots = PARAMS.spots || [
    { id: "HubH", lat: 39.8439, lng: -84.1247 }, { id: "Tipp", lat: 39.9598, lng: -84.1747 },
    { id: "Greensburg", lat: 39.3373, lng: -85.4836 }, { id: "Lexington", lat: 38.0406, lng: -84.5037 },
  ];
  const queries = [...NAMES, "HighTec Industrial Services Tipp City", "High-Tec Industrial Services Inc", "AVS Advanced Vacuum Services Greensburg Indiana"];
  const jobs: { q: string; s: any; device: string }[] = [];
  for (const q of queries) for (const s of spots) for (const device of ["desktop"]) jobs.push({ q, s, device });
  const found = new Map<string, any>();
  await pool(jobs, 8, async (j) => {
    if (capped()) return;
    try {
      const { items } = await mapsCall(creds, j.q, j.s.lat, j.s.lng, j.device);
      const top = items.slice(0, 8).map((it: any) => ({ k: it.rank_group, t: trim(it.title, 70), w: whoIs(it), d: it.domain, a: trim(it.address, 80), p: it.phone, ...rv(it), cat: it.category, cid: it.cid }));
      console.log(`### MAPS ${J({ q: j.q, from: j.s.id, device: j.device, top })}`);
      for (const it of items) if (whoIs(it) || look(it)) { const key = String(it.cid || it.place_id); if (!found.has(key)) found.set(key, it); }
    } catch (e) { console.log(`### MAPS ERROR ${J({ q: j.q, from: j.s.id, e: String(e).slice(0, 200) })}`); }
  });
  console.log(`# candidate listings: ${found.size}`);
  for (const [k, it] of found) {
    console.log(`### CAND ${J({ cid: it.cid, place_id: it.place_id, title: it.title, who: whoIs(it), domain: it.domain, phone: it.phone, address: it.address, lat: it.latitude, lng: it.longitude, cat: it.category, addl: it.additional_categories, ...rv(it), claimed: it.is_claimed, photos: it.total_photos })}`);
  }
  // business info for confirmed matches (and ? matches, so duplicates are visible)
  const infoTargets = [...found.values()].filter((it) => whoIs(it));
  for (const it of infoTargets) {
    if (capped()) break;
    try {
      const { result } = await task(creds, "/business_data/google/my_business_info/live", [{ keyword: `cid:${it.cid}`, location_name: "United States", language_code: "en" }]);
      const x = result?.items?.[0] ?? {};
      console.log(`### INFO ${J({ cid: it.cid, title: x.title, category: x.category, additional: x.additional_categories, address: x.address, phone: x.phone, url: x.url, domain: x.domain, claimed: x.is_claimed, rating: x.rating, dist: x.rating_distribution, photos: x.total_photos, hours: x.work_time?.work_hours?.timetable, attrs: x.attributes, lat: x.latitude, lng: x.longitude, updated: x.last_updated_time, desc: trim(x.description, 300), service_area: x.address_info, local_links: x.local_business_links })}`);
    } catch (e) { console.log(`### INFO ERROR ${J({ cid: it.cid, e: String(e).slice(0, 200) })}`); }
  }
}

async function grid(creds: DfsCreds) {
  const centers: { terr: Terr; id: string; lat: number; lng: number }[] = PARAMS.centers || TERR.map((t) => ({ terr: t, id: t.id, lat: t.lat, lng: t.lng }));
  const devices: string[] = PARAMS.devices || ["desktop", "mobile"];
  const onlyTerr: string[] = PARAMS.only || [];
  const size = Number(PARAMS.size || 7);
  const cellJobs: { c: (typeof centers)[number]; q: { q: string; kind: string; svc: string }; device: string }[] = [];
  for (const c of centers) { if (onlyTerr.length && !onlyTerr.includes(c.id)) continue; for (const q of queriesFor(c.terr)) for (const device of devices) cellJobs.push({ c, q, device }); }
  console.log(`# grid jobs ${cellJobs.length} x ${size * size} points`);
  for (const job of cellJobs) {
    if (capped()) { console.log(`# COST CAP HIT before ${job.c.id} ${job.q.q} ${job.device}`); break; }
    const pts = gridPoints(job.c.lat, job.c.lng, size, 5);
    const per: Record<string, (number | null)[]> = { HT: [], AVS: [] };
    const comp = new Map<string, any>(); const lookalikes = new Map<string, number>(); let err = 0; let nResults = 0;
    await pool(pts, 14, async (p) => {
      try {
        const { items } = await mapsCall(creds, job.q.q, p.lat, p.lng, job.device);
        nResults += items.length;
        let ht: number | null = null, avs: number | null = null;
        for (const it of items) {
          const w = whoIs(it); const rank = n(it.rank_group) ?? n(it.rank_absolute) ?? 99;
          if (w === "HT" && ht == null) ht = rank; else if (w === "AVS" && avs == null) avs = rank;
          else if (w === "HT?" || w === "AVS?" || (look(it) && !w)) lookalikes.set(`${trim(it.title, 60)} | ${it.domain ?? ""}`, (lookalikes.get(`${trim(it.title, 60)} | ${it.domain ?? ""}`) ?? 0) + 1);
          const key = String(it.cid || it.domain || it.title);
          const e = comp.get(key) ?? { t: trim(it.title, 60), d: it.domain, a: trim(it.address_info?.city ? `${it.address_info.city}, ${it.address_info.region ?? ""}` : it.address, 50), cat: it.category, ...rv(it), n: 0, t3: 0, sum: 0, who: w };
          e.n++; e.sum += rank; if (rank <= 3) e.t3++; comp.set(key, e);
        }
        per.HT.push(ht); per.AVS.push(avs);
      } catch { err++; per.HT.push(null); per.AVS.push(null); }
    });
    const stat = (arr: (number | null)[]) => {
      const tot = pts.length - err; const found = arr.filter((x) => x != null) as number[];
      return { found: found.length, tot, share_found: tot ? +(found.length / tot).toFixed(3) : null, share_top3: tot ? +(found.filter((x) => x <= 3).length / tot).toFixed(3) : null, avg_when_found: found.length ? +(found.reduce((a, b) => a + b, 0) / found.length).toFixed(2) : null, arp_missing21: tot ? +(arr.slice(0, tot).reduce<number>((a, b) => a + (b ?? 21), 0) / pts.length).toFixed(2) : null, best: found.length ? Math.min(...found) : null };
    };
    const compList = [...comp.values()].filter((e) => !e.who).map((e) => ({ ...e, avg: +(e.sum / e.n).toFixed(2), sum: undefined })).sort((a, b) => b.t3 - a.t3 || b.n - a.n).slice(0, 8);
    console.log(`### GRID ${J({ terr: job.c.id, q: job.q.q, kind: job.q.kind, svc: job.q.svc, device: job.device, err, results: nResults, HT: stat(per.HT), AVS: stat(per.AVS), comp: compList, look: [...lookalikes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) })}`);
  }
}

async function serp(creds: DfsCreds) {
  const spots: { id: string; lat: number; lng: number; state: string }[] = PARAMS.spots || [
    { id: "Greensburg", lat: 39.3373, lng: -85.4836, state: "Indiana" }, { id: "HuberHeights", lat: 39.8439, lng: -84.1247, state: "Ohio" },
    { id: "TippCity", lat: 39.9598, lng: -84.1747, state: "Ohio" }, { id: "Lexington", lat: 38.0406, lng: -84.5037, state: "Kentucky" },
  ];
  const devices = ["desktop", "mobile"];
  const jobs: { kind: string; q: string; spot: (typeof spots)[number]; device: string; terr?: string }[] = [];
  if (!PARAMS.skipBranded) for (const q of NAMES) for (const spot of spots) for (const device of devices) jobs.push({ kind: "branded", q, spot, device });
  if (!PARAMS.skipService) for (const t of TERR) {
    const spot = { id: t.id, lat: t.lat, lng: t.lng, state: t.state };
    for (const x of queriesFor(t)) for (const device of devices) jobs.push({ kind: "service", q: x.q, spot, device, terr: t.id });
  }
  console.log(`# serp jobs ${jobs.length}`);
  await pool(jobs, 10, async (j) => {
    if (capped()) return;
    try {
      const body: any = { keyword: j.q, location_coordinate: `${j.spot.lat},${j.spot.lng},${ZOOM}`, language_code: "en", device: j.device, depth: 20, os: j.device === "mobile" ? "android" : "windows" };
      const { result } = await task(creds, "/serp/google/organic/live/advanced", [body]);
      const items: any[] = result?.items ?? [];
      const types = [...new Set(items.map((x) => x.type))];
      const paid = items.filter((x) => x.type === "paid").map((x) => ({ t: trim(x.title, 90), d: x.domain, desc: trim(x.description, 160) }));
      const pack = items.filter((x) => x.type === "local_pack").map((x) => ({ t: trim(x.title, 70), d: x.domain, ph: x.phone, w: whoIs(x), ...rv(x), paid: x.is_paid || undefined }));
      const kg = items.filter((x) => x.type === "knowledge_graph").map((x) => ({ t: trim(x.title, 80), sub: trim(x.sub_title, 80), cat: x.category, addr: x.address, ph: x.phone, d: x.url, desc: trim(x.description, 160), ...rv(x) }));
      const org = items.filter((x) => x.type === "organic").slice(0, 8).map((x) => ({ t: trim(x.title, 80), d: x.domain, w: whoIs(x) }));
      const paa = items.filter((x) => x.type === "people_also_ask").flatMap((x) => (x.items ?? []).map((y: any) => trim(y.title, 120)));
      const rel = items.filter((x) => x.type === "related_searches").flatMap((x) => x.items ?? []).map((s: any) => trim(typeof s === "string" ? s : s?.title, 80));
      console.log(`### SERP ${J({ kind: j.kind, terr: j.terr, from: j.spot.id, q: j.q, device: j.device, types, paid, pack, kg, org, paa, rel, inclu: result?.item_types?.length })}`);
    } catch (e) { console.log(`### SERP ERROR ${J({ q: j.q, from: j.spot.id, device: j.device, e: String(e).slice(0, 160) })}`); }
  });
  if (!PARAMS.skipSuggest) {
    const sj: { q: string; terr: string; state: string }[] = [];
    for (const t of TERR) for (const s of SERVICES) { sj.push({ q: s, terr: t.id, state: t.state }); sj.push({ q: `${s} ${t.city}`, terr: t.id, state: t.state }); }
    await pool(sj, 8, async (j) => {
      if (capped()) return;
      try {
        const { result } = await task(creds, "/serp/google/autocomplete/live/advanced", [{ keyword: j.q, location_name: `${j.state},United States`, language_code: "en" }]);
        console.log(`### SUGGEST ${J({ terr: j.terr, q: j.q, s: (result?.items ?? []).map((x: any) => x.suggestion) })}`);
      } catch (e) { console.log(`### SUGGEST ERROR ${J({ q: j.q, e: String(e).slice(0, 160) })}`); }
    });
  }
}

async function ai(creds: DfsCreds) {
  const jobs: { engine: string; t: Terr; svc: string; text: string }[] = [];
  const engines: string[] = PARAMS.engines || ["ChatGPT", "Perplexity", "Google AI Mode", "Google AI Overviews"];
  for (const t of TERR) for (const s of SERVICES) {
    const text = `${s} in ${t.city}, ${t.state}`;
    for (const e of engines) jobs.push({ engine: e, t, svc: s, text });
  }
  const readText = (result: any) => {
    const texts: string[] = []; const src: string[] = []; const seen = new Set<string>();
    const add = (a: any) => { const u = a?.url || a?.link; if (typeof u === "string" && !seen.has(u)) { seen.add(u); src.push(`${u} [${trim(a?.title ?? a?.domain ?? a?.source, 50)}]`); } };
    const walk = (o: any) => { if (!o || typeof o !== "object") return; if (Array.isArray(o)) { o.forEach(walk); return; } if (typeof o.text === "string") texts.push(o.text); for (const a of o.annotations ?? []) add(a); for (const a of o.references ?? []) add(a); if (Array.isArray(o.items)) walk(o.items); if (Array.isArray(o.sections)) walk(o.sections); };
    for (const it of result?.items ?? []) { if (it?.type === "ai_overview" || it?.type === "ai_mode" || !it?.type?.startsWith?.("organic")) { if (typeof it?.markdown === "string") texts.push(it.markdown); walk(it); } }
    for (const a of result?.sources ?? []) add(a);
    return { text: [...new Set(texts)].join(" ").replace(/\s+/g, " ").trim(), src };
  };
  console.log(`# ai jobs ${jobs.length}`);
  await pool(jobs, 4, async (j) => {
    if (capped()) return;
    try {
      let out: { text: string; src: string[] };
      if (j.engine === "ChatGPT" || j.engine === "Perplexity") {
        const seg = j.engine === "ChatGPT" ? "chat_gpt" : "perplexity"; const model = j.engine === "ChatGPT" ? (process.env.M_CHATGPT || "gpt-5.5") : "sonar-pro";
        const { result } = await task(creds, `/ai_optimization/${seg}/llm_responses/live`, [{ user_prompt: `Who are the best companies for ${j.text}? Name specific local companies.`, model_name: model, web_search: true, max_output_tokens: 1500, ...(seg === "chat_gpt" ? {} : { temperature: 0.3 }) }]);
        out = readText(result);
      } else if (j.engine === "Google AI Mode") {
        const { result } = await task(creds, "/serp/google/ai_mode/live/advanced", [{ keyword: j.text, location_coordinate: `${j.t.lat},${j.t.lng},${ZOOM}`, language_code: "en", device: "desktop" }]);
        out = readText(result);
      } else {
        const { result } = await task(creds, "/serp/google/organic/live/advanced", [{ keyword: j.text, location_coordinate: `${j.t.lat},${j.t.lng},${ZOOM}`, language_code: "en", device: "desktop", load_async_ai_overview: true, depth: 10 }]);
        out = readText({ items: (result?.items ?? []).filter((x: any) => x?.type === "ai_overview") });
      }
      const ht = /hi[\s-]?tec(h)?\s+industrial|hightec/i.test(out.text) || out.src.some((s) => /hightecindustrial\.com/i.test(s));
      const avs = /advanced vacuum services|\bAVS\b/i.test(out.text) || out.src.some((s) => /advancedvacuum\.com/i.test(s));
      console.log(`### AI ${J({ terr: j.t.id, engine: j.engine, q: j.text, ht, avs, err: out.text ? "" : "no answer", text: out.text.slice(0, 1500), src: out.src.slice(0, 12) })}`);
    } catch (e) { console.log(`### AI ERROR ${J({ terr: j.t.id, engine: j.engine, q: j.text, e: String(e).slice(0, 160) })}`); }
  });
}

async function listings(creds: DfsCreds) {
  const centers: { id: string; lat: number; lng: number }[] = PARAMS.centers || [
    { id: "Greensburg", lat: 39.3373, lng: -85.4836 }, { id: "HuberHeights", lat: 39.8439, lng: -84.1247 }, { id: "Lexington", lat: 38.0406, lng: -84.5037 },
  ];
  const likes: string[] = PARAMS.likes || ["%hi%tec%", "%high%tec%", "%hitec%", "%hi-tech%", "%advanced vacuum%", "%avs %", "%power%clean%industrial%"];
  const radiusKm = Number(PARAMS.radiusKm || 322);
  const jobs: { c: (typeof centers)[number]; like: string }[] = [];
  for (const c of centers) for (const like of likes) jobs.push({ c, like });
  await pool(jobs, 3, async (j) => {
    if (capped()) return;
    try {
      const { result } = await task(creds, "/business_data/business_listings/search/live", [{ location_coordinate: `${j.c.lat},${j.c.lng},${radiusKm}`, filters: [["title", "like", j.like]], limit: 100, order_by: ["rating.votes_count,desc"] }]);
      const items = (result?.items ?? []).map((x: any) => ({ t: trim(x.title, 70), cat: x.category, addl: (x.additional_categories ?? []).slice(0, 3), city: x.address_info?.city, st: x.address_info?.region, d: x.domain, ph: x.phone, ...rv(x), cid: x.cid, claimed: x.is_claimed }));
      console.log(`### LISTINGS ${J({ from: j.c.id, like: j.like, total: result?.total_count, n: items.length, items })}`);
    } catch (e) { console.log(`### LISTINGS ERROR ${J({ from: j.c.id, like: j.like, e: String(e).slice(0, 200) })}`); }
  });
}

async function reviews(creds: DfsCreds) {
  const cids: string[] = PARAMS.cids || []; const depth = Number(PARAMS.reviewDepth || 20);
  const posted: { cid: string; id: string }[] = [];
  for (const cid of cids) {
    try { const { raw } = await task(creds, "/business_data/google/reviews/task_post", [{ cid, location_name: "United States", language_code: "en", depth, sort_by: "newest" }]); posted.push({ cid, id: raw.id }); }
    catch (e) { console.log(`### REVIEWS ERROR post ${cid} ${String(e).slice(0, 200)}`); }
  }
  const pending = new Set(posted.map((p) => p.id)); const t0 = Date.now();
  while (pending.size && Date.now() - t0 < 8 * 60 * 1000) {
    await sleep(15000);
    for (const p of posted) {
      if (!pending.has(p.id)) continue;
      try {
        const j = await dfs(creds, "GET", `/business_data/google/reviews/task_get/${p.id}`); const t = j?.tasks?.[0];
        if (t?.status_code === 20000 && t.result?.[0]) {
          pending.delete(p.id); const r = t.result[0];
          const rev = (r.items ?? []).map((x: any) => ({ when: x.timestamp, rating: x.rating?.value, text: trim(x.review_text, 400), owner: !!x.owner_answer }));
          console.log(`### REVIEWS ${J({ cid: p.cid, title: r.title, rating: r.rating, reviews_count: r.reviews_count, newest: rev[0]?.when, items: rev })}`);
        } else if (t && ![20100, 40601, 40602].includes(t.status_code)) { pending.delete(p.id); console.log(`### REVIEWS ERROR ${p.cid} ${t.status_code} ${t.status_message}`); }
      } catch (e) { console.log(`### REVIEWS ERROR get ${p.cid} ${String(e).slice(0, 160)}`); }
    }
  }
  if (pending.size) console.log(`# reviews still pending after wait: ${pending.size}`);
}

(async () => {
  const creds = credsFromEnv();
  const bal = () => dfs(creds, "GET", "/appendix/user_data").then((j) => n(j?.tasks?.[0]?.result?.[0]?.money?.balance)).catch(() => null);
  const b0 = await bal();
  console.log(`RUN ${new Date().toISOString()} · HighTec local probe · PHASE=${PHASE} · read-only\n# balance before: ${b0 == null ? "unreadable" : "$" + b0.toFixed(4)} · cap $${CAP} · zoom ${ZOOM} · depth ${DEPTH}`);
  const phases: Record<string, (c: DfsCreds) => Promise<void>> = { discover, grid, serp, ai, listings, reviews };
  const fn = phases[PHASE]; if (!fn) throw new Error(`unknown PHASE ${PHASE}`);
  await fn(creds);
  const b1 = await bal();
  console.log(`\n# balance after: ${b1 == null ? "unreadable" : "$" + b1.toFixed(4)}`);
  console.log(`### JSON summary\n${J({ phase: PHASE, calls, spent: Number(spent.toFixed(4)), stopped, before: b0, after: b1 })}`);
})().catch((e) => { console.error(e); process.exit(1); });

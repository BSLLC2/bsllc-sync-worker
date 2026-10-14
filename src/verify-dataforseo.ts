#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv } from "./dataforseo.js";

/**
 * Read-only DataForSEO connectivity check. Calls the free /appendix/user_data
 * endpoint with DATAFORSEO_LOGIN/PASSWORD — runs no paid tasks — and prints the
 * account's remaining balance. Use it to confirm the API credentials are valid
 * before trusting the SEO/AEO importers.
 *
 *   npm run verify-dataforseo
 *
 * With --probe it ALSO fires one live task at each endpoint the research
 * workbench + authority card depend on (keyword_ideas, ranked_keywords,
 * domain_rank_overview, backlinks/summary), printing each endpoint's raw
 * status_code / status_message / item count. This is how we tell which
 * DataForSEO *products* the account plan actually includes — a keyword search
 * that "errors" in the UI is almost always a product the plan doesn't cover,
 * not a payload bug. Costs a few cents; run it deliberately.
 *
 *   npm run verify-dataforseo -- --probe
 */
const BASE = "https://api.dataforseo.com/v3";

function authHeader(login: string, password: string): string {
  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
}

/** POST one live task and report the outer + inner status without throwing. */
async function probe(auth: string, label: string, path: string, body: unknown): Promise<void> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) { console.log(`  ✗ ${label} — HTTP ${res.status}: ${text.slice(0, 200)}`); return; }
    const j = JSON.parse(text) as {
      status_code?: number; status_message?: string;
      tasks?: Array<{ status_code?: number; status_message?: string; result?: Array<{ items?: unknown[] } | unknown> }>;
    };
    const t = j.tasks?.[0];
    const result0 = t?.result?.[0] as { items?: unknown[] } | undefined;
    const items = Array.isArray(result0?.items) ? result0!.items!.length
      : Array.isArray(t?.result) ? t!.result!.length : 0;
    const ok = t?.status_code === 20000;
    console.log(
      `  ${ok ? "✓" : "✗"} ${label} — outer ${j.status_code}, task ${t?.status_code} ` +
      `"${t?.status_message ?? j.status_message ?? ""}"${ok ? `, ${items} item(s)` : ""}`,
    );
  } catch (e) {
    console.log(`  ✗ ${label} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  const creds = credsFromEnv();
  const auth = authHeader(creds.login, creds.password);
  const res = await fetch(`${BASE}/appendix/user_data`, { method: "GET", headers: { authorization: auth } });
  const text = await res.text();
  if (!res.ok) throw new Error(`DataForSEO user_data HTTP ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as {
    status_code?: number; status_message?: string;
    tasks?: Array<{ result?: Array<{ money?: { balance?: number }; login?: string }> }>;
  };
  if (j.status_code !== 20000) throw new Error(`DataForSEO error ${j.status_code}: ${j.status_message}`);
  const r = j.tasks?.[0]?.result?.[0];
  const balance = r?.money?.balance;
  console.log(`✓ DataForSEO auth OK — login "${r?.login ?? creds.login}", balance $${balance ?? "?"}`);

  if (!process.argv.slice(2).includes("--probe")) {
    console.log("  (read-only check — no paid tasks were run; pass --probe to test each endpoint)");
    return;
  }

  console.log("\nLive endpoint probes (one paid task each):");
  const loc = "United States", lang = "English";
  await probe(auth, "keyword_ideas (Labs)", "/dataforseo_labs/google/keyword_ideas/live",
    [{ keywords: ["personal injury lawyer"], location_name: loc, language_name: lang, limit: 5 }]);
  // THE CALL A KEYWORD RESEARCH RUN NOW USES FOR THE WHOLE COUNTRY (one per seed).
  // Its parameter names (`keyword` as a string, include_seed_keyword, order_by)
  // are the provider's published ones as far as this repository knows; nothing
  // here has called the endpoint, so this line is how to find out. A 40501 on it
  // names the parameter the provider did not accept.
  await probe(auth, "keyword_suggestions (Labs)", "/dataforseo_labs/google/keyword_suggestions/live",
    [{ keyword: "furnace brazing", location_name: loc, language_name: lang, limit: 5, include_seed_keyword: true, order_by: ["keyword_info.search_volume,desc"] }]);
  // The two calls a keyword research run uses for a place below the country.
  // The CITY form is the thing nothing here could test without an account, so
  // this is how to find out whether the plan accepts it. A 40501 on either line
  // means the account or the spelling does not, and a run in that place stops
  // with the provider's own sentence.
  await probe(auth, "keywords_for_keywords at a city (Keywords Data)", "/keywords_data/google_ads/keywords_for_keywords/live",
    [{ keywords: ["drug rehab"], location_name: "Cincinnati,Ohio,United States", language_name: lang }]);
  await probe(auth, "search_volume at a city (Keywords Data)", "/keywords_data/google_ads/search_volume/live",
    [{ keywords: ["drug rehab near me"], location_name: "Cincinnati,Ohio,United States", language_name: lang }]);
  await probe(auth, "ranked_keywords (Labs)", "/dataforseo_labs/google/ranked_keywords/live",
    [{ target: "nolo.com", location_name: loc, language_name: lang, limit: 5 }]);
  await probe(auth, "domain_rank_overview (Labs)", "/dataforseo_labs/google/domain_rank_overview/live",
    [{ target: "nolo.com", location_name: loc, language_name: lang }]);
  await probe(auth, "backlinks/summary (Backlinks)", "/backlinks/summary/live",
    [{ target: "nolo.com", internal_list_limit: 10, backlinks_status_type: "live" }]);
}

main().catch((e) => { console.error("✗ DataForSEO verify FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

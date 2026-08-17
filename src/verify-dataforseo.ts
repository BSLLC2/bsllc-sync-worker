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
 */
async function main() {
  const creds = credsFromEnv();
  const auth = "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64");
  const res = await fetch("https://api.dataforseo.com/v3/appendix/user_data", {
    method: "GET",
    headers: { authorization: auth },
  });
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
  console.log("  (read-only check — no paid tasks were run)");
}

main().catch((e) => { console.error("✗ DataForSEO verify FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

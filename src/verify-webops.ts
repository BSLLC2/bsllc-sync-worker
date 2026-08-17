#!/usr/bin/env tsx
import "dotenv/config";

/**
 * Read-only WP Umbrella connectivity check. Lists projects with the API key —
 * fetches no reports, writes nothing — and prints how many sites the key can
 * see. Confirms the WP Umbrella credentials before trusting the webops importer.
 *
 *   npm run verify-webops
 */
const BASE = (process.env.WP_UMBRELLA_BASE || "https://api.wp-umbrella.com").replace(/\/+$/, "");

async function main() {
  const token = process.env.WP_UMBRELLA_API_KEY?.trim();
  if (!token) throw new Error("Missing WP_UMBRELLA_API_KEY");
  const res = await fetch(`${BASE}/projects`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`WP Umbrella /projects HTTP ${res.status}: ${text.slice(0, 300)}`);
  let count = "?";
  try {
    const j = JSON.parse(text) as { data?: unknown[]; projects?: unknown[] };
    const list = Array.isArray(j.data) ? j.data : Array.isArray(j.projects) ? j.projects : Array.isArray(j) ? (j as unknown[]) : null;
    if (list) count = String(list.length);
  } catch { /* leave count unknown */ }
  console.log(`✓ WP Umbrella auth OK — ${count} project(s) visible to this key`);
  console.log("  (read-only check — nothing was written)");
}

main().catch((e) => { console.error("✗ WP Umbrella verify FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { runDashboardSync, type SyncEntry } from "./emit.js";
import { credsFromEnv, aeoCheck, AEO_PROVIDERS, type AeoResult } from "./dataforseo.js";

/**
 * Weekly AEO (Answer Engine Optimization) visibility tracking via DataForSEO's
 * AI Optimization API. For each client's tracked prompts (aeo_prompts), asks each
 * configured AI engine the prompt and records whether the brand is mentioned and
 * whether its domain is cited — then writes aggregate metrics through the sync
 * contract (source 'aeo'). This is the "are we showing up in ChatGPT / AI
 * Overviews / Perplexity / Gemini?" signal for the client report + health score.
 *
 *   npm run import-aeo            (live)
 *   npm run import-aeo -- --dry-run
 *   npm run import-aeo -- --client=some-slug
 *
 * Providers default to chatgpt,gemini,perplexity; override with AEO_PROVIDERS
 * (comma-separated). Cost scales with prompts × providers, so keep prompt lists
 * tight and cadence weekly.
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

interface ClientRow { id: string; name: string; brand_name: string | null; seo_domain: string | null; }

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var ${name}.`);
  return v.trim();
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const onlyClient = (argv.find((a) => a.startsWith("--client="))?.slice(9) || "").trim();
  const dashboardDir = req("DASHBOARD_DIR");
  const databaseUrl = req("DATABASE_URL");
  const creds = credsFromEnv();

  const providers = (process.env.AEO_PROVIDERS || "chatgpt,gemini,perplexity")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => AEO_PROVIDERS[p]);
  if (!providers.length) throw new Error("No valid AEO providers configured.");

  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  const syncs: SyncEntry[] = [];
  try {
    const clients = (await c.query<ClientRow>(
      `SELECT id, name, brand_name, seo_domain FROM clients`,
    )).rows;

    for (const client of clients) {
      const slug = slugify(client.name);
      if (onlyClient && slug !== onlyClient) continue;
      const prompts = (await c.query<{ prompt: string }>(
        `SELECT prompt FROM aeo_prompts WHERE client_id = $1 AND active = true`,
        [client.id],
      )).rows.map((r) => r.prompt);
      if (!prompts.length) continue;

      const brand = (client.brand_name?.trim() || client.name).trim();
      const domain = client.seo_domain?.trim() ? client.seo_domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null;

      // For each prompt, ask every provider; a prompt "counts" if ANY provider
      // mentions the brand (mention_rate) / cites the domain (citation_rate).
      const perProviderMentions: Record<string, number> = {};
      providers.forEach((p) => (perProviderMentions[p] = 0));
      let mentionedPrompts = 0;
      let citedPrompts = 0;
      let errors = 0;
      let calls = 0;

      for (const prompt of prompts) {
        const results: AeoResult[] = await Promise.all(
          providers.map((p) => aeoCheck(creds, p, prompt, brand, domain)),
        );
        calls += results.length;
        let anyMention = false;
        let anyCite = false;
        for (const r of results) {
          if (r.error) { errors++; continue; }
          if (r.mentioned) { anyMention = true; perProviderMentions[r.provider] = (perProviderMentions[r.provider] ?? 0) + 1; }
          if (r.cited) anyCite = true;
        }
        if (anyMention) mentionedPrompts++;
        if (anyCite) citedPrompts++;
      }

      const now = new Date();
      const periodStart = new Date(now.getTime() - 7 * 86_400_000);
      const base = {
        client_id: slug,
        source: "aeo" as const,
        period_start: periodStart.toISOString(),
        period_end: now.toISOString(),
      };

      const total = prompts.length;
      if (errors >= calls && calls > 0) {
        syncs.push({ ...base, data_state: "error", error_message: "all AI-engine calls errored", metrics: {} });
        console.log(`✗ ${slug}: all ${calls} AEO calls errored`);
        continue;
      }

      const metrics: Record<string, number | string | null> = {
        "aeo.prompts_tracked": total,
        "aeo.mention_rate": mentionedPrompts / total,
        "aeo.citation_rate": citedPrompts / total,
      };
      for (const p of providers) metrics[`aeo.mention_rate_${p}`] = (perProviderMentions[p] ?? 0) / total;

      syncs.push({
        ...base,
        data_state: "live",
        error_message: errors ? `${errors}/${calls} engine call(s) errored` : null,
        metrics,
      });
      console.log(`✓ ${slug}: mentioned in ${mentionedPrompts}/${total} prompts · cited ${citedPrompts}/${total} · providers ${providers.join(",")}`);
    }
  } finally {
    await c.end();
  }

  if (!syncs.length) { console.log("No clients with AEO prompts — nothing to sync."); return; }
  const code = runDashboardSync({ dashboardDir, databaseUrl }, syncs, { dryRun });
  process.exit(code);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

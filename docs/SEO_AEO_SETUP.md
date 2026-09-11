# SEO + AEO tracking — setup & turn-up

Moves routine keyword rank tracking and AI-answer visibility (AEO) off SEMrush's
metered API onto **DataForSEO**, feeding the client report and health score.

## What's already built
- **Dashboard**: per-client keyword list + AI-prompt list + domain/brand config,
  under a client's **Connected data** tab → "SEO & AEO tracking".
- **Worker**: `import-seo` (Google organic ranks) and `import-aeo` (brand
  citations across ChatGPT / Gemini / Perplexity), both weekly.
- **Health score**: a "Search & AI visibility" signal (15% share) for any client
  with live SEO/AEO data.
- **Monitoring**: `seo` / `aeo` sources + `seo_import` / `aeo_import` heartbeats
  show on Admin → Data health and the freshness monitor (weekly SLA).

## One-time setup (blocks the pipeline until done)
1. Create a **DataForSEO** account (https://dataforseo.com) — pay-as-you-go,
   $50 minimum deposit (lasts many months at ~10 clients / weekly cadence).
2. In DataForSEO, copy the **API login** and **API password** (the API
   credential pair, NOT your account email/password).
3. Add repo secrets on `bsllc-sync-worker`:
   - `DATAFORSEO_LOGIN`
   - `DATAFORSEO_PASSWORD`
   - *(optional)* `AEO_PROVIDERS` — comma list, default `chatgpt,gemini,perplexity`.
4. Per client, in the dashboard: set the **Domain to track**, **Brand name**
   (for AEO), and paste the **keyword list** (national/local + device) and
   **AI prompts**.

## Verify
- Dispatch **Import SEO ranks** with `dry_run=true` (Actions → workflow_dispatch),
  read the log: it prints `✓ <client>: N/M ranked · avg pos …`.
- Then dispatch **Import AEO** with `dry_run=true`: `✓ <client>: mentioned in
  N/M prompts …`.
- Drop `dry_run` (or wait for the Monday cron) to write for real; figures then
  appear on the client's health score + Connected-data tab.

## Cost (weekly, ~10 clients)
- SERP ranks: ~$0.60 / 1,000 lookups → a few dollars/month.
- AEO (LLM responses): base + tokens per prompt × provider — keep prompt lists
  tight; weekly cadence keeps it modest. Switch `AEO_PROVIDERS` to fewer engines
  to cut cost.

## Metrics written (metric_snapshots)
- `seo`: `seo.avg_position`, `seo.keywords_tracked`, `seo.keywords_ranked`,
  `seo.top3_share`, `seo.top10_share`, `seo.visibility`, `seo.ai_overview_share`
- `aeo`: `aeo.prompts_tracked`, `aeo.mention_rate`, `aeo.citation_rate`,
  `aeo.mention_rate_<provider>`

## Retiring SEMrush (Phase 2, later)
DataForSEO also covers keyword research (Labs/Keywords Data), site audits
(OnPage), backlinks, and keyword/backlink gap (Domain Intersection). Once
on-demand research tools for those exist in the dashboard, SEMrush can be
cancelled. Until then, keep the SEMrush seat for the manual research GUI.

## Keyword research (added 2026-09-10) — the Semrush replacement
Two entry points in the dashboard, one engine here:
- **Client page → SEO & AEO tab → "Keyword research"**: seeds (≤10) + optional
  competitor domain → the app stores a `research_requests` row with
  `kind='discovery'`, `client_id`, `params_json` (`{seeds, competitor, limit}`),
  and `estimated_cost_usd`. The app never calls DataForSEO — it only stores the
  row and (best-effort) dispatches `run-research.yml` via GitHub so the result
  lands in under a minute instead of on the 2-minute cron.
- **SEO research page** (sidebar): the older cross-client workbench — kinds
  `ideas`, `rankings`, `gap`.

`run-research` (`src/run-research.ts` → `keywordDiscovery()` in
`src/dataforseo.ts`) makes at most three Labs calls per discovery run:
1. `dataforseo_labs/google/keyword_ideas/live` with all seeds in one task
   (volume, CPC, competition, KD, intent, SERP features);
2. `ranked_keywords/live` for the client domain (≤1000) → each idea's
   `clientRank` ("you rank #N");
3. `ranked_keywords/live` for the competitor (≤700) when given → rows the
   competitor wins (top 50) that the client doesn't rank for, tagged `gap`.
Calls 2–3 are best-effort (a failure is logged as a warning; the ideas still
land). The sum of each task's `cost` field from DataForSEO's responses is
written to `cost_usd`, so the UI shows estimate vs actual.

**Cost guard.** The estimate the AM sees before clicking Run uses DataForSEO's
Labs list price ($0.01 per task + $0.0001 per returned row —
`DATAFORSEO_LABS_PRICING` in the dashboard's `shared/schema.ts`; confirm
against https://dataforseo.com/pricing when the plan changes). Inputs are
clamped server-side (≤10 seeds, ≤500 ideas) and a run estimated above $1.00 is
refused. A typical run (200 ideas + client rankings) is ≈ $0.13 worst case.

Smoke test from here without the UI:
```
npm run enqueue-research -- --kind=discovery --query="commercial roofing, flat roof repair" --target=client.com --competitor=rival.com
```
(or dispatch **Enqueue research** with `kind=discovery`.)

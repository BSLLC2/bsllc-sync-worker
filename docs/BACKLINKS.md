# Backlinks: own site and named competitors

`src/read-backlinks.ts`, `.github/workflows/read-backlinks.yml` (Sundays 05:20 UTC, dispatchable with a client and a
dry run that defaults to **true**), heartbeat `read_backlinks` (216 hours). Guard: `npm run verify-backlinks`, in CI.

## What it reads, per active client with the search module on and a recorded site

For the client's own site and up to **three competitors a person typed** (never picked by this job; the dashboard
stores them at `app_settings backlink_competitors:<clientId>` as `{ domains, by, at }`):

| Call | Path | Kept |
|---|---|---|
| summary | `/backlinks/summary/live` | backlinks, referring domains, referring main domains, broken backlinks, and COUNTS of links by type (anchor, image, other). **No anchor text.** |
| new and lost | `/backlinks/timeseries_new_lost_summary/live` | new and lost backlinks and referring domains over 30 days, summed |
| referring domains | `/backlinks/referring_domains/live` | the ten domains with the most links, with the count and first-seen date |

The competitors that outrank a client are NOT read here: the dashboard works them out from `seo_serp_results`, which the
weekly rank check already stores. This job makes no SERP call and no research call.

## Tables (the dashboard declares them, schema v304 provisional; this repo only writes)

`seo_backlink_summaries` (one row per client, domain and day), `seo_backlink_domains` (the ten referring domains per
target per day), `seo_backlink_runs` (one row per client: status, domains read, estimate, spend). A part that failed keeps
an earlier same-day value; a referring-domain list that failed is not replaced. Summaries are kept 400 days, domain lists
60 days.

## Cost

The run prices its plan **before any call** at `EST_USD_PER_DOMAIN` (our own estimate, $0.07) and **refuses the whole run**
when the estimate is over `BACKLINKS_RUN_BUDGET_CENTS` (a repository variable, default 150 = $1.50). A dry run prints the
estimate and reads nothing. During a run a domain is read only while the spend so far plus one more domain's estimate stays
inside the budget; the rest are `capped` and keep their earlier rows. The real charge is read from each answer.

## Secrets

`DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` (the research runner's own). With them missing, a client that has a plan is
marked `no_key` and the run exits 1 naming them. `DATABASE_URL`.

## UNVERIFIED LIVE

Nothing here has run against DataForSEO. The three paths, the request bodies (`include_subdomains`,
`backlinks_status_type: "live"`, `group_range: "month"`, `order_by: ["backlinks,desc"]`), the answer fields
(`referring_links_types`, `new_backlinks`, `lost_backlinks`, `new_referring_domains`, `lost_referring_domains`, `first_seen`)
and the per-call prices are from the published reference. Run once with `dry_run` true, then once for one client.

# Meta ads in depth: what is unverified, and how the first dry run settles it

Nothing in `ads_meta_days` has run against a live Meta account. Every Graph field,
breakdown and enum below was written from the published Marketing API reference and
the existing adapters, and is a guess until a real account answers. The job is
read-only (every request is a GET) and dispatches as a dry run by default.

**First run:** Actions, "Meta ads in depth (read-only)", `client` = one slug,
`dry_run` = true. It prints one line per account: ad-days, segment-days and entities
read, and every problem by name. Read it, then run again with `dry_run` = false for
that one client, then check the `meta_scans` rows (ok, rows_read, covered span).

| # | Assumption | Where it lives | How the first run confirms it |
|---|---|---|---|
| 1 | Graph version `v21.0` serves everything below | `META_GRAPH` in `src/meta/insights.ts` | Any 400 naming an unknown field or version. |
| 2 | `level=ad` insights with `time_increment=1` and `time_range={"since","until"}` returns one row per ad per day | `src/meta/depth-run.ts` | Part `ad_days` reads rows; `date_start` equals `date_stop` on every row (a row with a range is refused as unplaceable). |
| 3 | `AD_DAY_FIELDS`: `campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend, impressions, reach, frequency, inline_link_clicks, actions, action_values` are all valid at ad level | `src/meta/depth.ts` | A 400 "fields" error on the ad-day read. Reach and frequency come back null if Meta drops them at this level; the frequency rules then stay silent and say so. |
| 4 | `reach` and `frequency` at `time_increment=1` are that day's figures, not additive | rule comments in `src/meta/rules.ts` | Compare the sum of daily reach against a window-level `reach` request by hand. The rules use impressions / sum of daily reach as a LOWER bound, so a wrong assumption makes them quieter, never louder. |
| 5 | `breakdowns=publisher_platform,platform_position` is accepted at `level=adset` with `time_increment=1` and the fields in `SEGMENT_FIELDS` | `SEGMENT_BREAKDOWNS` | Part `segments`. Meta refuses some breakdown and field combinations; a refusal fails the whole segments part by name and writes nothing. |
| 6 | `breakdowns=age` and `breakdowns=gender` are accepted the same way (counts of delivery, never a person) | `SEGMENT_BREAKDOWNS` | As above. |
| 7 | A placement row carries both `publisher_platform` and `platform_position` | `segmentLabel` | A row without both is unplaceable and refuses the part. |
| 8 | Action type names `lead`, `offsite_conversion.fb_pixel_lead`, `onsite_conversion.lead_grouped`, `omni_purchase`, etc. | `ACTION_FAMILIES` (existing) | Compare conversions against Ads Manager for one day. `objective_results` is NOT requested here; whether it exists at ad level is untested. |
| 9 | Entity edges `/{act}/campaigns`, `/adsets`, `/ads` list all entities (any status) with the fields in `CAMPAIGN_FIELDS`, `ADSET_FIELDS`, `AD_FIELDS` | `src/meta/depth.ts` | Part `entities`. Meta's default listing may hide archived or deleted entities; if a paused-then-deleted ad matters, a `filtering` clause is needed. |
| 10 | `daily_budget` and `lifetime_budget` are strings in the account currency's MINOR unit (cents), so x 10,000 = micros | `minorToMicros` | Compare one ad set's budget against Ads Manager. WRONG for zero-decimal currencies (JPY): the figure would be 100 times too small. The existing adapter makes the same assumption. |
| 11 | `learning_stage_info.status` returns `LEARNING`, `SUCCESS`, `FAIL` or similar, and `LEARNING_LIMITED` for an ad set the platform says will not settle | `meta_thin_signal`, `src/ads/rules.ts` `learning_limited` | The rule skips an ad set whose status is `LEARNING_LIMITED` so it never repeats the platform's own finding. If the string differs, the two findings overlap. |
| 12 | `effective_status` is `ACTIVE` for something delivering | `isActive` in `src/meta/rules.ts` | A live ad set read as not active makes pacing, thin signal, winner and loser silent. |
| 13 | `objective` values `OUTCOME_LEADS`, `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`, `OUTCOME_ENGAGEMENT` (API v21) and the legacy names | `NON_CONVERSION_OBJECTIVES` | `meta_tracking_gap` stays silent for an account whose live campaigns all ask for awareness, traffic or engagement. A different spelling would raise a false gap. |
| 14 | `optimization_goal` values (`REACH`, `LINK_CLICKS`, `LANDING_PAGE_VIEWS`, `THRUPLAY`, ...) | `NON_CONVERSION_GOALS` | `meta_thin_signal` skips these. A goal missing from the list is read as a conversion goal. |
| 15 | The row ceilings (50,000 per part, 20,000 entities per type) and the 400-page ceiling are never reached on a real account | `src/meta/depth.ts`, `graph.ts` | A part that reaches one writes nothing and says so. Raise the constant if a real account needs it. |
| 16 | Rate-limit error codes `1, 2, 4, 17, 32, 341, 613, 80000, 80003, 80004, 80006` are the transient ones | `RETRY_CODES` in `src/meta/graph.ts` | A real rate-limit answer is retried; an unknown code fails the part. |
| 17 | The system user behind `META_ACCESS_TOKEN` needs `ads_read` only and each client's ad account granted to it | `docs/META_CONNECTOR_SETUP.md` | A permission error names the account; the others still read. |

## Floors (our own lines, not published anywhere)

All in `META_FLOORS` in `src/meta/rules.ts`, and printed on every finding. Meta's own
guidance of about 50 optimisation events a week to leave learning is treated as our line
too (row 11 above). Nothing in a finding states why a figure moved.

## What the app needs to mirror

`ADS_RULESET_VERSION` is 13 in `src/ads/rules.ts`. The dashboard repo's own constant, its
finding-type list (`ADS_FINDING_TYPES`, label, stage, rank basis, vendor target) and its v312
DDL must carry the eight `meta_*` types and the four tables as written in
`src/meta/depth-store.ts` (including `id`, `synced_at`, and on `meta_entities` `content_hash`
and `updated_at`).

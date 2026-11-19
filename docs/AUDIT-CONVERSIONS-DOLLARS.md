# Audit: conversions and dollars

A READ-ONLY job that shows, for one client, what the OS stores for conversions and
dollars, which stored figure each headline tile reads, and what is odd about it, so a
person can hold it beside Google Ads, GA4 and Meta by eye. Written for the Tablespoon
question: the OS showed 52 results and $32.8k revenue in Jan to Mar when ads were off,
0 results in Apr to Jun despite 788 clicks, and a cost per conversion of $29 to $36
against about $13.40 in the Google Ads export.

Nothing here was run against a live service. Every guard runs on invented fixtures.

## How to run it

Dry-run is the only mode. It writes nothing: SELECT-only SQL (the session is also set
read-only), GET-only HTTP, no heartbeat row.

GitHub, `BSLLC2/bsllc-sync-worker`, Actions, **Audit conversions and dollars (read-only)**,
Run workflow:

1. `client`: `tablespoon` (a slug or a name; `all` audits up to 5 live clients).
2. `days`: leave 30 (the window for the two live reads, ending yesterday).
3. Open the run. The report is in the log and attached as the artifact
   `conversions-dollars-audit`.

From a terminal with the secrets: `npm run audit-conversions-dollars -- --client=tablespoon`
(options `--days`, `--since=YYYY-MM` (default 1 January), `--max` (client cap), `--out`).

Secrets used, all existing: `DATABASE_URL`, `GOOGLE_SERVICE_ACCOUNT_JSON` (GA4), `META_ACCESS_TOKEN`.
A missing one skips its section with a plain line.

## What each section means

- **What the OS stores, month by month.** Every stored figure for the audited keys
  (ads cost, clicks, conversions, verified conversions, conversion value, cost per
  conversion, GA4 conversions and revenue, Square, HubSpot, D365, manual, Meta) with its
  source and data state. Units are converted once: micros and cents are shown as dollars,
  conversion value is already dollars. "not stored" is unanswered, never zero. Rolling
  30-day rows are set aside and counted.
- **How the tiles are calculated.** Which stored figure the Conversions and Revenue
  tiles would read that month, by the dashboard's own priority order, in words. When two
  or more revenue sources are live it says the tile ADDS them and lists each part.
- **Flags.** Conversions chosen from a non-ad source while ads exist (and the stronger
  version when ad spend was $0); revenue summed from 2+ sources; revenue shown while ad
  spend was $0; clicks with zero or no conversion figure (possible broken tracking); a
  stored cost per conversion that does not equal spend over conversions; the daily ad
  record disagreeing with the monthly snapshot by more than 5%.
- **Platform-reported ROAS** only where spend and conversion value for the SAME platform
  both exist.
- **Ads daily record (coverage)** and **conversion actions**: which conversion actions
  counted, their category, whether primary, and whether counted in Conversions. "not stored"
  when the table or snapshot kind is absent.
- **GA4 (live)**: event names with counts and the key-event flag, and sessions, key events
  and revenue by channel group (so paid and other are visible).
- **Meta (live)**: per campaign, spend, objective, and the actions and action values BY
  ACTION TYPE under the 1d_click, 7d_click and 1d_view windows, beside what the OS would count.

The headline order is a copy of `HEADLINE_SNAPSHOT_METRICS` in the dashboard repo
(`shared/schema.ts`, about line 13326) and the revenue summing rule in `getSnapshotTiles`
(`server/storage.ts`). If that order changes there, change `src/audit-conv/headline.ts` here.

## Guard

`npm run verify-audit-conversions` (in CI): behaviour checks over a fixture shaped like the
reported case, static checks that the source has no write SQL, write verb, heartbeat or
person field, and 17 planted failures that each must fail a named check.

## Assumptions written from documentation and NOT verified live

1. GA4 `runReport` accepts the `isKeyEvent` dimension with `eventName` (the audit retries without it on a 400).
2. GA4 metrics `purchaseRevenue`, `totalRevenue`, `ecommercePurchases` and `keyEvents` exist on the property (the audit steps down a ladder on a 400, and says which set it used).
3. `sessionDefaultChannelGroup` splits paid from other traffic the way the dashboard's channel labels do.
4. Meta Graph `v21.0` `insights` at `level=campaign` accepts the fields `campaign_name,objective,spend,impressions,inline_link_clicks,actions,action_values,attribution_setting`.
5. The `action_attribution_windows` parameter with `["1d_click","7d_click","1d_view"]` makes each action entry carry per-window keys of the same names.
6. Meta `spend` is a decimal string in account currency (the existing importer's rule), converted to micros once.
7. Meta `objective` is returned at campaign level.
8. The conversion-action settings (category, primary, counted in Conversions) are the ones the daily structure snapshot stores in `attrs_json`; if the worker has not written that kind, those columns read "not stored".
9. A month row in `metric_snapshots` starts on the 1st (within a 12 hour nudge) and spans at most 32 days; anything else is treated as a rolling window.
10. The 5% daily-versus-monthly spend tolerance and the 10% cost-per-conversion tolerance are our own lines.
11. Connection by `connector_mappings` (`ga4` and `meta` sources, enabled, external id set) finds the right property and ad account.
12. GA4's runReport is a POST by API design; it reads and goes through the existing shared reader.

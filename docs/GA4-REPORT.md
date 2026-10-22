# Website performance report (Google Analytics 4)

A Looker-Studio-style report for a client's dashboard: overview totals, a daily
trend, visitors by region, traffic sources, landing pages, form submissions by
page, named page groups, and (for the team only) which event names the property
counts. The dashboard app only reads Postgres. **This worker is the only thing
that reads Google.** Job name `read_ga4_report`.

Nothing here was run against a live property. Every request shape below is
written from the Data API documentation; "least certain" ones are listed at the
end. The guard (`npm run verify-ga4-report`) proves the code against a pretend
Google and a scratch Postgres, not that Google answers in these shapes.

## What it reads

Per client with an enabled `ga4` connector mapping (the same property the
page-behaviour reader resolves), through `runReport`, over the last N complete
calendar months (default **24**, `--months=`, at most 36) plus the days of the
current month up to today minus 2 days (the GA4 lag the page-behaviour reader
uses).

1. **Daily totals** (`ga4_site_days`): dimension `date`; metrics `sessions`,
   `engagedSessions`, `userEngagementDuration`, `totalUsers`, `keyEvents`. On a
   400 the metric ladder falls back (`keyEvents` then `conversions` then neither,
   then fewer metrics). A dropped metric is a NULL column, never a zero.
2. **By month x dimension** (`ga4_report_rows`), with `yearMonth` as the first
   dimension, the busiest N per month kept:

   | kind | dimensions after yearMonth | metric | parent | key | top N |
   |---|---|---|---|---|---|
   | `region` | country, region | sessions, engaged, seconds | the country | the region | 100 |
   | `source_medium` | sessionSourceMedium | same | '' | "source / medium" | 100 |
   | `landing_page` | landingPage | same | '' | normalised path | 100 |
   | `form_page` | pagePath (filter eventName = form event) | eventCount -> `events` | '' | normalised path | 100 |
   | `event_name` | eventName | eventCount -> `events` | '' | the event name verbatim | 100 |
   | `group_page` | landingPage (BEGINS_WITH prefix) | same as sessions | the prefix | normalised path | 300 per group |
   | `group_form` | pagePath (BEGINS_WITH prefix AND eventName = form event) | eventCount -> `events` | the prefix | normalised path | 300 per group |

   | `group_visits` | pagePath (BEGINS_WITH prefix) | sessions | the prefix | normalised path | 300 per group |
   | `channel_sessions` | sessionDefaultChannelGroup | sessions | '' | the channel group | 40 |
   | `channel_forms` | sessionDefaultChannelGroup (filter eventName = form event) | eventCount -> `events` | '' | the channel group | 40 |

   `group_visits` counts any visit that touched the page; `group_page` counts engagement on
   visits that started there. `channel_sessions` and `channel_forms` are ALWAYS read without
   any channel exclusion, so the app can show what an exclusion removes.

   `(not set)` is kept as its own key for regions and sources; a path that is
   not a real path is dropped. Several spellings of one path (query string,
   trailing slash, host) are summed.
3. `event_name` is a team diagnostic ("which events does the property count").
   It is never shown to a client.

## The settings it applies

`app_settings` row `web_report_config:<clientId>`, JSON
`{ excludeCountries, excludeChannels, groups: [{name, prefix}], formEvent, by, at }`. Sanitised:
a missing or unparseable value means no exclusions, no groups, form event
`form_submit`; countries max 25 (trimmed, case-insensitive duplicates dropped);
groups max 5 (prefix must start with `/`, at most 120 characters, no spaces);
event name must match `^[a-z][a-z0-9_]{0,39}$`.

**Exclusion semantics.** When `excludeCountries` is not empty, **every** request,
the daily one included, carries a `notExpression` over an `inListFilter` on
`country`, combined with any other filter in an `andGroup`. So the totals, the
trend and every list leave out the same traffic. The applied list is stored on the
run row (`excluded_countries`, a JSON array) so the app can say exactly what was
left out. **Channels.** `excludeChannels` (max 6, each one of `CHANNEL_GROUPS`, Google's own names, matched
case-insensitively and sent in Google's spelling) is applied the same way on `sessionDefaultChannelGroup`
to every request EXCEPT the two channel kinds; the applied list is stored on the run row
(`excluded_channels`, schema v264). None is left out by default. No other bot filter is applied and none is invented.

## What is written (the contract)

The app declares and creates `ga4_site_days`, `ga4_report_rows`,
`ga4_report_runs`; **the worker never creates or alters them.** Per client, in one
transaction:

- daily rows are upserted on `(client_id, day)`;
- for each kind that read in full, that client's rows of the kind for the months
  read are deleted and re-inserted (a month GA4 restated replaces itself; a month
  with no rows for a kind stays absent, which the app reads as "nothing" inside
  the run's month span). Group kinds with no groups configured read as empty, so
  the rows of a removed group clear;
- a kind that **failed** (or was too big to read in full) is left exactly as it
  was and named in `failed_kinds`;
- the run row is upserted last.

If the daily read fails nothing is written for the client but the run row
(`status = error`). GA4 sends no row for a day with no sessions, so a missing day
**inside the span** is written as an explicit zero (a metric the property did not
return stays null); nothing outside the span is written.

**Span detail (a refinement of the contract's wording).** `first_day` is the first
day with traffic in the window, not necessarily the window's first day: days before
the property had any traffic are not written as zeros (they would claim years of
"zero sessions" before the property existed). `last_day` is the window's last day.
`first_month` / `last_month` follow the span (`last_month` may be a part month; read
`last_day`).

**Run row.** `status` is `ok | off | error | no_data | capped` (`no_key` is in the
vocabulary and not used: the service account is the only credential).
`capped_kinds` are kinds cut to the busiest per month (information);
`failed_kinds` are kinds not written. `status = ok` can carry `failed_kinds`
(daily totals read, one report did not); `error` means the daily read failed, the
token failed, or every report failed. `capped` means the daily read or a report
was too big to read in full (past 200,000 rows; paged 25,000 at a time). A run
that wrote no rows (off, error, no_data, too big) keeps the earlier span and the
earlier applied config on the run row, since the rows still in the tables are from
that earlier run.

## What is NOT read

No user, device or session id, no IP, no GA4 client id, no demographics, no
e-commerce, no per-visitor anything. Counts and aggregates only. No other table is
written; the heartbeat row is stamped by the workflow.

## Running it

```
npm run read-ga4-report -- --dry-run            # every client, prints counts per kind and the first five keys, writes nothing
npm run read-ga4-report -- --client=<uuid> --dry-run
npm run read-ga4-report -- --client=<uuid>      # one client for real
npm run read-ga4-report                          # every client
```

Needs `DATABASE_URL` and `GOOGLE_SERVICE_ACCOUNT_JSON` (both existing; the service
account must be a user on each property). One client's failure never stops the
others; casualties are listed last; the command exits 1 only if no client with a
property could be read.

## First run

1. Deploy the dashboard app so the three tables exist (a real run stops with a
   plain message if they do not; a dry run does not need them).
2. Actions, "Read website performance (Google Analytics 4 report)", Run workflow:
   leave `dry_run` true, `client_id` blank. Read the counts.
3. Run it again for one client with `dry_run` false, check the dashboard, then
   leave the daily schedule (07:40 UTC) to run. The heartbeat `read_ga4_report`
   is stamped only by a live whole-book run (a dry run and a one-client run do not
   stamp it).

## Least certain request shapes (none verified live)

1. `yearMonth` together with `country`+`region` in one request (compatibility).
2. `landingPage` with a `BEGINS_WITH` filter (landing page values carry query
   strings; the prefix match assumes the path comes first).
3. `notExpression` over `inListFilter` on `country`, inside an `andGroup`, on a
   request that does not have `country` as a dimension.
4. `eventName` filter together with `pagePath` and `eventCount`, and `eventName`
   as the only dimension for the diagnostic.
5. `sessionSourceMedium` in the same request as `yearMonth`.
6. `keyEvents` vs `conversions` availability on older properties (the ladder
   handles it); the `orderBys` mixing a dimension and a metric.
7. Paging with `offset` (the offset follows rows received) and `rowCount`.

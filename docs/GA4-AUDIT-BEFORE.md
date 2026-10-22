# The stored GA4 report, before the audit: what it asks, what it returns, where it falls short

Read from `src/read-ga4-report.ts` and `src/ga4-report/*` at `main` f29d2da, and from the logs of the two runs
against Brownell Travel (`--client=5b4872f4-e86e-4db9-8db6-0c341e1571bc`): the dry run that printed per-kind
counts, and the real run that returned 10,379 rows in 3m 42s. Nothing here was re-run for this note.

## What it asks Google Analytics 4

One Data API `runReport` call (paged at 25,000 rows, up to a 200,000-row ceiling) per line. The window is the last
24 complete months plus the days of this month up to three days ago. Country and channel exclusions typed in the
dashboard go on every request except the two channel reports.

| Kind (table `ga4_report_rows`) | Dimensions | Metrics | Filter | Rows kept | Brownell rows |
|---|---|---|---|---|---|
| daily totals (`ga4_site_days`) | date | sessions, engaged sessions, engagement seconds, users, key events | exclusions | every day | 750 (2024-10-01 to 2026-10-20) |
| `region` | month, country, region | sessions, engaged, seconds | exclusions | busiest 100 a month | 2,500 |
| `source_medium` | month, source / medium | same | exclusions | busiest 100 a month | 2,403 |
| `landing_page` | month, landing page | same | exclusions | busiest 100 a month | 2,500 |
| `form_page` | month, page path | event count | event = form event, exclusions | busiest 100 a month | 1,685 |
| `event_name` | month, event name | event count | exclusions | busiest 100 a month | 262 |
| `channel_sessions` | month, channel group | sessions, engaged, seconds | country exclusion only | busiest 40 a month | 167 |
| `channel_forms` | month, channel group | event count | form event, country exclusion only | busiest 40 a month | 112 |
| `group_page` | month, landing page | same as landing | landing page begins with each group prefix | busiest 300 a month and group | 0 (no group was set) |
| `group_visits` | month, page path | sessions, engaged, seconds | page path begins with each group prefix | busiest 300 | 0 |
| `group_form` | month, page path | event count | form event and prefix | busiest 300 | 0 |

The rows add to the 10,379 the run reported: 750 + 2,500 + 2,403 + 2,500 + 1,685 + 262 + 167 + 112 = 10,379.
The three group kinds returned nothing because the run used the settings stored before groups were typed in.

## Where it differs from what is now known about the property

1. **It stores top-100 lists, not the data a defence needs.** Region and landing page hit the 2,500-row ceiling
   (24 months x 100): the cut drops the long tail every month, so per-advisor and per-path figures cannot be summed
   or compared across months from it. Advisor pages in particular are a long tail of hundreds of small pages.
2. **No reconciliation.** It reports one filtered basis. It never shows raw sessions, then the effect of each rule,
   and it has no check against the stored Looker Studio figures (37,863 sessions, 25,072 engaged, 66.22% for
   Jan 1 to Sep 30, 2026).
3. **Bot handling is whole channels only.** The only rules are "leave out Direct" and "leave out Unassigned" (and
   typed countries). Direct includes real people (untagged Instagram, bookmarks, typed addresses) and the flood
   (about 591,000 sessions at 2.8% engagement on `/plan-your-trip/advisor` and old `/hotel-destinations/` paths,
   Nov 2025 to Aug 2026). There is no breakdown of the flood by landing path, country, city or source, and no
   narrower rule.
4. **Page groups cannot separate the directory from the microsites.** A group is a path prefix and a prefix cannot
   repeat, so `/plan-your-trip/advisor/` cannot be both the directory page and the start of every microsite. Group
   rows are also keyed to landing pages (`group_page`), which misses a visitor who entered elsewhere and then looked
   at an advisor page.
5. **`form_submit` is read as a count and nothing more.** It is split by page (`form_page`) but not by page group
   and month, `form_start` is not read at all, and there is no weekly series, so the mid-August 2026 step change
   cannot be located or tested. Nothing says the event also fires on the homepage advisor search and the directory.
6. **No per-advisor reading.** The advisor name is not extracted from the path, and views, sessions, submits per
   session and engagement are not computed per advisor.
7. **No period comparison.** The stored rows carry months, so a prior period and a prior year have to be assembled
   by hand, and a window that touches Nov 2025 to Aug 2026 is not flagged as not comparable.
8. **Sources are not classified.** Facebook, Instagram, AI assistants (`chatgpt.com` appears as both an
   `ai-assistant` and a `referral` row) and email are not grouped, and nothing notes that untagged Instagram clicks
   arrive as Direct.
9. **No Search Console.** The stored report never reads it. Search Console is not affected by bots, so it is the
   independent check on whether the bot filter is right, and it is the only way to say whether the form drop follows
   a drop in search clicks.
10. **No anomaly flags or projection, no help for the person presenting it.**
11. **Engineering.** The Postgres connection string uses `sslmode=require`, which this version of `pg` treats as an
    alias for `verify-full` and warns about; the workflow pins `actions/checkout@v4` and `actions/setup-node@v4`,
    which GitHub now forces onto Node 24.

## What stays as it is

The stored report keeps feeding the dashboard's Website performance section. It stays read-only toward Google and
write-only toward its three tables. The audit described in `docs/GA4-AUDIT.md` is a separate read that writes no
database rows at all.

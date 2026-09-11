# Agent report — Tests and CI (worker side)

Branch `agent/tests-ci`, on main `717a476`. The full report, covering both
repos, is `docs/agent-reports/tests-ci.md` in **bsllc-account-health**. This is
the worker half.

## Pass/fail

```
npx tsc --noEmit   clean (tests/ now included, so the suite typechecks too)
npm test           61 passed | 1 skipped (62) in 3.70s
```

The 1 skipped is the placeholder that prints *why* `connector-health.test.ts`
skipped when `TEST_DATABASE_URL` is unset. With a database set — which CI always
does — it does not appear and all 16 of that file's tests run.

```bash
npm test                  # everything
npm run check:conflicts   # conflict markers in tracked files
TEST_DATABASE_URL=postgresql://... npm test   # including the SQL test
```

## Runner

Vitest, the same as the dashboard, so `npm test` means the same thing in both
repos. `vitest.config.ts` is 20 lines. `TZ` is pinned to `America/New_York`:
every date here is UTC by construction (`ymd()` goes through `toISOString`), and
pinning a real offset is what proves a non-UTC runner cannot change an answer.

## Covered — the helpers that have already caused incidents

**`monthSnapshot` (src/dates.ts).** The in-progress month is capped at **today**
and stamped `now`, so it can never write a future `period_end` or `synced_at`. A
future `synced_at` out-ranks every later, correct row in a "latest reading" pick,
so a stale number kept winning and Data health reported a bad timestamp every
morning. Asserted for all twelve months, both sides of the
finished/in-progress boundary (on the last day of the month and the day after),
leap years, and the compact `YYYYMM` key some importers pass. A finished month
keeps its real end date and a backdated noon-UTC `synced_at`, because a backfill
that stamps "now" makes every trend delta disappear.

**The Search Console 16-month retention clamp.** Extracted from
`import-gsc-api.ts` into `src/dates.ts` as `gscRetentionFloor` /
`clampSinceToGscRetention`. Tested at the boundary exactly — the floor itself is
allowed, one day earlier is clamped — with OCH's Aug-2024 contract start, and
with the invariant that no input can produce a `since` older than the floor.
Asking for older data 400'd, failed the whole backfill, and left an `error` row
newer than every good one, which then made connector health call Search Console
failing until somebody noticed.

**The failing-connector rule, against real Postgres, running the real SQL.** The
rule is: the newest `error` row is **strictly** newer than the newest
`live`/`no_data` row. The query text moved into `src/connector-health.ts` so the
morning audit and the test share one string — a test against a TypeScript
re-implementation would prove nothing about the query that ships. 16 cases:
error-only, error after success, success after error, `no_data` as a success,
`no_data` older than the error, the same-instant tie, per-source and per-metric
isolation, a disabled mapping, an unmapped source, every client status, a
future-dated row, the newest error message winning, and one row per connector
rather than one per metric key.

Both clauses are **mutation-checked**. Changing `IN ('live','no_data')` to
`= 'live'` fails the no_data test; changing `>` to `>=` fails the strictly-newer
test. Worth recording: the first draft of these tests passed under **both**
mutations, because the error and the success shared a metric key and the
`latest` CTE dropped the error before the comparison ever happened. They now use
distinct keys, which is what makes the clauses load-bearing.

**Job cadence, both kinds.** They answer different questions and it is easy to
assume there is one:

- `src/audit-jobs.ts` (extracted from `audit-and-repair.ts`) — the audit's fixed
  re-run windows: 26h for a daily job so a late start is not "stale", 14h for
  the twice-daily HubSpot deals, 8 days for the weekly importers. `--mode=plan`
  turns this into the `rerun=` output the workflow re-runs from, so a wrong
  window either silently skips a broken importer or re-runs all fourteen every
  morning. Tested at each boundary, plus: a FAILED run is stale however recent,
  an unparseable timestamp is stale rather than fresh, and a heartbeat for an
  untracked job is ignored.
- `src/job-cadence.ts` (already existed) — derives a freshness SLA from the
  `cron:` lines in `.github/workflows`. Tested on daily, twice-daily,
  weekday-only (the weekend is the gap) and weekly crons, on the SLA's slack
  floor, and against the real workflow directory.

Plus a cross-check between them: every job the audit re-runs must have a
workflow that stamps its heartbeat — one that doesn't could never come back
healthy.

**GSC monthly bucketing.** Moved to `src/gsc-monthly.ts`, because
`import-gsc-api.ts` calls `main()` on import and nothing inside it was reachable
from a test. Average position is **impressions-weighted**: a day with three
impressions at position 2 must not outweigh a day with three thousand at
position 20, which a naive average of daily averages does (it would report 11 on
a month that really sat at 20). A month with no impressions returns `null`, not
`0`, which would render as the best possible ranking on a client's card.

## Not covered

- Every importer's network path. Google Ads, GA4, GSC, HubSpot, D365, QBO,
  Slack, Dialpad, DataForSEO — no client is contacted or mocked. Only the pure
  helpers around them are tested.
- `match-web-leads-to-crm`, which writes the `lead_attributions` rows that basis
  **b** of the revenue rule reads. This is the top worker-side risk: a wrong
  match or a wrong bucket becomes a wrong *published* revenue figure with a
  confident basis line under it. It needs recorded CRM fixtures.
- `emit.ts` / `runDashboardSync` — the seam that actually writes
  `metric_snapshots`.
- The ~120 `debug-*` and `oneoff-*` scripts, deliberately. They are one-shot
  investigation tools, not a path anything depends on.
- The daily brief and `post-to-slack` message formatting.

## CI

`.github/workflows/ci.yml`, on push to any branch and on pull request, with
`concurrency` so a new push cancels the previous run. Two jobs:

1. **`No conflict markers`** — no install, runs
   `scripts/check-conflict-markers.mjs` (the same script as the dashboard) over
   every tracked file. Verified clean on 350 files and exit 1 with a
   `file:line` list on a planted marker.
2. **`Typecheck and test`** — `npm ci` with the npm cache, `npm run typecheck`,
   `npm test`, with a Postgres 16 service container so the SQL test really runs
   instead of skipping. There is no bundle step in this repo — every entry point
   runs under `tsx` — so typecheck plus the suite is the whole gate.

Making it required: Settings → Branches → protect `main`, tick **Require status
checks to pass** and **Require branches to be up to date**, and add both check
names. The CLI form is in the dashboard's copy of this report.

## Files

```
vitest.config.ts
tests/{dates,audit-jobs,gsc-monthly,connector-health}.test.ts
src/connector-health.ts    the failing-connector SQL, shared with the test
src/audit-jobs.ts          the audit's re-run windows
src/gsc-monthly.ts         bucketMonthly, out of the main()-on-import module
scripts/check-conflict-markers.mjs
.github/workflows/ci.yml
```

**No behaviour changed.** The three extractions are moves: `src/dates.ts` gained
the clamp, and `import-gsc-api.ts` and `audit-and-repair.ts` now call the
extracted helpers and the SQL constant instead of holding their own copies.
`tsconfig.json` gained `tests/**/*.ts`.

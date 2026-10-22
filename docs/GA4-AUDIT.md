# The GA4 and Search Console audit

A read-only report that answers the questions Brownell Travel's marketing director has to present. It is separate from the stored Website performance section: it writes no database row and runs for any window.

## Run it

    npm run read-ga4-audit -- --client=brownell-travel
    npm run read-ga4-audit -- --client=brownell-travel --start=2026-07-01 --end=2026-09-30
    npm run verify-ga4-audit            (the checks; no network, invented data)

Or Actions, "GA4 and Search Console audit". It uploads the full report and a one-page client summary as an artifact. Needs `GOOGLE_SERVICE_ACCOUNT_JSON` and `DATABASE_URL`. The service account must be a user on the GA4 property and on the Search Console property.

## What it answers, for the window, the period before and the same dates a year earlier

0. Stored facts, re-checked first; any that changed come first.
1. Headline with the effect of every exclusion, checked against the stored Looker Studio figures.
2. What moved, each with a likely driver and a test that would confirm it.
3. Advisor microsites (directory and homepage kept out).
4. The form funnel (`form_start` and `form_submit`), with searches and repeats separated.
5. Sources (search, Facebook, Instagram, AI assistants, referral, email).
6. Search Console (clicks, impressions, CTR, position; branded and not; by group, advisor, device, country).
7. Bot and quality watch, with narrower rules and the real visitors each keeps.
8. Anomaly flags in both directions; a projection only with 24 clean months.
9. Talking points, ranked next steps, likely questions, what could not be verified.
10. Data quality.

## Rules it keeps

- Every figure is labelled "confirmed from data" or "inference" and prints its dates and filters.
- A `form_submit` event is a form submit event, never an enquiry, lead or conversion.
- A window touching Nov 2025 to Aug 2026 carries a comparability warning (the automated flood).
- A figure it cannot read (the Airtable lead count, anything behind the disabled GA4 Admin API) is listed as cannot verify.
- A re-run of a settled window sends almost nothing to Google (disk cache keyed by request).
- The Postgres connection says `sslmode=verify-full` itself (`src/db-url.ts`); local test databases are left alone.

## Not verified live

Nothing here has run against a real property. Request shapes for GA4 (up to four named date ranges, the `isKeyEvent` dimension) and Search Console (`sites.list`, `searchAnalytics.query`) are written from the published reference. The first real run is the proof.

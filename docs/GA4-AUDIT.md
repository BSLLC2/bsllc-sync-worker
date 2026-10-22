# The GA4 and Search Console audit

A read-only report that answers the questions Brownell Travel's marketing director has to present. It is separate from the stored Website performance section: it writes no database row and runs for any window.

## Run it

    npm run read-ga4-audit -- --client=brownell-travel
    npm run read-ga4-audit -- --client=brownell-travel --start=2026-07-01 --end=2026-09-30
    npm run read-ga4-audit -- --client=brownell-travel --start=2026-07-01 --end=2026-09-30 --compare-start=2025-09-01 --compare-end=2025-09-30
    npm run verify-ga4-audit            (the checks; no network, invented data)

Or Actions, "GA4 and Search Console audit". It uploads the full report and a one-page client summary as an artifact. Needs `GOOGLE_SERVICE_ACCOUNT_JSON` and `DATABASE_URL`. The service account must be a user on the GA4 property and on the Search Console property.

## Comparisons

Standard: the period of the same length straight before the window, and the same dates a year earlier. Default window is 1 Jan to three days ago, so by default this is year to date against last year to date.

Custom: `--compare-start` and `--compare-end` (both, or neither) replace "the period before" with a range you choose; the year-earlier comparison is still worked out. Everything that would say "period before" says "comparison period". A range that overlaps the window is refused, because a day on both sides would be counted twice. A range of a different length is allowed and the report says counts are not like for like (rates and shares are).

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

## Where the sources agree and disagree (section 6b)

The audit sets Google Analytics beside Search Console on exact keys only: the whole window, a page group, and an advisor's name. Each join is one of **agree**, **disagree**, **one source** or **cannot tell**, and disagreements print first.

- **Organic visits against search clicks.** Same direction, or both held, agrees. Opposite ways by at least 10% each, or one held while the other moves 20% or more, disagrees.
- **Page groups.** Clicks, impressions and Analytics organic landings per group. A clicks fall with held impressions reads "people saw it and clicked less" (title, snippet or position). A fall with falling impressions reads "fewer people were shown it". A small fall with a bigger engagement fall reads "the visits do less on the page". These are inference with the check that would settle each; none is a cause.
- **Advisors.** Search clicks to an advisor's pages against Analytics visits to the main page. Clicks well above visits points at lost tracking (consent banner, redirect, a filter).
- **Not joined here**, listed with a reason each: Bing, rank history, AI-answer prompts, Airtable leads, call tracking and Clarity. They live in other jobs or cannot be read by this audit.

The floors (a base of 100, 5% held, 10% and 20% for disagreement, 30 advisor clicks) are our own and are printed under the findings. The check is `npm run verify-ga4-audit` (section 11c).

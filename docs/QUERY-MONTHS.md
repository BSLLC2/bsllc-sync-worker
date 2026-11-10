# Branded and other searches, by month (`read-query-months`)

What the job stores, what it never stores, and what the figures can and cannot say.

## What is stored

One row per client per FINISHED calendar month in `seo_query_months`, written from Search Console's
Search Analytics report by the `query` dimension (and the same month with no dimension for the site total).
Only counts:

- `branded_clicks`, `branded_impressions`: searches that name the client (see "Brand terms").
- `other_clicks`, `other_impressions`: every other search Google listed.
- `total_clicks`, `total_impressions`: the site total for the month, anonymised searches included.
- `hidden_clicks`, `hidden_impressions`: the total less the searches Google listed, never below 0. These are
  the searches Google withholds from the per-search list.
- `rows_read`, `rows_capped`: how many search rows were read, and whether the read stopped at our ceiling
  (75,000 rows, three full pages).
- `brand_terms`, `terms_fingerprint`, `terms_source`: how many terms were used, a 16-character fingerprint
  of the sorted list (so a later change of terms is visible) and where the list came from (`typed` or `derived`).
- `month`, `covered_to` (the last day of the month), `synced_at`.

A month is written only once its last day is at least three days behind today, and is replaced as a whole, so
re-running is free. The first run reads sixteen months (Search Console keeps about sixteen); `--months=1..16`
narrows it.

## What is never stored

**A search's text.** Not in a column, not in a log, not in a heartbeat note, not in an error. The job reads each
search only to answer "is this branded?" and adds its clicks and impressions to one of two running sums. A search
can carry a person's name. `npm run verify-query-months` reads the table definition, the INSERT and every log line
for this, and the real job's output and stored rows are scanned for planted search text.

## Caveats the dashboard has to carry

- **Hidden searches make branded a floor.** A withheld search might have been branded or not. Branded plus other
  plus hidden is the site total; branded and other are what Google listed.
- **A capped read is a floor too.** When `rows_capped` is true the unread tail and Google's withheld searches cannot
  be told apart, so `hidden_*` is NULL for that month.
- **A month Search Console returned nothing for is not written**, because "no row" and "nought clicks" are different
  statements and a property younger than the month looks the same as a month with no impressions.
- **No usable brand term means NULL branded and other** (never a nought, which would read as "all other").
- **Brand terms are a person's call.** The job derives them from the client's name, aliases and domain label
  (company suffixes such as LLC taken off) unless a person typed a list at `app_settings` key
  `brand_terms:<clientId>`: `{"terms":["..."],"by":"name","at":"iso date"}`. A typed list with no name or no date is
  not read. A term under 3 letters is refused; a single everyday short word ("hope", "star", "love") is skipped and
  counted. Both counts are printed. Matching is whole words with case, punctuation, spacing and accents set aside,
  and the term run together matches the search spaced out and the other way round; a word that merely contains the
  term does not match.
- The Search Console request shapes follow the published documentation and have not been run against a live property.

## Running it

`npm run read-query-months -- --dry-run` reads and prints counts and writes nothing. The workflow
`read-query-months.yml` runs Mondays 09:00 UTC (after the page-months job), has `client_id` and `dry_run` inputs
(`dry_run` defaults to true on a hand dispatch), and stamps the `read_query_months` heartbeat only for a full, live run.
Needs `DATABASE_URL` and `GOOGLE_SERVICE_ACCOUNT_JSON` (both already in use); the service account must be a user on
each property.

# WebOps readers: run order and contract

Three readers fill ONE table for the dashboard's site-care view. Branch `claude/webops-readers-20271101`, not merged and not run against any live site.

## What they read
| Reader | Source | Secret | Stores |
|---|---|---|---|
| `site` | the client's own home page, one chain of GETs, robots.txt first, one TLS handshake | none | HTTP status, response ms, redirect hops, ended on https, left the site, canonical same/other host/other path/none, certificate expiry date and whether it is trusted, NAMES of missing security headers (HSTS, nosniff, frame protection, referrer policy) |
| `domain` | RDAP through `rdap.org` (public) | none | domain expiry date (null when the registry publishes none) |
| `wp` | WP Umbrella project | `WP_UMBRELLA_API_KEY` | core behind, plugins behind, themes behind, vulnerability count, uptime %, last backup time and ok. **Field names are UNVERIFIED.** |

SiteGround has no API and is never read or scraped: its facts are typed in the app.
No page text, header value, plugin name, certificate or person is stored. A failed read stores `could_not_check` with a reason and nulls every figure; `last_read_at` keeps the last time the site was really seen. Missing is null, never 0.

## Who is read
WebOps add-on clients, plus any client with a typed connector row: `site_check` (site address), `domain_watch` (domain), `wp_umbrella` (project id; falls back to `clients.web_ops_site_id`). Site falls back to `clients.seo_domain` for add-on clients.

## The table (names are PROVISIONAL)
`site_care_readings (client_id, kind, subject, read_state, detail, http_status, response_ms, redirect_hops, ended_https, ends_off_site, canonical_state, cert_expires_on, cert_trusted, headers_missing, domain_expires_on, wp_core_behind, wp_plugins_behind, wp_themes_behind, wp_vulnerabilities, wp_uptime_pct, wp_last_backup_at, wp_last_backup_ok, checked_at, last_read_at)`, unique on `(client_id, kind, subject)`. `read_state` is `read | could_not_check | blocked_by_robots | no_key`. The app side could not be seen when this was written; if it declares other names, change `UPSERT_READING` in `src/webops/store.ts` and the app's `verify:wiring` surface together. The heartbeat is `read_webops` (give it an SLA of about 36 hours in the app's `JOB_SLA_HOURS`).

## Run order (owner)
1. Merge the app's site-care table first (the job refuses to run without it and says so).
2. Optional: add repository secret `WP_UMBRELLA_API_KEY`; type each client's WP Umbrella project id on its connector row.
3. Actions, "Read WebOps site care": leave `dry_run` true, run `kind=site` for one client, read the log. Then `kind=domain`, then `kind=wp` (its dry run prints which fields were found; adjust `UMBRELLA_PATHS` in `src/webops/umbrella.ts` to the real names).
4. Run once with `dry_run` false for one client, then for all. The daily schedule (09:30 UTC) takes over.

## Checks
`npm run verify-webops-readers` (in CI): pretend site, registry and Umbrella servers. It cannot prove any live shape.

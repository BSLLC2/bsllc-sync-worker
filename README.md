# bsllc-sync-worker

Self-hosted sync worker for the [BS LLC Account Health dashboard](https://github.com/BSLLC2/bsllc-account-health).
Pulls metrics from source APIs (v1: **Google Ads**) and feeds them into Neon
Postgres through the dashboard's existing seam — `npm run sync` — so the
dashboard itself never changes and never holds a credential.

```
this worker (credentialed)                 dashboard checkout (DB only)
──────────────────────────                 ────────────────────────────
query Google Ads API  ──writes──▶  /tmp/sync.json  ──npm run sync──▶  metric_snapshots
read connector_mappings (read-only)                                    (Neon Postgres)
```

**This repo is the only place third-party tokens ever live.** They sit in a
local `.env` that is gitignored. Never commit `.env`; never paste these values
anywhere else.

## Prerequisites

- Node 18+ on the VPS (`node -v`).
- A checkout of the dashboard repo on the same box (for `npm run sync`), with
  its own `DATABASE_URL` set. Point `DASHBOARD_DIR` at it.
- Google Ads API access:
  1. **Developer token** with **Standard access** — MCC → Tools → API Center.
     A *test* token cannot read production accounts; the backfill needs Standard.
  2. **OAuth client (Desktop type)** — Google Cloud Console → enable "Google Ads
     API" → configure OAuth consent → create OAuth client ID (Desktop). Gives you
     `client_id` + `client_secret`.
  3. **Refresh token** — minted once with `npm run mint-token` (see below).
  4. **`login_customer_id`** — your MCC id, digits only (BS LLC · Manager →
     `2141712409`).

## Setup

```bash
npm install
cp .env.example .env
# fill in .env — all four Google Ads values, DATABASE_URL, DASHBOARD_DIR
```

### Mint the refresh token (once)

Run this **on a machine with a browser** (your laptop), because it opens a
Google consent page. The token is portable — mint it on the laptop, paste it
into the VPS `.env`.

```bash
npm run mint-token
# opens a consent URL → authorize as the account with MCC access
# → prints the refresh token → paste into .env as GOOGLE_ADS_REFRESH_TOKEN
```

If it reports "no refresh_token returned", revoke the app at
<https://myaccount.google.com/permissions> and run it again (Google only issues
a refresh token on first consent).

## Which accounts get synced

Discovery reads **`connector_mappings`** (source `google_ads`, enabled, with an
external id) directly from Neon, read-only — the customer id paired to each
client in **Admin → Connectors**. Populate that screen and the worker needs no
other configuration.

**Day-one bootstrap:** if `connector_mappings` is still empty, copy
`accounts.example.json` to `accounts.json` and confirm every row. Each entry's
`client` must match a dashboard client by name, slug, or UUID; `customer_id` is
the Google Ads account (dashes optional). On the first run the dashboard's sync
write-back creates the `connector_mappings` rows from these, and DB discovery
takes over — you can delete `accounts.json` afterward.

> The seed excludes the two **BS LLC** accounts (the operating account and the
> **Manager/MCC** `214-171-2409`) and the "Setup in progress" account — those
> are the agency/MCC, not clients. Confirm the full name of **Colorado School of
> Clinical Herbalism** (it was truncated in the account list) so its slug
> resolves.

## Running

Validate without writing anything:

```bash
npm run incremental -- --dry-run
```

**Backfill** (one-time — plants ~52 weekly historical snapshots so week/month/
quarter trends appear). Each weekly as-of date `D` is emitted with a **backdated
`synced_at = D`**, which is what makes the trend windows line up:

```bash
npm run backfill -- --weeks=52
```

**Incremental** (daily) — current trailing-30-day window, `synced_at` defaults
to now:

```bash
npm run incremental
```

Force the file-based account list instead of the DB: `-- --accounts=accounts.json`.

## Daily cron

```cron
# 06:00 UTC daily — pull yesterday's trailing-30-day window for every account
0 6 * * *  cd /home/YOUR_USER/sync-worker && /usr/bin/npm run incremental >> /var/log/bsllc-sync.log 2>&1
```

## Exit codes

Propagated from the dashboard's `npm run sync`: `0` all entries persisted ·
`1` bad input · `2` one or more entries failed (details in the printed summary).

## Metric mapping

| Google Ads field | Dashboard metric key | Units |
| ---------------- | -------------------- | ----- |
| `metrics.cost_micros` | `ads.cost_micros` | micros |
| `metrics.impressions` | `ads.impressions` | count |
| `metrics.clicks` | `ads.clicks` | count |
| `metrics.conversions` | `ads.conversions` | count |
| `metrics.cost_per_conversion` | `ads.cost_per_conversion` | micros (null at 0 conversions) |
| `metrics.ctr` | `ads.ctr` | ratio |
| `metrics.average_cpc` | `ads.average_cpc` | micros |

`data_state`: `live` when the window served impressions/clicks/spend · `no_data`
when empty · `error` (with `error_message`) on API failure.

## Adding more sources later

GA4, Search Console, HubSpot, D365 follow the same shape: a `pull*` module that
returns `{ state, metrics }` keyed by that source's dashboard metric keys, wired
into the same discovery + emit pipeline. The contract and the backdated-backfill
trick are identical.

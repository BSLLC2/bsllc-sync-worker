# DPG — per-deal Closed Won feed — status (checkpoint, paused 2026-09-03)

Picking this back up: read this file first, it captures where the conversation
left off before context switched to OHC.

## The ask

DPG's BS LLC-attributed Closed Won deals should flow into the Account Health
Dashboard automatically, **named and dollar-valued, no manual entry** — one
row per deal (not an aggregate), so deal names carry through:

- `source: "d365"`, `metricKey: "d365.deal_won"`
- `valueNumeric` = amount in cents
- `valueText` = contact name + opportunity name
- `periodStart`/`periodEnd` = close date

**Filter, locked 9/2:**
- Window: Opportunities closed Won **on or after September 3, 2026 — no
  backfill**.
- Include: Paid Search, Organic Search, Google Business Profile, Website
  Form, Website Phone Call, Social Media, Email Campaign, **Referral
  Program**.
- Exclude: Manual Sales Outreach (legacy/rep-driven default), Truck Paper
  (not yet BS LLC-managed), Word of Mouth (can't prove the required digital
  touch), Other.

## Important correction found before building anything

The premise that only a "write-only lead-capture credential" exists is
**wrong** — a full read integration against this exact data already exists,
already scheduled, already shipping to the dashboard:

- `src/d365.ts` — Azure AD **client-credentials** OAuth (`getToken`), the
  Dataverse OData query (`fetchClosedWon`), and the classification function
  (`classify`) that buckets each Closed Won deal by its Contact's
  `new_firsttouchsource`.
- `src/import-d365.ts` — runs `fetchClosedWon`, classifies every deal, and
  aggregates into **monthly** revenue/deal-count totals per bucket
  (`bsllc` / `other` / `manual` / `unknown`), then hands them to `npm run
  sync` the same way HubSpot metrics land in `metric_snapshots`.
- `src/verify-d365.ts` — read-only smoke test, writes nothing.
- `.github/workflows/import-d365.yml` — cron `50 7 * * *` (daily), plus
  `workflow_dispatch`.
- Env vars actually used: `DYNAMICS_TENANT_ID`, `DYNAMICS_CLIENT_ID`,
  `DYNAMICS_CLIENT_SECRET`, `DYNAMICS_RESOURCE_URL` (NOT the `D365_*` names
  in `docs/D365_CLOSED_WON_BRIEF.md` — that doc has drifted from what's
  actually deployed and should be corrected/retired once this work lands).

No writes to Dataverse exist anywhere in this repo, and there is no n8n
footprint in either repo (`bsllc-account-health` or `bsllc-sync-worker`) —
grepped, zero matches. If a separate write-only lead-capture credential is
real, it lives entirely outside these two repos.

**Real gap, confirmed accurate:** the existing importer only ever emits
monthly aggregates — it discards deal names and per-deal dollar amounts
entirely. That's genuinely missing and is the actual work.

**Bucket model has evolved since `D365_CLOSED_WON_BRIEF.md` was written:**
that doc's "option B" puts Referral Program in the non-billable "Other
tracked" bucket. The 9/2-locked filter above explicitly **includes**
Referral Program as an attributed source for the per-deal feed. `d365.ts`'s
`BSLLC_DRIVEN` set does NOT currently include `FTS.REFERRAL_PROGRAM` — this
needs to change (or the per-deal feed needs its own include-set, separate
from the existing monthly aggregate's `BSLLC_DRIVEN`/`OTHER_TRACKED`
grouping, if the aggregate's definition of "BS LLC-driven" is meant to stay
as-is for that report).

## Recommended path (not yet decided with the user — pick this back up)

Extend the existing `d365.ts` / `import-d365.ts` rather than standing up a
second Azure App Registration + n8n workflow:

1. `fetchClosedWon` (or a sibling function) adds `and actualclosedate ge
   2026-09-03` to the OData `$filter` (or filters client-side) — no
   backfill, per the locked window.
2. New include-set matching the locked filter exactly (7 channels +
   Referral Program), separate from the existing `BSLLC_DRIVEN`/
   `OTHER_TRACKED` used by the monthly aggregate, unless the user confirms
   the aggregate's definition should also change to match.
3. `import-d365.ts` emits one `metric_snapshots` row per qualifying deal
   (`metricKey: "d365.deal_won"`, `valueNumeric` = `actualvalue` in cents,
   `valueText` = Contact name + Opportunity name, `periodStart`/`periodEnd`
   = `actualclosedate`) **in addition to** (not instead of) the existing
   monthly aggregate rows, unless told otherwise.
4. No schema changes needed — `metric_snapshots` and `CONNECTOR_SOURCES`
   already support `"d365"` as a source.

**Still open, decided with the user before this proceeds:**
- Confirm the extend-existing-integration path over the original
  new-App-Registration + n8n plan (asked, not yet answered).
- SECURITY.md's rotation item (`SECURITY.md:16-17` in the app repo) says
  "Rotate the Dynamics (dpg-prod) app-registration client secret... once
  end-to-end testing is done" — dated 2026-08-07, not 8/3 as referenced in
  chat. Still owed regardless of which path is chosen.

## Files touched by this work (once it proceeds)

- `src/d365.ts`
- `src/import-d365.ts`
- Possibly `docs/D365_CLOSED_WON_BRIEF.md` (correct the stale "not yet
  built" status and the wrong `D365_*` env var names)

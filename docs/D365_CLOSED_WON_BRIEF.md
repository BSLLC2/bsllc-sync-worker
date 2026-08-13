# Vercel Dashboard — D365 Closed Won Integration Brief

**Client:** Diesel Power Group (DPG) · slug `diesel-power-group`
**Owner:** BS LLC RevOps · **Status:** spec — not yet built (blocked on Dataverse API access)
**Runs in:** the sync-worker (the deployed dashboard makes zero third-party calls; it
only reads Postgres). The worker queries Dataverse and writes DPG's attributed
revenue to Postgres for the dashboard to read.

---

## 1. The problem (confirmed, not suspected)

Opportunities in DPG's D365 carry **no attribution**. Verified against a real
closed-won Opportunity (PACCAR MX13, $48,000, rep-created):

- There is **no Lead Source field on Opportunity** at all.
- There is **no Lead → Opportunity conversion trail** — reps create Opportunities
  straight against a Contact.

**Consequence:** any logic that reads the Opportunity's source, or traces an
Opportunity back to an originating Lead, returns nothing for every deal. Do not
build it. Attribution must come from the **Contact**, not the Opportunity.

## 2. Source of truth: `new_firsttouchsource` (Contact-level)

A Choice/picklist field built on the **Contact** table specifically to close this gap.

- Logical name: **`new_firsttouchsource`** (on Contact — not Opportunity, not Lead).
- **Automatically populated**, permission-locked; reps cannot edit it after creation.
- 12 possible values (see grouping in §3).
- `Manual Sales Outreach` is the automation's **default/fallback** when a rep creates
  a Contact themselves (not from a tracked web channel).

## 3. Attribution model — option **B** (BS LLC-driven channels only)

Chosen because it's what stands up in front of the client: only channels BS LLC
actually runs count as BS-LLC-driven. Every Closed Won deal lands in exactly one of
three buckets by its Contact's First Touch Source:

| Bucket | First Touch Source values |
|---|---|
| **BS LLC-driven** (attributed to BS LLC / billable) | Paid Search · Organic Search · Google Business Profile · Website Form · Website Phone Call · Social Media · Email Campaign |
| **Other tracked** (real source, but not BS LLC) | Referral Program · Word of Mouth · Truck Paper · Other |
| **Not attributed** (excluded) | Manual Sales Outreach · *(blank — see §5)* |

The dashboard reports these as **three separate revenue lines** so DPG never sees a
single blended number that over- or under-claims BS LLC's contribution.

> Choice fields match on their **integer option value**, not the label. Before build,
> capture each of the 12 labels → its int and pin them in §6. Match on the int.

## 4. Matching logic

For each **Closed Won** Opportunity:

1. Resolve its related **Contact** via the Opportunity's Customer/Contact lookup
   (confirm the logical name — likely `parentcontactid` or `customerid`).
2. Read that Contact's **`new_firsttouchsource`**.
3. Classify the deal's `actualvalue` into the §3 bucket for that value.
4. Blank → treat per §5 (unknown vs. not-attributed by Contact creation date).

"Closed Won" = `statecode = 1` (Won); confirm whether a specific `statuscode` is also
required. Revenue = `actualvalue` (confirm currency handling).

## 5. Timing / rollout — do not assume Contact coverage

`new_firsttouchsource` only started populating **on its go-live date**. Contacts
created before then are **blank** until they're next touched. So:

- A blank on a Contact **created before go-live** → **Unknown (pre-field)** — its own
  bucket, reported separately. Not counted as BS LLC-driven and not counted as manual.
- A blank on a Contact **created on/after go-live** → shouldn't happen (automation
  defaults to `Manual Sales Outreach`); defensively treat as **Not attributed**.

Encode the go-live date as a constant (`FIRST_TOUCH_GOLIVE = <YYYY-MM-DD>`) and split
blanks by `createdon` vs that date. Expect the Attributed number to be **low early**
and grow as the field backfills prospectively — that is correct, not a bug. The report
copy must say so.

## 6. Open items to build (the actual blockers)

1. **Dataverse API access** — org/environment URL, an Azure AD app registration
   (tenant id, client id, client secret) with **read** on Opportunity + Contact.
   Store as worker secrets (`D365_TENANT_ID`, `D365_CLIENT_ID`, `D365_CLIENT_SECRET`,
   `D365_ORG_URL`), same pattern as the Google Ads secrets. **This gates the build.**
2. **Option-set map** — the 12 `new_firsttouchsource` labels → integer values.
3. **Lookup field logical name** — Opportunity → Contact (`parentcontactid` /
   `customerid` / other).
4. **Closed Won definition** — exact `statecode`/`statuscode`, and the money field.
5. **Go-live date** for `new_firsttouchsource`.

## 7. Data model (worker → Postgres → dashboard)

Worker writes per-period DPG metrics (source `d365`), e.g.:

- `d365.closed_won_revenue_bsllc` — sum of `actualvalue` in the **BS LLC-driven** bucket
- `d365.closed_won_revenue_other` — **Other tracked** bucket
- `d365.closed_won_revenue_unknown` — **Unknown (pre-field)** bucket
- `d365.closed_won_deals_bsllc` / `_other` / `_unknown` — deal counts per bucket

The dashboard reads these from Postgres like any other metric source and renders the
three-line breakdown on DPG's client page / report. No D365 calls from dashboard code.

## 8. Query sketch (Dataverse Web API, OData)

```
GET {D365_ORG_URL}/api/data/v9.2/opportunities
  ?$filter=statecode eq 1 and actualvalue ne null
  &$select=opportunityid,name,actualvalue,actualclosedate,_parentcontactid_value
  &$expand=parentcontactid($select=contactid,createdon,new_firsttouchsource)
```

Adjust the lookup nav property once §6.3 is confirmed. Page with `@odata.nextLink`.
Aggregate by `actualclosedate` month into the metric keys in §7.

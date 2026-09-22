# What each ad platform's API can and cannot change

Written down so "can the API do that?" is a fact in the repo rather than
something each session re-guesses, and so a vendor brief can be accurate about
why we are asking a person to do something.

Sources are Google's and Microsoft's own developer docs and Meta's Marketing
API guides, checked September 2026. Where a limit is a **policy** choice of ours
rather than an API limitation, it says so — that distinction matters, because a
policy can be changed by a decision and an API limit cannot.

The adapter interface these map onto is `src/ads/platform.ts`: `read`,
`validate`, `apply`, `rollback`, `verify`, `capabilities`.

---

## Google Ads — implemented

Adapter: `src/ads/google-ads-adapter.ts`. Writes go through `applyChangeSet` in
`src/apply-ads-changes.ts`, the same guarded function the hand-run CLI uses.

| Capability | API can? | We have a guarded path? | Notes |
| --- | --- | --- | --- |
| Campaign daily budget | yes | **yes** | Capped at 2× and $100/day movement per run. |
| Bid strategy / target CPA / target ROAS | yes | no — **our policy** | Judgement-heavy and hard to reverse cleanly. Vendor brief. |
| Keywords (add / pause / bid) | yes | no — **our policy** | Pausing a keyword also removes its assists, which last-click conversions don't show. Brief. |
| Campaign negative keywords | yes | **yes** | Add and remove. Protected-term collision aborts the whole run; duplicates skipped. |
| Keyword final URLs | yes | **yes** | The one way to change where a click lands without touching ad copy. |
| Audiences / targeting | yes | no | Not built. Would be a new guarded op. |
| Status changes (pause / enable) | yes | no — **our policy** | A broken-tracking false alarm and genuinely bad traffic look identical from outside. Never automated. |
| Asset detach | yes | **yes** | Removes the link, not the asset. Google keeps assets; detaching is what stops it serving. |
| **Ad copy edit** | **no** | no | A served ad is effectively immutable. "Changing an ad" = create new + pause old, which resubmits for policy review. |
| Ad create | yes | no — **our policy** | See LegitScript below. |

### Validation
Google is the only one of the three with a real server-side dry run:
`validate_only` on every mutate. Every operation we apply is sent twice — once
to be validated, once for real — and the findings pipeline re-validates at apply
time, days after the finding was detected, because the account may have moved.

### Performance Max
PMax exposes asset groups, budget, and limited signals. It does **not** expose
keyword-level control, search-term-level negatives at the ad-group level, or
placement control the way Search does. Practically: on a PMax campaign our only
useful automated lever is **budget**, and account-level negative keyword lists.
Everything else is a brief. The rules engine produces no keyword or search-term
findings for PMax campaigns because the data simply isn't there to produce them.

### Special ad categories and certification — what actually affects our accounts
- **Housing, employment, consumer finance** (US/CA): age, gender, parental
  status, marital status and ZIP-code targeting are unavailable. No current BS
  LLC client falls in these categories.
- **Healthcare / addiction services**: certification required to run at all, and
  personalised-advertising restrictions apply on health topics. **This is Ohio
  Community Health.** OCH runs under LegitScript certification. The consequence
  for this system is concrete and is the single biggest reason ad copy is out of
  scope: editing an ad resubmits it for policy review, and a certified account
  failing review does not just lose one ad, it can lose serving. So: **no
  automated ad text changes on OCH, ever, regardless of what the API permits.**
  This is a policy guard, enforced by there being no ad-copy operation in
  `applyChangeSet` at all rather than by a flag someone can flip.

### Rate limits
Google Ads API limits are per developer token and access level. A Standard-access
token (which ours is — see README) has operation limits high enough that a weekly
audit across our account count is nowhere near them. The audit issues roughly six
GAQL queries per account per run and is capped with `LIMIT` on the three
expensive ones (500 search terms, 300 keywords).

### The Recommendations service and auto-apply
Google exposes its own `RecommendationService`, and
`RecommendationSubscriptionService` can subscribe an account to apply certain
recommendation types automatically. Two facts matter:

1. Auto-apply is **account-level only** and covers a subset of recommendation
   types. You cannot subscribe to a recommendation for one campaign.
2. From 26 January 2026, the "Add responsive search ads" recommendation no
   longer auto-suggests or auto-applies new RSAs, and has been removed from the
   Auto-apply settings page.

**Our recommendation: do not enable auto-apply on any account, and specifically
never on OCH.** The reasons are the ones this whole system exists for. Auto-apply
makes changes with no record on our side of what was changed or why, so the
memory we just built has a hole in it exactly where the changes are. It applies
Google's optimisation-score logic, which is not neutral about spend. And on a
LegitScript account, an auto-applied ad change is the specific risk we have
engineered around. Reading recommendations is a different question and is worth
doing — pulling them as findings (source: Google, still requiring our approval)
is a sensible next increment. **This needs Sebastien's call**, and it is in the
report's decision list.

---

## Meta — implemented, dormant until credentialed

Adapter: `src/ads/meta-adapter.ts`. Reports `credentialed: false` and refuses
every mutation without `META_ACCESS_TOKEN`, the same dormant-ready pattern as
Dialpad and Slack in this worker.

| Capability | API can? | We have a guarded path? | Notes |
| --- | --- | --- | --- |
| Campaign / ad set budget | yes | **yes** | Campaign daily budget only. Same 2× and $100/day guards, enforced in the Meta adapter itself — plus, since 2026-09-22, the same staleness guard the Google path carries: a proposal with no recorded starting budget, or one whose budget has moved since, is refused rather than applied over somebody else's change. |
| Bid strategy (cost cap, bid cap) | yes | no | Brief. |
| Keywords / negative keywords | **no** | — | Meta has no keywords. The search-term and keyword rules simply produce nothing here. |
| Audiences / targeting | yes | no — **and unverifiable** | See Advantage+ below. |
| Status changes | yes | no — **our policy** | Same reasoning as Google. |
| **Creative edit** | **no** | no | A creative is immutable once created. A change is a new ad object plus pausing the old, which resets learning and re-enters review. |
| Creative create | yes | no — **our policy** | Same as Google. |
| Destination URL | via creative | no | The URL lives on the creative, so changing it is a creative change. |

### Advantage+ — why targeting is always a brief
Under Advantage+ campaign types, audience inputs are treated as **signals to the
delivery model, not constraints**. Budget and the (2026-added) existing-customer
budget cap are real controls; a targeting change is a suggestion. That is a
genuine problem for this system specifically: we cannot verify a targeting change
did what we said it would, and a finding we cannot verify has no business being
in the applied-and-measured loop. So targeting on Meta is a vendor brief by
design, not by omission.

### Special Ad Categories
Meta's Special Ad Category (housing, employment, credit, social issues/elections)
strips age, gender and detailed targeting on any account running under one.

**This paragraph used to say the adapter read the flag "so a finding can say so".
It did not.** `special_ad_categories` was in the campaign field list and the
response was discarded, and no rule could see it because `CampaignRow` had no
field for one. It is carried now, and the one thing it does is remove a line of
advice: an ad set under a restricted category is never told to widen its
audience, because that control does not exist on it. `[]` means we read it and
there are none; absent means the campaign read never reached that campaign, and
the two are kept apart.

### The learning phase — the one reading Meta gives that Google does not
`AdSet.learning_stage_info` reports Meta's own verdict per ad set (`status`,
the optimisation events it counted, and often
`dynamic_lp_conversions_threshold`, the threshold it is measuring that ad set
against). Google describes its learning period in support documentation and
reports it in no API field at all.

So the engine READS a verdict here rather than forming one. A platform saying
`SUCCESS` on a thin-looking count is settled; a platform saying
`LEARNING_LIMITED` on a healthy-looking count is limited. The counts are only
used to say how far short, and where Meta reports no threshold the published
convention (~50 events / 7 days) is used with a sentence saying it is a
convention rather than the platform's figure.

### Counting a conversion once
Meta's `actions` array reports the same event under several names: `lead`,
`offsite_conversion.fb_pixel_lead` and `onsite_conversion.lead_grouped` are one
lead, not three. The adapter's original prefix regex summed all of them, so a
cost per conversion came out at a third of the truth — the direction that makes
a struggling account look healthy. `countMetaConversions` declares the families
and takes exactly one member of each, and prefers `objective_results` (the
platform's own count of what the ad set optimises for) wherever Meta reports it.

`clicks` is Clicks (All) and counts reactions, comments, shares and media
expansions. The adapter reads `inline_link_clicks` and says in the log when it
had to fall back.

### What Meta has no equivalent of
- **Impression share.** No metric of any kind. Null, never nought.
- **Keywords and search terms.** No such objects, so those rules find nothing.
- **A conversion-action object.** Meta's equivalent is a dataset, its
  pixel/CAPI events and their match quality, which is a different shape. The
  adapter reads none of it, and the rules now know that rather than reporting
  "part of this could not be read" on every Meta account forever.
- **Bidding data exclusions.** Google can be told to ignore a range of days
  after a tracking outage. Meta cannot, at all. The only remedy is behavioural.
- **A click id anywhere in this system.** There is no `fbclid` column on
  `web_inquiries`, so the click → customer chain the Google accounts are read on
  does not exist for Meta and no reading of it is attempted.

### Rate limits
The Marketing API is points-based per app per ad account over a rolling window.
Reads cost roughly 1 point, writes 3, and development-tier apps get a much
smaller budget than standard-tier ones. Our read path asks for one Insights page
per level rather than walking every object, which keeps a weekly audit cheap.
**If a Meta app is created for this, request Standard access** — development tier
will throttle a multi-account weekly audit.

### What is missing before Meta works
A Meta app, a system user, and a long-lived system-user token with `ads_read`
(reporting) plus `ads_management` (to action findings), with our Business Manager
added as a partner on each client's ad account. None of that exists today. It is
in the report's decision list.

---

## Microsoft Advertising — declared seam, not implemented

Adapter: `src/ads/microsoft-adapter.ts`. Every verb throws
`AdapterNotImplemented` with a pointer here. It is a stub on purpose: no BS LLC
client currently runs Microsoft Advertising spend we manage, and an untested
write path against an account that does not exist would be worse than nothing.

The write surface is closer to Google's than to Meta's — budgets, bid strategy,
keywords, negative keywords, audiences, targeting, status and final URLs are all
writable through Campaign Management v13 — so **the Google adapter is the
template to copy**, with two changes:

1. **Reporting is asynchronous.** You submit a report request, poll for
   completion, then download a file. `read()` becomes a submit/poll/download
   loop rather than a synchronous query.
2. **There is no `validate_only`.** `validate()` must report
   `serverValidated: false`, exactly as the Meta adapter does, so nobody reads a
   local shape check as a platform dry run.

Before building per-finding automation, the obvious first move is Microsoft's own
**Google Ads Import**, which copies a Google account wholesale and can be told to
scale budgets on the way in (commonly +25%). Getting the account populated
correctly is worth more than automating changes to an empty one.

Credentials it would need: a Microsoft Advertising developer token, a Microsoft
Entra app, and a refresh token for an account with access to the customer's ad
account.

---

## Summary: where automation actually pays

Ranked by value per unit of risk, across all three platforms:

1. **Campaign negative keywords (Google).** Highest-value, lowest-risk,
   cleanly reversible, and the biggest single source of recoverable waste.
   Fully automated behind approval today.
2. **Budgets (Google, Meta).** Valuable and reversible, but only on campaigns
   that already convert — which is a rule in `src/ads/rules.ts`, not a habit.
3. **Keyword final URLs (Google).** Underrated: it changes where a click lands
   without touching ad copy, so it carries none of the policy-review risk.
4. **Everything else is people-work**, and the honest answer is that it should
   be. Ad copy, landing pages and bid judgement are where an agency earns its
   fee; the value this system adds there is a specific, evidenced brief with a
   tracking id and a verification check, not an API call.

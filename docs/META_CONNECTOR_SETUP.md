# Meta (Facebook / Instagram) — what a person has to do

Everything in this file is a step Claude cannot take. The code is written, it
typechecks, its guard runs in CI, and it will import nothing at all until the
three things below exist. Nothing here was run against a live Meta account —
there is no Meta credential in the sandbox this was written in, so every figure
in the tests and fixtures is invented.

Read it the way the dashboard's own "Known blockers" section is written: what
the secret is called, exactly where it goes, what it needs to be allowed to do,
and what stays broken until it is there.

---

## 1. `META_ACCESS_TOKEN` — a repository secret on `bsllc-sync-worker`

**Exact name:** `META_ACCESS_TOKEN`
**Where:** GitHub → `BSLLC2/bsllc-sync-worker` → Settings → Secrets and
variables → Actions → Repository secrets → New repository secret.
**Not on Vercel.** The app never calls Meta; the worker is the only thing that
reads a third party. A copy on the dashboard project would do nothing.

**What the token must be.** A **system-user** access token from the BS LLC Meta
business portfolio — not a personal user token, which dies when the person who
made it changes their password, leaves, or has their session expired.

To create it:

1. **Meta Business Suite → Business settings → Users → System users → Add.**
   Name it something that says what it is (`bsllc-dashboard-sync`), role
   **Employee** — Admin is not needed for reading.
2. With that system user selected, **Add assets → Ad accounts**, tick each
   client's ad account, and grant **View performance** (`ads_read`).
   *Do this for every client, one at a time.* A token that can see two of three
   accounts reads the third as a permissions error, which this importer records
   as an `error` row against that client and names in its log.
3. **Generate new token.** Pick the BS LLC app (the one with the Marketing API
   product added — if there is no such app, create it first at
   developers.facebook.com → My Apps → Create app → Business → add **Marketing
   API**).
4. **Permissions to tick:** `ads_read` only.
   Also tick `ads_management` **only if** we intend to act on Meta findings from
   the dashboard's Approve path later. The importer never writes, and the
   findings adapter's only guarded operation is a budget change. Leave it off
   until somebody decides to turn that on.
5. Set the token to **never expire** (System-user tokens offer this; a 60-day
   token means this importer dies silently in two months, which is exactly the
   failure the heartbeat below exists to make loud rather than something to
   accept).
6. Copy it straight into the GitHub secret. It is not needed anywhere else.

**Nothing takes effect until the next run.** Unlike a Vercel env var, a GitHub
Actions secret is read at job start, so the next scheduled 07:55 UTC run picks
it up with no redeploy. To see it work immediately: Actions → **Import Meta ads
spend and performance** → Run workflow.

---

## 2. One connector mapping per client — in the dashboard, by an AM

**Where:** the dashboard → **Admin → Connectors** → the **Meta** row for that
client. Switch it on and paste the **ad account id, including the `act_`
prefix**: `act_1234567890`.

Where to find it: Meta Ads Manager → the account selector at the top left; the
id is the number beside the account name, and it is also in the URL as
`act=1234567890`. Bare digits are accepted — the importer adds the prefix — and
a value with no digits in it at all is refused by name rather than being turned
into a request for an account that cannot exist.

**What the client has to do, once, before that mapping means anything.** This
is already the wording on the connector row itself:

> Our portfolio `147520162648091` added as a partner in Business settings, then
> the ad account at "Manage campaigns", the Facebook Page and the Pixel shared
> to it, plus the Page's leads if they run Lead Ads.

Partner access is what lets our system user be granted the account at step 1.2
above. Without it, the grant screen will not list the account.

---

## 3. Nothing else

No Vercel variable, no redeploy, no database migration, no schema change. The
metric keys, the connector source and the currency-unit declaration have all
been in the app's `shared/schema.ts` since the Meta connector row was made
mappable; what was missing was something to write the rows.

---

## How to tell whether it is working

| Where | What it says when it is right | What it says when it is not |
|---|---|---|
| **Admin → Data health** | `Meta ads import (job)` green, with a note like `accounts=1 read=1 months=24 errors=0` | Red with `META_ACCESS_TOKEN is not set on the worker`, or a permissions message naming the account |
| **Admin → Connectors** | The client's Meta row shows a recent sync | "Not connected", or an error with the reason on it |
| **The client page** | A Meta panel with ad spend, impressions, link clicks, conversions, CTR and cost per click | — |
| **Actions → Import Meta ads…** | The run's log names every account and how many months it planted | The failing accounts are listed last, with the fix |

**A run with nothing mapped exits 0 and says so** — nobody has wired an account
yet, which is not a failure. **A run with accounts mapped and no token FAILS**,
every day, on purpose: a green heartbeat over an importer that can never import
is the "stopped, or retired?" confusion the whole Data health page exists to
end.

---

## What this does NOT do

- **It does not act on anything.** Read-only against Meta. The findings adapter
  (`src/ads/meta-adapter.ts`) has one guarded operation, a budget change, and it
  still sits behind the dashboard's Approve path.
- **It does not convert currency.** An ad account billed in euros reports euros,
  and the figure is stored as that account's own money — the same assumption
  every Google Ads figure in this system already carries.
- **It does not read Lead Ads leads.** Form submissions on Meta are a different
  object with its own permission (`leads_retrieval`) and its own destination in
  this system (`web_inquiries`, not `client_metrics`). That is its own change.
- **It does not backfill beyond 37 months.** Meta refuses an insights window
  that starts further back than that, and the importer refuses to ask rather
  than producing an error somebody has to decode.

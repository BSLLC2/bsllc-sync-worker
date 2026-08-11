# Google Ads recursive loop — token fix runbook

**Status as of 2026-08-11:** BLOCKED. Every mapped Google Ads account (OCH,
CSCH, Diesel Power Group, Franklin Brazing, Tablespoon) returns the OAuth error
`invalid_grant: Token has been expired or revoked.` This is verified by the
`verify-all.yml` workflow (run #4, commit `461b8b0`):

```
Summary: 0 reachable · 0 access-denied · 5 credential-failure · 3 no Ads mapping · 8 total
```

**What this means (important — it changes the fix):** This is NOT a permission
or account-linking problem. Earlier the verifier's bare `catch` mislabeled it
"PERMISSION DENIED," which pointed us at MCC linking. The real error is that the
**refresh token itself is dead**. The account links are fine. The one thing to
fix is the token.

**Why a token dies on its own:** When a Google Cloud OAuth "consent screen" is
in **Testing** publishing status, Google **expires every refresh token after 7
days**. That exactly matches the "it worked, then broke a week later, again and
again" pattern. So this runbook has two jobs: (1) stop the 7-day expiry for
good, then (2) mint a fresh token.

Do the parts **in order**. Part 1 is what stops this from recurring.

---

## Part 1 — Stop the 7-day expiry (publish the OAuth consent screen)

1. Open the OAuth consent screen:
   **https://console.cloud.google.com/apis/credentials/consent**
2. At the very top of the page, confirm the **project selector** shows the
   project that owns your Ads OAuth client. That is the same project as the sync
   service account — **`bs-llc-internal-tools`**. If a different project is
   shown, click the selector and switch to `bs-llc-internal-tools`.
3. Look at **"User type."**
   - If it says **Internal** → refresh tokens do **not** expire for internal
     apps. In that case the token didn't die from expiry; skip to Part 2 and
     just re-mint (the old one was probably revoked or minted under a different
     client). Nothing to publish.
   - If it says **External** → continue to step 4. This is the likely case.
4. Find **"Publishing status."**
   - If it says **Testing** → click **"PUBLISH APP,"** then **Confirm** in the
     dialog. Status should change to **"In production."** This is the fix that
     stops the 7-day expiry.
   - If it already says **In production** → leave it; go to Part 2.
5. You do **not** need Google's app-verification review for this. The "adwords"
   scope is "sensitive," but an unverified in-production app still works for
   your own users; it just shows an "unverified app" warning at sign-in, which
   you click through. (If you'd rather avoid the warning entirely and every user
   is an `@bsllc.biz` Workspace member, you can instead set User type =
   **Internal** — that also removes the 7-day expiry. Either path fixes it.)

---

## Part 2 — Mint a fresh refresh token (OAuth Playground)

You need the **web** OAuth client's ID and secret — the same values the worker
uses in `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` (the client secret
starts with `GOCSPX-`). The new refresh token **must** be minted with this exact
client, or the worker can't use it.

### 2a. Allow the Playground to use this client (one-time)

1. Open **https://console.cloud.google.com/apis/credentials** (same
   `bs-llc-internal-tools` project).
2. Under **"OAuth 2.0 Client IDs,"** click the **Web application** client whose
   ID matches `GOOGLE_ADS_CLIENT_ID`.
3. Under **"Authorized redirect URIs,"** click **"+ ADD URI"** and paste
   exactly:
   ```
   https://developers.google.com/oauthplayground
   ```
   (no trailing slash)
4. Click **Save**. Wait ~1 minute for it to propagate.

### 2b. Authorize as a user who has Ads access

1. Open **https://developers.google.com/oauthplayground**
2. Click the **gear icon (⚙)** at the top right → check
   **"Use your own OAuth credentials."**
   - **OAuth Client ID:** paste your web client ID (the `GOOGLE_ADS_CLIENT_ID`
     value).
   - **OAuth Client secret:** paste the `GOCSPX-…` secret.
   - Leave the gear panel (it stays applied).
3. On the left, in **"Step 1 — Select & authorize APIs,"** find the
   **"Input your own scopes"** box at the bottom and type exactly:
   ```
   https://www.googleapis.com/auth/adwords
   ```
4. Click **"Authorize APIs."**
5. Google's sign-in appears. **Sign in as the Google user that actually has
   access to the Ads accounts** — i.e. the user who can see MCC `2141712409` and
   OCH's account in the Google Ads UI. Per your notes that is
   **`digital@bsllc.biz`**. Use that account. (Do **not** sign in as a user
   without Ads access — that would mint a working token that then can't see the
   accounts, which is a different dead end.)
6. If you see an **"unverified app"** screen, click **Advanced → Go to
   (app) (unsafe)** and continue. Grant the requested access.

### 2c. Exchange for the refresh token

1. Back in the Playground, you'll be on **"Step 2 — Exchange authorization code
   for tokens."** Click **"Exchange authorization code for tokens."**
2. In the response panel, copy the **`Refresh token`** value. It starts with
   **`1//`**. This is your new `GOOGLE_ADS_REFRESH_TOKEN`.
   - Copy just the token. **No** surrounding quotes, spaces, or line breaks.

---

## Part 3 — Update the GitHub secret

1. Open the sync-worker secrets:
   **https://github.com/BSLLC2/bsllc-sync-worker/settings/secrets/actions**
2. Click **`GOOGLE_ADS_REFRESH_TOKEN`** → **"Update."**
3. Paste the new `1//…` token into the value box. **Do not press Enter after it**
   and make sure there's no trailing space — a stray newline/character is a real
   failure mode (a ` ` line-separator was seen trailing this secret once).
4. Click **"Update secret."**
5. If any **other** workflow or environment also holds `GOOGLE_ADS_REFRESH_TOKEN`
   (e.g. a separate daily Ads-metrics sync), update it there too so the whole
   pipeline uses the fresh token.

---

## Part 4 — Verify (Claude runs this)

Tell me it's updated and I'll dispatch `verify-all.yml`. Success looks like:

```
Summary: 5 reachable · 0 access-denied · 0 credential-failure · 3 no Ads mapping · 8 total
```

When that flips green:
- The daily **offline-conversions** loop (`import-offline-conversions.yml`) can
  upload admissions back to Google Ads as offline conversions — the recursive
  learning loop is live.
- The Ads-side metrics for these accounts start flowing to the dashboard.

If it still shows **credential-failure**, the token was minted under the wrong
client or the wrong user — repeat Part 2, double-checking the client ID matches
`GOOGLE_ADS_CLIENT_ID` and you signed in as the Ads-access user.
If it shows **access-denied** instead (auth now works but the user can't see the
accounts), that's the linking case: grant that user access to MCC `2141712409`
in the Google Ads UI, then re-run.

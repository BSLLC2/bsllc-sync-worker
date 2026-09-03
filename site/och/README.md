# OCH site code (ohiorecoverycenters.com)

Versioned source for the code we run on Ohio Community Health's WordPress
site. The site has no repo of its own; this folder is the source of truth and
the server copy is deployed from here, never edited in place.

Host: Cloudways, SSH `master_gfpqenyutm@161.35.130.84`, path
`applications/xadhjnucjv/public_html`. WP-CLI is available over SSH.

## mu-plugins/bsllc-lead-forwarder.php — every form → dashboard

Forwards every Elementor Pro form submission to
`https://work.bsllc.biz/api/webform/och` with first-touch ad attribution from
the `bs_attrib` cookie (gclid/UTMs, 90 days). Replaces the two WPCode snippets
"OCH — Elementor form → BS LLC pipeline" and "OCH — gclid capture" (9250),
which had the secret hardcoded, pointed at the old vercel.app host, and — as
of 2026-09-03 — showed no evidence of ever delivering a row.

### Deploy (5 minutes, from any machine with the SSH key)

```sh
SITE=master_gfpqenyutm@161.35.130.84
ROOT=applications/xadhjnucjv/public_html

# 1. The secret lives in wp-config.php, never in this repo. Same value as the
#    app's WEBFORM_SECRET on Vercel.
ssh $SITE "cd $ROOT && wp config set BSLLC_WEBFORM_KEY '<WEBFORM_SECRET>' --type=constant"

# 2. Copy the plugin (mu-plugins load automatically, no activation).
scp site/och/mu-plugins/bsllc-lead-forwarder.php $SITE:$ROOT/wp-content/mu-plugins/

# 3. Turn the WPCode snippets off so nothing posts twice (draft = inactive).
ssh $SITE "cd $ROOT && wp post list --post_type=wpcode --fields=ID,post_title,post_status"
ssh $SITE "cd $ROOT && wp post update <ID of 'OCH — Elementor form → BS LLC pipeline'> --post_status=draft"
ssh $SITE "cd $ROOT && wp post update 9250 --post_status=draft"

# 4. Purge Breeze/Varnish so the new <head> script is served.
ssh $SITE "cd $ROOT && wp breeze purge --cache=all" 2>/dev/null || true
```

Then, in Elementor, remove the native **Webhook** action from the
"Contact Us - Contact Page" form (Actions After Submit) — the forwarder covers
it, and until the dashboard's dedupe is deployed the two together store every
Contact-page lead twice.

### Verify (2 minutes)

1. Open `https://ohiorecoverycenters.com/?gclid=TEST123&utm_source=test`,
   browse to any other page, submit any form with email
   `test-inquiry@bsllc.biz` (internal test address, hidden from all lead views).
2. Within ~10 s the lead shows on OCH's board in the dashboard with
   Form = that form's name and gclid = TEST123.
3. Or over SSH: `grep "BSLLC webform" wp-content/debug.log` must be empty.
   Any line there names the form and the HTTP status (401 = key mismatch:
   redo step 1 with the current WEBFORM_SECRET).

### Why this exists

Elementor only calls a webhook from a form that has its own Webhook action.
Of the site's 31 forms, one (Contact Us) had it, so from Aug 7 to Aug 27 2026
the dashboard saw 1 of 10 real submissions. Full history: the "OCH Lead
Pipeline Audit" (2026-09-03) and the OCH Engagement Log in Drive.

## What is NOT here (yet)

`mu-plugins/och-consolidation-redirects.php` (2026-09-01, ~20 retired URLs
→ canonical, plus /about/, /about-us/, /contact-us/, /blue-ash*) was written
on the server directly and is not in this repo. Pull it down before the next
change to it: `scp $SITE:$ROOT/wp-content/mu-plugins/och-consolidation-redirects.php site/och/mu-plugins/`.

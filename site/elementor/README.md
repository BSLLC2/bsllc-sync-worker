# BS LLC lead forwarder — installable plugin for any Elementor Pro site

Forwards every Elementor Pro form submission to the dashboard's Website Leads
(`POST https://work.bsllc.biz/api/webform/<client-slug>`), with first-touch
gclid/UTM attribution from a first-party cookie. Same logic as
`site/och/mu-plugins/bsllc-lead-forwarder.php`, packaged so it installs from
WP admin alone — no SSH or wp-config access needed.

## Install (about two minutes)

1. Download `bsllc-lead-forwarder.zip` from this folder.
2. In the client's WordPress: Plugins → Add New → Upload Plugin → choose the
   zip → Install Now → Activate.
3. Settings → BS LLC lead forwarder:
   - Client slug: the client's name lowercased with non-alphanumerics as `-`
     (e.g. `franklin-brazing`). It must match the client in the dashboard.
   - Webhook key: the app's `WEBFORM_SECRET` (ask Sebastien; never commit it).
   - Save. Status should read "configured".
4. Submit a test on each form on the site (every form, not just the main one)
   with a recognizable name. Each should appear in the dashboard's Website
   Leads within seconds, with the form's name as its source.

If a submission doesn't show, `wp-content/debug.log` (when `WP_DEBUG_LOG` is
on) carries a line starting `BSLLC webform POST failed`.

## Rebuilding the zip after editing the plugin

    cd site/elementor && rm -f bsllc-lead-forwarder.zip && zip -r bsllc-lead-forwarder.zip bsllc-lead-forwarder

Sites known to use this: Franklin Brazing (franklinbrazing.com). OCH runs the
mu-plugin variant instead (key in wp-config, deployed over SSH).

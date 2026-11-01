/**
 * The only write the WebOps readers make: one upsert into `site_care_readings`.
 *
 * *** PROVISIONAL NAMES. *** The app's site-care table could not be seen when this was
 * written. The table and its columns are declared HERE as a literal (so the app's
 * `verify:wiring` can read them) and in docs/WEBOPS-READERS.md; if the app declares
 * different names, change this one statement.
 *
 * ONE ROW per (client, kind, subject). A failed read nulls every measurement and keeps
 * `last_read_at`, the last time the reader really saw the site, so a stale figure is
 * never shown beside "could not check". No SQL here logs a parameter.
 */
import type { Queryable } from "../page-behaviour/store.js";
import type { ReadingOut } from "./types.js";

export const UPSERT_READING = `INSERT INTO site_care_readings
  (client_id, kind, subject, read_state, detail, http_status, response_ms, redirect_hops, ended_https, ends_off_site,
   canonical_state, cert_expires_on, cert_trusted, headers_missing, domain_expires_on,
   wp_core_behind, wp_plugins_behind, wp_themes_behind, wp_vulnerabilities, wp_uptime_pct, wp_last_backup_at, wp_last_backup_ok,
   checked_at, last_read_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
 ON CONFLICT (client_id, kind, subject) DO UPDATE SET
   read_state = EXCLUDED.read_state, detail = EXCLUDED.detail,
   http_status = EXCLUDED.http_status, response_ms = EXCLUDED.response_ms, redirect_hops = EXCLUDED.redirect_hops,
   ended_https = EXCLUDED.ended_https, ends_off_site = EXCLUDED.ends_off_site, canonical_state = EXCLUDED.canonical_state,
   cert_expires_on = EXCLUDED.cert_expires_on, cert_trusted = EXCLUDED.cert_trusted, headers_missing = EXCLUDED.headers_missing,
   domain_expires_on = EXCLUDED.domain_expires_on,
   wp_core_behind = EXCLUDED.wp_core_behind, wp_plugins_behind = EXCLUDED.wp_plugins_behind, wp_themes_behind = EXCLUDED.wp_themes_behind,
   wp_vulnerabilities = EXCLUDED.wp_vulnerabilities, wp_uptime_pct = EXCLUDED.wp_uptime_pct,
   wp_last_backup_at = EXCLUDED.wp_last_backup_at, wp_last_backup_ok = EXCLUDED.wp_last_backup_ok,
   checked_at = EXCLUDED.checked_at,
   last_read_at = COALESCE(EXCLUDED.last_read_at, site_care_readings.last_read_at)`;

export async function writeReading(c: Queryable, clientId: string, r: ReadingOut, at: Date): Promise<void> {
  const s = r.site, d = r.domain, w = r.wp;
  const ok = r.state === "read";
  await c.query(UPSERT_READING, [
    clientId, r.kind, r.subject, r.state, r.detail,
    s?.httpStatus ?? null, s?.responseMs ?? null, s?.redirectHops ?? null, s?.endedHttps ?? null, s?.endsOffSite ?? null,
    s?.canonicalState ?? null, s?.certExpiresOn ?? null, s?.certTrusted ?? null, s?.headersMissing ? s.headersMissing.join(",") : null,
    d?.domainExpiresOn ?? null,
    w?.wpCoreBehind ?? null, w?.wpPluginsBehind ?? null, w?.wpThemesBehind ?? null, w?.wpVulnerabilities ?? null, w?.wpUptimePct ?? null,
    w?.wpLastBackupAt ?? null, w?.wpLastBackupOk ?? null,
    at.toISOString(), ok ? at.toISOString() : null,
  ]);
}

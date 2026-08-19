#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * WebOps site-health importer. For every client with the WebOps add-on AND a WP
 * Umbrella project id (clients.web_ops_site_id), pulls the site's uptime,
 * pending updates, vulnerabilities, and last backup from the WP Umbrella Public
 * API and writes one site_health_snapshots row. The dashboard's health score
 * (site_health signal) and the client's maintenance report card read the latest
 * row, so WebOps clients get a real, scored site-health signal instead of the
 * "not connected" placeholder.
 *
 *   npm run import-webops            (live)
 *   npm run import-webops -- --dry-run
 *
 * Needs WP_UMBRELLA_API_KEY (Bearer token, one per account). Base URL override:
 * WP_UMBRELLA_BASE (default https://api.wp-umbrella.com). Response shapes are
 * mapped defensively — verify field names on the first dry-run and adjust
 * pickField() below if WP Umbrella names them differently.
 */
const BASE = (process.env.WP_UMBRELLA_BASE || "https://api.wp-umbrella.com").replace(/\/+$/, "");

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var ${name}.`);
  return v.trim();
}

async function wpGet(token: string, path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (!res.ok) throw new Error(`WP Umbrella ${path} HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

/** First present value among candidate paths (dot notation), else undefined. */
function pick(obj: any, paths: string[]): any {
  for (const p of paths) {
    let cur = obj;
    let ok = true;
    for (const seg of p.split(".")) {
      if (cur && typeof cur === "object" && seg in cur) cur = cur[seg];
      else { ok = false; break; }
    }
    if (ok && cur != null) return cur;
  }
  return undefined;
}

interface Snapshot {
  uptimePct: number | null;
  securityStatus: "clean" | "warning" | "compromised" | null;
  pluginsBehind: number | null;
  coreBehind: boolean | null;
  lastBackupAt: string | null;
  lastBackupOk: boolean | null;
  reportUrl: string | null;
}

/** Map a WP Umbrella project payload to our snapshot shape (defensive). */
function toSnapshot(project: any, siteId: string): Snapshot {
  const uptime = pick(project, ["uptime.percentage", "uptime_percentage", "monitoring.uptime", "uptimePercentage"]);
  const pluginsBehind = pick(project, ["updates.plugins", "pending_updates.plugins", "outdated_plugins_count"]);
  const themesBehind = pick(project, ["updates.themes", "pending_updates.themes", "outdated_themes_count"]);
  const coreBehind = pick(project, ["updates.core", "pending_updates.core", "core_update_available"]);
  const vulnCount = pick(project, ["vulnerabilities.count", "vulnerabilities_count", "security.vulnerabilities"]);
  const lastBackupAt = pick(project, ["backup.last_at", "last_backup.date", "backups.last_backup_at"]);
  const lastBackupStatus = pick(project, ["backup.status", "last_backup.status", "backups.last_status"]);

  const vulns = Number(vulnCount ?? 0);
  const security: Snapshot["securityStatus"] = vulns >= 3 ? "compromised" : vulns > 0 ? "warning" : "clean";
  const plugins = Number(pluginsBehind ?? 0) + Number(themesBehind ?? 0);
  const coreOut = typeof coreBehind === "boolean" ? coreBehind : Number(coreBehind ?? 0) > 0;
  const backupOk = lastBackupStatus == null ? null : /ok|success|complete/i.test(String(lastBackupStatus));

  return {
    uptimePct: uptime != null ? Number(uptime) : null,
    securityStatus: security,
    pluginsBehind: pluginsBehind != null || themesBehind != null ? plugins : null,
    coreBehind: coreBehind != null ? coreOut : null,
    lastBackupAt: lastBackupAt ? new Date(lastBackupAt).toISOString() : null,
    lastBackupOk: backupOk,
    reportUrl: `https://app.wp-umbrella.com/projects/${siteId}`,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const onlyClient = (argv.find((a) => a.startsWith("--client="))?.slice(9) || "").trim();
  const token = req("WP_UMBRELLA_API_KEY");
  const databaseUrl = req("DATABASE_URL");
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    let clients = (await c.query<{ id: string; name: string; web_ops_site_id: string }>(
      `SELECT id, name, web_ops_site_id FROM clients
        WHERE web_ops_add_on = true AND web_ops_site_id IS NOT NULL AND btrim(web_ops_site_id) <> ''`,
    )).rows;
    if (onlyClient) clients = clients.filter((c) => c.id === onlyClient);
    if (!clients.length) { console.log("No WebOps clients with a WP Umbrella site id — nothing to do."); return; }

    let ok = 0, failed = 0;
    for (const client of clients) {
      try {
        const project = await wpGet(token, `/projects/${client.web_ops_site_id}`);
        const snap = toSnapshot(project?.data ?? project, client.web_ops_site_id);
        console.log(`✓ ${client.name}: uptime ${snap.uptimePct ?? "—"}% · ${snap.securityStatus} · ${snap.pluginsBehind ?? "—"} updates · backup ${snap.lastBackupOk === null ? "?" : snap.lastBackupOk ? "ok" : "FAILED"}`);
        if (!dryRun) {
          await c.query(
            `INSERT INTO site_health_snapshots
               (id, client_id, captured_at, uptime_pct, security_status, plugins_behind, core_behind, last_backup_at, last_backup_ok, report_url)
             VALUES (gen_random_uuid()::text, $1, now(), $2, $3, $4, $5, $6, $7, $8)`,
            [client.id, snap.uptimePct, snap.securityStatus, snap.pluginsBehind, snap.coreBehind, snap.lastBackupAt, snap.lastBackupOk, snap.reportUrl],
          );
        }
        ok++;
      } catch (e) {
        failed++;
        console.log(`✗ ${client.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log(`WebOps: ${ok} ok, ${failed} failed${dryRun ? " (dry-run, nothing written)" : ""}.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

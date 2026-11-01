/**
 * WP Umbrella reader: versions, backups and uptime for a WordPress site managed in
 * WP Umbrella.
 *
 * *** EVERY FIELD NAME BELOW IS UNVERIFIED. *** WP Umbrella's API documentation could
 * not be read when this was written, so neither the endpoint (`GET /projects/:id`)
 * nor the shape of its answer is confirmed. The candidate paths are the ones the
 * existing `import-webops` importer already guessed. The reader is written against the
 * typed `UmbrellaApi` interface and tested only against a pretend server that serves
 * those guessed shapes; a green guard means the code does what it says against them,
 * not that WP Umbrella answers in them. The first dry run against a real account
 * (`npm run read-webops -- --kind=wp --dry-run`, which prints which fields it found
 * and which it did not) is how they are confirmed.
 *
 *  · A field the answer does not carry is NULL. It is never read as 0: a missing
 *    update count is not "no updates" and a missing backup is not "backed up".
 *  · If NONE of the fields is found the reading is `could_not_check` ("the answer had
 *    none of the fields this reads"), never an all-null `read`.
 *  · The per-client mapping is the project id, typed on the client's connector row
 *    (source `wp_umbrella`), falling back to the existing `clients.web_ops_site_id`.
 *  · No plugin name, vulnerability title or report text is kept: counts and dates.
 *
 * SiteGround has no API. Nothing here scrapes it; its hosting facts are typed in the
 * app (the confirmation path), and this reader never writes them.
 */
import { safeMessage } from "../page-behaviour/http.js";
import type { ReadingOut, WpFacts } from "./types.js";

export interface UmbrellaApi { project(id: string): Promise<unknown> }

/** The real API over fetch. */
export function realUmbrellaApi(base: string, key: string, fetchImpl: typeof fetch = fetch): UmbrellaApi {
  return {
    async project(id) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      try {
        const res = await fetchImpl(`${base}/projects/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: ctl.signal });
        const text = await res.text();
        if (!res.ok) throw new Error(`WP Umbrella answered ${res.status}`);
        return JSON.parse(text) as unknown;
      } finally { clearTimeout(timer); }
    },
  };
}

function pick(obj: unknown, paths: string[]): unknown {
  for (const p of paths) {
    let cur: unknown = obj;
    let ok = true;
    for (const seg of p.split(".")) {
      if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[seg];
      else { ok = false; break; }
    }
    if (ok && cur != null) return cur;
  }
  return undefined;
}
const asNum = (v: unknown): number | null => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const asIso = (v: unknown): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** UNVERIFIED candidate paths. Edit here when the first real answer shows the real ones. */
export const UMBRELLA_PATHS = {
  uptime: ["uptime.percentage", "uptime_percentage", "monitoring.uptime", "uptimePercentage"],
  plugins: ["updates.plugins", "pending_updates.plugins", "outdated_plugins_count"],
  themes: ["updates.themes", "pending_updates.themes", "outdated_themes_count"],
  core: ["updates.core", "pending_updates.core", "core_update_available"],
  vulns: ["vulnerabilities.count", "vulnerabilities_count", "security.vulnerabilities"],
  backupAt: ["backup.last_at", "last_backup.date", "backups.last_backup_at"],
  backupStatus: ["backup.status", "last_backup.status", "backups.last_status"],
} as const;

/** Pure. A project answer to facts, and the names of the fields that were found. */
export function toWpFacts(answer: unknown): { facts: WpFacts; found: string[] } {
  const project = (pick(answer, ["data"]) ?? answer) as unknown;
  const found: string[] = [];
  const get = (k: keyof typeof UMBRELLA_PATHS) => { const v = pick(project, [...UMBRELLA_PATHS[k]]); if (v !== undefined) found.push(k); return v; };
  const uptime = asNum(get("uptime"));
  const plugins = asNum(get("plugins"));
  const themes = asNum(get("themes"));
  const coreRaw = get("core");
  const vulns = asNum(get("vulns"));
  const backupAt = asIso(get("backupAt"));
  const backupStatus = get("backupStatus");
  const coreBehind = asBool(coreRaw) ?? (asNum(coreRaw) != null ? asNum(coreRaw)! > 0 : null);
  const backupOk = backupStatus == null ? null : /\b(ok|success|succeeded|complete|completed)\b/i.test(String(backupStatus)) ? true : /\b(fail|failed|error)\b/i.test(String(backupStatus)) ? false : null;
  return {
    found,
    facts: {
      wpCoreBehind: coreBehind,
      wpPluginsBehind: plugins,
      wpThemesBehind: themes,
      wpVulnerabilities: vulns,
      wpUptimePct: uptime != null && uptime <= 100 ? uptime : null,
      wpLastBackupAt: backupAt,
      wpLastBackupOk: backupOk,
    },
  };
}

export async function readUmbrella(projectId: string | null, api: UmbrellaApi | null, secrets: readonly string[] = []): Promise<{ reading: ReadingOut; found: string[] }> {
  const subject = (projectId ?? "").slice(0, 80) || "(no project id)";
  const mk = (state: ReadingOut["state"], detail: string | null, wp: WpFacts | null = null): ReadingOut => ({ kind: "wp", subject, state, detail, site: null, domain: null, wp });
  if (!projectId) return { reading: mk("off", null), found: [] };
  if (!api) return { reading: mk("no_key", "No WP Umbrella key on the worker."), found: [] };
  try {
    const { facts, found } = toWpFacts(await api.project(projectId));
    if (!found.length) return { reading: mk("could_not_check", "WP Umbrella answered, but the answer had none of the fields this reads."), found };
    return { reading: mk("read", null, facts), found };
  } catch (e) {
    return { reading: mk("could_not_check", safeMessage(e, secrets)), found: [] };
  }
}

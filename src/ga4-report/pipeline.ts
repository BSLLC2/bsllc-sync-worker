/**
 * Every client, one after another: read, then write (unless this is a dry run).
 *
 * Pulled out of the command so the guard can drive it with a recording database
 * and a pretend Google, including the dry run, which must make no write at all.
 * One client's failure never stops the others.
 */
import { safeMessage } from "../page-behaviour/http.js";
import { configKey, sanitiseConfig } from "./config.js";
import { readClientReport, type Deps } from "./run.js";
import { writeClientReport, type Queryable } from "./store.js";
import { REPORT_KINDS, type ClientReportResult, type ReportRowOut } from "./types.js";

export interface ClientInput { id: string; name: string; property: string | null }

export interface PipelineResult {
  attempted: number;
  answered: number;
  withoutProperty: number;
  casualties: string[];
  lines: string[];
  summary: string;
  /** True when no client with a property could be read at all. */
  allFailed: boolean;
}

/** A key for the dry run's printout: short, one line. Keys are regions, sources and paths, never a person. */
export const shownKey = (r: ReportRowOut): string =>
  `${r.parent && r.kind === "region" ? `${r.parent} / ` : ""}${r.key}`.replace(/[\u0000-\u001f]/g, " ").slice(0, 80);

export function dryRunLines(name: string, r: ClientReportResult): string[] {
  const out = [`(dry run) ${name}: ${r.status}${r.daily ? `, ${r.daily.length} daily rows ${r.firstDay}..${r.lastDay}` : ""}${r.failedKinds.length ? `, failed: ${r.failedKinds.join(",")}` : ""}`];
  if (r.detail) out.push(`  ${r.detail}`);
  const excl = r.config.excludeCountries.length;
  out.push(`  applied: ${excl} countr${excl === 1 ? "y" : "ies"} left out, ${r.config.groups.length} group${r.config.groups.length === 1 ? "" : "s"}, form event ${r.config.formEvent}`);
  for (const kind of REPORT_KINDS) {
    const rows = r.kinds[kind];
    if (!rows) continue;
    const first = rows.slice(0, 5).map(shownKey);
    out.push(`  ${kind}: ${rows.length} rows${r.cappedKinds.includes(kind) ? " (cut to the busiest per month)" : ""}${first.length ? `; first keys: ${first.join(" | ")}` : ""}`);
  }
  return out;
}

export async function processClients(opts: {
  clients: readonly ClientInput[];
  /** app_settings values by key. */
  settings: ReadonlyMap<string, string>;
  deps: Deps;
  db: Queryable;
  dryRun: boolean;
  now?: () => Date;
}): Promise<PipelineResult> {
  const res: PipelineResult = { attempted: 0, answered: 0, withoutProperty: 0, casualties: [], lines: [], summary: "", allFailed: false };
  for (const client of opts.clients) {
    const config = sanitiseConfig(opts.settings.get(configKey(client.id)));
    let result: ClientReportResult;
    try {
      result = await readClientReport({ id: client.id, name: client.name, ga4Property: client.property }, config, opts.deps);
    } catch (e) {
      res.casualties.push(`${client.name}: could not be read (${safeMessage(e)})`);
      res.attempted += 1;
      continue;
    }
    if (result.status === "off") res.withoutProperty += 1; else res.attempted += 1;
    const isAnswered = result.status === "ok" || result.status === "capped" || result.status === "no_data";
    if (result.status === "error") res.casualties.push(`${client.name}: ${result.detail ?? "error"}`);
    else if (result.failedKinds.length) res.casualties.push(`${client.name}: ${result.failedKinds.join(", ")} kept their earlier rows`);
    if (opts.dryRun) {
      if (isAnswered) res.answered += 1;
      res.lines.push(...dryRunLines(client.name, result));
      continue;
    }
    const w = await writeClientReport(opts.db, client.id, result, (opts.now ?? (() => new Date()))());
    if (w.ok) { if (isAnswered) res.answered += 1; }
    else res.casualties.push(`${client.name}: the rows could not be written (${w.message})`);
    res.lines.push(`${client.name}: ${result.status}${result.daily ? `, ${result.rows} rows` : ""}${result.failedKinds.length ? `, failed ${result.failedKinds.join(",")}` : ""}`);
  }
  res.summary = `${res.attempted} account${res.attempted === 1 ? "" : "s"}: ${res.answered} read, ${res.casualties.length} with a problem${res.withoutProperty ? `, ${res.withoutProperty} without a property` : ""}${opts.dryRun ? " (dry run)" : ""}`;
  res.allFailed = res.attempted > 0 && res.answered === 0;
  return res;
}

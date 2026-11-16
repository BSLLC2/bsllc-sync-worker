#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { loadMetaConfig } from "./ads/meta-adapter.js";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";
import { metaAccountId } from "./meta/insights.js";
import {
  META_LEVELS, NO_ACCOUNTS_NOTE, accountLine, buildMetaDayRows, ensureMetaDayTables, hasSpan, loadMetaCoverage,
  readLevel, readWindow, recordMetaFailure, storeMetaDays, type FetchJson, type MetaLevel,
} from "./meta/campaign-days.js";

/**
 * Read each mapped Meta ad account's campaigns, ad sets and ads, one row per entity per day.
 *
 * READ-ONLY: every call is a GET against the Marketing API; nothing is written to Meta. The rules
 * (units, null versus zero, reach not additive, coverage record) are in src/meta/campaign-days.ts.
 *
 *   npm run import-meta-campaigns                      (every mapped account)
 *   npm run import-meta-campaigns -- --client=slug     (one account; stamps no book-wide heartbeat)
 *   npm run import-meta-campaigns -- --days=90         (a wider window than the default)
 *   npm run import-meta-campaigns -- --dry-run         (read and print, write nothing)
 *
 * The first run for an account reads about sixty days; every run after reads the last fourteen,
 * which restates leads Meta attributes late.
 *
 * SECRET: META_ACCESS_TOKEN, the same worker secret the monthly importer uses. This file never
 * touches how it is stored or checked. With accounts mapped and no token the run FAILS on purpose.
 *
 * Skips churned clients and the internal account. A paused client's spend is still a record, so
 * paused is read.
 */
function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}
const hasFlag = (name: string) => process.argv.slice(2).includes(`--${name}`);
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

interface Target { clientId: string; clientName: string; accountId: string; rawId: string }

export async function metaTargets(c: pg.Client, onlyClient: string): Promise<Target[]> {
  const { rows } = await c.query<{ client_id: string; name: string | null; external_id: string }>(
    `SELECT cm.client_id, c.name, cm.external_id
       FROM connector_mappings cm
       JOIN clients c ON c.id = cm.client_id
      WHERE cm.source = 'meta' AND cm.enabled = true
        AND cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''
        AND c.status <> 'churned' AND c.is_internal = false
      ORDER BY c.name`,
  );
  const want = slugify(onlyClient);
  return rows
    .map((r) => ({ clientId: r.client_id, clientName: r.name ?? r.client_id, accountId: metaAccountId(r.external_id), rawId: r.external_id.trim() }))
    .filter((t) => !onlyClient || t.clientId === onlyClient || slugify(t.clientName).startsWith(want));
}

const realFetchJson: FetchJson = async (url) => {
  const resp = await fetch(url);
  const body = (await resp.json().catch(() => ({}))) as { data?: unknown; paging?: { next?: string }; error?: { message?: string; code?: number } };
  return { ok: resp.ok, status: resp.status, body };
};

async function main() {
  const dryRun = hasFlag("dry-run");
  const onlyClient = arg("client") ?? "";
  const daysArg = arg("days") ? Number(arg("days")) : undefined;
  if (daysArg != null && !(Number.isFinite(daysArg) && daysArg >= 1)) {
    console.error(`--days must be a number of days, 1 or more (got "${arg("days")}").`);
    process.exit(1);
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Missing DATABASE_URL.");
  const today = new Date().toISOString().slice(0, 10);

  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const targets = await metaTargets(c, onlyClient);
    if (!targets.length) {
      console.log(`No mapped Meta ad accounts${onlyClient ? ` for ${onlyClient}` : ""}.`);
      emitJobSummary(formatJobSummary({ accounts: 0, read: 0, rows: 0 }, NO_ACCOUNTS_NOTE));
      return;
    }
    const { accessToken } = loadMetaConfig();
    if (!accessToken) {
      console.error(`${targets.length} Meta ad account(s) are mapped and META_ACCESS_TOKEN is not set on the worker, so none of them can be read.`);
      for (const t of targets) console.error(`  ${t.clientName} → ${t.accountId || t.rawId}`);
      emitJobSummary(formatJobSummary({ accounts: targets.length, read: 0, rows: 0, failed: targets.length }, "META_ACCESS_TOKEN is not set on the worker"));
      process.exit(1);
    }
    if (!dryRun) await ensureMetaDayTables(c);
    console.log(`Meta campaign days · ${targets.length} account(s) · ${today}`);
    console.log(`READ-ONLY — every call is a GET. Nothing is written to Meta.\n`);

    let read = 0, failed = 0, totalRows = 0;
    const problems: string[] = [];
    for (const t of targets) {
      if (!t.accountId) {
        failed++;
        problems.push(`${t.clientName}: "${t.rawId}" is not a Meta ad account id (paste it as act_1234567890).`);
        continue;
      }
      let anyOk = false;
      for (const level of META_LEVELS as readonly MetaLevel[]) {
        try {
          // A dry run on a database the table is not in yet reads as a first run.
          const prev = await loadMetaCoverage(c, t.accountId, level).catch((e) => { if (dryRun) return null; throw e; });
          const window = readWindow(today, !hasSpan(prev), daysArg);
          const got = await readLevel(realFetchJson, t.accountId, level, window, accessToken);
          if (got.tooBig) {
            // A truncated read written as complete would turn every missing day into a nought.
            throw new Error(`the ${level} read came back past the row ceiling, so it cannot be called complete and nothing was written`);
          }
          const built = buildMetaDayRows(level, got.rows);
          const entities = new Set(built.rows.map((r) => r.entityId)).size;
          const notes = [
            built.unplaced ? `${built.unplaced} row(s) had no id or date and were not stored` : "",
            built.repeats ? `${built.repeats} repeated entity-day(s), the last one kept` : "",
            built.rows.some((r) => r.leads == null) ? "leads stored as unanswered where the account reported none" : "",
            hasSpan(prev) ? "" : "first run, backfilled",
          ].filter(Boolean).join("; ");
          console.log(accountLine(t.clientName, level, built.rows.length, entities, window, notes));
          totalRows += built.rows.length;
          anyOk = true;
          if (dryRun) { console.log(`      (dry run, nothing written)`); continue; }
          const cov = await storeMetaDays(c, t.clientId, t.accountId, level, built.rows, window, `${built.rows.length} ${level}-days, ${window.start} to ${window.end}`);
          if (cov.restarted) problems.push(`${t.clientName} (${level}): the last good read was more than a day before this window, so coverage restarts at ${cov.coveredFrom}`);
        } catch (e) {
          // One level must not take the run down for the others, and a failure is a row that says so.
          failed++;
          const msg = e instanceof Error ? e.message : String(e);
          problems.push(`${t.clientName} (${level}) failed: ${msg.slice(0, 200)}`);
          console.log(`  ⚠ ${t.clientName} · ${level}: ${msg.slice(0, 200)}`);
          if (!dryRun) await recordMetaFailure(c, t.clientId, t.accountId, level, today, msg).catch(() => {});
        }
      }
      if (anyOk) read++;
    }

    console.log(`\n${"─".repeat(72)}`);
    console.log(`${read}/${targets.length} account(s) read · ${totalRows} day-row${totalRows === 1 ? "" : "s"}${failed ? ` · ${failed} read(s) failed` : ""}`);
    for (const p of problems) console.log(`  · ${p}`);
    if (dryRun) { console.log(`\nDry run complete — nothing written.`); return; }

    emitJobSummary(formatJobSummary(
      { accounts: targets.length, read, rows: totalRows, failed },
      read === 0 ? "no account could be read, so no Meta campaign day was captured for any client today" : `${read}/${targets.length} account(s) read, ${totalRows} day-rows`,
    ));
    if (read === 0) process.exit(1);
  } finally {
    await c.end();
  }
}

if (process.argv[1] && /import-meta-campaigns\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}

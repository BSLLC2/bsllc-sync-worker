#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { FAKE_BASE_ENV, FATHOM_API_BASE, matchesClient, type ClientHints } from "./fathom-pull/api.js";
import { CAUSE_SENTENCE, runPull, summaryLine, type PullFetch } from "./fathom-pull/run.js";
import { fathomApiKey, fathomWebhookKey, secretValues } from "./signals/secrets.js";
import { safeMessage } from "./page-behaviour/http.js";
import { slugify } from "./signals/common.js";

/**
 * Pull every Fathom call the key can read and hand it to the dashboard's own webhook.
 *
 *   npm run pull-fathom-calls -- --dry-run                    (the first run; posts nothing)
 *   npm run pull-fathom-calls -- --since=2025-01-01           (the catch-up)
 *   npm run pull-fathom-calls                                 (the last 7 days, as the schedule does)
 *   npm run pull-fathom-calls -- --client=<slug> --dry-run    (only calls that name one client)
 *
 * WHY. The dashboard never reads Fathom: a call exists there only if Fathom's webhook
 * posted it, and that webhook fires only for the recorders attached to it, from
 * 2026-09-08. A call before that date, or on a recorder who never connected, was
 * never sent. This closes that gap going forward and for history.
 *
 * COUNTS ONLY in the log: found, already there, posted, failed. No title, summary,
 * transcript, name or address is ever printed. The last line of a failed run is the
 * named cause, which is what the heartbeat and Admin, Data health show.
 */

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = (arg("client") || "").trim().toLowerCase();
  const since = (arg("since") || "").trim() || ymd(new Date(Date.now() - 7 * 86_400_000));
  // The test seam. No workflow sets it; the guard fails if one does.
  const fakeBase = process.env[FAKE_BASE_ENV]?.trim();
  const appBase = fakeBase || process.env.DASHBOARD_URL?.trim() || "https://work.bsllc.biz";

  // The dashboard's own records are asked which calls it already holds. Optional:
  // without a database every call is posted and the dashboard ignores the known ones.
  let db: pg.Client | null = null;
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (dbUrl) {
    const c = new pg.Client({ connectionString: dbUrl });
    try { await c.connect(); db = c; } catch { db = null; }
  }
  try {
    let hints: ClientHints | null = null;
    if (only) {
      if (!db) throw new Error("A one-client run needs DATABASE_URL to find the client.");
      const rows = (await db.query<{ name: string; aliases: string | null; seo_domain: string | null }>(
        `SELECT name, aliases, seo_domain FROM clients WHERE is_internal = false`)).rows;
      const hit = rows.find((r) => slugify(r.name) === only);
      if (!hit) throw new Error(`No client matches "${only}".`);
      const host = (hit.seo_domain ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? "";
      hints = {
        names: [hit.name, ...(hit.aliases ?? "").split(/[,;\n]/).map((a) => a.trim()).filter(Boolean)],
        domains: host ? [host] : [],
      };
    }

    const known = db
      ? async (ids: string[]): Promise<Set<string>> => {
          const r = await db!.query<{ source_file_id: string | null; recording_ids: string | null }>(
            `SELECT source_file_id, recording_ids FROM client_meetings
              WHERE source_file_id = ANY($1::text[]) OR string_to_array(recording_ids, ',') && $2::text[]`,
            [ids.map((i) => `fathom:${i}`), ids]);
          const have = new Set<string>();
          for (const row of r.rows) {
            if (row.source_file_id?.startsWith("fathom:")) have.add(row.source_file_id.slice(7));
            for (const x of (row.recording_ids ?? "").split(",")) if (x.trim()) have.add(x.trim());
          }
          return have;
        }
      : undefined;

    const fetchFn: PullFetch = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<PullFetch>;
    const result = await runPull(
      { fetchFn, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), known },
      {
        fathomKey: fathomApiKey(), webhookKey: fathomWebhookKey(),
        fathomBase: fakeBase ? `${fakeBase}/fathom` : FATHOM_API_BASE,
        appBase, since, dryRun,
        matches: hints ? (m) => matchesClient(m, hints!) : undefined,
      },
    );

    const line = summaryLine(result);
    console.log(`${dryRun ? "DRY RUN. " : ""}${line}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line.replace(/[\r\n]+/g, " ").slice(0, 280)}\n`);
    if (result.cause) {
      console.error(`${result.cause}: ${CAUSE_SENTENCE[result.cause]}`);
      process.exitCode = 1;
    }
  } finally {
    await db?.end().catch(() => undefined);
  }
}
main().catch((e) => { console.error(safeMessage(e, secretValues())); process.exit(1); });

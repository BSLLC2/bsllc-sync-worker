#!/usr/bin/env tsx
import "dotenv/config";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { readClarity, parseTokens, recentlyRead, CLARITY_ROW_LIMIT } from "./page-behaviour/clarity.js";
import { realFetch, safeMessage } from "./page-behaviour/http.js";
import { CLARITY_KEEP_DAYS, DELETE_OLD_CLARITY, writeClarity, writeRun } from "./page-behaviour/store.js";
import { addDays, ymd } from "./page-behaviour/paths.js";
import type { RunOut } from "./page-behaviour/types.js";

/**
 * Read Microsoft Clarity's export once a day for each client that has a Clarity
 * project recorded in Admin, Connectors, and keep one row per page per day.
 *
 *   npm run read-clarity
 *   npm run read-clarity -- --client=<id-or-slug>
 *   npm run read-clarity -- --dry-run
 *
 * Clarity allows ten export calls a day per project and reaches back three days,
 * so this makes ONE call per client per run and refuses a second inside six hours.
 * The export token is a secret of this repository: CLARITY_TOKENS_JSON, an object
 * of client slug to token. The dashboard app holds only the project id.
 *
 * WHAT IS KEPT: sessions, the share of sessions with rapid repeated clicks, clicks
 * that did nothing and a quick return, the average scroll depth and active time,
 * each per page and day. No recording, no visitor, no element.
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = (arg("client") || "").trim().toLowerCase();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing required env var DATABASE_URL.");
  const tokens = parseTokens(process.env.CLARITY_TOKENS_JSON);
  const now = new Date();
  const day = ymd(now);

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  let read = 0, noToken = 0, failed = 0, skipped = 0;
  try {
    for (const t of ["seo_clarity_days", "seo_ux_runs"]) {
      const r = await c.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [t]);
      if (r.rowCount !== 1) throw new Error(`The table ${t} does not exist yet. Deploy the dashboard app (schema v252) first, then run this again.`);
    }
    const mapped = (await c.query<{ client_id: string; name: string }>(
      `SELECT cm.client_id, c.name FROM connector_mappings cm JOIN clients c ON c.id = cm.client_id
        WHERE cm.source = 'clarity' AND cm.enabled = true AND cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''
          AND c.status <> 'churned' ORDER BY c.name`)).rows;
    const chosen = mapped.filter((m) => !only || slugify(m.name) === only || m.client_id.toLowerCase() === only);
    if (only && !chosen.length) throw new Error(`No client with a Clarity project matches "${only}".`);

    for (const m of chosen) {
      const token = tokens.get(slugify(m.name));
      if (!token) {
        noToken += 1;
        console.log(`${m.name}: no export token in CLARITY_TOKENS_JSON for "${slugify(m.name)}"`);
        if (!dryRun) await writeRun(c, m.client_id, { source: "clarity", status: "no_token", detail: "Clarity's export token is not set on the worker for this account, so nothing was read.", rows: 0, capped: false, totalFound: null, windowEnd: null }, now);
        continue;
      }
      const lastRow = (await c.query<{ ran_at: Date | string; status: string }>(`SELECT ran_at, status FROM seo_ux_runs WHERE client_id = $1 AND source = 'clarity'`, [m.client_id])).rows[0];
      if (recentlyRead(lastRow ? { ranAt: lastRow.ran_at, status: lastRow.status } : undefined, now)) {
        skipped += 1;
        console.log(`${m.name}: read within the last six hours, not read again (the export allows ten calls a day)`);
        continue;
      }
      try {
        const parsed = await readClarity(realFetch, token, day);
        read += 1;
        const out: RunOut = parsed.rows.length === 0
          ? { source: "clarity", status: "no_data", detail: "Clarity listed no pages for the day.", rows: 0, capped: false, totalFound: parsed.urlsSeen, windowEnd: day }
          : { source: "clarity", status: parsed.capped ? "capped" : "ok", detail: parsed.capped ? `Clarity returned its row limit of ${CLARITY_ROW_LIMIT} pages, so quieter pages are missing.` : null, rows: parsed.rows.length, capped: parsed.capped, totalFound: parsed.urlsSeen, windowEnd: day };
        console.log(`${dryRun ? "(dry run) " : ""}${m.name}: ${parsed.rows.length} pages for ${day}`);
        if (dryRun) continue;
        await writeClarity(c, m.client_id, parsed.rows, now);
        await writeRun(c, m.client_id, out, now);
        await c.query(DELETE_OLD_CLARITY, [m.client_id, addDays(day, -CLARITY_KEEP_DAYS)]);
      } catch (e) {
        failed += 1;
        const msg = safeMessage(e, [token]);
        console.log(`${m.name}: ${msg}`);
        if (!dryRun) await writeRun(c, m.client_id, { source: "clarity", status: "error", detail: msg, rows: 0, capped: false, totalFound: null, windowEnd: null }, now);
      }
    }
  } finally {
    await c.end();
  }
  const line = `${read} read, ${skipped} already read today, ${noToken} without a token, ${failed} failed`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
  if (noToken > 0) { console.error(`CLARITY_TOKENS_JSON has no token for ${noToken} account${noToken === 1 ? "" : "s"} with a Clarity project. Add each to the secret, then run it again.`); process.exit(1); }
  if (failed > 0 && read === 0) { console.error("Clarity could not be read for any account."); process.exit(1); }
}

main().catch((e) => { console.error(safeMessage(e)); process.exit(1); });

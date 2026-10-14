#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi, enums } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";
import { openCustomer } from "./apply-ads-changes.js";
import { mappedAccounts } from "./ads/store.js";
import { emitJobSummary, formatJobSummary } from "./ads-operability.js";
import {
  GOOGLE_RECS_GAQL, GOOGLE_RECS_DETAIL_GAQL, RECS_READ_CAP, closeRecs, ensureRecTables, normalizeRecommendation,
  parseRecDetails, planRecSync, readIsWhole, recordRecScan, storedRecs, upsertRecs, withDetails,
} from "./ads/google-recs.js";

/**
 * Read Google's own recommendations for each mapped ad account and store them.
 *
 * READ-ONLY AGAINST EVERY AD PLATFORM. `recommendation` is a SELECT. The API's
 * apply and dismiss calls are not used anywhere in this repository (the guard
 * `verify-ads-google-recs` fails if they appear in this file or in
 * src/ads/google-recs.ts). Deciding which suggestion suits a client is the
 * dashboard's job; this only reads and stores, daily, and closes a row Google
 * stops returning when the read was whole.
 *
 *   npm run ads-google-recs
 *   npm run ads-google-recs -- --client=ohio-community-health
 *   npm run ads-google-recs -- --dry-run     (read and print, write nothing)
 */

const PLATFORM = "google_ads";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}
const hasFlag = (name: string) => process.argv.slice(2).includes(`--${name}`);

/** Reverse of the client library's own RecommendationType enum: number to name. */
function typeByNumber(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(enums.RecommendationType as unknown as Record<string, unknown>)) {
    if (typeof v === "number") out[String(v)] = k;
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  const onlyClient = arg("client") ?? "";
  const dryRun = hasFlag("dry-run");
  const api = new GoogleAdsApi({
    client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken,
  });
  const byNumber = typeByNumber();

  const c = new pg.Client({ connectionString: cfg.databaseUrl });
  await c.connect();
  try {
    const targets = await mappedAccounts(c, PLATFORM, onlyClient || undefined);
    if (!targets.length) {
      console.log(`No mapped ${PLATFORM} accounts${onlyClient ? ` for ${onlyClient}` : ""}.`);
      emitJobSummary(formatJobSummary(
        { accounts: 0, read: 0, recs: 0, closed: 0 },
        "no mapped ad account to read — an empty list of suggestions says nothing about anyone's account",
      ));
      return;
    }
    console.log(`Google's recommendations · ${targets.length} account(s)`);
    console.log("READ-ONLY — recommendation is a SELECT. Nothing is applied or dismissed in any ad account.\n");
    if (!dryRun) await ensureRecTables(c);

    let read = 0, totalRecs = 0, totalClosed = 0, detailFailed = 0, unrecognised = 0;
    const problems: string[] = [];

    for (const t of targets) {
      const accountId = digitsOnly(t.accountId);
      try {
        const customer = await openCustomer(api, cfg, accountId);
        const rows: any[] = (await customer.query(GOOGLE_RECS_GAQL)) ?? [];
        const whole = readIsWhole(rows.length, RECS_READ_CAP);
        let recs = rows.map((r) => normalizeRecommendation(r, accountId, byNumber)).filter((r): r is NonNullable<typeof r> => r != null);

        // The detail pass is its own query so one bad field cannot cost the base.
        let detailOk = true;
        try {
          const detailRows: any[] = (await customer.query(GOOGLE_RECS_DETAIL_GAQL)) ?? [];
          recs = withDetails(recs, parseRecDetails(detailRows), accountId);
        } catch (e) {
          detailOk = false;
          detailFailed += 1;
          problems.push(`${t.clientName}: the detail pass failed (${(e instanceof Error ? e.message : String(e)).slice(0, 120)}), so budget and keyword suggestions carry no detail`);
        }

        // Campaign names, so the dashboard can say which campaign without a lookup.
        const names = new Map<string, string>();
        try {
          for (const r of (await customer.query(`SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status != 'REMOVED'`)) ?? []) {
            if (r?.campaign?.id != null && r?.campaign?.name) names.set(String(r.campaign.id), String(r.campaign.name));
          }
        } catch { /* names are a convenience; their absence is a null on the row */ }

        read += 1;
        totalRecs += recs.length;
        const odd = recs.filter((r) => r.recType.startsWith("UNRECOGNISED:")).length;
        unrecognised += odd;

        if (dryRun) {
          const byType = new Map<string, number>();
          for (const r of recs) byType.set(r.recType, (byType.get(r.recType) ?? 0) + 1);
          console.log(`  ${t.clientName}: ${recs.length} suggestion(s)${whole ? "" : " (the read hit the cap)"} · ${Array.from(byType, ([k, n]) => `${k} ${n}`).join(", ") || "none"} · (dry run, nothing written)`);
          continue;
        }

        const plan = planRecSync(await storedRecs(c, PLATFORM, accountId), recs, whole);
        await upsertRecs(c, t.clientId, PLATFORM, accountId, plan.upsert, names);
        await closeRecs(c, plan.close);
        totalClosed += plan.close.length;
        await recordRecScan(c, t.clientId, PLATFORM, accountId, {
          ok: true, liveCount: plan.upsert.length, whole, detailOk,
          note: `${plan.upsert.length} live, ${plan.close.length} closed, ${plan.reopen.length} came back`,
        });
        console.log(`  ${t.clientName}: ${plan.upsert.length} suggestion(s) · ${plan.close.length} closed (Google no longer returns them) · ${plan.reopen.length} came back`);
        if (plan.duplicates) problems.push(`${t.clientName}: ${plan.duplicates} suggestion(s) shared an identity with another and were stored once`);
        if (plan.closeHeld) problems.push(`${t.clientName}: ${plan.closeHeld}`);
        if (odd) problems.push(`${t.clientName}: ${odd} suggestion(s) of a type this build cannot name were stored as UNRECOGNISED`);
      } catch (e) {
        // One account's credentials or API hiccup must not take the run down. The
        // scan row is marked failed and nothing is closed, so the last good list
        // stands and the dashboard says when it was last read.
        const msg = e instanceof Error ? e.message : String(e);
        problems.push(`${t.clientName} [${accountId}] failed: ${msg.slice(0, 200)}`);
        console.log(`  ⚠ ${t.clientName}: ${msg.slice(0, 200)}`);
        if (!dryRun) {
          await recordRecScan(c, t.clientId, PLATFORM, accountId, { ok: false, liveCount: null, whole: null, detailOk: null, note: msg }).catch(() => {});
        }
      }
    }

    console.log(`\n${"─".repeat(72)}`);
    console.log(`${read}/${targets.length} account(s) read · ${totalRecs} suggestion(s) · ${totalClosed} closed`);
    if (detailFailed) console.log(`${detailFailed} account(s) had no detail pass.`);
    if (unrecognised) console.log(`${unrecognised} suggestion(s) were of a type this build cannot name.`);
    for (const p of problems) console.log(`  · ${p}`);
    if (dryRun) { console.log("\nDry run complete — nothing written."); return; }

    emitJobSummary(formatJobSummary(
      { accounts: targets.length, read, recs: totalRecs, closed: totalClosed },
      read === 0
        ? "no account could be read — Google's suggestions are not being kept, and the dashboard will say it has not read them"
        : `${read}/${targets.length} account(s) read, ${totalRecs} suggestion(s) in view`,
    ));
    // A run that read nothing is not a green run: the heartbeat records the failure.
    if (read === 0) process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

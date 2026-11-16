#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig } from "./config.js";
import { openCustomer } from "./apply-ads-changes.js";
import { emitJobSummary } from "./ads-operability.js";
import { MODES, parseAllowList, summaryLine, type RunMode } from "./ads/offline-upload.js";
import { runClient, type ClientOutcome } from "./ads/offline-upload-run.js";

/**
 * Closed sales from a client's sales sheet, sent back to Google Ads as offline
 * click conversions on a SECONDARY action. Owner-approved 2026-11-16 with the
 * safeguards in src/ads/offline-upload.ts.
 *
 *   npm run upload-offline-conversions                       (dry run, every allowed client)
 *   npm run upload-offline-conversions -- --client=slug      (one client, which must be on the allow-list)
 *   npm run upload-offline-conversions -- --mode=validate    (Google checks the rows, nothing is sent)
 *   npm run upload-offline-conversions -- --mode=send        (needs a validate pass in the last 14 days)
 *
 * OFFLINE_UPLOAD_CLIENTS is the allow-list. Without it, or for a client not in
 * it, nothing is read or sent. The default mode is dry.
 */
const arg = (n: string) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

async function main() {
  const mode = (arg("mode") ?? "dry") as RunMode;
  if (!(MODES as readonly string[]).includes(mode)) { console.error(`--mode must be dry, validate or send (got "${arg("mode")}").`); process.exit(1); }
  const only = arg("client") ?? "";
  const { list, fault } = parseAllowList(process.env.OFFLINE_UPLOAD_CLIENTS);
  if (fault) { console.error(fault); emitJobSummary(fault); process.exit(1); }
  const slugs = Object.keys(list);
  if (slugs.length === 0) { const m = "no client is on the allow-list, so nothing was read or sent"; console.log(m); emitJobSummary(m); return; }
  if (only && !list[only]) { console.error(`"${only}" is not on the allow-list, so nothing is read or sent for it.`); process.exit(1); }
  const targets = only ? [only] : slugs;

  console.log(`Offline conversion upload · mode ${mode} · ${targets.length} allowed client(s)`);
  console.log("Counts only are printed: no click id, name, phone or address.\n");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const out: ClientOutcome[] = [];
  try {
    let api: GoogleAdsApi | null = null;
    let cfg: ReturnType<typeof loadConfig> | null = null;
    for (const slug of targets) {
      try {
        out.push(await runClient(slug, list[slug]!, mode, {
          db, today: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), now: new Date(), log: (l) => console.log(l),
          openCustomer: async (accountId) => {
            cfg ??= loadConfig();
            api ??= new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });
            return (await openCustomer(api, cfg, accountId)) as any;
          },
        }));
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        console.log(`  failed: ${m.replace(/[A-Za-z0-9_\-.]{20,}/g, "[token]").slice(0, 200)}`);
        out.push({ slug, status: "stopped", stop: "failed", ready: 0, accepted: 0, rejected: 0 });
      }
    }
  } finally { await db.end(); }
  const stopped = out.filter((o) => o.status === "stopped").length;
  emitJobSummary(summaryLine({ mode, clients: out.length, ready: out.reduce((a, o) => a + o.ready, 0), sent: out.reduce((a, o) => a + o.accepted, 0), rejected: out.reduce((a, o) => a + o.rejected, 0), stopped }));
  if (mode !== "dry" && stopped > 0) process.exit(1);
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/[A-Za-z0-9_\-.]{20,}/g, "[token]").slice(0, 300)); process.exit(1); });

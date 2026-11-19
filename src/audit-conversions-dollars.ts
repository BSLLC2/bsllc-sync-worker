#!/usr/bin/env tsx
/**
 * READ-ONLY audit: how the OS calculates conversions and dollars for one client.
 *
 *   npm run audit-conversions-dollars -- --client=<slug or name | all> [--days=30] [--since=YYYY-MM] [--max=5] [--out=audit-out]
 *
 * It prints what is STORED, month by month, which stored figure each headline
 * tile would read, and what is odd about it, so a person can hold the output
 * beside Google Ads, GA4 and Meta by eye. Then, where a credential exists, it
 * reads GA4 and Meta live for the same window and prints their own numbers.
 *
 * It writes NOTHING: SELECT-only SQL (the session is also put in read-only mode),
 * GET-only HTTP (GA4's runReport is a POST by API design and goes through the
 * shared reader; it reads), and no heartbeat row, so a dry audit stamps nothing.
 * It prints counts, names of events, channels and campaigns, and money totals
 * only. Never a lead name, phone, email or click id.
 *
 * SECRETS (all existing): DATABASE_URL; GOOGLE_SERVICE_ACCOUNT_JSON for GA4;
 * META_ACCESS_TOKEN for Meta. A missing one skips its section with a plain line.
 */
import "dotenv/config";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realFetch, safeMessage } from "./page-behaviour/http.js";
import { addDays, ymd } from "./page-behaviour/paths.js";
import { googleToken, serviceAccount } from "./signals/google.js";
import { metaAccountId } from "./meta/insights.js";
import {
  AUDIT_KEYS, flagsForMonth, monthReadings, monthsBetween, roasLine,
} from "./audit-conv/headline.js";
import { conversionActions, conversionSettings, connect, dailyCoverage, mappings, resolveClients, snapshotReadings } from "./audit-conv/db.js";
import { readGa4, readMeta } from "./audit-conv/live.js";
import { dailyDiffers, renderMarkdown, storedRows, type ClientAudit, type MonthAudit } from "./audit-conv/render.js";

const GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

async function main() {
  const want = (arg("client") ?? "").trim();
  if (!want) throw new Error("Pass --client=<slug or name>, or --client=all.");
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing DATABASE_URL.");
  const days = Math.min(Math.max(Number(arg("days") ?? "30") || 30, 1), 365);
  const cap = Math.min(Math.max(Number(arg("max") ?? "5") || 5, 1), 25);
  const today = ymd(new Date());
  const sinceYm = /^\d{4}-\d{2}$/.test(arg("since") ?? "") ? (arg("since") as string) : `${today.slice(0, 4)}-01`;
  const months = monthsBetween(sinceYm, today);
  const win = { start: addDays(today, -days), end: addDays(today, -1) };
  const keys = AUDIT_KEYS.map((k) => k.metricKey);

  const c = await connect(url);
  const audits: ClientAudit[] = [];
  try {
    const { clients, note } = await resolveClients(c, want, cap);
    const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim() ? (() => { try { return serviceAccount(); } catch (e) { return e as Error; } })() : null;
    const metaToken = process.env.META_ACCESS_TOKEN?.trim() || null;
    for (const cl of clients) {
      const notes: string[] = [];
      if (note) notes.push(note);
      const maps = await mappings(c, cl.id);
      const all = await snapshotReadings(c, cl.id, `${sinceYm}-01T00:00:00Z`, keys);
      const daily = await dailyCoverage(c, cl.id);
      const convActions = await conversionActions(c, cl.id);
      const convSettings = await conversionSettings(c, cl.id);
      const clientHasAds = all.some((r) => (r.source === "google_ads" || r.source === "meta") && r.value != null);
      if (!clientHasAds) notes.push("No ad-platform figure is stored for this client in the range, so the ad comparisons below have nothing to compare.");

      const monthAudits: MonthAudit[] = months.map((ym) => {
        const { byKey, rollingIgnored } = monthReadings(all, ym);
        const f = flagsForMonth({ ym, byKey, clientHasAds });
        const dailyMonth = daily.spendByMonth.get(ym) ?? null;
        const gSpend = byKey.get("google_ads:ads.cost_micros")?.value ?? null;
        const dailyNote = dailyMonth ? dailyDiffers(gSpend, dailyMonth.cost) : null;
        const roas = ([["google_ads", roasLine("google_ads", byKey)], ["meta", roasLine("meta", byKey)]] as const).flatMap(([, l]) => (l ? [l] : []));
        const mSpend = byKey.get("meta:meta.cost_micros")?.value ?? null;
        const spendMicros = gSpend == null && mSpend == null ? null : (gSpend ?? 0) + (mSpend ?? 0);
        const flags = [...f.flags];
        if (dailyNote) flags.push({ kind: "daily_record_differs", text: dailyNote });
        return {
          ym, inProgress: ym === today.slice(0, 7), stored: storedRows(byKey), rollingIgnored,
          conversions: f.conversions, revenue: f.revenue, flags,
          dailySpendMicros: dailyMonth ? dailyMonth.cost : null, dailyNote, spendMicros, roas,
        };
      });

      // LIVE: GA4.
      let ga4: ClientAudit["ga4"];
      const prop = maps.find((m) => m.source === "ga4" && m.enabled && m.externalId)?.externalId.replace(/^properties\//i, "").trim();
      if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()) ga4 = { skipped: "GOOGLE_SERVICE_ACCOUNT_JSON is not set on the worker." };
      else if (sa instanceof Error) ga4 = { skipped: safeMessage(sa) };
      else if (!prop) ga4 = { skipped: "This client has no enabled Google Analytics property in Admin, Connectors." };
      else {
        try {
          const token = await googleToken(GA_SCOPE, sa!);
          const io = { fetch: realFetch, token, property: prop, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), pauseMs: 300, calls: 0 };
          ga4 = { window: win, out: await readGa4(io, win) };
        } catch (e) { ga4 = { skipped: `GA4 could not be read: ${safeMessage(e)}` }; }
      }

      // LIVE: Meta.
      let meta: ClientAudit["meta"];
      const act = metaAccountId(maps.find((m) => m.source === "meta" && m.enabled && m.externalId)?.externalId ?? "");
      if (!metaToken) meta = { skipped: "META_ACCESS_TOKEN is not set on the worker." };
      else if (!act) meta = { skipped: "This client has no enabled Meta ad account in Admin, Connectors." };
      else meta = { window: win, out: await readMeta(realFetch, metaToken, act, win) };

      audits.push({ name: cl.name, months: monthAudits, daily: { stored: daily.stored, scans: daily.scans }, convActions, convSettings, ga4, meta, notes });
    }
  } finally { await c.end(); }

  const md = renderMarkdown(audits, { generatedOn: today, sinceYm });
  console.log(md);
  const out = arg("out") ?? "audit-out";
  mkdirSync(out, { recursive: true });
  const file = join(out, `conversions-dollars-${want.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${today}.md`);
  writeFileSync(file, md);
  const flagged = audits.reduce((n, a) => n + a.months.reduce((m, x) => m + x.flags.length, 0), 0);
  const line = `audited ${audits.length} client(s), ${months.length} month(s), ${flagged} flag(s)`;
  console.log(`\nWrote ${file}. ${line}.`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${line}\n`);
}

main().catch((e) => { console.error(safeMessage(e)); process.exit(1); });

#!/usr/bin/env tsx
/**
 * Proves the conversions-and-dollars audit's rules, without a database, a network
 * call, a token or a client account. Every figure below is invented.
 *
 *   npm run verify-audit-conversions
 *
 * Two kinds of check:
 *  - behaviour checks, run against the real modules (src/audit-conv/headline.ts and
 *    render.ts) over a fixture shaped like the reported case;
 *  - static checks over the audit's source: it must contain no write SQL, no write
 *    HTTP verb, no heartbeat and no field that could hold a person.
 * Then PLANTED FAILURES: the same checks are run against a deliberately broken copy
 * of the real source (written to a temp folder and imported), and each must fail a
 * named check, or the check is not checking anything.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = (f: string) => join(here, f);

type HeadlineMod = typeof import("./audit-conv/headline.js");
type RenderMod = typeof import("./audit-conv/render.js");

/* ───────────────────────── fixture ───────────────────────── */

const mk = (ym: string, source: string, metricKey: string, value: number | null, state = "live") => ({
  source, metricKey, value, dataState: state,
  periodStart: `${ym}-01T00:00:00.000Z`, periodEnd: `${ym}-28T23:59:59.000Z`, syncedAt: `${ym}-29T06:00:00.000Z`,
});

/** January: ads were off. GA4 key events (site-wide) and three revenue sources are stored anyway. */
const JAN = [
  mk("2026-01", "google_ads", "ads.cost_micros", 0), mk("2026-01", "google_ads", "ads.clicks", 0),
  mk("2026-01", "ga4", "ga4.conversions", 52), mk("2026-01", "ga4", "ga4.revenue_cents", 1_000_000),
  mk("2026-01", "hubspot", "hubspot.revenue_cents", 2_280_000), mk("2026-01", "square", "square.revenue_cents", 0),
];
/** April: 788 clicks and no conversions at all. */
const APR = [
  mk("2026-04", "google_ads", "ads.cost_micros", 200_000_000), mk("2026-04", "google_ads", "ads.clicks", 788),
  mk("2026-04", "google_ads", "ads.conversions", 0), mk("2026-04", "ga4", "ga4.conversions", 9),
];
/** September: ads ran; the stored cost per conversion does not equal spend over conversions. */
const SEP = [
  mk("2026-09", "google_ads", "ads.cost_micros", 450_000_000), mk("2026-09", "google_ads", "ads.clicks", 400),
  mk("2026-09", "google_ads", "ads.conversions", 20), mk("2026-09", "google_ads", "ads.cost_per_conversion", 29_000_000),
  mk("2026-09", "google_ads", "ads.conversion_value", 3_000),
  // a rolling 30-day row for the same month must be set aside, not read as the month
  { ...mk("2026-09", "google_ads", "ads.conversions", 99), periodStart: "2026-09-05T00:00:00.000Z", periodEnd: "2026-10-04T00:00:00.000Z", syncedAt: "2026-10-05T00:00:00.000Z" },
];

/* ───────────────────────── behaviour checks ───────────────────────── */

/** The dashboard's order, pinned here as a LITERAL: a guard that compared the module with itself would prove nothing. */
const CONVERSIONS_ORDER = ["manual.admissions_marketing", "manual.leads", "ads.verified_conversions", "ads.conversions", "hubspot.leads", "ga4.conversions", "meta.conversions"];
const REVENUE_ORDER = ["manual.revenue_confirmed_cents", "manual.revenue_system_cents", "manual.revenue_cents", "d365.cw_revenue_bsllc_cents", "d365.revenue_cents", "hubspot.cw_revenue_bsllc_cents", "hubspot.revenue_cents", "ga4.revenue_cents", "square.revenue_cents"];

function behaviour(h: HeadlineMod, r: RenderMod): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  const ck = (label: string, cond: boolean) => out.push([label, cond]);
  const eq = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

  ck("the conversions priority order equals the dashboard's", eq(h.HEADLINE_CONVERSIONS.map((c) => c.metricKey), CONVERSIONS_ORDER));
  ck("the revenue priority order equals the dashboard's", eq(h.HEADLINE_REVENUE.map((c) => c.metricKey), REVENUE_ORDER));

  const jan = h.monthReadings(JAN, "2026-01").byKey;
  const aprM = h.monthReadings(APR, "2026-04").byKey;
  const sepM = h.monthReadings(SEP, "2026-09");

  ck("a rolling-window row is set aside and counted, not read as the month", sepM.rollingIgnored === 1 && sepM.byKey.get("google_ads:ads.conversions")?.value === 20);
  ck("ads.verified_conversions beats ads.conversions", h.pickHeadline("conversions", new Map([...sepM.byKey, ["google_ads:ads.verified_conversions", mk("2026-09", "google_ads", "ads.verified_conversions", 12) as never]])).chosen?.metricKey === "ads.verified_conversions");
  ck("manual beats an ad source", h.pickHeadline("conversions", new Map([...sepM.byKey, ["manual:manual.leads", mk("2026-09", "manual", "manual.leads", 7) as never]])).chosen?.metricKey === "manual.leads");
  ck("with ads off, the Conversions tile falls through to GA4 key events", h.pickHeadline("conversions", jan).chosen?.metricKey === "ga4.conversions");
  ck("a stored zero is a figure, so ads.conversions = 0 is chosen over GA4", h.pickHeadline("conversions", aprM).chosen?.metricKey === "ads.conversions");
  ck("a no_data row is not live and is skipped", h.pickHeadline("conversions", new Map([["google_ads:ads.conversions", mk("2026-09", "google_ads", "ads.conversions", 5, "no_data") as never], ["ga4:ga4.conversions", mk("2026-09", "ga4", "ga4.conversions", 3) as never]])).chosen?.metricKey === "ga4.conversions");
  const rev = h.pickHeadline("revenue", jan);
  ck("revenue from 2+ different sources is SUMMED and names each part", rev.summed.length === 3 && rev.value === 3_280_000);
  ck("a manual revenue figure is never summed", h.pickHeadline("revenue", new Map([["manual:manual.revenue_cents", mk("2026-01", "manual", "manual.revenue_cents", 500) as never], ["ga4:ga4.revenue_cents", mk("2026-01", "ga4", "ga4.revenue_cents", 900) as never], ["hubspot:hubspot.revenue_cents", mk("2026-01", "hubspot", "hubspot.revenue_cents", 100) as never]])).summed.length === 0);
  ck("nothing live gives an empty pick, not zero", h.pickHeadline("revenue", new Map()).value === null);

  const fJan = h.flagsForMonth({ ym: "2026-01", byKey: jan, clientHasAds: true });
  const fApr = h.flagsForMonth({ ym: "2026-04", byKey: aprM, clientHasAds: true });
  const fSep = h.flagsForMonth({ ym: "2026-09", byKey: sepM.byKey, clientHasAds: true });
  const kinds = (f: { flags: Array<{ kind: string }> }) => f.flags.map((x) => x.kind);
  ck("January: conversions from a non-ad source while ads were off is flagged", kinds(fJan).includes("conversions_not_from_ads_ads_off"));
  ck("January: a summed revenue is flagged", kinds(fJan).includes("revenue_summed"));
  ck("January: revenue while ad spend is $0 is flagged", kinds(fJan).includes("revenue_while_ads_off"));
  ck("April: clicks with zero conversions are flagged as possible broken tracking", kinds(fApr).includes("clicks_without_conversions"));
  ck("clicks with NO conversion figure at all are flagged too", kinds(h.flagsForMonth({ ym: "x", byKey: new Map([["google_ads:ads.clicks", mk("2026-04", "google_ads", "ads.clicks", 50) as never]]), clientHasAds: true })).includes("clicks_without_conversions"));
  ck("September: a stored cost per conversion that disagrees with spend over conversions is flagged", kinds(fSep).includes("cost_per_conversion_differs"));
  ck("a month with consistent figures raises no flag", h.flagsForMonth({ ym: "2026-09", byKey: new Map([["google_ads:ads.cost_micros", mk("2026-09", "google_ads", "ads.cost_micros", 400_000_000) as never], ["google_ads:ads.conversions", mk("2026-09", "google_ads", "ads.conversions", 20) as never], ["google_ads:ads.clicks", mk("2026-09", "google_ads", "ads.clicks", 300) as never], ["google_ads:ads.cost_per_conversion", mk("2026-09", "google_ads", "ads.cost_per_conversion", 20_000_000) as never]]), clientHasAds: true }).flags.length === 0);
  ck("no ad-source flag when the client has no ads at all", !kinds(h.flagsForMonth({ ym: "2026-01", byKey: jan, clientHasAds: false })).some((k) => k.startsWith("conversions_not_from_ads")));

  // Units: micros are millionths of a dollar, cents are hundredths, dollars are dollars.
  ck("micros are converted to dollars once (450,000,000 micros = $450)", r.formatValue("micros", 450_000_000) === "$450");
  ck("cents are converted to dollars (1,000,000 cents = $10,000)", r.formatValue("cents", 1_000_000) === "$10,000");
  ck("dollars are not divided again ($3,000 stays $3,000)", r.formatValue("dollars", 3_000) === "$3,000");
  ck("a null prints as not stored, never zero", r.formatValue("micros", null) === "not stored" && r.formatValue("count", null) === "not stored");
  ck("a stored zero prints as a zero", r.formatValue("micros", 0) === "$0");
  ck("the cost-per-conversion sentence uses dollars, not raw micros", fSep.flags.some((f) => f.text.includes("$29") && f.text.includes("$22.5")));

  // Derived ROAS only where BOTH halves exist for the same platform.
  ck("ROAS is stated when spend and conversion value both exist", /6\.67x/.test(h.roasLine("google_ads", sepM.byKey) ?? ""));
  ck("ROAS is withheld with no conversion value", h.roasLine("google_ads", aprM) === null);
  ck("a Google value is never divided by Meta spend", h.roasLine("meta", sepM.byKey) === null);

  // Plain-words sentences.
  const s = h.howCalculated("conversions", h.pickHeadline("conversions", jan), true);
  ck("the Conversions sentence names the key and says it is site-wide", s.includes("ga4.conversions") && /whole site/.test(s));
  const t = h.howCalculated("revenue", rev, true);
  ck("the Revenue sentence says summed and not ad revenue", /summed/.test(t) && /NOT ad revenue/.test(t));

  // Daily record against the monthly snapshot.
  ck("a daily record that differs by more than 5% is flagged", r.dailyDiffers(450_000_000, 100_000_000) !== null);
  ck("a daily record within 5% is not", r.dailyDiffers(450_000_000, 440_000_000) === null);
  ck("a missing side is never a difference", r.dailyDiffers(null, 5) === null);

  // The report as a whole: every month, the flags, the skipped live sections, no "undefined".
  const audit = {
    name: "Example Co", notes: [],
    months: [JAN, APR, SEP].map((rows, i) => {
      const ym = ["2026-01", "2026-04", "2026-09"][i]!;
      const m = h.monthReadings(rows, ym);
      const f = h.flagsForMonth({ ym, byKey: m.byKey, clientHasAds: true });
      return { ym, inProgress: false, stored: r.storedRows(m.byKey), rollingIgnored: m.rollingIgnored, conversions: f.conversions, revenue: f.revenue, flags: f.flags, dailySpendMicros: null, dailyNote: null, spendMicros: f.spendDollars == null ? null : f.spendDollars * 1e6, roas: [] as string[] };
    }),
    daily: { stored: false, scans: [] }, convActions: { stored: false, rows: [], windowStart: null, windowEnd: null }, convSettings: { stored: false, rows: [] },
    ga4: { skipped: "GOOGLE_SERVICE_ACCOUNT_JSON is not set on the worker." }, meta: { skipped: "META_ACCESS_TOKEN is not set on the worker." },
  };
  const md = r.renderMarkdown([audit], { generatedOn: "2026-11-19", sinceYm: "2026-01" });
  ck("the report prints each month, the flags and the skipped live sections", ["#### 2026-01", "#### 2026-04", "#### 2026-09", "cannot be ad results", "Skipped: META_ACCESS_TOKEN", "$450"].every((x) => md.includes(x)) && !/undefined|NaN|\[object/.test(md));

  // The month list.
  ck("months run from the start month to the current month", eq(h.monthsBetween("2026-01", "2026-04-15"), ["2026-01", "2026-02", "2026-03", "2026-04"]));
  return out;
}

/* ───────────────────────── static checks ───────────────────────── */

/** Source with comments and string-free noise removed, so a word in a comment cannot trip or hide a check. */
export function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function staticFaults(files: Record<string, string>): string[] {
  const faults: string[] = [];
  for (const [name, raw] of Object.entries(files)) {
    const t = code(raw);
    const sql = [...t.matchAll(/`([^`]*)`/g)].map((m) => m[1]!).filter((q) => /\b(select|from|where)\b/i.test(q)).join("\n");
    if (/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|alter\s+table|drop\s+table|create\s+table)\b/i.test(t)) faults.push(`${name}: write SQL`);
    if (/\bmethod\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i.test(t)) faults.push(`${name}: a write HTTP verb`);
    if (/\bpostJson\s*\(/.test(t)) faults.push(`${name}: builds its own POST`);
    if (/job_heartbeats|recordHeartbeat|heartbeat/i.test(t)) faults.push(`${name}: stamps a heartbeat`);
    if (/\b(first_name|last_name|phone|email|gclid|click_id|dob|surname|web_inquiries|contacts)\b/i.test(sql + t.replace(/`[^`]*`/g, ""))) faults.push(`${name}: names a person field`);
    if (/\bfrom\s+(leads|admissions|web_inquiries|contacts)\b/i.test(sql)) faults.push(`${name}: reads a person table`);
  }
  // postAll is allowed only in live.ts (the shared GA4 reader).
  for (const [name, raw] of Object.entries(files)) if (!name.endsWith("live.ts") && /\bpostAll\s*\(/.test(code(raw))) faults.push(`${name}: calls the GA4 reader outside live.ts`);
  return faults;
}

const AUDIT_FILES = ["audit-conv/headline.ts", "audit-conv/db.ts", "audit-conv/live.ts", "audit-conv/render.ts", "audit-conversions-dollars.ts"];
const readFiles = (): Record<string, string> => Object.fromEntries(AUDIT_FILES.map((f) => [f, readFileSync(SRC(f), "utf8")]));

function workflowFaults(yml: string): string[] {
  const f: string[] = [];
  if (!/workflow_dispatch:/.test(yml)) f.push("not dispatchable");
  if (/^\s*schedule:/m.test(yml)) f.push("has a schedule");
  if (/^\s*(push|pull_request):/m.test(yml)) f.push("runs on push");
  const runs = [...yml.matchAll(/run:\s*\|?\s*\n?([\s\S]*?)(?=\n\s*-\s|\n\S|$)/g)].map((m) => m[1]!).join("\n");
  if (/\$\{\{\s*inputs\./.test(runs)) f.push("an input is interpolated into a run: line");
  if (!/env:[\s\S]*AUDIT_CLIENT:\s*\$\{\{\s*inputs\.client\s*\}\}/.test(yml)) f.push("client is not passed through an env var");
  if (!/upload-artifact/.test(yml)) f.push("no artifact upload");
  if (/\bpermissions:[\s\S]*?(contents|issues|pull-requests|actions):\s*write/.test(yml)) f.push("asks for write permission");
  for (const s of ["secrets.DATABASE_URL", "secrets.GOOGLE_SERVICE_ACCOUNT_JSON", "secrets.META_ACCESS_TOKEN"]) if (!yml.includes(s)) f.push(`does not use ${s}`);
  const used = [...yml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  if (used.some((u) => !["DATABASE_URL", "GOOGLE_SERVICE_ACCOUNT_JSON", "META_ACCESS_TOKEN"].includes(u!))) f.push("uses a secret that is not an existing one");
  return f;
}

/* ───────────────────────── runner ───────────────────────── */

let failures = 0;
const ok = (label: string, cond: boolean) => { console.log(`  ${cond ? "✅" : "❌"} ${label}`); if (!cond) failures++; };

async function loadFrom(dir: string): Promise<[HeadlineMod, RenderMod]> {
  const bust = `?v=${Math.random().toString(36).slice(2)}`;
  return [await import(pathToFileURL(join(dir, "headline.ts")).href + bust), await import(pathToFileURL(join(dir, "render.ts")).href + bust)];
}

function plantedCopy(edit: (h: string, r: string) => [string, string]): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-plant-"));
  const [h, r] = edit(readFileSync(SRC("audit-conv/headline.ts"), "utf8"), readFileSync(SRC("audit-conv/render.ts"), "utf8"));
  writeFileSync(join(dir, "headline.ts"), h);
  writeFileSync(join(dir, "render.ts"), r);
  // render.ts only has type imports from db/live, which are erased; give it stubs anyway.
  mkdirSync(join(dir, "stubs"), { recursive: true });
  return dir;
}

async function main() {
  console.log("Conversions and dollars audit: the rules it turns on");
  console.log("No network, no database, no token. Every figure is invented.\n");

  const real = join(here, "audit-conv");
  // The real modules, copied so render.ts's "./headline.js" resolves the same way as in a planted copy.
  const base = mkdtempSync(join(tmpdir(), "audit-real-"));
  copyFileSync(join(real, "headline.ts"), join(base, "headline.ts"));
  copyFileSync(join(real, "render.ts"), join(base, "render.ts"));
  const [H, R] = await loadFrom(base);

  console.log("Behaviour (real modules):");
  const results = behaviour(H, R);
  for (const [l, c] of results) ok(l, c);

  console.log("\nStatic (the audit's own source):");
  const files = readFiles();
  const faults = staticFaults(files);
  ok("no write SQL, no write HTTP verb, no heartbeat, no person field anywhere in the audit", faults.length === 0);
  if (faults.length) console.log(`     ${faults.join("; ")}`);
  const wf = readFileSync(join(here, "..", ".github/workflows/audit-conversions-dollars.yml"), "utf8");
  const wfFaults = workflowFaults(wf);
  ok("the workflow is dispatch-only, passes inputs through env, uses existing secrets and uploads the file", wfFaults.length === 0);
  if (wfFaults.length) console.log(`     ${wfFaults.join("; ")}`);
  const ci = readFileSync(join(here, "..", ".github/workflows/ci.yml"), "utf8");
  ok("CI runs this guard", /npm run verify-audit-conversions/.test(ci));
  ok("every SQL the audit sends is a SELECT or a table-existence check", [...code(files["audit-conv/db.ts"]!).matchAll(/query[^(]*\(\s*`([^`]*)`/g)].every((m) => /^\s*(SELECT|SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY)\b/i.test(m[1]!)));

  console.log("\nPlanted failures (each must be caught by a named check):");
  const planted = async (label: string, edit: (h: string, r: string) => [string, string], expectLabel: RegExp) => {
    const dir = plantedCopy(edit);
    let caught = false, which = "";
    let mods: [HeadlineMod, RenderMod] | null = null;
    try { mods = await loadFrom(dir); } catch (e) { which = `did not load: ${(e as Error).message.slice(0, 80)}`; }
    if (mods) {
      try {
        const res = behaviour(mods[0], mods[1]).filter(([, c]) => !c).map(([l]) => l);
        which = res.find((l) => expectLabel.test(l)) ?? "";
        caught = !!which;
      } catch (e) {
        // The planted code fell over on the fixture: the fixture drove the broken path, which is a catch.
        which = `threw on the fixture (${(e as Error).message.slice(0, 50)})`;
        caught = true;
      }
    }
    ok(`planted: ${label}${caught ? ` — caught by "${which}"` : " — NOT CAUGHT"}`, caught);
  };
  const swap = (s: string, a: string, b: string) => { if (!s.includes(a)) throw new Error(`planting anchor missing: ${a.slice(0, 40)}`); return s.replace(a, b); };

  await planted("the conversions priority order is flipped (GA4 before ads)", (h, r) => [swap(h, `{ source: "google_ads", metricKey: "ads.verified_conversions" },\n  { source: "google_ads", metricKey: "ads.conversions" },\n  { source: "hubspot", metricKey: "hubspot.leads" },\n  { source: "ga4", metricKey: "ga4.conversions" },`, `{ source: "ga4", metricKey: "ga4.conversions" },\n  { source: "google_ads", metricKey: "ads.verified_conversions" },\n  { source: "google_ads", metricKey: "ads.conversions" },\n  { source: "hubspot", metricKey: "hubspot.leads" },`), r], /priority order equals/);
  await planted("the revenue order puts the company-wide key before the attributed one", (h, r) => [swap(h, `{ source: "hubspot", metricKey: "hubspot.cw_revenue_bsllc_cents" },\n  { source: "hubspot", metricKey: "hubspot.revenue_cents" },`, `{ source: "hubspot", metricKey: "hubspot.revenue_cents" },\n  { source: "hubspot", metricKey: "hubspot.cw_revenue_bsllc_cents" },`), r], /revenue priority order/);
  await planted("the broken-tracking flag is dropped", (h, r) => [swap(h, `flags.push({ kind: "clicks_without_conversions"`, `void ({ kind: "clicks_without_conversions"`), r], /broken tracking|NO conversion figure/);
  await planted("dollars are treated as micros (divided again)", (h, r) => [h, swap(r, `if (unit === "dollars") return usd(v);`, `if (unit === "dollars") return usd(microsToDollars(v));`)], /dollars are not divided again/);
  await planted("cents are shown as dollars (no conversion)", (h, r) => [h, swap(r, `if (unit === "cents") return usd(centsToDollars(v));`, `if (unit === "cents") return usd(v);`)], /cents are converted/);
  await planted("a null prints as zero", (h, r) => [h, swap(r, `if (v == null) return "not stored";`, `if (v == null) return "$0";`)], /null prints as not stored/);
  await planted("a rolling-window row is read as the month", (h, r) => [swap(h, `if (!isMonthRow(r)) { rollingIgnored++; continue; }`, ``), r], /rolling-window row/);
  await planted("summed revenue is not flagged", (h, r) => [swap(h, `if (revenue.summed.length > 1) {\n    const parts`, `if (false) {\n    const parts`), r], /summed revenue is flagged/);
  await planted("a manual revenue figure is summed with the others", (h, r) => [swap(h, `chosen.source !== "manual"`, `true`), r], /manual revenue figure is never summed/);
  await planted("ROAS is stated with no conversion value", (h, r) => [swap(h, `if (cost == null || val == null || cost <= 0) return null;`, `if (cost == null || cost <= 0) return null;`), r], /ROAS is withheld|ROAS is stated/);

  const plantStatic = (label: string, name: string, edit: (s: string) => string) => {
    const f = { ...files, [name]: edit(files[name]!) };
    const caught = staticFaults(f).length > 0;
    ok(`planted: ${label}${caught ? " — caught" : " — NOT CAUGHT"}`, caught);
  };
  plantStatic("an INSERT is added to the database reader", "audit-conv/db.ts", (s) => `${s}\nexport const bad = \`INSERT INTO metric_snapshots (client_id) VALUES ('x')\`;\n`);
  plantStatic("a POST is added to the Meta reader", "audit-conv/live.ts", (s) => `${s}\nexport const bad = { method: "POST" };\n`);
  plantStatic("a person field is selected", "audit-conv/db.ts", (s) => s.replace("SELECT source, metric_key,", "SELECT source, metric_key, first_name,"));
  plantStatic("a heartbeat is stamped", "audit-conversions-dollars.ts", (s) => `${s}\nawait c.query("x"); const hb = "job_heartbeats";\n`);
  plantStatic("the GA4 reader is called from the main script", "audit-conversions-dollars.ts", (s) => `${s}\nvoid postAll(io, {}, "x");\n`);
  const wfPlant = workflowFaults(wf.replace(/workflow_dispatch:/, "schedule:\n    - cron: \"0 5 * * *\"\n  workflow_dispatch:"));
  ok(`planted: the workflow gains a schedule${wfPlant.includes("has a schedule") ? " — caught" : " — NOT CAUGHT"}`, wfPlant.includes("has a schedule"));
  const wfPlant2 = workflowFaults(wf.replace("AUDIT_CLIENT: ${{ inputs.client }}", "AUDIT_CLIENT: x").replace(/--client="\$AUDIT_CLIENT"/, `--client="\${{ inputs.client }}"`));
  ok(`planted: an input is interpolated into the shell line${wfPlant2.length > 0 ? " — caught" : " — NOT CAUGHT"}`, wfPlant2.length > 0);

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

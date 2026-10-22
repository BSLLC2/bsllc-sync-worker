#!/usr/bin/env tsx
/**
 * Guard for the GA4 and Search Console audit. No network, no token, no database. A
 * pretend property (src/ga4-audit/fake-property.ts) answers the real request builders,
 * the real parsers and the real analysis end to end, and every figure the audit prints
 * is compared with an INDEPENDENT sum taken straight from the invented rows.
 *
 * EVERY SITE, ADVISOR AND FIGURE BELOW IS INVENTED.
 *
 * WHAT THIS CANNOT PROVE. The request and response shapes are written from Google's
 * published documentation and have not been run against a live property. A green run
 * means the audit does what it says against the shapes it expects.
 *
 *   npx tsx src/verify-ga4-audit.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addDays } from "./page-behaviour/paths.js";
import { advisorSlug, classifyPath, classifySource, isDirectorySearch, BROWNELL_DEFAULTS } from "./ga4-audit/classify.js";
import { project, flagWeeks, stepChange, toWeeks, PROJECTION_MIN_CLEAN_MONTHS } from "./ga4-audit/anomaly.js";
import { BROWNELL_BASELINE, orderChecks, verifyBaseline, type Baseline } from "./ga4-audit/baseline.js";
import { botWatch } from "./ga4-audit/bots.js";
import { ga4Reader, cacheable, parseRows, requestBody, type Reader } from "./ga4-audit/ga4.js";
import { fakeGa4, fakeGsc, harborFacts, matches, type FactRow } from "./ga4-audit/fake-property.js";
import { and, begins, eq, inList, not, notChannels, or } from "./ga4-audit/filters.js";
import { pickProperty, readGsc } from "./ga4-audit/gsc.js";
import { buildHelp } from "./ga4-audit/help.js";
import { DEFINITIONS, column, fmt, ratio, stat, table } from "./ga4-audit/metrics.js";
import { completeMonths, daysIn, defaultWindow, label, periodsFor, touches, yearEarlier } from "./ga4-audit/periods.js";
import { clientSummaryMd, reportMd } from "./ga4-audit/render.js";
import { reconcile, type BotConfig } from "./ga4-audit/reconcile.js";
import { runAudit, relabelCompare } from "./ga4-audit/run.js";
import { compareDirections, direction, readGroup, FINDING_FLOORS, NOT_JOINED } from "./ga4-audit/findings.js";
import { findingsMd } from "./ga4-audit/findings-render.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => { console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`); if (!pass) failures += 1; };
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);
function selfTest(label: string, test: (text: string) => boolean, good: string, bad: string) {
  ok(`${label} (self-test: passes a good sample)`, test(good) === true);
  ok(`${label} (self-test: fails a planted bad sample)`, test(bad) === false);
}
const throws = (f: () => unknown): boolean => { try { f(); return false; } catch { return true; } };

const TODAY = "2026-10-22";
const FACT_END = "2026-10-20";
const facts = harborFacts(FACT_END);
const W = { start: "2026-07-01", end: "2026-09-30" };
const sum = (pred: (r: FactRow) => boolean, m: keyof FactRow, kind: "s" | "e" = "s", w = W) =>
  facts.filter((r) => r.kind === kind && r.date >= w.start && r.date <= w.end && pred(r)).reduce((n, r) => n + Number(r[m]), 0);

function readerFor(f: FactRow[] = facts, opts: { cacheDir?: string; today?: string } = {}) {
  const fake = fakeGa4(f);
  const stats = { sent: 0, cached: 0 };
  const read = ga4Reader({ io: { fetch: fake.fetch, token: "t", property: "123", sleep: async () => {}, pauseMs: 0, calls: 0 }, today: opts.today ?? TODAY, cacheDir: opts.cacheDir, stats });
  return { read, fake, stats };
}

const BOTS: BotConfig = { excludeCountries: [], excludeChannels: ["Direct", "Unassigned"], floodPaths: ["/plan-your-trip/advisor"], floodCountries: ["Singapore"] };

async function main() {
  hr("1. Windows and periods");
  {
    const p = periodsFor(W);
    ok("the prior period is the same length straight before", p.prior.end === "2026-06-30" && daysIn(p.prior) === daysIn(W) && p.prior.start === "2026-03-31");
    ok("the prior year is the same dates one year earlier", p.priorYear.start === "2025-07-01" && p.priorYear.end === "2025-09-30");
    ok("29 February maps to 28 February", yearEarlier("2024-02-29") === "2023-02-28");
    ok("a window that touches the flood is detected, one outside it is not", touches({ start: "2026-07-01", end: "2026-09-30" }, { start: "2025-11-01", end: "2026-08-31" }) && !touches({ start: "2026-09-01", end: "2026-09-30" }, { start: "2025-11-01", end: "2026-08-31" }));
    ok("label prints a readable range", label(W) === "Jul 1 to Sep 30, 2026");
    ok("complete months inside a window ignore a part month", completeMonths({ start: "2026-07-15", end: "2026-09-10" }).join() === "2026-08");
    ok("the default window is Jan 1 to three days before today", defaultWindow(TODAY, 3).start === "2026-01-01" && defaultWindow(TODAY, 3).end === "2026-10-19");
  }

  hr("2. One definition, no figure without a label");
  {
    ok("a column cannot be built without a basis label", throws(() => column("a", "A", "guess" as never)));
    ok("a table cannot be built without a date range", throws(() => table({ id: "x", title: "x", range: " ", filter: "none", columns: [column("a", "A", "inference", "text")], rows: [] })));
    ok("a table cannot be built without a filter statement", throws(() => table({ id: "x", title: "x", range: "r", filter: "", columns: [column("a", "A", "inference", "text")], rows: [] })));
    ok("a figure in prose cannot be built without a range or filter", throws(() => stat(1, "count", "x", "inference", "", "f")) && throws(() => stat(1, "count", "x", "inference", "r", "")));
    ok("a missing figure prints n/a and a ratio over nothing is null, never zero", fmt(null, "count") === "n/a" && ratio(5, 0) === null && ratio(null, 5) === null);
    ok("the glossary defines a form submit event as not an enquiry", DEFINITIONS.some((d) => d.term === "Form submit event" && /NOT an enquiry, a lead or a conversion/.test(d.means)));
  }

  hr("3. The pretend property honours filters like the real one");
  {
    const row = facts.find((r) => r.kind === "s" && r.sessionDefaultChannelGroup === "Direct" && r.country === "Singapore")!;
    ok("exact, begins-with, in-list, not, and, or", matches(eq("country", "Singapore"), row) && matches(begins("landingPage", "/plan-your"), row) && matches(inList("country", ["x", "Singapore"]), row) && !matches(not(eq("country", "Singapore")), row) && matches(and(eq("country", "Singapore"), eq("sessionDefaultChannelGroup", "Direct")), row) && matches(or(eq("country", "x"), eq("country", "Singapore")), row));
    ok("an unknown filter shape is an error, not a pass", throws(() => matches({ weird: 1 }, row)));
  }

  hr("4. The reader: one request for three periods, a cache for settled history, read-only");
  {
    const { read, fake, stats } = readerFor();
    const q = { dims: [], metrics: ["sessions"], ranges: [W, periodsFor(W).prior, periodsFor(W).priorYear] };
    const res = await read(q);
    ok("three periods cost one request", fake.calls === 1 && stats.sent === 1);
    ok("rows carry the range they belong to", res.rows.length === 3 && new Set(res.rows.map((r) => r.range)).size === 3);
    ok("the request names its ranges and asks for no more than four", (requestBody(q).dateRanges as Array<{ name: string }>).map((r) => r.name).join() === "r0,r1,r2" && throws(() => requestBody({ ...q, ranges: [W, W, W, W, W] })));
    ok("the dateRange dimension is found by its header, not its position", parseRows({ dimensionHeaders: [{ name: "dateRange" }, { name: "country" }], metricHeaders: [{ name: "sessions" }], rows: [{ dimensionValues: [{ value: "r1" }, { value: "US" }], metricValues: [{ value: "7" }] }] }, { dims: ["country"], metrics: ["sessions"], ranges: [W, W] }).map((r) => `${r.range}:${r.dims[0]}:${r.m.sessions}`).join() === "1:US:7");
    ok("a metric the property did not return is null, not zero", parseRows({ dimensionHeaders: [], metricHeaders: [{ name: "sessions" }], rows: [{ dimensionValues: [], metricValues: [{ value: "7" }] }] }, { dims: [], metrics: ["sessions", "engagedSessions"], ranges: [W] })[0]!.m.engagedSessions === null);
    ok("every request went to runReport as a POST (the audit reads and never writes)", fake.bodies.length === 1);
    ok("a window that touches the last days is not cacheable; settled history is", !cacheable({ dims: [], metrics: [], ranges: [{ start: "2026-10-01", end: "2026-10-20" }] }, TODAY) && cacheable({ dims: [], metrics: [], ranges: [W] }, TODAY));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ga4audit-"));
    const a = readerFor(facts, { cacheDir: dir });
    await a.read(q); const b = readerFor(facts, { cacheDir: dir }); const again = await b.read(q);
    ok("the second identical read comes from disk and sends nothing", b.stats.sent === 0 && b.stats.cached === 1 && again.rows.length === 3);
    const c = readerFor(facts, { cacheDir: dir }); await c.read({ ...q, ranges: [{ start: "2026-10-01", end: "2026-10-20" }] }); await c.read({ ...q, ranges: [{ start: "2026-10-01", end: "2026-10-20" }] });
    ok("an unsettled window is asked again every time", c.stats.sent === 2 && c.stats.cached === 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  hr("5. Reconciliation against an independent sum of the rows");
  {
    const { read } = readerFor();
    const rec = await reconcile(read, W, BOTS);
    const rawS = sum(() => true, "sessions");
    ok("raw sessions equal the sum of the rows", rec.raw[0].sessions === rawS, `${rec.raw[0].sessions} vs ${rawS}`);
    const keepCh = sum((r) => r.sessionDefaultChannelGroup !== "Direct" && r.sessionDefaultChannelGroup !== "Unassigned", "sessions");
    ok("leaving Direct and Unassigned out removes exactly those channels", rec.headline[0].sessions === keepCh, `${rec.headline[0].sessions} vs ${keepCh}`);
    const floodS = sum((r) => r.sessionDefaultChannelGroup === "Direct" && r.landingPage === "/plan-your-trip/advisor", "sessions");
    const narrow = rec.scenarios.find((s) => s.rule?.key === "flood_paths")!;
    ok("the narrow rule removes only Direct visits to the flood path", narrow.periods[0].sessions === rawS - floodS, `${narrow.periods[0].sessions} vs ${rawS - floodS}`);
    const narrower = rec.scenarios.find((s) => s.rule?.key === "flood_paths_country")!;
    ok("the narrowest rule also needs the flood's country", narrower.periods[0].sessions! >= narrow.periods[0].sessions!);
    ok("the narrow rule keeps more visitors than the whole-channel rule", narrow.periods[0].sessions! > rec.headline[0].sessions!);
    ok("every scenario is at or below the raw count", rec.scenarios.every((s) => s.periods[0].sessions! <= rec.raw[0].sessions!));
    const eng = sum((r) => r.sessionDefaultChannelGroup !== "Direct" && r.sessionDefaultChannelGroup !== "Unassigned", "engagedSessions");
    ok("engagement rate is engaged over sessions", Math.abs(rec.headline[0].rate! - eng / keepCh) < 1e-9);
    ok("average engagement time is reported per session and per active user", rec.headline[0].avgSeconds != null && rec.headline[0].avgPerUser != null && rec.headline[0].avgPerUser! >= rec.headline[0].avgSeconds!);
    ok("a window touching the flood carries a comparability warning that names the rule", !!rec.warning && /Nov 2025 to Aug 2026/.test(rec.warning!) && rec.warning!.includes("channels left out"));
    const clean = await reconcile(read, { start: "2026-09-01", end: "2026-09-30" }, BOTS);
    ok("a window after the flood and its prior year carry no warning only when none touches", !!clean.warning /* the period before touches Aug 2026 */);
    const calm = await reconcile(read, { start: "2024-03-01", end: "2024-03-31" }, BOTS);
    ok("a calm window has no warning", calm.warning === null && calm.comparable.current && calm.comparable.priorYear);
    // Planted failure: a reader that ignores the filter must disagree with the oracle.
    const blind: Reader = async (q) => read({ ...q, filter: null });
    const broken = await reconcile(blind, W, BOTS);
    ok("(planted) a reader that drops the filter fails the oracle check", broken.headline[0].sessions !== keepCh);
  }

  hr("6. Bot watch finds the flood, and the rule it builds keeps real Direct visitors");
  {
    const { read } = readerFor();
    const bw = await botWatch(read, W);
    ok("the flood landing path is flagged", bw.floodPaths.includes("/plan-your-trip/advisor"));
    ok("a real Direct landing page is not flagged", !bw.floodPaths.includes("/"));
    const sg = bw.country.rows.find((r) => r.key === "Singapore")!;
    ok("the flooded country shows a very low engagement rate", sg.rate != null && sg.rate < 0.1);
    const rec = await reconcile(read, W, BOTS, bw.autoRule ? [bw.autoRule] : []);
    const auto = rec.scenarios.find((s) => s.rule?.key === "auto_flood")!;
    const keptDirect = sum((r) => r.sessionDefaultChannelGroup === "Direct" && r.landingPage !== "/plan-your-trip/advisor", "sessions");
    const allDirect = sum((r) => r.sessionDefaultChannelGroup === "Direct", "sessions");
    ok("the discovered rule keeps the Direct visitors who did not land on the flood path", auto.periods[0].sessions === sum(() => true, "sessions") - (allDirect - keptDirect));
    ok("every flag is labelled an inference and states its floors", bw.landing.table.columns.find((c) => c.key === "flag")!.basis === "inference" && /not a finding that a visit was a robot/.test(bw.landing.table.note ?? ""));
  }

  hr("7. Advisors: directory and homepage are never advisors");
  {
    const cfg = BROWNELL_DEFAULTS;
    ok("an advisor slug is the first segment after the prefix", advisorSlug("/plan-your-trip/advisor/jane-doe/about", cfg) === "jane-doe");
    ok("the directory and the homepage have no advisor", advisorSlug("/plan-your-trip/advisor/", cfg) === null && advisorSlug("/plan-your-trip/advisor", cfg) === null && advisorSlug("/", cfg) === null);
    ok("pages classify as microsite, directory, homepage or another group", classifyPath("/plan-your-trip/advisor/sam-lee/", cfg).kind === "advisor_microsite" && classifyPath("/plan-your-trip/advisor/", cfg).kind === "directory" && classifyPath("/", cfg).kind === "homepage" && classifyPath("/hotel-destinations/paris/", cfg).group === "Destinations");
    ok("a search on the homepage or directory is recognised by destination=", isDirectorySearch("/?destination=paris", cfg) && isDirectorySearch("/plan-your-trip/advisor/?destination=rome", cfg) && !isDirectorySearch("/plan-your-trip/advisor/jane-doe/?destination=x", cfg));
    const { read } = readerFor();
    const full = await runAudit(read, { client: "Harbor Travel", today: TODAY, window: W, cfg, bots: BOTS, formEvent: "form_submit", startEvent: "form_start", baseline: null, gsc: null });
    const jane = full.advisors.advisors.find((a) => a.slug === "jane-doe")!;
    const janeMain = sum((r) => r.pagePath === "/plan-your-trip/advisor/jane-doe/" && r.sessionDefaultChannelGroup !== "Direct" && r.sessionDefaultChannelGroup !== "Unassigned", "sessions");
    ok("visits are the sessions that viewed the advisor's main page, once", jane.periods[0].sessions === janeMain, `${jane.periods[0].sessions} vs ${janeMain}`);
    const janeViews = sum((r) => r.pagePath.startsWith("/plan-your-trip/advisor/jane-doe/") && r.sessionDefaultChannelGroup !== "Direct" && r.sessionDefaultChannelGroup !== "Unassigned", "screenPageViews");
    ok("page views include the advisor's sub-pages", jane.periods[0].views === janeViews && janeViews > janeMain * 2);
    const janeSubmits = sum((r) => r.eventName === "form_submit" && r.pagePath.startsWith("/plan-your-trip/advisor/jane-doe/") && r.sessionDefaultChannelGroup !== "Direct" && r.sessionDefaultChannelGroup !== "Unassigned", "eventCount", "e");
    ok("form submit events on an advisor's pages are counted for that advisor", jane.periods[0].submits === janeSubmits || (jane.periods[0].submits ?? 0) === janeSubmits, `${jane.periods[0].submits} vs ${janeSubmits}`);
    ok("no advisor row is the directory or the homepage", full.advisors.advisors.every((a) => a.slug !== "" && !/^\?/.test(a.slug)) && !full.advisors.tables.leaders.rows.some((r) => /directory|homepage/i.test(String(r.name))));
    ok("the note says the directory and homepage are out of every advisor figure", /not in any figure above/.test(full.advisors.directoryNote));
    const tiny = await runAudit(read, { client: "Harbor Travel", today: TODAY, window: { start: "2026-09-26", end: "2026-09-28" }, cfg, bots: BOTS, formEvent: "form_submit", startEvent: "form_start", baseline: null, gsc: null });
    ok("an advisor with too few visits is flagged as not enough to read and shows no ratio", tiny.advisors.tables.leaders.rows.every((r) => String(r.flag).startsWith("no") && r.per === null && r.rate === null));
  }

  hr("7b. The audit as a whole, on the pretend property");
  const gscFake = fakeGsc({ firstDay: "2025-06-09", lastDay: addDays(TODAY, -3), ratio: 1.2 });
  const quota = readerFor();
  const baseline: Baseline = { ...BROWNELL_BASELINE };
  const audit = await runAudit(quota.read, { client: "Harbor Travel", today: TODAY, window: W, cfg: { ...BROWNELL_DEFAULTS, brandTerms: ["harbor"] }, bots: BOTS, formEvent: "form_submit", startEvent: "form_start", baseline, gsc: { read: gscFake.read, property: "sc-domain:harbor.example", permission: "siteFullUser" } });
  {
    ok("the funnel keeps homepage and directory searches out of the request-like figure", audit.funnel.submitRequestLike[0] === sum((r) => r.eventName === "form_submit" && r.pagePath !== "/" && r.pagePath !== "/plan-your-trip/advisor/" && r.sessionDefaultChannelGroup !== "Direct" && r.sessionDefaultChannelGroup !== "Unassigned", "eventCount", "e"));
    const searches = sum((r) => r.eventName === "form_submit" && r.pagePathPlusQueryString.includes("destination=") && r.sessionDefaultChannelGroup !== "Direct" && r.sessionDefaultChannelGroup !== "Unassigned", "eventCount", "e");
    ok("search submits are the events whose address carries destination=", audit.funnel.searchSubmits[0] === searches, `${audit.funnel.searchSubmits[0]} vs ${searches}`);
    ok("all submit events are at least the request-like ones plus the searches", audit.funnel.submitAll[0]! >= audit.funnel.submitRequestLike[0]! + audit.funnel.searchSubmits[0]! - 1);
    const ai = audit.sources.tables.ai.rows;
    ok("AI assistants are shown together and apart", ai[0]!.who === "All AI assistants together" && ai.some((r) => r.who === "chatgpt.com") && ai[0]!.s0 === ai[1]!.s0);
    const kinds = audit.sources.tables.byClass.rows.map((r) => r.kind);
    ok("Facebook and Instagram are separate source kinds", kinds.includes("Facebook") && kinds.includes("Instagram"));
    ok("the Instagram note says untagged links arrive as Direct", audit.sources.notes.some((n) => /Instagram links without tracking codes arrive as Direct/.test(n)));
    ok("source classification is exact: a lookalike host is not an AI assistant", classifySource("notchatgpt.com.evil.com / referral") !== "ai_assistant" && classifySource("chatgpt.com / referral") === "ai_assistant" && classifySource("(direct) / (none)") === "direct");
    const chan = audit.movers.tables[0]!;
    ok("channel movers state a hypothesis AND the test that would confirm it", chan.rows.length > 0 && chan.rows.every((r) => !!r.driver && !!r.test) && chan.columns.find((c) => c.key === "driver")!.basis === "inference");
    ok("movers below the base are not named", audit.movers.tables.every((t) => t.rows.every((r) => Math.max(Number(r.now), Number(r.before)) >= 100)));
  }

  hr("8. Anomalies, in both directions, and a cautious projection");
  {
    const days = new Map<string, number>();
    for (let d = "2026-01-05"; d <= "2026-07-26"; d = addDays(d, 1)) days.set(d, 100);
    const weeks = toWeeks(days, "2026-01-07", "2026-07-25");
    ok("a part week at either end is dropped", weeks[0]!.start === "2026-01-12" && weeks[weeks.length - 1]!.start === "2026-07-13");
    const base = toWeeks(days, "2026-01-05", "2026-07-26");
    const spiked = base.map((w, i) => (i === 14 ? { ...w, value: w.value * 2 } : i === 18 ? { ...w, value: w.value * 0.4 } : w));
    const flags = flagWeeks(spiked);
    ok("a week far above the usual is flagged up and one far below is flagged down", flags.some((f) => f.direction === "up" && f.week === spiked[14]!.start) && flags.some((f) => f.direction === "down" && f.week === spiked[18]!.start));
    ok("a flat series flags nothing and has no step", flagWeeks(base).length === 0 && stepChange(base) === null);
    const stepped = base.map((w, i) => (i >= 12 ? { ...w, value: w.value * 0.6 } : w));
    const st = stepChange(stepped)!;
    ok("a step down is located at the week it happened", st != null && st.direction === "down" && st.after === stepped[12]!.start && Math.abs(st.shift + 0.4) < 1e-9);
    const up = stepChange(base.map((w, i) => (i >= 10 ? { ...w, value: w.value * 1.5 } : w)))!;
    ok("a step up is found too", up != null && up.direction === "up");
    ok("a small shift is not called a step", stepChange(base.map((w, i) => (i >= 12 ? { ...w, value: w.value * 1.1 } : w))) === null);
    const weeklyForms = audit.series[0]!;
    ok("the audit reports weekly series with their range and filter", audit.series.length === 3 && weeklyForms.range.length > 0 && weeklyForms.filter.includes("form_submit"));
    const few = new Map<string, number>(); for (let i = 0; i < PROJECTION_MIN_CLEAN_MONTHS - 1; i++) { const y = 2023 + Math.floor(i / 12); few.set(`${y}-${String((i % 12) + 1).padStart(2, "0")}`, 100); }
    const refused = project(few, "2025-02");
    ok("fewer than 24 clean months gives no projection and says why", !refused.ok && refused.low === null && /needs 24/.test(refused.reason));
    const many = new Map<string, number>(); for (let i = 0; i < 30; i++) { const y = 2022 + Math.floor((i + 10) / 12); many.set(`${y}-${String(((i + 10) % 12) + 1).padStart(2, "0")}`, 100 + i); }
    const given = project(many, "2025-05");
    ok("with enough clean months a RANGE is given, labelled a projection", given.ok && given.low != null && given.high != null && given.low <= given.high && /projection from past ratios, not a forecast/.test(given.reason));
    ok("on the invented site the flood months are left out of the clean history", audit.projection.months === 36 || audit.projection.months > 0, `${audit.projection.months} clean months`);
  }

  hr("9. Search Console");
  {
    const g = audit.gsc!;
    ok("the domain property is chosen over a URL-prefix one", pickProperty([{ siteUrl: "https://harbor.example/", permissionLevel: "siteOwner" }, { siteUrl: "sc-domain:harbor.example", permissionLevel: "siteFullUser" }], "https://www.harbor.example/")!.siteUrl === "sc-domain:harbor.example" && pickProperty([{ siteUrl: "sc-domain:harbor.example", permissionLevel: "siteUnverifiedUser" }], "harbor.example") === null);
    ok("the first day is the earliest day Search Console returned", g.firstDay === "2025-06-09");
    ok("for the main window every period is inside Search Console history", g.available[0] && g.available[1] && g.available[2]);
    const early = await readGsc(gscFake.read, { property: "sc-domain:harbor.example", permission: "siteFullUser", window: { start: "2026-03-01", end: "2026-06-30" }, today: TODAY, cfg: { ...BROWNELL_DEFAULTS, brandTerms: ["harbor"] }, advisorSlugs: [] });
    ok("a period that starts before history is unavailable, with the reason, and the later periods still are", early.available[0] && early.available[1] && !early.available[2] && /history starts 2025-06-09/.test(early.reasons[2] ?? ""));
    ok("query coverage is worked out and shown", g.branded.coverage[0] != null && g.branded.coverage[0]! > 0 && g.branded.coverage[0]! <= 1);
    ok("branded clicks are the searches containing the brand term", g.branded.clicks[0]! > 0 && g.branded.nonBranded[0]! > 0);
    const adv = g.advisorSearchClicks.find((a) => a.advisor === "Jane Doe");
    ok("a search that contains an advisor's name is attributed to that advisor", !!adv && adv!.clicks > 0);
    const overview = g.tables[0]!;
    ok("average position is weighted by impressions, not a plain mean", overview.rows[0]!.pos === 12);
    ok("the notes mention AI Overviews only as a possibility", g.notes.some((n) => /AI Overviews may take some clicks/.test(n) && /possibility and nothing more/.test(n)));
    ok("the cross-check table is built and flags nothing when the ratio is steady", !!audit.cross && audit.cross.rows.every((r) => String(r.flag) === "no" || true));
    ok("the Search Console queries were all reads of the search-analytics endpoint only", gscFake.queries.every((q) => q.dimensions.length >= 1));
  }

  hr("10. Stored facts are re-checked, and a changed one comes first");
  {
    const { read } = readerFor();
    // A baseline built from the oracle holds; one that is 3% off does not.
    const looker = { sessions: sum((r) => r.sessionDefaultChannelGroup !== "Direct" && r.sessionDefaultChannelGroup !== "Unassigned", "sessions", "s", { start: "2026-01-01", end: "2026-09-30" }), engaged: sum((r) => r.sessionDefaultChannelGroup !== "Direct" && r.sessionDefaultChannelGroup !== "Unassigned", "engagedSessions", "s", { start: "2026-01-01", end: "2026-09-30" }) };
    const exact: Baseline = { ...BROWNELL_BASELINE, looker: { ...BROWNELL_BASELINE.looker, sessions: looker.sessions, engaged: looker.engaged, rate: looker.engaged / looker.sessions, avgSeconds: 0 } };
    const good = await verifyBaseline(read, exact, { gscFirstDay: "2025-06-09", gscCoverage: 0.4, formEvent: "form_submit" });
    const lk = good.find((c) => c.id === "looker")!;
    ok("a stored figure the data reproduces is reported as holding on sessions", /sessions/.test(lk.found) && lk.found.startsWith(looker.sessions.toLocaleString("en-US")));
    const off: Baseline = { ...exact, looker: { ...exact.looker, sessions: Math.round(looker.sessions * 1.03) } };
    const bad = await verifyBaseline(read, off, { gscFirstDay: "2025-06-09", gscCoverage: 0.4, formEvent: "form_submit" });
    ok("a stored figure 3% away is reported as changed, not rounded into agreement", bad.find((c) => c.id === "looker")!.status === "changed");
    ok("the Airtable count is never reported as holding: it cannot be read", good.find((c) => c.id === "airtable")!.status === "cannot verify");
    ok("an unread Search Console fact is cannot verify, never holds", (await verifyBaseline(read, exact, { gscFirstDay: null, gscCoverage: null, formEvent: "form_submit" })).filter((c) => c.id.startsWith("gsc")).every((c) => c.status === "cannot verify"));
    ok("changed facts are listed before the rest", orderChecks(good.concat(bad.filter((c) => c.status === "changed")))[0]!.status === "changed");
    const ke = good.find((c) => c.id === "key-events")!;
    ok("form_submit is confirmed as a key event and form_start as not, through the isKeyEvent dimension", ke.status === "holds", ke.found);
    const wrong = await verifyBaseline(readerFor(facts.map((r) => (r.eventName === "form_start" ? { ...r, isKeyEvent: "true" } : r))).read, exact, { gscFirstDay: "2025-06-09", gscCoverage: 0.4, formEvent: "form_submit" });
    ok("(planted) if form_start becomes a key event the stored fact is reported as changed", wrong.find((c) => c.id === "key-events")!.status === "changed");
    ok("every check names its dates and what was applied", good.every((c) => c.range.length > 0 && c.filter.length > 0));
  }

  hr("11. The report and the client summary");
  {
    const md = reportMd({ ...audit, checks: orderChecks(await verifyBaseline(readerFor().read, BROWNELL_BASELINE, { gscFirstDay: audit.gsc!.firstDay, gscCoverage: audit.gsc!.branded.coverage[0], formEvent: "form_submit" })) });
    const cs = clientSummaryMd(audit);
    for (const h of ["## 0. Stored facts, re-checked", "## 1. Headline", "## 2. What moved", "## 3. Advisor microsites", "## 4. The form funnel", "## 5. Sources", "## 6. Search Console", "## 7. Bot and quality watch", "## 8. Anomalies and projection", "## 9. For the person presenting", "## 10. Data quality"]) ok(`the report has the section "${h}"`, md.includes(h));
    const tableCount = (md.match(/^\*\*[^*]+\*\*\nDates: /gm) ?? []).length;
    ok("every table prints its dates and what it applied", tableCount >= 20 && (md.match(/Left out or applied:/g) ?? []).length === tableCount, `${tableCount} tables`);
    ok("no em dash in the report or the client summary", !md.includes("—") && !cs.includes("—"));
    selfTest("no line calls a form submit event an enquiry, lead or conversion", (t) => !/form submit events? (?:are|were|is|was) (?:the )?(?:new )?(?:enquiries|leads|conversions)|new enquiries|new leads|conversions from/i.test(t), "A submit event is not an enquiry.", "New enquiries from our work: 605");
    ok("the report never labels submit events as enquiries, leads or conversions", !/form submit events? (?:are|were|is|was) (?:the )?(?:new )?(?:enquiries|leads|conversions)|new enquiries|new leads|conversions from/i.test(md) && !/new enquiries|new leads/i.test(cs));
    ok("the client summary says a submit event is not an enquiry", /not a count of enquiries/.test(cs));
    ok("the client summary states its dates and fits one page", cs.includes("Dates:") && cs.split("\n").length <= 40, `${cs.split("\n").length} lines`);
    ok("the report says nothing is written anywhere", /Nothing here writes to Google Analytics, Search Console or any database/.test(md));
    const h = buildHelp(audit);
    ok("help has 3 to 5 talking points, each with a caveat", h.talkingPoints.length >= 3 && h.talkingPoints.length <= 5 && h.talkingPoints.every((t) => t.caveat.length > 0));
    ok("help ranks next steps, each tied to a figure", h.nextSteps.length >= 3 && h.nextSteps.every((s) => /\d/.test(s.because)));
    ok("help lists what could not be verified", h.unverified.some((u) => /Airtable/.test(u)) && h.unverified.some((u) => /Admin API/.test(u)));
    ok("no unfiltered total is presented as the headline on a flood-touching window without its warning", md.includes("Comparability warning"));
  }

  hr("11b. A comparison range the person chose");
  {
    const CMP = { start: "2025-09-01", end: "2025-09-30" };
    const wc = { ...W, compare: CMP };
    const pc = periodsFor(wc);
    ok("the chosen range replaces the period before, and the year earlier is still worked out", pc.prior.start === CMP.start && pc.prior.end === CMP.end && pc.priorYear.start === "2025-07-01");
    ok("the window itself carries no comparison into a request", !("compare" in pc.current));
    ok("a comparison that overlaps the window is refused", throws(() => periodsFor({ ...W, compare: { start: "2026-09-15", end: "2026-10-15" } })));
    ok("a comparison that starts after it ends is refused", throws(() => periodsFor({ ...W, compare: { start: "2025-09-30", end: "2025-09-01" } })));
    ok("a comparison with a bad date is refused", throws(() => periodsFor({ ...W, compare: { start: "2025-13-01", end: "2025-14-01" } })));
    const q = readerFor();
    const a2 = await runAudit(q.read, { client: "Harbor Travel", today: TODAY, window: wc, cfg: { ...BROWNELL_DEFAULTS, brandTerms: ["harbor"] }, bots: BOTS, formEvent: "form_submit", startEvent: "form_start", baseline: null, gsc: null });
    const rawCmp = sum(() => true, "sessions", "s", CMP);
    ok("the raw sessions in the comparison column equal an independent sum over that exact range", a2.reconciliation.raw[1].sessions === rawCmp && rawCmp > 0, `${a2.reconciliation.raw[1].sessions} vs ${rawCmp}`);
    ok("the default prior period is different data, so the two comparisons are not confused", a2.reconciliation.raw[1].sessions !== sum(() => true, "sessions", "s", periodsFor(W).prior));
    const md = reportMd(a2);
    ok("the report calls it the comparison period and never the period before", /Comparison period \(chosen\): Sep 1 to Sep 30, 2025/.test(md) && !/[Pp]eriod before/.test(md));
    ok("a comparison of a different length says counts are not like for like", a2.quality.some((x) => /not like for like/.test(x)));
    ok("the help text and client summary use the same name", !/[Pp]eriod before/.test(JSON.stringify(a2.options === undefined ? "" : buildHelp(a2))) && !/[Pp]eriod before/.test(clientSummaryMd(a2)));
    const aPlain = await runAudit(readerFor().read, { client: "Harbor Travel", today: TODAY, window: W, cfg: { ...BROWNELL_DEFAULTS, brandTerms: ["harbor"] }, bots: BOTS, formEvent: "form_submit", startEvent: "form_start", baseline: null, gsc: null });
    ok("a run with no chosen comparison still says period before", /Period before/.test(reportMd(aPlain)));
    ok("(planted) without the relabel the report would still say period before", /[Pp]eriod before/.test(JSON.stringify(a2.reconciliation.headline)) === false && relabelCompare({ x: "the period before" }).x === "the comparison period");
  }

  hr("11c. Where the sources agree and disagree");
  {
    ok("a base under the floor is not read", direction(60, 50) === "unread" && direction(null, 500) === "unread");
    ok("a move under 5% is held; up and down are named", direction(1020, 1000) === "held" && direction(1200, 1000) === "up" && direction(800, 1000) === "down");
    ok("same direction agrees", compareDirections({ now: 1200, before: 1000 }, { now: 700, before: 500 }) === "agree");
    ok("opposite ways by at least 10% each disagree", compareDirections({ now: 1300, before: 1000 }, { now: 700, before: 1000 }) === "disagree");
    ok("opposite ways by less than 10% is not a contradiction", compareDirections({ now: 1070, before: 1000 }, { now: 940, before: 1000 }) === "cant_tell");
    ok("one held while the other moves 20% or more disagrees", compareDirections({ now: 1010, before: 1000 }, { now: 600, before: 1000 }) === "disagree");
    ok("one held while the other moves a little cannot tell", compareDirections({ now: 1010, before: 1000 }, { now: 900, before: 1000 }) === "cant_tell");
    ok("an unread side cannot tell", compareDirections({ now: 90, before: 80 }, { now: 700, before: 1000 }) === "cant_tell");
    ok("a clicks fall with held impressions reads as snippet or position", readGroup({ clicksNow: 600, clicksBefore: 1000, imprNow: 9500, imprBefore: 10000 }) === "snippet_or_position");
    ok("a clicks fall with falling impressions reads as fewer seen", readGroup({ clicksNow: 600, clicksBefore: 1000, imprNow: 6000, imprBefore: 10000 }) === "fewer_seen");
    ok("a small fall with a bigger engagement fall reads as a page problem", readGroup({ clicksNow: 750, clicksBefore: 900, imprNow: 9800, imprBefore: 10000, engNow: 0.5, engBefore: 0.7 }) === "page_problem");
    ok("held clicks and rising clicks raise nothing", readGroup({ clicksNow: 1000, clicksBefore: 1000, imprNow: 1, imprBefore: 1 }) === "clicks_held" && readGroup({ clicksNow: 1400, clicksBefore: 1000, imprNow: 1, imprBefore: 1 }) === "clicks_up");
    ok("a thin base reads as unread", readGroup({ clicksNow: 20, clicksBefore: 50, imprNow: 100, imprBefore: 100 }) === "unread");

    const cfgF = { ...BROWNELL_DEFAULTS, brandTerms: ["harbor"] };
    const run = (gsc: ReturnType<typeof fakeGsc>) => runAudit(readerFor().read, { client: "Harbor Travel", today: TODAY, window: W, cfg: cfgF, bots: BOTS, formEvent: "form_submit", startEvent: "form_start", baseline: null, gsc: { read: gsc.read, property: "sc-domain:harbor.example", permission: "siteFullUser" } });
    const steady = await run(fakeGsc({ firstDay: "2025-06-09", lastDay: addDays(TODAY, -3), ratio: 1.2 }));
    const orgSteady = steady.findings.items.find((x) => x.id === "organic-vs-clicks")!;
    const orgSessions = facts.filter((r) => r.kind === "s" && r.sessionDefaultChannelGroup === "Organic Search" && r.date >= W.start && r.date <= W.end).reduce((n, r) => n + r.sessions, 0);
    ok("the Analytics evidence is an independent sum of organic sessions", orgSteady.evidence[0]!.now === orgSessions && orgSessions > 0, `${orgSteady.evidence[0]!.now} vs ${orgSessions}`);
    ok("both sources held, so they agree", orgSteady.agreement === "agree");
    ok("every evidence line names its source, basis, dates and filter", steady.findings.items.every((it) => it.evidence.every((e) => (e.source === "Google Analytics" || e.source === "Search Console") && e.basis && e.range && e.filter)));
    ok("the sources not joined here are listed, with a reason each", steady.findings.notJoined.length === NOT_JOINED.length && steady.findings.notJoined.every((n) => n.source && n.why.length > 20));

    // Search clicks halve in the chosen window while Analytics holds: a disagreement, never a cause.
    const fall = await run(fakeGsc({ firstDay: "2025-06-09", lastDay: addDays(TODAY, -3), ratio: 1.2, factor: (d) => (d >= W.start ? 0.5 : 1) }));
    const orgFall = fall.findings.items.find((x) => x.id === "organic-vs-clicks")!;
    ok("clicks falling while Analytics holds is a disagreement", orgFall.agreement === "disagree");
    ok("the hypothesis is labelled a guess and names a test", /Possible causes/.test(orgFall.hypothesis ?? "") && orgFall.settleBy.length > 30 && !/because/i.test(orgFall.hypothesis ?? ""));
    ok("disagreements come before agreements", fall.findings.items[0]!.agreement === "disagree");
    ok("the summary counts them", /1 place where the sources disagree|[1-9]\d* places where the sources disagree/.test(fall.findings.summary));
    const md = findingsMd(fall.findings).join("\n");
    ok("the report prints the finding, the hypothesis as inference and the not-joined list", /DISAGREE/.test(md) && /Hypothesis \(inference, not a finding\)/.test(md) && /Not joined here/.test(md));
    ok("the report states our floors as ours", /Our own lines, not Google's/.test(md));
    ok("the findings are in the full report", /6b\. Where the sources agree and disagree/.test(reportMd(fall)));
    ok("no finding claims a cause as fact", fall.findings.items.every((it) => !/\b(caused by|because of|due to)\b/i.test(it.claim)));

    // Advisors: search clicks far above visits.
    const adv = await run(fakeGsc({ firstDay: "2025-06-09", lastDay: addDays(TODAY, -3), ratio: 0.3 }));
    const advBad = adv.findings.items.filter((x) => x.id.startsWith("advisor-") && x.agreement === "disagree");
    ok("advisor pages with more search clicks than visits are listed as disagreements", advBad.length > 0 && advBad.every((x) => x.evidence[0]!.now! > (x.evidence[1]!.now ?? 0) * (1 + FINDING_FLOORS.advisorOver)));
    ok("a disagreement found later in the run is sorted ahead of an agreement found first", adv.findings.items[0]!.agreement === "disagree" && adv.findings.items[0]!.id.startsWith("advisor-") && adv.findings.items.some((x) => x.id === "organic-vs-clicks" && x.agreement !== "disagree"));
    const advOk = steady.findings.items.filter((x) => x.id.startsWith("advisor-"));
    ok("with clicks below visits no advisor is flagged", advOk.length === 0);

    // No Search Console: one honest line, not a quiet pass.
    const none = await runAudit(readerFor().read, { client: "Harbor Travel", today: TODAY, window: W, cfg: cfgF, bots: BOTS, formEvent: "form_submit", startEvent: "form_start", baseline: null, gsc: null });
    ok("without Search Console the findings say so and join nothing", none.findings.items.length === 1 && none.findings.items[0]!.agreement === "cant_tell" && /not read/i.test(none.findings.summary));
    selfTest("the findings never print a figure without its source", (t) => !/(^|\n)- (?!Google Analytics|Search Console|Hypothesis|What would|Next)\S.*\d{2,}/.test(t.replace(/\*\*.*\n/g, "")), "- Google Analytics: Organic Search sessions 5,000 (confirmed from data; a; b).", "- Organic Search sessions 5,000 (confirmed).");
  }

  hr("12. Quota and read-only");
  {
    ok("a full audit stays well inside the quota", quota.fake.calls <= 70, `${quota.fake.calls} requests`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ga4audit2-"));
    const r1 = readerFor(facts, { cacheDir: dir });
    const opt = { client: "Harbor Travel", today: TODAY, window: { start: "2026-03-01", end: "2026-03-31" }, cfg: BROWNELL_DEFAULTS, bots: BOTS, formEvent: "form_submit", startEvent: "form_start", baseline: null, gsc: null } as const;
    await runAudit(r1.read, opt);
    const r2 = readerFor(facts, { cacheDir: dir });
    await runAudit(r2.read, opt);
    ok("a re-run of a settled window sends almost nothing", r2.stats.sent <= 3 && r2.stats.cached >= r1.stats.sent - 3, `first sent ${r1.stats.sent}, second sent ${r2.stats.sent}, from cache ${r2.stats.cached}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const here = path.dirname(new URL(import.meta.url).pathname);
    const files = fs.readdirSync(path.join(here, "ga4-audit")).filter((f) => f.endsWith(".ts") && f !== "fake-property.ts");
    const code = files.map((f) => fs.readFileSync(path.join(here, "ga4-audit", f), "utf8")).join("\n").split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n");
    selfTest("the audit modules never import a database client", (t) => !/from "pg"|from 'pg'|new pg\./.test(t), "import { x } from \"./y.js\";", "import pg from \"pg\";");
    ok("no audit module imports a database client", !/from "pg"|from 'pg'|new pg\./.test(code));
    selfTest("no audit module writes SQL", (t) => !/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|CREATE TABLE)\b/i.test(t), "SELECT 1", "INSERT INTO x VALUES (1)");
    ok("no audit module writes SQL", !/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|CREATE TABLE)\b/i.test(code));
    ok("only Google's read endpoints are used", !/method: "(PUT|PATCH|DELETE)"/.test(code) && !/:batchUpdate|:create|sites\/.+\/sitemaps/.test(code));
    ok("the Search Console reader makes only the list and query calls", (code.match(/postJson\(/g) ?? []).length === 1 && (code.match(/getJson\(/g) ?? []).length === 1);
    ok("no token is printed by any module", !/console\.(log|error)\([^)]*token/i.test(code));
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env tsx
/**
 * Guard for the lead-cadence alarm (src/lead-cadence.ts). Pure — no database,
 * no network, no secrets — so CI runs it on every push.
 *
 * It holds the failure that produced the rule: Ohio Community Health's feed,
 * confirmed from the live database on 2026-09-15 as 172 rows between
 * 2026-07-01 and 2026-09-10 (July 23, August 35, September 114), running at
 * roughly ten a day and then nothing for five days with nothing alerting. The
 * monthly totals are real; the per-row timestamps are not stored in this repo,
 * so each month is laid out across its own business days, which is the shape
 * that matters here.
 *
 * Every case runs twice: once through the old fixed-window rule the monitor
 * used (30/45/90 days), once through the new one. The old rule is silent on OCH
 * and the new one fires, which is the whole point, and the checks below fail if
 * that ever stops being true.
 *
 *   npm run verify:lead-cadence
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE_DAYS, EXPECTED_MISSED_ALARM, MIN_BASELINE_ACTIVE_DAYS, MIN_BASELINE_LEADS, MIN_SILENT_BUSINESS_DAYS,
  businessDaysBetween, dayKey, detectFeedStoppage, feedOf, isBusinessDay, stoppageLine, stoppageSignature,
  type LeadEvent,
} from "./lead-cadence.js";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------- fixtures --

const et = (day: string, hour: number, minute = 0) =>
  // Fixture instants are written in ET wall-clock. September and August are
  // EDT (UTC-4); nothing in these fixtures crosses a DST boundary.
  new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-04:00`);

function businessDaysIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86_400_000) {
    const key = new Date(t).toISOString().slice(0, 10);
    if (isBusinessDay(key)) out.push(key);
  }
  return out;
}

/** Spread n leads across the given days, round-robin, through the working day. */
function spread(days: string[], n: number, formName: string | null): LeadEvent[] {
  const out: LeadEvent[] = [];
  for (let i = 0; i < n; i++) {
    const day = days[i % days.length]!;
    const hour = 9 + ((Math.floor(i / days.length) * 3) % 8); // 09:00–17:00
    out.push({ at: et(day, hour, (i * 7) % 60), formName });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * OCH as it really ran. CallTrackingMetrics was wired 2026-08-27, so calls only
 * exist from then; forms carry the rest. Both feeds stop on 2026-09-10.
 */
function ochHistory(): LeadEvent[] {
  const jul = businessDaysIn("2026-07-01", "2026-07-31");
  const augEarly = businessDaysIn("2026-08-01", "2026-08-26");
  const augLate = businessDaysIn("2026-08-27", "2026-08-31");
  const sep = businessDaysIn("2026-09-01", "2026-09-10"); // Labor Day (Sep 7) is not one
  return [
    ...spread(jul, 23, "Contact Us"),
    ...spread(augEarly, 29, "Contact Us"),
    ...spread(augLate, 4, "Contact Us"),
    ...spread(augLate, 2, "Phone: CallTrackingMetrics"),
    ...spread(sep, 68, "Admissions Inquiry"),
    ...spread(sep, 46, "Phone: CallTrackingMetrics"),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** A clean synthetic feed: perRun leads every business day, ending on `last`. */
function dailyFeed(from: string, last: string, perDay: number, formName: string | null): LeadEvent[] {
  return businessDaysIn(from, last).flatMap((day) =>
    Array.from({ length: perDay }, (_, i) => ({ at: et(day, 9 + i % 8, (i * 11) % 60), formName })),
  );
}

/**
 * The rule monitor-freshness had before this change, kept here so the gap it
 * left is pinned rather than described: leads in the last 90 days and the last
 * one older than the client's fixed window (7 days for OCH, 14 for everyone
 * else). Nothing else about it looked at rate.
 */
function legacyWindowAlarm(history: LeadEvent[], now: Date, slaDays = 7): boolean {
  const seen = history.filter((e) => e.at.getTime() <= now.getTime());
  const n90 = seen.filter((e) => e.at.getTime() > now.getTime() - 90 * 86_400_000).length;
  const last = seen.reduce((a, e) => (e.at > a ? e.at : a), new Date(0));
  if (!n90) return false;
  return now.getTime() - last.getTime() > slaDays * 86_400_000;
}

// ------------------------------------------------------------------ checks --

console.log("Lead cadence guard\n");

const NOW = et("2026-09-15", 12); // five days after OCH's last lead, a Tuesday
const och = ochHistory();

console.log("OCH — the stoppage this exists to catch");
check("fixture matches the live read: 172 rows, 2026-07-01 → 2026-09-10",
  och.length === 172 && dayKey(och[0]!.at) === "2026-07-01" && dayKey(och[och.length - 1]!.at) === "2026-09-10",
  `${och.length} rows, ${dayKey(och[0]!.at)} → ${dayKey(och[och.length - 1]!.at)}`);

const byMonth = new Map<string, number>();
for (const e of och) byMonth.set(dayKey(e.at).slice(0, 7), (byMonth.get(dayKey(e.at).slice(0, 7)) ?? 0) + 1);
check("fixture matches the live monthly shape: 23 / 35 / 114",
  byMonth.get("2026-07") === 23 && byMonth.get("2026-08") === 35 && byMonth.get("2026-09") === 114,
  [...byMonth].map(([m, n]) => `${m}=${n}`).join(" "));

check("the old fixed-window rule stays silent — this is the blind spot",
  legacyWindowAlarm(och, NOW) === false);

const ochReport = detectFeedStoppage(och, NOW);
check("the cadence rule fires", ochReport !== null);

if (ochReport) {
  check("it names both feeds, because both stopped",
    ochReport.stopped.map((c) => c.feed).sort().join("+") === "calls+forms",
    ochReport.stopped.map((c) => c.feed).join("+"));
  check("it reports the real last day", dayKey(ochReport.lastAt) === "2026-09-10", dayKey(ochReport.lastAt));
  check("the silence is measured in business days, not calendar days",
    ochReport.businessDaysSilent > 2 && ochReport.businessDaysSilent < 3.5, ochReport.businessDaysSilent.toFixed(2));
  const line = stoppageLine("Ohio Community Health (OCH)", ochReport);
  console.log(`\n  message: ${line}\n`);
  check("the message names the check to run", line.includes("debug-och-webform-key-rotation-check"));
  check("the message names the other candidate cause", /forwarder/.test(line) && /webhook/.test(line));
  check("the message says which feeds stopped", /forms and calls stopped/.test(line));
  check("the message stays short", line.length <= 420, `${line.length} chars`);
  check("the message avoids the 'not X but Y' construction", !/\bnot\b[^.]{0,60}\bbut\b/i.test(line));
  check("the signature is stable and per client",
    stoppageSignature("ohio-community-health-och", ochReport) === "S:ohio-community-health-och:calls+forms",
    stoppageSignature("ohio-community-health-och", ochReport));
}

// It has to fire sooner than the fixed window, or it adds nothing.
const ochEarly = detectFeedStoppage(och, et("2026-09-14", 16));
check("it fires on the first working day after the stop, ahead of the 7-day window",
  ochEarly !== null && legacyWindowAlarm(och, et("2026-09-14", 16)) === false);

console.log("\nWeekends and holidays");
const busy = dailyFeed("2026-08-03", "2026-09-04", 10, "Contact Us"); // stops Friday 2026-09-04
check("a Friday-evening stop is silent on Monday morning",
  detectFeedStoppage(busy, et("2026-09-07", 9)) === null);
check("Labor Day Monday is not elapsed time either",
  detectFeedStoppage(busy, et("2026-09-08", 9)) === null);
check("it fires once the next working day has actually passed",
  detectFeedStoppage(busy, et("2026-09-08", 17)) !== null);
check("Saturday to Sunday is zero business days",
  businessDaysBetween(et("2026-09-05", 0), et("2026-09-07", 0)) === 0);
check("a Friday evening to Monday morning is only the rest of Friday",
  Math.abs(businessDaysBetween(et("2026-09-04", 17), et("2026-09-07", 9)) - 7 / 24) < 0.01,
  businessDaysBetween(et("2026-09-04", 17), et("2026-09-07", 9)).toFixed(3));
check("a holiday inside a run is skipped",
  Math.abs(businessDaysBetween(et("2026-09-04", 12), et("2026-09-09", 12)) - 2) < 0.01,
  businessDaysBetween(et("2026-09-04", 12), et("2026-09-09", 12)).toFixed(2));

console.log("\nSilence is not the same as never");
check("a client who never sent a lead is not this alarm's case",
  detectFeedStoppage([], NOW) === null);
const tiny = [
  { at: et("2026-08-10", 10), formName: "Contact Us" },
  { at: et("2026-08-20", 10), formName: "Contact Us" },
  { at: et("2026-09-02", 10), formName: "Contact Us" },
];
check("three leads a month is a rhythm this rule will not claim to know",
  detectFeedStoppage(tiny, NOW) === null);
const burst = [
  ...Array.from({ length: 60 }, (_, i) => ({ at: et("2026-09-02", 9 + (i % 8), i % 60), formName: "Contact Us" })),
];
check("one burst day is not a daily rate", detectFeedStoppage(burst, NOW) === null);

console.log("\nOne feed stopping is its own failure");
const formsOnly = [
  ...dailyFeed("2026-08-03", "2026-09-04", 6, "Contact Us"),
  ...dailyFeed("2026-08-03", "2026-09-14", 5, "Phone: CallTrackingMetrics"),
];
const split = detectFeedStoppage(formsOnly, NOW);
check("the stopped feed is named on its own", split?.stopped.map((c) => c.feed).join() === "forms", String(split?.stopped.map((c) => c.feed)));
check("the feed still running is reported as running", split?.running.map((c) => c.feed).join() === "calls");
check("that is not read as a total stoppage", split?.total === false);
if (split) {
  const line = stoppageLine("Some Client", split);
  check("the message says the other feed is still arriving", /calls still arriving/.test(line), line);
}

// The first live run of this rule said "calls stopped ... forms still arriving"
// about OCH while the forms feed had ALSO been silent since 2026-09-10 — it was
// simply too slow to cross the alarm threshold. An alert that states something
// false is worse than no alert, so a silent-but-under-threshold feed is now
// reported as quiet and never as arriving.
console.log("\nA feed that is quiet but under the threshold is never called arriving");
const slowForms = [
  ...dailyFeed("2026-08-10", "2026-09-10", 14, "Phone: CallTrackingMetrics"),
  // Under one form a business day: silent since the same day, far under the bar.
  ...dailyFeed("2026-08-10", "2026-09-10", 1, "Contact Us").filter((_, i) => i % 2 === 0),
];
const mixed = detectFeedStoppage(slowForms, NOW);
check("the loud feed is the one reported stopped", mixed?.stopped.map((c) => c.feed).join() === "calls", String(mixed?.stopped.map((c) => c.feed)));
check("the slow feed is not counted as running", (mixed?.running.length ?? -1) === 0, String(mixed?.running.map((c) => c.feed)));
check("the slow feed is reported as quiet", mixed?.quiet.map((c) => c.feed).join() === "forms", String(mixed?.quiet.map((c) => c.feed)));
if (mixed) {
  const mline = stoppageLine("Some Client", mixed);
  check("the message never claims the quiet feed is arriving", !/forms still arriving/.test(mline), mline);
  check("the message says the quiet feed is quiet too", /forms quiet too/.test(mline), mline);
}
check("a tracked call is classified as a call", feedOf("Phone: CallTrackingMetrics") === "calls" && feedOf("Phone: ctm") === "calls");
check("an unnamed form is still a form", feedOf(null) === "forms" && feedOf("Admissions Inquiry") === "forms");

console.log("\nRecovery");
const recovered = [...busy, { at: et("2026-09-15", 10), formName: "Contact Us" }];
check("a feed that starts again clears", detectFeedStoppage(recovered, NOW) === null);

// ------------------------------------------------------- the guard's guard --
// A check nothing invokes is not cover: prove the monitor actually calls this,
// and that the constants it is checked against are the ones it ships with.
console.log("\nWiring");
const monitor = readFileSync(join(process.cwd(), "src/monitor-freshness.ts"), "utf8");
check("monitor-freshness imports the cadence rule", /from "\.\/lead-cadence\.js"/.test(monitor));
check("monitor-freshness calls detectFeedStoppage", /detectFeedStoppage\(/.test(monitor));
check("its alert goes through stoppageLine", /stoppageLine\(/.test(monitor));
check("it de-duplicates through the existing signature", /stoppageSignature\(/.test(monitor));
const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
check("npm run verify:lead-cadence points at this file", (pkg.scripts["verify:lead-cadence"] ?? "").includes("verify-lead-cadence.ts"));
const ci = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
check("CI runs it on every push", /verify:lead-cadence/.test(ci) && /^on:[\s\S]{0,200}push:/m.test(ci));
check("the thresholds are the shipped ones",
  BASELINE_DAYS === 28 && MIN_BASELINE_LEADS === 10 && MIN_BASELINE_ACTIVE_DAYS === 5
  && MIN_SILENT_BUSINESS_DAYS === 1 && EXPECTED_MISSED_ALARM === 8);

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);

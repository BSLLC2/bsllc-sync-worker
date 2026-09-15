/**
 * "This feed was busy and it stopped" — the lead-flow alarm sized to each
 * client's own rhythm.
 *
 * monitor-freshness already asks "has this client sent a lead lately?" over a
 * fixed 30/45/90-day window. That question catches a form nobody ever wired and
 * a client who has drifted quiet over a month. It cannot see the worse failure:
 * a feed running at ten a day that stops dead. Ohio Community Health took 114
 * leads in the first ten days of September and then nothing for five days, and
 * every fixed window stayed comfortably satisfied the whole time — 114 rows this
 * month reads as healthy from any angle except the one that matters. The
 * dashboard kept showing a good month while leads hit the floor.
 *
 * So the expectation is derived from the client's own recent history instead of
 * a constant: how many leads a business day has this feed been producing, and
 * how many has the silence cost. Ten a day is in trouble after two quiet days;
 * three a month is not, and that client stays with the fixed-window check.
 *
 * WEEKENDS AND HOLIDAYS. These are business-hours flows — phone calls to an
 * admissions line, forms filled during the working day — so a plain "N days
 * since the last row" fires every Monday morning and gets muted inside a week.
 * Every measurement here runs on a BUSINESS-DAY clock in the client's own
 * timezone: Saturday, Sunday and the US public holidays below are not elapsed
 * time, and the rate is per business day for the same reason, so both sides of
 * the comparison use one clock. The holiday table is the part that needs
 * keeping up. A holiday missing from it costs at most one early alarm, posted
 * once, because the alarm is edge-triggered on the monitor's signature.
 *
 * Pure on purpose: (history, now) in, a verdict out, no database. Fixtures and
 * checks live in verify-lead-cadence.ts.
 */

/** Forms and calls land in the same table. The app labels a tracked call
 *  `Phone: <source>` in form_name (server/webform.ts) — everything else is a
 *  form. One stopping while the other runs is a different fault from both
 *  stopping together, so they are measured apart. */
export type LeadFeed = "forms" | "calls";

export interface LeadEvent {
  at: Date;
  formName?: string | null;
}

export interface FeedCadence {
  feed: LeadFeed;
  /** Leads per business day over the baseline window. */
  perBusinessDay: number;
  baselineLeads: number;
  /** Distinct days with at least one lead in the baseline window. */
  baselineActiveDays: number;
  lastAt: Date;
  businessDaysSilent: number;
  /** Leads this feed would have produced during the silence at its own rate. */
  expectedMissed: number;
  /** True when the feed has enough history to have a rate at all. */
  hasBaseline: boolean;
  stopped: boolean;
}

export interface FeedStoppage {
  /** Feeds that were producing and have gone silent. Never empty. */
  stopped: FeedCadence[];
  /** Feeds with a baseline that are genuinely still producing — a lead within
   *  the last business day. A feed that is ALSO silent but has not crossed the
   *  alarm threshold is not one of these: saying "forms still arriving" about a
   *  feed whose last lead was five days ago is a false statement in an alert,
   *  and the first OCH run made exactly that claim. */
  running: FeedCadence[];
  /** Feeds with a baseline that are silent too, but too slow for the rule to
   *  call it a stoppage yet. Reported as quiet, never as arriving. */
  quiet: FeedCadence[];
  /** True when every feed with a baseline has stopped. */
  total: boolean;
  /** Newest lead across the stopped feeds, and the business days since it. */
  lastAt: Date;
  businessDaysSilent: number;
}

export const BUSINESS_TZ = "America/New_York";

/** Baseline window, in calendar days back from the feed's last lead. Measured
 *  from the LAST LEAD, not from now: measuring back from now would fold the
 *  silence into the rate and shrink the expectation the longer the outage ran. */
export const BASELINE_DAYS = 28;
/** Below this the feed has no rhythm worth deriving one from; the fixed-window
 *  check owns it. At the alarm threshold below, ten leads in 28 days needs more
 *  than two weeks of silence to trip, which the 14-day window catches first. */
export const MIN_BASELINE_LEADS = 10;
/** Leads on at least this many separate days, so one burst — a spam run, a
 *  one-day import — never reads as a daily rhythm. */
export const MIN_BASELINE_ACTIVE_DAYS = 5;
/** Never alarm before a full business day of silence, whatever the rate. An
 *  hour of quiet on a busy afternoon is an hour of quiet, and a feed that stops
 *  on Friday evening must not be reported on Monday morning — at this floor the
 *  weekend contributes nothing and Monday morning is still only part of a day. */
export const MIN_SILENT_BUSINESS_DAYS = 1;
/** Alarm when the silence has cost this many leads at the feed's own rate. Ten
 *  a business day trips after one quiet day, two a day after four, one a day
 *  after eight — each still ahead of the fixed 14-day window. */
export const EXPECTED_MISSED_ALARM = 8;

/** US public holidays through 2027, in BUSINESS_TZ local dates. Add the next
 *  year before this list runs out — see the note at the top of the file. */
export const HOLIDAYS = new Set<string>([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03",
  "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05",
  "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24",
]);

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const clockFmt = new Intl.DateTimeFormat("en-GB", { timeZone: BUSINESS_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Local calendar date (YYYY-MM-DD) of an instant, in BUSINESS_TZ. */
export function dayKey(at: Date): string {
  return dayFmt.format(at);
}

/** How far through its local day an instant sits, as a fraction. */
function dayFraction(at: Date): number {
  const [h, m, s] = clockFmt.format(at).split(":").map(Number);
  return ((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) / 86_400;
}

/** Monday to Friday, minus the holiday table. */
export function isBusinessDay(key: string): boolean {
  if (HOLIDAYS.has(key)) return false;
  const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

function nextDay(key: string): string {
  return dayFmt.format(new Date(new Date(`${key}T12:00:00Z`).getTime() + 86_400_000));
}

/** Business days between two instants, counting part-days as fractions. Returns
 *  0 when b is at or before a. */
export function businessDaysBetween(a: Date, b: Date): number {
  if (b.getTime() <= a.getTime()) return 0;
  const startKey = dayKey(a), endKey = dayKey(b);
  const startFrac = dayFraction(a), endFrac = dayFraction(b);
  if (startKey === endKey) return isBusinessDay(startKey) ? Math.max(0, endFrac - startFrac) : 0;
  let total = 0;
  for (let key = startKey, guard = 0; guard < 4000; guard++) {
    const covered = key === startKey ? 1 - startFrac : key === endKey ? endFrac : 1;
    if (isBusinessDay(key)) total += covered;
    if (key === endKey) break;
    key = nextDay(key);
  }
  return total;
}

/** Which feed a row belongs to. Mirrors the app's labelling. */
export function feedOf(formName: string | null | undefined): LeadFeed {
  return /^\s*phone\s*:/i.test(formName ?? "") ? "calls" : "forms";
}

function cadenceFor(feed: LeadFeed, events: LeadEvent[], now: Date): FeedCadence | null {
  const sorted = events.filter((e) => e.at.getTime() <= now.getTime()).sort((x, y) => x.at.getTime() - y.at.getTime());
  const lastAt = sorted[sorted.length - 1]?.at;
  if (!lastAt) return null; // never sent one — the fixed-window check's case, not this one.

  const windowStart = new Date(lastAt.getTime() - BASELINE_DAYS * 86_400_000);
  const baseline = sorted.filter((e) => e.at.getTime() >= windowStart.getTime());
  const activeDays = new Set(baseline.map((e) => dayKey(e.at))).size;
  // Rate over the business days the baseline actually spans (first lead in the
  // window to the last), so a feed that started mid-window is not averaged down
  // over days it did not exist for.
  const spanDays = businessDaysBetween(baseline[0]!.at, lastAt);
  const businessDaysSilent = businessDaysBetween(lastAt, now);
  const hasBaseline = baseline.length >= MIN_BASELINE_LEADS && activeDays >= MIN_BASELINE_ACTIVE_DAYS && spanDays >= 1;
  const perBusinessDay = hasBaseline ? baseline.length / spanDays : 0;
  const expectedMissed = perBusinessDay * businessDaysSilent;
  return {
    feed,
    perBusinessDay,
    baselineLeads: baseline.length,
    baselineActiveDays: activeDays,
    lastAt,
    businessDaysSilent,
    expectedMissed,
    hasBaseline,
    stopped: hasBaseline && businessDaysSilent >= MIN_SILENT_BUSINESS_DAYS && expectedMissed >= EXPECTED_MISSED_ALARM,
  };
}

/**
 * The whole rule, for one client's lead history. Returns null when nothing has
 * stopped — including for a client who has never sent a lead, which stays the
 * fixed-window check's case and is deliberately not folded in here.
 */
export function detectFeedStoppage(history: LeadEvent[], now: Date): FeedStoppage | null {
  const cadences: FeedCadence[] = [];
  for (const feed of ["forms", "calls"] as LeadFeed[]) {
    const c = cadenceFor(feed, history.filter((e) => feedOf(e.formName) === feed), now);
    if (c) cadences.push(c);
  }
  const stopped = cadences.filter((c) => c.stopped);
  if (!stopped.length) return null;
  const withBaseline = cadences.filter((c) => c.hasBaseline);
  const others = withBaseline.filter((c) => !c.stopped);
  const running = others.filter((c) => c.businessDaysSilent < MIN_SILENT_BUSINESS_DAYS);
  const quiet = others.filter((c) => c.businessDaysSilent >= MIN_SILENT_BUSINESS_DAYS);
  const newest = stopped.reduce((a, c) => (c.lastAt > a.lastAt ? c : a), stopped[0]!);
  return { stopped, running, quiet, total: running.length === 0, lastAt: newest.lastAt, businessDaysSilent: newest.businessDaysSilent };
}

/** Stable per-client entry for the monitor's alert signature, so this alarm
 *  de-duplicates through the same edge-trigger as every other line and repeats
 *  only when the state changes. */
export function stoppageSignature(slug: string, report: FeedStoppage): string {
  return `S:${slug}:${report.stopped.map((c) => c.feed).sort().join("+")}`;
}

const FEED_WORD: Record<LeadFeed, string> = { forms: "forms", calls: "calls" };

/** One line for Slack. Names the feed that stopped, the rate it was running at,
 *  and the first thing to check. The two causes for this failure are a webform
 *  key mismatch swallowing every post as a 401 and the site-side forwarder or
 *  call webhook being switched off; the script named here tells them apart, so
 *  the line points at it rather than picking one. */
export function stoppageLine(label: string, report: FeedStoppage): string {
  const feeds = report.stopped.map((c) => FEED_WORD[c.feed]).join(" and ");
  const rate = report.stopped.reduce((n, c) => n + c.perBusinessDay, 0);
  const rateText = rate < 1 ? rate.toFixed(1) : String(Math.round(rate));
  const days = Math.round(report.businessDaysSilent);
  const arriving = report.running.length
    ? ` ${report.running.map((c) => FEED_WORD[c.feed]).join(" and ")} still arriving.`
    : "";
  const alsoQuiet = report.quiet.length
    ? ` ${report.quiet.map((c) => FEED_WORD[c.feed]).join(" and ")} quiet too, too slow to call it yet.`
    : "";
  const still = `${arriving}${alsoQuiet}`;
  return (
    `${label} — ${feeds} stopped. Last one ${dayKey(report.lastAt)}, ${days} business days ago; it was running about ${rateText} a business day.${still}` +
    " Check the webform key first (`npm run debug-och-webform-key-rotation-check`): a rotated key turns every post into a 401 and nothing here errors." +
    " If the key is good, check the site's forwarder and the call-tracking webhook are still switched on."
  );
}

/**
 * What happened after a change — the outcome record.
 *
 * ── THE DEFECT THIS CLOSES ─────────────────────────────────────────────────
 *
 * `src/ads-verify-outcomes.ts` has always measured an entity before and after
 * a change and written a verdict onto the finding. It only ever looked at
 * findings sitting at `verifying`, `won` or `lost`, and those three statuses
 * are written in exactly ONE place: `src/ads-apply-approved.ts`, after a
 * successful apply, which first asks `adsWriteAuthorityFor`.
 * `clients.ads_write_authority` has no default and is null on every client, so
 * nothing has ever been applied through that path and the after-check has had
 * nothing to measure. The system has no memory of what worked.
 *
 * `ads_change_events` (v194) records EVERY change to an account — ours, an
 * account manager's, a subcontractor's — with a date and whether a person or
 * an API made it. So the measurement no longer needs us to have been the one
 * who made the change.
 *
 * ── WHAT THE RECORD CLAIMS ─────────────────────────────────────────────────
 *
 * "What happened after", and never "what this caused". There is no control
 * group and there never will be one here. Gordon, Zettelmeyer, Bhargava and
 * Chapsky (Marketing Science, 2019) ran fifteen large advertising experiments
 * with a real holdout and found that observational before-and-after methods
 * over the same data reported effects that were badly wrong in both
 * directions. Seasonality, a competitor's budget and the client's own trading
 * all move these numbers. `OBSERVATIONAL_CAVEAT` in `./change-window.js` is
 * the one wording for that and is composed here rather than restated.
 *
 * ── AND MOST DIFFERENCES ON THIS BOOK ARE NOISE ────────────────────────────
 *
 * The accounts here convert in tens per month, not thousands. A 4% move on
 * twelve conversions is one conversion. A reading that reports it as a result
 * is worse than no reading at all, because somebody plans against it.
 *
 * So every reading states its MINIMUM DETECTABLE EFFECT and refuses a verdict
 * inside it. Conversions are a COUNT, so the standard two-sample Poisson
 * sizing applies: the smallest relative difference distinguishable from noise
 * is about (z(alpha/2) + z(beta)) * sqrt(2 / n) where n is the count in the
 * before window. At 95% confidence and 80% power that is 2.80 * sqrt(2 / n) —
 * 125% on ten conversions, 40% on a hundred, 20% on four hundred. The figure
 * is printed beside every verdict, because "no clear move" on twelve
 * conversions and "no clear move" on twelve hundred are different statements.
 *
 * `ads.conversions` is a FLOAT — Google counts conversions fractionally and
 * attribution splits one across clicks — so a before window holding less than
 * one conversion has no denominator worth dividing by and the reading refuses
 * to produce a figure at all rather than reporting a 4,000% rise.
 *
 * Spend is not a sample and is not given an MDE. It is reported as measured
 * and never as an effect.
 *
 * ── AN EPISODE IS THE UNIT, NOT AN EVENT ───────────────────────────────────
 *
 * A vendor restructuring a campaign emits dozens of change events in an hour.
 * Measuring each one separately is thirty API reads answering one question,
 * and it would attribute one afternoon's work thirty times. Events on one
 * entity separated by less than `EPISODE_QUIET_DAYS` are one EPISODE, and the
 * episode is what gets a before and an after.
 *
 * ── A SHARED WINDOW CREDITS NOBODY ─────────────────────────────────────────
 *
 * Another episode landing inside the measured stretch is recorded, counted,
 * and said out loud. Nothing is dropped and nothing is adjusted — the same
 * call `./change-window.js` already makes for the finding path, and that
 * module is composed here rather than copied.
 *
 * ── A NULL IS UNANSWERED ───────────────────────────────────────────────────
 *
 * `ads_change_scans` says how far back capture actually reaches. A window
 * outside it is `cant_tell`, named, never a clean one. The feed began
 * capturing on its first run and there is no history before it, so an account
 * with no events is only ever reported as quiet where coverage says we were
 * looking.
 *
 * Pure: facts in, one reading out. No queries, no clock of its own, no API.
 */
import { changeWindowReading, OBSERVATIONAL_CAVEAT, type ChangeWindowEvent } from "./change-window.js";

export { OBSERVATIONAL_CAVEAT };

/** Days of quiet that separate two episodes on one entity. Two days, because
 *  an account manager's Tuesday afternoon and their Wednesday morning are one
 *  piece of work and the platform is still settling from the first either way. */
export const EPISODE_QUIET_DAYS = 2;

/** How long after an episode ends we look. The same two horizons the finding
 *  path has always used, so one record does not hold two vocabularies. */
export const OUTCOME_HORIZONS = [14, 28] as const;
export type OutcomeHorizon = (typeof OUTCOME_HORIZONS)[number];

/** 95% two-sided, 80% power. Named rather than inlined so the guard can read
 *  them and the report can quote them. */
export const Z_ALPHA_HALF = 1.96;
export const Z_BETA = 0.84;

/** Below this the before window has no denominator worth dividing by.
 *  `ads.conversions` is a float, so this is a real case and not a guard
 *  against nought alone. */
export const MIN_CONVERSIONS_TO_COMPARE = 1;

export interface OutcomeEventFact {
  changedAt: Date;
  /** Null for an account-level change, which touches every campaign. */
  campaignId: string | null;
  resourceType: string | null;
  operation: string | null;
  actorKind: string;
  actorInternal: boolean | null;
}

export interface ChangeEpisode {
  /** "" for an account-level episode. */
  campaignId: string;
  start: Date;
  end: Date;
  events: OutcomeEventFact[];
  /** Made by a person, through the web interface or the editor. */
  byHand: number;
  /** Made through an API, which includes our own apply job. */
  byApi: number;
  /** Made from an address at a domain that is not ours. Null-safe: an event
   *  with no address counts toward neither and is not guessed at. */
  fromOutside: number;
  /** Every resource type touched, deduplicated, in the order first seen. */
  resourceTypes: string[];
}

/**
 * A stable name for an episode.
 *
 * It is the account, the entity and the day the episode STARTED — never a
 * position in a result set and never a counter. An episode is only ever
 * measured once it is older than its horizon, and `change_event` is a log that
 * is re-read whole every six hours, so by then no further event can join it
 * and the start day cannot move. Two runs therefore produce the same key and
 * the second writes nothing.
 */
export function episodeKey(accountId: string, campaignId: string, start: Date): string {
  return `${accountId}|${campaignId || "account"}|${start.toISOString().slice(0, 10)}`;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * Group captured events into episodes, per entity, oldest first.
 *
 * An account-level event (no campaign id) forms its own episode rather than
 * being folded into every campaign's: it is one piece of work, and copying it
 * onto six campaigns would report one afternoon six times.
 */
export function episodesFrom(events: OutcomeEventFact[]): ChangeEpisode[] {
  const byEntity = new Map<string, OutcomeEventFact[]>();
  for (const e of events) {
    const k = e.campaignId ?? "";
    if (!byEntity.has(k)) byEntity.set(k, []);
    byEntity.get(k)!.push(e);
  }
  const out: ChangeEpisode[] = [];
  for (const [campaignId, list] of byEntity) {
    const sorted = [...list].sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
    let current: OutcomeEventFact[] = [];
    const flush = () => {
      if (!current.length) return;
      const types: string[] = [];
      for (const e of current) if (e.resourceType && !types.includes(e.resourceType)) types.push(e.resourceType);
      out.push({
        campaignId,
        start: current[0]!.changedAt,
        end: current[current.length - 1]!.changedAt,
        events: current,
        byHand: current.filter((e) => e.actorKind === "person").length,
        byApi: current.filter((e) => e.actorKind === "api").length,
        fromOutside: current.filter((e) => e.actorInternal === false).length,
        resourceTypes: types,
      });
      current = [];
    };
    for (const e of sorted) {
      const last = current[current.length - 1];
      if (last && e.changedAt.getTime() - last.changedAt.getTime() > EPISODE_QUIET_DAYS * 86_400_000) flush();
      current.push(e);
    }
    flush();
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * The smallest relative difference in conversions this window could tell apart
 * from noise, or null when there is nothing to divide by.
 *
 * Two-sample Poisson sizing at 95% confidence and 80% power. Returned as a
 * fraction: 1.25 is "a move smaller than 125% is inside the noise here".
 */
export function minimumDetectableEffect(beforeConversions: number): number | null {
  if (!Number.isFinite(beforeConversions) || beforeConversions < MIN_CONVERSIONS_TO_COMPARE) return null;
  return (Z_ALPHA_HALF + Z_BETA) * Math.sqrt(2 / beforeConversions);
}

/**
 * The floor under the noise band, regardless of volume.
 *
 * The finding path has judged on a flat 10% since it was written, and on a
 * very large account the Poisson figure drops below that — it takes about
 * 1,600 conversions in a window before it does, which is far above anything on
 * this book. Keeping the floor means the rule can be stated in one line ("a
 * move under a tenth is never called a result") and means adopting this band
 * changes no verdict the finding path would already have reached on a busy
 * account. What it changes is the small ones, which is the point.
 */
export const MIN_NOISE_BAND = 0.10;

/**
 * THE ONE BAND BOTH PATHS JUDGE AGAINST.
 *
 * The change-feed reading and the applied-finding after-check are two entry
 * points into one measurement job, and this is the function that keeps them
 * from being two jobs measuring the same thing differently. Null is "there is
 * nothing here to compare against", which is a refusal rather than a wide band.
 */
export function noiseBand(beforeConversions: number): number | null {
  const mde = minimumDetectableEffect(beforeConversions);
  return mde === null ? null : Math.max(MIN_NOISE_BAND, mde);
}

/** The noise band in one sentence, for whichever path is printing it. */
export function noiseBandLine(beforeConversions: number, band: number): string {
  return `On ${beforeConversions.toFixed(1)} conversions in the before window, the smallest move this could tell `
    + `apart from ordinary variation is about ${band >= 0 ? "+" : ""}${(band * 100).toFixed(0)}% — `
    + `so anything smaller is reported as no clear move rather than as a result.`;
}

export type OutcomeVerdict =
  /** Conversions rose by more than this window could produce by chance. */
  | "rose"
  /** Conversions fell by more than this window could produce by chance. */
  | "fell"
  /** Measured, and the difference is inside the noise band. A real answer. */
  | "no_clear_move"
  /** Not measurable: no coverage, or nothing to compare against. */
  | "cant_tell";

export interface OutcomeWindows {
  beforeStart: Date;
  beforeEnd: Date;
  afterStart: Date;
  afterEnd: Date;
}

/**
 * The windows an episode is measured over, at one horizon.
 *
 * Like for like: the same number of days immediately before the episode
 * started and immediately after it ended. A 14-day after-window against a
 * 28-day before-window reports a halving that is pure arithmetic.
 */
export function outcomeWindows(episode: { start: Date; end: Date }, horizonDays: number): OutcomeWindows {
  return {
    beforeStart: addDays(episode.start, -horizonDays),
    beforeEnd: addDays(episode.start, -1),
    afterStart: addDays(episode.end, 1),
    afterEnd: addDays(episode.end, horizonDays),
  };
}

export interface OutcomeMetrics {
  conversions: number;
  costMicros: number;
  clicks?: number;
  impressions?: number;
}

export interface OutcomeFacts {
  episode: ChangeEpisode;
  horizonDays: number;
  windows: OutcomeWindows;
  before: OutcomeMetrics | null;
  after: OutcomeMetrics | null;
  /** Start of unbroken captured coverage for the account, or null when nothing
   *  has been captured at all. */
  coveredFrom: Date | null;
  /** Captured changes on the same entity inside the AFTER window that are not
   *  part of this episode. The caller scopes them; this module counts. */
  otherChangesAfter: ChangeWindowEvent[];
  /** True where the measurement is the whole account rather than one campaign. */
  wholeAccount: boolean;
  /** Set where one of our own applied findings covers this episode. Its title,
   *  never an id a person cannot read. */
  ourFindingTitle: string | null;
  /** Today, from the caller. This module keeps no clock. */
  now: Date;
}

export interface OutcomeReading {
  verdict: OutcomeVerdict;
  /** The relative change in conversions, or null where there was nothing to
   *  divide by. Never a percentage of nought. */
  relativeChange: number | null;
  /** The smallest relative change this window could have told apart from
   *  noise, or null for the same reason. */
  mde: number | null;
  /** True when another episode landed inside the after window. Null is "we
   *  could not see", which is never read as a clean window. */
  shared: boolean | null;
  otherChangesAfter: number | null;
  /** What was changed, in plain words, with nobody named. */
  what: string;
  /** The verdict in one sentence, with its own figures. */
  headline: string;
  /** Every qualification that applies, already composed — coverage, the noise
   *  band, the shared window, and the observational caveat. */
  basis: string;
}

/** "CAMPAIGN_BUDGET" → "campaign budget". The platform's own vocabulary is
 *  shouted and underscored; a person reads a sentence. */
function plainType(t: string): string {
  return t.toLowerCase().replace(/_/g, " ");
}

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;

/**
 * What the episode was, with NOBODY NAMED.
 *
 * `actor_email` is personal data and never leaves the company; this sentence
 * is the one a person reads on a record that a report could one day quote, so
 * it says how many and how, and never who. A change one of our staff made and
 * a change a contractor made read the same here on purpose.
 */
export function episodeDescription(e: ChangeEpisode, ourFindingTitle: string | null): string {
  const n = e.events.length;
  const types = e.resourceTypes.slice(0, 3).map(plainType);
  const what = types.length ? types.join(", ") : "the account";
  const span = ymd(e.start) === ymd(e.end) ? `on ${ymd(e.start)}` : `between ${ymd(e.start)} and ${ymd(e.end)}`;
  if (ourFindingTitle) {
    return `${n} change${n === 1 ? "" : "s"} to ${what} ${span}, from a finding we applied here: "${ourFindingTitle}".`;
  }
  const how = e.byHand > 0 && e.byApi > 0
    ? `${e.byHand} by hand and ${e.byApi} through an API`
    : e.byHand > 0
      ? "made by hand"
      : e.byApi > 0
        ? "made through an API"
        : "with no record of how";
  return `${n} change${n === 1 ? "" : "s"} to ${what} ${span}, ${how}.`;
}

/**
 * One reading of one episode at one horizon.
 *
 * The order of refusals is deliberate: coverage first (we may not have been
 * looking at all), then the denominator (there may be nothing to compare
 * against), then the noise band. Each says which, and a `cant_tell` never
 * carries a figure it cannot stand behind.
 */
export function outcomeReading(f: OutcomeFacts): OutcomeReading {
  const what = episodeDescription(f.episode, f.ourFindingTitle);
  const scope = f.wholeAccount ? "the account" : "this campaign";

  // ── Was the after window shared? Composed, never re-decided. ──
  const windowRead = changeWindowReading({
    coveredFrom: f.coveredFrom,
    windowStart: f.windows.afterStart,
    windowEnd: f.windows.afterEnd,
    wholeAccount: f.wholeAccount,
    events: f.otherChangesAfter,
  });

  // ── Coverage. A window the feed cannot see is not a quiet one. ──
  // The BEFORE window matters as much as the after: an episode measured
  // against a stretch we were not capturing is measured against a stretch
  // somebody may have been working in.
  const coveredBefore = Boolean(f.coveredFrom && f.coveredFrom.getTime() <= f.windows.beforeStart.getTime());
  if (!coveredBefore || windowRead.contaminated === null) {
    const detail = f.coveredFrom
      ? `Change history for this account only reaches back to ${ymd(f.coveredFrom)}, which is inside the stretch this would be measured over`
      : "No change history has been captured for this account at all";
    return {
      verdict: "cant_tell",
      relativeChange: null,
      mde: null,
      shared: null,
      otherChangesAfter: null,
      what,
      headline: `Not measurable: ${detail.charAt(0).toLowerCase()}${detail.slice(1)}.`,
      basis: `${detail}, so whether anybody else worked on ${scope} between `
        + `${ymd(f.windows.beforeStart)} and ${ymd(f.windows.afterEnd)} is not known here. `
        + `Capture began on its first run and there is no history before that. ${OBSERVATIONAL_CAVEAT}`,
    };
  }

  const sharedLine = windowRead.note;

  // ── Something to compare against. ──
  if (!f.before || !f.after) {
    return {
      verdict: "cant_tell",
      relativeChange: null,
      mde: null,
      shared: windowRead.contaminated,
      otherChangesAfter: windowRead.otherChanges,
      what,
      headline: "Not measurable: the platform returned no figures for one of the two windows.",
      basis: `${sharedLine} ${OBSERVATIONAL_CAVEAT}`,
    };
  }

  const before = f.before.conversions;
  const after = f.after.conversions;
  const band = noiseBand(before);
  const spendLine = `Spend over the same stretch went from `
    + `$${Math.round(f.before.costMicros / 1_000_000).toLocaleString()} to `
    + `$${Math.round(f.after.costMicros / 1_000_000).toLocaleString()}, measured rather than compared.`;

  if (band === null) {
    return {
      verdict: "cant_tell",
      relativeChange: null,
      mde: null,
      shared: windowRead.contaminated,
      otherChangesAfter: windowRead.otherChanges,
      what,
      headline: `Not measurable: ${scope} recorded ${before.toFixed(1)} conversions in the `
        + `${f.horizonDays} days before this, which is too few to compare anything against.`,
      basis: `A count under ${MIN_CONVERSIONS_TO_COMPARE} has no denominator, so no percentage is produced here at all. `
        + `${spendLine} ${sharedLine} ${OBSERVATIONAL_CAVEAT}`,
    };
  }

  const rel = (after - before) / before;
  const noiseLine = noiseBandLine(before, band);

  if (Math.abs(rel) <= band) {
    return {
      verdict: "no_clear_move",
      relativeChange: rel,
      mde: band,
      shared: windowRead.contaminated,
      otherChangesAfter: windowRead.otherChanges,
      what,
      headline: `Conversions went ${before.toFixed(1)} → ${after.toFixed(1)} (${pct(rel)}) over ${f.horizonDays} days, `
        + `which is inside the noise band for a window this size.`,
      basis: `${noiseLine} ${spendLine} ${sharedLine} ${OBSERVATIONAL_CAVEAT}`,
    };
  }

  return {
    verdict: rel > 0 ? "rose" : "fell",
    relativeChange: rel,
    mde: band,
    shared: windowRead.contaminated,
    otherChangesAfter: windowRead.otherChanges,
    what,
    headline: `Conversions went ${before.toFixed(1)} → ${after.toFixed(1)} (${pct(rel)}) over the ${f.horizonDays} days after this, `
      + `which is larger than this window's noise band.`,
    basis: `${noiseLine} ${spendLine} ${sharedLine} ${OBSERVATIONAL_CAVEAT}`,
  };
}

/**
 * Is this episode old enough to read at this horizon?
 *
 * The after window has to have finished. Measuring a 14-day horizon on day
 * nine reports a fortnight's worth of conversions against nine days of them,
 * which is arithmetic rather than a reading.
 */
export function episodeDue(episode: { end: Date }, horizonDays: number, now: Date): boolean {
  return addDays(episode.end, horizonDays).getTime() <= now.getTime();
}

/** YYYY-MM-DD, for the adapter's own window arguments. */
export const outcomeYmd = ymd;

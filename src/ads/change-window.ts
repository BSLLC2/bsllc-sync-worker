/**
 * Was the measurement window clean?
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 *
 * `src/ads-verify-outcomes.ts` measures an entity's metrics before a change we
 * applied and again 14 and 28 days after it, and writes a won / lost /
 * inconclusive verdict onto the finding. Until now it had no way to know that
 * somebody else was working the same account inside that window, so a
 * subcontractor's rebuild landed in our column as our result.
 *
 * It is worse for anything whose entityType is not a campaign:
 * `GoogleAdsAdapter.verify` measures the WHOLE ACCOUNT for those, so every
 * other change in the account is inside the measurement by construction.
 *
 * ── WHAT THIS DOES AND DOES NOT DO ─────────────────────────────────────────
 *
 * It does not drop a result and it does not adjust one. It RECORDS that the
 * window was shared, how many other changes landed in it and who made them, so
 * a won or a lost is readable months later instead of quietly wrong.
 *
 * ── NEVER CAUSAL ───────────────────────────────────────────────────────────
 *
 * A before-and-after comparison with no control group is an OBSERVATION. It
 * cannot establish that our change produced the movement, and the caveat below
 * says so on every verdict rather than only on a contaminated one — seasonality,
 * competitors and the client's own trading all move these numbers, and a clean
 * window changes none of that.
 *
 * ── A NULL IS UNANSWERED ───────────────────────────────────────────────────
 *
 * `contaminated: null` is "we could not see this window", which happens when
 * nothing was captured for the account or when capture started after the
 * window opened. It is never read as a clean window. That is the whole reason
 * `ads_change_scans` exists.
 *
 * Pure: facts in, one reading out. No queries, no clock of its own.
 */

export interface ChangeWindowEvent {
  changedAt: Date;
  actorKind: string;
  actorInternal: boolean | null;
  actorEmail: string | null;
}

export interface ChangeWindowFacts {
  /** Start of unbroken captured coverage for this account, or null when
   *  nothing has been captured at all. */
  coveredFrom: Date | null;
  windowStart: Date;
  windowEnd: Date;
  /** Every captured change on the measured entity inside the window. The
   *  caller scopes it; this module counts and describes. */
  events: ChangeWindowEvent[];
  /** True where `verify` measured the whole account rather than one campaign,
   *  which is what the adapter does for every non-campaign entity. Said in the
   *  note, because it widens what counts as interference. */
  wholeAccount: boolean;
}

export interface ChangeWindowReading {
  /** null is "we could not see", never "clean". */
  contaminated: boolean | null;
  /** Null alongside a null verdict, for the same reason. */
  otherChanges: number | null;
  byHand: number | null;
  fromOutsideTheCompany: number | null;
  /** Who, for the record. Internal only — this lands in outcomes_json, which
   *  no client report, share payload or vendor workspace reads. */
  actors: string[];
  /** One sentence, appended to the verdict's own note. */
  note: string;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Said on EVERY verdict, clean window or not. A pre/post comparison with no
 * control group observes; it does not prove.
 */
export const OBSERVATIONAL_CAVEAT =
  "Measured before and after, with nothing held back for comparison, so this is what happened rather than what the change caused.";

export function changeWindowReading(f: ChangeWindowFacts): ChangeWindowReading {
  const scope = f.wholeAccount ? "the account" : "this campaign";
  if (!f.coveredFrom || f.coveredFrom.getTime() > f.windowStart.getTime()) {
    return {
      contaminated: null,
      otherChanges: null,
      byHand: null,
      fromOutsideTheCompany: null,
      actors: [],
      note: f.coveredFrom
        ? `Change history for this account starts on ${ymd(f.coveredFrom)}, inside the measured window, `
          + `so whether anybody else worked on ${scope} between ${ymd(f.windowStart)} and ${ymd(f.windowEnd)} is not known here.`
        : `No change history has been captured for this account, so whether anybody else worked on ${scope} `
          + `during the measured window is not known here.`,
    };
  }

  const inWindow = f.events.filter(
    (e) => e.changedAt.getTime() >= f.windowStart.getTime() && e.changedAt.getTime() <= f.windowEnd.getTime(),
  );
  const byHand = inWindow.filter((e) => e.actorKind === "person").length;
  const fromOutside = inWindow.filter((e) => e.actorInternal === false).length;
  const actors = Array.from(new Set(inWindow.map((e) => e.actorEmail).filter((a): a is string => Boolean(a))));

  if (!inWindow.length) {
    return {
      contaminated: false,
      otherChanges: 0,
      byHand: 0,
      fromOutsideTheCompany: 0,
      actors: [],
      note: `No other change was recorded on ${scope} between ${ymd(f.windowStart)} and ${ymd(f.windowEnd)}.`,
    };
  }

  const who = fromOutside > 0
    ? `${fromOutside} from outside this company`
    : byHand > 0
      ? `${byHand} made by hand`
      : "all through an API";
  return {
    contaminated: true,
    otherChanges: inWindow.length,
    byHand,
    fromOutsideTheCompany: fromOutside,
    actors,
    note: `${inWindow.length} other change${inWindow.length === 1 ? "" : "s"} landed on ${scope} `
      + `between ${ymd(f.windowStart)} and ${ymd(f.windowEnd)} (${who}), so this movement is not ours alone to claim.`,
  };
}

/**
 * src/hubspot-deal-status.ts — is this HubSpot deal open, won or lost, and
 * what says so. Pure: facts in, one reading out. No network, no database.
 *
 * WHY THIS EXISTS. Two importers in this repo write HubSpot deals into the
 * same `deals` table and each had its own idea of what "closed" means:
 *
 *   • src/import-hubspot.ts (the MANUAL path, `import-hubspot.yml`, and also
 *     scheduled 07:00 UTC) read HubSpot's own booleans — `hs_is_closed_won`
 *     and `hs_is_closed` — and handed a status to the app's crm-import.
 *   • src/import-hubspot-deals.ts (the SCHEDULED path, 11:00 and 23:00 UTC)
 *     read pipeline stage metadata, used it ONLY to drop closed deals out of
 *     the payload entirely, and then hardcoded `status='open'` in all three of
 *     its write paths.
 *
 * So a deal closed in HubSpot stayed open in the app until somebody ran the
 * manual import by hand. Every reading built on "this deal is settled" — a
 * forecast, a follow-up list, a commission — was only as current as the last
 * time a person pressed a button.
 *
 * Two importers disagreeing about what "lost" means is worse than one of them
 * being wrong, because nobody can tell which answer they are looking at. So
 * the decision is here, once, and both read it.
 *
 * THE RUNGS, in order, each named on the reading so the run can print which
 * one answered:
 *
 *   1. hubspot_flags — HubSpot's own calculated booleans. `hs_is_closed_won`
 *      true is a win. `hs_is_closed` true with the win flag PRESENT and not
 *      true is a loss (that is exactly what import-hubspot.ts has always
 *      done). `hs_is_closed` present and not true is open.
 *   2. stage_metadata — the pipeline's own `isClosed` / `probability`, from
 *      /crm/v3/pipelines/deals. A closed stage at probability 1 is a win, a
 *      closed stage below it is a loss. Only the scheduled importer fetches
 *      this; the manual one passes nothing and simply never reaches this rung.
 *   3. default_open — no flags and no stage metadata. OPEN, never closed.
 *
 * AND THE REFUSAL, which is the point of having a reading rather than a
 * ternary: `hs_is_closed` says the deal is CLOSED, the win flag is absent
 * altogether (the property was not asked for, or HubSpot returned nothing),
 * and no stage metadata settles it. Nothing here knows which way it went.
 * Guessing "lost" takes a real win off the board and out of every revenue
 * figure that reads it; guessing "open" leaves a stale row somebody can see.
 * So the verdict is `null` — the caller leaves the deal exactly as it is and
 * NAMES it in the run's output. A null is unanswered, never a value.
 *
 * AN UNKNOWN STAGE IS NEVER READ AS CLOSED. `stageIsClosed` null means this
 * run could not resolve the stage id, which is a gap in what we fetched and
 * not a fact about the deal. That is the same call import-hubspot-deals.ts's
 * own `isOpen` already made (`!si ? true`), kept rather than re-decided.
 */

/** The app's own vocabulary (shared/schema.ts DEAL_STATUSES). Written here as
 *  a literal because the repos cannot import from each other; the app's zod
 *  contract in server/crm-import.ts refuses anything else, so a drift fails
 *  the import loudly rather than writing a status nothing reads. */
export type DealStatus = "open" | "won" | "lost";

/** The app's two closed stage labels (shared/schema.ts DEAL_STAGES). Same
 *  reason, same constraint. */
export const CLOSED_WON_STAGE = "Closed won";
export const CLOSED_LOST_STAGE = "Closed lost";

export interface DealCloseFacts {
  /** HubSpot `hs_is_closed_won`, verbatim. `undefined` means the property was
   *  never asked for; `null` means HubSpot returned no value. Both are the
   *  absence that can force the refusal below — only a PRESENT non-"true"
   *  value is read as "not a win". */
  isClosedWon?: string | null;
  /** HubSpot `hs_is_closed`, verbatim. Same rules. */
  isClosed?: string | null;
  /** The deal's stage, from the pipeline definition: `metadata.isClosed`.
   *  null/undefined = this run could not resolve the stage. */
  stageIsClosed?: boolean | null;
  /** The same stage's `metadata.probability`, 0..1. */
  stageProbability?: number | null;
}

export type DealStatusSource = "hubspot_flags" | "stage_metadata" | "default_open" | "cant_tell";

export interface DealStatusReading {
  /** null means "closed, and nothing here says which way" — see the header.
   *  The caller must not write a status on a null. */
  status: DealStatus | null;
  decidedBy: DealStatusSource;
  /** One clause, for the run's own output. Always present on a refusal. */
  why: string;
}

const isTrue = (v: string | null | undefined): boolean => v === "true";
/** Present at all — a HubSpot boolean that came back as the string "false" is
 *  an ANSWER. Only an absent one (never fetched, or null) is unanswered. */
const answered = (v: string | null | undefined): boolean => v !== undefined && v !== null && v !== "";

export function dealStatus(f: DealCloseFacts): DealStatusReading {
  if (isTrue(f.isClosedWon)) {
    return { status: "won", decidedBy: "hubspot_flags", why: "hs_is_closed_won is true" };
  }
  if (isTrue(f.isClosed)) {
    if (answered(f.isClosedWon)) {
      return { status: "lost", decidedBy: "hubspot_flags", why: "hs_is_closed is true and hs_is_closed_won is not" };
    }
    // Closed, and the win flag is missing. Try the pipeline's own metadata.
    if (f.stageIsClosed === true) {
      const won = (f.stageProbability ?? 0) >= 1;
      return {
        status: won ? "won" : "lost",
        decidedBy: "stage_metadata",
        why: `hs_is_closed is true with no win flag; the stage is closed at probability ${f.stageProbability ?? 0}`,
      };
    }
    return {
      status: null,
      decidedBy: "cant_tell",
      why: "hs_is_closed says this deal is closed, hs_is_closed_won was not returned, and the stage could not be resolved — nothing here says whether it was won or lost",
    };
  }
  if (answered(f.isClosed)) {
    return { status: "open", decidedBy: "hubspot_flags", why: "hs_is_closed is not true" };
  }
  if (f.stageIsClosed === true) {
    const won = (f.stageProbability ?? 0) >= 1;
    return {
      status: won ? "won" : "lost",
      decidedBy: "stage_metadata",
      why: `the stage is a closed stage at probability ${f.stageProbability ?? 0}`,
    };
  }
  if (f.stageIsClosed === false) {
    return { status: "open", decidedBy: "stage_metadata", why: "the stage is an open stage" };
  }
  return {
    status: "open",
    decidedBy: "default_open",
    why: "no close flags and no stage metadata — an unresolved stage is never read as closed",
  };
}

/** The stage LABEL that goes with a status. A closed deal takes the app's own
 *  closed label; an open one keeps whatever the caller worked out from the
 *  pipeline (the two importers derive an open stage differently on purpose —
 *  one has the live pipeline definition and the other does not — and that is
 *  not this module's business). */
export function dealStageLabel(status: DealStatus, openStage: string): string {
  if (status === "won") return CLOSED_WON_STAGE;
  if (status === "lost") return CLOSED_LOST_STAGE;
  return openStage;
}

/** `deals.closed_at`, the same rule server/crm-import.ts applies to the
 *  payload it is handed: a close date only means something on a closed deal,
 *  and a closed deal with no date in HubSpot gets none here rather than
 *  today's date, which nobody recorded. */
export function dealClosedAt(status: DealStatus, closeDate: string | null | undefined): string | null {
  if (status !== "won" && status !== "lost") return null;
  return closeDate ? String(closeDate).slice(0, 10) : null;
}

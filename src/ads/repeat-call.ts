/**
 * A repeat-call conversion action that counts as a conversion.
 *
 * ── THE FINDING (2026-10-12) ───────────────────────────────────────────────
 *
 * Diesel Power Group's account counts a "Repeat Phone Call" action as a primary
 * conversion. A repeat call is a call from somebody who has already called, so
 * counting it beside the first call counts one person twice. Conversions go
 * up, cost per conversion comes down, and bidding learns that the account is
 * doing better than it is, with no new customer behind any of it. Nothing in
 * this audit looked at what the conversion actions were NAMED, so it read the
 * inflated column as the truth and judged every campaign by it.
 *
 * ── WHAT IS READ, AND THE ONE GUESS ────────────────────────────────────────
 *
 * Google has no flag for "this is a repeat-call action"; the only place the
 * account says so is the action's own name. So the match is on the NAME, it is
 * narrow (the word repeat, then call), and the row says that is what it
 * matched, because a name is what a person typed and not a record of what the
 * action does. Whether the action counts is NOT guessed: it is the platform's
 * own `include_in_conversions_metric`, preferred over the goal flag, and an
 * action the platform did not say counts is left out (null is unanswered).
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 *
 * It does not change an action, and it puts no value on any. Setting an action
 * to Secondary changes what the account bids toward; that is a person's change
 * in the account, outside the guarded path on purpose.
 *
 * Pure. Facts in, a reading out.
 */
import type { ConversionActionRow } from "./rules.js";

/** The word repeat, then call, in the action's own name. Narrow on purpose.
 *  An underscore is a separator here (`Repeat_Phone_Call`), which `\b` is not. */
export const REPEAT_CALL_NAME = /(?<![a-z])repeat(?:ed)?(?![a-z])[\s_\-:]*(?:phone(?![a-z])[\s_\-]*)?(?:calls?|callers?)(?![a-z])/i;

const isEnabled = (a: ConversionActionRow): boolean => String(a.status ?? "ENABLED").toUpperCase() === "ENABLED";
/** Does the platform say this action counts into the conversions column? Null
 *  when it did not say, which is never read as yes. */
export const countsAsPrimary = (a: ConversionActionRow): boolean | null =>
  a.countsIntoConversionsColumn != null ? a.countsIntoConversionsColumn : a.primaryForGoal;

const CALLISH_CATEGORY = new Set(["PHONE_CALL_LEAD", "CONTACT"]);
const CALLISH_TYPE = /CALL/i;
export const looksLikeCallAction = (a: ConversionActionRow): boolean =>
  CALLISH_CATEGORY.has(String(a.category ?? "").toUpperCase()) || CALLISH_TYPE.test(String(a.actionType ?? ""));

export interface RepeatCallReading {
  /** open: a repeat-call action counts. clear: none does. cant_tell: actions were not read. */
  state: "open" | "clear" | "cant_tell";
  /** Repeat-call actions that count into the conversions column. */
  counting: ConversionActionRow[];
  /** Repeat-call actions the platform did not say either way about. */
  undecided: ConversionActionRow[];
  /** Other call actions that also count, which is what the repeat one doubles. */
  otherCounting: ConversionActionRow[];
  lines: string[];
}

export function repeatCallReading(actions: readonly ConversionActionRow[] | null | undefined): RepeatCallReading {
  if (actions == null) {
    return { state: "cant_tell", counting: [], undecided: [], otherCounting: [], lines: ["The account's conversion actions were not read this run."] };
  }
  const live = actions.filter(isEnabled);
  const repeat = live.filter((a) => REPEAT_CALL_NAME.test(a.name ?? ""));
  const counting = repeat.filter((a) => countsAsPrimary(a) === true);
  const undecided = repeat.filter((a) => countsAsPrimary(a) == null);
  const otherCounting = live
    .filter((a) => !repeat.includes(a) && countsAsPrimary(a) === true && (looksLikeCallAction(a) || /\bcalls?\b/i.test(a.name ?? "")));
  const lines: string[] = [];
  for (const a of counting) {
    lines.push(`"${a.name}" is enabled and counts into the conversions column${a.conversionsInWindow != null ? `, with ${a.conversionsInWindow.toFixed(1)} conversion(s) in the window` : ""}`);
  }
  if (counting.length) {
    lines.push(otherCounting.length
      ? `It sits beside ${otherCounting.map((a) => `"${a.name}"`).join(", ")}, which also counts calls, so a caller can be counted on both`
      : "No other call action counting was found, so check what the first call is counted under");
    lines.push("Matched on the action's name, which is the only place the account says it is a repeat-call action");
  }
  return {
    state: counting.length ? "open" : "clear",
    counting, undecided, otherCounting, lines,
  };
}

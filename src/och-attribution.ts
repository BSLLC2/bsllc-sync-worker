/**
 * Did OCH's intake team say this admission came from us?
 *
 * OCH have no CRM we can read. The only channel evidence on an admission is a
 * free-text "Referent" cell somebody typed by hand, so the rule that reads it
 * is the whole of attribution for this account — it decides what lands in
 * `manual.admissions_marketing` and, through that, the revenue figure on the
 * case study.
 *
 * It lives here, alone, because two readers now depend on it: `import-och.ts`
 * (the monthly import) and `debug-och-month.ts` (the read-only answer to "did
 * anything of ours admit this month"). A second copy of a word list is a
 * second answer to the same question, and the two would drift the first time
 * somebody added a word to one of them. `verify-och-attribution.ts` fails the
 * build if either file grows its own copy.
 *
 * Pure: no I/O, no dates, no client data of any kind.
 */

/**
 * Referent values we count as driven by our marketing. Matched on WHOLE WORDS
 * (not loose substrings — otherwise "Crossroads" trips on "ads" and a referral
 * centre gets miscredited to us). Covers search, web, and paid social.
 * Everything else (professional referrals, past clients, word of mouth,
 * walk-in, insurance lists, …) is a real admission but not attributable to our
 * efforts.
 */
export const ATTRIBUTABLE_WORDS = new Set([
  "google", "adwords", "ads", "ppc", "sem", "seo", "organic", "search",
  "web", "webform", "website", "online", "form", "landing",
  "facebook", "fb", "meta", "instagram", "ig", "social", "paid",
]);

/** True when the Referent text names a channel we drive. Blank is never ours. */
export function isAttributable(referent: string | null | undefined): boolean {
  const s = (referent ?? "").toString().trim().toLowerCase();
  if (!s) return false;
  if (s.includes("web form") || s.includes("paid search")) return true;
  const tokens = s.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => ATTRIBUTABLE_WORDS.has(t));
}

/**
 * The same rule, with its two kinds of "no" kept apart.
 *
 *   ours          — the text names a channel we drive.
 *   blank         — intake wrote nothing. We know nothing about this admission.
 *   unrecognised  — intake wrote something the word list does not know. It may
 *                   be a referral partner, or it may be our lead under a name
 *                   nobody here has seen. This is the doubt, and it is worth
 *                   counting rather than folding into "not ours".
 *
 * `isAttributable` is the rule; this only sorts its "no" into the two cases,
 * so there is still one place a channel is decided.
 */
export type ReferentVerdict = "ours" | "blank" | "unrecognised";

export function referentVerdict(referent: string | null | undefined): ReferentVerdict {
  if (isAttributable(referent)) return "ours";
  return (referent ?? "").toString().trim() ? "unrecognised" : "blank";
}

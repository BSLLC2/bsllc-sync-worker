/**
 * Which place the research provider is asked about.
 *
 * Pure. The app records a place the way a person writes it ("Cincinnati, OH");
 * the provider only accepts a place spelled exactly as its own list spells it
 * ("Cincinnati,Ohio,United States"). src/research-location.ts, copied byte for
 * byte from the app, turns one into the other; this file decides whether the
 * result is good enough to pay for a run with.
 *
 * ── WHAT IT REFUSES ────────────────────────────────────────────────────────
 *
 *  · A PLACE THAT CANNOT BE SPELLED. One word that could be many places
 *    ("Cincinnati") is refused, not guessed, and the sentence says how to write
 *    it. A blank is refused: it is never read as the whole country.
 *  · A PLACE THE PROVIDER'S OWN LIST DOES NOT HOLD, where the list could be
 *    read. A run in a place the provider cannot target would come back as an
 *    error after queueing, or worse as a different place, so it is stopped
 *    here and named.
 *  · WHERE THE LIST COULD NOT BE READ THE RUN GOES AHEAD, UNVERIFIED, and says
 *    so. An unreadable list is unanswered. It is never read as "the place is
 *    missing", which would stop every run on a day the free endpoint was slow.
 *
 * The whole country needs no list: it is the original run and the original
 * wording, and it always was valid.
 */
import { isNational, placeKey, placeLabel, providerLocationName } from "./research-location.js";

export type ProviderPlace =
  | { ok: true; name: string; national: boolean; verified: boolean; note: string | null }
  | { ok: false; message: string };

export function resolveProviderPlace(requested: string | null | undefined, catalogue: readonly string[] | null): ProviderPlace {
  const typed = String(requested ?? "").trim();
  if (!typed) {
    return { ok: false, message: "No location was recorded on this run, and a blank is never read as the whole country. Choose a place on the research panel." };
  }
  const name = providerLocationName(typed);
  if (!name) {
    return { ok: false, message: `The place "${typed}" cannot be looked up on its own, because more than one place has that name. Write it as city and state, like Cincinnati, OH, or choose United States.` };
  }
  if (isNational(typed)) return { ok: true, name, national: true, verified: true, note: null };
  if (!catalogue || catalogue.length === 0) {
    return { ok: true, name, national: false, verified: false, note: `the provider's list of places could not be read, so "${placeLabel(typed)}" was not checked against it` };
  }
  const key = placeKey(name);
  const hit = catalogue.find((c) => placeKey(c) === key);
  if (!hit) {
    return { ok: false, message: `The research provider has no place called "${name}" in its list, so nothing was searched. Check the spelling, pick a larger place, or choose United States.` };
  }
  return { ok: true, name: hit, national: false, verified: true, note: null };
}

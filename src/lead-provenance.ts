/**
 * How a `web_inquiries` row ARRIVED — the difference between a lead the site
 * captured and a lead somebody typed in from a client's export.
 *
 * Both are real enquiries and both belong in the table. Only one of them
 * carries observed tracking. A hand-typed backfill knows a name, a phone and a
 * date; it knows nothing about the click, the campaign or the channel, because
 * the export it came from never contained any. Writing a plausible-looking
 * `utm_source` / `utm_medium` onto it to make it "count" is inventing evidence:
 * `ATTRIBUTABLE_UTM_WORDS` in import-och.ts reads exactly those two columns to
 * decide whether an admission was ours, so a typed-in "website"/"form" pair is
 * an attribution claim nobody observed. 37 rows of OCH's July–August form log
 * sat in that index asserting a channel (fixed 2026-09-15).
 *
 * So provenance is RECORDED, in `raw_json.source`, and READ — by this module,
 * by the attribution index, and by a person looking at the row. A backfill row
 * is kept as a lead and excluded from anything that claims a channel, and the
 * exclusion is by name rather than by the UTM columns happening to be empty:
 * blank columns are how the last version of this went wrong quietly.
 *
 * Pure: no I/O, no dates of its own.
 */

/** `raw_json.source` values written by a hand-typed backfill, never by a live capture. */
export const BACKFILL_SOURCES = [
  "elementor-log-export", // OCH's own Elementor form log, Jul 1 – Aug 24 2026
] as const;

export type LeadProvenance = "captured" | "backfilled";

/**
 * What a row's stored payload says about how it arrived. Anything that does not
 * name itself a backfill is treated as a live capture — a live webhook post is
 * the overwhelming majority and never has to declare itself.
 */
export function provenanceOf(rawJson: string | null | undefined): LeadProvenance {
  const raw = rawJson?.trim();
  if (!raw) return "captured";
  let source: unknown;
  try {
    source = (JSON.parse(raw) as { source?: unknown }).source;
  } catch {
    // Not JSON (or truncated by a SELECT left(...)): fall back to looking for
    // the marker, because a wrong "captured" here is an over-credit.
    return BACKFILL_SOURCES.some((s) => raw.includes(s)) ? "backfilled" : "captured";
  }
  return typeof source === "string" && (BACKFILL_SOURCES as readonly string[]).includes(source)
    ? "backfilled"
    : "captured";
}

/** One line for a run log, so the exclusion is visible rather than inferred. */
export function backfillExclusionLine(n: number): string {
  return (
    `${n} hand-typed backfill row(s) excluded from the attribution cross-check — ` +
    `the export they came from carried no gclid and no UTMs, so they can prove a lead but never a channel.`
  );
}

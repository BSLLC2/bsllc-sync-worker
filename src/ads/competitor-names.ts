/**
 * A keyword on another provider's name, judged on what it costs rather than on
 * its quality score.
 *
 * Pure. A list of names somebody RECORDED, a keyword, a verdict.
 *
 * ── WHY A QUALITY SCORE OF 1 TO 3 IS NORMAL HERE ───────────────────────────
 *
 * Quality score is Google's estimate of how well an ad and a landing page answer
 * the search. A keyword on a rival's name ("their brand + the city") is a search
 * for somebody else, so the ad cannot be the answer and the score is low
 * whatever the copy says. Counting those beside the keywords that score low
 * because the copy is thin sends a vendor to rewrite ads that cannot be fixed by
 * rewriting. The honest test for a competitor keyword is whether the clicks are
 * worth what they cost, which is cost per conversion.
 *
 * ── THE NAMES ARE RECORDED, NEVER DERIVED ──────────────────────────────────
 *
 * Nothing here decides a keyword is a competitor's from its wording. A sister
 * brand, a partner and a reseller look exactly like a rival until somebody who
 * knows the client says which is which; guessing sets aside keywords that
 * should be fixed. The list is `clients.ads_competitor_terms`, typed on the
 * client's Ads tab, and a NULL means nobody has recorded one: that is
 * unanswered and never "this client has no competitors". The protected-term
 * list is NOT this list: it holds brands and partners to keep, and a competitor
 * the client bids on deliberately is the opposite instruction.
 *
 * Matching is whole-word and contiguous (`isBrandKeyword`'s rule), so a recorded
 * "cat house" matches "cat house cincinnati ohio" and never "concatenate house".
 */
import { isBrandKeyword } from "./traffic-readiness.js";

/** Printed once on a quality-score row when no competitor name is recorded. */
export const COMPETITOR_NAMES_NOT_RECORDED =
  "No competitor names are recorded for this client, so a keyword on another provider's name is counted here like any other, and those score low by nature. Type the names on the client's Ads tab (Competitor names) and they are judged on cost per conversion instead.";

/** The recorded list from one field: one name per line, or comma separated. */
export function parseCompetitorNames(raw: string | null | undefined): string[] | null {
  if (raw == null) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw).split(/[\n,;]+/)) {
    const t = part.trim();
    if (!t) continue;
    const key = t.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.length ? out : null;
}

/** True when the keyword carries a recorded name, as whole words in order. */
export function matchesRecordedName(keyword: string, names: readonly string[]): boolean {
  const clean = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (clean.length === 0) return false;
  return isBrandKeyword(keyword.toLowerCase(), clean);
}

interface CompetitorKeyword {
  text: string;
  campaignName: string;
  score: number;
  costMicros: number | null;
  conversions: number | null;
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/**
 * One line per set-aside keyword, saying what it cost and what that bought.
 * A null cost or conversion count is "not read", never nought; a keyword that
 * spent and converted nothing says so plainly, which is the one case that IS a
 * problem on a competitor's name.
 */
export function competitorKeywordNote(k: CompetitorKeyword): string {
  const head = `competitor name, judged on cost · QS ${k.score}`;
  const tail = `"${k.text}" (${k.campaignName})`;
  if (k.costMicros == null) return `${head} · no spend recorded in this window · ${tail}`;
  if (k.conversions == null) return `${head} · ${usd(k.costMicros)} · conversions not read · ${tail}`;
  if (k.conversions > 0) {
    return `${head} · ${usd(k.costMicros)} · ${k.conversions % 1 === 0 ? k.conversions : k.conversions.toFixed(1)} conversions · ${usd(Math.round(k.costMicros / k.conversions))} a conversion · ${tail}`;
  }
  return k.costMicros > 0
    ? `${head} · ${usd(k.costMicros)} · 0 conversions · ${tail}`
    : `${head} · no spend · ${tail}`;
}

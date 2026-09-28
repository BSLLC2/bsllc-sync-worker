/**
 * What one Meta insights row means, and in which units.
 *
 * PURE. No network, no database, no credential, no client account. Everything
 * here is a rule about a payload shape, so it can be driven from fixtures --
 * see `npm run verify-meta-import`.
 *
 * WHY THIS FILE EXISTS RATHER THAN A SECOND COPY INSIDE THE IMPORTER. Two
 * things read Meta: the findings adapter (src/ads/meta-adapter.ts, which
 * judges campaigns and ad sets) and the metric importer (src/import-meta.ts,
 * which plants monthly spend and performance for the dashboard). They ask for
 * different objects at different levels, but they have to agree about what a
 * conversion is, what a click is and what a dollar is -- and the adapter's own
 * header records what happens when nobody writes that down: Meta reports the
 * SAME lead under two or three action types, and a regular expression over the
 * prefixes sums one conversion three times. The counting rule, the click rule
 * and the money rule therefore live here once and both sides import them.
 *
 * ── THE THREE UNIT TRAPS, AND THE ONE DECLARATION THAT SETTLES EACH ──────────
 *
 * 1. SPEND IS A DECIMAL STRING IN THE ACCOUNT'S CURRENCY. NOT MICROS, NOT
 *    CENTS. Meta answers `"spend": "451.27"`. The dashboard's own declaration
 *    (METRIC_CURRENCY_UNITS in the app's shared/schema.ts) says
 *    `meta.cost_micros` holds MICROS, because it is read by the same four
 *    readers as the Google Ads keys and those are micros. So the conversion
 *    happens HERE, once, at the boundary -- never in a reader, and never by a
 *    reader guessing from the key's spelling, which is exactly how a live
 *    account came to print "$32" in one tile and "$32,000,000" in the panel
 *    below it.
 *
 * 2. META'S `ctr` IS A PERCENTAGE. THE DASHBOARD STORES A FRACTION. Meta
 *    answers `"ctr": "1.23"` meaning 1.23%, while the app's formatMetricValue
 *    multiplies a `*_ctr` value by 100 to render it. Storing Meta's figure
 *    verbatim would print 123%. It is worse than that, though: Meta's `ctr` is
 *    computed over Clicks (All), and the click count stored beside it here is
 *    LINK clicks (rule 3), so the two would disagree on the same row. The
 *    figure is therefore DERIVED from the clicks and impressions this file
 *    actually stores, so a reader can divide one by the other and get the
 *    third.
 *
 * 3. `clicks` IS CLICKS (ALL). Meta's `clicks` counts reactions, comments,
 *    shares, profile-photo taps and media expansions alongside link clicks.
 *    Every click-shaped judgement downstream -- cost per click, conversions
 *    per click -- means a link click, so `inline_link_clicks` is what is
 *    stored. Clicks (All) stands in only where the link metric is missing
 *    entirely, and the row SAYS SO rather than quietly handing on a different
 *    metric.
 *
 * ── A NULL IS UNANSWERED, NEVER A NOUGHT ────────────────────────────────────
 * A metric Meta did not return arrives here as `null`, which the dashboard's
 * sync records as a `no_data` row for that one key: the run happened, that
 * metric has nothing behind it. Omitting the key instead would leave no row at
 * all, which reads as "never imported" -- the bug in the other direction.
 * Conversions take one extra step through metric-evidence.ts, for the reason
 * that file argues: Meta answers 0 both for "nobody converted" and for "no
 * pixel event is configured", and never says which.
 */
import { evidencedMetric } from "../metric-evidence.js";

/** One Graph API version for everything that reads Meta. */
export const META_GRAPH = "https://graph.facebook.com/v21.0";

/**
 * The metric keys the importer writes, and the ONLY ones it writes.
 *
 * This list has to equal `EXPECTED_METRIC_KEYS.meta` in the dashboard's
 * shared/schema.ts, or the client page renders a permanent "no data yet" cell
 * for a key nothing produces (an absence dressed as an expectation) or drops a
 * key that does arrive. The repos cannot import from each other, so the app's
 * `npm run verify:wiring` reads this array out of this file and compares the
 * two. Every money key among them must also be declared in
 * METRIC_CURRENCY_UNITS over there; that check runs in the same place.
 */
export const META_METRIC_KEYS = [
  "meta.cost_micros",
  "meta.impressions",
  "meta.clicks",
  "meta.conversions",
  // WHAT META ITSELF SAYS IT DROVE, IN THE AD ACCOUNT'S OWN CURRENCY -- not
  // micros and not cents, which is how `ads.conversion_value` is already
  // declared on the other side and why this one is declared identically. It is
  // the SECOND reading of a channel's revenue: the dashboard already holds
  // GA4's last-click figure, and the two are never summed, because a platform
  // counts view-through and its own click window over the same dollar the
  // analytics property credits somewhere else.
  "meta.conversion_value",
  "meta.ctr",
  "meta.average_cpc",
] as const;

/**
 * What the monthly account-level insights call asks for.
 *
 * `objective_results` is deliberately ABSENT here although the adapter asks
 * for it: it is the platform's count of what an AD SET is optimising for, and
 * an account-level query has no single objective to report it against. Asking
 * for it at this level risks a 400 for a field that could not have meant
 * anything anyway, so the count falls to `actions` and says so.
 *
 * `attribution_setting` is carried so the log can name the window Meta counted
 * these conversions under. It is never stored.
 */
export const META_MONTHLY_FIELDS =
  "spend,impressions,clicks,inline_link_clicks,actions,action_values,attribution_setting";

/**
 * WHICH ACTION TYPES COUNT AS ONE CONVERSION, AND WHY THIS IS A LIST AND NOT A
 * PATTERN.
 *
 * Meta's `actions` array is not a list of distinct events. The same lead is
 * reported several times under different names: `lead` is the canonical roll-up
 * and `offsite_conversion.fb_pixel_lead` is the pixel's own copy of the same
 * event, and `onsite_conversion.lead_grouped` is the instant-form copy. A
 * regular expression over the prefixes therefore SUMS one conversion two or
 * three times, and every cost-per-conversion figure downstream comes out a
 * third or a half of what it really is -- which is the direction that makes an
 * account look like it is working.
 *
 * So the families are declared, in preference order, and exactly ONE member of
 * each family is taken: the first one present. A family is a business outcome;
 * the names inside it are the several ways Meta reports it.
 *
 * Verify the exact strings on a real account before treating the ordering as
 * load-bearing -- this was assembled from Meta's own SDK field lists and from
 * community reports, not from a live read.
 */
export const ACTION_FAMILIES: readonly (readonly string[])[] = [
  // A form filled in, on the site or in an instant form.
  ["lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped", "leadgen_grouped"],
  // A sale.
  ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"],
  // An account or registration completed.
  ["complete_registration", "offsite_conversion.fb_pixel_complete_registration"],
  // An application submitted.
  ["submit_application", "offsite_conversion.fb_pixel_submit_application"],
];

/**
 * Count conversions from one insights row without counting anything twice.
 *
 * `objective_results` is preferred wherever Meta reports it: it is the
 * platform's own count of the thing the ad set is optimising for, which is the
 * number the delivery model is actually working from and the only one that
 * lines up with what the learning threshold is measured against.
 *
 * `basis: "none"` means Meta reported NOTHING countable on this row -- neither
 * an objective result nor a single action. That is not the same statement as
 * "nought people converted", and the caller must not read it as one.
 */
export function countMetaConversions(row: {
  actions?: unknown;
  objective_results?: unknown;
}): { conversions: number; basis: "objective_results" | "actions" | "none" } {
  const objective = Number(row.objective_results ?? NaN);
  if (Number.isFinite(objective) && objective >= 0) return { conversions: objective, basis: "objective_results" };

  const { total, sawAny } = oneFromEachFamily(row.actions);
  return { conversions: total, basis: sawAny ? "actions" : "none" };
}

/**
 * THE FAMILY WALK, WRITTEN ONCE FOR BOTH THINGS META DOUBLE-REPORTS.
 *
 * `actions` and `action_values` are the SAME array shape carrying the same
 * duplication: a purchase arrives as `omni_purchase`, `purchase` AND
 * `offsite_conversion.fb_pixel_purchase`, so a sum over the array counts one
 * sale three times -- and in `action_values` that is three times the money,
 * which is the direction that makes an account look like it is working. Two
 * copies of this walk is how one of them comes to include a family the other
 * does not, so there is one, and the families are ACTION_FAMILIES for both.
 *
 * Exactly one member of each family is taken: the first one present.
 */
function oneFromEachFamily(raw: unknown): { total: number; sawAny: boolean } {
  const rows: { action_type?: string; value?: string }[] = Array.isArray(raw) ? raw : [];
  if (!rows.length) return { total: 0, sawAny: false };
  const byType = new Map<string, number>();
  for (const a of rows) {
    const t = String(a.action_type ?? "");
    if (!t) continue;
    const n = Number(a.value ?? 0);
    // A member whose value Meta did not make a number of is not evidence that
    // the family was reported -- taking it would fix the family on an unusable
    // figure and shut out the readable member behind it.
    if (Number.isFinite(n)) byType.set(t, n);
  }
  let total = 0;
  let sawAny = false;
  for (const family of ACTION_FAMILIES) {
    for (const name of family) {
      if (byType.has(name)) { total += byType.get(name) ?? 0; sawAny = true; break; }
    }
  }
  return { total, sawAny };
}

/**
 * The money Meta says those conversions were worth, off ONE insights row, in
 * the ad account's own currency.
 *
 * `action_values` is the value half of `actions` and carries the identical
 * duplication, so it goes through the same family walk -- see above. There is
 * deliberately no `objective_results` preference here as there is for the
 * count: that field is a COUNT of the thing an ad set optimises for and says
 * nothing about what any of it was worth, so `action_values` is the only
 * source and the basis says so.
 *
 * `basis: "none"` means Meta reported no value of any recognised kind on this
 * row. That is NOT the same statement as "this month was worth nothing", and
 * the caller must not read it as one -- a lead-gen account reports conversions
 * with no value against them for ever, which is a real and permanent absence
 * rather than a nought.
 *
 * NOT A CURRENCY CONVERSION and not micros. Meta answers in the ad account's
 * own money, `METRIC_CURRENCY_UNITS` declares `meta.conversion_value` as
 * DOLLARS exactly as it declares `ads.conversion_value`, and every reader on
 * the other side reads the two the same way.
 */
export function sumMetaActionValues(row: { action_values?: unknown }): {
  value: number;
  basis: "action_values" | "none";
} {
  const { total, sawAny } = oneFromEachFamily(row.action_values);
  return { value: total, basis: sawAny ? "action_values" : "none" };
}

/** A finite number, or null. A string Meta could not make a number of is an
 *  absence, never a nought. */
function finiteOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Meta's `spend` (a decimal string in the ad account's own currency) as
 * MICROS, which is the unit the dashboard declares for `meta.cost_micros`.
 * Absent or unreadable is null -- see trap 1 in the header.
 *
 * NOT a currency conversion. An ad account billed in another currency reports
 * its own, and nothing here knows the rate; the figure is that account's
 * spend, in that account's money, and it is the same assumption every Google
 * Ads figure in this system already carries.
 */
export function metaSpendToMicros(v: unknown): number | null {
  const n = finiteOrNull(v);
  return n == null ? null : Math.round(n * 1_000_000);
}

/**
 * Link clicks off one insights row, with Clicks (All) as a NAMED fallback.
 * See trap 3. `usedAllClicks` exists so the run can say the substitution
 * happened rather than handing a different metric on in silence.
 */
export function metaLinkClicks(row: { inline_link_clicks?: unknown; clicks?: unknown }): {
  clicks: number | null;
  usedAllClicks: boolean;
} {
  const link = finiteOrNull(row.inline_link_clicks);
  if (link != null) return { clicks: link, usedAllClicks: false };
  const all = finiteOrNull(row.clicks);
  if (all != null) return { clicks: all, usedAllClicks: true };
  return { clicks: null, usedAllClicks: false };
}

/**
 * The calendar month a `time_increment=monthly` row belongs to, from the row's
 * OWN `date_start`. Null when the row carries no usable date, which is a row
 * this importer cannot place and therefore refuses to plant.
 */
export function metaMonthKey(row: { date_start?: unknown }): string | null {
  const raw = typeof row.date_start === "string" ? row.date_start.trim() : "";
  const ym = raw.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(ym) ? ym : null;
}

/**
 * The conversion count each row contributes to the evidence window.
 *
 * A row Meta reported nothing countable on contributes a nought -- it is not
 * evidence that the pixel works, which is the whole question the window
 * answers.
 */
export function metaConversionWindow(rows: readonly Record<string, unknown>[]): number[] {
  return rows.map((r) => {
    const { conversions, basis } = countMetaConversions(r);
    return basis === "none" ? 0 : conversions;
  });
}

/**
 * The same window for the MONEY, and it is deliberately its own.
 *
 * `evidencedMetric` asks one question -- has this account ever reported THIS
 * metric at all -- and the answer differs between the count and the value. A
 * lead-gen account reports conversions every month and a value against none of
 * them, for ever, because nobody assigns a lead a price in Meta. Reading the
 * value's evidence off the CONVERSION window would plant a live nought on
 * every one of those months, and "$0 of revenue" is a measured claim about an
 * account that is measuring something else entirely -- the null-as-nought
 * failure this whole rule exists to refuse. So the value earns its own noughts
 * from its own history, which is what metric-evidence.ts's header describes.
 */
export function metaConversionValueWindow(rows: readonly Record<string, unknown>[]): number[] {
  return rows.map((r) => {
    const { value, basis } = sumMetaActionValues(r);
    return basis === "none" ? 0 : value;
  });
}

/** Both windows, from one pass over the account's whole pull. Taking them
 *  together is what stops a caller passing the conversion window twice. */
export interface MetaEvidenceWindow {
  conversions: readonly number[];
  values: readonly number[];
}
export function metaEvidenceWindow(rows: readonly Record<string, unknown>[]): MetaEvidenceWindow {
  return { conversions: metaConversionWindow(rows), values: metaConversionValueWindow(rows) };
}

export interface MetaMonthReading {
  /** "YYYY-MM", or null for a row this importer cannot place. */
  ym: string | null;
  /** `no_data` where Meta returned a month in which nothing was served. */
  state: "live" | "no_data";
  /** Every key in META_METRIC_KEYS, with null where Meta said nothing. */
  metrics: Record<string, number | null>;
  /** Clicks (All) stood in for link clicks on this row. */
  usedAllClicks: boolean;
  /** How the conversion figure was arrived at, for the log. */
  conversionBasis: "objective_results" | "actions" | "none";
  /** True where the conversion figure was held back for want of evidence. */
  conversionsHeldBack: boolean;
  /** How the revenue figure was arrived at, for the log. */
  conversionValueBasis: "action_values" | "none";
  /** True where the revenue figure was held back for want of evidence — which
   *  on a lead-gen account is the ordinary, permanent state. */
  conversionValueHeldBack: boolean;
}

/**
 * One month of one ad account, as the dashboard's metric keys.
 *
 * `convWindow` is metaConversionWindow() over EVERY month in the same pull --
 * the evidence that this account's pixel reports conversions at all. Passing a
 * single month's own figure would make every quiet month read as no_data and
 * every busy one as live, which is not the question being asked.
 */
export function metaMonthlyMetrics(
  row: Record<string, unknown>,
  window: MetaEvidenceWindow,
): MetaMonthReading {
  const spendMicros = metaSpendToMicros(row.spend);
  const impressions = finiteOrNull(row.impressions);
  const { clicks, usedAllClicks } = metaLinkClicks(row);
  const { conversions: counted, basis } = countMetaConversions(row);
  const { value: countedValue, basis: valueBasis } = sumMetaActionValues(row);

  // A month in which nothing was served is `no_data`, not a row of noughts --
  // the same call src/google-ads.ts makes on an account with no delivery in
  // the window. Metrics are dropped entirely here because there is genuinely
  // nothing to report, and the entry itself still lands so the run is on the
  // record.
  const nothingServed = (spendMicros ?? 0) === 0 && (impressions ?? 0) === 0 && (clicks ?? 0) === 0;
  if (nothingServed) {
    return {
      ym: metaMonthKey(row), state: "no_data", metrics: {}, usedAllClicks,
      conversionBasis: basis, conversionsHeldBack: false,
      conversionValueBasis: valueBasis, conversionValueHeldBack: false,
    };
  }

  // Meta answers 0 both for "nobody converted" and for "no pixel event is
  // configured", and never says which, so a nought is only planted where this
  // account has demonstrably reported a conversion somewhere in the window.
  // See metric-evidence.ts; this is the same rule the GA4 importer runs.
  const conversions = evidencedMetric(basis === "none" ? 0 : counted, window.conversions as (number | null)[]);
  // Read against the VALUE's own history, never the count's — see
  // metaConversionValueWindow. An account that has never put a price on a
  // conversion records no data here for ever, which is the truth about it;
  // a nought would be a revenue figure nobody measured.
  const conversionValue = evidencedMetric(
    valueBasis === "none" ? 0 : countedValue,
    window.values as (number | null)[],
  );

  const metrics: Record<string, number | null> = {
    "meta.cost_micros": spendMicros,
    "meta.impressions": impressions,
    "meta.clicks": clicks,
    "meta.conversions": conversions,
    // DOLLARS, in the ad account's own currency — the same declaration
    // `ads.conversion_value` carries, so the dashboard reads the two
    // platforms' claims through one rule. It is what META says it drove, which
    // is a different reading from the analytics property's last-click revenue
    // and is never added to it.
    "meta.conversion_value": conversionValue,
    // DERIVED, never taken from Meta's own `ctr`. See trap 2: theirs is a
    // percentage over Clicks (All); this is a fraction over the link clicks
    // stored on the line above, so the three figures agree with each other.
    "meta.ctr": impressions != null && impressions > 0 && clicks != null ? clicks / impressions : null,
    // Cost per LINK click, in micros, derived for the same reason. Null rather
    // than nought where there were no clicks: a cost per click nobody paid is
    // not nought, it is undefined.
    "meta.average_cpc": spendMicros != null && clicks != null && clicks > 0 ? spendMicros / clicks : null,
  };

  return {
    ym: metaMonthKey(row),
    state: "live",
    metrics,
    usedAllClicks,
    conversionBasis: basis,
    conversionsHeldBack: conversions == null,
    conversionValueBasis: valueBasis,
    conversionValueHeldBack: conversionValue == null,
  };
}

/**
 * An ad account id in either form a person actually pastes into Admin ->
 * Connectors: `act_1234567890`, or the bare digits the Ads Manager URL shows.
 * The Graph path needs the prefix, and adding it twice is a 400 that surfaces
 * as a dead connector rather than as a fixable typo -- the same near miss the
 * GA4 importer already corrects for `properties/`.
 *
 * Something with no digits in it at all ("our facebook") comes back EMPTY
 * rather than as `act_`, so the importer can refuse it by name instead of
 * asking Meta about an account that cannot exist.
 */
export function metaAccountId(raw: string): string {
  const t = raw.trim().replace(/^act_/i, "").replace(/[^0-9]/g, "");
  return t ? `act_${t}` : "";
}

/** Meta refuses an insights window that starts more than 37 months ago. */
export const META_MAX_LOOKBACK_MONTHS = 37;

/** First day of the month `months` before (and including) the month containing
 *  `now`, as YYYY-MM-DD. `months = 1` is this month. */
export function monthsBackStart(months: number, now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - Math.max(0, months - 1), 1));
  return d.toISOString().slice(0, 10);
}

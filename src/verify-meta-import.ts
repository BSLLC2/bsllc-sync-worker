#!/usr/bin/env tsx
/**
 * Proves the rules the Meta importer turns on, without a database, a network
 * call, a token or a client account.
 *
 * The three that matter are UNIT rules, because this codebase has already paid
 * for getting one wrong: Google Ads micros were rendered as dollars by a reader
 * that guessed the unit from the metric key's spelling, and one client page
 * printed "$32" and "$32,000,000" for the same stored number. Meta gives three
 * more chances to make the same mistake -- spend is a decimal string in the
 * account currency, `ctr` is a percentage, and `clicks` is not link clicks --
 * so each one is checked here against a fixture AND against a deliberately
 * wrong reading that must fail the same check.
 *
 * EVERY FIGURE BELOW IS INVENTED. No real client, ad account, campaign or
 * amount appears here, and nothing in this file has been run against a live
 * Meta account -- there is no Meta credential in the environment this was
 * written in.
 *
 *   npm run verify-meta-import
 */
import {
  META_METRIC_KEYS, META_MONTHLY_FIELDS,
  countMetaConversions, metaAccountId, metaConversionValueWindow, metaConversionWindow,
  metaEvidenceWindow, metaLinkClicks, metaMonthKey, metaMonthlyMetrics, metaSpendToMicros,
  monthsBackStart, sumMetaActionValues,
} from "./meta/insights.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
/** A check that only means something if it can fail. Runs the same predicate
 *  against a deliberately wrong reading and asserts it says no. */
const planted = (label: string, predicate: () => boolean) => {
  const caught = !predicate();
  console.log(`  ${caught ? "🧪" : "❌"} planted failure: ${label}${caught ? " — caught" : " — NOT CAUGHT"}`);
  if (!caught) failures++;
};

console.log("Meta importer — the rules a monthly row is read by");
console.log("Pure. No network, no database, no token, no client account. Every figure is invented.\n");

/** One invented month of one invented ad account, in the shape the Graph API
 *  answers `act_X/insights?time_increment=monthly` with. */
const AUGUST = {
  date_start: "2026-08-01",
  date_stop: "2026-08-31",
  spend: "451.27",               // a decimal STRING in the account's currency
  impressions: "82140",
  clicks: "1904",                // Clicks (All) — reactions, comments, shares
  inline_link_clicks: "1211",    // link clicks — what every judgement means
  attribution_setting: "7d_click_1d_view",
  actions: [
    // The SAME lead, three times, which is how Meta reports one lead.
    { action_type: "lead", value: "34" },
    { action_type: "offsite_conversion.fb_pixel_lead", value: "34" },
    { action_type: "onsite_conversion.lead_grouped", value: "34" },
    // Unrelated engagement that is not a business outcome at all.
    { action_type: "post_engagement", value: "2205" },
    { action_type: "landing_page_view", value: "1100" },
  ],
  // THE VALUE HALF OF THE SAME DUPLICATION. One invented figure, reported
  // three times under the same three names — which is how Meta answers, and
  // why a sum over the array is three times the money rather than three times
  // the count. `post_engagement` carries a number and is not a business
  // outcome, so it is money that must not be counted at all.
  action_values: [
    { action_type: "lead", value: "12500.50" },
    { action_type: "offsite_conversion.fb_pixel_lead", value: "12500.50" },
    { action_type: "onsite_conversion.lead_grouped", value: "12500.50" },
    { action_type: "post_engagement", value: "9999" },
  ],
};

// ── 1. Money ────────────────────────────────────────────────────────────────
console.log("1. Spend is a decimal string in the account's currency, stored as micros");
{
  ok("$451.27 becomes 451,270,000 micros", metaSpendToMicros("451.27") === 451_270_000);
  ok("  …a plain number is read the same way", metaSpendToMicros(451.27) === 451_270_000);
  ok("  …and the figure is never treated as if it were already micros", metaSpendToMicros("451.27") !== 451.27);
  ok("an absent spend is null, never nought", metaSpendToMicros(undefined) === null && metaSpendToMicros(null) === null);
  ok("  …and so is an empty string or something unreadable", metaSpendToMicros("") === null && metaSpendToMicros("n/a") === null);
  ok("a genuine nought spend is a nought, not an absence", metaSpendToMicros("0") === 0);

  // The whole point: micros divided by a million is the dollars a person can
  // check against the Ads Manager screen.
  const m = metaMonthlyMetrics(AUGUST, metaEvidenceWindow([AUGUST]));
  ok("the month's cost key reads back as the dollars Meta reported", (m.metrics["meta.cost_micros"]! / 1_000_000).toFixed(2) === "451.27");

  planted("spend stored verbatim instead of converted to micros", () => {
    const wrong = { ...m.metrics, "meta.cost_micros": Number(AUGUST.spend) };
    return (wrong["meta.cost_micros"]! / 1_000_000).toFixed(2) === "451.27";
  });
}

// ── 2. Click-through rate ───────────────────────────────────────────────────
console.log("\n2. CTR is a FRACTION here and a PERCENTAGE at Meta");
{
  const m = metaMonthlyMetrics(AUGUST, metaEvidenceWindow([AUGUST]));
  const ctr = m.metrics["meta.ctr"]!;
  // The dashboard's formatMetricValue multiplies a *_ctr value by 100, so a
  // percentage stored verbatim prints at a hundred times its real size.
  ok("a click-through rate is stored as a fraction below 1", ctr > 0 && ctr < 1);
  ok("  …and it is the LINK clicks over the impressions, so the row agrees with itself",
    Math.abs(ctr - m.metrics["meta.clicks"]! / m.metrics["meta.impressions"]!) < 1e-12);
  ok("  …which renders as a believable percentage", `${(ctr * 100).toFixed(2)}%` === "1.47%");

  planted("Meta's own ctr percentage stored verbatim", () => {
    const metaCtr = 2.32; // what Meta answers for this row: 2.32%
    return metaCtr > 0 && metaCtr < 1;
  });

  const noImpressions = metaMonthlyMetrics({ ...AUGUST, impressions: "0" }, metaEvidenceWindow([AUGUST]));
  ok("no impressions means no click-through rate, not a nought", noImpressions.metrics["meta.ctr"] === null);
}

// ── 3. Clicks ───────────────────────────────────────────────────────────────
console.log("\n3. A click is a LINK click, and a substitution is named");
{
  const link = metaLinkClicks(AUGUST);
  ok("inline_link_clicks wins over Clicks (All)", link.clicks === 1211 && !link.usedAllClicks);
  const noLink = metaLinkClicks({ clicks: "1904" });
  ok("Clicks (All) stands in only where the link metric is missing", noLink.clicks === 1904 && noLink.usedAllClicks);
  ok("  …and the row says the substitution happened", noLink.usedAllClicks === true);
  ok("neither present is an absence, never a nought", metaLinkClicks({}).clicks === null);

  const m = metaMonthlyMetrics(AUGUST, metaEvidenceWindow([AUGUST]));
  ok("the stored click count is the link clicks", m.metrics["meta.clicks"] === 1211);
  planted("Clicks (All) stored as the click count", () => {
    const wrong = { ...m.metrics, "meta.clicks": 1904 };
    return wrong["meta.clicks"] === 1211;
  });

  // Cost per LINK click, in micros, so it renders through the same reader as
  // the Google Ads key of the same name.
  ok("cost per click is micros over link clicks", m.metrics["meta.average_cpc"] === 451_270_000 / 1211);
  ok("  …which reads back as cents somebody can check", (m.metrics["meta.average_cpc"]! / 1_000_000).toFixed(2) === "0.37");
  const noClicks = metaMonthlyMetrics({ ...AUGUST, clicks: "0", inline_link_clicks: "0" }, metaEvidenceWindow([AUGUST]));
  ok("no clicks means no cost per click, not a nought", noClicks.metrics["meta.average_cpc"] === null);
}

// ── 4. One conversion counted once ──────────────────────────────────────────
console.log("\n4. Meta reports one lead three times; it is counted once");
{
  const { conversions, basis } = countMetaConversions(AUGUST);
  ok("34 leads reported under three action types count as 34", conversions === 34 && basis === "actions");
  planted("a pattern over the action-type prefixes instead of the declared families", () => {
    const summed = AUGUST.actions
      .filter((a) => /lead/.test(a.action_type))
      .reduce((s, a) => s + Number(a.value), 0);
    return summed === 34;
  });

  ok("a purchase and a lead are different outcomes and both count",
    countMetaConversions({ actions: [{ action_type: "lead", value: "3" }, { action_type: "purchase", value: "5" }] }).conversions === 8);
  ok("engagement is not a conversion",
    countMetaConversions({ actions: [{ action_type: "post_engagement", value: "2205" }] }).basis === "none");
  ok("the platform's own objective result wins where it is reported",
    countMetaConversions({ objective_results: 7, actions: [{ action_type: "lead", value: "12" }] }).conversions === 7);
  ok("a row with nothing countable on it says so rather than claiming a nought",
    countMetaConversions({}).basis === "none");
}

// ── 4b. What Meta says it drove, in the account's own money ─────────────────
console.log("\n4b. The value of those conversions is counted once, in DOLLARS");
{
  const { value, basis } = sumMetaActionValues(AUGUST);
  ok("one valued lead reported under three action types counts once", value === 12500.5 && basis === "action_values");
  ok("  …and engagement carrying a number is not money", value !== 12500.5 + 9999);

  planted("a sum over every value row instead of one member per family", () => {
    const summed = AUGUST.action_values.reduce((s, a) => s + Number(a.value), 0);
    return summed === 12500.5;
  });
  planted("a pattern over the action-type prefixes instead of the declared families", () => {
    const summed = AUGUST.action_values
      .filter((a) => /lead/.test(a.action_type))
      .reduce((s, a) => s + Number(a.value), 0);
    return summed === 12500.5;
  });

  const m = metaMonthlyMetrics(AUGUST, metaEvidenceWindow([AUGUST]));
  ok("the month's revenue key holds the account's own currency, not micros and not cents",
    m.metrics["meta.conversion_value"] === 12500.5);
  ok("  …so it reads back as the dollars somebody can check against Ads Manager",
    m.metrics["meta.conversion_value"]!.toFixed(2) === "12500.50");
  planted("the value converted to micros the way spend is", () => {
    const wrong = Math.round(12500.5 * 1_000_000);
    return wrong === 12500.5;
  });
  planted("the value stored as cents", () => Math.round(12500.5 * 100) === 12500.5);

  ok("a row with no action_values at all says so rather than claiming a nought",
    sumMetaActionValues({}).basis === "none" && sumMetaActionValues({ action_values: [] }).basis === "none");
  ok("a purchase and a lead are different outcomes and both are worth money",
    sumMetaActionValues({ action_values: [{ action_type: "lead", value: "10" }, { action_type: "omni_purchase", value: "90" }] }).value === 100);
  ok("the purchase family is taken once, at its preferred member",
    sumMetaActionValues({ action_values: [
      { action_type: "omni_purchase", value: "500" },
      { action_type: "purchase", value: "500" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "500" },
    ] }).value === 500);
  ok("a value Meta did not make a number of is not evidence the family was reported",
    sumMetaActionValues({ action_values: [{ action_type: "omni_purchase", value: "n/a" }, { action_type: "purchase", value: "72" }] }).value === 72);
}

// ── 4c. A lead-gen account prices nothing, for ever ─────────────────────────
console.log("\n4c. Revenue earns its noughts from ITS OWN history, never from the count's");
{
  // The ordinary lead-gen account: conversions every month, a price on none of
  // them. Reading the value's evidence off the CONVERSION window would plant
  // "$0 of revenue" on every month of it — a measured claim about an account
  // that is measuring something else.
  const leadGen = { ...AUGUST, action_values: undefined as unknown };
  const july = { ...leadGen, date_start: "2026-07-01" };
  const w = metaEvidenceWindow([leadGen, july]);
  ok("an account that prices nothing has conversion evidence", w.conversions.every((n) => n > 0));
  ok("  …and no value evidence at all", w.values.every((n) => n === 0));
  const r = metaMonthlyMetrics(leadGen, w);
  ok("  …so its conversions are a live figure", r.metrics["meta.conversions"] === 34);
  ok("  …and its revenue is no data, never a nought", r.metrics["meta.conversion_value"] === null);
  ok("  …and the run can say so", r.conversionValueHeldBack === true && r.conversionValueBasis === "none");
  ok("  …and the key is still present, so the month reads as imported rather than missing",
    "meta.conversion_value" in r.metrics);

  planted("an unevidenced revenue nought planted as a live figure",
    () => metaMonthlyMetrics(leadGen, w).metrics["meta.conversion_value"] === 0);
  planted("the value's evidence read off the conversion window", () => {
    const wrong = metaConversionWindow([leadGen, july]).some((n) => n > 0);
    return !wrong; // reading the count's window would say "this account reports value"
  });

  // An account that DOES price its conversions keeps a quiet month as a real
  // nought, which is the other half of the same rule.
  const quiet = { ...AUGUST, date_start: "2026-07-01", action_values: [{ action_type: "post_engagement", value: "12" }] };
  const priced = metaEvidenceWindow([quiet, AUGUST]);
  ok("an account that has priced a conversion keeps its quiet months as real noughts",
    metaMonthlyMetrics(quiet, priced).metrics["meta.conversion_value"] === 0);
  ok("  …and the value window is built from the values, not the counts",
    metaConversionValueWindow([quiet, AUGUST]).join() === "0,12500.5");
}

// ── 5. A nought needs evidence ──────────────────────────────────────────────
console.log("\n5. A conversion nought is only a nought where the pixel has ever fired");
{
  const quiet = { ...AUGUST, actions: [{ action_type: "post_engagement", value: "12" }] };
  const configured = [quiet, AUGUST];
  const window = metaEvidenceWindow(configured);
  ok("an account that has reported leads keeps its quiet months as real noughts",
    metaMonthlyMetrics(quiet, window).metrics["meta.conversions"] === 0);

  const neverAny = [quiet, { ...quiet, date_start: "2026-07-01" }];
  const blindWindow = metaEvidenceWindow(neverAny);
  const blind = metaMonthlyMetrics(quiet, blindWindow);
  ok("an account that has never reported one records no data, not a live nought",
    blind.metrics["meta.conversions"] === null);
  ok("  …and the run can say so", blind.conversionsHeldBack === true);
  ok("  …and the key is still present, so the month reads as imported rather than missing",
    "meta.conversions" in blind.metrics);

  planted("an unevidenced nought planted as a live figure", () => metaMonthlyMetrics(quiet, blindWindow).metrics["meta.conversions"] === 0);
}

// ── 6. A month with nothing served ──────────────────────────────────────────
console.log("\n6. Nothing served is no_data, not a row of noughts");
{
  const empty = { date_start: "2026-05-01", date_stop: "2026-05-31", spend: "0", impressions: "0", clicks: "0", inline_link_clicks: "0" };
  const r = metaMonthlyMetrics(empty, metaEvidenceWindow([empty]));
  ok("a month with no delivery is no_data", r.state === "no_data");
  ok("  …and carries no metrics at all rather than six noughts", Object.keys(r.metrics).length === 0);
  ok("  …and is still placed in its own month, so the run is on the record", r.ym === "2026-05");

  const served = metaMonthlyMetrics(AUGUST, metaEvidenceWindow([AUGUST]));
  ok("a month with delivery is live", served.state === "live");
}

// ── 7. What the importer writes, and only that ──────────────────────────────
console.log("\n7. The key set is the declared one");
{
  const m = metaMonthlyMetrics(AUGUST, metaEvidenceWindow([AUGUST]));
  const keys = Object.keys(m.metrics).sort();
  ok(`exactly the ${META_METRIC_KEYS.length} declared keys are written`,
    keys.join(",") === [...META_METRIC_KEYS].sort().join(","), keys.join(" "));
  ok("every key is namespaced to meta", keys.every((k) => k.startsWith("meta.")));
  ok("the monthly field list asks for what the rules read",
    ["spend", "impressions", "clicks", "inline_link_clicks", "actions", "action_values"].every((f) => META_MONTHLY_FIELDS.split(",").includes(f)));
  ok("  …including the value half, or the revenue key would be null on every account",
    META_MONTHLY_FIELDS.split(",").includes("action_values"));
  ok("the revenue key is one of the declared ones", (META_METRIC_KEYS as readonly string[]).includes("meta.conversion_value"));
  ok("  …and does NOT ask for objective_results, which has no meaning at account level",
    !META_MONTHLY_FIELDS.split(",").includes("objective_results"));
}

// ── 8. Placing a row, and the account id ────────────────────────────────────
console.log("\n8. A row is placed by its own date, and an ad account id by its digits");
{
  ok("a monthly row is placed by its date_start", metaMonthKey(AUGUST) === "2026-08");
  ok("a row with no usable date is placed nowhere rather than guessed at", metaMonthKey({}) === null && metaMonthKey({ date_start: "soon" }) === null);

  ok("act_1234567890 is taken as it is", metaAccountId("act_1234567890") === "act_1234567890");
  ok("  …and the bare digits from the Ads Manager URL get the prefix", metaAccountId("1234567890") === "act_1234567890");
  ok("  …and the prefix is never doubled", metaAccountId("act_act_1234567890") === "act_1234567890");
  ok("something with no digits in it is refused rather than turned into act_", metaAccountId("our facebook") === "");

  const now = new Date("2026-09-25T09:00:00.000Z");
  ok("the default window starts at the first of the month 24 months back", monthsBackStart(24, now) === "2024-10-01");
  ok("  …and one month back is this month", monthsBackStart(1, now) === "2026-09-01");
}

console.log(`\n${"─".repeat(72)}`);
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
console.log("─".repeat(72));
process.exit(failures === 0 ? 0 : 1);

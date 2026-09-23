#!/usr/bin/env tsx
/**
 * Guard for the outcome record — what happened after a change.
 *
 * No database and no ad account: it drives the real functions over fixtures.
 * EVERY FIGURE HERE IS INVENTED. There is no production database in this
 * sandbox and no ad-account credential, so nothing in this file was measured.
 *
 *   npx tsx src/verify-ads-outcome-record.ts
 */
import {
  episodesFrom, episodeKey, episodeDue, outcomeWindows, outcomeReading, episodeDescription,
  minimumDetectableEffect, noiseBand, noiseBandLine,
  EPISODE_QUIET_DAYS, OUTCOME_HORIZONS, MIN_NOISE_BAND, MIN_CONVERSIONS_TO_COMPARE,
  Z_ALPHA_HALF, Z_BETA, OBSERVATIONAL_CAVEAT,
  type OutcomeEventFact, type ChangeEpisode, type OutcomeReading,
} from "./ads/outcome-record.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);

const at = (iso: string) => new Date(`${iso}T10:00:00.000Z`);
const ev = (iso: string, over: Partial<OutcomeEventFact> = {}): OutcomeEventFact => ({
  changedAt: at(iso),
  campaignId: "222222",
  resourceType: "CAMPAIGN_BUDGET",
  operation: "UPDATE",
  actorKind: "person",
  actorInternal: false,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
hr("1. An episode is a run of changes, not one event");
{
  const eps = episodesFrom([
    ev("2026-08-01"), ev("2026-08-02"), ev("2026-08-03"),   // one piece of work
    ev("2026-08-20"), ev("2026-08-21"),                      // a fortnight later
  ]);
  ok("a run of changes inside the quiet gap is one episode", eps.length === 2, `${eps.length} episodes`);
  ok("the first holds all three", eps[0]!.events.length === 3);
  ok("the gap that splits them is the declared one", EPISODE_QUIET_DAYS === 2);
  ok("the episode spans first to last", eps[0]!.start < eps[0]!.end);

  const perEntity = episodesFrom([
    ev("2026-08-01", { campaignId: "111" }),
    ev("2026-08-01", { campaignId: "222" }),
  ]);
  ok("two campaigns changed the same day are two episodes", perEntity.length === 2);

  const acctLevel = episodesFrom([
    ev("2026-08-01", { campaignId: null, resourceType: "CUSTOMER_ASSET" }),
    ev("2026-08-01", { campaignId: "111" }),
  ]);
  ok("an account-level change is its OWN episode, never copied onto every campaign",
    acctLevel.length === 2 && acctLevel.some((e) => e.campaignId === ""));
}

hr("2. The key is an identity, never a position in a list");
{
  const events = [ev("2026-08-01"), ev("2026-08-02")];
  const a = episodesFrom(events)[0]!;
  const b = episodesFrom([...events].reverse())[0]!;
  const ka = episodeKey("acct", a.campaignId, a.start);
  const kb = episodeKey("acct", b.campaignId, b.start);
  ok("the same episode keys the same way whatever order it arrives in", ka === kb, ka);
  // A key built from a position in a result set would move the moment another
  // episode appeared earlier in the list. This one is made only of the
  // account, the entity and the day the run of changes started.
  const withNeighbour = episodesFrom([ev("2026-07-01"), ...events]);
  const later = withNeighbour[withNeighbour.length - 1]!;
  ok("an earlier episode appearing does not move this one's key",
    episodeKey("acct", later.campaignId, later.start) === ka, ka);
  ok("a different day is a different episode", episodeKey("acct", "222222", at("2026-08-02")) !== ka);
  const byIndex = (i: number) => `acct|222222|${i}`;
  ok("SELF-TEST: a key built from a row index would not be stable", byIndex(0) !== byIndex(1));
}

hr("3. How much of a move this book can actually tell apart");
{
  const ten = minimumDetectableEffect(10)!;
  const hundred = minimumDetectableEffect(100)!;
  const fourHundred = minimumDetectableEffect(400)!;
  const expected = (n: number) => (Z_ALPHA_HALF + Z_BETA) * Math.sqrt(2 / n);
  ok("ten conversions can only tell a doubling apart", Math.abs(ten - expected(10)) < 1e-9 && ten > 1.2 && ten < 1.3, `${(ten * 100).toFixed(0)}%`);
  ok("a hundred brings it to about 40%", hundred > 0.38 && hundred < 0.41, `${(hundred * 100).toFixed(0)}%`);
  ok("four hundred brings it to about 20%", fourHundred > 0.19 && fourHundred < 0.21, `${(fourHundred * 100).toFixed(0)}%`);
  ok("more volume never widens the band", ten > hundred && hundred > fourHundred);
  ok("a denominator below one is refused rather than divided by",
    minimumDetectableEffect(0.4) === null && minimumDetectableEffect(0) === null);
  ok("the refusal threshold is the declared one", MIN_CONVERSIONS_TO_COMPARE === 1);
  ok("the flat tenth survives only as a floor", noiseBand(10_000) === MIN_NOISE_BAND && noiseBand(10)! > MIN_NOISE_BAND);
  ok("the band a very busy account gets is the one the finding path always used",
    noiseBand(5_000) === 0.10);
  ok("the band refuses alongside the effect", noiseBand(0.5) === null);
  ok("the sentence names the count it was worked out from", noiseBandLine(10, noiseBand(10)!).includes("10.0 conversions"));
}

hr("4. A window nobody was looking at is not a quiet one");
{
  const ep = episodesFrom([ev("2026-08-10")])[0]!;
  const windows = outcomeWindows(ep, 14);
  const base = {
    episode: ep, horizonDays: 14, windows,
    before: { conversions: 40, costMicros: 4_000_000_000 },
    after: { conversions: 41, costMicros: 4_100_000_000 },
    otherChangesAfter: [], wholeAccount: false, ourFindingTitle: null, now: at("2026-09-20"),
  };
  const none = outcomeReading({ ...base, coveredFrom: null });
  ok("no capture at all reads as cant_tell", none.verdict === "cant_tell");
  ok("…and prints no percentage", !/%/.test(none.headline) && !/%/.test(none.basis.split(". ")[0]!));
  ok("…and says the feed has no history before its first run", /no history before/i.test(none.basis));
  ok("…and carries no figures it cannot stand behind",
    none.relativeChange === null && none.mde === null && none.shared === null);

  const late = outcomeReading({ ...base, coveredFrom: at("2026-08-05") });
  ok("capture that starts inside the stretch reads as cant_tell too", late.verdict === "cant_tell");
  ok("…and names the date it actually reaches back to", late.basis.includes("2026-08-05"));

  const covered = outcomeReading({ ...base, coveredFrom: at("2026-07-01") });
  ok("coverage reaching before the whole stretch lets a reading happen", covered.verdict !== "cant_tell");
}

hr("5. A move inside the noise band is not a result");
{
  const ep = episodesFrom([ev("2026-08-10")])[0]!;
  const windows = outcomeWindows(ep, 14);
  const base = {
    episode: ep, horizonDays: 14, windows, coveredFrom: at("2026-07-01"),
    otherChangesAfter: [], wholeAccount: false, ourFindingTitle: null, now: at("2026-09-20"),
  };
  const tiny = outcomeReading({
    ...base,
    before: { conversions: 12, costMicros: 3_000_000_000 },
    after: { conversions: 13, costMicros: 3_100_000_000 },
  });
  ok("one extra conversion on twelve is no clear move", tiny.verdict === "no_clear_move", tiny.headline);
  ok("…and the band is printed beside it", /smallest move/.test(tiny.basis));

  // THE CASE THIS WHOLE BAND EXISTS FOR. Twelve to fifteen conversions is a
  // 25% rise, which the flat tenth the finding path used to carry would have
  // called a result. It is three conversions.
  const noisy = outcomeReading({
    ...base,
    before: { conversions: 12, costMicros: 3_000_000_000 },
    after: { conversions: 15, costMicros: 3_100_000_000 },
  });
  ok("a quarter more conversions on twelve is still no clear move", noisy.verdict === "no_clear_move", noisy.headline);
  ok("SELF-TEST: a flat tenth would have called that a result", Math.abs((15 - 12) / 12) > MIN_NOISE_BAND);

  const real = outcomeReading({
    ...base,
    before: { conversions: 40, costMicros: 3_000_000_000 },
    after: { conversions: 90, costMicros: 3_200_000_000 },
  });
  ok("a move larger than the band is reported", real.verdict === "rose", real.headline);
  const down = outcomeReading({
    ...base,
    before: { conversions: 90, costMicros: 3_000_000_000 },
    after: { conversions: 30, costMicros: 2_000_000_000 },
  });
  ok("a fall is reported exactly as plainly as a rise", down.verdict === "fell");

  const thin = outcomeReading({
    ...base,
    before: { conversions: 0.4, costMicros: 900_000_000 },
    after: { conversions: 3, costMicros: 1_000_000_000 },
  });
  ok("under one conversion before, nothing is claimed", thin.verdict === "cant_tell");
  ok("…and no percentage is printed anywhere in it", !/%/.test(thin.headline) && !/%/.test(thin.basis));
  ok("SELF-TEST: the naive division would have printed one", ((3 - 0.4) / 0.4 * 100).toFixed(0) === "650");

  ok("spend is reported as measured rather than as an effect", /measured rather than compared/.test(real.basis));
}

hr("6. A shared window credits none of the changes in it");
{
  const ep = episodesFrom([ev("2026-08-10")])[0]!;
  const windows = outcomeWindows(ep, 14);
  const shared = outcomeReading({
    episode: ep, horizonDays: 14, windows, coveredFrom: at("2026-07-01"),
    before: { conversions: 40, costMicros: 3_000_000_000 },
    after: { conversions: 90, costMicros: 3_200_000_000 },
    otherChangesAfter: [
      { changedAt: at("2026-08-16"), actorKind: "person", actorInternal: false, actorEmail: null },
      { changedAt: at("2026-08-18"), actorKind: "api", actorInternal: true, actorEmail: null },
    ],
    wholeAccount: false, ourFindingTitle: null, now: at("2026-09-20"),
  });
  ok("the other changes are counted", shared.shared === true && shared.otherChangesAfter === 2);
  ok("…and the reading says it is not ours alone to claim", /not ours alone to claim/.test(shared.basis));
  ok("the verdict is NOT dropped and NOT adjusted", shared.verdict === "rose");
  const clean = outcomeReading({
    episode: ep, horizonDays: 14, windows, coveredFrom: at("2026-07-01"),
    before: { conversions: 40, costMicros: 3_000_000_000 },
    after: { conversions: 90, costMicros: 3_200_000_000 },
    otherChangesAfter: [], wholeAccount: false, ourFindingTitle: null, now: at("2026-09-20"),
  });
  ok("a clean window says so rather than saying nothing", clean.shared === false && /No other change was recorded/.test(clean.basis));
}

hr("7. Nobody is named, and nothing claims a cause");
{
  const CAUSAL = /\bcaused\b|\bbecause of\b|\bthanks to\b|\bdrove\b|\bresulted in\b|\bled to\b|\bdue to\b/i;
  const ep = episodesFrom([
    ev("2026-08-10", { actorKind: "person", actorInternal: false }),
    ev("2026-08-11", { actorKind: "api", actorInternal: true, resourceType: "CAMPAIGN" }),
  ])[0]!;
  const windows = outcomeWindows(ep, 14);
  const readings: OutcomeReading[] = [
    outcomeReading({ episode: ep, horizonDays: 14, windows, coveredFrom: null, before: null, after: null, otherChangesAfter: [], wholeAccount: false, ourFindingTitle: null, now: at("2026-09-20") }),
    outcomeReading({ episode: ep, horizonDays: 14, windows, coveredFrom: at("2026-07-01"), before: { conversions: 40, costMicros: 3e9 }, after: { conversions: 90, costMicros: 3e9 }, otherChangesAfter: [], wholeAccount: false, ourFindingTitle: null, now: at("2026-09-20") }),
    outcomeReading({ episode: ep, horizonDays: 28, windows, coveredFrom: at("2026-07-01"), before: { conversions: 0.2, costMicros: 1e8 }, after: { conversions: 1, costMicros: 1e8 }, otherChangesAfter: [], wholeAccount: true, ourFindingTitle: "Cut three dead search terms", now: at("2026-09-20") }),
  ];
  const all = readings.flatMap((r) => [r.what, r.headline, r.basis]);
  ok("no sentence claims a cause", !all.some((t) => CAUSAL.test(t.replace(OBSERVATIONAL_CAVEAT, ""))));
  ok("SELF-TEST: a planted causal sentence is caught", CAUSAL.test("Conversions rose because of the budget change."));
  ok("the caveat rides on every reading", readings.every((r) => r.basis.includes(OBSERVATIONAL_CAVEAT)));
  ok("no sentence carries an address", !all.some((t) => t.includes("@")));
  ok("no sentence names a person", !all.some((t) => /\bby [A-Z][a-z]+ [A-Z][a-z]+\b/.test(t)));
  ok("what changed says how many and how, never who",
    /made by hand|through an API|by hand and/.test(readings[1]!.what), readings[1]!.what);
  ok("our own applied change is named as ours rather than as somebody else's",
    /from a finding we applied here/.test(readings[2]!.what));
}

hr("8. The platform's own vocabulary is not shown to a person");
{
  const ep: ChangeEpisode = episodesFrom([ev("2026-08-10", { resourceType: "CAMPAIGN_BUDGET" })])[0]!;
  const what = episodeDescription(ep, null);
  ok("an enum name is read as words", what.includes("campaign budget") && !what.includes("CAMPAIGN_BUDGET"), what);
  ok("SELF-TEST: an undecoded integer would be visible rather than pretty",
    episodeDescription(episodesFrom([ev("2026-08-10", { resourceType: "6" })])[0]!, null).includes("6"));
}

hr("9. Nothing is measured before its window has finished");
{
  const ep = episodesFrom([ev("2026-09-10")])[0]!;
  ok("a 14-day horizon is not due on day nine", !episodeDue(ep, 14, at("2026-09-19")));
  ok("…and is due once the fortnight is up", episodeDue(ep, 14, at("2026-09-25")));
  ok("the 28-day one waits longer", !episodeDue(ep, 28, at("2026-09-25")) && episodeDue(ep, 28, at("2026-10-09")));
  ok("both horizons are kept", OUTCOME_HORIZONS.length === 2 && OUTCOME_HORIZONS.includes(28));
  const w = outcomeWindows(ep, 14);
  const days = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);
  ok("before and after are the same length", days(w.beforeStart, w.beforeEnd) === days(w.afterStart, w.afterEnd));
  ok("neither window overlaps the episode itself", w.beforeEnd < ep.start && w.afterStart > ep.end);
}

console.log(`\n${"─".repeat(72)}`);
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");
console.log(`${"─".repeat(72)}`);

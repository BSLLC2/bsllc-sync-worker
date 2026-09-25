#!/usr/bin/env tsx
/**
 * Guard for the per-channel half of the GA4 import.
 *
 * No database, no GA4 property, no network: it drives the real functions over
 * fixtures. EVERY FIGURE, PROPERTY ID AND CHANNEL COUNT BELOW IS INVENTED.
 * There is no production database in this sandbox and no GA4 access, so
 * nothing here was measured — the paid-social finding this work came from was
 * read off a live screen by a person and is not reproduced here.
 *
 * The refusals are the deliverable, and each one has a planted failure beside
 * it so the check is shown to bite rather than asserted to.
 *
 *   npx tsx src/verify-ga4-channels.ts
 */
import { channelRows, channelSince, periodFromYearMonth, DEFAULT_CHANNEL_MONTHS, MAX_CHANNELS, CHANNEL_LABEL_MAX } from "./ga4/channel-rows.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);

/** A GA4 runReport row for [yearMonth, sessionDefaultChannelGroup]. */
const row = (ym: string, channel: string, sessions: number, conversions: number, revenue: number) => ({
  dimensionValues: [{ value: ym }, { value: channel }],
  metricValues: [{ value: String(sessions) }, { value: String(conversions) }, { value: String(revenue) }],
});

const OPTS = { clientId: "fixture-client", propertyId: "111111111", convWindow: [4, 9], revWindow: [1200] };

console.log("GA4 per-channel import — verification harness");
console.log("Nothing is fetched or written. Every figure below is invented.");

// ── 1. A month key in either shape, and nothing else ────────────────────────
hr("1. The month is read, never guessed");
{
  ok("GA4's own YYYYMM becomes YYYY-MM", periodFromYearMonth("202609") === "2026-09");
  ok("an already-hyphenated key passes through", periodFromYearMonth("2026-09") === "2026-09");
  ok("a thirteenth month is refused", periodFromYearMonth("202613") === null);
  ok("a blank is refused", periodFromYearMonth("") === null);
  ok("(other) is refused", periodFromYearMonth("(other)") === null);
  // PLANTED: a permissive parser that accepted anything six characters long
  // would turn "(other)" into a month and file a whole bucket under it.
  ok("planted — a loose parser would have taken a non-numeric key",
    periodFromYearMonth("abc123") === null,
    "a bucket filed under an invented month reads as a real month for ever");
}

// ── 2. The label is stored verbatim ────────────────────────────────────────
hr("2. The channel is whatever the platform said");
{
  const out = channelRows({ rows: [
    row("202609", "Paid Social", 2641, 0, 0),
    row("202609", "Paid Search", 807, 9, 4200.5),
    row("202609", "Cross-network", 12, 1, 0),
    row("202609", "Some Grouping Nobody Here Has Heard Of", 3, 0, 0),
  ] }, OPTS);
  const labels = out.rows.map((r) => r.channel);
  ok("a familiar label is untouched", labels.includes("Paid Social") && labels.includes("Cross-network"));
  ok("a label this build has never seen is written under its own name",
    labels.includes("Some Grouping Nobody Here Has Heard Of"),
    "an unfamiliar label is data, and folding it into the one it resembles is the failure next door");
  ok("nothing is slugged, lower-cased or renamed",
    !labels.some((l) => /_/.test(l) || l === l.toLowerCase()));
  ok("revenue is cents, taken off the platform's own units",
    out.rows.find((r) => r.channel === "Paid Search")?.revenue_cents === 420050);
  ok("the counts are what was read", out.channels === 4 && out.months === 1);
}

// ── 3. A nought is only a nought when the property counts the thing ────────
hr("3. A null measure is unanswered, never a nought");
{
  const converting = channelRows({ rows: [
    row("202609", "Paid Social", 2641, 0, 0),
    row("202609", "Paid Search", 807, 9, 0),
  ] }, { ...OPTS, convWindow: [9], revWindow: [0] });
  const social = converting.rows.find((r) => r.channel === "Paid Social")!;
  ok("a channel that converted nothing on a property that DOES convert reads as a real nought",
    social.conversions === 0,
    "this is the whole finding: traffic arriving and producing nothing");
  ok("revenue on a property that has never reported any is unanswered",
    social.revenue_cents === null);

  const neverConverts = channelRows({ rows: [
    row("202609", "Paid Social", 2641, 0, 0),
    row("202609", "Organic Search", 5000, 0, 0),
  ] }, { ...OPTS, convWindow: [0, 0], revWindow: [0] });
  ok("on a property with no key event at all, every channel's conversions are unanswered",
    neverConverts.rows.every((r) => r.conversions === null),
    "otherwise the whole reading measures the absence of a key event");
  // PLANTED: writing 0 instead of null here is the defect. A channel with no
  // tracking on it would then be indistinguishable from one that converts
  // nobody, and the first ROI card built on it would name the wrong channel.
  ok("planted — a nought written here would be read as a measurement",
    !neverConverts.rows.some((r) => r.conversions === 0));

  ok("sessions are never withheld — a session count needs no key event",
    neverConverts.rows.every((r) => typeof r.sessions === "number"));
}

// ── 4. A label that cannot be stored is named, never trimmed ──────────────
hr("4. A row the app's table cannot key on is refused by name");
{
  const long = "x".repeat(CHANNEL_LABEL_MAX + 1);
  const out = channelRows({ rows: [
    row("202609", "Paid Search", 807, 9, 0),
    row("202609", "", 40, 0, 0),
    row("202609", long, 40, 0, 0),
  ] }, OPTS);
  ok("an empty label is not written", !out.rows.some((r) => r.channel === ""));
  ok("a label past the column's length is not written", !out.rows.some((r) => r.channel.length > CHANNEL_LABEL_MAX));
  ok("both are named in the run's output", out.refusedLabels.length === 2);
  // PLANTED: cutting the long label to fit would merge it with any other label
  // sharing its first 120 characters — the unique key ends in the channel, so
  // the merged figure would then read as a measurement of one of them.
  ok("planted — nothing is trimmed to fit",
    !out.rows.some((r) => r.channel === long.slice(0, CHANNEL_LABEL_MAX)));
  ok("the rows that are fine still land", out.rows.length === 1 && out.rows[0]!.channel === "Paid Search");
}

// ── 5. A property reporting something other than a channel grouping ───────
hr("5. Too many distinct labels and none of it is written");
{
  const many = Array.from({ length: MAX_CHANNELS + 1 }, (_, i) => row("202609", `Label ${i}`, 10, 0, 0));
  const out = channelRows({ rows: many }, OPTS);
  ok("nothing is written", out.rows.length === 0);
  ok("the run says why", Boolean(out.refused) && out.refused!.includes(String(MAX_CHANNELS)));
  const justUnder = channelRows({ rows: many.slice(0, MAX_CHANNELS) }, OPTS);
  ok("a property at the limit still imports", justUnder.rows.length === MAX_CHANNELS && justUnder.refused === null);
}

// ── 6. A malformed report costs the run nothing ───────────────────────────
hr("6. A report that is not what this code was told it is");
{
  ok("no rows at all is an empty outcome and no throw", channelRows({ rows: [] }, OPTS).rows.length === 0);
  ok("no body at all is an empty outcome and no throw", channelRows(undefined, OPTS).rows.length === 0);
  const dup = channelRows({ rows: [
    row("202609", "Paid Search", 807, 9, 0),
    row("202609", "Paid Search", 1, 1, 0),
  ] }, OPTS);
  ok("one (month, channel) pair produces one row", dup.rows.length === 1 && dup.droppedRows === 1);
  ok("the first one wins and is not overwritten", dup.rows[0]!.sessions === 807);
  const bad = channelRows({ rows: [row("(other)", "Paid Search", 5, 0, 0), row("202609", "Paid Search", 807, 9, 0)] }, OPTS);
  ok("a row with no usable month is counted and dropped", bad.rows.length === 1 && bad.droppedRows === 1);
}

// ── 7. The rows carry what the sync contract needs ────────────────────────
hr("7. Every row is addressed to a client, a source and a property");
{
  const out = channelRows({ rows: [row("202609", "Paid Search", 807, 9, 0)] }, OPTS);
  const r = out.rows[0]!;
  ok("the client the importer was iterating", r.client_id === "fixture-client");
  ok("the source is ga4", r.source === "ga4");
  ok("the property it was read from", r.external_id === "111111111");
  ok("the period is YYYY-MM", /^\d{4}-\d{2}$/.test(r.period));
}

// ── 8. Nothing is backfilled unless somebody asks for it ──────────────────
hr("8. The breakdown reads a bounded window, not the whole history");
{
  const now = new Date("2026-09-25T12:00:00Z");
  ok("the default reaches back two whole months plus this one",
    channelSince(DEFAULT_CHANNEL_MONTHS, "2023-01-01", now) === "2026-07-01",
    "two is the minimum that lets a closed month's restatement land; the third is slack for a run that was down");
  // PLANTED: inheriting the aggregate's own --since would write a client's
  // entire history the first time this shipped, which is a backfill nobody
  // decided on.
  ok("planted — the aggregate's 2023 start is NOT what the breakdown asks from",
    channelSince(DEFAULT_CHANNEL_MONTHS, "2023-01-01", now) !== "2023-01-01");
  ok("a widened window is how a backfill is performed",
    channelSince(14, "2023-01-01", now) === "2025-08-01");
  ok("it never reaches back past what the rest of the import reads",
    channelSince(36, "2026-01-01", now) === "2026-01-01",
    "months in one table with no counterpart in the other is a gap nobody can explain");
  ok("nought turns it off and asks for nothing", channelSince(0, "2023-01-01", now) === "");
  ok("a year boundary is crossed properly",
    channelSince(3, "2020-01-01", new Date("2026-01-15T00:00:00Z")) === "2025-11-01");
}

console.log(`\n${"─".repeat(72)}`);
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");
console.log(`${"─".repeat(72)}`);

#!/usr/bin/env tsx
/**
 * Proves the two rules that keep an ABSENCE and a REAL ZERO apart, without a
 * database, a network call or any client account.
 *
 *   1. metric-evidence.ts — a zero is only planted as a live zero where the
 *      property has demonstrably reported that metric. Otherwise it is
 *      no_data. Both directions matter: dropping a genuine zero from a
 *      properly configured account is the same bug in reverse.
 *
 *   2. sample-detect.ts — demo data is detected by HOW A ROW ARRIVED, not by
 *      its name. The word list is what failed in production, so the fixtures
 *      below deliberately carry ordinary names, ordinary contacts and
 *      ordinary emails: every one of them passes the catalogue check, and the
 *      shape rule has to catch them anyway.
 *
 * No real client, person, domain or figure appears here. Every name is made
 * up and every amount is invented.
 *
 *   npm run verify-zero-vs-nothing
 */
import { evidencedMetric, reportsMetric } from "./metric-evidence.js";
import { detectSampleRecords, matchesSampleName, mentionsSampleProduct, verdictFor, suspicionLine, BULK_BATCH_MIN, type CrmRecordShape } from "./sample-detect.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

console.log("Zero vs nothing — the rules that keep an absence and a real zero apart");
console.log("Pure. No network, no database, no client account is contacted.\n");

// ── 1. A zero needs evidence ────────────────────────────────────────────────
console.log("1. A zero is only a zero when the thing counting was switched on");
{
  // A property with a key event configured: it has fired, so a quiet month is
  // a REAL quiet month and must be recorded as one.
  const configured = [4, 11, 0, 7, 0];
  ok("a property that has reported key events keeps its zero months as live zeros", evidencedMetric(0, configured) === 0);
  ok("  …and its non-zero months are untouched", evidencedMetric(11, configured) === 11);

  // A property with no key event configured answers 0 forever. That is not a
  // performance figure, and planting it as one is the bug this rule exists for.
  const neverConfigured = [0, 0, 0, 0, 0, 0];
  ok("a property that has never reported one records no_data, not a live zero", evidencedMetric(0, neverConfigured) === null);
  ok("  …every month of it, not just the latest", neverConfigured.every((v) => evidencedMetric(v, neverConfigured) === null));

  // The correction path: the day the first event fires, the whole window is
  // re-read and every earlier month becomes a real zero with no backfill.
  const firstEventFires = [0, 0, 0, 0, 0, 1];
  ok("one event anywhere in the window turns every earlier zero back into a real zero", firstEventFires.slice(0, 5).every((v) => evidencedMetric(v, firstEventFires) === 0));

  ok("an empty window is not evidence of anything", reportsMetric([]) === false);
  ok("nulls and undefined are not evidence", reportsMetric([null, undefined, 0]) === false);
  ok("a negative or non-finite figure is not evidence", reportsMetric([-3, Number.NaN]) === false);
  // Conversions and revenue take the SAME route now. Revenue used to be
  // omitted entirely, which left no row at all and read as "never imported".
  ok("an unevidenced metric is nulled, never omitted (null → a no_data row, absent → no row)", evidencedMetric(0, [0]) === null);
}

// ── 2. The shape that defeated the word list ────────────────────────────────
console.log("\n2. Demo data is caught by how a row ARRIVED, not by what it is called");

// The catalogue still works on the records somebody remembered to name.
ok("the catalogue still catches an obviously-named demo record", matchesSampleName("Fabrikam Inc", null, "a@example.com"));
ok("  …and a manual test row", matchesSampleName("test lead 3"));

// The miss that mattered was not about WHO bought — the buyers were ordinary
// personal names — but about WHAT was sold: the CRM's stock product catalogue,
// in a business that sells nothing of the kind. Deal names below are shaped
// like the catalogue's, with invented buyers.
ok("a demo SKU in the deal name is caught, whoever the buyer is", matchesSampleName("30 Café A-100 Automatic; 3 Cafe Duo", "A. Buyer", "a.buyer@somewhere.test"));
ok("  …with or without the accent", matchesSampleName("25 Cafe A-100 Automatic") && matchesSampleName("25 Café A-100 Automatic"));
ok("  …and on a catalogue size nobody has listed yet", matchesSampleName("8 Café B-250 Compact"));
ok("an ordinary deal in the same org is untouched", !matchesSampleName("OE spec engine block, 7-cylinder", "R. Buyer"));

// A generic noun is NOT proof. A business that really does sell these would
// have its revenue deleted by a word list; it gets asked instead.
ok("a generic product noun is not a confirmed match", !matchesSampleName("2x commercial espresso machine"));
ok("  …it raises suspicion instead", mentionsSampleProduct("2x commercial espresso machine"));
{
  const v = detectSampleRecords([{ id: "generic-1", text: ["2x commercial espresso machine", "A. Buyer"] }]);
  ok("  …so the row is counted and flagged, never dropped", verdictFor(v, "generic-1").suspect && !verdictFor(v, "generic-1").confirmed);
}

// Now the shape that beat it: ordinary trade names, ordinary contacts,
// ordinary emails — nothing a word list could ever match — all written to the
// CRM inside one minute by one actor and backdated across four years.
const PLANTED_AT = "2024-02-06T09:14:31Z";
const PLANTER = "00000000-0000-4000-8000-00000000aaaa";
const planted: CrmRecordShape[] = [
  ["Riverside Plumbing Co", "M. Okafor", "m.okafor@riversideplumbing.test", "2020-03-11"],
  ["Halden Tool & Die", "J. Pereira", "jp@haldentool.test", "2020-11-02"],
  ["Cobalt Freight Ltd", "S. Whitfield", "s.whitfield@cobaltfreight.test", "2021-05-19"],
  ["Ashgrove Dental", "R. Nakamura", "rn@ashgrovedental.test", "2021-09-30"],
  ["Pinebrook Roofing", "T. Alvarez", "t.alvarez@pinebrookroofing.test", "2022-06-14"],
  ["Weston Glassworks", "D. Faruqi", "d.faruqi@westonglass.test", "2023-01-23"],
  ["Larkfield Cabinetry", "A. Bergstrom", "ab@larkfieldcab.test", "2023-08-08"],
].map(([name, person, email, businessDate], i) => ({
  id: `planted-${i}`,
  text: [name, person, email],
  writtenAt: PLANTED_AT,
  writtenBy: PLANTER,
  importSequenceNumber: 1,
  overriddenCreatedOn: `${businessDate}T00:00:00Z`,
  businessDate,
}));

ok(
  "not one of them contains a catalogue word in its name, its contact or its email",
  planted.every((r) => !matchesSampleName(...(r.text ?? []))),
  "this is exactly why the word list passed them through",
);

{
  const v = detectSampleRecords(planted);
  ok("every one of them is flagged by the shape rule", planted.every((r) => verdictFor(v, r.id).suspect));
  ok("  …as SUSPECTED, never as confirmed — nothing is silently subtracted", planted.every((r) => !verdictFor(v, r.id).confirmed));
  const reason = verdictFor(v, planted[0]!.id).reason ?? "";
  ok("  …and each carries a sentence naming what was actually seen", /same minute/.test(reason) && /bulk import/.test(reason));
  ok("  …that admits we cannot tell demo data from a migrated history", /nothing here can tell those apart/.test(reason));
}

// Same batch, stripped of the import stamps: the spread of business dates
// across one written minute is enough on its own.
{
  const unstamped = planted.map((r) => ({ ...r, importSequenceNumber: null, overriddenCreatedOn: null }));
  const v = detectSampleRecords(unstamped);
  ok("a backdated batch is caught with no import stamps at all", unstamped.every((r) => verdictFor(v, r.id).suspect));
}

// And one record at a time, when too few siblings came through the query.
{
  const lone = detectSampleRecords([{ ...planted[0]!, writtenAt: null }]);
  ok("an imported, backdated row is flagged even on its own", verdictFor(lone, planted[0]!.id).suspect);
}

// ── 3. Real business must not be flagged ────────────────────────────────────
console.log("\n3. A busy minute of genuine business is left alone");
{
  // A web form firing repeatedly, or an overnight integration: many rows in
  // one minute, all dated today. Written together is normal; written together
  // AND dated across years is not.
  const burst: CrmRecordShape[] = Array.from({ length: BULK_BATCH_MIN + 6 }, (_, i) => ({
    id: `burst-${i}`,
    text: [`Enquiry ${i}`, "web form"],
    writtenAt: "2026-04-02T18:22:07Z",
    writtenBy: "00000000-0000-4000-8000-00000000bbbb",
    importSequenceNumber: null,
    overriddenCreatedOn: null,
    businessDate: "2026-04-02",
  }));
  const v = detectSampleRecords(burst);
  ok("a same-minute burst of same-day records is not suspected", burst.every((r) => !verdictFor(v, r.id).suspect));

  // A handful of ordinary records typed in over a week.
  const typed: CrmRecordShape[] = ["2026-01-05", "2026-01-09", "2026-01-16", "2026-02-02"].map((d, i) => ({
    id: `typed-${i}`,
    text: [`Quote ${i}`],
    writtenAt: `${d}T10:0${i}:00Z`,
    writtenBy: "00000000-0000-4000-8000-00000000cccc",
    importSequenceNumber: null,
    overriddenCreatedOn: null,
    businessDate: d,
  }));
  const v2 = detectSampleRecords(typed);
  ok("records created one at a time are clean", typed.every((r) => !verdictFor(v2, r.id).suspect && !verdictFor(v2, r.id).confirmed));

  // A small batch under the threshold stays clean even when backdated: five
  // rows is a person tidying up, not a history being manufactured.
  const small = planted.slice(0, BULK_BATCH_MIN - 1).map((r) => ({ ...r, importSequenceNumber: null, overriddenCreatedOn: null }));
  const v3 = detectSampleRecords(small);
  ok(`fewer than ${BULK_BATCH_MIN} rows in a minute is not a batch`, small.every((r) => !verdictFor(v3, r.id).suspect));

  // A CRM that exposes none of this contributes nothing rather than guessing.
  const blind = detectSampleRecords([{ id: "blind-1", text: ["Ordinary Co", "someone@ordinary.test"] }]);
  ok("a CRM that exposes no arrival data produces no verdict at all", blind.size === 0);
}

// ── 4. What the run says out loud ───────────────────────────────────────────
console.log("\n4. Suspicion is stated, not swallowed");
{
  const line = suspicionLine(14, 125_000_00, 40) ?? "";
  ok("the run prints the count, the money and the share", /14 record/.test(line) && /\$125,000/.test(line) && /35%/.test(line));
  ok("  …and says the figure still counts them", /still counted/.test(line));
  ok("  …and says a person has to rule on it", /rules on them/.test(line));
  ok("nothing is printed when nothing is suspected", suspicionLine(0, 0, 40) === null);
}

console.log(`\n${"─".repeat(72)}`);
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
console.log("─".repeat(72));
process.exit(failures === 0 ? 0 : 1);

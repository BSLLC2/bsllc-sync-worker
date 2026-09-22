#!/usr/bin/env tsx
/**
 * Guard for the change-history capture and the shared-window reading.
 *
 * No database and no ad account: it drives the real functions over fixtures.
 * EVERY FIGURE AND EVERY ADDRESS HERE IS INVENTED — there is no production
 * database in this sandbox, and a real address must never be committed into a
 * fixture. The addresses use the reserved .invalid domain on purpose.
 *
 *   npx tsx src/verify-ads-change-history.ts
 */
import {
  captureWindows, changeGaql, normalizeChangeEvent, actorKind, isInternalAddress,
  CHANGE_LOOKBACK_DAYS, CHANGE_ROW_LIMIT,
} from "./ads/change-history.js";
import { changeWindowReading, OBSERVATIONAL_CAVEAT } from "./ads/change-window.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);

// A change_event row exactly as the REST transport delivers it: enums as
// integers, changed_fields as a paths object, resources as nested objects.
const rawEvent = (over: Record<string, unknown> = {}) => ({
  change_event: {
    resource_name: "customers/1111111111/changeEvents/1758240000000000~1~0",
    change_date_time: "2026-09-19 09:14:03",
    user_email: "someone@vendor.invalid",
    change_resource_type: 6,            // CAMPAIGN_BUDGET
    resource_change_operation: 3,       // UPDATE
    changed_fields: { paths: ["amount_micros"] },
    client_type: 2,                     // GOOGLE_ADS_WEB_CLIENT — a person
    campaign: "customers/1111111111/campaigns/222222",
    ad_group: null,
    old_resource: { campaignBudget: { amountMicros: "100000000" } },
    new_resource: { campaignBudget: { amountMicros: "150000000" } },
    ...over,
  },
});

hr("1. One API row, normalized");
{
  const e = normalizeChangeEvent(rawEvent())!;
  ok("the event is kept", Boolean(e));
  ok("the key is the platform's own resource name", e.keyFromPlatform && e.eventKey.includes("changeEvents"));
  ok("the enum integers are decoded", e.resourceType === "CAMPAIGN_BUDGET" && e.operation === "UPDATE", `${e.resourceType}/${e.operation}`);
  ok("a web-interface change reads as a person", e.actorKind === "person");
  ok("an address at a domain that is not ours reads as outside", e.actorInternal === false);
  ok("the campaign id is the tail of the resource name", e.campaignId === "222222");
  ok("an absent ad group stays null rather than becoming a nought", e.adGroupId === null);
  ok("the before and after of the changed field are kept", Boolean(e.oldResourceJson && e.newResourceJson));
}

hr("2. The key is the event's identity, never a row count");
{
  const a = normalizeChangeEvent(rawEvent())!;
  const b = normalizeChangeEvent(rawEvent())!;
  ok("the same event read twice keys the same", a.eventKey === b.eventKey);

  const noName = normalizeChangeEvent(rawEvent({ resource_name: "" }))!;
  const noNameAgain = normalizeChangeEvent(rawEvent({ resource_name: "" }))!;
  ok("with no resource name it falls back to a digest of the event's own fields", noName.eventKey.startsWith("digest:"));
  ok("and that digest is stable across runs", noName.eventKey === noNameAgain.eventKey);
  ok("the digest never carries an address", !noName.eventKey.includes("@"));

  const other = normalizeChangeEvent(rawEvent({ resource_name: "", change_date_time: "2026-09-19 09:14:04" }))!;
  ok("a genuinely different event keys differently", other.eventKey !== noName.eventKey);
}

hr("3. A null is unanswered");
{
  ok("an event with no timestamp is refused rather than stored undated", normalizeChangeEvent(rawEvent({ change_date_time: "" })) === null);
  const anon = normalizeChangeEvent(rawEvent({ user_email: "" }))!;
  ok("no address means nobody has said, never 'somebody outside'", anon.actorInternal === null);
  const unknownClient = normalizeChangeEvent(rawEvent({ client_type: 1 }))!;
  ok("an unknown client type reads as neither a person nor a machine", unknownClient.actorKind === "unknown");
  ok("an API change is told apart from a person", actorKind("GOOGLE_ADS_API") === "api" && actorKind("GOOGLE_ADS_WEB_CLIENT") === "person");
  ok("an address at our own domain reads as internal", isInternalAddress("someone@bsllc.biz") === true);
  ok("a subdomain of ours counts too", isInternalAddress("someone@mail.bsllc.biz") === true);
}

hr("4. The windows cover the cap and stay inside it");
{
  const now = new Date("2026-09-22T12:00:00.000Z");
  const w = captureWindows(now);
  const first = w[0]![0];
  const last = w[w.length - 1]![1];
  const spanDays = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000);
  ok("the windows span the lookback", spanDays >= CHANGE_LOOKBACK_DAYS - 3 && spanDays < CHANGE_LOOKBACK_DAYS, `${spanDays} days`);
  ok("nothing reaches beyond the platform's own cap", Date.parse(`${first}T00:00:00Z`) > now.getTime() - CHANGE_LOOKBACK_DAYS * 86_400_000);
  ok("the newest window ends today", last === now.toISOString().slice(0, 10), last);
  let contiguous = true;
  for (let i = 1; i < w.length; i += 1) {
    const gap = Date.parse(`${w[i]![0]}T00:00:00Z`) - Date.parse(`${w[i - 1]![1]}T00:00:00Z`);
    if (gap > 86_400_000) contiguous = false;
  }
  ok("the windows leave no gap between them", contiguous);
  const gaql = changeGaql(first, last);
  ok("the query is a SELECT and nothing else", /^\s*SELECT/.test(gaql) && !/INSERT|UPDATE|DELETE|MUTATE/i.test(gaql));
  ok("it carries a LIMIT, which the API requires", gaql.includes(`LIMIT ${CHANGE_ROW_LIMIT}`));
  ok("it asks for who and through what", gaql.includes("change_event.user_email") && gaql.includes("change_event.client_type"));
}

hr("5. Was the measurement window ours alone?");
{
  const windowStart = new Date("2026-09-08T00:00:00.000Z");
  const windowEnd = new Date("2026-09-21T23:59:59.000Z");
  const ev = (day: string, kind: string, internal: boolean | null, email: string | null) =>
    ({ changedAt: new Date(`${day}T10:00:00.000Z`), actorKind: kind, actorInternal: internal, actorEmail: email });

  const nothingCaptured = changeWindowReading({
    coveredFrom: null, windowStart, windowEnd, wholeAccount: false, events: [],
  });
  ok("no captured history is 'not known', never clean", nothingCaptured.contaminated === null);
  ok("…and the count is null rather than a nought", nothingCaptured.otherChanges === null);
  ok("…and it says so in words", /not known here/.test(nothingCaptured.note), nothingCaptured.note);

  const partial = changeWindowReading({
    coveredFrom: new Date("2026-09-15T00:00:00.000Z"), windowStart, windowEnd, wholeAccount: false, events: [],
  });
  ok("coverage starting inside the window is also 'not known'", partial.contaminated === null);
  ok("…and it names the date it starts", partial.note.includes("2026-09-15"));

  const clean = changeWindowReading({
    coveredFrom: new Date("2026-08-01T00:00:00.000Z"), windowStart, windowEnd, wholeAccount: false, events: [],
  });
  ok("a covered window with nothing in it reads as clean", clean.contaminated === false && clean.otherChanges === 0);

  const shared = changeWindowReading({
    coveredFrom: new Date("2026-08-01T00:00:00.000Z"), windowStart, windowEnd, wholeAccount: false,
    events: [
      ev("2026-09-12", "person", false, "someone@vendor.invalid"),
      ev("2026-09-14", "person", false, "someone@vendor.invalid"),
      ev("2026-10-01", "person", false, "someone@vendor.invalid"),  // outside the window
    ],
  });
  ok("changes inside the window are counted", shared.contaminated === true && shared.otherChanges === 2, String(shared.otherChanges));
  ok("a change outside the window is not", shared.otherChanges === 2);
  ok("who is recorded, for the record", shared.actors.length === 1);
  ok("the note names how many came from outside this company", /1 from outside|2 from outside/.test(shared.note), shared.note);

  const accountWide = changeWindowReading({
    coveredFrom: new Date("2026-08-01T00:00:00.000Z"), windowStart, windowEnd, wholeAccount: true, events: [],
  });
  ok("a whole-account measurement says so, because it widens what interferes", accountWide.note.includes("the account"));
}

hr("6. Nothing here claims a cause");
{
  const CAUSAL = /\bcaused\b|\bbecause of\b|\bthanks to\b|\bdrove\b|\bproduced\b|\bresulted in\b/i;
  const windowStart = new Date("2026-09-08T00:00:00.000Z");
  const windowEnd = new Date("2026-09-21T23:59:59.000Z");
  // The caveat is deliberately NOT in this list: it contains the word
  // "caused" in order to DENY causation, and it is checked on its own line
  // below for saying exactly that. Everything else has to be free of the word.
  const notes = [
    changeWindowReading({ coveredFrom: null, windowStart, windowEnd, wholeAccount: false, events: [] }).note,
    changeWindowReading({ coveredFrom: new Date("2026-08-01T00:00:00.000Z"), windowStart, windowEnd, wholeAccount: false, events: [] }).note,
    changeWindowReading({
      coveredFrom: new Date("2026-08-01T00:00:00.000Z"), windowStart, windowEnd, wholeAccount: false,
      events: [{ changedAt: new Date("2026-09-12T10:00:00.000Z"), actorKind: "person", actorInternal: false, actorEmail: null }],
    }).note,
  ];
  ok("no sentence claims a cause", !notes.some((n) => CAUSAL.test(n)));
  ok("the caveat says a pre/post reading observes rather than proves", /rather than what the change caused/.test(OBSERVATIONAL_CAVEAT));
  ok("SELF-TEST: a planted causal sentence is caught", CAUSAL.test("The budget rise caused conversions to climb."));
  ok("no note carries an address", !notes.some((n) => n.includes("@")));
  ok("SELF-TEST: a planted address in a note is caught", "changed by someone@vendor.invalid".includes("@"));
}

console.log(`\n${"─".repeat(72)}`);
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");
console.log(`${"─".repeat(72)}`);

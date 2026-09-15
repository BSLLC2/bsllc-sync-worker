#!/usr/bin/env tsx
/**
 * Proves the rule that keeps a repeat customer's old deals out of our numbers,
 * without a database, a network call or any client account.
 *
 * WHAT THIS EXISTS FOR. A CRM record with no lead source of its own is counted
 * as ours when it matches a web lead we captured — "where the CRM has no
 * source, the match IS the source". A record is matched through its parent
 * CONTACT on phone or email, and D365's `classify()` returns "unknown" for any
 * contact created before the first-touch field went live, so ONE tracked call
 * from a repeat customer used to attribute every deal ever filed against that
 * contact, including deals closed long before we were engaged. `webInquiryAt`
 * was on the row the whole time and compared to nothing.
 *
 * The comparison is our lead's SUBMITTED date against the record's OWN CREATED
 * date — not the contact's (too strict: a returning customer who enquires again
 * is demand we generated) and not the close date (too loose: a deal opened a
 * year before our lead and signed last week would sail through).
 *
 * Every fixture below is invented. No real client, person, number or amount.
 *
 *   npm run verify-attribution-dates
 */
import { readFileSync } from "node:fs";
import { isAttributed, leadPredatesRecord, EXCLUDED_INQUIRY_STATUSES, type Bucket } from "./attribution.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const row = (over: Partial<{ bucket: Bucket; isSample: boolean; webInquiryAt: string | null; recordCreatedOn: string | null }> = {}) => ({
  bucket: "unknown" as Bucket, isSample: false, webInquiryAt: null as string | null, recordCreatedOn: null as string | null, ...over,
});

console.log("Attribution dates — our lead has to come first");
console.log("Pure. No network, no database, no client account is contacted.\n");

console.log("1. An unsourced record is only ours when our lead predates it");
{
  ok(
    "a repeat customer's old deal is NOT ours because they called a tracked number this month",
    isAttributed(row({ webInquiryAt: "2026-09-10", recordCreatedOn: "2025-04-02" })) === false,
  );
  ok(
    "  …and the same record stays out however large it is (the value never enters the rule)",
    isAttributed(row({ webInquiryAt: "2026-09-10", recordCreatedOn: "2024-01-01" })) === false,
  );
  ok(
    "a record opened AFTER our lead is ours",
    isAttributed(row({ webInquiryAt: "2026-09-01", recordCreatedOn: "2026-09-05" })) === true,
  );
  ok(
    "  …and same-day counts (a CRM row is usually written from the enquiry within hours)",
    isAttributed(row({ webInquiryAt: "2026-09-05", recordCreatedOn: "2026-09-05" })) === true,
  );
  ok("a full timestamp on either side compares by day, not by string length", leadPredatesRecord("2026-09-05T23:10:00Z", "2026-09-05") === true);
}

console.log("\n2. A date we do not have is unknown, never a pass");
{
  ok("no lead date → not attributed", isAttributed(row({ webInquiryAt: null, recordCreatedOn: "2026-09-05" })) === false);
  ok("no record date → not attributed", isAttributed(row({ webInquiryAt: "2026-09-01", recordCreatedOn: null })) === false);
  ok("neither → not attributed", isAttributed(row()) === false);
  ok("an empty string is not a date", leadPredatesRecord("", "2026-09-05") === false);
}

console.log("\n3. The rest of the rule is unchanged");
{
  ok("the CRM's own source still wins, with no date at all", isAttributed(row({ bucket: "bsllc" })) === true);
  ok("  …and a confirmed sample never counts, whatever the source says", isAttributed(row({ bucket: "bsllc", isSample: true })) === false);
  ok("an explicit other/manual source is never overridden by a match", isAttributed(row({ bucket: "other", webInquiryAt: "2026-09-01", recordCreatedOn: "2026-09-05" })) === false);
  ok("  …nor by a well-ordered one", isAttributed(row({ bucket: "manual", webInquiryAt: "2026-09-01", recordCreatedOn: "2026-09-05" })) === false);
}

console.log("\n4. The promotion still COMPARES DATES (the check that must not rot)");
{
  // The hole was not a wrong comparison, it was no comparison. A future edit
  // that drops the date test would pass every behavioural assertion above only
  // by accident of the fixtures, so the source itself is checked too.
  const src = read("./attribution.ts");
  const fn = src.slice(src.indexOf("export function isAttributed"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  ok("isAttributed's unknown branch calls leadPredatesRecord", /bucket === "unknown"[\s\S]*leadPredatesRecord/.test(body));
  ok("leadPredatesRecord actually orders the two dates", /webInquiryAt[\s\S]*<=[\s\S]*recordCreatedOn/.test(src.slice(src.indexOf("export function leadPredatesRecord"), src.indexOf("export interface AttributionCandidate"))));
  // Both writers of the chain have to go through it.
  for (const f of ["./match-web-leads-to-crm.ts", "./import-hubspot-metrics.ts"]) {
    const s = read(f);
    ok(`${f.slice(2)} routes its verdict through isAttributed`, /isAttributed\(/.test(s));
  }
  const m = read("./match-web-leads-to-crm.ts");
  ok(
    "the D365 window floor treats a missing close date as OUTSIDE it",
    /!!r\.wonOn && r\.wonOn >= floor/.test(m) && !/!floor \|\| !r\.wonOn/.test(m),
    "a Closed Won with a null actualclosedate must not walk through the billable floor",
  );
}

console.log("\n5. Our own test calls are not leads, and not match candidates");
{
  ok('"internal_test" is excluded alongside "junk"', EXCLUDED_INQUIRY_STATUSES.has("internal_test") && EXCLUDED_INQUIRY_STATUSES.has("junk"));
  ok("  …and an ordinary status is not", !EXCLUDED_INQUIRY_STATUSES.has("new") && !EXCLUDED_INQUIRY_STATUSES.has("qualified"));
  const a = read("./attribution.ts");
  ok("loadWebInquiryIndex drops them before anything can match one", /EXCLUDED_INQUIRY_STATUSES\.has\(r\.status\)/.test(a));
}

console.log(`\n${"─".repeat(72)}`);
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
console.log("─".repeat(72));
process.exit(failures === 0 ? 0 : 1);

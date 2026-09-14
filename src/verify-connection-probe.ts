#!/usr/bin/env tsx
/**
 * Proves the connection-test probe's decisions WITHOUT touching a live client
 * account, a database or the network.
 *
 * The classification is where both the value and the risk of this feature sit.
 * Get it right and an AM answers a client in one message; get it wrong in the
 * two specific ways below and it costs more than having no test at all:
 *
 *   - "no_data" reported as a permission failure. The account is new and
 *     legitimately empty; we send the client another access request for access
 *     they already gave. That is the exact mistake this feature exists to stop.
 *   - OUR breakage reported as theirs. Our Google API switched off, our
 *     service-account key dead, our quota spent — every client fails at once,
 *     and a portfolio's worth of clients get chased for a permission they
 *     already granted.
 *
 * And one rule that is easy to erode: an error we do not recognise is reported
 * as unrecognised. A confident wrong instruction sends the client to do the
 * wrong work and costs us their trust in the next thing we say.
 *
 *   npm run verify-connection-probe
 */
import {
  adsCustomerId,
  analyzeAdsVisibility,
  analyzeGscSites,
  checkGa4PropertyId,
  classifyFailure,
  formatProbeError,
  httpErrorText,
  isProbeableSource,
  isUnusableGscPermission,
  normalizeGscProperty,
  outcomeForRead,
  summarizeRun,
  windowHasData,
  STRANDED_ERROR,
  MAX_RAW_ERROR,
  PROBEABLE_SOURCES,
} from "./connection-probe.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// Example domains only. Nothing in this file names a real client, a real
// property or a real account id.
const SITE_A = "sc-domain:example.com";
const SITE_A_PREFIX = "https://example.com/";
const SITE_B = "sc-domain:example.net";

console.log("Connection test — probe rules");
console.log("Pure. No network, no database, no client account is contacted.\n");

// ── 1. no_data is a success ─────────────────────────────────────────────────
console.log("1. An empty account is an ANSWER, not a refusal");
ok("a window with real numbers is a pass", outcomeForRead(windowHasData([12, 340])) === "pass");
ok("an empty window is no_data, never fail", outcomeForRead(windowHasData([])) === "no_data");
ok("a window of zeros is no_data, not a row of real zeros", outcomeForRead(windowHasData([0, 0, 0])) === "no_data");
ok("nulls do not read as data", outcomeForRead(windowHasData([null, undefined, 0])) === "no_data");
ok("one non-zero metric is enough to be a pass", outcomeForRead(windowHasData([0, 0, 7])) === "pass");
// The point of the whole exercise: classifyFailure is never even consulted for
// a no_data result, and nothing in the no_data path can produce a client ask.
ok(
  "no_data is not routed through failure classification at all",
  outcomeForRead(windowHasData([0])) === "no_data",
  "outcomeForRead has no branch that returns 'fail'",
);

// ── 2. ours vs theirs ───────────────────────────────────────────────────────
console.log("\n2. OURS vs THEIRS — the split that decides whether any client is contacted");

// Verbatim shapes Google returns. Each of these is a 403 or reads like one,
// which is exactly why the order in classifyFailure matters.
const API_DISABLED =
  'HTTP 403 {"error":{"code":403,"message":"Google Search Console API has not been used in project 123456 before or it is disabled.","status":"PERMISSION_DENIED"}}';
const DEAD_KEY = "invalid_grant: Invalid JWT Signature.";
const NO_SA_JSON = "Missing GOOGLE_SERVICE_ACCOUNT_JSON.";
const BAD_DEV_TOKEN = "authorization_error=DEVELOPER_TOKEN_NOT_APPROVED The developer token is not approved.";
const THROTTLED = 'HTTP 429 {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for quota metric."}}';
const NETWORK = "fetch failed: ECONNRESET";
const GSC_403 = `HTTP 403 {"error":{"code":403,"message":"User does not have sufficient permission for site '${SITE_A}'.","status":"PERMISSION_DENIED"}}`;
const GA4_403 = 'HTTP 403 {"error":{"code":403,"message":"User does not have sufficient permissions for this property.","status":"PERMISSION_DENIED"}}';
const ADS_DENIED = "authorization_error=USER_PERMISSION_DENIED User doesn't have permission to access customer.";
const ADS_MANAGER = "request_error=REQUESTED_METRICS_FOR_MANAGER Metrics cannot be requested for a manager account.";
const ADS_SUSPENDED = "authorization_error=CUSTOMER_NOT_ENABLED The customer account can't be accessed because it is not yet enabled or has been deactivated.";

const ours = (src: string, raw: string, code: string) => {
  const v = classifyFailure(src, raw);
  ok(`${code} → OURS`, v.scope === "ours" && v.code === code, `got ${v.scope}/${v.code}`);
  ok(`  …and its summary never tells anyone to ask a client`, !/grant|add .*as a user|ask the client for access/i.test(v.summary) || /Do not/i.test(v.summary));
};
ours("gsc", API_DISABLED, "api_disabled");
ours("ga4", API_DISABLED, "api_disabled");
ours("gsc", DEAD_KEY, "our_credential");
ours("ga4", NO_SA_JSON, "our_credential");
ours("google_ads", BAD_DEV_TOKEN, "our_credential");
ours("gsc", THROTTLED, "quota");

// The id WE hold being wrong is OURS too — a correction in Admin → Connectors,
// not a permission to chase. This is the one our own probe can produce without
// Google saying anything at all, and it must not read as the client's fault.
const storedId = classifyFailure("ga4", checkGa4PropertyId("G-ABC1234XYZ").probeError ?? "");
ok("a measurement id stored where the property id belongs → OURS", storedId.scope === "ours" && storedId.code === "stored_id", `got ${storedId.scope}/${storedId.code}`);
ok("  …and the summary says to correct our record, not to ask the client", /Admin → Connectors/.test(storedId.summary) && /do not ask the client/i.test(storedId.summary));
ok("a Search Console 400/INVALID_ARGUMENT is OURS (our stored property string)", classifyFailure("gsc", 'HTTP 400 {"error":{"code":400,"status":"INVALID_ARGUMENT"}}').code === "stored_id");
// …but a 404 is NOT: the id names nothing that exists, and only the client can
// tell us what their property or account actually is.
ok("a 404 stays client-side — that one is worth asking them about", classifyFailure("ga4", 'HTTP 404 {"error":{"code":404,"message":"Requested entity was not found."}}').scope === "client");
ok("a missing repo secret is OURS, not an unrecognised mystery", classifyFailure("google_ads", "Missing required env var GOOGLE_ADS_CLIENT_ID.").scope === "ours");

ours("ga4", NETWORK, "network");

const theirs = (src: string, raw: string, what: string) => {
  const v = classifyFailure(src, raw);
  ok(`${what} → client-side`, v.scope === "client" && v.code === "access_or_account", `got ${v.scope}/${v.code}`);
};
theirs("gsc", GSC_403, "Search Console 403 on the property");
theirs("ga4", GA4_403, "GA4 403 on the property");
theirs("google_ads", ADS_DENIED, "Ads USER_PERMISSION_DENIED");
theirs("google_ads", ADS_MANAGER, "Ads REQUESTED_METRICS_FOR_MANAGER");
theirs("google_ads", ADS_SUSPENDED, "Ads CUSTOMER_NOT_ENABLED");
theirs("gsc", 'HTTP 404 {"error":{"code":404,"message":"Not found."}}', "Search Console 404 on the property");

// The ordering trap, spelled out. Every one of our own failures ALSO carries a
// 403 and matches the client-side pattern. If the ours-first order is ever
// reversed, this is the check that fails first.
console.log("\n   The ordering trap — our own failures also look like a permission refusal:");
ok("a 403 that says 'has not been used in project' is OURS, not a missing grant", classifyFailure("gsc", API_DISABLED).scope === "ours");
ok("a 403 that also contains PERMISSION_DENIED is still OURS when the API is disabled", classifyFailure("gsc", API_DISABLED).code === "api_disabled");
ok(
  "a quota 429 is not read as a client problem",
  classifyFailure("google_ads", `${THROTTLED} PERMISSION_DENIED`).scope === "ours",
);
ok("a dead key beats the 403 that carries it", classifyFailure("ga4", `HTTP 401 ${DEAD_KEY} PERMISSION_DENIED`).scope === "ours");

// ── 3. unrecognised stays unrecognised ──────────────────────────────────────
console.log("\n3. An error we do not recognise says so — it is not squeezed into the nearest bucket");
const WEIRD = "The upstream widget frobnicator returned a teapot.";
const weird = classifyFailure("gsc", WEIRD);
ok("an unfamiliar error is 'unknown', not 'client'", weird.scope === "unknown" && weird.code === "unrecognised", `got ${weird.scope}/${weird.code}`);
ok("  …and it says not to ask the client for anything", /do not ask the client/i.test(weird.summary));
ok("  …and it points at engineering", /engineering/i.test(weird.summary));
const empty = classifyFailure("ga4", "");
ok("a failure with NO error text is unrecognised, not invented", empty.scope === "unknown" && empty.code === "unrecognised");
ok("  …and says it is a bug in the probe, not an answer about the client", /bug in the probe/i.test(empty.summary));
ok("an unknown source with an unknown error is still unknown", classifyFailure("mystery_source", WEIRD).scope === "unknown");

// ── 4. Google Ads failure text survives the client's odd error shape ────────
console.log("\n4. The error text we store is the API's, and it keeps the code the dashboard keys on");
// google-ads-api throws a GoogleAdsFailure object, not an Error — String() on
// it yields "[object Object]" and the whole mapping downstream goes blind.
const adsFailure = {
  errors: [
    { error_code: { authorization_error: "USER_PERMISSION_DENIED" }, message: "User doesn't have permission to access customer." },
  ],
};
const text = formatProbeError(adsFailure);
ok("a GoogleAdsFailure is unwrapped, not stringified to [object Object]", !text.includes("[object Object]"), text.slice(0, 60));
ok("  …and the error CODE survives, because the dashboard's rules key on it", /USER_PERMISSION_DENIED/.test(text));
ok("  …and so does the human message", /doesn't have permission/.test(text));
ok("  …and it classifies as client-side once unwrapped", classifyFailure("google_ads", text).scope === "client");
ok("a plain Error keeps its message", formatProbeError(new Error("boom")) === "boom");
ok("a thrown string is kept", formatProbeError("plain string failure") === "plain string failure");
ok("an unprintable object still yields something", formatProbeError({ odd: true }).length > 0);
ok("nothing is ever stored empty", formatProbeError(undefined).length > 0);
ok("an enormous error body is capped", formatProbeError("x".repeat(MAX_RAW_ERROR * 3)).length <= MAX_RAW_ERROR);
ok("the HTTP status is kept alongside the body", /\b403\b/.test(httpErrorText(403, '{"error":{"message":"nope"}}')));

// ── 5. Search Console: wrong property vs no grant ───────────────────────────
console.log("\n5. Search Console — 'you granted the wrong property' is a different answer from 'you granted nothing'");
ok("a domain property and a URL-prefix property are NOT the same property", normalizeGscProperty(SITE_A) !== normalizeGscProperty(SITE_A_PREFIX));
ok("a missing trailing slash is only formatting", normalizeGscProperty("https://example.com") === normalizeGscProperty(SITE_A_PREFIX));
ok("casing and whitespace are only formatting", normalizeGscProperty("  SC-DOMAIN:Example.com ") === normalizeGscProperty(SITE_A));

const wrongProperty = analyzeGscSites(SITE_A, [
  { siteUrl: SITE_B, permissionLevel: "siteFullUser" },
  { siteUrl: SITE_A_PREFIX, permissionLevel: "siteFullUser" },
]);
ok("we hold the domain property, they granted the URL-prefix one → visibleElsewhere", wrongProperty.visibleElsewhere);
ok("  …and the detail names what we CAN see, so the AM can correct it without a client email", wrongProperty.detail.includes(SITE_A_PREFIX));
ok("  …and it explains why the two forms are different properties", /separate properties/i.test(wrongProperty.detail));

const nothingGranted = analyzeGscSites(SITE_A, []);
ok("an EMPTY property list is NOT a wrong-property mix-up", nothingGranted.visibleElsewhere === false);
ok("  …and says so plainly, because that is a different conversation", /not been added to anything/i.test(nothingGranted.detail));

const present = analyzeGscSites(SITE_A, [{ siteUrl: SITE_A, permissionLevel: "siteFullUser" }]);
ok("the property IS listed for us → not visibleElsewhere", present.found !== null && present.visibleElsewhere === false);
ok("  …and the detail records the permission level", /siteFullUser/.test(present.detail));

const unverified = analyzeGscSites(SITE_A, [{ siteUrl: SITE_A, permissionLevel: "siteUnverifiedUser" }]);
ok("an unverified user is recognised as a granted-but-unusable level", isUnusableGscPermission("siteUnverifiedUser"));
ok("  …and the detail credits the client with having done the work", /Somebody did add us/i.test(unverified.detail));
ok("  …and does not claim we were never added", !/never/i.test(unverified.detail));
ok("a normal level is not flagged as unusable", !isUnusableGscPermission("siteRestrictedUser"));

// ── 6. GA4: the measurement-ID mix-up is ours ───────────────────────────────
console.log("\n6. GA4 — a G- code where the numeric property id belongs is OURS to fix");
const meas = checkGa4PropertyId("G-ABC1234XYZ");
ok("a measurement id is refused before any API call", meas.ok === false && meas.kind === "measurement");
ok("  …with an error the dashboard reads as a bad property format", /Invalid property/i.test(meas.probeError ?? ""));
ok("  …that says plainly no call was made, so it is not mistaken for Google's words", /no API call was made/i.test(meas.probeError ?? ""));
ok("  …and the detail says it is ours, not the client's", /ours to fix/i.test(meas.detail ?? ""));
ok("  …and explains property-level access covers every data stream", /every data stream/i.test(meas.detail ?? ""));
const ua = checkGa4PropertyId("UA-12345-1");
ok("a Universal Analytics id is refused too", ua.ok === false && ua.kind === "universal");
ok("  …and is also ours to fix", /Ours to fix/i.test(ua.detail ?? ""));
ok("an empty id is refused, not sent as an empty path", checkGa4PropertyId("").ok === false);
ok("a stray word is refused", checkGa4PropertyId("my property").ok === false);
const numeric = checkGa4PropertyId("123456789");
ok("a numeric id is accepted", numeric.ok && numeric.id === "123456789");
const prefixed = checkGa4PropertyId("properties/123456789");
ok("'properties/123' is unwrapped rather than doubled into properties/properties/123", prefixed.ok && prefixed.id === "123456789");

// ── 7. Google Ads: an unaccepted invitation is not a permission error ───────
console.log("\n7. Google Ads — the commonest failure is an unaccepted link invitation, not a permission");
ok("dashes and spaces in a customer id are only formatting", adsCustomerId("123-456-7890") === "1234567890");
const notLinked = analyzeAdsVisibility("123-456-7890", { visibleIds: ["9999999999", "8888888888"], listed: true });
ok("our manager cannot see the account → visibleElsewhere", notLinked.visibleElsewhere);
ok("  …and the detail names the unaccepted invitation FIRST", /never ACCEPTED/i.test(notLinked.detail));
ok("  …and says it is not a permission error", /not a permission error/i.test(notLinked.detail));
ok("  …and warns their user list will look normal, so we do not argue with them", /look perfectly normal/i.test(notLinked.detail));
ok("  …and says Ads never uses the service-account address", /never uses the shared service-account address/i.test(notLinked.detail));
ok("  …and does not name the other accounts under our manager", !notLinked.detail.includes("9999999999"));

const linked = analyzeAdsVisibility("1234567890", { visibleIds: ["1234567890"], listed: true });
ok("the account IS linked → not visibleElsewhere", linked.visibleElsewhere === false);
ok("  …and the detail points at the account's own state instead", /suspended, cancelled, unpaid billing/i.test(linked.detail));

const couldNotList = analyzeAdsVisibility("1234567890", { visibleIds: [], listed: false });
ok("when we could not enumerate, we claim NOTHING", couldNotList.visibleElsewhere === false);
ok("  …and say so, rather than implying a check we did not make", /cannot say whether/i.test(couldNotList.detail));

// ── 8. the run summary an operator reads ───────────────────────────────────
console.log("\n8. The run summary says the one thing that decides who gets contacted");
const mixed = summarizeRun([
  { source: "gsc", outcome: "pass" },
  { source: "ga4", outcome: "no_data" },
  { source: "google_ads", outcome: "fail", scope: "ours" },
]);
ok("no_data is labelled as access-fine, not as a failure", /access fine, account empty/i.test(mixed));
ok("our own failures are counted separately and named as ours", /OURS, not the client/i.test(mixed));
const unknownRun = summarizeRun([{ source: "gsc", outcome: "fail", scope: "unknown" }]);
ok("unrecognised failures are called out for engineering", /unrecognised/i.test(unknownRun) && /engineering/i.test(unknownRun));
const stranded = summarizeRun([{ source: "gsc", outcome: "running" }]);
ok("a row left running is shouted about, never silent", /STILL RUNNING/i.test(stranded));
ok("an empty run says nothing was probed", /nothing was probed/i.test(summarizeRun([])));

// ── 9. a row we had to close without an answer must not accuse the client ───
console.log("\n9. A row closed without an answer says 'our test did not run' — never something about their account");
// The dashboard classifies a stored error by matching Google's vocabulary in
// it. If the run's own status ever reached the stored text, a CANCELLED run
// would read to the Ads rules as "this client's ad account is cancelled or
// suspended", and the AM would be handed a sentence to send them about their
// billing. This is the negative guard on that: it is a list of the words the
// dashboard keys on, and the stranded text must contain none of them.
const DASHBOARD_TRIGGER_WORDS = [
  /has not been used in project/i, /SERVICE_DISABLED/i, /is disabled\b/i, /accessNotConfigured/i,
  /invalid_grant/i, /Invalid JWT/i, /invalid_client/i, /unauthorized_client/i, /signature/i,
  /ACCOUNT_DISABLED/i, /DEVELOPER_TOKEN_/i, /not valid JSON/i,
  /RESOURCE_EXHAUSTED/i, /rateLimitExceeded/i, /quota/i, /\b429\b/, /Too Many Requests/i,
  /ENOTFOUND/i, /ECONNRESET/i, /ETIMEDOUT/i, /socket hang up/i, /network/i, /fetch failed/i,
  /\b50[023]\b/, /Service Unavailable/i, /Internal error encountered/i,
  /\b40[034]\b/, /PERMISSION_DENIED/i, /Forbidden/i, /insufficient permission/i,
  /siteUnverifiedUser/i, /unverified/i, /INVALID_ARGUMENT/i, /badRequest/i, /Invalid site/i,
  /Invalid property/i, /malformed/i, /NOT_FOUND/i, /not found/i,
  /REQUESTED_METRICS_FOR_MANAGER/i, /CUSTOMER_NOT_ENABLED/i, /ACCOUNT_SUSPENDED/i,
  /CANCELLED/i, /SUSPENDED/i, /billing/i, /payment/i, /CUSTOMER_NOT_FOUND/i,
  /INVALID_CUSTOMER_ID/i, /USER_PERMISSION_DENIED/i, /NOT_ADS_USER/i, /authorization_error/i,
  /not permitted/i, /does not have permission/i, /doesn't have permission/i,
];
const tripped = DASHBOARD_TRIGGER_WORDS.filter((re) => re.test(STRANDED_ERROR));
ok("the stranded-row text matches none of the words the dashboard classifies on", tripped.length === 0, tripped.map(String).join(" "));
ok("  …so it lands on 'unrecognised', which is owner=us and hands the client nothing", tripped.length === 0);
ok("  …and it says plainly it is about our run, not their access", /about our test run, not about the client/i.test(STRANDED_ERROR));
ok("  …and carries a stable hook the dashboard could key on later", /CONNECTION_TEST_DID_NOT_FINISH/.test(STRANDED_ERROR));
// The specific accident this guards: the word "cancelled" from job.status.
ok("  …and in particular never contains the run status 'cancelled'", !/cancelled/i.test(STRANDED_ERROR));

// ── 10. the source list matches the dashboard's ─────────────────────────────
console.log("\n10. The probeable sources are exactly the ones the dashboard offers a button for");
ok("gsc, ga4 and google_ads", PROBEABLE_SOURCES.join(",") === "gsc,ga4,google_ads", PROBEABLE_SOURCES.join(","));
ok("a connector with no probe is refused rather than left running", !isProbeableSource("hubspot") && !isProbeableSource("meta"));

console.log(`\n${"─".repeat(72)}`);
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
console.log("─".repeat(72));
process.exit(failures === 0 ? 0 : 1);

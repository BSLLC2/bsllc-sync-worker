#!/usr/bin/env tsx
/**
 * Two small rules every scheduled reader leans on, checked with invented inputs
 * (no network, no database, no credential):
 *
 *   1. describeError turns anything thrown into one safe, readable line. It
 *      exists because the google-ads-api client throws plain objects, and a
 *      run printed `failed: [object Object]` for every account.
 *   2. client-scope decides which clients a per-client reader may read: a
 *      churned client never, a paused one still, a client we cannot find still.
 *
 *   npm run verify-error-and-scope
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, scrubSecrets } from "./describe-error.js";
import { isChurned, notChurnedSql, skippedLine, skippedNames, splitClients } from "./client-scope.js";
import { slugOfName } from "./client-scope-db.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const here = dirname(fileURLToPath(import.meta.url));

console.log("\n1. describeError");
const failure = {
  errors: [
    { error_code: { authorization_error: "USER_PERMISSION_DENIED" }, message: "User doesn't have permission to access customer." },
    { error_code: { request_error: 7 }, message: "Second problem." },
  ],
  request_id: "abc123XYZ",
};
const f = describeError(failure);
ok("a GoogleAdsFailure object names its code and message", /authorization_error=USER_PERMISSION_DENIED/.test(f) && /permission/.test(f), f);
ok("it carries Google's request id", /request abc123XYZ/.test(f));
ok("a second error is joined, not dropped", /Second problem/.test(f));
ok("an Error gives its message", describeError(new Error("boom")) === "boom");
ok("a string stays a string", describeError("plain words") === "plain words");
ok("null and undefined are named, never empty", describeError(null).length > 5 && describeError(undefined).length > 5);
const weird: unknown[] = [{}, [], { a: 1 }, { error: { nested: true } }, Symbol("s") as unknown, () => 1, 42, new Date(0), Object.create(null), { toString: () => "[object Object]" }];
ok("no input ever reads [object Object] or undefined", weird.every((w) => { const d = describeError(w); return d && !/\[object Object\]/.test(d) && d !== "undefined"; }),
  weird.map((w) => describeError(w)).join(" / ").slice(0, 120));
const circ: Record<string, unknown> = { a: 1 }; circ.self = circ;
ok("a circular object does not throw", describeError(circ).length > 0);
ok("an HTTP client error shows the answer's own message", /HTTP 403 PERMISSION_DENIED The caller does not have permission/.test(
  describeError({ message: "Request failed with status code 403", response: { status: 403, data: { error: { status: "PERMISSION_DENIED", message: "The caller does not have permission" } } } })));
ok("an HTML answer is named, not dumped", /HTML page/.test(describeError({ response: { status: 404, data: "<html><body>Not found</body></html>" } })));
ok("a Failure inside an HTTP answer's details is unwrapped", /authorization_error=X.*nope/.test(
  describeError({ response: { status: 400, data: { error: { details: [{ errors: [{ error_code: { authorization_error: "X" }, message: "nope" }] }] } } } })));
ok("a gRPC status gives its details", /code 7 denied/.test(describeError({ code: 7, details: "denied" })));
ok("an OAuth answer gives error and description", /invalid_grant: Token has been expired/.test(describeError({ error: "invalid_grant", error_description: "Token has been expired or revoked." })));
ok("one line", !/\n/.test(describeError(new Error("a\n  b\r\n c"))));
ok("cut to the length asked for, with a mark", describeError("x".repeat(900), 100).length === 100 && describeError("x".repeat(900), 100).endsWith("…"));
ok("a cause is shown when the message alone is thin", /fetch failed: ECONNRESET/.test(describeError(Object.assign(new Error("fetch failed"), { cause: new Error("ECONNRESET") }))));

console.log("\n2. secrets and addresses are scrubbed");
const secrets = [
  "Authorization: Bearer ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "refresh failed for 1//0gAbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  "GET https://x.example/api?apikey=SuperSecretKey12345&q=1",
  '{"access_token":"abcd1234efgh5678"}',
  "developer_token=DEVTOKEN123456",
  "client_secret: GOCSPX-abcdefghijklmnop",
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
  "key 0123456789abcdef0123456789abcdef0123 leaked",
];
ok("every secret shape is removed", secrets.every((s) => !/ya29|0gAbCd|SuperSecretKey|abcd1234efgh|DEVTOKEN123456|GOCSPX|MIIEvQ|0123456789abcdef0123456789abcdef/.test(describeError(new Error(s)))),
  secrets.map((s) => describeError(s)).join(" | ").slice(0, 160));
ok("an ordinary email is removed", describeError("sent to alex.rivera@example.com failed") === "sent to [email] failed");
ok("a service account address is kept (the fix names it)", /reader@proj-1\.iam\.gserviceaccount\.com/.test(describeError("add reader@proj-1.iam.gserviceaccount.com as a Viewer")));
ok("an ordinary long word is not cut", describeError("internationalization") === "internationalization");
ok("scrubSecrets leaves a plain sentence alone", scrubSecrets("GA4 403 for property 123456 in the dashboard") === "GA4 403 for property 123456 in the dashboard");
ok("a request id stays readable", /request abc123XYZ/.test(describeError(failure)));

console.log("\n3. client-scope");
const rows = [
  { id: "a", status: "active", internal: false }, { id: "b", status: "churned", internal: false }, { id: "c", status: "paused", internal: false },
  { id: "d", status: null, internal: false }, { id: "e", status: "Churned ", internal: false }, { id: "f", status: "launch", internal: true },
];
const s1 = splitClients(rows, (r) => ({ status: r.status, isInternal: r.internal }));
ok("churned is left out, whatever its spelling", s1.churned.map((r) => r.id).join() === "b,e" && !s1.live.some((r) => isChurned(r.status)));
ok("paused is still read", s1.live.some((r) => r.id === "c"));
ok("a client with no status is read, never read as churned", s1.live.some((r) => r.id === "d"));
ok("the internal client is read unless the reader asks to skip it", s1.live.some((r) => r.id === "f") && s1.internal.length === 0);
const s2 = splitClients(rows, (r) => ({ status: r.status, isInternal: r.internal }), { skipInternal: true });
ok("skipInternal leaves it out and counts it", s2.internal.map((r) => r.id).join() === "f" && !s2.live.some((r) => r.id === "f"));
ok("every row lands in exactly one list", s2.live.length + s2.churned.length + s2.internal.length === rows.length);
ok("the output line names the count", skippedLine(s1) === "2 churned skipped" && skippedLine(s2) === "2 churned skipped, 1 internal skipped");
ok("zero is said, not omitted", skippedLine(splitClients([{ s: "active" }], (r) => ({ status: r.s }))) === "0 churned skipped");
ok("names are capped, the count is not", skippedNames(["a", "b", "c", "d", "e", "f", "g"]) === "a, b, c, d, e and 2 more");
ok("the SQL fragment treats a null status as not churned", notChurnedSql("cl") === "COALESCE(cl.status, '') <> 'churned'");
ok("the slug rule matches the app's", slugOfName("Franklin Brazing") === "franklin-brazing" && slugOfName("Diesel Power Group") === "diesel-power-group");

console.log("\n4. the readers use them");
const src = (p: string) => readFileSync(join(here, p), "utf8");
const SCOPED = [
  "import-ga4.ts", "import-gsc-api.ts", "import-aeo.ts", "import-seo.ts", "import-domain-authority.ts", "import-meta.ts",
  "import-hubspot-metrics.ts", "import-webops.ts", "targets.ts", "import-tracker.ts", "import-dpg-tracker.ts",
  "read-wp-changes.ts", "read-bing.ts", "read-page-months.ts", "read-serp-pages.ts", "read-query-months.ts", "read-pages.ts",
  "read-gbp.ts", "read-url-inspection.ts", "read-ga4-report.ts", "read-ctm.ts", "read-clarity.ts", "read-page-behaviour.ts",
];
for (const file of SCOPED) {
  const t = src(file).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  ok(`${file} decides through the one rule`, /client-scope/.test(t) || /status <> 'churned'|COALESCE\(\w*\.?status, ''\) <> 'churned'/.test(t));
  ok(`${file} says how many churned it skipped`, /skippedLine\(|logChurnedSkipped\(|churned skipped/.test(t));
}
ok("the Meta importer's header no longer says churned clients are read", !/NOT filtered by client status/.test(src("import-meta.ts")));

console.log("\n5. nothing in a scheduled reader prints an error as [object Object]");
const SKIP = /^(verify-|debug-|oneoff-|dump-|diag|audit-och|check-|och-revenue|fake-|integrus|hightec|brownell|describe-error)/;
const bad: string[] = [];
const walk = (dir: string, prefix = "") => {
  for (const ent of readdirSync(join(here, dir), { withFileTypes: true })) {
    const rel = join(dir, ent.name);
    if (ent.isDirectory()) { walk(rel, prefix + ent.name + "/"); continue; }
    if (!ent.name.endsWith(".ts") || SKIP.test(ent.name)) continue;
    const t = src(rel);
    if (/\b(\w+) instanceof Error \? \1\.message : String\(\1\)/.test(t)) bad.push(rel);
  }
};
walk(".");
ok("no source file keeps the form that loses a thrown object", bad.length === 0, bad.join(", "));
for (const file of ["ads-google-recs.ts", "ads-daily-metrics.ts", "ads-keyword-metrics.ts", "ads-structure-snapshot.ts", "ads-change-history.ts", "ads-search-term-days.ts"]) {
  ok(`${file} describes its failures`, /describeError\(/.test(src(file)));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);

/** No network to Google: a pretend Data Manager on this machine. */
import http from "node:http";
import assert from "node:assert/strict";
import { buildIngestBody, chunk, interpret, eventTimestamp, validationAllows, actionFault, getAccessToken, ingest, requestStatus, scrub } from "./ads/data-manager.js";

let n = 0; const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const dest = { accountId: "835-068-9003", loginAccountId: "214-171-2409", actionId: "7717525647" };
const row = { gclid: "Cj0KCQ_TESTCLICK_abcdefghijklmnop", closed: "2026-10-05", valueDollars: 8000, transactionId: "och-x-2026-10-05" };

const b = buildIngestBody(dest, [row], true) as any;
ok(b.validateOnly === true, "validate-only is set");
ok(buildIngestBody(dest, [row], false) && (buildIngestBody(dest, [row], false) as any).validateOnly === false, "send sets it false");
ok(b.destinations[0].operatingAccount.accountId === "8350689003", "account digits only");
ok(b.destinations[0].loginAccount.accountId === "2141712409", "login account");
ok(b.destinations[0].productDestinationId === "7717525647", "action id");
ok(b.events[0].adIdentifiers.gclid === row.gclid && b.events[0].eventSource === "OTHER", "gclid and source");
ok(b.events[0].eventTimestamp === "2026-10-05T23:59:59-04:00", "Eastern daylight offset");
ok(eventTimestamp("2026-12-05") === "2026-12-05T23:59:59-05:00", "Eastern standard offset");
const flat = JSON.stringify(b);
ok(!/email|phone|name|dob|birth/i.test(flat.replace(/transactionId/, "")), "no personal field in the body");
ok(!("conversionValue" in (buildIngestBody(dest, [{ ...row, valueDollars: null }], true) as any).events[0]), "no value when none");
ok(chunk(Array.from({ length: 4500 }, (_, i) => i)).length === 3, "chunks of 2000");
ok(interpret(200, { requestId: "r1" }).ok, "2xx ok");
ok(!interpret(403, { error: { status: "PERMISSION_DENIED", message: "no scope" } }).ok && interpret(403, { error: { message: "x" } }).scopeProblem, "403 is a scope problem");
ok(!scrub("clickid_" + "A".repeat(40) + " a@b.co").includes("AAAA") && !scrub("a@b.co").includes("@"), "scrub");
const now = new Date("2026-11-17T12:00:00Z");
ok(!validationAllows(null, now) && validationAllows("2026-11-10T00:00:00Z", now) && !validationAllows("2026-10-01T00:00:00Z", now) && !validationAllows("2027-01-01T00:00:00Z", now), "validation freshness");
ok(actionFault({ type: 7, status: 2, primary_for_goal: false }, "A") === null, "secondary upload action allowed");
ok(!!actionFault({ type: 7, status: 2, primary_for_goal: true }, "A"), "primary refused");
ok(!!actionFault({ type: 7, status: 2 }, "A"), "unknown primary refused");
ok(!!actionFault(null, "A") && !!actionFault({ type: 3, status: 2, primary_for_goal: false }, "A") && !!actionFault({ type: 7, status: 3, primary_for_goal: false }, "A"), "missing, wrong type, paused refused");

const seen: any[] = [];
const srv = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") return res.end(JSON.stringify({ access_token: "tok" }));
    if (req.url?.startsWith("/v1/events:ingest")) return res.end(JSON.stringify({ requestId: "req-1" }));
    if (req.url?.startsWith("/v1/requestStatus")) return res.end(JSON.stringify({ requestStatusPerDestination: [{ eventsIngestionStatus: { recordCount: "1", failureRecordCount: "0" } }] }));
    res.statusCode = 404; res.end("{}");
  });
});
await new Promise<void>((r) => srv.listen(0, r));
process.env.DATA_MANAGER_FAKE_BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
const tok = await getAccessToken({ DATA_MANAGER_REFRESH_TOKEN: "rt", GOOGLE_ADS_CLIENT_ID: "i", GOOGLE_ADS_CLIENT_SECRET: "s" });
ok(tok === "tok", "refresh-token exchange");
const a = await ingest(tok, b);
ok(a.ok && a.requestId === "req-1", "ingest answered");
ok(seen.some((x) => x.url === "/v1/events:ingest" && x.auth === "Bearer tok" && JSON.parse(x.body).validateOnly === true), "request carried the token and validate flag");
const st = await requestStatus(tok, "req-1");
ok(st?.received === 1 && st?.failed === 0, "status counts");
let threw = false; try { await getAccessToken({}); } catch { threw = true; }
ok(threw, "no credential throws");
srv.close();
console.log(`verify-data-manager: ${n} checks passed`);

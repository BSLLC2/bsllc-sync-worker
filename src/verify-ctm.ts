#!/usr/bin/env tsx
/**
 * Guard for the CallTrackingMetrics reader: what it asks CTM, what it keeps, and the
 * list of things it can never keep.
 *
 * No CTM, no database, no key. A pretend CTM (a real HTTP server on a local port)
 * answers the real request builders, the real parser and the real orchestration through
 * the real fetch, and a recording client stands in for Postgres.
 *
 * EVERY ACCOUNT, CALLER, NUMBER, CALL AND KEY BELOW IS INVENTED. The phone numbers are
 * the reserved fictional 555-01xx range.
 *
 * WHAT THIS CANNOT PROVE. No CallTrackingMetrics keys exist to this build, so nothing
 * here has run against CTM. The address, Basic authentication, the date and paging
 * parameters and every field name are written from CTM's API reference as I know it,
 * and the field names also include probable headings of its call-log CSV export; all of
 * it is declared in src/ctm/types.ts with `verified: false`. A green run means the code
 * does what it says against the shapes it expects, not that CTM answers in them.
 *
 *   npx tsx src/verify-ctm.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { startFake, type Call } from "./signals/fake-http.js";
import { HttpError, realFetch, safeMessage } from "./page-behaviour/http.js";
import { basicAuth, callsUrl, isKeyRefusal, parseCallsPage } from "./ctm/api.js";
import { buildCall, type BuildResult, callerHashOf, calledAtOf, cleanText, normalizeDirection, normalizeStatus, pick, seconds } from "./ctm/map.js";
import { readCtmClient, type CtmCtx, type CtmDeps } from "./ctm/run.js";
import { BATCH, PRUNE_CTM_CALLS, UPSERT_CTM_CALLS, writeCalls } from "./ctm/store.js";
import { CTM_FIELDS, CTM_MAX_PAGES, CTM_PER_PAGE, CTM_ROW_KEYS, CTM_WINDOW_DAYS } from "./ctm/types.js";
import { SECRET_NAMES, ctmAccountKeys, ctmHashKey } from "./signals/secrets.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const rowOf = (r: BuildResult): Record<string, unknown> => { if (!("row" in r)) throw new Error(`no row: ${r.skip}`); return r.row as unknown as Record<string, unknown>; };
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);
function selfTest(label: string, test: (text: string) => boolean, good: string, bad: string) {
  ok(`${label} (self-test: passes a good sample)`, test(good) === true);
  ok(`${label} (self-test: fails a planted bad sample)`, test(bad) === false);
}

const ACCESS = "access-key-abc-123", SECRET = "secret-key-xyz-789", HASHKEY = "a-long-random-hash-key-value-0123456789";
const NOW = new Date("2026-10-15T11:05:00Z");
const KEYS = new Map([["hillside-roofing", { accessKey: ACCESS, secretKey: SECRET, accountId: "1234567" }]]);

/** A JSON-shaped call as CTM's API probably answers it, with everything that must never be kept. */
const JSON_CALL = {
  id: 9001, sid: "CA1", called_at: "2026-10-14 12:30:45 -0400", tracking_source: "Google Ads", tracking_label: "Main line 513-555-0142",
  call_status: "answered", talk_time: 143, ring_time: "00:07", duration: "2:30", direction: "inbound", city: "Cincinnati", state: "OH",
  gclid: "Cj0KCQjwexample123456", utm_source: "google", utm_medium: "cpc", utm_campaign: "Roof Repair - Cincinnati", device: "Mobile",
  tag_list: ["Google Ads Conversion: Leads", "voicemail", "Repeat"], caller_number: "+1 (513) 555-0188",
  // everything below must never reach a stored row
  name: "JANE SMITH", cnam: "SMITH JANE", audio: "https://audio.example/rec/9001.mp3", recording_url: "https://x.example/r.mp3", transcription: "hello I have a leak", transcript: "t",
  summary: "caller wants a quote", notes: "call back after 5", message: "please call", visitor_ip: "203.0.113.9", ip: "203.0.113.9", keyword_spotting: ["quote"],
};
/** The same call as a row of CTM's call-log CSV export, headings as I believe the export names them. */
const CSV_CALL = {
  "Call ID": "9002", "Date/Time": "2026-10-14T16:31:00Z", "Source": "GMB North", "Tracking Label": "North", "Call Status": "No Answer", "Talk Time": "0", "Ring Time": "20", "Duration": "20",
  "Direction": "Inbound", "City": "Dayton", "State": "OH", "Tags": "Repeat, other", "Caller Number": "5135550142", "Caller": "(513) 555-0142",
};

type Rec = { sql: string; params: unknown[] };
const recorder = () => { const calls: Rec[] = []; return { calls, query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params: params ?? [] }); return {}; } }; };

async function main() {
  /* ───────────────────────── 1. one record to one row ───────────────────────── */
  hr("1. a call becomes the allowlisted row and nothing else");
  const r1 = buildCall(JSON_CALL, HASHKEY);
  ok("a JSON call is read", "row" in r1);
  const row = rowOf(r1);
  ok("the row has exactly the declared keys and no others", JSON.stringify(Object.keys(row).sort()) === JSON.stringify([...CTM_ROW_KEYS].sort()), Object.keys(row).join());
  const blob = JSON.stringify(row);
  for (const [label, needle] of [["the caller's number", /5135550188|513-555-0188|\(513\)/], ["the label's phone number", /555-0142|5135550142/], ["the caller-ID text or name", /JANE|SMITH/i], ["a recording link", /audio\.example|r\.mp3|\.mp3/], ["the transcript", /leak|hello/i], ["the summary", /wants a quote/], ["the notes", /call back/], ["the message", /please call/], ["the visitor IP", /203\.0\.113/], ["a tag's text other than the two flags", /voicemail/]] as const) {
    ok(`${label} is not in the stored row`, !needle.test(blob));
  }
  ok("a phone number typed into a label is replaced, not stored", row.trackingLabel === "Main line [number]");
  ok("time with an offset becomes the right instant", row.calledAt === "2026-10-14T16:30:45.000Z");
  ok("seconds read from a number, mm:ss and a string; talk 143, ring 7, duration 150", row.talkSeconds === 143 && row.ringSeconds === 7 && row.durationSeconds === 150);
  ok("status, direction, source and location are kept", row.status === "answered" && row.direction === "inbound" && row.trackingSource === "Google Ads" && row.city === "Cincinnati" && row.state === "OH");
  ok("the two tags are yes or no and nothing else", row.tagsGoogleAdsConversion === true && row.tagsRepeat === true);
  ok("the click id and campaign values are kept", row.gclid === "Cj0KCQjwexample123456" && row.utmCampaign === "Roof Repair - Cincinnati" && row.utmSource === "google" && row.utmMedium === "cpc" && row.device === "Mobile");

  hr("2. the caller is a salted hash, stable, and never the number");
  const h = row.callerHash as string;
  ok("a 64-character hex hash", /^[0-9a-f]{64}$/.test(h));
  ok("the same number written four ways is one hash", new Set([callerHashOf("+1 (513) 555-0188", HASHKEY), callerHashOf("5135550188", HASHKEY), callerHashOf("1-513-555-0188", HASHKEY), callerHashOf("513.555.0188", HASHKEY)]).size === 1);
  ok("a different number is a different hash", callerHashOf("5135550189", HASHKEY) !== h);
  ok("a different key is a different hash (the salt is the key)", callerHashOf("5135550188", `${HASHKEY}-other`) !== h);
  ok("the hash does not contain the digits", !h.includes("5135550188"));
  ok("no usable number is no hash, not a hash of nothing", callerHashOf("", HASHKEY) === null && callerHashOf("abc", HASHKEY) === null && callerHashOf("12345", HASHKEY) === null && callerHashOf(null, HASHKEY) === null);
  ok("the key is the last ten digits: nine digits is no number, and a country code in front does not change the hash", callerHashOf("513555018", HASHKEY) === null && callerHashOf("+44 5135550188", HASHKEY) === callerHashOf("5135550188", HASHKEY));
  ok("the key is read only if long enough: under 24 characters is not a key", ctmHashKey({ CTM_CALLER_HASH_KEY: "short" }) === null && ctmHashKey({ CTM_CALLER_HASH_KEY: HASHKEY }) === HASHKEY && ctmHashKey({}) === null);

  hr("3. the export's headings and a different casing are read through the declared names");
  const r2 = buildCall(CSV_CALL, HASHKEY);
  const row2 = rowOf(r2);
  ok("a CSV-shaped record is read", "row" in r2 && row2.ctmCallId === "9002" && row2.trackingSource === "GMB North" && row2.status === "no_answer" && row2.direction === "inbound");
  ok("'Caller' (a name) is NOT read as the number: only the declared number headings are", row2.callerHash === callerHashOf("5135550142", HASHKEY));
  ok("a Tags column as comma text sets the repeat flag", row2.tagsRepeat === true && row2.tagsGoogleAdsConversion === false);
  ok("every field alias is declared unverified until a real answer has been seen", Object.values(CTM_FIELDS).every((f) => f.verified === false));
  ok("a key is matched with case, spaces and punctuation ignored", pick({ "TALK_time": 5 }, CTM_FIELDS.talk) === 5 && pick({ "Talk Time": 6 }, CTM_FIELDS.talk) === 6 && pick({}, CTM_FIELDS.talk) === null);

  hr("4. a gap is never a nought, and a guess is never made");
  ok("no id is a skip", "skip" in buildCall({ called_at: "2026-10-14T10:00:00Z" }, HASHKEY) && (buildCall({ called_at: "2026-10-14T10:00:00Z" }, HASHKEY) as { skip: string }).skip === "no_id");
  ok("a time with no zone is refused, not read as any zone", calledAtOf({ called_at: "2026-10-14 12:30:45" }) === null && calledAtOf({ called_at: "10/14/2026 12:30 PM" }) === null && (buildCall({ id: "1", called_at: "2026-10-14 12:30:45" }, HASHKEY) as { skip: string }).skip === "no_time");
  ok("a Z time, an offset time and a unix time are read", calledAtOf({ called_at: "2026-10-14T10:00:00Z" }) === "2026-10-14T10:00:00.000Z" && calledAtOf({ called_at: "2026-10-14 06:00:00 -0400" }) === "2026-10-14T10:00:00.000Z" && calledAtOf({ unix_time: 1791972000 }) === "2026-10-14T10:00:00.000Z");
  const bare = rowOf(buildCall({ id: 5, called_at: "2026-10-14T10:00:00Z" }, HASHKEY));
  ok("fields CTM did not send are null: a missing talk time is not 0, a missing tags field is not 'no'", bare.talkSeconds === null && bare.ringSeconds === null && bare.status === null && bare.tagsRepeat === null && bare.tagsGoogleAdsConversion === null && bare.callerHash === null && bare.direction === null);
  ok("a talk time of 0 sent by CTM is stored as 0", (buildCall({ id: 6, called_at: "2026-10-14T10:00:00Z", talk_time: 0 }, HASHKEY) as { row: { talkSeconds: number } }).row.talkSeconds === 0);
  ok("an unrecognised status is null, not guessed", normalizeStatus("transferred-to-sales") === null && normalizeStatus("") === null && normalizeStatus(5) === null);
  ok("status words are normalised", normalizeStatus("Answered") === "answered" && normalizeStatus("Hang up") === "hangup" && normalizeStatus("hung-up") === "hangup" && normalizeStatus("No Answer") === "no_answer" && normalizeStatus("busy") === "no_answer");
  ok("direction words are normalised", normalizeDirection("Inbound") === "inbound" && normalizeDirection("outbound call") === "outbound" && normalizeDirection("x") === null);
  ok("nonsense durations are null", seconds("abc") === null && seconds(-5) === null && seconds(99999) === null && seconds("1:2") === null);
  ok("a click id that is not a click id is not kept", (buildCall({ id: 7, called_at: "2026-10-14T10:00:00Z", gclid: "call me 513 555 0100" }, HASHKEY) as { row: { gclid: string | null } }).row.gclid === null);
  ok("an email or a number in a free-text field is replaced", cleanText("me@example.test main 513-555-0100") === "[email] main [number]");
  selfTest("the phone-in-label scan can fail", (t) => !/\d{3}[-.\s]\d{3}[-.\s]\d{4}/.test(t), "Main line [number]", "Main line 513-555-0142");

  /* ───────────────────────── 5. the answers ───────────────────────── */
  hr("5. the request and the paging");
  const u = new URL(callsUrl("1234567", "2026-09-01", "2026-10-15", 3));
  ok("the address is the documented host and the account path with the window and page", u.hostname === "api.calltrackingmetrics.com" && u.pathname === "/api/v1/accounts/1234567/calls.json" && u.searchParams.get("start_date") === "2026-09-01" && u.searchParams.get("end_date") === "2026-10-15" && u.searchParams.get("page") === "3" && u.searchParams.get("per_page") === String(CTM_PER_PAGE));
  const auth = basicAuth({ accessKey: ACCESS, secretKey: SECRET, accountId: null }).Authorization!;
  ok("authentication is Basic access:secret in the header, never in the address", auth === `Basic ${Buffer.from(`${ACCESS}:${SECRET}`).toString("base64")}` && !callsUrl("1", "a", "b", 1).includes(ACCESS) && !callsUrl("1", "a", "b", 1).includes(SECRET));
  const pg1 = parseCallsPage({ calls: [JSON_CALL, "junk", null], total_pages: 3, total_entries: 250 });
  ok("a page is the list of call objects, with the paging", pg1.calls.length === 1 && pg1.totalPages === 3 && pg1.totalEntries === 250);
  for (const [label, body] of [["a string", "ok"], ["null", null], ["an object with no list", { page: 1 }], ["an array", []]] as const) {
    let threw = false; try { parseCallsPage(body); } catch { threw = true; }
    ok(`${label} is refused, not read as 'no calls'`, threw);
  }
  ok("a key refusal is read from the status", isKeyRefusal(new HttpError(401, "", "x")) && isKeyRefusal(new HttpError(403, "", "x")) && !isKeyRefusal(new HttpError(500, "", "x")));
  const msg = safeMessage(new HttpError(500, `bad ${ACCESS}:${SECRET}`, "CallTrackingMetrics calls"), [ACCESS, SECRET]);
  ok("an error that echoes a key is scrubbed", !msg.includes(ACCESS) && !msg.includes(SECRET), msg);

  /* ───────────────────────── 6. the run, through a pretend CTM ───────────────────────── */
  hr("6. the run");
  const asked: Call[] = [];
  let mode = "ok";
  const manyCalls = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, called_at: "2026-10-14T10:00:00Z", call_status: "answered", talk_time: 40 }));
  const ctm = await startFake((c: Call) => {
    asked.push(c);
    const u2 = new URL(`http://x${c.path}`);
    const page = Number(u2.searchParams.get("page") ?? "1");
    if (c.headers.authorization !== `Basic ${Buffer.from(`${ACCESS}:${SECRET}`).toString("base64")}`) return { status: 401, body: { error: "unauthorized" } };
    if (mode === "404") return { status: 404, body: {} };
    if (mode === "429") return { status: 429, body: {} };
    if (mode === "html") return { body: "<html>nope</html>" };
    if (mode === "leak") return { status: 500, body: `oops ${ACCESS} ${SECRET}` };
    if (mode === "empty") return { body: { calls: [], total_pages: 1, total_entries: 0 } };
    if (mode === "page2fails" && page === 2) return { status: 500, body: "backend error" };
    if (mode === "endless") return { body: { calls: manyCalls(3, page * 10), total_pages: 9999, total_entries: 99999 } };
    if (mode === "badtime") return { body: { calls: [JSON_CALL, { id: 1, called_at: "2026-10-14 12:00:00" }, { called_at: "2026-10-14T10:00:00Z" }], total_pages: 1 } };
    if (page === 1) return { body: { calls: [JSON_CALL, CSV_CALL], total_pages: 2, total_entries: 3 } };
    return { body: { calls: [{ ...JSON_CALL, id: 9003 }], total_pages: 2, total_entries: 3 } };
  });
  process.env.SIGNALS_FAKE_BASE = ctm.base;
  const ctx = (over: Partial<CtmCtx> = {}): CtmCtx => ({ name: "Hillside Roofing", slug: "hillside-roofing", recorded: "1234567", ...over });
  const deps = (over: Partial<CtmDeps> = {}): CtmDeps => ({ fetch: realFetch, keys: KEYS, hashKey: HASHKEY, now: NOW, pauseMs: 0, secrets: [ACCESS, SECRET, HASHKEY], ...over });

  const off = await readCtmClient(ctx({ recorded: null }), deps());
  ok("no CallTrackingMetrics row switched on is 'off', makes no call and costs nothing", off.run.status === "off" && asked.length === 0);
  const noHash = await readCtmClient(ctx(), deps({ hashKey: null }));
  ok("no hash key is no_key, names CTM_CALLER_HASH_KEY, says there is no fallback and makes no call", noHash.run.status === "no_key" && (noHash.run.detail ?? "").includes(SECRET_NAMES.ctmHash) && /no fallback/.test(noHash.run.detail ?? "") && asked.length === 0 && noHash.calls.length === 0);
  const noEntry = await readCtmClient(ctx({ slug: "someone-else" }), deps());
  ok("no entry for the client is no_key and names CTM_ACCOUNT_KEYS_JSON and the client", noEntry.run.status === "no_key" && (noEntry.run.detail ?? "").includes(SECRET_NAMES.ctmKeys) && (noEntry.run.detail ?? "").includes("someone-else") && asked.length === 0);
  const mismatch = await readCtmClient(ctx({ recorded: "7654321" }), deps());
  ok("a recorded account that is not the keyed account reads nothing and says both numbers", mismatch.run.status === "error" && /7654321/.test(mismatch.run.detail ?? "") && /1234567/.test(mismatch.run.detail ?? "") && asked.length === 0);
  const noAcct = await readCtmClient(ctx({ recorded: "" }), deps({ keys: new Map([["hillside-roofing", { accessKey: ACCESS, secretKey: SECRET, accountId: null }]]) }));
  ok("no account number anywhere is an error that says where to put it", noAcct.run.status === "error" && /account number/.test(noAcct.run.detail ?? "") && asked.length === 0);
  const wrongKeys = await readCtmClient(ctx(), deps({ keys: new Map([["hillside-roofing", { accessKey: "wrong", secretKey: "wrong", accountId: "1234567" }]]) }));
  ok("keys CTM refuses are no_key and say to replace the entry, not 'the account is empty'", wrongKeys.run.status === "no_key" && /replace its entry/.test(wrongKeys.run.detail ?? ""));

  asked.length = 0;
  const dry = await readCtmClient(ctx(), deps({ dryRun: true }));
  ok("a dry run asks once, for one call, proves the keys and reads nothing", dry.run.status === "ok" && /Dry run/.test(dry.run.detail ?? "") && asked.length === 1 && new URL(`http://x${asked[0]!.path}`).searchParams.get("per_page") === "1" && dry.calls.length === 0);

  asked.length = 0;
  const r = await readCtmClient(ctx(), deps());
  ok("it walks the pages until the last and every request is a GET", asked.length === 2 && ctm.calls.every((c) => c.method === "GET") && new URL(`http://x${asked[1]!.path}`).searchParams.get("page") === "2");
  ok("the window is the declared number of days ending today", (() => { const q = new URL(`http://x${asked[0]!.path}`); return q.searchParams.get("end_date") === "2026-10-15" && (Date.parse("2026-10-15") - Date.parse(q.searchParams.get("start_date")!)) / 86_400_000 === CTM_WINDOW_DAYS - 1; })());
  ok("three calls came back mapped, in the right account's id", r.calls.length === 3 && r.calls.map((c) => c.ctmCallId).sort().join() === "9001,9002,9003");
  ok("the run is ok, counts its rows and names the day it ran to", r.run.status === "ok" && r.run.rows === 3 && r.run.windowEnd === "2026-10-15" && r.run.totalFound === 3, JSON.stringify(r.run));
  ok("nothing the run returned carries a number, a name, a link or an address", !/5135550188|JANE|audio\.example|203\.0\.113|leak|quote|call back/.test(JSON.stringify(r)));
  const lengths: number[] = [];
  for (const d of [120, 5000, 0]) {
    asked.length = 0;
    await readCtmClient(ctx(), deps({ days: d }));
    const q = new URL(`http://x${asked[0]!.path}`);
    lengths.push((Date.parse(q.searchParams.get("end_date")!) - Date.parse(q.searchParams.get("start_date")!)) / 86_400_000 + 1);
  }
  ok("a longer window is honoured, capped at 400, and a nonsense one falls to 1", lengths[0] === 120 && lengths[1] === 400 && lengths[2] === 1, lengths.join());

  mode = "badtime";
  const bt = await readCtmClient(ctx(), deps());
  ok("calls with no id or no readable time are skipped, counted and named", bt.calls.length === 1 && bt.skipped.noId === 1 && bt.skipped.noTime === 1 && /2 calls had no id or no readable time/.test(bt.run.detail ?? ""));
  mode = "empty";
  const em = await readCtmClient(ctx(), deps());
  ok("an answer with no calls is no_data, not a success with zero", em.run.status === "no_data" && /no calls for/.test(em.run.detail ?? ""));
  mode = "endless"; asked.length = 0;
  const en = await readCtmClient(ctx(), deps());
  ok("paging is bounded and the run says it stopped", asked.length === CTM_MAX_PAGES && en.run.status === "capped" && en.run.capped === true && /Only the first/.test(en.run.detail ?? ""));
  mode = "page2fails";
  const p2 = await readCtmClient(ctx(), deps());
  ok("a page that fails after the first keeps what was read and says where it stopped", p2.run.status === "capped" && p2.calls.length === 2 && /Stopped after page 1/.test(p2.run.detail ?? ""));
  for (const [m, status, text] of [["404", "error", /does not know account/], ["429", "capped", /limit was reached/], ["html", "error", null], ["leak", "error", null]] as const) {
    mode = m;
    const x = await readCtmClient(ctx(), deps());
    ok(`a ${m} answer is ${status}${text ? " and says what to check" : ""}, never an empty success`, x.run.status === status && (text ? text.test(x.run.detail ?? "") : true) && x.calls.length === 0);
    if (m === "leak") ok("an error body that echoes a key is scrubbed before it is stored", !new RegExp(`${ACCESS}|${SECRET}`).test(x.run.detail ?? ""), x.run.detail ?? "");
  }
  mode = "ok";
  await ctm.close();
  delete process.env.SIGNALS_FAKE_BASE;

  /* ───────────────────────── 7. what is written ───────────────────────── */
  hr("7. the writes");
  const rec = recorder();
  const calls = [row, row2].map((x) => x as never);
  await writeCalls(rec, "c1", calls, NOW);
  const colsOf = (sql: string) => (sql.match(/INSERT INTO \w+\s*\(([^)]*)\)/s)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  ok("the INSERT names 22 columns and sends 3 parameters (client, time, the rows as JSON)", colsOf(UPSERT_CTM_CALLS).length === 22 && rec.calls[0]!.params.length === 3);
  ok("it is an upsert on the call's id for the client, so a re-read overwrites and never doubles", /ON CONFLICT \(client_id, ctm_call_id\)/.test(UPSERT_CTM_CALLS));
  const payload = JSON.parse(String(rec.calls[0]!.params[2])) as Array<Record<string, unknown>>;
  ok("the JSON sent has exactly the stored columns for each call, no more", payload.length === 2 && payload.every((p) => Object.keys(p).sort().join() === ["caller_hash", "called_at", "city", "ctm_call_id", "device", "direction", "duration_seconds", "gclid", "id", "ring_seconds", "state", "status", "tags_google_ads_conversion", "tags_repeat", "talk_seconds", "tracking_label", "tracking_source", "utm_campaign", "utm_medium", "utm_source"].sort().join()));
  ok("no number, name, link, address or key is in what was sent", !/5135550188|JANE|audio\.example|203\.0\.113|transcript|summary/.test(JSON.stringify(rec.calls)) && !JSON.stringify(rec.calls).includes(HASHKEY));
  const rec2 = recorder();
  await writeCalls(rec2, "c1", calls, NOW);
  ok("the same call written twice has the same id", (JSON.parse(String(rec2.calls[0]!.params[2])) as Array<{ id: string }>)[0]!.id === payload[0]!.id);
  const rec3 = recorder();
  await writeCalls(rec3, "c1", Array.from({ length: BATCH + 1 }, (_, i) => ({ ...(row as object), ctmCallId: `c${i}` }) as never), NOW);
  ok("rows go in many to a statement, at most the declared batch", rec3.calls.length === 2 && (JSON.parse(String(rec3.calls[0]!.params[2])) as unknown[]).length === BATCH);
  const forbidden = /(phone|number|caller_?(number|name|id)|cnam|name|email|ip_?addr|visitor|recording|audio|transcri|summary|notes|message|body|keyword_?spot)/i;
  const cols = colsOf(UPSERT_CTM_CALLS).filter((c) => c !== "ctm_call_id");
  ok("no column could hold a number, a name, a recording, a transcript, a summary, a note, a message or an IP", !cols.some((c) => forbidden.test(c)), cols.filter((c) => forbidden.test(c)).join(","));
  selfTest("the forbidden-column scan can fail", (t) => !forbidden.test(t), "caller_hash", "visitor_ip");
  ok("the only caller column is the hash", cols.filter((c) => /caller/.test(c)).join() === "caller_hash");
  ok("housekeeping deletes only this client's old calls", /WHERE client_id = \$1 AND called_at < \$2/.test(PRUNE_CTM_CALLS));

  /* ───────────────────────── 8. secrets, the entry, the workflow ───────────────────────── */
  hr("8. a missing key is red and named; the workflow is wired");
  const k = ctmAccountKeys({ CTM_ACCOUNT_KEYS_JSON: JSON.stringify({ "Hillside-Roofing": { accessKey: "a", secretKey: "b", accountId: 1234567 }, half: { accessKey: "a" } }) });
  ok("the keys secret reads {slug: {accessKey, secretKey, accountId}} by lower-case slug, a number account id as a string, and ignores half an entry", k.get("hillside-roofing")?.accountId === "1234567" && !k.has("half"));
  let threw = false; try { ctmAccountKeys({ CTM_ACCOUNT_KEYS_JSON: "{not json" }); } catch { threw = true; }
  ok("a keys secret that is not JSON is refused, not half-used", threw);
  const root = path.resolve(import.meta.dirname, "..");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*#.*$/gm, "");
  const wfc = code(fs.readFileSync(path.join(root, ".github/workflows/read-ctm.yml"), "utf8"));
  ok("the workflow is scheduled daily", /schedule:\s*\n\s*- cron: "\d+ \d+ \* \* \*"/.test(wfc));
  ok("it takes client_id, days and dry_run and requires none", ["client_id", "days", "dry_run"].every((i) => new RegExp(`${i}:[\\s\\S]*?required: false`).test(wfc)));
  ok("the heartbeat runs even when the job failed, and not for a dry or scoped run", /Heartbeat[\s\S]*?if: always\(\) && inputs\.dry_run != 'true' && inputs\.client_id == ''/.test(wfc));
  ok("the heartbeat is named read_ctm and the note goes through an environment variable", /--job=read_ctm(?![\w])/.test(wfc) && /NOTE: \$\{\{ steps\.run\.outputs\.summary \}\}/.test(wfc) && !/--note="\$\{\{/.test(wfc));
  selfTest("the heartbeat step is guarded by always()", (t) => /Heartbeat[\s\S]*?if: always\(\)/.test(t), "- name: Heartbeat\n  if: always() && x", "- name: Heartbeat\n  if: success() && x");
  ok("it never points the job at a pretend server", !/SIGNALS_FAKE_BASE/.test(wfc));
  ok("the only secrets it passes are the database and the two CallTrackingMetrics ones", Array.from(wfc.matchAll(/secrets\.([A-Z0-9_]+)/g)).map((m) => m[1]).every((n) => ["DATABASE_URL", "CTM_ACCOUNT_KEYS_JSON", "CTM_CALLER_HASH_KEY"].includes(n!)) && /secrets\.CTM_ACCOUNT_KEYS_JSON/.test(wfc) && /secrets\.CTM_CALLER_HASH_KEY/.test(wfc));
  const entry = code(fs.readFileSync(path.join(root, "src/read-ctm.ts"), "utf8"));
  ok("the summary line reaches the heartbeat", /steps\.run\.outputs\.summary/.test(wfc) && /GITHUB_OUTPUT/.test(entry));
  ok("the entry script exits 1 when a key is missing and names both secrets", /missing > 0[\s\S]*?process\.exit\(1\)/.test(entry) && /SECRET_NAMES\.ctmKeys/.test(entry) && /SECRET_NAMES\.ctmHash/.test(entry));
  ok("a client with no row switched on is written 'off' and never needs a key", /status === "off"/.test(entry));
  const files = ["src/ctm/api.ts", "src/ctm/map.ts", "src/ctm/run.ts", "src/ctm/store.ts", "src/ctm/types.ts", "src/read-ctm.ts"].map((f) => code(fs.readFileSync(path.join(root, f), "utf8")));
  ok("no write method toward CallTrackingMetrics: every call is a GET", !files.some((t) => /method:\s*"(POST|PUT|PATCH|DELETE)"/i.test(t)));
  ok("the field mapping names no recording, transcript, summary, notes, message, name or IP field", !JSON.stringify(CTM_FIELDS).match(/recording|audio|transcri|summary|notes|message|visitor|cnam|"name"|ip"/i));
  selfTest("the mapping scan can fail", (t) => !/recording|transcri/i.test(t), '{"id":["id"]}', '{"x":["recording_url"]}');
  ok("the host is the documented one", files[4]!.includes('"https://api.calltrackingmetrics.com/api/v1"'));
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  ok("CI runs this guard", /npm run verify-ctm(?![\w-])/.test(ci));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  ok("the scripts exist", Boolean(pkg.scripts["read-ctm"]) && Boolean(pkg.scripts["verify-ctm"]));
  ok("no other file reads a CallTrackingMetrics secret from the environment by name", (() => {
    const bad: string[] = [];
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.ts$/.test(e.name) && !/verify-|secrets\.ts$/.test(e.name) && /process\.env\.CTM_[A-Z_]+/.test(code(fs.readFileSync(f, "utf8")))) bad.push(f); } };
    walk(path.join(root, "src"));
    return bad.length === 0;
  })());

  console.log(failures ? `\n❌ ${failures} check(s) failed` : "\n✅ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

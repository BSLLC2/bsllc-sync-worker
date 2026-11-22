/**
 * Guard for enhanced conversions for leads (R25). No network, no database.
 *
 *   1. Normalisation and hashing follow Google's Data Manager formatting rules.
 *   2. The OCH gate: off by default on a real send, on for validate, on for other live clients, never for a churned one.
 *   3. The request carries hashes under userData.userIdentifiers with encoding HEX, and never a raw value.
 *   4. RUNTIME: everything the job may print or record (summary line, app_settings record, a refused answer) holds no
 *      raw phone, no raw email, no normalised value and no hash.
 *   5. STATIC: in the job and the two modules it uses, no console call and no database query names a raw or hashed
 *      identifier. Strings and comments are ignored; `x.length` is allowed.
 *   6. SELF-TEST: planted leaks (a log line, a query parameter, a whole-row dump) are caught, so the guard cannot pass
 *      by being blind.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normaliseEmail, normalisePhoneE164, hashedIdentifiers, identifierGate, identifierCounts, identifierSummary, identifierRecord, identifierRecordKey, OCH_SLUG } from "./ads/user-identifiers.js";
import { buildIngestBody, interpret } from "./ads/data-manager.js";

let n = 0; const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// 1. Normalisation (Google's formatting guide) and hashing.
ok(normaliseEmail("  Jane.Doe+ads@GMAIL.com ") === "janedoe@gmail.com", "gmail: lowercase, dots and plus suffix removed");
ok(normaliseEmail("j.a.n.e@googlemail.com") === "jane@googlemail.com", "googlemail dots removed");
ok(normaliseEmail("Jane.Doe+x@Example.org") === "jane.doe+x@example.org", "other domains keep dots and plus");
ok(normaliseEmail("not an email") === null && normaliseEmail("a@b") === null && normaliseEmail(null) === null && normaliseEmail("+x@gmail.com") === null, "junk is null");
ok(normalisePhoneE164("(614) 555-0142") === "+16145550142", "10 digit US to E.164");
ok(normalisePhoneE164("1-614-555-0142") === "+16145550142", "11 digit US to E.164");
ok(normalisePhoneE164("+44 20 7946 0958") === "+442079460958", "international kept");
ok(normalisePhoneE164("555-0142") === null && normalisePhoneE164("0145550142") === null && normalisePhoneE164("") === null, "short or invalid is null");
ok(sha("+16145550142") === createHash("sha256").update("+16145550142", "utf8").digest("hex") && sha("test@gmail.com").length === 64, "hash is SHA-256 hex");
const ids = hashedIdentifiers({ phone: "(614) 555-0142", email: "Jane.Doe@gmail.com" });
ok(ids.length === 2 && ids.some((i) => "emailAddress" in i && i.emailAddress === sha("janedoe@gmail.com")) && ids.some((i) => "phoneNumber" in i && i.phoneNumber === sha("+16145550142")), "one identifier per kind, hashed after normalising");
ok(hashedIdentifiers({ phone: null, email: undefined }).length === 0, "nothing held, nothing sent");

// 2. The gate.
ok(!identifierGate(OCH_SLUG, true, {}).include, "OCH send: off by default");
ok(!identifierGate(OCH_SLUG, true, { OCH_ENHANCED_IDENTIFIERS: "on" }).include && !identifierGate(OCH_SLUG, true, { OCH_ENHANCED_IDENTIFIERS: "true" }).include, "OCH send: only the exact word send opens it");
ok(identifierGate(OCH_SLUG, true, { OCH_ENHANCED_IDENTIFIERS: "send" }).include, "OCH send: on with the switch");
ok(identifierGate(OCH_SLUG, false, {}).include && !identifierGate(OCH_SLUG, false, {}).switchOn, "OCH validate: carries them, switch still reads off");
ok(identifierGate("diesel-power-group", true, {}).include, "another live client: on");
ok(!identifierGate("franklin-brazing", true, { OCH_ENHANCED_IDENTIFIERS: "send" }).include && !identifierGate("franklin-brazing", false, {}).include, "churned: never");

// 3. The request body.
const dest = { accountId: "835-068-9003", loginAccountId: null, actionId: "7717525647" };
const RAW_PHONE = "(614) 555-0142", RAW_EMAIL = "Planted.Person+x@gmail.com";
const planted = hashedIdentifiers({ phone: RAW_PHONE, email: RAW_EMAIL });
const withIds = buildIngestBody(dest, [{ gclid: "g1", closed: "2026-10-05", valueDollars: 8000, transactionId: "t1", userIdentifiers: planted }], true) as any;
ok(withIds.encoding === "HEX", "encoding HEX when identifiers ride");
ok(withIds.events[0].userData.userIdentifiers.length === 2 && withIds.events[0].userData.userIdentifiers.every((u: any) => Object.keys(u).length === 1), "userData.userIdentifiers, one field each");
const bare = buildIngestBody(dest, [{ gclid: "g1", closed: "2026-10-05", valueDollars: 8000, transactionId: "t1" }], false) as any;
ok(!("encoding" in bare) && !("userData" in bare.events[0]), "no identifiers, no userData and no encoding");

// 4. Runtime: what may be printed or recorded.
const forbidden = [RAW_PHONE, RAW_EMAIL, "6145550142", "+16145550142", "planted.person", "plantedperson@gmail.com", ...planted.map((i) => Object.values(i)[0] as string)];
const leaks = (text: string): string[] => forbidden.filter((f) => text.toLowerCase().includes(f.toLowerCase()));
ok(JSON.stringify(withIds).includes(Object.values(planted[0]!)[0] as string) && leaks(JSON.stringify(withIds)).every((f) => /^[0-9a-f]{64}$/.test(f)), "the body holds the hash and no raw value");
const counts = identifierCounts([{ userIdentifiers: planted }, {}]);
ok(counts.rows === 2 && counts.withPhone === 1 && counts.withEmail === 1 && counts.withEither === 1, "counts");
const printed = [
  identifierSummary(counts, identifierGate(OCH_SLUG, true, {})),
  identifierSummary(counts, identifierGate(OCH_SLUG, false, {})),
  identifierRecord(counts, identifierGate(OCH_SLUG, true, {}), "send", new Date("2026-11-22T08:20:00Z")),
  identifierRecordKey(OCH_SLUG),
  interpret(400, { error: { status: "INVALID_ARGUMENT", message: `bad identifier ${Object.values(planted[0]!)[0]} for ${RAW_EMAIL}` } }).reason ?? "",
];
for (const p of printed) ok(leaks(p).length === 0, `nothing personal in: ${p.slice(0, 60)}`);
ok(identifierSummary(counts, identifierGate(OCH_SLUG, true, {})) === "Matching by phone or email: off (off until OCH_ENHANCED_IDENTIFIERS=send (waiting on OCH's compliance OK)). Would have been: 1 of 2 carried a phone hash, 1 an email hash.", "summary words");
const rec = JSON.parse(printed[2]!);
ok(rec.switchOn === false && rec.included === false && rec.withPhone === 1 && Object.keys(rec).sort().join(",") === "api,at,included,rows,switchOn,withEither,withEmail,withPhone", "record is counts and flags only");

// 5. Static: no console call or query names an identifier.
const FORBIDDEN_NAMES = /\b(email|emailAddress|phone|phoneNumber|contactPhone|contactEmail|userIdentifiers|candidates|hashedIdentifiers|sha256Hex|dmRows|inqRows|inquiries|fresh|matches|admissions)\b/;

/** Code with string contents and comments removed; template `${…}` expressions kept. */
function codeOnly(src: string): string {
  let out = "", i = 0;
  const tpl: number[] = []; // brace depth at each open template expression
  let depth = 0;
  while (i < src.length) {
    const c = src[i]!, d = src[i + 1];
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i = src.indexOf("*/", i + 2); i = i < 0 ? src.length : i + 2; continue; }
    if (c === '"' || c === "'") { i++; while (i < src.length && src[i] !== c) { if (src[i] === "\\") i++; i++; } i++; out += '""'; continue; }
    if (c === "`" || (c === "}" && tpl.length && tpl[tpl.length - 1] === depth)) {
      if (c === "}") tpl.pop(); else out += "`";
      i++;
      while (i < src.length && src[i] !== "`" && !(src[i] === "$" && src[i + 1] === "{")) { if (src[i] === "\\") i++; i++; }
      if (src[i] === "$") { tpl.push(depth); out += " "; i += 2; continue; }
      out += "`"; i++; continue;
    }
    if (c === "{") depth++;
    if (c === "}") depth--;
    out += c; i++;
  }
  return out;
}
/** Each `console.x(...)` and `.query(...)` call's argument text, from code with strings stripped. */
function sinks(code: string): { kind: string; args: string }[] {
  const out: { kind: string; args: string }[] = [];
  const re = /\b(console\.(?:log|warn|error|info|debug)|\.query)\s*(?:<[^>()]*>)?\s*\(/g;
  for (let m: RegExpExecArray | null; (m = re.exec(code)); ) {
    let i = re.lastIndex, d = 1;
    while (i < code.length && d > 0) { if (code[i] === "(") d++; else if (code[i] === ")") d--; i++; }
    out.push({ kind: m[1]!, args: code.slice(re.lastIndex, i - 1) });
  }
  return out;
}
function staticLeaks(src: string): string[] {
  return sinks(codeOnly(src))
    .map((s) => ({ ...s, hit: s.args.replace(/\b\w+\.length\b/g, "").match(FORBIDDEN_NAMES)?.[1] }))
    .filter((s) => s.hit)
    .map((s) => `${s.kind} names ${s.hit}`);
}
for (const f of ["src/import-offline-conversions.ts", "src/ads/data-manager.ts", "src/ads/user-identifiers.ts"]) {
  const found = staticLeaks(readFileSync(f, "utf8"));
  ok(found.length === 0, `${f}: no log line or query names an identifier${found.length ? ` (${found.join("; ")})` : ""}`);
}
ok(sinks(codeOnly(readFileSync("src/import-offline-conversions.ts", "utf8"))).length > 20, "the scan sees the job's log lines and queries");

// 6. Self-test: planted leaks are caught.
const plantedSrc = [
  "console.log(`sent ${m.contactEmail}`);",
  "console.error('row', m.contactPhone);",
  "console.log(fresh);",
  "await pgc.query(\"INSERT INTO t (a) VALUES ($1)\", [m.contactPhone]);",
  "await pgc.query<{ x: string }>(\"UPDATE t SET h=$1\", [dmRows[0].userIdentifiers]);",
  "console.log(`${JSON.stringify(candidates)}`);",
];
for (const p of plantedSrc) ok(staticLeaks(p).length === 1, `SELF-TEST: planted leak caught: ${p}`);
ok(staticLeaks("console.log(`Matching: ${fresh.length} rows`); console.log(\"phone hash\");").length === 0, "SELF-TEST: a count and a word in a string are allowed");
ok(leaks(`row for ${RAW_EMAIL}`).length > 0 && leaks(`hash ${Object.values(planted[1]!)[0]}`).length > 0, "SELF-TEST: a planted raw value and a planted hash in output are caught");

console.log(`verify-enhanced-identifiers: ${n} checks passed`);

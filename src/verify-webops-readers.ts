#!/usr/bin/env tsx
/**
 * Guard for the WebOps readers: the public site check, the RDAP domain expiry and the
 * WP Umbrella reader, plus what they write.
 *
 * No real site, no registry, no WP Umbrella, no database. A pretend server (a real HTTP
 * server on a local port) answers the real code through the real fetch, and a recording
 * client stands in for Postgres so the real upsert is read as text and as parameters.
 *
 * EVERY SITE, DOMAIN, KEY AND COUNT BELOW IS INVENTED.
 *
 * WHAT THIS CANNOT PROVE. Nothing here has run against a live site, a registry or WP
 * Umbrella. The RDAP answer shape is the standard one (RFC 9083 events); the WP Umbrella
 * endpoint and field names are UNVERIFIED guesses (see src/webops/umbrella.ts); the
 * certificate probe is injected here and was not run against a real TLS server.
 *
 *   npx tsx src/verify-webops-readers.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { startFake, type Call, type Reply } from "./signals/fake-http.js";
import { canonicalStateOf, checkSite, missingSecurityHeaders, siteStartUrl, type CertProbeFn } from "./webops/site-check.js";
import { checkDomain, expiryFromRdap } from "./webops/rdap.js";
import { readUmbrella, realUmbrellaApi, toWpFacts } from "./webops/umbrella.js";
import { missingUmbrellaMessage, umbrellaKey, WEBOPS_SECRET } from "./webops/secrets.js";
import { UPSERT_READING, writeReading } from "./webops/store.js";
import { SITE_USER_AGENT, type ReadingOut } from "./webops/types.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);
function selfTest(label: string, test: (text: string) => boolean, good: string, bad: string) {
  ok(`${label} (self-test: passes a good sample)`, test(good) === true);
  ok(`${label} (self-test: fails a planted bad sample)`, test(bad) === false);
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const KEY = "umbrella-key-value-123456";
const html = (canon: string | null) => `<html><head>${canon ? `<link rel="canonical" href="${canon}">` : ""}<title>x</title></head><body>hello</body></html>`;
const goodHeaders = { "content-type": "text/html", "strict-transport-security": "max-age=1", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" };

async function main() {
  hr("1. pure readings");
  ok("a bare host becomes an https home address", siteStartUrl("example.com") === "https://example.com/" && siteStartUrl(" https://www.example.com/x?y=1 ") === "https://www.example.com/");
  ok("a non-address is refused", siteStartUrl("") === null && siteStartUrl("ftp://example.com") === null && siteStartUrl("notahost") === null);
  ok("canonical: same, other path, other host, none", canonicalStateOf(html("https://example.com/"), "https://example.com") === "same" && canonicalStateOf(html("https://example.com/other"), "https://example.com/") === "other_path" && canonicalStateOf(html("https://elsewhere.test/"), "https://example.com/") === "other_host" && canonicalStateOf(html(null), "https://example.com/") === "none");
  ok("canonical: www and non-www are the same site", canonicalStateOf(html("https://www.example.com/"), "https://example.com/") === "same");
  ok("security headers: all present is an empty list, absent ones are named", missingSecurityHeaders(new Headers(goodHeaders)).length === 0 && missingSecurityHeaders(new Headers({})).length === 4);
  ok("frame protection is met by a CSP frame-ancestors", !missingSecurityHeaders(new Headers({ ...goodHeaders, "x-frame-options": "", "content-security-policy": "frame-ancestors 'none'" })).includes("x-frame-options-or-frame-ancestors"));
  ok("rdap: expiration event read; others ignored; none is null", expiryFromRdap({ events: [{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }, { eventAction: "expiration", eventDate: "2027-03-04T12:00:00Z" }] }) === "2027-03-04" && expiryFromRdap({ events: [] }) === null && expiryFromRdap(null) === null && expiryFromRdap({ events: [{ eventAction: "expiration", eventDate: "junk" }] }) === null);
  const w = toWpFacts({ data: { uptime: { percentage: "99.5" }, updates: { plugins: 3, themes: 0, core: false }, vulnerabilities: { count: 0 }, backup: { last_at: "2026-10-30T01:00:00Z", status: "completed" } } });
  ok("wp facts read from the guessed shape", w.facts.wpUptimePct === 99.5 && w.facts.wpPluginsBehind === 3 && w.facts.wpThemesBehind === 0 && w.facts.wpCoreBehind === false && w.facts.wpVulnerabilities === 0 && w.facts.wpLastBackupOk === true && w.facts.wpLastBackupAt === "2026-10-30T01:00:00.000Z");
  const wn = toWpFacts({ data: { updates: { plugins: 2 } } });
  ok("a field the answer lacks is null, never 0", wn.facts.wpThemesBehind === null && wn.facts.wpVulnerabilities === null && wn.facts.wpLastBackupOk === null && wn.facts.wpCoreBehind === null && wn.facts.wpUptimePct === null);
  ok("an uptime over 100 and a negative count are not believed", toWpFacts({ uptime_percentage: 140, outdated_plugins_count: -2 }).facts.wpUptimePct === null && toWpFacts({ outdated_plugins_count: -2 }).facts.wpPluginsBehind === null);
  ok("a failed backup status reads false, an unknown one null", toWpFacts({ backup: { status: "failed" } }).facts.wpLastBackupOk === false && toWpFacts({ backup: { status: "queued" } }).facts.wpLastBackupOk === null);

  hr("2. the public site check, against a pretend site");
  let robots: Reply = { status: 200, body: "User-agent: *\nDisallow: /private\n", headers: { "content-type": "text/plain" } };
  let routes: Record<string, Reply> = {
    "/": { status: 200, body: html("http://PLACEHOLDER/"), headers: goodHeaders },
  };
  const fake = await startFake((c: Call) => {
    if (c.path === "/robots.txt") return robots;
    return routes[c.path] ?? { status: 404, body: "no" };
  });
  const homeCalls = () => fake.calls.filter((c) => c.path !== "/robots.txt");
  routes["/"] = { status: 200, body: html(`${fake.base}/`), headers: goodHeaders };
  const certCalls: string[] = [];
  const probe: CertProbeFn = async (h, p) => { certCalls.push(`${h}:${p}`); return { validTo: "2027-01-02", trusted: true }; };

  let r = await checkSite(fake.base, { allowPrivate: true });
  ok("a healthy page reads: status, time, no hops, canonical same", r.state === "read" && r.site!.httpStatus === 200 && (r.site!.responseMs ?? -1) >= 0 && r.site!.redirectHops === 0 && r.site!.canonicalState === "same");
  ok("all four security headers present gives an empty missing list", Array.isArray(r.site!.headersMissing) && r.site!.headersMissing.length === 0);
  ok("one page request and one robots.txt, nothing else", fake.calls.length === 2 && homeCalls().length === 1);
  ok("the request names itself and carries no credential or cookie", fake.calls.every((c) => c.headers["user-agent"] === SITE_USER_AGENT && !c.headers.authorization && !c.headers.cookie));
  ok("an http address is not given a certificate reading", r.site!.endedHttps === false && r.site!.certExpiresOn === null && r.site!.certTrusted === null);

  fake.calls.length = 0;
  routes["/"] = { status: 200, body: html(null), headers: { "content-type": "text/html" } };
  r = await checkSite(fake.base, { allowPrivate: true });
  ok("missing headers are named, canonical none", r.site!.headersMissing!.length === 4 && r.site!.canonicalState === "none");

  fake.calls.length = 0;
  routes["/"] = { status: 301, headers: { location: "/a" } };
  routes["/a"] = { status: 302, headers: { location: "/b" } };
  routes["/b"] = { status: 200, body: html(`${fake.base}/b`), headers: goodHeaders };
  r = await checkSite(fake.base, { allowPrivate: true });
  ok("a two-hop chain is followed and counted", r.state === "read" && r.site!.redirectHops === 2 && r.site!.httpStatus === 200 && r.site!.canonicalState === "same");

  fake.calls.length = 0;
  routes["/"] = { status: 302, headers: { location: "https://other-site.invalid/landing" } };
  r = await checkSite(fake.base, { allowPrivate: true });
  ok("a redirect off the site is recorded and NOT followed", r.state === "read" && r.site!.endsOffSite === true && homeCalls().length === 1 && r.site!.headersMissing === null && r.site!.canonicalState === null);

  fake.calls.length = 0;
  routes["/"] = { status: 302, headers: { location: "/" } };
  r = await checkSite(fake.base, { allowPrivate: true });
  ok("a redirect loop stops at the cap and is could_not_check, not read", r.state === "could_not_check" && /redirects/.test(r.detail ?? "") && r.site === null && homeCalls().length <= 7);

  fake.calls.length = 0;
  routes["/"] = { status: 503, body: "down", headers: { "content-type": "text/html" } };
  r = await checkSite(fake.base, { allowPrivate: true });
  ok("a 503 is a read (the site answered) with its status, not a failure to check", r.state === "read" && r.site!.httpStatus === 503 && r.site!.canonicalState === null);

  fake.calls.length = 0;
  robots = { status: 200, body: "User-agent: *\nDisallow: /\n" };
  routes["/"] = { status: 200, body: html(null), headers: goodHeaders };
  r = await checkSite(fake.base, { allowPrivate: true });
  ok("robots.txt forbidding / blocks the check and the home page is never requested", r.state === "blocked_by_robots" && homeCalls().length === 0 && r.site === null);

  fake.calls.length = 0;
  robots = { status: 500, body: "oops" };
  r = await checkSite(fake.base, { allowPrivate: true });
  ok("an unreadable robots.txt does not stop the check", r.state === "read" && homeCalls().length === 1);
  robots = { status: 200, body: "User-agent: *\nDisallow: /private\n" };

  fake.calls.length = 0;
  r = await checkSite(fake.base, { allowPrivate: false });
  ok("a private address is refused without a single request", r.state === "could_not_check" && fake.calls.length === 0);

  const dead = await checkSite("http://127.0.0.1:1", { allowPrivate: true });
  ok("a refused connection is could_not_check with no figures", dead.state === "could_not_check" && dead.site === null);

  // https path with a stub fetch and an injected probe
  const httpsStub = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/robots.txt") return new Response("", { status: 404 });
    return new Response(html("https://secure.example.test/"), { status: 200, headers: goodHeaders });
  }) as unknown as typeof fetch;
  r = await checkSite("secure.example.test", { fetchImpl: httpsStub, certProbe: probe, allowPrivate: true });
  ok("an https site gets its certificate read through the probe", r.state === "read" && r.site!.endedHttps === true && r.site!.certExpiresOn === "2027-01-02" && r.site!.certTrusted === true && certCalls.includes("secure.example.test:443"));
  const badProbe: CertProbeFn = async () => { throw new Error("handshake failed"); };
  r = await checkSite("secure.example.test", { fetchImpl: httpsStub, certProbe: badProbe, allowPrivate: true });
  ok("a failed handshake leaves the certificate null, never a date", r.state === "read" && r.site!.certExpiresOn === null && r.site!.certTrusted === null);
  await fake.close();

  hr("3. RDAP domain expiry");
  const rdapNames: string[] = [];
  const rd = await startFake((c) => {
    const name = decodeURIComponent(c.path.replace("/domain/", ""));
    rdapNames.push(name);
    if (name === "good.test") return { body: { events: [{ eventAction: "expiration", eventDate: "2027-05-06T00:00:00Z" }] } };
    if (name === "noevent.test") return { body: { events: [{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }] } };
    if (name === "parent.test") return { body: { events: [{ eventAction: "expiration", eventDate: "2028-01-01T00:00:00Z" }] } };
    if (name === "boom.test") return { status: 500, body: "x" };
    if (name === "html.test") return { status: 200, body: "<html>" };
    return { status: 404, body: "{}" };
  });
  let d = await checkDomain("www.good.test", { base: rd.base });
  ok("an expiration event gives the date; www is dropped", d.state === "read" && d.domain!.domainExpiresOn === "2027-05-06" && rdapNames[0] === "good.test");
  ok("the request is a GET to /domain/<name> with an rdap accept", rd.calls[0]!.method === "GET" && /rdap/.test(String(rd.calls[0]!.headers.accept)) && !rd.calls[0]!.headers.authorization);
  d = await checkDomain("noevent.test", { base: rd.base });
  ok("no published expiry is read with a null date and says so, not a date", d.state === "read" && d.domain!.domainExpiresOn === null && /does not publish/.test(d.detail ?? ""));
  rdapNames.length = 0;
  d = await checkDomain("shop.parent.test", { base: rd.base });
  ok("a subdomain with no record is retried once as its parent", d.state === "read" && d.domain!.domainExpiresOn === "2028-01-01" && rdapNames.join(",") === "shop.parent.test,parent.test");
  rdapNames.length = 0;
  d = await checkDomain("a.b.c.unknown.test", { base: rd.base });
  ok("it never walks down more than one label", d.state === "could_not_check" && rdapNames.length === 2);
  d = await checkDomain("unknown.test", { base: rd.base });
  ok("no RDAP record is could_not_check with the reason", d.state === "could_not_check" && d.domain === null && /no RDAP record/.test(d.detail ?? ""));
  d = await checkDomain("boom.test", { base: rd.base });
  ok("a registry error is could_not_check", d.state === "could_not_check" && /500/.test(d.detail ?? ""));
  d = await checkDomain("html.test", { base: rd.base });
  ok("a non-JSON answer is could_not_check", d.state === "could_not_check");
  d = await checkDomain("not a domain", { base: rd.base });
  ok("a non-domain is refused with no request", d.state === "could_not_check" && !rd.calls.some((c) => c.path.includes("not")));
  await rd.close();

  hr("4. the WP Umbrella reader, against a pretend Umbrella (shapes UNVERIFIED)");
  let umbrellaBody: Reply = { body: { data: { uptime: { percentage: 99.9 }, updates: { plugins: 4, themes: 1, core: true }, vulnerabilities: { count: 2 }, backup: { last_at: "2026-10-31T02:00:00Z", status: "success" } } } };
  const um = await startFake((c) => (c.path.startsWith("/projects/") ? umbrellaBody : { status: 404, body: "" }));
  const api = realUmbrellaApi(um.base, KEY);
  let wr = await readUmbrella("proj-1", api, [KEY]);
  ok("a project is read with a Bearer key to /projects/<id>", wr.reading.state === "read" && um.calls[0]!.path === "/projects/proj-1" && um.calls[0]!.headers.authorization === `Bearer ${KEY}`);
  ok("counts and dates come through; nothing else", wr.reading.wp!.wpPluginsBehind === 4 && wr.reading.wp!.wpCoreBehind === true && wr.reading.wp!.wpVulnerabilities === 2 && wr.reading.wp!.wpLastBackupOk === true && Object.keys(wr.reading.wp!).length === 7);
  umbrellaBody = { body: { unrelated: true } };
  wr = await readUmbrella("proj-1", api, [KEY]);
  ok("an answer with none of the fields is could_not_check, never an all-null read", wr.reading.state === "could_not_check" && wr.reading.wp === null && wr.found.length === 0);
  umbrellaBody = { status: 401, body: `denied for ${KEY}` };
  wr = await readUmbrella("proj-1", api, [KEY]);
  ok("a refusal is could_not_check and the key is nowhere in the message", wr.reading.state === "could_not_check" && !(wr.reading.detail ?? "").includes(KEY));
  wr = await readUmbrella("proj-1", { project: async () => { throw new Error(`fetch failed for https://x/?token=${KEY} using ${KEY}`); } }, [KEY]);
  ok("a thrown error that carries the key is scrubbed before it is stored", wr.reading.state === "could_not_check" && !(wr.reading.detail ?? "").includes(KEY));
  wr = await readUmbrella("proj-1", null);
  ok("no key is no_key and the message names the secret", wr.reading.state === "no_key" && missingUmbrellaMessage().includes(WEBOPS_SECRET));
  wr = await readUmbrella(null, api);
  ok("no project id is off and asks the server nothing", wr.reading.state === "off" && um.calls.length === 3);
  ok("the key is read from the one place, either secret name", umbrellaKey({ WP_UMBRELLA_API_KEY: " k " }) === "k" && umbrellaKey({ WPUMBRELLA_API_KEY: "z" }) === "z" && umbrellaKey({}) === null);
  await um.close();

  hr("5. what is written");
  const rec: Array<{ sql: string; params: unknown[] }> = [];
  const db = { query: async (sql: string, params?: unknown[]) => { rec.push({ sql, params: params ?? [] }); return {}; } };
  const at = new Date("2026-11-01T09:30:00Z");
  const cols = /\(([^)]*)\)\s*VALUES/.exec(UPSERT_READING)![1]!.split(",").map((s) => s.trim());
  const nPlace = (UPSERT_READING.match(/\$\d+/g) ?? []).filter((x, i, a) => a.indexOf(x) === i).length;
  ok("the upsert has a value for every column", cols.length === nPlace && cols.length === 24, `${cols.length} columns, ${nPlace} placeholders`);
  const good: ReadingOut = { kind: "site", subject: "example.com", state: "read", detail: null, site: { httpStatus: 200, responseMs: 320, redirectHops: 1, endedHttps: true, endsOffSite: false, canonicalState: "same", certExpiresOn: "2027-01-02", certTrusted: true, headersMissing: ["referrer-policy"] }, domain: null, wp: null };
  await writeReading(db, "c1", good, at);
  const p = rec[0]!.params;
  ok("a read stores its facts and stamps last_read_at", p[3] === "read" && p[5] === 200 && p[6] === 320 && p[13] === "referrer-policy" && p[22] === at.toISOString() && p[23] === at.toISOString());
  await writeReading(db, "c1", { kind: "site", subject: "example.com", state: "could_not_check", detail: "No answer in 15 seconds.", site: null, domain: null, wp: null }, at);
  const f = rec[1]!.params;
  ok("a failed read nulls every measurement and does not stamp last_read_at", f[3] === "could_not_check" && f.slice(5, 22).every((v) => v === null) && f[23] === null);
  ok("a failed read keeps the earlier last_read_at (COALESCE)", /last_read_at = COALESCE\(EXCLUDED\.last_read_at, site_care_readings\.last_read_at\)/.test(UPSERT_READING));
  ok("no key or secret reaches a parameter", !JSON.stringify(rec).includes(KEY));

  hr("6. static guards");
  const files = fs.readdirSync("src/webops").map((n) => `src/webops/${n}`).concat(["src/read-webops.ts"]);
  const allSrc = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allSrc(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []));
  const namesSecret = (t: string) => /WP_UMBRELLA_API_KEY|WPUMBRELLA_API_KEY/.test(t.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""));
  const outside = allSrc("src").filter((f2) => namesSecret(read(f2)) && !["src/webops/secrets.ts", "src/import-webops.ts", "src/verify-webops.ts", "src/verify-webops-readers.ts"].includes(f2));
  ok("only secrets.ts (and the older importer and its check) name the secret", outside.length === 0, outside.join(", "));
  selfTest("secret-name detector", namesSecret, "process.env.WP_UMBRELLA_API_KEY", "process.env.OTHER");
  const allowPrivateUse = (t: string) => /allowPrivate\s*:\s*true/.test(t);
  ok("the CLI never passes allowPrivate", !allowPrivateUse(read("src/read-webops.ts")) && !files.filter((f2) => f2 !== "src/read-webops.ts").some((f2) => allowPrivateUse(read(f2))));
  selfTest("allowPrivate detector", allowPrivateUse, "checkSite(x, { allowPrivate: true })", "checkSite(x)");
  const wf = read(".github/workflows/read-webops.yml");
  ok("workflow: schedule, dispatch dry run defaults to true, heartbeat on if always()", /schedule:/.test(wf) && /dry_run:[\s\S]*?default: "true"/.test(wf) && /Heartbeat\s+if: always\(\)/.test(wf) && /--job=read_webops/.test(wf));
  ok("workflow: no test seam and no other secret", !/SIGNALS_FAKE_BASE|GOOGLE_SERVICE_ACCOUNT/.test(wf) && (wf.match(/secrets\.[A-Z_]+/g) ?? []).every((s) => /DATABASE_URL|WP_UMBRELLA_API_KEY|WPUMBRELLA_API_KEY/.test(s)));
  const storeSrc = read("src/webops/store.ts");
  ok("the only table written is site_care_readings, and no DELETE", [...storeSrc.matchAll(/INSERT INTO (\w+)/g)].every((m) => m[1] === "site_care_readings") && !/DELETE\s+FROM|DROP\s/i.test(storeSrc));
  ok("only read-webops.ts opens a database connection", files.filter((f2) => /from "pg"|import pg/.test(read(f2))).join() === "src/read-webops.ts");
  const noScrape = files.every((f2) => !/siteground/i.test(read(f2).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  ok("nothing in code talks to SiteGround (comments only)", noScrape);
  ok("no page body or header value is a column", !/body|html|header_value|plugin_name|vuln_title/i.test(cols.join(",")));
  ok("the CI runs this guard", /verify-webops-readers/.test(read(".github/workflows/ci.yml")));
  const hasIf = (t: string) => /if \(!\(await hostIsPublic\(/.test(t);
  ok("every hop is checked as a public address before it is requested", hasIf(read("src/webops/site-check.ts")) && (read("src/webops/site-check.ts").match(/hostIsPublic\(/g) ?? []).length >= 2);
  selfTest("public-address check detector", hasIf, "if (!(await hostIsPublic(h)))", "doFetch(h)");

  console.log(failures ? `\n❌ ${failures} check(s) failed.` : "\n✅ All WebOps reader checks passed.");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

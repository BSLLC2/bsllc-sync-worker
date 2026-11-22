#!/usr/bin/env tsx
/**
 * Guard for the Tag Manager reader: what it asks, what it keeps and what it refuses to keep.
 *
 * No Google, no database, no key. A pretend Tag Manager (a real HTTP server on a local port)
 * answers the real request builders, the real parser and the real orchestration through the
 * real fetch, and a recording client stands in for Postgres so the real INSERTs are read as
 * text and as parameters.
 *
 * EVERY CONTAINER, TAG, TRIGGER, VARIABLE AND ID BELOW IS INVENTED.
 *
 * WHAT THIS CANNOT PROVE. No Tag Manager container was read: the endpoint paths, the answer
 * field names, the tag type codes, the built-in trigger id range, the live-version endpoint
 * and its not-found answer for an unpublished container are written from Google's published
 * Tag Manager API v2 reference as remembered. A green run means the code does what it says
 * against the shapes it expects, not that Google answers in them. The first dry run on the
 * real service account is the proof.
 *
 *   npx tsx src/verify-gtm.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { startFake, type Call } from "./signals/fake-http.js";
import { realFetch } from "./page-behaviour/http.js";
import { parseAccounts, parseContainers, parseLiveVersion } from "./gtm/api.js";
import { loadDirectory, readGtmClient, type GtmCtx } from "./gtm/run.js";
import { UPSERT_FACTS, UPSERT_FAILED, writeFacts, writeFailed } from "./gtm/store.js";
import { GTM_SCOPE, GTM_TAG_CAP } from "./gtm/types.js";
import { googleToken, serviceAccount } from "./signals/google.js";

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

const POISON_BODY = "POISON_HTML_BODY_do_not_keep";
const POISON_VALUE = "POISON_VARIABLE_VALUE_do_not_keep";
const POISON_LABEL = "POISON_CONVERSION_LABEL_do_not_keep";

const LIVE = {
  path: "accounts/111/containers/222/versions/9", containerVersionId: "9", name: "Add form event", fingerprint: "1760000000000",
  tag: [
    { tagId: "1", name: "GA4 config", type: "gaawc", parameter: [{ type: "template", key: "measurementId", value: "G-ABC1234" }], firingTriggerId: ["2147479553"] },
    { tagId: "2", name: "GA4 config via variable", type: "gaawc", parameter: [{ type: "template", key: "measurementId", value: "{{GA4 id}}" }], firingTriggerId: ["2147479553"] },
    { tagId: "3", name: "Form submit event", type: "gaawe", parameter: [{ type: "template", key: "eventName", value: "form_submit" }], firingTriggerId: ["10"] },
    { tagId: "4", name: "CTA click", type: "gaawe", paused: true, parameter: [{ type: "template", key: "eventName", value: "cta_click" }], firingTriggerId: ["10"] },
    { tagId: "5", name: "Lead event", type: "gaawe", parameter: [{ type: "template", key: "eventName", value: "generate_lead" }] },
    { tagId: "6", name: "Scroll", type: "gaawe", parameter: [{ type: "template", key: "eventName", value: "scroll_50" }], firingTriggerId: ["999"] },
    { tagId: "7", name: "Ads conversion", type: "awct", parameter: [{ type: "template", key: "conversionId", value: "123456789" }, { type: "template", key: "conversionLabel", value: POISON_LABEL }], firingTriggerId: ["11"] },
    { tagId: "8", name: "Linker", type: "gclidw", firingTriggerId: ["2147479553"] },
    { tagId: "9", name: "Custom", type: "html", parameter: [{ type: "template", key: "html", value: `<script>${POISON_BODY}</script>` }], firingTriggerId: ["2147479553"] },
    { tagId: "10", name: "Clarity", type: "cvt_222_31", firingTriggerId: ["2147479553"] },
    { tagId: "11", name: "Some template", type: "cvt_222_32", firingTriggerId: ["2147479553"] },
    { tagId: "12", name: "Old analytics", type: "ua", firingTriggerId: ["2147479553"] },
    { tagId: "13", name: "Pixel", type: "img", firingTriggerId: ["2147479553"] },
  ],
  trigger: [
    { triggerId: "10", name: "Form submit custom", type: "customEvent", customEventFilter: [{ type: "equals", parameter: [{ type: "template", key: "arg0", value: "{{_event}}" }, { type: "template", key: "arg1", value: "form_submit" }] }] },
    { triggerId: "11", name: "Thanks page", type: "pageview", filter: [{ type: "contains", parameter: [{ type: "template", key: "arg1", value: "/thanks/POISON_FILTER_VALUE" }] }] },
  ],
  variable: [{ variableId: "1", name: "GA4 id", type: "c", parameter: [{ type: "template", key: "value", value: POISON_VALUE }] }, { variableId: "2", name: "Page path", type: "u" }],
  customTemplate: [
    { templateId: "31", name: "Clarity", galleryReference: { host: "github.com", owner: "Microsoft", repository: "clarity-gtm-template" } },
    { templateId: "32", name: "Other", galleryReference: { host: "github.com", owner: "someone", repository: "something" } },
  ],
};

type Rec = { sql: string; params: unknown[] };
const recorder = () => { const calls: Rec[] = []; return { calls, query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params: params ?? [] }); return {}; } }; };
const NOW = new Date("2026-11-16T11:30:00Z");
const SECRET = "SECRET-service-account-private-key-value";

async function main() {
  /* ───────────────────────── 1. the parser ───────────────────────── */
  hr("1. a live version becomes declared facts, and nothing else");
  const { version, facts } = parseLiveVersion(LIVE);
  const dump = JSON.stringify({ version, facts });
  ok("the version id and name are kept", version.versionId === "9" && version.versionName === "Add form event");
  ok("a plausible fingerprint is read as the saved date; it is marked unverified in the module", version.publishedAt?.toISOString() === new Date(1760000000000).toISOString() && /UNVERIFIED/.test(fs.readFileSync(path.join(import.meta.dirname, "gtm/types.ts"), "utf8")));
  ok("an implausible fingerprint is no date", parseLiveVersion({ fingerprint: "12" }).version.publishedAt === null && parseLiveVersion({}).version.publishedAt === null);
  ok("a GA4 configuration tag keeps its measurement id; a variable reference keeps none and says so", facts.ga4Configs.length === 2 && facts.ga4Configs[0]!.measurementId === "G-ABC1234" && facts.ga4Configs[1]!.measurementId === null && facts.ga4Configs[1]!.viaVariable === true);
  const ev = (n: string) => facts.ga4Events.find((e) => e.event === n)!;
  ok("a GA4 event tag is kept by its event name", facts.ga4Events.length === 4 && ["form_submit", "cta_click", "generate_lead", "scroll_50"].every((n) => !!ev(n)));
  ok("an event tag fires only when it is not paused and has a firing trigger that exists", ev("form_submit").fires === true && ev("cta_click").fires === false && ev("cta_click").paused === true && ev("generate_lead").fires === false && ev("scroll_50").fires === false);
  ok("a built-in trigger id counts as a firing trigger", facts.ga4Configs[0]!.fires === true);
  ok("a Google Ads conversion tag keeps its id, with the AW- prefix, and only whether a label exists", facts.adsConversions.length === 1 && facts.adsConversions[0]!.conversionId === "AW-123456789" && facts.adsConversions[0]!.hasLabel === true && facts.adsConversions[0]!.fires === true);
  ok("the conversion linker is counted", facts.conversionLinker.count === 1 && facts.conversionLinker.active === 1);
  ok("a community template is a known product only by its exact gallery reference", facts.clarity.count === 1 && facts.clarity.active === 1 && facts.metaPixel.count === 0);
  ok("custom HTML, a custom image and an unrecognised template are counted as custom tags, never read", facts.customTags === 3);
  ok("any other tag type is counted and not read", facts.otherTags === 1);
  ok("the counts are the container's own", facts.counts.tags === 13 && facts.counts.paused === 1 && facts.counts.triggers === 2 && facts.counts.variables === 2);
  ok("a trigger is its type and a short summary; a custom event keeps the event name it waits for", facts.triggers.some((t) => t.type === "customEvent" && /event form_submit/.test(t.summary)) && facts.triggers.some((t) => t.type === "pageview" && /1 condition \(contains\)/.test(t.summary)));
  ok("variables are kept by name only", JSON.stringify(facts.variableNames) === '["GA4 id","Page path"]');
  ok("NO custom HTML body, variable value, conversion label or filter value is kept anywhere", ![POISON_BODY, POISON_VALUE, POISON_LABEL, "POISON_FILTER_VALUE"].some((p) => dump.includes(p)));
  selfTest("the poison scan can fail", (x) => !x.includes(POISON_BODY), "{}", `{"a":"${POISON_BODY}"}`);
  const big = parseLiveVersion({ tag: Array.from({ length: GTM_TAG_CAP + 5 }, (_, i) => ({ tagId: String(i), type: "html" })) });
  ok("over the tag cap the facts say they were cut", big.facts.counts.truncated === true && big.facts.counts.tags === GTM_TAG_CAP + 5 && big.facts.customTags === GTM_TAG_CAP);
  const empty = parseLiveVersion({});
  ok("an empty answer is no tags, never an invented one", empty.facts.counts.tags === 0 && empty.facts.ga4Configs.length === 0);
  ok("accounts and containers are listed from the answer and a malformed one is skipped", parseAccounts({ account: [{ path: "accounts/111" }, { path: "bad" }, {}] }).join() === "accounts/111" && parseContainers({ container: [{ publicId: "gtm-abc123", path: "accounts/111/containers/222" }, { publicId: "x", path: "nope" }] }).map((c) => c.publicId).join() === "GTM-ABC123");

  /* ───────────────────────── 2. the read, against a pretend Tag Manager ───────────────────────── */
  hr("2. the read, and every way it can end");
  type Mode = "ok" | "unlisted" | "empty_account" | "disabled" | "forbidden_version" | "unpublished" | "throttled_then_ok" | "server_error";
  let mode: Mode = "ok";
  let throttle = 0;
  const gtm = await startFake((c: Call) => {
    if (c.path === "/token") return undefined;
    if (c.path === "/gtm/tagmanager/v2/accounts") {
      if (mode === "disabled") return { status: 403, body: { error: { status: "PERMISSION_DENIED", message: "Tag Manager API has not been used in project 1 before or it is disabled.", details: [{ reason: "SERVICE_DISABLED" }] } } };
      if (mode === "empty_account") return { body: {} };
      return { body: { account: [{ path: "accounts/111", accountId: "111", name: "Agency" }] } };
    }
    if (c.path === "/gtm/tagmanager/v2/accounts/111/containers") {
      if (mode === "unlisted") return { body: { container: [{ path: "accounts/111/containers/333", publicId: "GTM-OTHER1" }] } };
      return { body: { container: [{ path: "accounts/111/containers/222", publicId: "GTM-ABC123", usageContext: ["web"] }] } };
    }
    if (c.path === "/gtm/tagmanager/v2/accounts/111/containers/222/versions:live") {
      if (mode === "unpublished") return { status: 404, body: { error: { code: 404, message: "Not found or permission denied" } } };
      if (mode === "forbidden_version") return { status: 403, body: { error: { code: 403, message: "The caller does not have permission" } } };
      if (mode === "server_error") return { status: 500, body: "boom" };
      if (mode === "throttled_then_ok" && throttle++ < 2) return { status: 429, body: "slow down" };
      return { body: LIVE };
    }
    return { status: 599, body: "no route" };
  });
  process.env.SIGNALS_FAKE_BASE = gtm.base;
  const sa = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "svc@example.test", private_key: SECRET }) };
  const tokenOf = async () => googleToken(GTM_SCOPE, serviceAccount(sa as never, "no Tag Manager container can be read"));
  const token = await tokenOf();
  const ctx = (id: string | null = "GTM-ABC123"): GtmCtx => ({ name: "Hillside Roofing", slug: "hillside-roofing", containerId: id });
  const deps = () => ({ fetch: realFetch, token, pauseMs: 0, secrets: [SECRET, token], directory: () => loadDirectory(realFetch, token, 0, [SECRET, token]) });

  const good = await readGtmClient(ctx(), deps());
  ok("a good read is ok and carries the facts and the container path", good.run.status === "ok" && good.facts?.counts.tags === 13 && good.containerPath === "accounts/111/containers/222" && good.failed === false && good.state === null);
  ok("the container id is matched exactly, case-insensitively, and stored upper-case", (await readGtmClient(ctx(" gtm-abc123 "), deps())).run.status === "ok");
  const off = await readGtmClient(ctx(null), deps());
  ok("no id recorded is off and asks nothing of Google", off.run.status === "off" && off.failed === false);
  const calledBefore = gtm.calls.length;
  await readGtmClient(ctx(null), deps());
  ok("an off client makes no call at all", gtm.calls.length === calledBefore);
  const bad = await readGtmClient(ctx("12345"), deps());
  ok("an id that is not a container id is refused by name, before any call", bad.run.status === "error" && bad.state === "bad_id" && /not a Tag Manager container id/.test(bad.run.detail ?? ""));
  const noTok = await readGtmClient(ctx(), { ...deps(), token: null, tokenProblem: null });
  ok("with the service account missing the run is no_token and names the secret", noTok.run.status === "no_token" && /GOOGLE_SERVICE_ACCOUNT_JSON/.test(noTok.run.detail ?? ""));
  mode = "unlisted";
  const un = await readGtmClient(ctx(), deps());
  ok("a container the service account cannot see says so and says how to grant Read access", un.run.status === "error" && un.state === "not_listed" && /cannot see GTM-ABC123/.test(un.run.detail ?? "") && /Read access/.test(un.run.detail ?? ""));
  mode = "empty_account";
  const em = await readGtmClient(ctx(), deps());
  ok("a service account that sees nothing at all says that, not 'this container'", em.state === "not_listed" && /no Tag Manager containers at all/.test(em.run.detail ?? ""));
  mode = "disabled";
  const dis = await readGtmClient(ctx(), deps());
  ok("a disabled API is its own message, because the fix is a different one", dis.state === "api_disabled" && /not switched on in the Google Cloud project/.test(dis.run.detail ?? ""));
  mode = "forbidden_version";
  const fv = await readGtmClient(ctx(), deps());
  ok("a refused live version is no_access, named, with the grant instruction", fv.state === "no_access" && fv.run.status === "error" && /Read access/.test(fv.run.detail ?? ""));
  mode = "unpublished";
  const up = await readGtmClient(ctx(), deps());
  ok("a container never published is no_data with its own state, not an error and not 'no tags'", up.run.status === "no_data" && up.state === "no_live_version" && up.facts === null && up.failed === false);
  mode = "server_error";
  const se = await readGtmClient(ctx(), deps());
  ok("a server error ends as an error that carries no key or token", se.run.status === "error" && se.state === "error" && !(se.run.detail ?? "").includes(SECRET) && !(se.run.detail ?? "").includes(token));
  mode = "throttled_then_ok";
  throttle = 0;
  const th = await readGtmClient(ctx(), deps());
  ok("a throttled answer is retried and then read", th.run.status === "ok");
  mode = "ok";

  const calls = gtm.calls.filter((c) => c.path !== "/token");
  ok("every call to Tag Manager is a GET", calls.every((c) => c.method === "GET"), calls.filter((c) => c.method !== "GET").map((c) => c.method).join(","));
  ok("every call carries the bearer token and nothing in the address", calls.every((c) => c.headers.authorization === `Bearer ${token}` && !/[?&](key|token|access_token)=/.test(c.path)));
  const tokenCalls = gtm.calls.filter((c) => c.path === "/token");
  ok("the only scope ever asked for is the read-only one", tokenCalls.length >= 1 && tokenCalls.every((c) => (JSON.parse(c.body) as { scope: string }).scope === GTM_SCOPE) && GTM_SCOPE === "https://www.googleapis.com/auth/tagmanager.readonly");
  await gtm.close();
  delete process.env.SIGNALS_FAKE_BASE;

  /* ───────────────────────── 3. what is written ───────────────────────── */
  hr("3. the writes");
  const rec = recorder();
  await writeFacts(rec, "c1", "GTM-ABC123", "accounts/111/containers/222", version, facts, null, NOW);
  await writeFailed(rec, "c1", "GTM-ABC123", "not_listed", NOW);
  const colsOf = (sql: string) => (sql.match(/INSERT INTO \w+\s*\(([^)]*)\)/s)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  ok("the facts INSERT names 11 columns and sends 11 parameters", colsOf(UPSERT_FACTS).length === 11 && rec.calls[0]!.params.length === 11);
  ok("the failed INSERT names the same 11 columns and sends only what it knows (5 parameters)", colsOf(UPSERT_FAILED).join() === colsOf(UPSERT_FACTS).join() && rec.calls[1]!.params.length === 5);
  ok("both are upserts on the client, so there is one row a client", /ON CONFLICT \(client_id\)/.test(UPSERT_FACTS) && /ON CONFLICT \(client_id\)/.test(UPSERT_FAILED));
  ok("a FAILED read changes the status columns only: the last good facts and their date stay", (() => {
    const set = UPSERT_FAILED.match(/DO UPDATE SET([\s\S]*)$/)?.[1] ?? "";
    return /ok = false/.test(set) && /error_state/.test(set) && !/tags_json|version_id|version_name|published_at|read_at|container_path/.test(set);
  })());
  ok("the stored facts are the declared facts and carry none of the poison", !JSON.stringify(rec.calls).includes(POISON_BODY) && !JSON.stringify(rec.calls).includes(POISON_VALUE) && !JSON.stringify(rec.calls).includes(SECRET));
  const forbidden = /(visitor|person|ip_|email|phone|user|cookie|session|html|body|secret|token|label_value)/i;
  ok("no column could hold a person, a secret or a custom HTML body", !colsOf(UPSERT_FACTS).some((c) => forbidden.test(c)), colsOf(UPSERT_FACTS).filter((c) => forbidden.test(c)).join(","));
  selfTest("the forbidden-column scan can fail", (x) => !forbidden.test(x), "tags_json", "custom_html_body");

  /* ───────────────────────── 4. secrets, the entry, the workflow ───────────────────────── */
  hr("4. the secret is the existing one, the scope is the only one, the workflow is wired");
  const root = path.resolve(import.meta.dirname, "..");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*#.*$/gm, "");
  const wfc = code(fs.readFileSync(path.join(root, ".github/workflows/read-gtm.yml"), "utf8"));
  ok("the workflow is scheduled daily", /schedule:\s*\n\s*- cron: "\d+ \d+ \* \* \*"/.test(wfc));
  ok("it takes client_id and dry_run, requires neither, and a dispatch defaults to a dry run", /client_id:[\s\S]*?required: false/.test(wfc) && /dry_run:[\s\S]*?required: false[\s\S]*?default: "true"/.test(wfc));
  ok("a scheduled run is a real one (the dry-run default applies to a hand dispatch only)", /github\.event_name == 'workflow_dispatch' && inputs\.dry_run \|\| 'false'/.test(wfc));
  ok("the heartbeat runs even when the job failed, and not for a dry or scoped run", /Heartbeat[\s\S]*?if: always\(\) && inputs\.dry_run != 'true' && inputs\.client_id == ''/.test(wfc));
  ok("the heartbeat is named read_gtm", /--job=read_gtm(?![\w])/.test(wfc));
  ok("the heartbeat note goes through an environment variable, not into the shell line", /NOTE: \$\{\{ steps\.run\.outputs\.summary \}\}/.test(wfc) && /--note="\$NOTE"/.test(wfc) && !/--note="\$\{\{/.test(wfc));
  selfTest("the heartbeat step is guarded by always()", (x) => /Heartbeat[\s\S]*?if: always\(\)/.test(x), "- name: Heartbeat\n  if: always() && x", "- name: Heartbeat\n  if: success() && x");
  ok("it never points the job at a pretend server", !/SIGNALS_FAKE_BASE/.test(wfc));
  const secretsPassed = Array.from(wfc.matchAll(/secrets\.([A-Z0-9_]+)/g)).map((m) => m[1]!).sort().join(", ");
  ok("the only secrets it passes are the database and the existing Google service account: no new secret", secretsPassed === "DATABASE_URL, DATABASE_URL, GOOGLE_SERVICE_ACCOUNT_JSON", secretsPassed);
  const src = ["src/gtm/api.ts", "src/gtm/run.ts", "src/gtm/store.ts", "src/gtm/types.ts", "src/read-gtm.ts"].map((f) => code(fs.readFileSync(path.join(root, f), "utf8")));
  ok("the readonly scope is the only Google scope named in the reader", src.every((x) => !/googleapis\.com\/auth\/(?!tagmanager\.readonly)/.test(x)) && /tagmanager\.readonly/.test(src[3]!));
  selfTest("the scope scan can fail", (x) => !/googleapis\.com\/auth\/(?!tagmanager\.readonly)/.test(x), "https://www.googleapis.com/auth/tagmanager.readonly", "https://www.googleapis.com/auth/tagmanager.edit.containers");
  ok("no write toward Tag Manager: no non-GET method and no mutate or publish endpoint", !src.some((x) => /method:\s*"(POST|PUT|PATCH|DELETE)"/i.test(x)) && !src.some((x) => /:(publish|create_version|move_tag_id|revert|reauthorize|set_latest)\b|\/(workspaces|tags|triggers|variables)\b/.test(x)));
  selfTest("the write-endpoint scan can fail", (x) => !/:(publish|create_version)\b/.test(x), "versions:live", "versions:publish");
  ok("only the live version is read: no workspace draft", src[0]!.includes("versions:live") && !/workspaces/.test(src[0]!));
  ok("the entry reads the container id from the 'gtm' connector row and skips churned and internal accounts in the query", /cm\.source = 'gtm'/.test(src[4]!) && /c\.status <> 'churned'/.test(src[4]!) && /c\.is_internal = false/.test(src[4]!));
  ok("the entry exits 1 when the service account is missing, naming the secret", /missing > 0[\s\S]*?process\.exit\(1\)/.test(src[4]!) && /SECRET_NAMES\.serviceAccount/.test(src[4]!));
  ok("a client with no container is written 'off' and never needs the service account", /status === "off"/.test(src[4]!));
  ok("a dry run writes nothing", /if \(dryRun\) continue;[\s\S]*?writeFacts/.test(src[4]!));
  ok("the source is registered with the shared status table", /"gtm"/.test(fs.readFileSync(path.join(root, "src/signals/common.ts"), "utf8")));
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  ok("CI runs this guard", /npm run verify-gtm(?![\w-])/.test(ci));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  ok("the scripts exist", Boolean(pkg.scripts["read-gtm"]) && Boolean(pkg.scripts["verify-gtm"]));

  console.log(failures ? `\n❌ ${failures} check(s) failed` : "\n✅ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

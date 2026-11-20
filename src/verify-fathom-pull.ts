#!/usr/bin/env tsx
/**
 * Guard for the Fathom call pull: what it asks Fathom, what it posts to the dashboard,
 * what it refuses to print, and how each way of failing ends.
 *
 * No Fathom, no dashboard, no database, no key. A pretend server (a real HTTP server on a
 * local port) plays BOTH Fathom's list API and the dashboard's webhook, and the real
 * runner and the real command-line entry talk to it through the real fetch.
 *
 * EVERY CALL, PERSON, ADDRESS, TITLE, SUMMARY AND KEY BELOW IS INVENTED.
 *
 * WHAT THIS CANNOT PROVE. Nothing here has run against Fathom. The list address, the
 * key header, the paging cursor and every field name are written from the published
 * reference as remembered; a green run means the code does what it says against the
 * shapes it expects, not that Fathom answers in them. docs/FATHOM-PULL.md (dashboard
 * repository) says what to read in the first dry run to confirm each one.
 *
 *   npx tsx src/verify-fathom-pull.ts
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { startFake, type Call, type Reply } from "./signals/fake-http.js";
import { buildWebhookBody, listUrl, matchesClient, parseListPage, ShapeChanged, type ListedMeeting } from "./fathom-pull/api.js";
import { runPull, summaryLine, type PullFetch } from "./fathom-pull/run.js";

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

// ── invented data ──
const FATHOM_KEY = "fk_test_0123456789abcdef";
const WEBHOOK_KEY = "wh_test_fedcba9876543210";
const SECRET_TITLE = "SECRET-TITLE-quarterly-with-acme";
const SECRET_SUMMARY = "SECRET-SUMMARY-they-want-a-refund";
const SECRET_ATTENDEE = "pat.person@secret-attendee.example";
const SECRET_TRANSCRIPT = "SECRET-TRANSCRIPT-line-one";

const meeting = (id: number, started: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  recording_id: id,
  title: `${SECRET_TITLE}-${id}`,
  meeting_title: `${SECRET_TITLE}-${id}`,
  url: `https://fathom.video/calls/${id}`,
  share_url: `https://fathom.video/share/tok${id}abcdef`,
  scheduled_start_time: started,
  recording_start_time: started,
  recording_end_time: started,
  created_at: started,
  transcript: [{ speaker: "x", text: SECRET_TRANSCRIPT }],
  recorded_by: { name: "Recorder One", email: id % 2 ? "rec.one@bsllc.example" : "rec.two@bsllc.example", email_domain: "bsllc.example", team: "Team" },
  calendar_invitees: [{ name: "Pat Person", email: SECRET_ATTENDEE, email_domain: "secret-attendee.example", is_external: true, phone: "5550100" }],
  calendar_invitees_domains_type: "one_external",
  default_summary: { template_name: "General", markdown_formatted: SECRET_SUMMARY, internal_note: "never-forward" },
  action_items: [{ description: "Send the deck", completed: false, recording_timestamp: "00:01:00", recording_playback_url: "https://fathom.video/x", assignee: { name: "Pat Person", email: SECRET_ATTENDEE, team: null, phone: "x" }, user_generated: false, extra: "never-forward" }],
  crm_matches: { companies: [{ name: "Acme" }] },
  unknown_future_field: "never-forward",
  ...extra,
});

// Three pages, oldest meeting last. Meeting 103 appears on pages 1 and 2 (a repeat).
const PAGES: Record<string, { items: Record<string, unknown>[]; next_cursor: string | null }> = {
  "": { items: [meeting(105, "2026-11-05T15:00:00Z"), meeting(104, "2026-11-04T15:00:00Z"), meeting(103, "2026-11-03T15:00:00Z")], next_cursor: "c2" },
  c2: { items: [meeting(103, "2026-11-03T15:00:00Z"), meeting(102, "2026-11-02T15:00:00Z")], next_cursor: "c3" },
  c3: { items: [meeting(101, "2026-11-01T15:00:00Z")], next_cursor: null },
};

interface Plan {
  fathom?: (c: Call, n: number) => Reply | undefined;
  app?: (c: Call, n: number) => Reply | undefined;
}
async function world(plan: Plan = {}) {
  let listN = 0, postN = 0;
  const fake = await startFake((c) => {
    if (c.path.startsWith("/fathom/meetings")) {
      listN += 1;
      const o = plan.fathom?.(c, listN);
      if (o) return o;
      const cur = new URL(c.path, "http://x").searchParams.get("cursor") ?? "";
      return { body: PAGES[cur] ?? { items: [], next_cursor: null } };
    }
    if (c.path === "/api/fathom-webhook") {
      postN += 1;
      return plan.app?.(c, postN) ?? { body: { ok: true } };
    }
    return undefined;
  });
  const fetchFn: PullFetch = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<PullFetch>;
  const sleeps: number[] = [];
  const deps = (known?: (ids: string[]) => Promise<Set<string>>) => ({
    fetchFn, known, sleep: async (ms: number) => { sleeps.push(ms); }, listGapMs: 0, postGapMs: 0,
  });
  const opts = (over: Record<string, unknown> = {}) => ({
    fathomKey: FATHOM_KEY, webhookKey: WEBHOOK_KEY, fathomBase: `${fake.base}/fathom`, appBase: fake.base,
    since: "2025-01-01", dryRun: false, ...over,
  });
  return { fake, deps, opts, sleeps, posts: () => fake.calls.filter((c) => c.method === "POST" && c.path === "/api/fathom-webhook"), lists: () => fake.calls.filter((c) => c.path.startsWith("/fathom/")) };
}

/** The real entry, as a child process. ASYNC on purpose: the pretend server lives in this process, and a blocking spawn would stop it answering. */
function runCli(args: string[], env: Record<string, string | undefined>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cwd = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const child = spawn("npx", ["tsx", "src/pull-fathom-calls.ts", ...args], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as Record<string, string> });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function main() {
  // ── 1. paging, the request, the repeat ──
  hr("1. Paging and the request");
  {
    const w = await world();
    const r = await runPull(w.deps(), w.opts());
    ok("three pages are read", r.pages === 3, `pages ${r.pages}`);
    ok("a repeated meeting is counted once", r.found === 5 && r.posted === 5, `found ${r.found}, posted ${r.posted}`);
    ok("no cause on a clean run", r.cause === null);
    const l = w.lists();
    ok("every call to Fathom is a GET", l.length === 3 && l.every((c) => c.method === "GET"));
    ok("the key goes in the header, never in the address", l.every((c) => c.headers["x-api-key"] === FATHOM_KEY && !c.path.includes(FATHOM_KEY)));
    ok("the window starts at the since day", l.every((c) => new URL(c.path, "http://x").searchParams.get("created_after") === "2025-01-01T00:00:00Z"));
    ok("the cursor is followed", new URL(l[1]!.path, "http://x").searchParams.get("cursor") === "c2" && new URL(l[2]!.path, "http://x").searchParams.get("cursor") === "c3");
    ok("the summary and action items are asked for; the transcript is not", l.every((c) => /include_summary=true/.test(c.path) && /include_action_items=true/.test(c.path) && !/transcript/.test(c.path)));
    ok("recorders are counted as a number", r.recorders === 2);
    await w.fake.close();
  }

  // ── 2. what is posted ──
  hr("2. What is posted to the dashboard");
  {
    const w = await world();
    await runPull(w.deps(), w.opts());
    const posts = w.posts();
    ok("every call is a POST to the webhook with the webhook key in the header", posts.length === 5 && posts.every((p) => p.headers["x-fathom-key"] === WEBHOOK_KEY && !p.path.includes("key=")));
    const bodies = posts.map((p) => JSON.parse(p.body) as Record<string, unknown>);
    ok("the body carries the fields the webhook sends", bodies.every((b) => b.recording_id !== undefined && b.meeting_title && b.scheduled_start_time && b.recorded_by && Array.isArray(b.calendar_invitees) && b.default_summary && Array.isArray(b.action_items) && b.url));
    ok("the recording id is a number where it is digits", bodies.every((b) => typeof b.recording_id === "number"));
    const all = posts.map((p) => p.body).join("\n");
    ok("the transcript is never forwarded", !all.includes(SECRET_TRANSCRIPT) && bodies.every((b) => !("transcript" in b)));
    ok("a field this build does not name is never forwarded", !all.includes("never-forward") && !all.includes("unknown_future_field") && !all.includes("5550100"));
    const order = bodies.slice(0, 3).map((b) => b.recording_id);
    ok("within a page the oldest call is posted first", JSON.stringify(order) === JSON.stringify([103, 104, 105]), JSON.stringify(order));
    await w.fake.close();
  }

  // ── 3. idempotent re-run ──
  hr("3. A second run files nothing twice");
  {
    const w = await world();
    const stored = new Set<string>();
    const known = async (ids: string[]) => new Set(ids.filter((i) => stored.has(i)));
    const first = await runPull(w.deps(known), w.opts());
    for (const p of w.posts()) stored.add(String((JSON.parse(p.body) as { recording_id: number }).recording_id));
    const postsAfterFirst = w.posts().length;
    const second = await runPull(w.deps(known), w.opts());
    ok("the first run posts all five", first.posted === 5 && first.alreadyThere === 0);
    ok("the second run posts none and counts five as already there", second.posted === 0 && second.alreadyThere === 5 && w.posts().length === postsAfterFirst, `already ${second.alreadyThere}`);
    const down = await runPull(w.deps(async () => { throw new Error("db down"); }), w.opts());
    ok("a known-call check that cannot be asked is said, and the run still posts", down.knownCheck === "unavailable" && down.posted === 5 && down.cause === null);
    ok("the summary says so", /could not be asked/.test(summaryLine(down)));
    await w.fake.close();
  }

  // ── 4. a dry run posts nothing ──
  hr("4. A dry run posts nothing");
  {
    const w = await world();
    const r = await runPull(w.deps(), w.opts({ dryRun: true, webhookKey: null }));
    ok("no POST of any kind", w.posts().length === 0 && w.fake.calls.every((c) => c.method === "GET"));
    ok("it counts what it would post, and needs no webhook key", r.posted === 5 && r.found === 5 && r.cause === null);
    ok("its summary says would post", /would post 5/.test(summaryLine(r)));
    await w.fake.close();
  }

  // ── 5. the failures, each a named cause ──
  hr("5. Each way of failing is a named cause");
  {
    const w0 = await world();
    ok("no Fathom key → no_fathom_key, nothing asked", (await runPull(w0.deps(), w0.opts({ fathomKey: null }))).cause === "no_fathom_key" && w0.fake.calls.length === 0);
    ok("no webhook key on a live run → no_webhook_key, nothing asked", (await runPull(w0.deps(), w0.opts({ webhookKey: null }))).cause === "no_webhook_key" && w0.fake.calls.length === 0);
    ok("a bad since day → bad_since", (await runPull(w0.deps(), w0.opts({ since: "2025-02-31" }))).cause === "bad_since");
    ok("a bad dashboard address → bad_app_address", (await runPull(w0.deps(), w0.opts({ appBase: "ftp://x" }))).cause === "bad_app_address");
    await w0.fake.close();

    const w401 = await world({ fathom: () => ({ status: 401, body: { error: "no" } }) });
    const r401 = await runPull(w401.deps(), w401.opts());
    ok("Fathom 401 → fathom_401, not retried", r401.cause === "fathom_401" && w401.lists().length === 1);
    await w401.fake.close();
    const w403 = await world({ fathom: () => ({ status: 403, body: "no" }) });
    ok("Fathom 403 → fathom_403", (await runPull(w403.deps(), w403.opts())).cause === "fathom_403");
    await w403.fake.close();

    const w429 = await world({ fathom: (_c, n) => (n <= 2 ? { status: 429, body: "slow", headers: { "retry-after": "7" } } : undefined) });
    const r429 = await runPull(w429.deps(), w429.opts());
    ok("a 429 is waited out (Retry-After honoured) and the run completes", r429.cause === null && r429.posted === 5 && w429.sleeps.includes(7000), `sleeps ${w429.sleeps.slice(0, 3).join(",")}`);
    await w429.fake.close();
    const w429b = await world({ fathom: () => ({ status: 429, body: "slow" }) });
    const r429b = await runPull(w429b.deps(), w429b.opts());
    ok("a 429 that never ends → fathom_429 after five tries", r429b.cause === "fathom_429" && w429b.lists().length === 5);
    ok("the waits between tries grow", w429b.sleeps[0]! < w429b.sleeps[3]!);
    await w429b.fake.close();

    const w500 = await world({ fathom: (_c, n) => (n === 1 ? { status: 503, body: "x" } : undefined) });
    ok("a 5xx is retried and the run completes", (await runPull(w500.deps(), w500.opts())).cause === null);
    await w500.fake.close();
    const w500b = await world({ fathom: () => ({ status: 502, body: "x" }) });
    ok("a 5xx that never ends → fathom_5xx", (await runPull(w500b.deps(), w500b.opts())).cause === "fathom_5xx");
    await w500b.fake.close();

    const wShape = await world({ fathom: () => ({ body: { meetings: [] } }) });
    ok("an answer with no items list → shape_changed (not 'no meetings')", (await runPull(wShape.deps(), wShape.opts())).cause === "shape_changed");
    await wShape.fake.close();
    const wShape2 = await world({ fathom: () => ({ body: { items: [{ nothing: 1 }, { alsoNothing: 2 }], next_cursor: null } }) });
    ok("a page where no item has a recording id → shape_changed", (await runPull(wShape2.deps(), wShape2.opts())).cause === "shape_changed");
    await wShape2.fake.close();
    const wShape3 = await world({ fathom: () => ({ body: "<html>maintenance</html>" }) });
    ok("a page that is not JSON → shape_changed", (await runPull(wShape3.deps(), wShape3.opts())).cause === "shape_changed");
    await wShape3.fake.close();
    const wMixed = await world({ fathom: () => ({ body: { items: [meeting(1, "2026-01-01T00:00:00Z"), { nope: true }], next_cursor: null } }) });
    const rMixed = await runPull(wMixed.deps(), wMixed.opts());
    ok("one unreadable item among good ones counts as failed and ends posts_failed", rMixed.unreadable === 1 && rMixed.posted === 1 && rMixed.cause === "posts_failed");
    await wMixed.fake.close();

    const wLoop = await world({ fathom: (_c, n) => ({ body: { items: [meeting(900 + n, "2026-01-01T00:00:00Z")], next_cursor: `more${n}` } }) });
    const rLoop = await runPull(wLoop.deps(), wLoop.opts({ maxPages: 3 }));
    ok("a list that never ends → too_many_pages after exactly the page limit", rLoop.cause === "too_many_pages" && rLoop.pages === 3 && wLoop.lists().length === 3);
    const wSame = await world({ fathom: () => ({ body: { items: [meeting(9, "2026-01-01T00:00:00Z")], next_cursor: "same" } }) });
    const rSame = await runPull(wSame.deps(), wSame.opts());
    ok("a cursor that repeats itself ends the list instead of looping", rSame.cause === null && rSame.pages === 2);
    await wSame.fake.close();
    await wLoop.fake.close();

    const wApp401 = await world({ app: () => ({ status: 401, body: { message: "Bad key" } }) });
    const rApp401 = await runPull(wApp401.deps(), wApp401.opts());
    ok("the dashboard refusing the key → app_401, run stops at once", rApp401.cause === "app_401" && wApp401.posts().length === 1);
    await wApp401.fake.close();
    const wApp503 = await world({ app: () => ({ status: 503, body: { message: "Webhook not configured" } }) });
    ok("the dashboard's webhook not configured → app_503", (await runPull(wApp503.deps(), wApp503.opts())).cause === "app_503");
    await wApp503.fake.close();

    const wPost = await world({ app: (c) => (JSON.parse(c.body).recording_id === 104 ? { status: 500, body: "boom" } : undefined) });
    const rPost = await runPull(wPost.deps(), wPost.opts());
    ok("one call that cannot be posted is retried three times, counted, and the others still go", rPost.failed === 1 && rPost.posted === 4 && wPost.posts().filter((p) => JSON.parse(p.body).recording_id === 104).length === 3);
    ok("and the run ends posts_failed so the heartbeat is red", rPost.cause === "posts_failed");
    await wPost.fake.close();
    const wDown = await world({ app: () => ({ status: 500, body: "boom" }) });
    ok("five failures in a row → app_unreachable", (await runPull(wDown.deps(), wDown.opts())).cause === "app_unreachable");
    await wDown.fake.close();
    const wBad = await world({ app: () => ({ status: 400, body: "bad" }) });
    const rBad = await runPull(wBad.deps(), wBad.opts());
    ok("a 400 is not retried", rBad.failed >= 1 && wBad.posts().length >= 1 && wBad.posts().length <= 5 && rBad.posted === 0);
    await wBad.fake.close();
  }

  // ── 6. one client ──
  hr("6. A one-client run");
  {
    const h = { names: ["Acme Holdings"], domains: ["secret-attendee.example"] };
    const w = await world();
    const r = await runPull(w.deps(), w.opts({ matches: (m: ListedMeeting) => matchesClient(m, h) }));
    ok("calls that name the client by an invitee's domain are posted", r.posted === 5 && r.outOfScope === 0);
    const w2 = await world();
    const none = { names: ["Nobody Corp"], domains: ["elsewhere.example"] };
    const r2 = await runPull(w2.deps(), w2.opts({ matches: (m: ListedMeeting) => matchesClient(m, none) }));
    ok("calls that do not are counted and not posted", r2.posted === 0 && r2.outOfScope === 5 && w2.posts().length === 0);
    const byTitle = matchesClient({ recordingId: "1", raw: { meeting_title: "Weekly with Acme-Holdings" }, startedAt: null, recordedByEmail: null }, { names: ["Acme Holdings"], domains: [] });
    ok("a name in the title matches on letters and digits only", byTitle);
    ok("a two-letter name never matches", !matchesClient({ recordingId: "1", raw: { meeting_title: "OK then" }, startedAt: null, recordedByEmail: null }, { names: ["OK"], domains: [] }));
    await w.fake.close(); await w2.fake.close();
  }

  // ── 7. pure parts ──
  hr("7. The parser and the builder");
  {
    let threw = false;
    try { parseListPage({ items: "x" }); } catch (e) { threw = e instanceof ShapeChanged; }
    ok("a non-list items value is a shape change", threw);
    ok("an empty list is a real, empty answer", parseListPage({ items: [], next_cursor: null }).items.length === 0);
    ok("a missing cursor ends the list", parseListPage({ items: [meeting(1, "2026-01-01T00:00:00Z")] }).nextCursor === null);
    {
      const keys = [...new URL(listUrl({ base: "https://x/v1", createdAfter: "2025-01-01T00:00:00Z", cursor: "ab" })).searchParams.keys()].sort().join(",");
      ok("the list address carries only the declared parameters, never a key", keys === "created_after,cursor,include_action_items,include_crm_matches,include_summary", keys);
    }
    ok("the list address carries the window and the cursor", /created_after=2025-01-01T00%3A00%3A00Z/.test(listUrl({ base: "https://x/v1", createdAfter: "2025-01-01T00:00:00Z", cursor: "ab" })) && /cursor=ab/.test(listUrl({ base: "https://x/v1/", createdAfter: "z", cursor: "ab" })));
    const b = buildWebhookBody({ recordingId: "42", raw: { title: "T", recorded_by: { email: "a@b.c", ssn: "x" } }, startedAt: null, recordedByEmail: null });
    ok("a title-only meeting still gets a meeting_title", b.meeting_title === "T");
    ok("an address-shaped id stays a string", typeof buildWebhookBody({ recordingId: "abc-1", raw: {}, startedAt: null, recordedByEmail: null }).recording_id === "string");
  }

  // ── 8. the real command line ──
  hr("8. The command-line entry");
  {
    const w = await world();
    const run = (args: string[], env: Record<string, string | undefined>, base = w.fake.base) => runCli(args, { FATHOM_FAKE_BASE: base, ...env });
    const keys = { FATHOM_API_KEY: FATHOM_KEY, FATHOM_WEBHOOK_KEY: WEBHOOK_KEY };
    const good = await run(["--since=2025-01-01"], keys);
    const goodOut = `${good.stdout}\n${good.stderr}`;
    ok("a good run exits 0 and prints counts", good.status === 0 && /found 5, already there 0, posted 5, failed 0/.test(good.stdout), `exit ${good.status}`);
    ok("the log holds no title, summary, transcript, attendee address or key", ![SECRET_TITLE, SECRET_SUMMARY, SECRET_TRANSCRIPT, SECRET_ATTENDEE, FATHOM_KEY, WEBHOOK_KEY, "Pat Person", "Recorder One"].some((s) => goodOut.includes(s)));
    const postsBefore = w.posts().length;
    const dry = await run(["--since=2025-01-01", "--dry-run"], { FATHOM_API_KEY: FATHOM_KEY });
    ok("a dry run exits 0, says so, and posts nothing", dry.status === 0 && /DRY RUN/.test(dry.stdout) && /would post 5/.test(dry.stdout) && w.posts().length === postsBefore);
    const noKey = await run([], { FATHOM_WEBHOOK_KEY: WEBHOOK_KEY });
    const lastErr = noKey.stderr.trim().split("\n").pop() ?? "";
    ok("no Fathom key exits 1 and the last line is the named cause", noKey.status === 1 && /^no_fathom_key: FATHOM_API_KEY is not set/.test(lastErr), lastErr.slice(0, 60));
    const badSince = await run(["--since=nope"], keys);
    ok("a bad since exits 1 with its cause", badSince.status === 1 && /^bad_since:/.test(badSince.stderr.trim().split("\n").pop() ?? ""));
    await w.fake.close();
    const w401 = await world({ fathom: () => ({ status: 401, body: "x" }) });
    const r401 = await runCli([], { FATHOM_FAKE_BASE: w401.fake.base, ...keys });
    ok("a refused key exits 1 with fathom_401 as the last line", r401.status === 1 && /^fathom_401:/.test(r401.stderr.trim().split("\n").pop() ?? ""));
    await w401.fake.close();
  }

  // ── 9. source guards ──
  hr("9. Where the secrets live, what the workflow does, what CI runs");
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const wf = read(".github/workflows/pull-fathom-calls.yml");
  const wfc = wf.replace(/^\s*#.*$/gm, "");
  const ci = read(".github/workflows/ci.yml");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  const readers = (text: string) => /process\.env\.FATHOM_(API|WEBHOOK)_KEY|process\.env\[["']FATHOM_(API|WEBHOOK)_KEY/.test(text);
  selfTest("a file that reads a Fathom secret is caught", readers, "const k = process.env.FATHOM_API_KEY;", "const k = fathomApiKey();");
  const srcFiles: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { if (e.isDirectory()) walk(`${d}/${e.name}`); else if (e.name.endsWith(".ts")) srcFiles.push(`${d}/${e.name}`); } };
  walk("src");
  const offenders = srcFiles.filter((f) => !f.endsWith("signals/secrets.ts") && !f.endsWith("verify-fathom-pull.ts") && readers(strip(read(f))));
  ok("no file but signals/secrets.ts reads a Fathom secret", offenders.length === 0, offenders.join(", "));
  ok("the secrets are scrubbed from every printed error", /fathomApi/.test(read("src/signals/secrets.ts")) && /fathomWebhook/.test(read("src/signals/secrets.ts")) && /Object\.values\(SECRET_NAMES\)/.test(read("src/signals/secrets.ts")));

  selfTest("the workflow has a schedule before the dashboard's 12:40 run", (t) => /cron:\s*"(\d+) 12 \* \* \*"/.test(t) && Number(/cron:\s*"(\d+) 12/.exec(t)![1]) < 40, 'cron: "5 12 * * *"', 'cron: "50 12 * * *"');
  ok("the workflow runs daily ahead of the dashboard's call-linking run", /cron:\s*"(\d+) 12 \* \* \*"/.test(wfc) && Number(/cron:\s*"(\d+) 12/.exec(wfc)![1]) < 40);
  ok("the workflow can be dispatched with client, since and dry_run", /workflow_dispatch:/.test(wfc) && /^\s+client:/m.test(wfc) && /^\s+since:/m.test(wfc) && /^\s+dry_run:/m.test(wfc));
  ok("dry_run defaults to true", /dry_run:\s*\n(?:\s+\w+:.*\n)*?\s+default:\s*"true"/.test(wf));
  ok("since defaults to 2025-01-01 for the catch-up", /since:\s*\n(?:\s+\w+:.*\n)*?\s+default:\s*"2025-01-01"/.test(wf));
  ok("the workflow gives the job both secrets and the database", /FATHOM_API_KEY: \$\{\{ secrets\.FATHOM_API_KEY \}\}/.test(wfc) && /FATHOM_WEBHOOK_KEY: \$\{\{ secrets\.FATHOM_WEBHOOK_KEY \}\}/.test(wfc) && /DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/.test(wfc));
  ok("inputs reach the command through the environment, never inline", /IN_CLIENT: \$\{\{ inputs\.client \}\}/.test(wfc) && !/run:[^\n]*\$\{\{ inputs\./.test(wfc));
  ok("the workflow never sets the test seam", !/FATHOM_FAKE_BASE/.test(wfc));
  const hb = /name: Heartbeat[\s\S]*$/.exec(wfc)?.[0] ?? "";
  ok("the heartbeat is pull_fathom_calls", /--job=pull_fathom_calls(?![\w])/.test(hb));
  ok("the heartbeat runs on failure too (if: always())", /if:\s*always\(\)/.test(hb));
  ok("a dry run and a one-client run stamp no heartbeat", /inputs\.dry_run != 'true'/.test(hb) && /inputs\.client == ''/.test(hb));
  ok("the heartbeat carries the log so a failure names its cause", /--log=run\.log/.test(hb));
  ok("the pull step's last line is what the heartbeat reads (tee to run.log, pipefail)", /set -o pipefail/.test(wfc) && /tee run\.log/.test(wfc));
  ok("the command is in package.json and the guard is in CI", pkg.scripts["pull-fathom-calls"] === "tsx src/pull-fathom-calls.ts" && /npm run verify-fathom-pull/.test(ci));

  const runner = strip(read("src/fathom-pull/run.ts"));
  const entry = strip(read("src/pull-fathom-calls.ts"));
  const verbs = (t: string) => (t.match(/method:\s*"(GET|POST|PUT|PATCH|DELETE)"/g) ?? []).map((v) => v.replace(/\D*"(\w+)"/, "$1")).sort().join(",");
  selfTest("the verb check sees a stray write", (t) => verbs(t) === "GET,POST", 'method: "GET" method: "POST"', 'method: "GET" method: "POST" method: "DELETE"');
  ok("the runner makes exactly one kind of call to Fathom (GET) and one to the dashboard (POST)", verbs(runner) === "GET,POST");
  ok("the POST is to the dashboard's webhook", /fetchFn\(`\$\{appBase\}\/api\/fathom-webhook`,\s*\{\s*method: "POST"/.test(runner));
  ok("nothing is written to the database by this job", !/\b(INSERT|UPDATE|DELETE)\b/.test(entry) && !/db\.query\(\s*`(INSERT|UPDATE|DELETE)/i.test(entry));
  ok("the log lines print counts, not call fields", !/console\.(log|error)\([^)]*(title|summary|transcript|email|name)\b/i.test(runner));
  const apiSrc = strip(read("src/fathom-pull/api.ts"));
  ok("the transcript is never requested and never in the allowlist", !/include_transcript/.test(apiSrc) && !/["']transcript["']/.test(apiSrc));

  console.log(`\n${failures === 0 ? "✅ All checks passed" : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

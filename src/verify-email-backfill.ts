#!/usr/bin/env tsx
/**
 * Guard for the scoped email-body backfill.
 *
 * No mailbox, no credential, no network, no database: it drives the real
 * functions over fixtures and reads the real workflow file. EVERY ADDRESS,
 * MESSAGE ID AND FILENAME BELOW IS INVENTED — there is no Gmail access and no
 * production database in this sandbox, so nothing here was measured.
 *
 * THE PROPERTIES THIS EXISTS TO HOLD, each with a planted failure beside it:
 *
 *   A. THE ORIGINAL GMAIL ID IS WHAT IS EMITTED when the fallback search finds
 *      a copy in a different mailbox. The dashboard upserts on
 *      (source, external_id); emitting the found id would insert a SECOND row
 *      for an email already logged, and the importer's own cross-mailbox
 *      dedupe would then drop it as a duplicate and store no body at all.
 *      This is the single subtlest thing in the file.
 *   B. THE ORIGINAL MAILBOX IS WHAT IS EMITTED when there was a hint, because
 *      `created_by` on an inbound row IS that mailbox and reporting another
 *      would quietly re-attribute who received the email.
 *   C. THE HINTED MAILBOX IS TRIED FIRST, and a 404 from it is ordinary rather
 *      than fatal — `created_by` on an outbound row is the resolved sender,
 *      which is not always the mailbox the copy was read from.
 *   D. NOTHING IS FETCHED THAT THE MANIFEST DOES NOT NAME. The scope rule
 *      lives in the dashboard; this file may never widen it.
 *   E. AN EMPTY MANIFEST IS AN ANSWER, NOT A FAULT. It is what finishing looks
 *      like, and it must exit 0.
 *   F. A MESSAGE WITH NO HINT AND NO RFC MESSAGE-ID CANNOT BE FOUND, and is
 *      reported rather than searched for in every mailbox on a guess.
 *   G. THE WORKFLOW IS DISPATCH-ONLY AND DRY BY DEFAULT.
 *   H. NO ATTACHMENT CONTENT IS EVER REQUESTED.
 *
 *   npx tsx src/verify-email-backfill.ts
 */
import { readFileSync } from "node:fs";
import { bareMessageId, fetchOne, parseArgs, readManifest, rfcQuery } from "./backfill-email-bodies.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);

const SRC = readFileSync(new URL("./backfill-email-bodies.ts", import.meta.url), "utf8");
const WORKFLOW = readFileSync(new URL("../.github/workflows/backfill-email-bodies.yml", import.meta.url), "utf8");

const OURS = "dana.reyes@bsllc.biz";
const OTHER_OURS = "sam.okafor@bsllc.biz";
const SA = { client_email: "invented-sa@invented.example", private_key: "not-a-key" };

/** A fake Gmail, so `fetchOne` can be driven with no credential. It records
 *  every path asked for, which is how "nothing outside the manifest" is
 *  checked rather than asserted. */
function fakeGmail(holdings: Record<string, Record<string, unknown>>) {
  const asked: string[] = [];
  const tokens = new Map<string, string>(Object.keys(holdings).map((m) => [m, `token-for-${m}`]));
  const original = (globalThis as { fetch: typeof fetch }).fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    asked.push(u);
    const auth = init?.headers?.Authorization ?? "";
    const mailbox = Object.keys(holdings).find((m) => auth.includes(`token-for-${m}`)) ?? "";
    const box = holdings[mailbox] ?? {};
    const getMatch = /\/messages\/([^?]+)\?format=full/.exec(u);
    if (getMatch) {
      const msg = box[decodeURIComponent(getMatch[1])];
      if (!msg) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(msg), { status: 200 });
    }
    const listMatch = /\/messages\?q=([^&]+)/.exec(u);
    if (listMatch) {
      const q = decodeURIComponent(listMatch[1]);
      const rfc = q.replace(/^rfc822msgid:/, "");
      const hit = Object.entries(box).find(([, m]) => (m as { _rfc?: string })._rfc === rfc);
      return new Response(JSON.stringify(hit ? { messages: [{ id: hit[0] }] } : {}), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { asked, tokens, restore: () => { (globalThis as { fetch: typeof fetch }).fetch = original; } };
}

const message = (id: string, rfc: string, words: string) => ({
  id,
  threadId: `thread-${id}`,
  _rfc: rfc,
  snippet: words.slice(0, 40),
  internalDate: "1758000000000",
  labelIds: ["INBOX"],
  payload: {
    headers: [
      { name: "From", value: "Priya <priya@northgate-invented.example>" },
      { name: "To", value: OURS },
      { name: "Subject", value: "An invented subject" },
      { name: "Message-ID", value: `<${rfc}>` },
      { name: "Date", value: "Mon, 15 Sep 2026 09:00:00 +0000" },
    ],
    mimeType: "text/plain",
    body: { data: Buffer.from(words, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_") },
  },
});

console.log("Scoped email-body backfill — verification harness");
console.log("Nothing is fetched from Google. Every address and message below is invented.\n");

// ── 1. The manifest contract ───────────────────────────────────────────────
hr("1. A manifest is read strictly, and an empty one is an answer");
{
  const good = JSON.stringify({
    scope: { contactsInScope: 12, stillOutstanding: 40 },
    messages: [{ gmailId: " gm-1 ", messageId: "<A@invented.example>", mailboxHint: "Dana.Reyes@BSLLC.biz", on: "2026-09-15" }],
  });
  const read = readManifest(good);
  ok("a gmail id is trimmed", read.messages[0].gmailId === "gm-1");
  ok("a mailbox hint is lower-cased", read.messages[0].mailboxHint === OURS);
  ok("the note says how much is still outstanding", /39 more are outstanding/.test(read.note), read.note);

  const empty = readManifest(JSON.stringify({ scope: {}, messages: [] }));
  ok("an EMPTY manifest reads cleanly — it is what finishing looks like", empty.messages.length === 0);

  let threw = false;
  try { readManifest("{ not json"); } catch { threw = true; }
  ok("a file that is not JSON is refused", threw);
  threw = false;
  try { readManifest(JSON.stringify({ messages: {} })); } catch { threw = true; }
  ok("a manifest with no messages array is refused", threw);
  threw = false;
  try { readManifest(JSON.stringify({ messages: [{ mailboxHint: OURS }] })); } catch { threw = true; }
  ok("a message with no gmailId is refused by index", threw);

  // Planted: a reader that accepted anything.
  let plantedThrew = false;
  try { readManifest(JSON.stringify({ messages: [{}] })); } catch { plantedThrew = true; }
  ok("SELF-TEST: a planted id-less message is caught", plantedThrew);
}

// ── 2. Arguments ───────────────────────────────────────────────────────────
hr("2. The arguments say what a run is");
{
  const a = parseArgs(["--manifest=/tmp/p.json", "--dry-run", "--limit=500", "--mailboxes=A@BSLLC.biz, b@bsllc.biz"]);
  ok("the manifest path is read", a.manifest === "/tmp/p.json");
  ok("dry run is a flag, not a value", a.dryRun === true);
  ok("a limit bounds the run", a.limit === 500);
  ok("mailboxes are lower-cased and trimmed", JSON.stringify(a.mailboxes) === JSON.stringify(["a@bsllc.biz", "b@bsllc.biz"]));
  ok("a nonsense limit is no limit rather than zero", parseArgs(["--limit=banana"]).limit === null);
  ok("no manifest is no manifest", parseArgs([]).manifest === null);
  ok("DRY RUN IS NOT THE DEFAULT IN THE SCRIPT — the workflow decides", parseArgs([]).dryRun === false);
}

// ── 3. The RFC search ──────────────────────────────────────────────────────
hr("3. The mailbox-independent id is what the fallback searches on");
{
  ok("angle brackets are stripped", bareMessageId("<abc@invented.example>") === "abc@invented.example");
  ok("the query is Gmail's own operator", rfcQuery("<abc@invented.example>") === "rfc822msgid:abc@invented.example");
}

// ── 4. The hint is tried first, and a miss is ordinary ─────────────────────
hr("4. The hinted mailbox is tried first (C)");
{
  const g = fakeGmail({
    [OURS]: { "gm-1": message("gm-1", "a@invented.example", "the invented words of an email") },
    [OTHER_OURS]: {},
  });
  const calls = { gets: 0, lists: 0 };
  const got = await fetchOne(
    { gmailId: "gm-1", messageId: "<a@invented.example>", mailboxHint: OURS },
    [OURS, OTHER_OURS], g.tokens, SA, calls,
  );
  g.restore();
  ok("the message comes back", got?.id === "gm-1");
  ok("the body came with it", got?.bodyText === "the invented words of an email");
  ok("ONE call was made — the hint hit, so no search happened", calls.gets === 1 && calls.lists === 0);
  ok("no other mailbox was touched", g.asked.every((u) => !u.includes(OTHER_OURS)));
}

// ── 5. THE SUBTLEST RULE: the original id survives the fallback (A, B) ─────
hr("5. A copy found elsewhere is emitted under the ORIGINAL id and mailbox (A, B)");
{
  // The stored Gmail id is not valid in the hinted mailbox any more; a copy of
  // the same email lives in another one under a DIFFERENT Gmail id.
  const g = fakeGmail({
    [OURS]: {},
    [OTHER_OURS]: { "gm-999-different": message("gm-999-different", "a@invented.example", "the same invented email") },
  });
  const calls = { gets: 0, lists: 0 };
  const got = await fetchOne(
    { gmailId: "gm-1", messageId: "<a@invented.example>", mailboxHint: OURS },
    [OURS, OTHER_OURS], g.tokens, SA, calls,
  );
  g.restore();
  ok("the message is found", got !== null);
  ok(
    "IT IS EMITTED UNDER THE STORED ID, so the import refreshes the row that exists",
    got?.id === "gm-1",
    `got ${got?.id}`,
  );
  ok(
    "IT IS EMITTED UNDER THE HINTED MAILBOX, so created_by is not re-attributed",
    got?.mailbox === OURS,
    `got ${got?.mailbox}`,
  );
  ok("the body is the one that was found", got?.bodyText === "the same invented email");
  ok("it cost a failed get, a search and a get", calls.gets === 2 && calls.lists >= 1);

  // Planted: emitting what was found. The dashboard would insert a second row
  // for an email already logged, and then drop it as a duplicate copy.
  const plantedId = "gm-999-different";
  ok("SELF-TEST: emitting the found id would be caught here", plantedId !== got?.id);
  ok(
    "SELF-TEST: the source really does re-point the id, rather than passing the fetch through",
    /id:\s*m\.gmailId/.test(SRC) && /mailbox:\s*m\.mailboxHint\s*\?\?/.test(SRC),
  );
}

// ── 6. Nothing outside the manifest, and nothing findable without a key ────
hr("6. Nothing the manifest does not name is fetched (D, F)");
{
  const g = fakeGmail({
    [OURS]: {
      "gm-1": message("gm-1", "a@invented.example", "wanted"),
      "gm-2": message("gm-2", "b@invented.example", "NOT WANTED — not on the manifest"),
    },
  });
  const calls = { gets: 0, lists: 0 };
  await fetchOne({ gmailId: "gm-1", messageId: "<a@invented.example>", mailboxHint: OURS }, [OURS], g.tokens, SA, calls);
  g.restore();
  ok("only the named message was asked for", g.asked.every((u) => !u.includes("gm-2")));
  ok("no listing of a mailbox's traffic was made at all", g.asked.every((u) => !/messages\?q=(?!rfc822msgid)/.test(u)));

  const g2 = fakeGmail({ [OURS]: {} });
  const calls2 = { gets: 0, lists: 0 };
  const none = await fetchOne({ gmailId: "gm-x", messageId: null, mailboxHint: null }, [OURS], g2.tokens, SA, calls2);
  g2.restore();
  ok("a message with no hint and no RFC id is reported, not hunted for", none === null && calls2.gets === 0 && calls2.lists === 0);
  ok("SELF-TEST: a hunt would have shown up as a call", g2.asked.length === 0);
}

// ── 7. Attachment content is never requested (H) ───────────────────────────
hr("7. Attachment bytes are never asked for (H)");
{
  ok("no attachments.get call appears in the source", !/messages\/[^"'`]*\/attachments/.test(SRC));
  ok("only format=full is requested", /format=full/.test(SRC) && !/format=raw/.test(SRC));
  // Planted: the call that would fetch a file.
  const planted = `gmailGet(token, "/users/me/messages/${"x"}/attachments/${"y"}")`;
  ok("SELF-TEST: a planted attachments.get would be caught", /messages\/[^"'`]*\/attachments/.test(planted));
}

// ── 8. It writes nothing itself ────────────────────────────────────────────
hr("8. Every write is the dashboard's");
{
  ok("no postgres client is opened here", !/\bnew pg\.Client\b/.test(SRC) && !/from "pg"/.test(SRC));
  ok("no INSERT or UPDATE appears", !/\b(INSERT INTO|UPDATE\s+\w+\s+SET)\b/i.test(SRC));
  ok("the import is the dashboard's own npm script", /"run",\s*"email-import"/.test(SRC));
  ok("SELF-TEST: a planted INSERT would be caught", /\bINSERT INTO\b/i.test('await client.query("INSERT INTO crm_activity_bodies …")'));
}

// ── 9. The workflow (G) ────────────────────────────────────────────────────
hr("9. The workflow is dispatch-only and dry by default (G)");
{
  ok("it is workflow_dispatch", /workflow_dispatch:/.test(WORKFLOW));
  ok("IT IS NOT SCHEDULED — this is a deliberate act, not a job", !/^\s*schedule:/m.test(WORKFLOW));
  ok("dry_run defaults to true", /dry_run:[\s\S]{0,220}?default:\s*"true"/.test(WORKFLOW));
  ok("it checks the dashboard out, because the dashboard owns the scope rule", /BSLLC2\/bsllc-account-health/.test(WORKFLOW));
  ok("it plans before it fetches", WORKFLOW.indexOf("email:backfill-plan") < WORKFLOW.indexOf("backfill-email-bodies --"));
  ok("the fetch step passes --dry-run when dry_run is not false", /--dry-run/.test(WORKFLOW));
  // The comment block above the job explains WHY there is no heartbeat, so
  // this reads the steps rather than the file: a check that greps a whole
  // YAML for a word fails on its own documentation.
  const workflowSteps = WORKFLOW.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  ok("no heartbeat step — an unscheduled job must not read as a stopped one", !/npm run heartbeat/.test(workflowSteps));
  ok("SELF-TEST: a planted heartbeat step would be caught", /npm run heartbeat/.test("        run: npm run heartbeat -- --job=x"));
  ok("it carries a timeout, because a first run is thousands of round trips", /timeout-minutes:/.test(WORKFLOW));
  // Planted: a schedule.
  ok("SELF-TEST: a planted schedule would be caught", /^\s*schedule:/m.test('on:\n  schedule:\n    - cron: "0 * * * *"'));
}

// ── 10. No secret is ever printed ──────────────────────────────────────────
hr("10. Nothing prints a credential");
{
  const logs = SRC.split("\n").filter((l) => /console\.(log|warn|error)/.test(l));
  const leaky = logs.filter((l) => /(private_key|GOOGLE_SERVICE_ACCOUNT_JSON|token|Authorization|DATABASE_URL)\b/.test(l) && !/could not mint a token|token for/.test(l));
  ok("no log line names a credential", leaky.length === 0, leaky.join(" | "));
  ok("SELF-TEST: a planted leak would be caught", /private_key/.test('console.log(sa.private_key)'));
}

console.log(`\n${failures === 0 ? "✅ all checks passed" : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);

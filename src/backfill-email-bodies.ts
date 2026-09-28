#!/usr/bin/env tsx
import "dotenv/config";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  reqEnv, serviceAccount, tokenFor, gmailGet, toFetched, type FetchedMessage,
} from "./import-email";

/**
 * Fetch the bodies of SPECIFIC already-logged emails, named by the dashboard.
 *
 * The company owner: "i would like some backfill particularly on actual leads
 * and sqls etc so we have context."
 *
 * The dashboard stores an email's body since 2026-09-28 and this worker
 * fetches `format=full` so there is one to store — both forward-only. Every
 * row logged before that carries Gmail's ~200-character snippet and nothing
 * else, so the history the context is wanted FROM is the part that has none.
 *
 * ── WHY THIS IS NOT `--backfill=90` ───────────────────────────────────────
 *
 * `import-email --backfill=N` re-runs the ordinary import over a date window.
 * It works and it is the wrong tool here, for one reason said twice: it is
 * scoped by DATE, so ninety days of every team mailbox is the support desks,
 * the newsletters, the invoices and the recruiters — and it cannot see what it
 * already has, so every re-run re-fetches the whole window whether or not a
 * body was stored last time. There is no such thing as finishing.
 *
 * ── THE DIVISION OF LABOUR, AND WHY IT IS TWO REPOSITORIES ────────────────
 *
 * THE DASHBOARD NAMES WHICH MESSAGES. It holds the CRM, the deals, the Leads
 * board and the rule — shared/email-backfill-scope.ts — for who counts as a
 * lead or an SQL, and it holds the record of which activities already have a
 * body. It has no Gmail credential and must never acquire one.
 *
 * THIS FETCHES EXACTLY THOSE. It holds the service account with domain-wide
 * delegation and has no idea who matters. It reads a manifest, gets those
 * messages, and hands them to the dashboard's own `npm run email-import` —
 * the same path the 30-minute cron uses, unchanged, with the same
 * classification, the same dedupe and the same writes.
 *
 * Neither half can do the other's job, and putting the scope rule here would
 * be a second definition of "a lead" that drifts from the one on the screen.
 *
 * ── A GMAIL MESSAGE ID IS PER MAILBOX ─────────────────────────────────────
 *
 * The same email Cc'd to two teammates has two Gmail ids, so a stored id is
 * only valid in the mailbox the importer read it from. The manifest carries a
 * `mailboxHint` (the activity's own `created_by`, when that is a mailbox we
 * can impersonate) and, for when the hint misses, the RFC `Message-ID`, which
 * is the same in every copy. The fallback is an `rfc822msgid:` search across
 * the mailboxes, one at a time, stopping at the first hit.
 *
 * WHEN THE FALLBACK FINDS IT SOMEWHERE ELSE, THE ORIGINAL ID IS WHAT IS
 * EMITTED. The dashboard upserts on (source, external_id), so emitting the id
 * it found would INSERT A SECOND ROW for an email already logged — and the
 * importer's own cross-mailbox dedupe would then drop it as a duplicate copy
 * and store no body at all. The manifest's id is the row that exists; this is
 * refreshing it, not logging a new email. The hinted mailbox is emitted for
 * the same reason: `created_by` on an inbound row IS that mailbox, and
 * reporting a different one would quietly re-attribute who received it.
 *
 * ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
 *
 * It fetches no attachment content — `format=full` does not return it and the
 * separate `messages.attachments.get` call is one this repository does not
 * make. It writes nothing to the database itself; every write is the
 * dashboard's. It reads no mailbox the manifest does not send it to. And it
 * never widens the scope: a manifest is a list of ids, and anything not on it
 * is not fetched.
 *
 * Usage:
 *   npm run backfill-email-bodies -- --manifest=/tmp/plan.json --dry-run
 *   npm run backfill-email-bodies -- --manifest=/tmp/plan.json
 *   npm run backfill-email-bodies -- --manifest=/tmp/plan.json --limit=500
 *
 * EXIT CODES
 *   0  fetched and imported, or reported (dry run), or nothing to do
 *   1  the arguments or the manifest do not describe a run
 *   2  every mailbox refused, or the dashboard's import failed
 */

/** Quota units per call, from Google's published Gmail usage-limits table.
 *  Printed so a run says what it spent rather than leaving somebody to guess. */
const UNITS_GET = 5;
const UNITS_LIST = 5;

interface ManifestMessage {
  gmailId: string;
  messageId: string | null;
  mailboxHint: string | null;
  on?: string;
}

interface Args {
  manifest: string | null;
  dryRun: boolean;
  limit: number | null;
  mailboxes: string[] | null;
}

export function parseArgs(argv: string[]): Args {
  let manifest: string | null = null;
  let dryRun = false;
  let limit: number | null = null;
  let mailboxes: string[] | null = null;
  for (const a of argv) {
    if (a.startsWith("--manifest=")) manifest = a.slice("--manifest=".length).trim() || null;
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--limit=")) {
      const n = Number(a.slice("--limit=".length));
      limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    } else if (a.startsWith("--mailboxes=")) {
      mailboxes = a.slice("--mailboxes=".length).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
  }
  return { manifest, dryRun, limit, mailboxes };
}

/** Read and check a manifest. A file that is not the shape this expects is an
 *  argument fault, not a fetch fault — it exits 1 and says which field. */
export function readManifest(text: string): { messages: ManifestMessage[]; note: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`the manifest is not valid JSON — ${e instanceof Error ? e.message : e}`);
  }
  const root = json as { messages?: unknown; scope?: { contactsInScope?: number; stillOutstanding?: number } };
  if (!Array.isArray(root.messages)) throw new Error("the manifest has no `messages` array.");
  const messages: ManifestMessage[] = [];
  for (const [i, raw] of root.messages.entries()) {
    const m = raw as Partial<ManifestMessage>;
    if (!m || typeof m.gmailId !== "string" || !m.gmailId.trim()) {
      throw new Error(`messages[${i}] has no gmailId.`);
    }
    messages.push({
      gmailId: m.gmailId.trim(),
      messageId: typeof m.messageId === "string" && m.messageId.trim() ? m.messageId.trim() : null,
      mailboxHint: typeof m.mailboxHint === "string" && m.mailboxHint.trim() ? m.mailboxHint.trim().toLowerCase() : null,
      on: typeof m.on === "string" ? m.on : undefined,
    });
  }
  const scope = root.scope ?? {};
  const note = `${messages.length} message(s)`
    + (typeof scope.contactsInScope === "number" ? ` across ${scope.contactsInScope} contact(s) in scope` : "")
    + (typeof scope.stillOutstanding === "number" && scope.stillOutstanding > messages.length
      ? ` · ${scope.stillOutstanding - messages.length} more are outstanding and will be planned by the next run`
      : "");
  return { messages, note };
}

/** Strip the angle brackets an RFC Message-ID is usually quoted with. Gmail's
 *  `rfc822msgid:` operator wants the bare value. */
export function bareMessageId(v: string): string {
  return v.trim().replace(/^<|>$/g, "").trim();
}

/** The query that finds one message by its mailbox-independent id. */
export function rfcQuery(messageId: string): string {
  return `rfc822msgid:${bareMessageId(messageId)}`;
}

type Tokens = Map<string, string>;

async function tokenForMailbox(tokens: Tokens, sa: { client_email: string; private_key: string }, mailbox: string): Promise<string | null> {
  const cached = tokens.get(mailbox);
  if (cached) return cached;
  try {
    const t = await tokenFor(sa, mailbox);
    tokens.set(mailbox, t);
    return t;
  } catch (e) {
    console.error(`  ${mailbox}: could not mint a token — ${e instanceof Error ? e.message : e}`);
    tokens.set(mailbox, "");
    return null;
  }
}

interface Calls { gets: number; lists: number }

/**
 * Get one message's full form. The hinted mailbox first; then, only when the
 * manifest carries an RFC Message-ID, a search across the others.
 *
 * A 404 from the hint is ORDINARY, not an error: `created_by` on an outbound
 * row is the resolved sender rather than necessarily the mailbox the copy was
 * read from, so the hint is a hint.
 */
export async function fetchOne(
  m: ManifestMessage,
  mailboxes: string[],
  tokens: Tokens,
  sa: { client_email: string; private_key: string },
  calls: Calls,
): Promise<FetchedMessage | null> {
  const order = m.mailboxHint && mailboxes.includes(m.mailboxHint)
    ? [m.mailboxHint, ...mailboxes.filter((b) => b !== m.mailboxHint)]
    : mailboxes;

  if (m.mailboxHint && mailboxes.includes(m.mailboxHint)) {
    const token = await tokenForMailbox(tokens, sa, m.mailboxHint);
    if (token) {
      try {
        calls.gets += 1;
        const msg = await gmailGet(token, `/users/me/messages/${m.gmailId}?format=full`);
        return toFetched(m.mailboxHint, msg);
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status !== 404 && status !== 400) throw e;
      }
    }
  }

  if (!m.messageId) return null;
  const q = encodeURIComponent(rfcQuery(m.messageId));
  for (const mailbox of order) {
    const token = await tokenForMailbox(tokens, sa, mailbox);
    if (!token) continue;
    calls.lists += 1;
    const list = await gmailGet(token, `/users/me/messages?q=${q}&maxResults=1`);
    const found: string | undefined = list.messages?.[0]?.id;
    if (!found) continue;
    calls.gets += 1;
    const msg = await gmailGet(token, `/users/me/messages/${found}?format=full`);
    const fetched = toFetched(mailbox, msg);
    // THE ORIGINAL ID AND THE ORIGINAL MAILBOX. See the header: emitting what
    // was found would insert a second row for an email already logged, and
    // would re-attribute who received it.
    return { ...fetched, id: m.gmailId, mailbox: m.mailboxHint ?? mailbox };
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) {
    console.error("backfill-email-bodies: --manifest=<file> is required. The dashboard writes one:");
    console.error("  npm run email:backfill-plan -- --out=<file>   (in the dashboard repo)");
    process.exit(1);
  }

  let text: string;
  try {
    text = readFileSync(args.manifest, "utf8");
  } catch (e) {
    console.error(`backfill-email-bodies: cannot read ${args.manifest} — ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  let parsed: ReturnType<typeof readManifest>;
  try {
    parsed = readManifest(text);
  } catch (e) {
    console.error(`backfill-email-bodies: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  const all = parsed.messages;
  const messages = args.limit ? all.slice(0, args.limit) : all;
  console.log(`Email body backfill — ${parsed.note}${args.limit && all.length > messages.length ? ` · this run takes the first ${messages.length}` : ""}${args.dryRun ? " (dry-run)" : ""}`);

  if (messages.length === 0) {
    // Not a failure. An empty manifest is the dashboard saying every email on
    // every contact in scope already has its body — which is what finishing
    // looks like.
    console.log("Nothing to fetch: the dashboard's plan is empty, so every message in scope already has its body stored.");
    process.exit(0);
  }

  const withHint = messages.filter((m) => m.mailboxHint).length;
  const units = withHint * UNITS_GET + (messages.length - withHint) * (UNITS_LIST + UNITS_GET);
  console.log(`  ${withHint} carry a mailbox to try first; ${messages.length - withHint} need a search. At most ~${units.toLocaleString("en-US")} Gmail quota units.`);
  const noFallback = messages.filter((m) => !m.mailboxHint && !m.messageId).length;
  if (noFallback > 0) {
    console.log(`  ${noFallback} carry neither a mailbox nor an RFC Message-ID and cannot be found at all — they are reported, not retried.`);
  }

  if (args.dryRun) {
    console.log("\n(dry-run) No Gmail call was made and nothing was imported. Drop --dry-run to fetch.");
    process.exit(0);
  }

  const sa = serviceAccount();
  const databaseUrl = reqEnv("DATABASE_URL");
  const dashboardDir = reqEnv("DASHBOARD_DIR");
  const mailboxes = args.mailboxes ?? (process.env.EMAIL_LOG_MAILBOXES
    ? process.env.EMAIL_LOG_MAILBOXES.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : []);
  if (!mailboxes.length) {
    console.error("backfill-email-bodies: no mailboxes. Set EMAIL_LOG_MAILBOXES or pass --mailboxes=a@…,b@…");
    process.exit(1);
  }

  const tokens: Tokens = new Map();
  const calls: Calls = { gets: 0, lists: 0 };
  const fetched: FetchedMessage[] = [];
  const missing: ManifestMessage[] = [];
  let failed = 0;

  for (const m of messages) {
    try {
      const got = await fetchOne(m, mailboxes, tokens, sa, calls);
      if (got) fetched.push(got); else missing.push(m);
    } catch (e) {
      failed += 1;
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) {
        console.error(`  ${m.gmailId}: ${status} — check domain-wide delegation (gmail.readonly) is authorized for this service account.`);
      } else {
        console.error(`  ${m.gmailId}: ${e instanceof Error ? e.message : e}`);
      }
      // A run of 401s means the credential is wrong and every later call will
      // fail the same way; stop rather than burn the whole manifest on it.
      if (failed >= 20 && fetched.length === 0) {
        console.error("  Twenty failures and nothing fetched — stopping. The credential or the delegation is the thing to check.");
        break;
      }
    }
  }

  console.log(`\nFetched ${fetched.length} of ${messages.length} · ${missing.length} not found in any mailbox · ${failed} failed`);
  console.log(`  Gmail calls: ${calls.gets} get(s), ${calls.lists} search(es) — ${(calls.gets * UNITS_GET + calls.lists * UNITS_LIST).toLocaleString("en-US")} quota units.`);
  for (const m of missing.slice(0, 20)) {
    console.log(`  not found: ${m.gmailId}${m.on ? ` (${m.on})` : ""} — deleted from Gmail, or in a mailbox this run cannot open.`);
  }
  if (missing.length > 20) console.log(`  …and ${missing.length - 20} more not found.`);

  if (!fetched.length) {
    console.error("Nothing was fetched — not invoking the dashboard's import.");
    process.exit(failed > 0 ? 2 : 0);
  }

  const dir = mkdtempSync(join(tmpdir(), "emailbackfill-"));
  const file = join(dir, "emails.json");
  const aliases: Record<string, string> = {};
  for (const pair of (process.env.EMAIL_ALIASES ?? "").split(",")) {
    const [alias, user] = pair.split("=").map((s) => s?.trim().toLowerCase());
    if (alias && user) aliases[alias] = user;
  }
  writeFileSync(file, JSON.stringify({ messages: fetched, aliases }, null, 2));
  console.log(`\n→ Wrote ${fetched.length} messages to ${file}; invoking \`npm run email-import\`…`);

  const res = spawnSync("npm", ["run", "email-import", "--", `--input=${file}`], {
    cwd: dashboardDir,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (res.error) {
    console.error(`Failed to run email-import in ${dashboardDir}:`, res.error.message);
    process.exit(2);
  }
  process.exit(res.status === 0 ? 0 : 2);
}

const isDirectRun = process.argv[1]?.endsWith("backfill-email-bodies.ts") || process.argv[1]?.endsWith("backfill-email-bodies.js");
if (isDirectRun) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  });
}

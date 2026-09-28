#!/usr/bin/env tsx
import "dotenv/config";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { JWT } from "google-auth-library";
import pg from "pg";

/**
 * Gmail → dashboard email-activity import. The worker holds the Google
 * Workspace credential (a service account with DOMAIN-WIDE DELEGATION), reads
 * each team mailbox's recent traffic, and hands the raw messages to the
 * dashboard's `npm run email-import`, which applies the admin "never log"
 * list, matches participants to CRM contacts/companies, and upserts one
 * activity per Gmail message id (dedup — safe to re-run).
 *
 * Gmail and Superhuman share the same Google mailbox, so both are captured.
 *
 * Prereqs (one-time, Workspace admin):
 *   Admin console → Security → API controls → Domain-wide delegation → add the
 *   service account's client_id with scope
 *     https://www.googleapis.com/auth/gmail.readonly
 *
 * Mailboxes: EMAIL_LOG_MAILBOXES (comma-separated) if set, else every
 * @bsllc.biz address in the dashboard `users` table.
 *
 * What each message carries: From, To, Cc, Subject, Date, the RFC Message-ID
 * (same in every mailbox that holds a copy, so the dashboard logs one row per
 * email, not one per teammate Cc'd), the Gmail label ids (SENT is a direct
 * "we sent this" signal), snippet, thread.
 *
 * AND, SINCE 2026-09-28, THE MESSAGE BODY. This used to fetch
 * `format=metadata`, which returns no body at all, so the dashboard could
 * only ever store Gmail's ~200-character snippet and "open email" on a CRM
 * timeline had to be a link OUT to Gmail. It fetches `format=full` now and
 * emits the text/plain and text/html parts.
 *
 *   • QUOTA IS UNCHANGED. messages.get costs the same units at either format;
 *     what grows is the RESPONSE SIZE, and therefore the temporary JSON file
 *     this writes. MAX_BODY_CHARS bounds that file — it is a TRANSPORT bound,
 *     not a decision about what is kept. The dashboard owns the real rule
 *     (shared/email-body.ts) and its ceiling is deliberately lower, so the
 *     binding limit is always the one in the repo that owns the business
 *     logic.
 *   • ATTACHMENT BYTES ARE NEVER FETCHED. `format=full` returns an attachment
 *     part's filename, type and size but NOT its content — that needs a
 *     separate messages.attachments.get call, which this file does not make
 *     and must not start making. Only how many there were is emitted.
 *   • WHAT TO DO WITH A BODY IS NOT DECIDED HERE. Plain text is preferred
 *     over HTML, HTML is converted to text, a quoted chain is never trimmed —
 *     all of it dashboard-side, in one pure, unit-tested module. This file
 *     hands over what Gmail returned and nothing else.
 *
 * Direction, aliases, the "never log" list and CRM matching are all decided
 * dashboard-side (shared/email-identity.ts) — this file only fetches.
 *
 * Window & caps: the 30-minute cron scans `newer_than:2d`. Anything wider
 * than 7 days (or --backfill) is fetched ONE DAY AT A TIME with Gmail
 * `after:`/`before:` epoch bounds, so a busy mailbox can never lose older
 * messages to a per-query cap — the cap (MAX_PER_WINDOW) is per day-window,
 * and hitting it prints a loud warning naming the day.
 *
 * Usage:
 *   npm run import-email                     # last 2 days, all mailboxes
 *   npm run import-email -- --days=30        # wider window (paged by day)
 *   npm run import-email -- --backfill=90    # 90-day re-import, paged by day, idempotent by Gmail id
 *   npm run import-email -- --dry-run
 *   npm run import-email -- --mailboxes=a@bsllc.biz,b@bsllc.biz
 */

const GMAIL = "https://gmail.googleapis.com/gmail/v1";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** Per day-window (or per whole window when ≤ 7 days). 2 000 messages in a
 *  2-day rolling window is far above any real mailbox; for a backfill the
 *  window is a single day. */
const MAX_PER_WINDOW = 2000;
/** Windows wider than this are split into one-day queries. */
const PAGE_BY_DAY_OVER = 7;
const METADATA_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID"];
/** A TRANSPORT bound on one message's emitted body, in characters — it keeps
 *  a 20MB newsletter out of the JSON file this writes. It is NOT the rule for
 *  what gets stored: the dashboard's own MAX_STORED_BODY_CHARS is lower and is
 *  what decides, in the repo that owns the business logic. Deliberately larger
 *  than it, so this can never be the limit that binds. */
const MAX_BODY_CHARS = 400_000;

interface Args {
  days: number;
  mailboxes: string[] | null;
  dryRun: boolean;
  backfill: boolean;
}

function parseArgs(argv: string[]): Args {
  let days = 2;
  let mailboxes: string[] | null = null;
  let dryRun = false;
  let backfill = false;
  for (const a of argv) {
    if (a.startsWith("--days=")) days = Math.max(1, Number(a.slice("--days=".length)) || 2);
    else if (a.startsWith("--backfill=")) { days = Math.max(1, Number(a.slice("--backfill=".length)) || 90); backfill = true; }
    else if (a === "--backfill") { days = 90; backfill = true; }
    else if (a.startsWith("--mailboxes=")) mailboxes = a.slice("--mailboxes=".length).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--dry-run") dryRun = true;
  }
  return { days, mailboxes, dryRun, backfill };
}

export function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var ${name}.`);
  return v.trim();
}

export function serviceAccount(): { client_email: string; private_key: string } {
  const raw = reqEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }
  if (!json.client_email || !json.private_key) throw new Error("Service-account JSON missing client_email / private_key.");
  return json;
}

/** A delegated access token for one impersonated mailbox. */
export async function tokenFor(sa: { client_email: string; private_key: string }, subject: string): Promise<string> {
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SCOPE], subject });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error(`Failed to mint a Gmail token for ${subject}.`);
  return token;
}

export async function gmailGet(token: string, path: string): Promise<any> {
  const res = await fetch(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Gmail GET ${path} → ${res.status} ${body}`);
    (err as any).status = res.status;
    throw err;
  }
  return res.json();
}

export function header(headers: any[], name: string): string | null {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}
/** Split a To/Cc header into individual address strings. Commas inside a
 *  quoted display name ('"Doe, Jane" <j@x.com>') don't split. */
export function splitAddrs(v: string | null): string[] {
  if (!v) return [];
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const ch of v) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === "," && !inQuote) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** One fetched message in the shape the dashboard's email-import expects. */
export interface FetchedMessage {
  mailbox: string;
  id: string;
  threadId: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  snippet: string | null;
  internalDate: string | null;
  messageId: string | null;
  labelIds: string[];
  date: string | null;
  /** The text/plain part, decoded. Null when the message had none. */
  bodyText: string | null;
  /** The text/html part, decoded. The dashboard converts it; nothing here
   *  renders it and nothing here sanitises it. */
  bodyHtml: string | null;
  /** How many attachment parts the message carried. Never their content. */
  attachmentCount: number;
}

/** Gmail's base64url, decoded as UTF-8. Anything that is not decodable comes
 *  back empty rather than as mojibake somebody later has to read. */
export function decodeBody(data: string | null | undefined): string {
  if (!data) return "";
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Walk a Gmail payload and pull out the two body parts and the attachment
 * count. Exported and pure so it can be driven with no credential and no
 * network — src/verify-email-body.ts does exactly that.
 *
 * Rules, each deliberate:
 *   • The FIRST text/plain and the FIRST text/html win. A multipart/alternative
 *     lists the same content twice and a forwarded chain nests more of it;
 *     concatenating every match prints the message several times over.
 *   • A part with a filename, or one carrying an attachmentId, is an
 *     ATTACHMENT — counted, never read. `format=full` does not return its
 *     bytes anyway, and fetching them would be a separate call this file does
 *     not make.
 *   • An inline image (a Content-ID part with no filename) is counted as an
 *     attachment for the same reason: it is a file, not words.
 *   • Depth is bounded. A malformed or hostile payload must not spin.
 */
export function extractBody(payload: any): { bodyText: string | null; bodyHtml: string | null; attachmentCount: number } {
  let text: string | null = null;
  let html: string | null = null;
  let attachments = 0;
  const walk = (part: any, depth: number): void => {
    if (!part || depth > 20) return;
    const mime = String(part.mimeType ?? "").toLowerCase();
    const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
    if (isAttachment) {
      attachments += 1;
      // Still descend: a forwarded message/rfc822 part carries real body
      // parts under it, and losing those loses the forwarded email.
    } else if (mime === "text/plain" && text === null) {
      text = decodeBody(part.body?.data);
    } else if (mime === "text/html" && html === null) {
      html = decodeBody(part.body?.data);
    }
    for (const child of Array.isArray(part.parts) ? part.parts : []) walk(child, depth + 1);
  };
  walk(payload, 0);
  const cap = (v: string | null): string | null => (v === null ? null : v.slice(0, MAX_BODY_CHARS) || null);
  return { bodyText: cap(text), bodyHtml: cap(html), attachmentCount: attachments };
}

export function toFetched(mailbox: string, msg: any): FetchedMessage {
  const headers = msg.payload?.headers ?? [];
  return {
    mailbox,
    id: msg.id,
    threadId: msg.threadId ?? null,
    from: header(headers, "From"),
    to: splitAddrs(header(headers, "To")),
    cc: splitAddrs(header(headers, "Cc")),
    subject: header(headers, "Subject"),
    snippet: msg.snippet ?? null,
    internalDate: msg.internalDate ?? null, // epoch-ms string
    messageId: header(headers, "Message-ID"),
    labelIds: Array.isArray(msg.labelIds) ? msg.labelIds : [],
    date: header(headers, "Date"),
    ...extractBody(msg.payload),
  };
}

/** The Gmail queries that cover `days` back from now: one query for a short
 *  window, one per day for a long one (newest day first). */
export function windowQueries(days: number, now: Date = new Date()): Array<{ label: string; q: string }> {
  if (days <= PAGE_BY_DAY_OVER) return [{ label: `last ${days}d`, q: `newer_than:${days}d -in:chats` }];
  const out: Array<{ label: string; q: string }> = [];
  const DAY = 86_400;
  const end = Math.floor(now.getTime() / 1000) + 3600; // an hour of slack past "now"
  for (let i = 0; i < days; i++) {
    const before = end - i * DAY;
    const after = before - DAY;
    out.push({ label: new Date(after * 1000).toISOString().slice(0, 10), q: `after:${after} before:${before} -in:chats` });
  }
  return out;
}

async function mailboxesFromDb(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ email: string }>("SELECT email FROM users WHERE email IS NOT NULL");
    return rows.map((r) => r.email.trim().toLowerCase()).filter((e) => e.endsWith("@bsllc.biz"));
  } finally {
    await client.end();
  }
}

/**
 * Fetch ONE message, headers and body.
 *
 * `format=full` rather than `format=metadata`: the metadata form returns no
 * body, which is why the dashboard could only ever store Gmail's snippet. It
 * costs the same quota; it returns more bytes. It does NOT return attachment
 * content — that is a separate call, and this file does not make it.
 *
 * METADATA_HEADERS is still the list the dashboard reads off each message; it
 * is documentation of that contract now rather than a query parameter,
 * because `format=full` returns every header and toFetched picks these out.
 */
export async function fetchMessage(token: string, mailbox: string, id: string): Promise<FetchedMessage> {
  const msg = await gmailGet(token, `/users/me/messages/${id}?format=full`);
  return toFetched(mailbox, msg);
}

/** List + fetch every message matching one Gmail query, up to the cap. */
export async function fetchQuery(token: string, mailbox: string, q: string, cap: number = MAX_PER_WINDOW): Promise<{ messages: FetchedMessage[]; capped: boolean }> {
  const out: FetchedMessage[] = [];
  let pageToken: string | undefined;
  do {
    const pt = pageToken ? `&pageToken=${pageToken}` : "";
    const list = await gmailGet(token, `/users/me/messages?q=${encodeURIComponent(q)}&maxResults=100${pt}`);
    const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
    for (const id of ids) {
      out.push(await fetchMessage(token, mailbox, id));
      if (out.length >= cap) return { messages: out, capped: true };
    }
    pageToken = list.nextPageToken;
  } while (pageToken);
  return { messages: out, capped: false };
}

async function fetchMailbox(token: string, mailbox: string, days: number): Promise<FetchedMessage[]> {
  const out: FetchedMessage[] = [];
  const seen = new Set<string>();
  for (const w of windowQueries(days)) {
    const { messages, capped } = await fetchQuery(token, mailbox, w.q);
    if (capped) console.warn(`  ${mailbox}: window ${w.label} hit the ${MAX_PER_WINDOW}-message cap — narrow the window or raise MAX_PER_WINDOW; some messages in that window were NOT fetched.`);
    for (const m of messages) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sa = serviceAccount();
  const databaseUrl = reqEnv("DATABASE_URL");
  const dashboardDir = reqEnv("DASHBOARD_DIR");

  const mailboxes = args.mailboxes ?? (process.env.EMAIL_LOG_MAILBOXES
    ? process.env.EMAIL_LOG_MAILBOXES.split(",").map((s) => s.trim()).filter(Boolean)
    : await mailboxesFromDb(databaseUrl));
  if (!mailboxes.length) throw new Error("No mailboxes to sync (set EMAIL_LOG_MAILBOXES or add @bsllc.biz users).");

  console.log(`Email import — ${mailboxes.length} mailbox(es): ${mailboxes.join(", ")} · last ${args.days}d${args.days > PAGE_BY_DAY_OVER ? " (paged by day)" : ""}${args.backfill ? " · BACKFILL" : ""}${args.dryRun ? " (dry-run)" : ""}`);
  const messages: FetchedMessage[] = [];
  for (const mailbox of mailboxes) {
    try {
      const token = await tokenFor(sa, mailbox);
      const msgs = await fetchMailbox(token, mailbox, args.days);
      const sent = msgs.filter((m) => m.labelIds.includes("SENT")).length;
      const withBody = msgs.filter((m) => m.bodyText || m.bodyHtml).length;
      console.log(`  ${mailbox}: ${msgs.length} messages (${sent} carry Gmail's SENT label · ${withBody} carry a body)`);
      messages.push(...msgs);
    } catch (e) {
      const status = (e as any).status;
      if (status === 401 || status === 403) {
        console.error(`  ${mailbox}: ${status} — check domain-wide delegation (gmail.readonly) is authorized for this service account.`);
      } else {
        console.error(`  ${mailbox}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  if (!messages.length) {
    console.log("No messages fetched — nothing to import.");
    process.exit(0);
  }

  // Optional alias → user map (EMAIL_ALIASES="sales@bsllc.biz=ben@bsllc.biz,…")
  // rides along; the dashboard also reads users.email_aliases itself.
  const aliases: Record<string, string> = {};
  for (const pair of (process.env.EMAIL_ALIASES ?? "").split(",")) {
    const [alias, user] = pair.split("=").map((s) => s?.trim().toLowerCase());
    if (alias && user) aliases[alias] = user;
  }
  const dir = mkdtempSync(join(tmpdir(), "emailimport-"));
  const file = join(dir, "emails.json");
  writeFileSync(file, JSON.stringify({ messages, aliases }, null, 2));

  if (args.dryRun) {
    console.log(`\n(dry-run) Wrote ${messages.length} messages to ${file}; NOT invoking email-import. Inspect the file to preview.`);
    process.exit(0);
  }
  // Said before handing over, because "nothing expands in the app" is
  // diagnosed from exactly this number — a run where it is 0 on a mailbox
  // that clearly has mail means the fetch is not returning bodies.
  const carried = messages.filter((m) => m.bodyText || m.bodyHtml).length;
  console.log(`Bodies: ${carried} of ${messages.length} messages carried one.`);
  console.log(`\n→ Wrote ${messages.length} messages to ${file}; invoking \`npm run email-import\`…`);

  const cliArgs = ["run", "email-import", "--", `--input=${file}`];
  const res = spawnSync("npm", cliArgs, {
    cwd: dashboardDir,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (res.error) {
    console.error(`Failed to run email-import in ${dashboardDir}:`, res.error.message);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}

const isDirectRun = process.argv[1]?.endsWith("import-email.ts") || process.argv[1]?.endsWith("import-email.js");
if (isDirectRun) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

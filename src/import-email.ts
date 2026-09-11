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
 * What each message carries (metadata only, never the body): From, To, Cc,
 * Subject, Date, the RFC Message-ID (same in every mailbox that holds a copy,
 * so the dashboard logs one row per email, not one per teammate Cc'd), the
 * Gmail label ids (SENT is a direct "we sent this" signal), snippet, thread.
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

/** Fetch metadata for one message. */
export async function fetchMessage(token: string, mailbox: string, id: string): Promise<FetchedMessage> {
  const hdrs = METADATA_HEADERS.map((h) => `&metadataHeaders=${h}`).join("");
  const msg = await gmailGet(token, `/users/me/messages/${id}?format=metadata${hdrs}`);
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
      console.log(`  ${mailbox}: ${msgs.length} messages (${sent} carry Gmail's SENT label)`);
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

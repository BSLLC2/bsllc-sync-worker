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
 * Usage:
 *   npm run import-email                     # last 2 days, all mailboxes
 *   npm run import-email -- --days=30        # wider backfill window
 *   npm run import-email -- --dry-run
 *   npm run import-email -- --mailboxes=a@bsllc.biz,b@bsllc.biz
 */

const GMAIL = "https://gmail.googleapis.com/gmail/v1";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const MAX_PER_MAILBOX = 500;

interface Args {
  days: number;
  mailboxes: string[] | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let days = 2;
  let mailboxes: string[] | null = null;
  let dryRun = false;
  for (const a of argv) {
    if (a.startsWith("--days=")) days = Math.max(1, Number(a.slice("--days=".length)) || 2);
    else if (a.startsWith("--mailboxes=")) mailboxes = a.slice("--mailboxes=".length).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--dry-run") dryRun = true;
  }
  return { days, mailboxes, dryRun };
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var ${name}.`);
  return v.trim();
}

function serviceAccount(): { client_email: string; private_key: string } {
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
async function tokenFor(sa: { client_email: string; private_key: string }, subject: string): Promise<string> {
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SCOPE], subject });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error(`Failed to mint a Gmail token for ${subject}.`);
  return token;
}

async function gmailGet(token: string, path: string): Promise<any> {
  const res = await fetch(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Gmail GET ${path} → ${res.status} ${body}`);
    (err as any).status = res.status;
    throw err;
  }
  return res.json();
}

function header(headers: any[], name: string): string | null {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}
/** Split a To/Cc header into individual address strings. */
function splitAddrs(v: string | null): string[] {
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
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

async function fetchMailbox(token: string, mailbox: string, days: number): Promise<any[]> {
  const q = encodeURIComponent(`newer_than:${days}d -in:chats`);
  const out: any[] = [];
  let pageToken: string | undefined;
  do {
    const pt = pageToken ? `&pageToken=${pageToken}` : "";
    const list = await gmailGet(token, `/users/me/messages?q=${q}&maxResults=100${pt}`);
    const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
    for (const id of ids) {
      const msg = await gmailGet(
        token,
        `/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject`,
      );
      const headers = msg.payload?.headers ?? [];
      out.push({
        mailbox,
        id: msg.id,
        threadId: msg.threadId ?? null,
        from: header(headers, "From"),
        to: splitAddrs(header(headers, "To")),
        cc: splitAddrs(header(headers, "Cc")),
        subject: header(headers, "Subject"),
        snippet: msg.snippet ?? null,
        internalDate: msg.internalDate ?? null, // epoch-ms string
      });
      if (out.length >= MAX_PER_MAILBOX) return out;
    }
    pageToken = list.nextPageToken;
  } while (pageToken);
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

  console.log(`Email import — ${mailboxes.length} mailbox(es), last ${args.days}d${args.dryRun ? " (dry-run)" : ""}`);
  const messages: any[] = [];
  for (const mailbox of mailboxes) {
    try {
      const token = await tokenFor(sa, mailbox);
      const msgs = await fetchMailbox(token, mailbox, args.days);
      console.log(`  ${mailbox}: ${msgs.length} messages`);
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

  const dir = mkdtempSync(join(tmpdir(), "emailimport-"));
  const file = join(dir, "emails.json");
  writeFileSync(file, JSON.stringify({ messages }, null, 2));

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

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

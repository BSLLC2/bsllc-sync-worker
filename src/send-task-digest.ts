#!/usr/bin/env tsx
import "dotenv/config";
import crypto from "node:crypto";
import pg from "pg";

/**
 * Morning task digest. Once a day, enqueue ONE team_notification per teammate
 * summarizing the work on their plate: overdue, due today, due tomorrow, and any
 * deliverables awaiting client review past the account's SLA. The row lands in
 * team_notifications with kind 'digest', status 'pending'; send-team-notifications
 * (runs every 3 min) then delivers it to each person's chosen channels (push /
 * Slack DM / SMS). The deployed dashboard makes zero third-party calls by design.
 *
 * A commitment belongs to a user when its EFFECTIVE owner (explicit assignee,
 * else the account's AM) matches the user's name — the same rule the homepage
 * "My work" view uses (full case-insensitive match, or first name if ≥3 chars).
 *
 *   npm run send-task-digest
 *   npm run send-task-digest -- --dry-run
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

/** Homepage matching rule: full case-insensitive match, or first name if ≥3. */
function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const la = a.trim().toLowerCase(), lb = b.trim().toLowerCase();
  if (la === lb) return true;
  const fa = la.split(/\s+/)[0] ?? "", fb = lb.split(/\s+/)[0] ?? "";
  return fa.length >= 3 && fa === fb;
}

/** 'YYYY-MM-DD' in local time (matches how due_date strings are stored/compared). */
function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Whole Mon–Fri business days elapsed from `from` (exclusive) to `to` (inclusive). */
function businessDaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let count = 0;
  const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (cur < end) {
    cur.setDate(cur.getDate() + 1);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

interface Commitment {
  id: string; client_id: string; title: string;
  owner_type: string; owner_name: string | null; assignee_name: string | null;
  status: string; due_date: string | null;
  review_state: string; review_requested_at: Date | null;
}
interface Client { id: string; name: string; am_owner: string | null; feedback_sla_business_days: number }

/** Compact list: first `max` titles, then "+N more". */
function titleList(titles: string[], max = 4): string {
  if (titles.length <= max) return titles.join(", ");
  return `${titles.slice(0, max).join(", ")} +${titles.length - max} more`;
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const now = new Date();
  const today = localYmd(now);
  const tomorrow = localYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const [{ rows: users }, { rows: clients }, { rows: commitments }] = await Promise.all([
      c.query<{ email: string; name: string }>(`SELECT email, name FROM users WHERE name IS NOT NULL AND email IS NOT NULL`),
      c.query<Client>(`SELECT id, name, am_owner, feedback_sla_business_days FROM clients`),
      c.query<Commitment>(
        `SELECT id, client_id, title, owner_type, owner_name, assignee_name, status, due_date, review_state, review_requested_at
           FROM commitments WHERE status <> 'complete'`,
      ),
    ]);
    const clientById = new Map(clients.map((cl) => [cl.id, cl]));

    let enqueued = 0;
    for (const u of users) {
      const overdue: string[] = [], dueToday: string[] = [], dueTomorrow: string[] = [], awaiting: string[] = [];
      for (const t of commitments) {
        const client = clientById.get(t.client_id);
        const effectiveOwner = t.assignee_name || client?.am_owner || null;
        if (!sameName(effectiveOwner, u.name)) continue;

        if (t.due_date && t.due_date < today) overdue.push(t.title);
        else if (t.due_date === today) dueToday.push(t.title);
        else if (t.due_date === tomorrow) dueTomorrow.push(t.title);

        // Awaiting client review past the account's business-day SLA.
        if (t.review_state === "awaiting" && t.review_requested_at) {
          const sla = client?.feedback_sla_business_days ?? 2;
          if (businessDaysBetween(new Date(t.review_requested_at), now) > sla) awaiting.push(t.title);
        }
      }

      const total = overdue.length + dueToday.length + dueTomorrow.length + awaiting.length;
      if (total === 0) continue;

      const title = `Today: ${overdue.length} overdue · ${dueToday.length} due today`;
      const parts: string[] = [];
      if (overdue.length) parts.push(`🔴 Overdue (${overdue.length}): ${titleList(overdue)}`);
      if (dueToday.length) parts.push(`🟡 Due today (${dueToday.length}): ${titleList(dueToday)}`);
      if (dueTomorrow.length) parts.push(`⚪ Due tomorrow (${dueTomorrow.length}): ${titleList(dueTomorrow)}`);
      if (awaiting.length) parts.push(`⏳ Awaiting client, past SLA (${awaiting.length}): ${titleList(awaiting)}`);
      const body = parts.join("  ").slice(0, 600);

      console.log(`  ${u.email}: ${overdue.length} overdue, ${dueToday.length} today, ${dueTomorrow.length} tomorrow, ${awaiting.length} past-SLA`);
      if (dryRun) continue;

      await c.query(
        `INSERT INTO team_notifications (id, user_email, kind, title, body, url, status)
         VALUES ($1, $2, 'digest', $3, $4, '/work', 'pending')`,
        [crypto.randomUUID(), u.email, title, body],
      );
      enqueued++;
    }
    console.log(`send-task-digest — ${enqueued} digest${enqueued === 1 ? "" : "s"} enqueued${dryRun ? " (dry-run: none written)" : ""} across ${users.length} users.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

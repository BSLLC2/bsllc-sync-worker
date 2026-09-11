#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { serviceAccount, tokenFor, fetchQuery, windowQueries, reqEnv, type FetchedMessage } from "./import-email.js";

/**
 * READ-ONLY diagnostic: why is a team member's reply missing from a
 * contact's timeline? Puts everything on one screen:
 *
 *   1. what Gmail holds for --mailbox in the last --days, split by
 *      From == mailbox exactly / From contains the mailbox address (display
 *      name, casing, +tag) / From is another @bsllc.biz address or alias /
 *      other — plus how many carry Gmail's SENT label;
 *   2. which of those Gmail ids are present in crm_activities (source=gmail),
 *      with their stored direction and contact — and which are NOT;
 *   3. the admin "never log" list, flagging entries for our own addresses;
 *   4. the mailboxes the cron would scan (EMAIL_LOG_MAILBOXES vs users table),
 *      the user rows' aliases, and whether the mailbox owner is ALSO a CRM
 *      contact (the shape that used to swallow their outbound);
 *   5. with --contact=<email>: every message in the window involving that
 *      address, each with a verdict on why it would or wouldn't be logged.
 *
 * Writes nothing. Dispatch: debug-email-logging.yml (inputs mailbox, days,
 * contact_email), or locally:
 *   npm run debug-email-logging -- --mailbox=ben@bsllc.biz --days=14 --contact=dana@psychoseltzer.com
 */

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length).trim() : undefined;
}
const lower = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
function bareAddr(s: string | null | undefined): string | null {
  if (!s) return null;
  const angle = s.match(/<([^<>]+)>/);
  const m = (angle?.[1] ?? s).match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (!m) return null;
  let e = m[0].toLowerCase();
  const at = e.lastIndexOf("@");
  const plus = e.indexOf("+");
  if (plus > 0 && plus < at) e = e.slice(0, plus) + e.slice(at);
  return e;
}
const short = (s: string | null | undefined, n = 50) => (s ?? "").replace(/\s+/g, " ").slice(0, n);
const when = (m: FetchedMessage) => (m.internalDate ? new Date(Number(m.internalDate)).toISOString().slice(0, 16).replace("T", " ") : "?");

async function main() {
  const mailbox = lower(arg("mailbox"));
  if (!mailbox) throw new Error("Pass --mailbox=<team address>.");
  const days = Math.max(1, Number(arg("days") ?? "14") || 14);
  const contact = bareAddr(arg("contact")) ?? null;

  const sa = serviceAccount();
  const db = new pg.Client({ connectionString: reqEnv("DATABASE_URL") });
  await db.connect();
  try {
    console.log(`═══ Email logging diagnostic — ${mailbox} · last ${days}d${contact ? ` · contact ${contact}` : ""} ═══\n`);

    // ── 4. configuration ──
    const envBoxes = (process.env.EMAIL_LOG_MAILBOXES ?? "").split(",").map(lower).filter(Boolean);
    const { rows: userRows } = await db.query<{ email: string; name: string; email_aliases: string | null }>(
      "SELECT email, name, email_aliases FROM users WHERE email IS NOT NULL ORDER BY email",
    );
    const dbBoxes = userRows.map((u) => lower(u.email)).filter((e) => e.endsWith("@bsllc.biz"));
    const scanned = envBoxes.length ? envBoxes : dbBoxes;
    console.log("Mailboxes the cron scans:", envBoxes.length ? `EMAIL_LOG_MAILBOXES secret → ${envBoxes.join(", ")}` : `(secret unset) every @bsllc.biz user → ${dbBoxes.join(", ")}`);
    console.log(scanned.includes(mailbox) ? `  ✓ ${mailbox} IS scanned` : `  ✗ ${mailbox} is NOT in the scanned set — nothing from this mailbox can ever be logged. Add it to EMAIL_LOG_MAILBOXES (or unset the secret) or add the user.`);
    const aliasRows = userRows.filter((u) => u.email_aliases);
    console.log("User aliases (users.email_aliases):", aliasRows.length ? aliasRows.map((u) => `${lower(u.email)} → ${u.email_aliases}`).join("; ") : "none set");
    const envAliases = (process.env.EMAIL_ALIASES ?? "").trim();
    console.log("EMAIL_ALIASES secret:", envAliases || "(unset)");
    const teamAddrs = new Set<string>([...userRows.map((u) => lower(u.email)), ...scanned]);
    for (const u of aliasRows) {
      try { for (const a of JSON.parse(u.email_aliases!) as string[]) teamAddrs.add(lower(a)); } catch { for (const a of u.email_aliases!.split(",")) teamAddrs.add(lower(a)); }
    }
    for (const pair of envAliases.split(",")) { const [a] = pair.split("="); if (a?.trim()) teamAddrs.add(lower(a)); }
    const isTeam = (e: string | null) => !!e && (teamAddrs.has(e) || e.endsWith("@bsllc.biz"));

    const { rows: selfContact } = await db.query<{ id: string; name: string; company_id: string | null }>(
      "SELECT id, name, company_id FROM contacts WHERE lower(email) = $1", [mailbox],
    );
    if (selfContact.length) console.log(`  ⚠ ${mailbox} is ALSO a CRM contact (${selfContact.map((c) => `${c.name} ${c.id}`).join(", ")}). Before the 2026-09-11 fix, every outbound from this mailbox was filed on THIS contact instead of the recipient's — look for the missing replies on this record.`);
    else console.log(`  ✓ ${mailbox} is not itself a CRM contact`);

    // ── 3. never-log list ──
    const { rows: excl } = await db.query<{ value: string; scope: string; note: string | null }>("SELECT value, scope, note FROM email_log_exclusions ORDER BY scope, value");
    console.log(`\n"Never log" list (${excl.length}):`);
    for (const e of excl) {
      const v = lower(e.value).replace(/^@/, "");
      const own = e.scope === "domain" ? v === "bsllc.biz" : isTeam(v);
      console.log(`  ${e.scope.padEnd(6)} ${e.value}${e.note ? ` — ${e.note}` : ""}${own ? "   ⚠ OUR OWN address/domain: pre-fix this suppressed EVERY message from this mailbox; post-fix it is ignored" : ""}`);
    }
    if (!excl.length) console.log("  (empty)");

    // ── 1. Gmail ──
    console.log(`\nGmail (${mailbox}, ${days}d):`);
    const token = await tokenFor(sa, mailbox);
    const all: FetchedMessage[] = [];
    for (const w of windowQueries(days)) {
      const { messages, capped } = await fetchQuery(token, mailbox, w.q);
      all.push(...messages);
      if (capped) console.log(`  ⚠ window ${w.label} hit the cap — counts below are incomplete for that day`);
    }
    const byId = new Map(all.map((m) => [m.id, m]));
    const buckets = { exact: [] as FetchedMessage[], contains: [] as FetchedMessage[], team: [] as FetchedMessage[], other: [] as FetchedMessage[] };
    for (const m of all) {
      const from = bareAddr(m.from);
      const rawFrom = lower(m.from);
      if (rawFrom === mailbox) buckets.exact.push(m);
      else if (from === mailbox || rawFrom.includes(mailbox)) buckets.contains.push(m);
      else if (isTeam(from)) buckets.team.push(m);
      else buckets.other.push(m);
    }
    const sentLabel = all.filter((m) => m.labelIds.includes("SENT"));
    console.log(`  ${all.length} messages in window · ${sentLabel.length} carry Gmail's SENT label`);
    console.log(`  From == "${mailbox}" exactly:              ${buckets.exact.length}   (old importer: outbound, but filed on the FIRST matching participant — the sender's own contact/company if they have one)`);
    console.log(`  From is "Name <${mailbox}>" / case / +tag: ${buckets.contains.length}   (old importer: name+case were fine, a +tag became INBOUND)`);
    console.log(`  From is another team address / alias:        ${buckets.team.length}   (old importer: INBOUND — misclassified)`);
    console.log(`  From is external:                            ${buckets.other.length}`);
    const sentButOtherFrom = sentLabel.filter((m) => !isTeam(bareAddr(m.from)));
    if (sentButOtherFrom.length) {
      console.log(`  ⚠ ${sentButOtherFrom.length} SENT-labelled message(s) whose From is NOT a known team address (send-as from an unknown alias / phone account). Distinct From values:`);
      for (const f of Array.from(new Set(sentButOtherFrom.map((m) => m.from ?? "?"))).slice(0, 10)) console.log(`      ${f}`);
      console.log("    → add these to the user's aliases (Admin → Users) or EMAIL_ALIASES; post-fix the SENT label already makes them outbound.");
    }
    if (buckets.contains.length) {
      console.log("  Distinct From headers in the 'contains' bucket:");
      for (const f of Array.from(new Set(buckets.contains.map((m) => m.from ?? "?"))).slice(0, 8)) console.log(`      ${f}`);
    }

    // ── 2. what the dashboard holds for those ids ──
    const ids = Array.from(byId.keys());
    const { rows: logged } = ids.length
      ? await db.query<{ external_id: string; direction: string | null; contact_id: string | null; company_id: string | null; created_by: string | null; email_message_id: string | null; contact_name: string | null }>(
          `SELECT a.external_id, a.direction, a.contact_id, a.company_id, a.created_by, a.email_message_id, c.name AS contact_name
             FROM crm_activities a LEFT JOIN contacts c ON c.id = a.contact_id
            WHERE a.source = 'gmail' AND a.external_id = ANY($1)`, [ids])
      : { rows: [] };
    const loggedById = new Map(logged.map((r) => [r.external_id, r]));
    const loggedCount = (list: FetchedMessage[]) => list.filter((m) => loggedById.has(m.id)).length;
    console.log(`\nDashboard crm_activities (source=gmail) for those ${ids.length} Gmail ids: ${logged.length} present, ${ids.length - logged.length} absent`);
    console.log(`  exact-From bucket:    ${loggedCount(buckets.exact)}/${buckets.exact.length} logged · stored as outbound: ${buckets.exact.filter((m) => loggedById.get(m.id)?.direction === "outbound").length}`);
    console.log(`  contains-From bucket: ${loggedCount(buckets.contains)}/${buckets.contains.length} logged · stored as outbound: ${buckets.contains.filter((m) => loggedById.get(m.id)?.direction === "outbound").length}`);
    console.log(`  team-From bucket:     ${loggedCount(buckets.team)}/${buckets.team.length} logged · stored as outbound: ${buckets.team.filter((m) => loggedById.get(m.id)?.direction === "outbound").length}`);
    console.log(`  external-From bucket: ${loggedCount(buckets.other)}/${buckets.other.length} logged`);
    if (selfContact.length) {
      const onSelf = logged.filter((r) => selfContact.some((c) => c.id === r.contact_id));
      console.log(`  ⚠ ${onSelf.length} of the logged rows are filed on ${mailbox}'s OWN contact record (the wrong-contact bug). A re-import (--backfill) moves them to the recipient.`);
    }
    // Absent outbound with an external recipient = the exact "our reply is missing" case.
    const { rows: contactRows } = await db.query<{ email: string | null; alt_emails: string | null; id: string; name: string }>("SELECT id, name, email, alt_emails FROM contacts WHERE email IS NOT NULL OR alt_emails IS NOT NULL");
    const contactByEmail = new Map<string, { id: string; name: string }>();
    for (const c of contactRows) {
      const e = bareAddr(c.email); if (e && !contactByEmail.has(e)) contactByEmail.set(e, c);
      if (c.alt_emails) { try { for (const a of JSON.parse(c.alt_emails) as string[]) { const ae = bareAddr(a); if (ae && !contactByEmail.has(ae)) contactByEmail.set(ae, c); } } catch { /* ignore */ } }
    }
    const teamSent = [...buckets.exact, ...buckets.contains, ...buckets.team, ...sentButOtherFrom];
    const missingReplies = teamSent.filter((m) => !loggedById.has(m.id) && [...m.to, ...m.cc].map(bareAddr).some((e) => e && contactByEmail.has(e)));
    console.log(`\nTeam-sent messages to a KNOWN CRM contact that are NOT logged (the reported symptom): ${missingReplies.length}`);
    for (const m of missingReplies.slice(0, 25)) {
      const who = [...m.to, ...m.cc].map(bareAddr).filter((e): e is string => !!e && contactByEmail.has(e));
      console.log(`  ${when(m)}  ${m.id}  from=${short(m.from, 40)}  to=${who.join(",")}  "${short(m.subject)}"  labels=${m.labelIds.join("|")}`);
    }
    if (missingReplies.length > 25) console.log(`  … ${missingReplies.length - 25} more`);

    // ── 5. one contact end to end ──
    if (contact) {
      const c = contactByEmail.get(contact);
      console.log(`\n═══ Contact ${contact}: ${c ? `${c.name} (${c.id})` : "NOT a CRM contact (by primary or alt email) — nothing can be logged against them until they are"} ═══`);
      const involved = all.filter((m) => [m.from, ...m.to, ...m.cc].map(bareAddr).includes(contact))
        .sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
      console.log(`${involved.length} message(s) in ${mailbox}'s Gmail involve them:`);
      const exclEmails = new Set(excl.filter((e) => e.scope === "email").map((e) => lower(e.value)));
      const exclDomains = new Set(excl.filter((e) => e.scope === "domain").map((e) => lower(e.value).replace(/^@/, "")));
      for (const m of involved) {
        const from = bareAddr(m.from);
        const dir = isTeam(from) || m.labelIds.includes("SENT") ? "outbound" : "inbound";
        const row = loggedById.get(m.id);
        const participants = [from, ...m.to.map(bareAddr), ...m.cc.map(bareAddr)].filter((e): e is string => !!e);
        const external = participants.filter((e) => !isTeam(e));
        const exclHit = external.find((e) => exclEmails.has(e) || exclDomains.has(e.split("@")[1] ?? ""));
        const oldExclHit = participants.find((e) => exclEmails.has(e) || exclDomains.has(e.split("@")[1] ?? ""));
        let verdict: string;
        if (row) verdict = `LOGGED as ${row.direction} on ${row.contact_name ?? row.contact_id ?? "(company only)"}${row.contact_id && c && row.contact_id !== c.id ? "  ⚠ WRONG CONTACT" : ""}`;
        else if (exclHit) verdict = `not logged — external participant ${exclHit} is on the never-log list`;
        else if (oldExclHit) verdict = `not logged — pre-fix: OUR address ${oldExclHit} on the never-log list suppressed it; post-fix it WILL log`;
        else if (!c) verdict = "not logged — not a CRM contact";
        else if (dir === "outbound") verdict = `not logged — pre-fix outbound handling (${lower(m.from) === mailbox ? "From matched exactly but the sender's own contact/company won the match" : "From ≠ mailbox string → misclassified/mis-filed"}); post-fix it WILL log as outbound`;
        else verdict = "not logged — should have been (check the run logs for this window)";
        console.log(`  ${when(m)}  ${dir.padEnd(8)}  from=${short(m.from, 36).padEnd(36)}  "${short(m.subject, 40)}"  → ${verdict}`);
      }
      if (c) {
        const { rows: timeline } = await db.query<{ occurred_at: string; direction: string | null; kind: string; source: string; subject: string | null; created_by: string | null }>(
          "SELECT occurred_at, direction, kind, source, subject, created_by FROM crm_activities WHERE contact_id = $1 ORDER BY occurred_at DESC LIMIT 15", [c.id]);
        console.log(`\nWhat the contact's timeline shows today (newest 15):`);
        for (const t of timeline) console.log(`  ${new Date(t.occurred_at).toISOString().slice(0, 16).replace("T", " ")}  ${(t.direction ?? "-").padEnd(8)} ${t.kind.padEnd(8)} ${t.source.padEnd(7)} ${short(t.subject, 50)}  ${t.created_by ?? ""}`);
        const { rows: eng } = await db.query("SELECT last_inbound_at, last_outbound_at, last_meeting_at, waiting_on, waiting_since, lead_status, lifecycle_stage FROM contacts WHERE id = $1", [c.id]);
        console.log("Stored engagement summary:", JSON.stringify(eng[0] ?? {}));
      }
    }

    console.log("\nNext: if the symptom shows above, dispatch import-email.yml with backfill=90 (idempotent) and re-run this diagnostic.");
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});

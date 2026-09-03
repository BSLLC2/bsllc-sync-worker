#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { phone10 } from "./lead-keys.js";
import { OCH_FORM_LOG, OCH_FORM_LOG_EXPORTED_AT } from "./och-form-log-2026-08.js";

/**
 * ONE-OFF. Lands OCH's hand-exported form log (Jul 1 – Aug 24 2026) in
 * web_inquiries, so the leads the site received through its six unwired forms
 * exist on our side: they show on OCH's board, count in the setup checklist,
 * and — because they carry utm_source=website / utm_medium=form — let the
 * admissions import credit an admission that came through the website even
 * when intake typed the clinical partner into Referent.
 *
 * Idempotent: a person whose phone already has a web_inquiries row within 7
 * days of the logged date is skipped. Rows are tagged in raw_json
 * (source: elementor-log-export) so they can be told apart or removed with one
 * query. Tracking params (gclid/UTMs) are unknown for these rows and left
 * blank; the form name is what the export tagged.
 *
 *   npm run oneoff-backfill-och-form-log -- --dry-run
 *   npm run oneoff-backfill-och-form-log
 */
const CLIENT = "ohio-community-health-och";
const dryRun = process.argv.includes("--dry-run");
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    // Same idempotent statements as the dashboard's ensureSchema v117, so this
    // works before that deploy lands and is a no-op after it.
    if (!dryRun) {
      await c.query(`ALTER TABLE web_inquiries ADD COLUMN IF NOT EXISTS form_name TEXT`);
      await c.query(`ALTER TABLE web_inquiries ADD COLUMN IF NOT EXISTS page_url TEXT`);
      // The (email, dob, gclid) identity index is what silently discarded every
      // phone-only organic lead after the first — it rejects this backfill for
      // the same reason. Dropping it is the dashboard's v117 change verbatim;
      // the deployed app's schema fast-path never re-runs the block that created
      // it, so this is safe before that deploy and a no-op after.
      await c.query(`DROP INDEX IF EXISTS uq_web_inquiries_identity`);
    }
    const { rows: existing } = await c.query<{ id: string; phone: string | null; email: string | null; submitted_at: Date; raw_json: string | null }>(
      `SELECT id, phone, email, submitted_at, raw_json FROM web_inquiries WHERE client_slug = $1`, [CLIENT],
    );
    const seen = new Map<string, Date[]>();
    const seenEmail = new Map<string, Date[]>();
    for (const r of existing) {
      const p = phone10(r.phone); if (p) seen.set(p, [...(seen.get(p) ?? []), new Date(r.submitted_at)]);
      const e = r.email?.trim().toLowerCase(); if (e) seenEmail.set(e, [...(seenEmail.get(e) ?? []), new Date(r.submitted_at)]);
    }

    // Rows already backfilled by an earlier run without an email: fill it in.
    let enriched = 0;
    for (const s of OCH_FORM_LOG) {
      const p = phone10(s.phone);
      if (!p || !s.email) continue;
      const row = existing.find((r) => phone10(r.phone) === p && !r.email && r.raw_json?.includes('"elementor-log-export"'));
      if (!row) continue;
      if (!dryRun) await c.query(`UPDATE web_inquiries SET email = $1 WHERE id = $2 AND email IS NULL`, [s.email, row.id]);
      enriched++;
    }
    if (enriched) console.log(`Filled in email on ${enriched} previously backfilled row(s).`);

    let inserted = 0, skipped = 0, noPhone = 0;
    for (const s of OCH_FORM_LOG) {
      const p = phone10(s.phone);
      const at = new Date(`${s.date}T16:00:00Z`); // noon ET; the export has dates only
      const near = (dates: Date[] | undefined) => (dates ?? []).some((d) => Math.abs(d.getTime() - at.getTime()) <= 7 * 86_400_000);
      const emailKey = s.email.trim().toLowerCase() || null;
      if (!p && !emailKey) { noPhone++; console.log(`  – ${s.date} ${s.name} (${s.via}): no phone or email, not backfilled`); continue; }
      const dupe = (p && near(seen.get(p))) || (emailKey && near(seenEmail.get(emailKey)));
      if (dupe) { skipped++; console.log(`  = ${s.date} ${s.name} (${s.via}): already in web_inquiries`); continue; }
      const parts = s.name.trim().split(/\s+/);
      const firstName = parts[0] ?? null;
      const lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
      console.log(`  + ${s.date} ${s.name} (${s.via})${dryRun ? " [dry-run]" : ""}`);
      if (!dryRun) {
        await c.query(
          `INSERT INTO web_inquiries (id, client_slug, first_name, last_name, email, phone, dob, gclid,
             utm_source, utm_medium, utm_campaign, utm_content, utm_term, form_name, page_url, raw_json, submitted_at)
           VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,'website','form',NULL,NULL,NULL,$7,NULL,$8,$9)`,
          [randomUUID(), CLIENT, firstName, lastName, s.email || null, s.phone || null, s.via,
           JSON.stringify({ source: "elementor-log-export", exportedAt: OCH_FORM_LOG_EXPORTED_AT, via: s.via }), at],
        );
      }
      if (p) seen.set(p, [...(seen.get(p) ?? []), at]);
      if (emailKey) seenEmail.set(emailKey, [...(seenEmail.get(emailKey) ?? []), at]);
      inserted++;
    }
    console.log(`\n${dryRun ? "Would insert" : "Inserted"} ${inserted} · already present ${skipped} · no phone/email ${noPhone} · of ${OCH_FORM_LOG.length}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

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
    }
    const { rows: existing } = await c.query<{ phone: string | null; submitted_at: Date }>(
      `SELECT phone, submitted_at FROM web_inquiries WHERE client_slug = $1`, [CLIENT],
    );
    const seen = new Map<string, Date[]>();
    for (const r of existing) { const p = phone10(r.phone); if (p) seen.set(p, [...(seen.get(p) ?? []), new Date(r.submitted_at)]); }

    let inserted = 0, skipped = 0, noPhone = 0;
    for (const s of OCH_FORM_LOG) {
      const p = phone10(s.phone);
      if (!p) { noPhone++; console.log(`  – ${s.date} ${s.name} (${s.via}): no phone, not backfilled`); continue; }
      const at = new Date(`${s.date}T16:00:00Z`); // noon ET; the export has dates only
      const dupe = (seen.get(p) ?? []).some((d) => Math.abs(d.getTime() - at.getTime()) <= 7 * 86_400_000);
      if (dupe) { skipped++; console.log(`  = ${s.date} ${s.name} (${s.via}): already in web_inquiries`); continue; }
      const parts = s.name.trim().split(/\s+/);
      const firstName = parts[0] ?? null;
      const lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
      console.log(`  + ${s.date} ${s.name} (${s.via})${dryRun ? " [dry-run]" : ""}`);
      if (!dryRun) {
        await c.query(
          `INSERT INTO web_inquiries (id, client_slug, first_name, last_name, email, phone, dob, gclid,
             utm_source, utm_medium, utm_campaign, utm_content, utm_term, form_name, page_url, raw_json, submitted_at)
           VALUES ($1,$2,$3,$4,NULL,$5,NULL,NULL,'website','form',NULL,NULL,NULL,$6,NULL,$7,$8)`,
          [randomUUID(), CLIENT, firstName, lastName, s.phone, s.via,
           JSON.stringify({ source: "elementor-log-export", exportedAt: OCH_FORM_LOG_EXPORTED_AT, via: s.via }), at],
        );
      }
      seen.set(p, [...(seen.get(p) ?? []), at]);
      inserted++;
    }
    console.log(`\n${dryRun ? "Would insert" : "Inserted"} ${inserted} · already present ${skipped} · no phone ${noPhone} · of ${OCH_FORM_LOG.length}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

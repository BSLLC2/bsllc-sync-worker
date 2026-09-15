#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * READ-ONLY. Counts and lists the blank-name `admissions` rows OCH's import
 * created while the Admission Board's column A heading was truncated from
 * "Name" to "h" (roughly 2026-09-09 → 2026-09-15).
 *
 * With no recognisable name column, `nameCol` resolved to -1 and every row was
 * written with `name: ""`. The unique index is
 * (client_slug, admitted_on, phone, name), so a blank-name row does not
 * conflict with the named row already sitting there — it INSERTS BESIDE it.
 * The "See who" drill-down has been showing a nameless twin of every admission
 * since. The import itself is fixed (it now fails loudly instead); this script
 * exists so a person can see the damage before deciding anything.
 *
 * It DELETES NOTHING and writes nothing. Two groups are reported separately
 * because they are not the same decision:
 *
 *   • blank-name rows that have a NAMED twin on the same (admitted_on, phone)
 *     — duplicates of a row that is still there. Removing one loses nothing.
 *   • blank-name rows with NO named twin — the only record of that admission
 *     on our side. Removing one loses the admission; it needs a re-import from
 *     a restored sheet first.
 *
 * Names are printed; phones are reduced to their last four digits. This is
 * health-adjacent data and the report only needs to identify a row.
 *
 *   npm run debug-och-duplicate-admissions
 *   npm run debug-och-duplicate-admissions -- --client=some-other-slug
 */
const DEFAULT_SLUG = "ohio-community-health-och";
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const last4 = (p: string | null) => { const d = (p ?? "").replace(/[^0-9]/g, ""); return d ? `***${d.slice(-4)}` : "(no phone)"; };

interface Row {
  id: string;
  admitted_on: string;
  phone: string | null;
  referent: string | null;
  attributable: boolean;
  attribution_source: string | null;
  created_at: string;
  twins: string;      // how many named rows share (admitted_on, phone)
  twin_names: string | null;
}

async function main() {
  const slug = process.argv.find((a) => a.startsWith("--client="))?.slice("--client=".length) ?? DEFAULT_SLUG;
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: totals } = await c.query<{ total: string; blank: string; named: string; first_blank: string | null; last_blank: string | null }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE coalesce(name, '') = '')::text AS blank,
              count(*) FILTER (WHERE coalesce(name, '') <> '')::text AS named,
              min(created_at) FILTER (WHERE coalesce(name, '') = '')::text AS first_blank,
              max(created_at) FILTER (WHERE coalesce(name, '') = '')::text AS last_blank
         FROM admissions WHERE client_slug = $1`, [slug]);
    const t = totals[0];
    if (!t) { console.log(`No admissions rows for "${slug}".`); return; }
    console.log(`Admissions for ${slug}: ${t.total} row(s) — ${t.named} named, ${t.blank} blank-name.`);
    if (t.blank === "0") { console.log("No blank-name rows. Nothing to report."); return; }
    console.log(`Blank-name rows were written between ${t.first_blank?.slice(0, 19) ?? "?"} and ${t.last_blank?.slice(0, 19) ?? "?"}.`);

    const { rows: byDay } = await c.query<{ d: string; n: string }>(
      `SELECT created_at::date::text AS d, count(*)::text AS n FROM admissions
        WHERE client_slug = $1 AND coalesce(name, '') = '' GROUP BY 1 ORDER BY 1`, [slug]);
    console.log("\nBlank-name rows by the day they were written:");
    for (const r of byDay) console.log(`  ${r.d}  ${r.n.padStart(4)}`);

    const { rows } = await c.query<Row>(
      `SELECT a.id, a.admitted_on, a.phone, a.referent, a.attributable, a.attribution_source, a.created_at::text,
              count(b.id)::text AS twins,
              string_agg(DISTINCT b.name, ', ') AS twin_names
         FROM admissions a
         LEFT JOIN admissions b
           ON b.client_slug = a.client_slug AND b.admitted_on = a.admitted_on
          AND coalesce(b.phone, '') = coalesce(a.phone, '') AND coalesce(b.name, '') <> ''
        WHERE a.client_slug = $1 AND coalesce(a.name, '') = ''
        GROUP BY a.id, a.admitted_on, a.phone, a.referent, a.attributable, a.attribution_source, a.created_at
        ORDER BY a.admitted_on, a.created_at`, [slug]);

    const dupes = rows.filter((r) => Number(r.twins) > 0);
    const orphans = rows.filter((r) => Number(r.twins) === 0);

    console.log(`\n── ${dupes.length} blank-name row(s) that DUPLICATE a named row (same admit date + phone) ──`);
    for (const r of dupes) {
      console.log(`  ${r.admitted_on} · ${last4(r.phone).padEnd(9)} · referent ${(r.referent ?? "-").slice(0, 28).padEnd(28)} · ${r.attributable ? "attributable" : "not attributable"} · duplicates: ${r.twin_names ?? "?"}`);
    }

    console.log(`\n── ${orphans.length} blank-name row(s) with NO named twin — the only record of that admission ──`);
    for (const r of orphans) {
      console.log(`  ${r.admitted_on} · ${last4(r.phone).padEnd(9)} · referent ${(r.referent ?? "-").slice(0, 28).padEnd(28)} · ${r.attributable ? "attributable" : "not attributable"} · written ${r.created_at.slice(0, 10)}`);
    }

    // What the drill-down and the monthly rollup are currently double-counting.
    const { rows: months } = await c.query<{ m: string; blank: string; named: string; blank_attr: string }>(
      `SELECT left(admitted_on, 7) AS m,
              count(*) FILTER (WHERE coalesce(name, '') = '')::text AS blank,
              count(*) FILTER (WHERE coalesce(name, '') <> '')::text AS named,
              count(*) FILTER (WHERE coalesce(name, '') = '' AND attributable)::text AS blank_attr
         FROM admissions WHERE client_slug = $1 GROUP BY 1 ORDER BY 1`, [slug]);
    console.log("\nBy admission month (named · blank · blank-and-counted-as-ours):");
    for (const r of months) console.log(`  ${r.m}  named ${r.named.padStart(3)} · blank ${r.blank.padStart(3)} · of those attributable ${r.blank_attr.padStart(3)}`);

    console.log(
      `\nNothing was changed. ${dupes.length} row(s) are safe to remove once somebody decides to; ` +
      `${orphans.length} are not — re-import from a restored Admission Board first, then re-check.`,
    );
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

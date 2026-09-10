#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { loadD365Config, getToken } from "./d365.js";

/**
 * One-time backfill of DPG's Website Leads for 2026-09-03 onward, from the
 * two places leads went before the dashboard was wired to receive them:
 *
 *   1. D365 Leads (the Gravity Forms → Power Automate flow) — one row per
 *      lead, form "DPG Quote Form", utm_source = the D365 Lead Source label.
 *   2. CallRail calls Sebastien pasted from the call log (14 unique callers,
 *      same list as oneoff-backfill-callrail-contacts) — one row per caller,
 *      form "Phone: <tracker>", timestamps from the log (America/New_York).
 *
 * Also corrects the one live CallRail row that landed before the attribution
 * fix (utm_source "offline" → the session's Direct). Dedupes against rows
 * already present by email or phone within a day, so re-running is safe.
 *
 *   npm run oneoff-backfill-dpg-web-inquiries -- --dry-run=true   (default)
 *   npm run oneoff-backfill-dpg-web-inquiries -- --dry-run=false
 */

const SLUG = "diesel-power-group";
const SINCE = "2026-09-03T00:00:00Z";

interface CallRow { phone: string; name: string; pool: "gbp" | "website"; when: string }
const CALLS: CallRow[] = [
  { phone: "5745368923", name: "Wireless C...", pool: "gbp", when: "Sep 9 4:06pm" },
  { phone: "6304006206", name: "I Matulevi...", pool: "gbp", when: "Sep 9 3:23pm" },
  { phone: "6613442429", name: "Kuldip Sid...", pool: "website", when: "Sep 9 12:51pm" },
  { phone: "7408167672", name: "Michele Ha...", pool: "website", when: "Sep 9 11:30am" },
  { phone: "3174941266", name: "Franklin ...", pool: "gbp", when: "Sep 9 10:01am" },
  { phone: "3177345666", name: "Indianapol...", pool: "gbp", when: "Sep 7 10:00am" },
  { phone: "7657482018", name: "Eric Hall", pool: "gbp", when: "Sep 9 9:54am" },
  { phone: "7658816759", name: "Five Star ...", pool: "gbp", when: "Sep 9 9:16am" },
  { phone: "4637105104", name: "Robledo,an...", pool: "gbp", when: "Sep 8 8:37am" },
  { phone: "5749466149", name: "Vander Haa...", pool: "gbp", when: "Sep 8 3:36pm" },
  { phone: "4197860419", name: "Colwell,mi...", pool: "gbp", when: "Sep 8 2:47pm" },
  { phone: "3178479904", name: "John Cleary", pool: "gbp", when: "Sep 8 2:22pm" },
  { phone: "5742687844", name: "Tyler Bern...", pool: "gbp", when: "Sep 8 11:59am" },
  { phone: "3306639006", name: "Tuscon Tru...", pool: "website", when: "Sep 3 6:42pm" },
];

// "Sep 9 4:06pm" (America/New_York, EDT = UTC-4 in September) → ISO.
function whenToIso(when: string): string {
  const m = when.match(/^Sep (\d+) (\d+):(\d+)(am|pm)$/);
  if (!m) throw new Error(`unparseable when: ${when}`);
  let h = Number(m[2]) % 12;
  if (m[4] === "pm") h += 12;
  return `2026-09-${String(m[1]).padStart(2, "0")}T${String(h).padStart(2, "0")}:${m[3]}:00-04:00`;
}

function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const last10 = (p: string | null) => (p ?? "").replace(/[^0-9]/g, "").slice(-10) || null;

async function main() {
  const dryRun = !process.argv.includes("--dry-run=false");
  const db = new pg.Client({ connectionString: env("DATABASE_URL") });
  await db.connect();
  const cfg = loadD365Config();
  const token = await getToken(cfg);
  const base = cfg.resourceUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json", Prefer: "odata.maxpagesize=500" };

  let inserted = 0, skipped = 0;
  const exists = async (email: string | null, phone: string | null, at: string): Promise<boolean> => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM web_inquiries
        WHERE client_slug = $1 AND submitted_at BETWEEN $4::timestamptz - interval '1 day' AND $4::timestamptz + interval '1 day'
          AND (($2::text IS NOT NULL AND lower(email) = lower($2))
            OR ($3::text IS NOT NULL AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $3))`,
      [SLUG, email, last10(phone), at],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  };
  const insert = async (r: { first: string | null; last: string | null; email: string | null; phone: string | null; utmSource: string | null; form: string; at: string; raw: object }) => {
    if (await exists(r.email, r.phone, r.at)) { console.log(`SKIP    ${r.form} · ${r.first ?? ""} ${r.last ?? ""} · ${r.email ?? r.phone} — already present`); skipped++; return; }
    console.log(`INSERT  ${r.form} · ${r.first ?? ""} ${r.last ?? ""} · ${r.email ?? r.phone} · ${r.at}${r.utmSource ? ` · ${r.utmSource}` : ""}`);
    if (!dryRun) {
      await db.query(
        `INSERT INTO web_inquiries (id, client_slug, first_name, last_name, email, phone, utm_source, form_name, page_url, raw_json, submitted_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, 'https://dieselpowergroup.com/', $8, $9::timestamptz)`,
        [SLUG, r.first, r.last, r.email, r.phone, r.utmSource, r.form, JSON.stringify(r.raw), r.at],
      );
    }
    inserted++;
  };

  // 1. D365 leads since Sep 3, with Lead Source labels resolved from metadata.
  const labels = new Map<number, string>();
  try {
    const metaRes = await fetch(`${base}/api/data/v9.2/EntityDefinitions(LogicalName='lead')/Attributes(LogicalName='leadsourcecode')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`, { headers });
    if (metaRes.ok) {
      const meta = (await metaRes.json()) as { OptionSet?: { Options?: Array<{ Value: number; Label?: { UserLocalizedLabel?: { Label?: string } } }> } };
      for (const o of meta.OptionSet?.Options ?? []) { const l = o.Label?.UserLocalizedLabel?.Label; if (l) labels.set(o.Value, l); }
    }
  } catch { /* fall back to numeric codes */ }

  const leadsRes = await fetch(`${base}/api/data/v9.2/leads?$select=leadid,firstname,lastname,emailaddress1,telephone1,mobilephone,leadsourcecode,createdon&$filter=createdon ge ${SINCE}&$orderby=createdon asc`, { headers });
  if (!leadsRes.ok) throw new Error(`leads ${leadsRes.status}: ${await leadsRes.text()}`);
  const leads = (await leadsRes.json()) as { value: Array<{ leadid: string; firstname: string | null; lastname: string | null; emailaddress1: string | null; telephone1: string | null; mobilephone: string | null; leadsourcecode: number | null; createdon: string }> };
  console.log(`D365: ${leads.value.length} lead(s) since ${SINCE}\n`);
  const isTest = (l: { firstname: string | null; lastname: string | null; emailaddress1: string | null }) =>
    /test/i.test(`${l.firstname ?? ""} ${l.lastname ?? ""}`) || /@test+\.com$|test/i.test(l.emailaddress1 ?? "");
  for (const l of leads.value) {
    if (isTest(l)) { console.log(`TEST    skipping ${l.firstname} ${l.lastname} <${l.emailaddress1}>`); skipped++; continue; }
    const src = l.leadsourcecode == null ? null : (labels.get(l.leadsourcecode) ?? String(l.leadsourcecode));
    await insert({ first: l.firstname, last: l.lastname, email: l.emailaddress1, phone: l.telephone1 ?? l.mobilephone, utmSource: src, form: "DPG Quote Form", at: l.createdon, raw: { backfill: "d365", leadid: l.leadid, leadsourcecode: l.leadsourcecode } });
  }

  // 2. CallRail callers from the pasted log.
  console.log(`\nCallRail: ${CALLS.length} caller(s)\n`);
  for (const c of CALLS) {
    const name = c.name.replace(/\.\.\.$/, "").trim();
    const form = c.pool === "gbp" ? "Phone: DPG Google Business Profile" : "Phone: DPG Website Pool";
    await insert({ first: name || null, last: null, email: null, phone: `+1${c.phone}`, utmSource: null, form, at: whenToIso(c.when), raw: { backfill: "callrail-log", pool: c.pool } });
  }

  // 3. Correct the live row that arrived before the attribution fix.
  const fix = await db.query<{ id: string }>(
    `SELECT id FROM web_inquiries WHERE client_slug = $1 AND form_name LIKE 'Phone:%' AND utm_source = 'offline'`, [SLUG]);
  for (const r of fix.rows) {
    console.log(`FIX     ${r.id}: utm offline/GBP → Direct`);
    if (!dryRun) await db.query(`UPDATE web_inquiries SET utm_source = 'Direct', utm_medium = 'Direct', utm_campaign = NULL, page_url = coalesce(page_url, 'https://dieselpowergroup.com/') WHERE id = $1`, [r.id]);
  }

  console.log(`\n${dryRun ? "DRY RUN — " : ""}${inserted} inserted, ${skipped} skipped, ${fix.rows.length} corrected.`);
  if (dryRun) console.log("Re-run with --dry-run=false to write.");
  await db.end();
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

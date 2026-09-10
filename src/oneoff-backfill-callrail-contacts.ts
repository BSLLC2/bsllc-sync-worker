#!/usr/bin/env tsx
import "dotenv/config";
import { loadD365Config, getToken, FTS } from "./d365.js";

/**
 * One-time backfill: 22 CallRail call-log rows Sebastien pasted (Sep 3-10),
 * 14 unique callers after dedup. Right now none of these callers have any
 * D365 record tying their call back to a BS-LLC-driven source, so if any of
 * them close as a deal later, classify() (see d365.ts) has nothing to work
 * with and the revenue falls out of billable attribution. This searches for
 * an existing Contact by phone, sets new_firsttouchsource ONLY if it's
 * currently blank (never overwrites a real first touch — e.g. someone who
 * found us by form first, called second), and creates a Contact if none
 * exists. Same classification the live CallRail-to-D365 flow will use going
 * forward: DPG Google Business Profile pool -> GOOGLE_BUSINESS_PROFILE,
 * DPG Website Pool -> WEBSITE_PHONE_CALL.
 *
 *   npm run oneoff-backfill-callrail-contacts -- --dry-run=true   (default)
 *   npm run oneoff-backfill-callrail-contacts -- --dry-run=false
 */

interface CallRow { phone: string; name: string; pool: "gbp" | "website"; when: string }

// Deduped by phone -- each caller's most informative row (longest/most recent).
const CALLS: CallRow[] = [
  { phone: "5745368923", name: "Wireless C...", pool: "gbp", when: "Sep 9 4:06pm, 29s" },
  { phone: "6304006206", name: "I Matulevi...", pool: "gbp", when: "Sep 9 3:23pm, 8m54s" },
  { phone: "6613442429", name: "Kuldip Sid...", pool: "website", when: "Sep 9 12:51pm, 3m6s" },
  { phone: "7408167672", name: "Michele Ha...", pool: "website", when: "Sep 9 11:30am, 7m9s" },
  { phone: "3174941266", name: "Franklin ...", pool: "gbp", when: "Sep 9 10:01am, 1m30s" },
  { phone: "3177345666", name: "Indianapol...", pool: "gbp", when: "Sep 9 10:00am, 9m30s (called 6x Sep 7-9)" },
  { phone: "7657482018", name: "Eric Hall", pool: "gbp", when: "Sep 9 9:54am, 5m56s" },
  { phone: "7658816759", name: "Five Star ...", pool: "gbp", when: "Sep 9 9:16am, 1m10s" },
  { phone: "4637105104", name: "Robledo,an...", pool: "gbp", when: "Sep 8 8:37am, 1m17s" },
  { phone: "5749466149", name: "Vander Haa...", pool: "gbp", when: "Sep 8 3:36pm, 1m6s (called 2x)" },
  { phone: "4197860419", name: "Colwell,mi...", pool: "gbp", when: "Sep 8 2:47pm, 6m56s (called 2x)" },
  { phone: "3178479904", name: "John Cleary", pool: "gbp", when: "Sep 8 2:22pm, 3m37s" },
  { phone: "5742687844", name: "Tyler Bern...", pool: "gbp", when: "Sep 8 11:59am, 1m48s" },
  { phone: "3306639006", name: "Tuscon Tru...", pool: "website", when: "Sep 3 6:42pm, 47s" },
];

function fts(pool: "gbp" | "website"): number {
  return pool === "gbp" ? FTS.GOOGLE_BUSINESS_PROFILE : FTS.WEBSITE_PHONE_CALL;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run=false") ? false : true;
  const cfg = loadD365Config();
  const token = await getToken(cfg);
  const base = cfg.resourceUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0" };

  let created = 0, updated = 0, skippedAlreadySet = 0, errors = 0;

  for (const call of CALLS) {
    try {
      const filter = `telephone1 eq '${call.phone}' or mobilephone eq '${call.phone}'`;
      const searchUrl = `${base}/api/data/v9.2/contacts?$select=contactid,fullname,new_firsttouchsource&$filter=${encodeURIComponent(filter)}`;
      const searchRes = await fetch(searchUrl, { headers });
      if (!searchRes.ok) throw new Error(`search ${searchRes.status}: ${await searchRes.text()}`);
      const search = (await searchRes.json()) as { value: Array<{ contactid: string; fullname: string; new_firsttouchsource: number | null }> };

      const targetFts = fts(call.pool);

      if (search.value.length === 0) {
        console.log(`CREATE  ${call.phone} (${call.name}, ${call.when}) -> new Contact, FTS=${targetFts}`);
        if (!dryRun) {
          const res = await fetch(`${base}/api/data/v9.2/contacts`, {
            method: "POST", headers,
            body: JSON.stringify({ telephone1: call.phone, lastname: call.name.replace(/\.\.\.$/, "").trim() || "(unknown caller)", new_firsttouchsource: targetFts }),
          });
          if (!res.ok) throw new Error(`create ${res.status}: ${await res.text()}`);
        }
        created++;
      } else {
        const existing = search.value[0]!;
        if (existing.new_firsttouchsource != null) {
          console.log(`SKIP    ${call.phone} (${existing.fullname}) -- already has FTS=${existing.new_firsttouchsource}, not overwriting`);
          skippedAlreadySet++;
        } else {
          console.log(`UPDATE  ${call.phone} (${existing.fullname}) -> FTS=${targetFts} (was blank)`);
          if (!dryRun) {
            const res = await fetch(`${base}/api/data/v9.2/contacts(${existing.contactid})`, {
              method: "PATCH", headers,
              body: JSON.stringify({ new_firsttouchsource: targetFts }),
            });
            if (!res.ok) throw new Error(`update ${res.status}: ${await res.text()}`);
          }
          updated++;
        }
      }
    } catch (e) {
      console.error(`ERROR   ${call.phone}: ${e instanceof Error ? e.message : e}`);
      errors++;
    }
  }

  console.log(`\n${dryRun ? "DRY RUN -- " : ""}${created} would-be-created, ${updated} would-be-updated, ${skippedAlreadySet} already set (skipped), ${errors} error(s).`);
  if (dryRun) console.log("Re-run with --dry-run=false to actually write to D365.");
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

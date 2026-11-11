#!/usr/bin/env tsx
/**
 * Every field a GAQL query in this repository selects exists on the API version the installed library speaks.
 *
 * WHY (2026-11-11): the structure snapshot selected `campaign.start_date` and `campaign.end_date`, which the installed
 * library's API version does not have. The platform refused the whole campaign query, the campaign kind came back "not
 * read", and a live account's snapshot held budgets, ad groups and keywords and no campaign at all, with a green run. No
 * unit test could see it because none of them ask the platform. This one asks the library's own field list.
 *
 * It reads the SELECT clause of every query written as a template literal in src/ads/*.ts and src/ads-*.ts and checks
 * each resource-qualified field against `fields.d.ts` of the installed `google-ads-api`. A field this cannot judge is not
 * invented away: the ones in KNOWN_UNVERIFIED are named with the reason, and a stale entry fails the run.
 *
 *   npm run verify-gaql-fields
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const here = dirname(fileURLToPath(import.meta.url));
const FIELDS = join(here, "..", "node_modules", "google-ads-api", "build", "src", "protos", "autogen", "fields.d.ts");

/** Fields that are selected and are not in the library's list. Each is a reading to settle, not a pass. */
export const KNOWN_UNVERIFIED: Record<string, string> = {
  "customer_negative_criterion.keyword.text": "Account-level negative keywords: the field list has no keyword on this resource, so that kind reads as not read (src/ads/structure-snapshot.ts ACCOUNT_NEGATIVE_GAQL). An owner decision.",
  "customer_negative_criterion.keyword.match_type": "Same query as above.",
};
/** Message fields the list names only as a whole message, selected here by sub-field. Unconfirmed; named, not hidden. */
const KNOWN_PREFIXES: Record<string, string> = {
  "recommendation.": "Recommendation payloads are selected by sub-field (src/ads/google-recs.ts); the list names the messages whole. Unconfirmed against a live account.",
};

export function loadFieldList(): { fields: Set<string>; resources: Set<string> } {
  const src = readFileSync(FIELDS, "utf8");
  const fields = new Set(Array.from(src.matchAll(/"([a-z_]+(?:\.[a-z_0-9]+)*)"/g)).map((m) => m[1]!));
  const resources = new Set(Array.from(fields).map((f) => f.split(".")[0]!));
  return { fields, resources };
}

/** The resource-qualified fields in the SELECT clause of every GAQL query in a source text. */
export function selectedFields(src: string, resources: ReadonlySet<string>): { field: string; from: string }[] {
  const out: { field: string; from: string }[] = [];
  for (const m of src.matchAll(/SELECT\s+([\s\S]*?)\s+FROM\s+([a-z_]+)/g)) {
    const from = m[2]!;
    if (!resources.has(from)) continue;                 // SQL against our own tables
    for (const raw of m[1]!.split(",")) {
      const t = raw.trim().replace(/\s+/g, " ");
      if (!/^[a-z_]+(\.[a-z_0-9]+)+$/.test(t)) continue; // `${...}`, aliases, SQL
      if (!resources.has(t.split(".")[0]!)) continue;
      out.push({ field: t, from });
    }
  }
  return out;
}

export function unknownFields(src: string, fields: ReadonlySet<string>, resources: ReadonlySet<string>): string[] {
  return Array.from(new Set(selectedFields(src, resources).map((s) => s.field).filter((f) => !fields.has(f))));
}

const { fields, resources } = loadFieldList();

console.log("\n1. The field list is read");
ok("the installed library's field list has campaign, metrics and segments", fields.size > 1000 && ["campaign.id", "metrics.clicks", "segments.date"].every((f) => fields.has(f)), `${fields.size} fields`);

console.log("\n2. SELF-TEST: the instrument sees a planted bad field");
ok("a field the API version has is not flagged", unknownFields("SELECT campaign.id, campaign.start_date_time FROM campaign", fields, resources).length === 0);
ok("campaign.start_date is flagged", unknownFields("SELECT campaign.id, campaign.start_date FROM campaign", fields, resources).join() === "campaign.start_date");
ok("a SQL select against our own table is left alone", unknownFields("SELECT c.id, c.name FROM clients c", fields, resources).length === 0);

console.log("\n3. Every field the ads queries select exists");
const dir = join(here);
const files = [
  ...readdirSync(join(dir, "ads")).filter((f) => f.endsWith(".ts") && !f.startsWith("verify")).map((f) => join(dir, "ads", f)),
  ...readdirSync(dir).filter((f) => /^ads-.*\.ts$/.test(f) && !f.startsWith("verify")).map((f) => join(dir, f)),
];
const used = new Set<string>();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const bad = unknownFields(src, fields, resources).filter((x) => {
    if (KNOWN_UNVERIFIED[x]) { used.add(x); return false; }
    const pre = Object.keys(KNOWN_PREFIXES).find((p) => x.startsWith(p));
    if (pre) { used.add(pre); return false; }
    return true;
  });
  ok(`${f.slice(dir.length + 1)} selects only fields the API version has`, bad.length === 0, bad.join(", "));
}
for (const k of [...Object.keys(KNOWN_UNVERIFIED), ...Object.keys(KNOWN_PREFIXES)]) {
  ok(`the allowance for ${k} is still needed`, used.has(k), "delete it when the query stops selecting it");
}

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll checks passed.");

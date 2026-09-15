#!/usr/bin/env tsx
/**
 * One rule decides whether an OCH admission was ours: a free-text "Referent"
 * cell somebody typed by hand. It is the whole of attribution for an account
 * with no CRM we can read, so it lives in one module and this proves that it
 * still behaves and that nobody has grown a second copy of it.
 *
 * A second word list is a second answer. The day somebody adds "gbp" to one of
 * them, the monthly number and the month's row-by-row readout disagree about
 * the same admissions and nothing says so.
 *
 * Pure: no sheet, no network, no database, no credential, no client data. The
 * Referent strings below are invented.
 *
 *   npm run verify-och-attribution
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isAttributable, referentVerdict, ATTRIBUTABLE_WORDS } from "./och-attribution.js";

const SRC = path.resolve(import.meta.dirname);
const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

console.log("OCH attribution — one rule, one place");
console.log("Pure. No sheet, no network, no database, no client account is contacted.\n");

// ── 1. The rule itself ──────────────────────────────────────────────────────
console.log("1. What the Referent rule counts as ours");
{
  ok("blank is never ours", !isAttributable("") && !isAttributable("   ") && !isAttributable(null) && !isAttributable(undefined));
  ok("a whole word from the list is ours", isAttributable("Google") && isAttributable("SEO") && isAttributable("Facebook"));
  ok("  …whatever the case or the punctuation", isAttributable("GOOGLE ADS") && isAttributable("web-form") && isAttributable("Online/Search"));
  ok("\"web form\" and \"paid search\" count as phrases too", isAttributable("Came in via web form") && isAttributable("paid search ad"));

  // The substring trap this rule exists to avoid: a referral centre whose name
  // happens to contain a keyword is not a marketing channel.
  ok("a name that merely contains a keyword is NOT ours", !isAttributable("Crossroads") && !isAttributable("Formworks Clinic"));
  ok("an ordinary referral is not ours", !isAttributable("Word of mouth") && !isAttributable("Alumni") && !isAttributable("Hospital"));
}

// ── 2. The two kinds of no ──────────────────────────────────────────────────
console.log("\n2. \"Not ours\" and \"we cannot tell\" are different answers");
{
  ok("a recognised channel reads as ours", referentVerdict("Google Ads") === "ours");
  ok("nothing typed reads as blank", referentVerdict("") === "blank" && referentVerdict("  ") === "blank" && referentVerdict(null) === "blank");
  ok("something we do not know reads as unrecognised", referentVerdict("Crossroads") === "unrecognised");
  ok("the verdict never contradicts the rule",
    ["Google", "Crossroads", "", "web form", "Alumni"].every((r) => (referentVerdict(r) === "ours") === isAttributable(r)));
  ok("the word list is still whole words, and still populated", ATTRIBUTABLE_WORDS.has("google") && ATTRIBUTABLE_WORDS.size > 10);
}

// ── 3. One copy, and only one ───────────────────────────────────────────────
console.log("\n3. Neither reader holds its own copy of the rule");
{
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && f !== "och-attribution.ts" && f !== "verify-och-attribution.ts");
  const withWordList = files.filter((f) => /\bconst ATTRIBUTABLE_WORDS\b/.test(read(f)));
  ok("no other file declares ATTRIBUTABLE_WORDS", withWordList.length === 0, withWordList.join(", "));
  const withOwnRule = files.filter((f) => /function isAttributable\s*\(/.test(read(f)));
  ok("no other file declares isAttributable", withOwnRule.length === 0, withOwnRule.join(", "));

  ok("import-och imports the rule", /from "\.\/och-attribution\.js"/.test(read("import-och.ts")));
}

// ── 4. The rule decides attribution, and nothing else does ─────────────────
console.log("\n4. The column resolver may recognise a Referent column; it never attributes a row");
{
  const cols = read("och-sheet-columns.ts");
  ok("the resolver uses the rule only to RECOGNISE a column of origins",
    /looksLikeReferentValue/.test(cols) && /never to attribute a row/.test(cols));
  const importer = read("import-och.ts");
  ok("the importer attributes with the shared rule", /const referentSaysYes = isAttributable\(row\[refCol\]\)/.test(importer));
  ok("  …and the month readout sorts its answers with the shared verdict", /referentVerdict\(d\.referent\)/.test(importer));
  ok("the importer stops when the board has no Referent column at all",
    /require: \["name", "date", "contact", "referent"\]/.test(importer));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll OCH attribution checks passed.");

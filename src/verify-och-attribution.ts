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
import { buildLeadIndex, matchAdmission, leadLine, MATCH_WINDOW_DAYS, type LeadRow } from "./och-lead-match.js";

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

// ── 5. The second way an admission becomes ours ────────────────────────────
// This is the path that went quiet unnoticed. On 2026-09-15 lifetime
// attribution moved 51 → 49 and it took two workflow logs to establish that
// the rescue still worked and had simply stopped counting two admissions
// credited on the strength of hand-typed rows. A fixture says it in a second.
console.log("\n5. An admission with no recognised Referent is still ours when a lead we captured matches");
{
  const admittedOn = new Date(Date.UTC(2026, 8, 20)); // 2026-09-20
  const day = (n: number) => new Date(Date.UTC(2026, 8, n));
  const lead = (over: Partial<LeadRow>): LeadRow => ({
    phone: "513-555-0142", dob: null, lastName: null, gclid: null,
    utmSource: null, utmMedium: null, rawJson: null, submittedAt: day(2), ...over,
  });
  const keys = { phone: "5135550142", lastDob: null };

  // A gclid: this person clicked an ad. Intake typed a referral partner.
  const adClick = buildLeadIndex([lead({ gclid: "Cj0KEQ" })]);
  const v1 = matchAdmission(adClick, keys, admittedOn);
  ok("a captured ad click attributes an admission whose Referent says something else", !!v1.attributing);
  ok("  …and the row says it was the ad click", leadLine(v1) === "our lead, ad click" && v1.via === "web_inquiry_phone");
  ok("  …while the Referent text on its own would not have", !isAttributable("Addiction Services - James H"));

  // A captured form with marketing UTMs and no gclid still attributes.
  const form = buildLeadIndex([lead({ utmSource: "google", utmMedium: "organic" })]);
  ok("a captured form with a marketing source attributes too", !!matchAdmission(form, keys, admittedOn).attributing);
  ok("  …and reads as a form, not an ad click", leadLine(matchAdmission(form, keys, admittedOn)) === "our lead, captured form");

  // Surname + DOB is the second key, for a board row with no usable phone.
  const byDob = buildLeadIndex([lead({ phone: null, lastName: "Navarro", dob: "1980-01-09", gclid: "Cj0KEQ" })]);
  const v2 = matchAdmission(byDob, { phone: null, lastDob: "navarro|19800109" }, admittedOn);
  ok("surname and date of birth match when there is no phone", !!v2.attributing && v2.via === "web_inquiry_dob");

  // The two that vanished: hand-typed rows from the client's own export.
  const typedIn = buildLeadIndex([lead({ utmSource: "website", utmMedium: "form", rawJson: JSON.stringify({ source: "elementor-log-export" }) })]);
  const v3 = matchAdmission(typedIn, keys, admittedOn);
  ok("a lead typed in from the client's export never attributes", v3.attributing === null);
  ok("  …however marketing-looking the columns somebody typed into it", typedIn.counts.attributing === 0);
  ok("  …but it is still reported as a lead we hold, not as nothing", leadLine(v3) === "our lead, typed in" && !!v3.known);

  // A lead with no tracking at all: a real enquiry, no channel.
  const untracked = buildLeadIndex([lead({})]);
  ok("a lead with no tracking proves the enquiry and not the channel",
    matchAdmission(untracked, keys, admittedOn).attributing === null && leadLine(matchAdmission(untracked, keys, admittedOn)) === "our lead, no tracking");

  // Nothing at all reads as nothing at all.
  ok("no lead reads as a dash", leadLine(matchAdmission(buildLeadIndex([]), keys, admittedOn)) === "—");

  // The window: a lead has to come first, and not from another era.
  const after = buildLeadIndex([lead({ gclid: "Cj0KEQ", submittedAt: new Date(Date.UTC(2026, 9, 30)) })]);
  ok("a lead captured after the admission does not explain it", matchAdmission(after, keys, admittedOn).attributing === null);
  const ancient = buildLeadIndex([lead({ gclid: "Cj0KEQ", submittedAt: new Date(admittedOn.getTime() - (MATCH_WINDOW_DAYS + 5) * 86_400_000) })]);
  ok(`  …nor does one from more than ${MATCH_WINDOW_DAYS} days before`, matchAdmission(ancient, keys, admittedOn).attributing === null);

  // And the importer must still run this path and count it.
  const importer = read("import-och.ts");
  ok("import-och runs the match on every admission", /matchAdmission\(leadIndex,/.test(importer));
  ok("  …attributes on it when the Referent text does not", /const webInquiryMatch = !referentSaysYes && !!verdict\.attributing/.test(importer));
  ok("  …says on each row which of the two ways made it ours", /ours: referent/.test(importer) && /ours: lead/.test(importer));
  ok("  …and says so out loud when the rescue matched nothing all run",
    /rescuedByLead === 0/.test(importer) && /matched nothing this run/.test(importer));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll OCH attribution checks passed.");

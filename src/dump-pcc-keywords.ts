#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, rankedKeywords, domainAuthority, bulkKeywordMetrics, type KeywordIdea } from "./dataforseo.js";

/**
 * READ-ONLY current-data audit for Pink Cash Cow (pinkcashcow.com).
 *
 * Semrush is out of API units account-wide, so the sitemap/keyword work in
 * Drive was built on 2022/2023 Semrush numbers presented without a fresh
 * check. This re-pulls from DataForSEO Labs — the second SEO API already
 * wired into this repo with live credentials — against the CORRECT audience
 * (furnished short-term rental owners/investors, not tenants), the service
 * line ("no traditional rentals" per the brand Discovery doc), and BOTH
 * markets (Cincinnati + Louisville, per the site's own footer).
 *
 *   npm run dump-pcc-keywords
 */

const DOMAIN = "pinkcashcow.com";

// The real, human-built 2023 "Blog Opportunities" list — investor/owner
// intent, furnished/short-term specific, each already carrying a content
// schema + writing guide in Drive. Checked EXACT-PHRASE (bulkKeywordMetrics),
// not expanded from a seed: DataForSEO's keyword_ideas endpoint broadens a
// seed topically and returns geography-blind noise ("porta potty rental" for
// an "airbnb management cincinnati" seed) with the local intent stripped out.
const TERMS_CIN = [
  "cincinnati rental management companies",
  "rental management cincinnati",
  "short term rental cincinnati",
  "short term rentals cincinnati",
  "property management cincinnati",
  "property manager cincinnati",
  "how to manage short term rentals",
  "best rental property management companies",
  "cincinnati property management",
  "furnished short term rentals cincinnati",
  "how to furnish a short term rental",
  "investment property cincinnati",
  "managing apartments",
  "owning a short term rental",
  "short term apartment rentals cincinnati",
];
// Same phrases, city swapped, for the 6 that are Cincinnati-qualified —
// checks a real market gap rather than guessing Louisville volume from the
// Cincinnati number.
const TERMS_LOU = TERMS_CIN
  .filter((t) => t.includes("cincinnati"))
  .map((t) => t.replace("cincinnati", "louisville"));

const n0 = (v: number | null) => (v == null ? "—" : v.toLocaleString("en-US"));
const money = (v: number | null) => (v == null ? "—" : `$${v.toFixed(2)}`);
const hr = (t: string) => console.log(`\n${"=".repeat(96)}\n${t}\n${"=".repeat(96)}`);

function table(rows: KeywordIdea[], limit = 20) {
  console.log(`  ${"keyword".padEnd(46)}${"vol".padStart(8)}${"KD".padStart(6)}${"CPC".padStart(9)}  intent`);
  for (const r of rows.slice(0, limit)) {
    console.log(`  ${r.keyword.slice(0, 45).padEnd(46)}${n0(r.volume).padStart(8)}${n0(r.difficulty).padStart(6)}${money(r.cpc).padStart(9)}  ${r.intent ?? "—"}`);
  }
  if (rows.length > limit) console.log(`  ... ${rows.length - limit} more not shown`);
}

async function main() {
  const creds = credsFromEnv();
  console.log(`\nPINK CASH COW — CURRENT KEYWORD DATA (DataForSEO Labs) — READ ONLY`);
  console.log(`Semrush is out of account-wide API units; this is the second SEO API, live credentials confirmed.`);

  // ── Current standing ────────────────────────────────────────────────────
  hr("A. CURRENT DOMAIN STANDING — pinkcashcow.com");
  try {
    const auth = await domainAuthority(creds, DOMAIN);
    console.log(`  backlink authority (DataForSEO rank, 0-1000 scale) ${n0(auth.authorityScore)}`);
    console.log(`  backlinks            ${n0(auth.backlinks)}`);
    console.log(`  referring domains    ${n0(auth.referringDomains)}`);
    console.log(`  est. traffic VALUE   ${money(auth.organicTraffic)}/mo  (ETV — what this traffic would cost as paid clicks; NOT a visit count)`);
    console.log(`  ranking keywords     ${n0(auth.keywordCount)}`);
    console.log(`\n  Not directly comparable to the 2023 Semrush baseline (Domain Authority 2, ~28`);
    console.log(`  organic users/mo) — different vendor, different scale, different metric`);
    console.log(`  (Moz-style DA 0-100 vs. DataForSEO backlink rank 0-1000; visits vs. traffic $).`);
    console.log(`  Directionally the domain now has a real backlink profile it didn't in 2023.`);
    console.log(`  Section B below (actual ranked keywords) is the trustworthy current-state read.`);
  } catch (e) {
    console.log(`  [UNAVAILABLE] ${e instanceof Error ? e.message : String(e)}`);
  }

  hr("B. WHAT THE SITE ACTUALLY RANKS FOR TODAY");
  try {
    const ranked = await rankedKeywords(creds, DOMAIN, "United States", "English", 100);
    console.log(`  ${ranked.length} ranked keywords returned.`);
    if (!ranked.length) console.log(`  Zero organic rankings. Consistent with the 2023 DA-2 baseline — this may still be a cold-start SEO problem, not a refresh problem.`);
    for (const r of ranked.slice(0, 30)) {
      console.log(`  #${String(r.rank ?? "—").padStart(3)}  ${r.keyword.slice(0, 44).padEnd(46)} vol ${n0(r.volume).padStart(6)}  KD ${n0(r.difficulty).padStart(4)}  ${r.url ?? ""}`);
    }
  } catch (e) {
    console.log(`  [UNAVAILABLE] ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Cincinnati — the real 2023 curated list, re-priced today ────────────
  hr("C. CINCINNATI — 2023 CURATED LIST, CURRENT VOLUME/DIFFICULTY/CPC");
  console.log(`  Same ${TERMS_CIN.length} phrases as the 2023 "Blog Opportunities" sheet (owner/investor`);
  console.log(`  intent, furnished/short-term specific). Re-priced with today's data.`);
  try {
    const metrics = await bulkKeywordMetrics(creds, TERMS_CIN, "United States", "English");
    table(metrics.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)), TERMS_CIN.length);
  } catch (e) {
    console.log(`  [UNAVAILABLE] ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Louisville — unconfirmed second market ──────────────────────────────
  hr("D. LOUISVILLE — UNCONFIRMED MARKET, per the site footer only");
  console.log(`  The 2021 website copy doc lists two locations: Cincinnati and Louisville.`);
  console.log(`  No prior keyword research (2022 or 2023) covers Louisville at all. Checking`);
  console.log(`  the ${TERMS_LOU.length} city-qualified terms from the Cincinnati list, swapped to Louisville,`);
  console.log(`  so the gap is sized, not just noted — confirm with the client whether`);
  console.log(`  Louisville is still active before this drives any sitemap decision.`);
  try {
    const metrics = await bulkKeywordMetrics(creds, TERMS_LOU, "United States", "English");
    table(metrics.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)), TERMS_LOU.length);
  } catch (e) {
    console.log(`  [UNAVAILABLE] ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Direct local competitor named in the 2022 sheet ─────────────────────
  hr("E. KEYWORD GAP vs. a named local competitor");
  console.log(`  "Balanced Property Solutions" appeared IN the 2022 target-keyword sheet as if`);
  console.log(`  it were a keyword — it is a competitor's brand name. Domain is unconfirmed, so`);
  console.log(`  this section is skipped rather than guessed. Provide the real domain to run it.`);

  console.log(`\nDONE — read only. No writes, no client-facing changes.\n`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

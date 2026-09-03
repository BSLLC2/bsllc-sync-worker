#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, keywordResearch, rankedKeywords, domainAuthority, keywordGap, type KeywordIdea } from "./dataforseo.js";

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

// Seeds are investor/owner-intent, furnished/short-term specific — the 2023
// "Blog Opportunities" list's framing, not the 2022 list's tenant-intent terms.
const SEEDS_CIN = [
  "property management cincinnati",
  "short term rental management cincinnati",
  "furnished rental management cincinnati",
  "airbnb management cincinnati",
];
const SEEDS_LOU = [
  "property management louisville",
  "short term rental management louisville",
  "airbnb management louisville",
];

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
    console.log(`  authority score      ${n0(auth.authorityScore)}`);
    console.log(`  backlinks            ${n0(auth.backlinks)}`);
    console.log(`  referring domains    ${n0(auth.referringDomains)}`);
    console.log(`  est. organic traffic ${n0(auth.organicTraffic)}/mo`);
    console.log(`  ranking keywords     ${n0(auth.keywordCount)}`);
    console.log(`\n  2023 Semrush baseline for comparison: Domain Authority 2, ~28 organic users/mo.`);
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

  // ── Cincinnati, correct-audience seeds ──────────────────────────────────
  for (const seed of SEEDS_CIN) {
    hr(`C. CINCINNATI — "${seed}"`);
    try {
      const ideas = await keywordResearch(creds, seed, "United States", "English", 100);
      // The audit finding from last time: filter OUT tenant-intent noise
      // ("for rent", "apartment for rent") a keyword_ideas pull for a PM seed
      // will still surface, so the owner/investor signal isn't buried again.
      const tenantNoise = /\bfor rent\b|\bapartments? for rent\b|\brent(al)? listings?\b/i;
      const ownerSide = ideas.filter((k) => !tenantNoise.test(k.keyword));
      const filtered = ideas.length - ownerSide.length;
      console.log(`  ${ideas.length} ideas returned; ${filtered} look tenant/renter-intent and are excluded below.`);
      table(ownerSide, 15);
    } catch (e) {
      console.log(`  [UNAVAILABLE] ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Louisville — unconfirmed second market ──────────────────────────────
  hr("D. LOUISVILLE — UNCONFIRMED MARKET, per the site footer only");
  console.log(`  The 2021 website copy doc lists two locations: Cincinnati and Louisville.`);
  console.log(`  No prior keyword research (2022 or 2023) covers Louisville at all. Pulling`);
  console.log(`  it now so the gap is sized, not just noted — confirm with the client whether`);
  console.log(`  Louisville is still active before this drives any sitemap decision.`);
  for (const seed of SEEDS_LOU) {
    console.log(`\n  "${seed}"`);
    try {
      const ideas = await keywordResearch(creds, seed, "United States", "English", 30);
      const tenantNoise = /\bfor rent\b|\bapartments? for rent\b/i;
      table(ideas.filter((k) => !tenantNoise.test(k.keyword)), 8);
    } catch (e) {
      console.log(`  [UNAVAILABLE] ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Direct local competitor named in the 2022 sheet ─────────────────────
  hr("E. KEYWORD GAP vs. a named local competitor");
  console.log(`  "Balanced Property Solutions" appeared IN the 2022 target-keyword sheet as if`);
  console.log(`  it were a keyword — it is a competitor's brand name. Domain is unconfirmed, so`);
  console.log(`  this section is skipped rather than guessed. Provide the real domain to run it.`);

  console.log(`\nDONE — read only. No writes, no client-facing changes.\n`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, rankedKeywords, domainAuthority, bulkKeywordMetrics, keywordGap, type KeywordIdea, type DfsCreds } from "./dataforseo.js";

/**
 * READ-ONLY validation of the Integrus Partners strategy deck (Sam, 2026-09-21)
 * against live DataForSEO data. Checks, in this order, because revenue comes
 * from the bottom of the funnel first:
 *   A. what integruspartners.com ranks for today, and its authority vs. the
 *      competitor set the client named
 *   B. the deck's own search-volume claims, re-priced exact-phrase
 *   C. a BOFU/MOFU seller-intent keyword set per priority vertical
 *   D. who actually owns the top-10 for the highest-value BOFU terms
 *   E. seller-intent keyword gaps vs. PGP and Provident
 *   F. the live site: sitemap, titles, H1s, meta — the audit's duplicate/
 *      missing-page claims checked against what is served today
 *
 *   npm run integrus-strategy-check
 */

const DOMAIN = "integruspartners.com";

const COMPETITORS: Array<{ name: string; domain: string; note: string }> = [
  { name: "Physician Growth Partners", domain: "physiciangrowthpartners.com", note: "client-named, 'true banker', content-led" },
  { name: "Provident Healthcare Partners", domain: "providenthp.com", note: "client-named, 'true banker'" },
  { name: "Skytale Group", domain: "skytalegroup.com", note: "client-named, rebuilt site, expanding verticals" },
  { name: "Practice Transitions Group", domain: "practicetransitions.com", note: "client-named broker" },
  { name: "Large Practice Sales", domain: "largepracticesales.com", note: "client-named broker" },
  { name: "1st Med Capital", domain: "1stmedcapital.com", note: "background research: dental/healthcare sell-side" },
  { name: "Forged Advisory", domain: "forgedadvisor.com", note: "background research: veterinary sell-side" },
  { name: "Integris Partners (name collision)", domain: "integrispartners.com", note: "unrelated middle-market bank, one letter off" },
];

// The deck's volume claims, exact phrase as the deck words them, plus the
// obvious phrasing variants a seller actually types. [n] = deck footnote.
const DECK_CLAIMS: Array<{ claim: string; deck: number; terms: string[] }> = [
  { claim: "[1] dental practice broker ~1,000", deck: 1000, terms: ["dental practice broker", "dental practice brokers", "dental broker"] },
  { claim: "[1] dental valuation ~720", deck: 720, terms: ["dental practice valuation", "dental practice appraisal", "how much is my dental practice worth", "dental practice valuation calculator"] },
  { claim: "[1] sell dental practice ~590", deck: 590, terms: ["sell dental practice", "sell my dental practice", "selling a dental practice", "sell dental practice to dso"] },
  { claim: "[2] HVAC valuation ~320", deck: 320, terms: ["hvac business valuation", "hvac company valuation", "how much is my hvac business worth", "hvac business worth"] },
  { claim: "[2] roofing valuation ~20", deck: 20, terms: ["roofing business valuation", "roofing company valuation", "sell my roofing business", "sell roofing company"] },
  { claim: "[2] sell garage-door business ~20", deck: 20, terms: ["sell garage door business", "garage door business valuation", "sell my garage door company"] },
  { claim: "[4] sell veterinary practice ~170", deck: 170, terms: ["sell veterinary practice", "sell my veterinary practice", "selling a veterinary practice", "sell vet practice"] },
  { claim: "[5] oral surgery valuation ~40", deck: 40, terms: ["oral surgery practice valuation", "sell oral surgery practice", "oral surgery practice for sale", "oms practice valuation"] },
  { claim: "[5] dermatology valuation ~50", deck: 50, terms: ["dermatology practice valuation", "sell dermatology practice", "dermatology practice for sale", "sell my dermatology practice"] },
  { claim: "[6] ASC valuation ~320", deck: 320, terms: ["asc valuation", "ambulatory surgery center valuation", "sell ambulatory surgery center", "surgery center valuation", "asc for sale"] },
];

// BOFU / MOFU seller-intent set by vertical. BOFU = "I am selling / what is it
// worth / who do I hire"; MOFU = "I have an offer / how do buyers think";
// TOFU is deliberately last and short.
const VERTICAL_SETS: Array<{ vertical: string; role: string; bofu: string[]; mofu: string[] }> = [
  { vertical: "Dental", role: "deck: OWN", bofu: ["dental m&a advisor", "dental practice sale advisor", "dental practice transition consultant", "dental practice broker near me", "sell dental practice to private equity", "dental practice buyers", "dso buyers"], mofu: ["dental practice ebitda multiple", "dental practice valuation multiples", "dso offer", "dso offer letter", "how much do dsos pay for dental practices", "dso vs private buyer", "selling to a dso", "dental practice sale price"] },
  { vertical: "Veterinary", role: "deck: OWN-SUPPORT", bofu: ["veterinary practice valuation", "veterinary practice broker", "veterinary practice sales", "vet practice valuation", "veterinary practice for sale", "sell vet practice to corporate", "veterinary m&a advisor"], mofu: ["veterinary practice ebitda multiple", "veterinary practice valuation multiples", "corporate veterinary buyers", "selling veterinary practice to corporate", "veterinary practice sale price", "how much is my vet practice worth"] },
  { vertical: "HVAC / Residential", role: "deck: OWN (HVAC-led)", bofu: ["sell my hvac business", "sell hvac company", "hvac business broker", "hvac m&a advisor", "sell hvac business to private equity", "hvac company for sale", "plumbing business valuation", "sell my plumbing business"], mofu: ["hvac ebitda multiple", "hvac business valuation multiples", "private equity hvac", "private equity hvac acquisitions", "hvac private equity buyers", "hvac company sale price"] },
  { vertical: "Oral Surgery", role: "deck: SUPPORT", bofu: ["oral surgery practice broker", "sell my oral surgery practice", "oral surgery practice transition"], mofu: ["oral surgery practice ebitda multiple", "oral surgery dso", "oral surgery private equity", "oral surgery practice sale"] },
  { vertical: "Dermatology", role: "deck: SUPPORT", bofu: ["dermatology practice broker", "dermatology m&a", "sell dermatology practice private equity"], mofu: ["dermatology practice ebitda multiple", "dermatology private equity", "dermatology practice sale multiples", "dermatology practice buyers"] },
  { vertical: "ASC", role: "deck: TEST", bofu: ["sell surgery center", "asc broker", "ambulatory surgery center for sale", "surgery center for sale"], mofu: ["asc ebitda multiple", "ambulatory surgery center multiples", "surgery center private equity", "asc private equity", "asc management company acquisition"] },
  { vertical: "Infusion / Dental Lab / CRO", role: "deck: WATCH", bofu: ["sell infusion center", "infusion center valuation", "sell dental lab", "dental lab valuation", "dental laboratory for sale", "sell clinical research site", "cro valuation", "clinical research site valuation"], mofu: ["infusion center private equity", "dental lab private equity", "clinical research site private equity", "site management organization acquisition"] },
  { vertical: "Cross-vertical (owner decision moments)", role: "deck: content spine", bofu: ["sell side m&a advisor", "m&a advisor for small business", "sell my business to private equity", "sell my practice", "how to sell my practice", "medical practice valuation", "medical practice broker", "practice valuation"], mofu: ["unsolicited offer for my business", "should i sell my practice to private equity", "rollover equity", "what is rollover equity", "rollover equity private equity", "ebitda adjustments", "adjusted ebitda", "letter of intent business sale", "earnout", "investment banker vs business broker", "how private equity values a business", "what happens when private equity buys your practice", "how to compare two offers for my business", "quality of earnings", "private equity recapitalization"] },
];
const BRAND = ["integrus partners", "integrus", "integris partners", "integrus partners dallas"];

// Highest-value BOFU terms: who owns the SERP today, ads present, AI overview.
const SERP_TERMS = [
  "sell my dental practice", "dental practice valuation", "dental practice broker",
  "sell my veterinary practice", "veterinary practice valuation",
  "sell my hvac business", "hvac business valuation",
  "sell oral surgery practice", "sell dermatology practice",
  "ambulatory surgery center valuation",
  "unsolicited offer for my business", "rollover equity",
];

const n0 = (v: number | null) => (v == null ? "—" : v.toLocaleString("en-US"));
const money = (v: number | null) => (v == null ? "—" : `$${v.toFixed(2)}`);
const hr = (t: string) => console.log(`\n${"=".repeat(96)}\n${t}\n${"=".repeat(96)}`);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const SELLER_RX = /sell|selling|sale|valuation|worth|multiple|ebitda|broker|advisor|advisory|private equity|\bpe\b|dso|acquisition|buyer|offer|rollover|earnout|loi|due diligence|exit|transition/i;

function table(rows: KeywordIdea[], limit = 40) {
  console.log(`  ${"keyword".padEnd(48)}${"vol".padStart(7)}${"KD".padStart(5)}${"CPC".padStart(9)}`);
  for (const r of rows.slice(0, limit)) console.log(`  ${r.keyword.slice(0, 47).padEnd(48)}${n0(r.volume).padStart(7)}${n0(r.difficulty).padStart(5)}${money(r.cpc).padStart(9)}`);
  if (rows.length > limit) console.log(`  ... ${rows.length - limit} more not shown`);
}

async function dfsPost(creds: DfsCreds, path: string, body: unknown): Promise<any> {
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DataForSEO ${path} HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

/** Top-10 organic domains + ads/AI-overview/PAA presence for one keyword. */
async function serpTop(creds: DfsCreds, keyword: string) {
  const resp = await dfsPost(creds, "/serp/google/organic/live/advanced", [{ keyword, location_name: "United States", language_name: "English", device: "desktop", depth: 10 }]);
  const rt = resp?.tasks?.[0];
  if (!rt || rt.status_code !== 20000) throw new Error(rt?.status_message || "no task result");
  const items: any[] = rt.result?.[0]?.items ?? [];
  const organic = items.filter((i) => i?.type === "organic").slice(0, 10).map((i) => ({ domain: String(i.domain ?? "").replace(/^www\./, ""), title: String(i.title ?? "") }));
  const paid = items.filter((i) => i?.type === "paid").map((i) => String(i.domain ?? "").replace(/^www\./, ""));
  const types = new Set(items.map((i) => String(i?.type)));
  return { organic, paid, aiOverview: types.has("ai_overview"), paa: types.has("people_also_ask"), types: [...types] };
}

// ── Live site inventory (fetched from the runner; the sandbox cannot reach it) ──
async function fetchText(url: string): Promise<{ status: number; text: string; finalUrl: string }> {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (BS LLC read-only audit)" } });
  return { status: res.status, text: await res.text(), finalUrl: res.url };
}
function pick(html: string, re: RegExp): string { const m = re.exec(html); return m ? m[1]!.replace(/\s+/g, " ").trim() : ""; }
function decode(s: string) { return s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " "); }

async function main() {
  const creds = credsFromEnv();
  console.log(`\nINTEGRUS PARTNERS — STRATEGY DECK CHECK (DataForSEO, live) — READ ONLY — ${new Date().toISOString().slice(0, 10)}`);

  // ── A ────────────────────────────────────────────────────────────────────
  hr("A. WHERE INTEGRUS STANDS TODAY vs. THE CLIENT-NAMED COMPETITOR SET");
  console.log(`  ${"domain".padEnd(32)}${"auth".padStart(6)}${"refdoms".padStart(9)}${"kw".padStart(7)}${"ETV$/mo".padStart(9)}  note`);
  const standing: Array<{ domain: string; kw: number | null }> = [];
  for (const c of [{ name: "INTEGRUS", domain: DOMAIN, note: "the client" }, ...COMPETITORS]) {
    try {
      const a = await domainAuthority(creds, c.domain);
      standing.push({ domain: c.domain, kw: a.keywordCount });
      console.log(`  ${c.domain.padEnd(32)}${n0(a.authorityScore).padStart(6)}${n0(a.referringDomains).padStart(9)}${n0(a.keywordCount).padStart(7)}${n0(a.organicTraffic).padStart(9)}  ${c.note}`);
    } catch (e) {
      console.log(`  ${c.domain.padEnd(32)} [UNAVAILABLE] ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
    }
  }
  console.log(`  auth = DataForSEO backlink rank (0-1000); kw = organic keywords ranking; ETV = est. monthly traffic value in paid-click $ (not visits).`);

  console.log(`\n  What ${DOMAIN} ranks for today (top 40 by volume):`);
  try {
    const ranked = await rankedKeywords(creds, DOMAIN, "United States", "English", 200);
    console.log(`  ${ranked.length} ranked keywords returned; ${ranked.filter((r) => (r.rank ?? 999) <= 10).length} in the top 10; ${ranked.filter((r) => SELLER_RX.test(r.keyword) && !/integrus|integris/i.test(r.keyword)).length} carry seller intent and are non-brand.`);
    for (const r of ranked.slice(0, 40)) console.log(`  #${String(r.rank ?? "—").padStart(3)}  ${r.keyword.slice(0, 44).padEnd(46)} vol ${n0(r.volume).padStart(6)}  KD ${n0(r.difficulty).padStart(3)}  ${(r.url ?? "").replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}`);
  } catch (e) { console.log(`  [UNAVAILABLE] ${e instanceof Error ? e.message : String(e)}`); }

  // ── B ────────────────────────────────────────────────────────────────────
  hr("B. THE DECK'S VOLUME CLAIMS, RE-PRICED EXACT-PHRASE (Google Ads volume, US)");
  const claimTerms = [...new Set(DECK_CLAIMS.flatMap((c) => c.terms))];
  let claimMetrics: KeywordIdea[] = [];
  try { claimMetrics = await bulkKeywordMetrics(creds, claimTerms); } catch (e) { console.log(`  [UNAVAILABLE] ${e instanceof Error ? e.message : String(e)}`); }
  const byKw = new Map(claimMetrics.map((m) => [norm(m.keyword), m]));
  for (const c of DECK_CLAIMS) {
    const rows = c.terms.map((t) => byKw.get(norm(t))).filter((m): m is KeywordIdea => !!m);
    const best = rows.reduce((a, b) => ((b.volume ?? 0) > (a?.volume ?? -1) ? b : a), rows[0]);
    const cluster = rows.reduce((s, r) => s + (r.volume ?? 0), 0);
    const verdict = !best ? "no data" : (best.volume ?? 0) >= c.deck * 0.7 && (best.volume ?? 0) <= c.deck * 1.5 ? "HOLDS" : (best.volume ?? 0) > c.deck * 1.5 ? "UNDERSTATED" : "OVERSTATED";
    console.log(`\n  ${c.claim.padEnd(38)} best phrase ${n0(best?.volume ?? null)}/mo  cluster ${n0(cluster)}/mo  → ${verdict}`);
    for (const r of rows.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))) console.log(`      ${r.keyword.padEnd(46)}${n0(r.volume).padStart(7)}  KD ${n0(r.difficulty).padStart(3)}  CPC ${money(r.cpc)}`);
  }
  console.log(`\n  HOLDS = within 0.7-1.5x of the deck figure. Google Ads volume is a 12-month average; the deck's source may differ (Semrush/Keyword Planner ranges).`);

  // ── C ────────────────────────────────────────────────────────────────────
  hr("C. BOFU / MOFU SELLER-INTENT DEMAND BY PRIORITY VERTICAL (exact phrase)");
  const allSet = [...new Set([...VERTICAL_SETS.flatMap((v) => [...v.bofu, ...v.mofu]), ...BRAND])];
  let setMetrics: KeywordIdea[] = [];
  try { setMetrics = await bulkKeywordMetrics(creds, allSet); } catch (e) { console.log(`  [UNAVAILABLE] ${e instanceof Error ? e.message : String(e)}`); }
  const byKw2 = new Map(setMetrics.map((m) => [norm(m.keyword), m]));
  const get = (t: string) => byKw2.get(norm(t)) ?? byKw.get(norm(t));
  const summary: Array<{ vertical: string; role: string; bofu: number; mofu: number; cpc: number; n: number }> = [];
  for (const v of VERTICAL_SETS) {
    const b = v.bofu.map(get).filter((m): m is KeywordIdea => !!m);
    const m = v.mofu.map(get).filter((x): x is KeywordIdea => !!x);
    const bv = b.reduce((s, r) => s + (r.volume ?? 0), 0), mv = m.reduce((s, r) => s + (r.volume ?? 0), 0);
    const cpcs = [...b, ...m].map((r) => r.cpc).filter((x): x is number => x != null);
    summary.push({ vertical: v.vertical, role: v.role, bofu: bv, mofu: mv, cpc: cpcs.length ? cpcs.reduce((s, x) => s + x, 0) / cpcs.length : 0, n: b.length + m.length });
    console.log(`\n  ${v.vertical}  (${v.role})   BOFU ${n0(bv)}/mo   MOFU ${n0(mv)}/mo`);
    console.log(`    BOFU:`); table(b.sort((a, c) => (c.volume ?? 0) - (a.volume ?? 0)), 12);
    console.log(`    MOFU:`); table(m.sort((a, c) => (c.volume ?? 0) - (a.volume ?? 0)), 12);
  }
  console.log(`\n  SUMMARY — where the seller-intent demand actually is (deck role beside it):`);
  console.log(`  ${"vertical".padEnd(40)}${"role".padEnd(22)}${"BOFU/mo".padStart(9)}${"MOFU/mo".padStart(9)}${"avgCPC".padStart(9)}`);
  for (const s of summary.sort((a, b) => (b.bofu + b.mofu) - (a.bofu + a.mofu))) console.log(`  ${s.vertical.padEnd(40)}${s.role.padEnd(22)}${n0(s.bofu).padStart(9)}${n0(s.mofu).padStart(9)}${money(s.cpc).padStart(9)}`);
  console.log(`\n  Brand terms:`); table(BRAND.map(get).filter((m): m is KeywordIdea => !!m), 6);
  // Also: what Google's own ideas add around the two OWN verticals that the curated set may have missed
  console.log(`\n  Missed demand — Google keyword ideas seeded on the OWN verticals, seller-intent only, vol ≥ 50 (top 25):`);
  try {
    const ideasResp = await dfsPost(creds, "/dataforseo_labs/google/keyword_ideas/live", [{ keywords: ["sell dental practice", "dental practice valuation", "sell veterinary practice", "sell hvac business", "hvac business valuation"], location_name: "United States", language_name: "English", limit: 400, order_by: ["keyword_info.search_volume,desc"] }]);
    const items: any[] = ideasResp?.tasks?.[0]?.result?.[0]?.items ?? [];
    const known = new Set([...byKw.keys(), ...byKw2.keys()]);
    const extra = items.map((it) => ({ keyword: String(it?.keyword ?? ""), volume: it?.keyword_info?.search_volume ?? null, difficulty: it?.keyword_properties?.keyword_difficulty ?? null, cpc: it?.keyword_info?.cpc ?? null, intent: it?.search_intent_info?.main_intent ?? null, serpFeatures: null }))
      .filter((k) => k.keyword && !known.has(norm(k.keyword)) && SELLER_RX.test(k.keyword) && (k.volume ?? 0) >= 50 && !/job|salary|school|course|near me hiring|resume/i.test(k.keyword));
    table(extra as KeywordIdea[], 25);
  } catch (e) { console.log(`  [UNAVAILABLE] ${e instanceof Error ? e.message : String(e)}`); }

  // ── D ────────────────────────────────────────────────────────────────────
  hr("D. WHO OWNS THE TOP-10 TODAY for the highest-value BOFU terms (live Google, US desktop)");
  const compSet = new Set(COMPETITORS.map((c) => c.domain));
  const domainTally = new Map<string, number>();
  for (const term of SERP_TERMS) {
    try {
      const s = await serpTop(creds, term);
      const ours = s.organic.findIndex((o) => o.domain.endsWith(DOMAIN));
      console.log(`\n  "${term}"  ${s.aiOverview ? "[AI OVERVIEW]" : ""}${s.paa ? "[PAA]" : ""}${s.paid.length ? `[ADS: ${[...new Set(s.paid)].slice(0, 4).join(", ")}]` : "[no ads]"}  Integrus: ${ours >= 0 ? `#${ours + 1}` : "not in top 10"}`);
      s.organic.forEach((o, i) => { domainTally.set(o.domain, (domainTally.get(o.domain) ?? 0) + 1); console.log(`    ${String(i + 1).padStart(2)}. ${o.domain.padEnd(36)}${compSet.has(o.domain) ? " ← named competitor" : ""} ${o.title.slice(0, 60)}`); });
    } catch (e) { console.log(`\n  "${term}" [UNAVAILABLE] ${e instanceof Error ? e.message : String(e)}`); }
  }
  console.log(`\n  Domains appearing most across these ${SERP_TERMS.length} SERPs (the real digital competitive set, whoever the client named):`);
  for (const [d, n] of [...domainTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${String(n).padStart(2)}x  ${d}${compSet.has(d) ? "  ← named competitor" : ""}`);

  // ── E ────────────────────────────────────────────────────────────────────
  hr("E. SELLER-INTENT KEYWORD GAPS vs. the two 'true banker' competitors");
  for (const comp of ["physiciangrowthpartners.com", "providenthp.com"]) {
    try {
      const gaps = (await keywordGap(creds, DOMAIN, comp, "United States", "English", 30, 400)).filter((g) => SELLER_RX.test(g.keyword) && !/job|career|salary|login/i.test(g.keyword));
      console.log(`\n  ${comp} ranks top-30 for ${gaps.length} seller-intent terms Integrus does not rank for at all. Top 20 by volume:`);
      console.log(`  ${"keyword".padEnd(48)}${"vol".padStart(7)}${"KD".padStart(5)}${"CPC".padStart(9)}  comp#`);
      for (const g of gaps.slice(0, 20)) console.log(`  ${g.keyword.slice(0, 47).padEnd(48)}${n0(g.volume).padStart(7)}${n0(g.difficulty).padStart(5)}${money(g.cpc).padStart(9)}  #${g.competitorRank ?? "—"}`);
    } catch (e) { console.log(`\n  ${comp} [UNAVAILABLE] ${e instanceof Error ? e.message : String(e)}`); }
  }

  // ── F ────────────────────────────────────────────────────────────────────
  hr("F. THE LIVE SITE — sitemap, titles, H1s, meta (fetched from the runner just now)");
  try {
    const robots = await fetchText(`https://www.${DOMAIN}/robots.txt`);
    console.log(`  robots.txt ${robots.status}: ${robots.text.replace(/\s+/g, " ").slice(0, 200)}`);
    const sm = await fetchText(`https://www.${DOMAIN}/sitemap.xml`);
    let locs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!.trim());
    console.log(`  sitemap.xml ${sm.status}: ${locs.length} <loc> entries${sm.text.includes("<sitemapindex") ? " (index)" : ""}`);
    if (sm.text.includes("<sitemapindex")) {
      const children = locs; locs = [];
      for (const child of children.slice(0, 10)) { try { const c = await fetchText(child); locs.push(...[...c.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!.trim())); } catch { /* skip */ } }
      console.log(`  expanded to ${locs.length} URLs across ${children.length} child sitemaps`);
    }
    const urls = [...new Set(locs)].slice(0, 60);
    const pages: Array<{ url: string; status: number; title: string; h1s: string[]; desc: string; canonical: string; words: number }> = [];
    for (let i = 0; i < urls.length; i += 4) {
      await Promise.all(urls.slice(i, i + 4).map(async (u) => {
        try {
          const p = await fetchText(u);
          const html = p.text;
          const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => decode(m[1]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())).filter(Boolean);
          const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ");
          pages.push({ url: u, status: p.status, title: decode(pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i)), h1s, desc: decode(pick(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || pick(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)), canonical: pick(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i), words: body.split(/\s+/).filter((w) => w.length > 2).length });
        } catch (e) { pages.push({ url: u, status: 0, title: `[fetch failed: ${e instanceof Error ? e.message.slice(0, 40) : e}]`, h1s: [], desc: "", canonical: "", words: 0 }); }
      }));
    }
    pages.sort((a, b) => a.url.localeCompare(b.url));
    console.log(`\n  ${pages.length} pages fetched. url | status | words | H1 count | title`);
    for (const p of pages) console.log(`  ${p.url.replace(/^https?:\/\/(www\.)?/, "").padEnd(58).slice(0, 58)} ${String(p.status).padStart(3)} ${String(p.words).padStart(6)}w  H1x${p.h1s.length}  ${p.title.slice(0, 70)}`);
    const titles = new Map<string, string[]>(); for (const p of pages) if (p.title) (titles.get(p.title) ?? titles.set(p.title, []).get(p.title)!).push(p.url);
    const dupTitles = [...titles.entries()].filter(([, u]) => u.length > 1);
    const descs = new Map<string, string[]>(); for (const p of pages) if (p.desc) (descs.get(p.desc) ?? descs.set(p.desc, []).get(p.desc)!).push(p.url);
    const dupDescs = [...descs.entries()].filter(([, u]) => u.length > 1);
    console.log(`\n  Audit claims vs. what is served today:`);
    console.log(`    duplicate titles: ${dupTitles.length} groups (audit said 5)${dupTitles.length ? " → " + dupTitles.map(([t, u]) => `"${t.slice(0, 40)}" x${u.length}`).join("; ") : ""}`);
    console.log(`    duplicate descriptions: ${dupDescs.length} groups (audit said 7)`);
    console.log(`    pages with 0 or 2+ H1s: ${pages.filter((p) => p.h1s.length !== 1).length} (audit said 2 with multiple H1s)`);
    console.log(`    titles > 60 chars: ${pages.filter((p) => p.title.length > 60).length} (audit said 8 overly long)`);
    console.log(`    pages with a canonical tag: ${pages.filter((p) => p.canonical).length} of ${pages.length}`);
    console.log(`    thin pages (< 300 words of visible text): ${pages.filter((p) => p.status === 200 && p.words < 300).length}`);
    const vertical = pages.filter((p) => /dental|veterinar|vet\b|hvac|residential|oral|dermat|surgery|infusion|lab|cro|home-service|industr|sector/i.test(p.url + " " + p.title));
    console.log(`\n  Pages that read as vertical/industry pages today (${vertical.length}):`);
    for (const p of vertical) console.log(`    ${p.url.replace(/^https?:\/\/(www\.)?/, "")}  — ${p.h1s[0] ?? "(no H1)"}`);
    const valuation = pages.filter((p) => /valuation|worth|contact|inquiry|get-started|consult/i.test(p.url + " " + p.title + " " + p.h1s.join(" ")));
    console.log(`  Conversion / valuation pages found (${valuation.length}): ${valuation.map((p) => p.url.replace(/^https?:\/\/(www\.)?/, "")).join(", ") || "none by URL/title"}`);
    const wins = pages.filter((p) => /win|transaction|deal|closed|case/i.test(p.url));
    console.log(`  Client-win / transaction pages (${wins.length}), median words ${wins.length ? [...wins.map((p) => p.words)].sort((a, b) => a - b)[Math.floor(wins.length / 2)] : 0}`);
    const llms = await fetchText(`https://www.${DOMAIN}/llms.txt`);
    console.log(`  llms.txt ${llms.status}: ${llms.text.replace(/\s+/g, " ").slice(0, 160)}`);
  } catch (e) { console.log(`  [UNAVAILABLE] ${e instanceof Error ? e.message : String(e)}`); }

  console.log(`\nDONE — read only. No writes anywhere.\n`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

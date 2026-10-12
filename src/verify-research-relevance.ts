#!/usr/bin/env tsx
/**
 * Guard for a keyword research run: which ideas are kept, and where it searches.
 *
 * No database, no research provider, no network. The provider is a fake `fetch`
 * that answers each endpoint from a fixture, so the real `keywordDiscovery` is
 * driven end to end and the requests it makes are inspected.
 *
 * EVERY CLIENT, SEED, IDEA, VOLUME AND COST BELOW IS INVENTED. The SHAPE of the
 * bad run is what the owner read off one live screen: ten service seeds on a
 * Cincinnati addiction-treatment provider returned two hundred ideas that were
 * mostly hospital systems, insurers and unrelated conditions at national
 * volumes. Nothing here was measured and no figure may be quoted as a fact
 * about any client. No provider was called.
 *
 * The refusals are the deliverable, and each has a planted failure beside it
 * in the delivery report so the check is shown to bite rather than asserted to.
 *
 *   npx tsx src/verify-research-relevance.ts
 */
import { judgeIdeas, buildAnchors, foldWord, ideaKey, ideaUseLine } from "./ads/idea-relevance.js";
import {
  parsePlace, providerLocationName, placeKey, sameMarket, resolveResearchLocation,
  researchLocationOptions, splitRunsByMarket, searchedInLine, NO_LOCATION_MESSAGE, UNITED_STATES,
} from "./research-location.js";
import { resolveProviderPlace } from "./research-provider-location.js";
import { keywordDiscovery, locationNamesFrom } from "./dataforseo.js";
import { keywordGaps, type ResearchFacts } from "./ads/keyword-gap.js";
import * as fs from "node:fs";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);

// ── The OCH-shaped run. Invented. ───────────────────────────────────────────
const SEEDS = [
  "drug rehab", "alcohol rehab", "iop", "suboxone treatment", "detox center",
  "sober living", "dual diagnosis treatment", "mental health treatment",
  "partial hospitalization program", "medication assisted treatment",
];
const SERVICES = ["Medicaid alcohol rehab", "Intensive outpatient program", "Suboxone treatment"];

/** Ideas a semantic expansion returns around those seeds. The first block is
 *  what the owner saw; the second is real; volumes are national. */
const JUNK: Array<[string, number]> = [
  ["sutter health", 450_000], ["united health care", 1_220_000], ["overactive bladder treatment", 74_000],
  ["medicaid", 823_000], ["medicaid health insurance", 60_500], ["kaiser permanente", 1_000_000],
  ["urgent care near me", 550_000], ["health insurance", 301_000], ["blue cross", 673_000],
  ["anxiety symptoms", 201_000], ["depression test", 90_500], ["adhd in adults", 110_000],
  ["mental health", 368_000], ["therapy near me", 301_000], ["rehab", 135_000], ["treatment", 201_000],
];
const REAL: Array<[string, number]> = [
  ["drug rehab near me", 14_800], ["alcohol rehabs", 12_100], ["iop near me", 5_400],
  ["medicaid drug rehab", 880], ["suboxone treatment near me", 2_900], ["best detox centers", 1_600],
  ["sober living homes", 6_600], ["dual diagnosis treatment centers", 1_300],
  ["mental health treatment programs", 2_400], ["partial hospitalization program near me", 1_900],
  ["medication assisted treatment clinics", 1_000], ["medicaid alcohol rehab", 590],
];

function labsItems(list: Array<[string, number]>) {
  return list.map(([keyword, v]) => ({
    keyword_info: { search_volume: v, cpc: 4.2, competition: 0.5 },
    keyword_properties: { keyword_difficulty: 40 },
    search_intent_info: { main_intent: "commercial" },
    serp_info: { serp_item_types: [] },
    keyword,
  }));
}
function plannerItems(list: Array<[string, number]>) {
  return list.map(([keyword, v]) => ({ keyword, search_volume: v, cpc: 5.1, competition_index: 55 }));
}

// ── The fake provider. It records every request. ───────────────────────────
interface Req { path: string; body: any }
function installFetch(opts: { localVolumes?: "ok" | "fail"; ranked?: Record<string, Array<[string, number, number]>> } = {}) {
  const calls: Req[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const path = String(url).replace("https://api.dataforseo.com/v3", "");
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    const task = (result: unknown, cost = 0.01) => ({ ok: true, json: async () => ({ tasks: [{ status_code: 20000, cost, result }] }) });
    const fail = () => ({ ok: true, json: async () => ({ tasks: [{ status_code: 40501, status_message: "Invalid Field: location_name." }] }) });
    if (path === "/dataforseo_labs/google/keyword_ideas/live") {
      // Labs answers country-level only.
      if (body?.[0]?.location_name !== UNITED_STATES) return fail();
      return task([{ items: labsItems([...JUNK, ...REAL]) }]);
    }
    if (path === "/keywords_data/google_ads/keywords_for_keywords/live") {
      return task(plannerItems([...JUNK, ...REAL]), 0.075);
    }
    if (path === "/keywords_data/google_ads/search_volume/live") {
      if (opts.localVolumes === "fail") return fail();
      return task((body?.[0]?.keywords ?? []).map((k: string) => ({ keyword: k, search_volume: 70, cpc: 6 })), 0.05);
    }
    if (path === "/dataforseo_labs/google/bulk_keyword_difficulty/live") {
      return task([{ items: (body?.[0]?.keywords ?? []).map((k: string) => ({ keyword: k, keyword_difficulty: 33 })) }], 0.02);
    }
    if (path === "/dataforseo_labs/google/ranked_keywords/live") {
      const items = (opts.ranked?.[body?.[0]?.target] ?? []).map(([keyword, v, rank]) => ({
        keyword_data: { keyword, keyword_info: { search_volume: v, cpc: 3 }, keyword_properties: { keyword_difficulty: 20 } },
        ranked_serp_element: { serp_item: { rank_absolute: rank } },
      }));
      return task([{ items }], 0.03);
    }
    return fail();
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const creds = { login: "fixture", password: "fixture" };

console.log("Keyword research relevance and location — verification harness");
console.log("Nothing is fetched. The provider is a fixture. Every figure below is invented.");

// ── 1. THE RULE ─────────────────────────────────────────────────────────────
hr("1. An idea is kept only if it contains a seed or a signed-off service");
{
  const ideas = [...JUNK, ...REAL].map(([k]) => k);
  const j = judgeIdeas(ideas, { seeds: SEEDS, services: SERVICES });
  const kept = new Set(j.verdicts.filter((v) => v.kept).map((v) => v.keyword));
  for (const [junk] of JUNK) ok(`"${junk}" is set aside`, !kept.has(junk));
  for (const [real] of REAL) ok(`"${real}" is kept`, kept.has(real));
  ok("the counts add up to the ideas read", j.counts.kept + j.counts.setAside === j.counts.total && j.counts.total === ideas.length);
  ok("every set-aside idea is counted under a reason", j.counts.noAnchor === j.counts.setAside);
  ok("the line says how many were kept and how many set aside",
    /\d+ ideas read: 12 kept, 16 set aside/.test(j.line), j.line);
  ok("the basis line adds nothing when seeds and services both judged and every phrase was usable", j.basis === "seeds_and_services" && j.basisLine === null, String(j.basisLine));
}

hr("2. The refusals");
{
  // A word of a two-word anchor is not enough.
  const a = judgeIdeas(["sutter health", "mental health"], { seeds: ["mental health treatment"], services: null });
  ok('"sutter health" shares "health" with a seed and is set aside', !a.verdicts[0]!.kept);
  ok('a seed\'s head noun alone is not enough ("treatment")', !judgeIdeas(["overactive bladder treatment"], { seeds: ["mental health treatment"], services: null }).verdicts[0]!.kept);
  // A lone generic word is not an anchor when it was reduced to one.
  const ac = buildAnchors({ seeds: ["AC repair"], services: null });
  ok('"AC repair" reduces to one common word and is not used', ac.anchors.length === 0 && ac.unusable[0]?.fault === "reduced_to_one_word");
  ok("…so it keeps nothing", judgeIdeas(["roof repair", "ac repair near me"], { seeds: ["AC repair"], services: ["Drug rehab"] }).verdicts.every((v) => v.via?.phrase !== "AC repair"));
  // A one-word seed typed as one word stands.
  ok('a seed typed as one word ("iop") stands', judgeIdeas(["iop near me"], { seeds: ["iop"], services: null }).verdicts[0]!.kept);
  ok("…and does not keep an idea without it", !judgeIdeas(["sutter health"], { seeds: ["iop"], services: null }).verdicts[0]!.kept);
  // Folding.
  ok("a plural is folded: seeds \"alcohol rehab\" keeps \"alcohol rehabs\"", judgeIdeas(["alcohol rehabs"], { seeds: ["alcohol rehab"], services: null }).verdicts[0]!.kept);
  ok("case and punctuation do not matter", judgeIdeas(["Drug-Rehab, NEAR me!"], { seeds: ["drug rehab"], services: null }).verdicts[0]!.kept);
  ok("any order: \"rehab for drug\"", judgeIdeas(["rehab for drug addiction"], { seeds: ["drug rehab"], services: null }).verdicts[0]!.kept);
  ok("no other stemming: \"rehabilitation\" is not \"rehab\"", !judgeIdeas(["drug rehabilitation"], { seeds: ["drug rehab"], services: null }).verdicts[0]!.kept);
  ok("foldWord leaves short and \"ss\" words alone", foldWord("bus") === "bus" && foldWord("class") === "class" && foldWord("diagnosis") === "diagnosis" && foldWord("therapies") === "therapy");
  // Medicaid-type words get no special treatment.
  ok('"medicaid" alone is set aside, "medicaid drug rehab" is kept', !judgeIdeas(["medicaid"], { seeds: ["drug rehab"], services: null }).verdicts[0]!.kept && judgeIdeas(["medicaid drug rehab"], { seeds: ["drug rehab"], services: null }).verdicts[0]!.kept);
  // A null is unanswered.
  const noServices = judgeIdeas(["drug rehab near me", "sutter health"], { seeds: ["drug rehab"], services: null });
  ok("with no signed-off services the seeds alone are used, and the line says so", noServices.basis === "seeds_only" && /No services list is signed off, so the seeds were the only test/.test(noServices.basisLine ?? "") && noServices.counts.kept === 1);
  const nothing = judgeIdeas(["sutter health", "drug rehab near me"], { seeds: [], services: null });
  ok("with neither, nothing is dropped and nothing is called checked", nothing.basis === "nothing_to_judge_by" && nothing.counts.kept === 2 && nothing.counts.keptUnchecked === 2 && /none checked/.test(nothing.line), nothing.line);
  ok("an empty services list is not read as no seeds either", judgeIdeas(["drug rehab"], { seeds: ["drug rehab"], services: [] }).counts.kept === 1);
  // A tracked search is exact only.
  ok("a tracked search keeps exactly that phrase", judgeIdeas(["cincinnati iop"], { seeds: ["detox"], services: null, tracked: ["cincinnati iop"] }).verdicts[0]!.kept);
  ok("…and not a longer one containing it", !judgeIdeas(["cincinnati iop reviews"], { seeds: ["detox"], services: null, tracked: ["cincinnati iop"] }).verdicts[0]!.kept);
  // A person beats the rule in both directions.
  const key = ideaKey("sutter health");
  const kept = judgeIdeas(["sutter health"], { seeds: SEEDS, services: null, reviews: { [key]: { decision: "keep", by: "A" } } });
  ok("a person's keep brings an idea back", kept.verdicts[0]!.kept && kept.counts.keptByPerson === 1);
  const gone = judgeIdeas(["drug rehab near me"], { seeds: SEEDS, services: null, reviews: { [ideaKey("drug rehab near me")]: { decision: "set_aside" } } });
  ok("a person's set-aside takes one out", !gone.verdicts[0]!.kept && gone.counts.byPerson === 1);
  ok("a blank idea is set aside and counted", judgeIdeas(["  "], { seeds: SEEDS, services: null }).counts.blank === 1);
  ok("the use line says how many were used", /Used 12 of 28 stored ideas/.test(ideaUseLine(28, 12) ?? ""));
}

// ── 3. THE PLACE ────────────────────────────────────────────────────────────
hr("3. Where a run searches");
{
  ok('"Cincinnati, OH" is spelled the way the provider spells it', providerLocationName("Cincinnati, OH") === "Cincinnati,Ohio,United States");
  ok("the provider's own form reads back the same", providerLocationName("Cincinnati,Ohio,United States") === "Cincinnati,Ohio,United States");
  ok('"cincinnati, ohio" is tidied', providerLocationName("cincinnati, ohio") === "Cincinnati,Ohio,United States");
  ok('one word ("Cincinnati") is refused, not guessed', providerLocationName("Cincinnati") === null && parsePlace("Cincinnati")?.kind === "ambiguous");
  ok("a state and the country are readable", providerLocationName("Ohio") === "Ohio,United States" && providerLocationName("USA") === UNITED_STATES);
  ok("a blank is nothing, not the country", providerLocationName("") === null && providerLocationName(null) === null);
  ok("two spellings of one city are one market", sameMarket("Cincinnati, OH", "Cincinnati,Ohio,United States"));
  ok("two places are two markets", !sameMarket("Cincinnati, OH", "United States"));
  ok("an unanswered place is the same as nothing", !sameMarket(null, null));

  const none = resolveResearchLocation({});
  ok("nothing recorded and nothing chosen is refused with a sentence", !none.ok && none.message === NO_LOCATION_MESSAGE);
  const rec = resolveResearchLocation({ seoLocation: "Cincinnati, OH" });
  ok("the client's own recorded place is the default", rec.ok && rec.location === "Cincinnati,Ohio,United States" && rec.source === "client_setting");
  const targets = resolveResearchLocation({ targetLocations: ["Cincinnati, OH", "Cincinnati, OH", "Dayton, OH"] });
  ok("else the place its local tracked searches are pinned to, most used first", targets.ok && targets.location === "Cincinnati,Ohio,United States" && targets.source === "tracked_searches");
  const billing = resolveResearchLocation({ billing: { city: "Cincinnati", state: "OH" } });
  ok("a billing address is never the default", !billing.ok);
  ok("…but it is offered", researchLocationOptions({ billing: { city: "Cincinnati", state: "OH" } }).some((o) => o.source === "billing" && !o.isDefault));
  const chosen = resolveResearchLocation({ override: "United States", seoLocation: "Cincinnati, OH" });
  ok("a person's choice beats the record, and the whole country is allowed when chosen", chosen.ok && chosen.national && chosen.source === "chosen");
  ok("a chosen one-word place is refused", !resolveResearchLocation({ override: "Cincinnati" }).ok);
  ok("the line says where it searched", searchedInLine("Cincinnati,Ohio,United States") === "Searched in Cincinnati, OH.");
  const runs = splitRunsByMarket([{ id: "new", location: "Cincinnati,Ohio,United States" }, { id: "old", location: "United States" }, { id: "blank", location: null }]);
  ok("runs from another place are left out, and a run with no place too", runs.used.join() === "new" && runs.leftOut.join() === "old,blank");

  // The provider's list.
  const list = ["United States", "Ohio,United States", "Cincinnati,Ohio,United States"];
  const good = resolveProviderPlace("Cincinnati, OH", list);
  ok("a place the provider holds is verified", good.ok && good.verified && good.name === "Cincinnati,Ohio,United States");
  const missing = resolveProviderPlace("Springfield, OH", list);
  ok("a place the provider's list does not hold stops the run before anything is paid for", !missing.ok && /no place called "Springfield,Ohio,United States"/.test((missing as any).message));
  const unread = resolveProviderPlace("Cincinnati, OH", null);
  ok("a list that could not be read is unverified, not a refusal", unread.ok && !unread.verified && /could not be read/.test((unread as any).note));
  ok("the whole country needs no list", resolveProviderPlace("United States", null).ok);
  ok("a blank is refused", !resolveProviderPlace("", list).ok && !resolveProviderPlace(null, list).ok);
  ok("an ambiguous one-word place is refused", !resolveProviderPlace("Cincinnati", list).ok);
  ok("the provider's locations answer is read, and an error answer is not", locationNamesFrom({ tasks: [{ status_code: 20000, result: [{ location_name: "Ohio,United States" }] }] })?.[0] === "Ohio,United States" && locationNamesFrom({ tasks: [{ status_code: 40501, result: [] }] }) === null);
}

// ── 4. THE RUN, END TO END ──────────────────────────────────────────────────
hr("4. A whole-country run keeps its original calls and flags every idea");
{
  const f = installFetch();
  try {
    const out = await keywordDiscovery(creds, { seeds: SEEDS, competitor: null, limit: 200 }, null, UNITED_STATES, "English",
      { services: SERVICES, tracked: [] });
    ok("it used the Labs ideas call, in the country", f.calls[0]?.path === "/dataforseo_labs/google/keyword_ideas/live" && f.calls[0]?.body[0].location_name === UNITED_STATES);
    ok("every idea is stored, none deleted", out.rows.length === JUNK.length + REAL.length);
    ok("each junk idea is flagged, not removed", JUNK.every(([k]) => out.rows.find((r) => r.keyword === k)?.relevance.kept === false));
    ok("each real idea is flagged kept with the term it contains", REAL.every(([k]) => { const r = out.rows.find((x) => x.keyword === k); return r?.relevance.kept === true && !!r.relevance.via; }));
    ok("every row says the place its volume was measured in", out.rows.every((r) => r.measuredIn === UNITED_STATES));
    ok("the run reports its counts", out.judgement.counts.kept === REAL.length && out.judgement.counts.setAside === JUNK.length, out.judgement.line);
  } finally { f.restore(); }
}

hr("5. A run in Cincinnati asks for local volumes, and buys difficulty for the kept ideas only");
{
  const f = installFetch({ ranked: {
    "client.example": [["drug rehab near me", 14_800, 14]],
    "rival.example": [["opioid treatment cincinnati", 900, 6], ["hospital billing office", 120_000, 3]],
  } });
  try {
    const out = await keywordDiscovery(creds, { seeds: SEEDS, competitor: "rival.example", limit: 200 }, "client.example", "Cincinnati,Ohio,United States", "English",
      { services: SERVICES, tracked: ["opioid treatment cincinnati"] });
    const paths = f.calls.map((c) => c.path);
    ok("the ideas came from the Keywords Data call, with the city", f.calls[0]?.path === "/keywords_data/google_ads/keywords_for_keywords/live" && f.calls[0]?.body[0].location_name === "Cincinnati,Ohio,United States");
    ok("the Labs ideas call, which is country-level, was never made", !paths.includes("/dataforseo_labs/google/keyword_ideas/live"));
    ok("the ranking calls stayed at country level, and the run says positions are national",
      f.calls.filter((c) => c.path.endsWith("ranked_keywords/live")).every((c) => c.body[0].location_name === UNITED_STATES) && out.warnings.some((w) => /positions are the national ones/.test(w)));
    const kd = f.calls.find((c) => c.path === "/dataforseo_labs/google/bulk_keyword_difficulty/live");
    const kdKeywords: string[] = kd?.body[0].keywords ?? [];
    ok("difficulty was bought for KEPT ideas only", kdKeywords.length > 0 && kdKeywords.every((k) => out.rows.find((r) => r.keyword === k)?.relevance.kept === true), `${kdKeywords.length} asked`);
    ok("…and not one set-aside idea was priced for it", !kdKeywords.includes("sutter health") && !kdKeywords.includes("united health care"));
    ok("every volume left in the run is for Cincinnati", out.rows.every((r) => r.volume == null || r.measuredIn === "Cincinnati,Ohio,United States"));
    ok("the competitor-only idea was re-measured in the city", f.calls.some((c) => c.path === "/keywords_data/google_ads/search_volume/live"));
    const gapJunk = out.rows.find((r) => r.keyword === "hospital billing office");
    ok("a set-aside competitor idea carries no national volume into a local run", !!gapJunk && gapJunk.volume == null && gapJunk.relevance.kept === false);
    const tracked = out.rows.find((r) => r.keyword === "opioid treatment cincinnati");
    ok("a competitor idea that is on the tracking list is kept, and re-measured in the city", !!tracked && tracked.relevance.kept && tracked.relevance.source === "tracked" && tracked.volume === 70 && tracked.measuredIn === "Cincinnati,Ohio,United States");
    ok("the source and place are on the result", out.source === "google_ads_local" && out.place === "Cincinnati,Ohio,United States");
    ok("the cost is the sum of what the tasks said", out.costUsd > 0.075);
  } finally { f.restore(); }
}

hr("6. A place run never carries a volume from somewhere else");
{
  const f = installFetch({ localVolumes: "fail", ranked: { "rival.example": [["opioid treatment cincinnati", 900, 6]] } });
  try {
    const out = await keywordDiscovery(creds, { seeds: SEEDS, competitor: "rival.example", limit: 200 }, "client.example", "Cincinnati,Ohio,United States", "English",
      { services: SERVICES, tracked: ["opioid treatment cincinnati"] });
    const gap = out.rows.find((r) => r.keyword === "opioid treatment cincinnati");
    ok("a gap idea whose local volume could not be read has NO volume, not the national one", !!gap && gap.volume == null && gap.measuredIn == null);
    ok("…and the run says so", out.warnings.some((w) => /volumes for/.test(w)));
    ok("every row that has a volume names the city", out.rows.every((r) => r.volume == null || r.measuredIn === "Cincinnati,Ohio,United States"));
  } finally { f.restore(); }
}

// ── 7. THE GROWTH READING ───────────────────────────────────────────────────
hr("7. The growth reading counts the ideas it used and never prices a set-aside one");
{
  const keywords = [...JUNK, ...REAL].map(([keyword, volume]) => ({
    keyword, volume: volume as number | null, cpcDollars: 5 as number | null, difficulty: 30 as number | null,
    intent: "commercial" as string | null, clientRank: null as number | null, competitorRank: null as number | null,
  }));
  const research: ResearchFacts = { keywords, ranAt: "2026-10-12", location: UNITED_STATES, seeds: SEEDS };
  const confirmed = {
    services: [{ name: "Drug rehab", note: null }, { name: "Intensive outpatient program", note: null }, { name: "Sober living", note: null }],
    confirmedBy: "Ana", confirmedAt: "2026-10-01", candidatesWaiting: 0,
  };
  const reading = keywordGaps({
    research, services: confirmed,
    existingKeywords: [], seenTerms: [], existingNegatives: new Set<string>(),
    provenQueries: [], protectedPatterns: [], accountTermCoverage: 0.8,
    targets: [],
  } as any);
  const priced = reading.services.flatMap((s) => s.terms.map((t) => t.keyword));
  ok("no junk idea reaches a row", JUNK.every(([k]) => !priced.includes(k)), priced.join(", "));
  ok("real ideas do", priced.includes("drug rehab near me") && priced.includes("sober living homes"));
  ok("the reading says how many ideas it read and used", reading.ideasRead === JUNK.length + REAL.length && reading.ideasUsed === REAL.length);
  ok("…and the row carries the sentence", reading.services.some((s) => s.lines.some((l) => /Used 12 of 28 stored ideas/.test(l))));
  ok("a national run says its volumes are national", reading.services.some((s) => s.lines.some((l) => /whole country/.test(l))));
  const kept = keywordGaps({
    research: { ...research, reviews: { [ideaKey("sutter health")]: { decision: "keep", by: "Ana" } } },
    services: confirmed, existingKeywords: [], seenTerms: [], existingNegatives: new Set<string>(),
    provenQueries: [], protectedPatterns: [], accountTermCoverage: 0.8, targets: [],
  } as any);
  ok("a person's keep lets one idea through the gate, and the services still decide the rest", kept.ideasUsed === REAL.length + 1);
  // The other direction: a person set aside an idea that DOES match a service.
  // The service rule alone would offer it; only the gate holds it back.
  const aside = keywordGaps({
    research: { ...research, reviews: { [ideaKey("drug rehab near me")]: { decision: "set_aside", by: "Ana" } } },
    services: confirmed, existingKeywords: [], seenTerms: [], existingNegatives: new Set<string>(),
    provenQueries: [], protectedPatterns: [], accountTermCoverage: 0.8, targets: [],
  } as any);
  const pricedAside = aside.services.flatMap((s) => s.terms.map((t) => t.keyword));
  ok("an idea a person set aside is not offered, though it matches a service", !pricedAside.includes("drug rehab near me") && pricedAside.includes("sober living homes") && aside.ideasUsed === REAL.length - 1, pricedAside.join(", "));
}

// ── 8. WHAT THE CODE DOES, READ OUT OF THE SOURCE ───────────────────────────
hr("8. The run refuses to start without a place, and checks it before paying");
{
  const run = fs.readFileSync(new URL("./run-research.ts", import.meta.url), "utf8");
  const resolveAt = run.indexOf("resolveProviderPlace(");
  const discoveryAt = run.indexOf("await keywordDiscovery(");
  ok("run-research resolves the place before it calls the provider", resolveAt > 0 && discoveryAt > resolveAt);
  ok("a place that cannot be resolved throws before any task", /if \(!place\.ok\) throw new Error\(place\.message\)/.test(run));
  ok("the gate gets the signed-off services and tracked searches", /clientServicesFor\(c, clientId\)/.test(run) && /seoTargetsFor\(c, clientId\)/.test(run));
  const dfs = fs.readFileSync(new URL("./dataforseo.ts", import.meta.url), "utf8");
  ok("keywordDiscovery judges every idea and deletes none", /judgeIdeas\(all\.map/.test(dfs) && !/rows\.delete\(/.test(dfs.slice(dfs.indexOf("export async function keywordDiscovery"))));
  ok("local difficulty is asked for the kept ideas only", /const needKd = all\.filter\(\(r\) => kept\(r\)/.test(dfs));
}

console.log(`\n${failures === 0 ? "✅ research relevance guard: all checks passed" : `❌ ${failures} check(s) FAILED`}`);
console.log("Every figure above is an invented fixture. No research provider was called.");
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * One-off, guarded import of OHC's SEO keyword-research set + AEO prompts —
 * the CSV/txt Sebastien provided (83 keywords across 9 research "layers",
 * 12 AEO questions). Matches the client by exact name, refuses on ambiguity.
 * Idempotent: skips a keyword row that already exists for this client on the
 * same (keyword, scope, device); skips an AEO prompt that already exists
 * verbatim. Safe to re-run.
 *
 *   npm run import-och-seo-set -- --dry-run
 *   npm run import-och-seo-set
 */
const CLIENT_NAME = "Ohio Community Health (OCH)";

const CSV = `priority,keyword,layer,report_status,scope,location_name,device,volume,kd,cpc,why\n1,m367,1 · Reference footprint (defend),core - report weekly,national,,desktop,22200,30,4.34,Carries 78% of site traffic today. Track to defend and to prove the bridge layer is converting it — not to grow.\n2,m367 pill,1 · Reference footprint (defend),core - report weekly,national,,desktop,9900,25,4.37,Carries 78% of site traffic today. Track to defend and to prove the bridge layer is converting it — not to grow.\n3,xanax generic name,1 · Reference footprint (defend),core - report weekly,national,,desktop,8100,77,4.4,Carries 78% of site traffic today. Track to defend and to prove the bridge layer is converting it — not to grow.\n4,barbiturate overdose,1 · Reference footprint (defend),core - report weekly,national,,desktop,49500,50,,Carries 78% of site traffic today. Track to defend and to prove the bridge layer is converting it — not to grow.\n5,meloxicam and alcohol,1 · Reference footprint (defend),core - report weekly,national,,desktop,3600,20,,Carries 78% of site traffic today. Track to defend and to prove the bridge layer is converting it — not to grow.\n6,sublocade,2 · MAT medication (commercial engine),core - report weekly,national,,desktop,33100,32,8.68,Best volume-to-difficulty available. BrightView #12.\n7,brixadi,2 · MAT medication (commercial engine),core - report weekly,national,,desktop,22200,32,18.1,Highest CPC in the category. BrightView #13.\n8,sublocade shot,2 · MAT medication (commercial engine),core - report weekly,national,,desktop,8100,27,7.58,Lowest KD in the category.\n9,vivitrol,2 · MAT medication (commercial engine),core - report weekly,national,,desktop,33100,69,9.27,Harder. Ties to the Vivitrol provider locator listing.\n10,vivitrol shot,2 · MAT medication (commercial engine),core - report weekly,national,,desktop,8100,61,9.25,OHC delivers MAT and ranks for none of these. Admission-adjacent intent at scale.\n11,antabuse,2 · MAT medication (commercial engine),core - report weekly,national,,desktop,14800,49,3.47,Alcohol-specific MAT.\n12,campral,2 · MAT medication (commercial engine),core - report weekly,national,,desktop,6600,36,3.64,Alcohol-specific MAT.\n13,naltrexone for alcohol,2 · MAT medication (commercial engine),core - report weekly,national,,desktop,9900,49,3.47,Bridges MAT and the alcohol line.\n14,vivitrol for alcohol,2 · MAT medication (commercial engine),core - report weekly,national,,desktop,1300,31,,KD 31. Easiest entry into the alcohol-MAT intersection.\n15,naltrexone,2 · MAT medication (commercial engine),core - report weekly,national,,desktop,246000,77,3.33,Long-horizon marker only.\n16,how long does suboxone stay in your system,3 · MAT questions (AEO),core - report weekly,national,,desktop,8100,16,4.26,"8,100 at KD 16. Best single opportunity on the site."\n17,is suboxone addictive,3 · MAT questions (AEO),core - report weekly,national,,desktop,1900,17,6.29,The objection every patient raises.\n18,how does suboxone work,3 · MAT questions (AEO),core - report weekly,national,,desktop,1300,13,2.81,Lowest KD in the set.\n19,does suboxone help with pain,3 · MAT questions (AEO),core - report weekly,national,,desktop,2400,23,7.67,"High CPC, low difficulty."\n20,does suboxone show up on a drug test,3 · MAT questions (AEO),core - report weekly,national,,desktop,1600,20,8.52,"Cluster totals ~7,000/mo across phrasings."\n21,can you overdose on suboxone,3 · MAT questions (AEO),core - report weekly,national,,desktop,1300,22,4.77,"AEO question. OHC holds 5 AI Overview citations of 2,573 eligible."\n22,does suboxone get you high,3 · MAT questions (AEO),core - report weekly,national,,desktop,1000,14,2.88,"AEO question. OHC holds 5 AI Overview citations of 2,573 eligible."\n23,how long does suboxone stay in urine,3 · MAT questions (AEO),core - report weekly,national,,desktop,1000,14,6.47,"AEO question. OHC holds 5 AI Overview citations of 2,573 eligible."\n24,precipitated withdrawal,3 · MAT questions (AEO),core - report weekly,national,,desktop,2900,39,3.68,The thing patients fear most about starting Suboxone. Directly tied to induction.\n25,what is suboxone,3 · MAT questions (AEO),core - report weekly,national,,desktop,12100,55,5.75,Anchor term. Build after the easy wins.\n26,what is suboxone used for,3 · MAT questions (AEO),core - report weekly,national,,desktop,5400,51,4.97,"AEO question. OHC holds 5 AI Overview citations of 2,573 eligible."\n27,what is mat treatment,3 · MAT questions (AEO),core - report weekly,national,,desktop,720,41,6.07,"AEO question. OHC holds 5 AI Overview citations of 2,573 eligible."\n28,what is iop,4 · Service & decision,core - report weekly,national,,desktop,4400,25,3.18,Supports the IOP service page.\n29,outpatient rehab,4 · Service & decision,core - report weekly,national,,desktop,9900,54,16.37,$16.37 CPC. Core service term.\n30,how much does rehab cost,4 · Service & decision,core - report weekly,national,,desktop,1600,27,5.3,Service or decision-stage term.\n31,how long is rehab,4 · Service & decision,core - report weekly,national,,desktop,1300,16,5.22,"Low KD, common pre-admission question."\n32,does insurance cover rehab,4 · Service & decision,core - report weekly,national,,desktop,1000,33,14.69,$14.69 CPC.\n33,does medicaid cover rehab,4 · Service & decision,core - report weekly,national,,desktop,590,24,4.51,OHC's clearest differentiator.\n34,what is php treatment,4 · Service & decision,core - report weekly,national,,desktop,590,21,2.46,"CORRECTION: 590/mo, not 5,400."\n35,signs of addiction,4 · Service & decision,core - report weekly,national,,desktop,3600,46,2.54,Builds remarketing audiences.\n36,dual diagnosis,4 · Service & decision,core - report weekly,national,,desktop,5400,60,8.23,Long-horizon authority page.\n37,how to help someone with addiction,4 · Service & decision,core - report weekly,national,,desktop,480,52,2.47,Family audience — families often make the call.\n38,signs of alcoholism,5 · Alcohol (underbuilt half),core - report weekly,national,,desktop,5400,45,,OHC's footprint is opioid-heavy. Alcohol is half the business and almost none of the content.\n39,how to stop drinking,5 · Alcohol (underbuilt half),core - report weekly,national,,desktop,4400,46,3.29,OHC's footprint is opioid-heavy. Alcohol is half the business and almost none of the content.\n40,alcohol withdrawal timeline,5 · Alcohol (underbuilt half),core - report weekly,national,,desktop,8100,59,1.64,Also pre-positions the 2027 detox line.\n41,how long does alcohol withdrawal last,5 · Alcohol (underbuilt half),core - report weekly,national,,desktop,6600,58,1.47,OHC's footprint is opioid-heavy. Alcohol is half the business and almost none of the content.\n42,drinking problem,5 · Alcohol (underbuilt half),core - report weekly,national,,desktop,3600,53,6.63,OHC's footprint is opioid-heavy. Alcohol is half the business and almost none of the content.\n43,outpatient alcohol treatment,5 · Alcohol (underbuilt half),core - report weekly,national,,desktop,2400,50,,Describes exactly what OHC delivers.\n44,alcohol counseling near me,5 · Alcohol (underbuilt half),core - report weekly,national,,desktop,1600,46,13.12,"$13.12 CPC, KD 46."\n45,how to quit drinking alcohol,5 · Alcohol (underbuilt half),core - report weekly,national,,desktop,1300,43,,OHC's footprint is opioid-heavy. Alcohol is half the business and almost none of the content.\n46,suboxone clinic near me,6 · Local capture,core - report weekly,local,"Cincinnati, OH",mobile,9900,28,16.34,Volume shown is NATIONAL; resolves locally. Cincinnati captures roughly 2% of it. Mobile — these are phone searches.\n47,suboxone doctors near me,6 · Local capture,core - report weekly,local,"Cincinnati, OH",mobile,8100,26,18.73,Volume shown is NATIONAL; resolves locally. Cincinnati captures roughly 2% of it. Mobile — these are phone searches.\n48,alcohol rehab near me,6 · Local capture,core - report weekly,local,"Cincinnati, OH",mobile,12100,82,,Volume shown is NATIONAL; resolves locally. Cincinnati captures roughly 2% of it. Mobile — these are phone searches.\n49,drug rehab near me,6 · Local capture,core - report weekly,local,"Cincinnati, OH",mobile,14800,65,,Volume shown is NATIONAL; resolves locally. Cincinnati captures roughly 2% of it. Mobile — these are phone searches.\n50,iop near me,6 · Local capture,core - report weekly,local,"Cincinnati, OH",mobile,5400,39,19.28,Volume shown is NATIONAL; resolves locally. Cincinnati captures roughly 2% of it. Mobile — these are phone searches.\n51,php near me,6 · Local capture,core - report weekly,local,"Cincinnati, OH",mobile,1600,12,13.51,Volume shown is NATIONAL; resolves locally. Cincinnati captures roughly 2% of it. Mobile — these are phone searches.\n52,rehab cincinnati,6 · Local capture,core - report weekly,local,"Cincinnati, OH",desktop,320,30,23.18,"Cincinnati-explicit. Whole local market is ~1,500/mo — small but highest intent."\n53,addiction treatment cincinnati,6 · Local capture,core - report weekly,local,"Cincinnati, OH",desktop,210,39,15.16,"Cincinnati-explicit. Whole local market is ~1,500/mo — small but highest intent."\n54,alcohol rehab cincinnati,6 · Local capture,core - report weekly,local,"Cincinnati, OH",desktop,210,42,,"Cincinnati-explicit. Whole local market is ~1,500/mo — small but highest intent."\n55,drug rehab cincinnati,6 · Local capture,core - report weekly,local,"Cincinnati, OH",desktop,170,28,,"Cincinnati-explicit. Whole local market is ~1,500/mo — small but highest intent."\n56,methadone clinic cincinnati,6 · Local capture,core - report weekly,local,"Cincinnati, OH",desktop,110,7,5.15,"Cincinnati-explicit. Whole local market is ~1,500/mo — small but highest intent."\n57,intensive outpatient program cincinnati,6 · Local capture,core - report weekly,local,"Cincinnati, OH",desktop,110,15,,"Cincinnati-explicit. Whole local market is ~1,500/mo — small but highest intent."\n58,suboxone clinic cincinnati,6 · Local capture,core - report weekly,local,"Cincinnati, OH",desktop,90,26,,"Cincinnati-explicit. Whole local market is ~1,500/mo — small but highest intent."\n59,outpatient rehab cincinnati,6 · Local capture,core - report weekly,local,"Cincinnati, OH",desktop,40,21,,"Cincinnati-explicit. Whole local market is ~1,500/mo — small but highest intent."\n60,iop cincinnati,6 · Local capture,core - report weekly,local,"Cincinnati, OH",desktop,30,8,12.52,"Cincinnati-explicit. Whole local market is ~1,500/mo — small but highest intent."\n61,php cincinnati,6 · Local capture,core - report weekly,local,"Cincinnati, OH",desktop,30,0,5.77,"Cincinnati-explicit. Whole local market is ~1,500/mo — small but highest intent."\n62,detox near me,7 · Detox pre-position (Q1 2027),baseline - track do not report yet,national,,desktop,9900,57,34.3,$34.30 CPC. KD 57 — will not rank organically at AS 24.\n63,alcohol detox near me,7 · Detox pre-position (Q1 2027),baseline - track do not report yet,national,,desktop,6600,62,31.13,Detox licensure Q1 2027. Track now to hold a pre-launch baseline. Do NOT make service claims before licensure.\n64,detox center near me,7 · Detox pre-position (Q1 2027),baseline - track do not report yet,national,,desktop,6600,76,25.83,KD 76. Paid-only realistically.\n65,drug detox near me,7 · Detox pre-position (Q1 2027),baseline - track do not report yet,national,,desktop,3600,73,,Detox licensure Q1 2027. Track now to hold a pre-launch baseline. Do NOT make service claims before licensure.\n66,medical detox near me,7 · Detox pre-position (Q1 2027),baseline - track do not report yet,national,,desktop,1900,56,,Detox licensure Q1 2027. Track now to hold a pre-launch baseline. Do NOT make service claims before licensure.\n67,alcohol detox cincinnati,7 · Detox pre-position (Q1 2027),baseline - track do not report yet,local,"Cincinnati, OH",desktop,110,26,,KD 26 — the one detox term OHC can realistically win organically.\n68,detox cincinnati,7 · Detox pre-position (Q1 2027),baseline - track do not report yet,local,"Cincinnati, OH",desktop,20,0,25.04,"KD 0, $25.04 CPC."\n69,drug detox cincinnati,7 · Detox pre-position (Q1 2027),baseline - track do not report yet,local,"Cincinnati, OH",desktop,30,0,,KD 0.\n70,how to detox from alcohol,7 · Detox pre-position (Q1 2027),baseline - track do not report yet,national,,desktop,3600,55,4.62,"Education, not a service claim — safe to build pre-licensure."\n71,opioid withdrawal timeline,7 · Detox pre-position (Q1 2027),baseline - track do not report yet,national,,desktop,590,41,,KD 41. Buildable now.\n72,what is medical detox,7 · Detox pre-position (Q1 2027),baseline - track do not report yet,national,,desktop,260,53,4.53,"Education, buildable pre-licensure."\n73,drug rehab ohio,8 · Service area & expansion,baseline - track do not report yet,national,,desktop,480,58,,Baseline for the west-side and service-area expansion. Low volume — do not over-invest.\n74,drug rehab columbus ohio,8 · Service area & expansion,baseline - track do not report yet,national,,desktop,260,52,,"Service area, not a facility market."\n75,addiction treatment columbus ohio,8 · Service area & expansion,baseline - track do not report yet,national,,desktop,260,53,,Baseline for the west-side and service-area expansion. Low volume — do not over-invest.\n76,suboxone clinic ohio,8 · Service area & expansion,baseline - track do not report yet,national,,desktop,70,27,,KD 27 — winnable statewide term.\n77,drug rehab dayton,8 · Service area & expansion,baseline - track do not report yet,national,,desktop,50,24,,Whole Dayton market is ~100/mo. Service-area framing only.\n78,addiction treatment dayton,8 · Service area & expansion,baseline - track do not report yet,national,,desktop,30,0,13.51,Baseline for the west-side and service-area expansion. Low volume — do not over-invest.\n79,rehab mason ohio,8 · Service area & expansion,baseline - track do not report yet,national,,desktop,40,15,,Near-term expansion geography.\n80,sublocade,9 · Device check,core - report weekly,national,,mobile,,,,Mobile pair. Treatment search skews heavily mobile and local packs differ by device.\n81,how long does suboxone stay in your system,9 · Device check,core - report weekly,national,,mobile,,,,Mobile pair. Treatment search skews heavily mobile and local packs differ by device.\n82,rehab cincinnati,9 · Device check,core - report weekly,local,"Cincinnati, OH",mobile,,,,Mobile pair. Treatment search skews heavily mobile and local packs differ by device.\n83,what is iop,9 · Device check,core - report weekly,national,,mobile,,,,Mobile pair. Treatment search skews heavily mobile and local packs differ by device.`;

const AEO_PROMPTS = `what is sublocade and how does it work\nwhat is the difference between sublocade and suboxone\nhow long does suboxone stay in your system\nis suboxone addictive\nwhat is precipitated withdrawal and how do i avoid it\ndoes medicaid cover rehab in ohio\nwhat is an intensive outpatient program\nwhat does outpatient addiction treatment involve\ni found pills in my child's room what do i do\nhow do i know if i need rehab or just to cut back\nhow do i get someone into treatment in cincinnati\ncan i get vivitrol for alcohol and how does it work`
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

interface Row {
  keyword: string; scope: string; locationName: string | null; device: string;
  tag: string; reportStatus: string; notes: string | null;
}

function parseRows(): Row[] {
  const lines = CSV.split("\n").map((l) => l.trim()).filter(Boolean);
  const header = parseCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iKeyword = col("keyword"), iLayer = col("layer"), iStatus = col("report_status"),
    iScope = col("scope"), iLoc = col("location_name"), iDevice = col("device"),
    iVol = col("volume"), iKd = col("kd"), iCpc = col("cpc"), iWhy = col("why");
  const rows: Row[] = [];
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    const keyword = (c[iKeyword] ?? "").trim();
    if (!keyword) continue;
    const scope = (c[iScope] ?? "").trim().toLowerCase() === "local" ? "local" : "national";
    const location = (c[iLoc] ?? "").trim();
    const device = (c[iDevice] ?? "").trim().toLowerCase() === "mobile" ? "mobile" : "desktop";
    const tag = (c[iLayer] ?? "").trim();
    const reportStatus = (c[iStatus] ?? "").trim().toLowerCase().startsWith("baseline") ? "baseline" : "core";
    const vol = (c[iVol] ?? "").trim(), kd = (c[iKd] ?? "").trim(), cpc = (c[iCpc] ?? "").trim(), why = (c[iWhy] ?? "").trim();
    const metaBits = [vol && `${vol}/mo`, kd && `KD ${kd}`, cpc && `$${cpc} CPC`].filter(Boolean);
    const notes = [metaBits.join(" · "), why].filter(Boolean).join(" — ") || null;
    rows.push({ keyword, scope, locationName: scope === "local" ? location || null : null, device, tag, reportStatus, notes });
  }
  return rows;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v?.trim()) throw new Error(`Missing ${name}`);
  return v.trim();
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: matches } = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE lower(trim(name)) = lower(trim($1))`,
      [CLIENT_NAME],
    );
    if (matches.length === 0) {
      const { rows: fuzzy } = await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM clients WHERE name ILIKE $1`,
        [`%${CLIENT_NAME.replace(/[()]/g, "")}%`],
      );
      if (fuzzy.length !== 1) {
        console.error(`Could not uniquely match "${CLIENT_NAME}". Exact: 0, fuzzy: ${fuzzy.length} (${fuzzy.map((f) => f.name).join(", ")}). Refusing to guess.`);
        process.exit(1);
      }
      matches.push(fuzzy[0]!);
    }
    if (matches.length > 1) {
      console.error(`Ambiguous match for "${CLIENT_NAME}": ${matches.map((m) => m.name).join(", ")}. Refusing to guess.`);
      process.exit(1);
    }
    const client = matches[0]!;
    console.log(`Client: ${client.name} (${client.id})`);

    const targets = parseRows();
    const core = targets.filter((t) => t.reportStatus === "core").length;
    const baseline = targets.length - core;
    console.log(`Parsed ${targets.length} keyword targets (${core} core, ${baseline} baseline).`);
    console.log(`Parsed ${AEO_PROMPTS.length} AEO prompts.`);

    if (dryRun) {
      for (const t of targets.slice(0, 5)) console.log(`  · ${t.keyword} [${t.scope}/${t.device}] tag=${t.tag} status=${t.reportStatus}`);
      console.log("  … dry run, nothing written.");
      return;
    }

    const { rows: existingTargets } = await c.query<{ keyword: string; scope: string; device: string }>(
      `SELECT keyword, scope, device FROM seo_targets WHERE client_id = $1`, [client.id],
    );
    const existingKey = new Set(existingTargets.map((r) => `${r.keyword.toLowerCase()}|${r.scope}|${r.device}`));

    let insertedTargets = 0, skippedTargets = 0;
    for (const t of targets) {
      const key = `${t.keyword.toLowerCase()}|${t.scope}|${t.device}`;
      if (existingKey.has(key)) { skippedTargets++; continue; }
      await c.query(
        `INSERT INTO seo_targets (id, client_id, keyword, scope, location_name, device, tag, report_status, notes, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
        [randomUUID(), client.id, t.keyword, t.scope, t.locationName, t.device, t.tag, t.reportStatus, t.notes],
      );
      existingKey.add(key);
      insertedTargets++;
    }
    console.log(`Keyword targets: ${insertedTargets} inserted, ${skippedTargets} already present.`);

    const { rows: existingPrompts } = await c.query<{ prompt: string }>(
      `SELECT prompt FROM aeo_prompts WHERE client_id = $1`, [client.id],
    );
    const existingPromptSet = new Set(existingPrompts.map((r) => r.prompt.toLowerCase().trim()));
    let insertedPrompts = 0, skippedPrompts = 0;
    for (const p of AEO_PROMPTS) {
      if (existingPromptSet.has(p.toLowerCase().trim())) { skippedPrompts++; continue; }
      await c.query(
        `INSERT INTO aeo_prompts (id, client_id, prompt, active) VALUES ($1,$2,$3,true)`,
        [randomUUID(), client.id, p],
      );
      existingPromptSet.add(p.toLowerCase().trim());
      insertedPrompts++;
    }
    console.log(`AEO prompts: ${insertedPrompts} inserted, ${skippedPrompts} already present.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
/**
 * Guard for the one won/lost/open rule both HubSpot importers read.
 *
 * No network, no database, no HubSpot token — it composes src/hubspot-deal-
 * status.ts over invented fixtures and then reads the two importers to check
 * they still go through it. Runs in CI on every push.
 *
 * WHY. src/import-hubspot-deals.ts runs twice a day and could not close a deal
 * at all: it threw closed deals out of its own write set and hardcoded
 * status='open'. src/import-hubspot.ts decided the same question with a
 * different ternary. Two importers disagreeing about what "lost" means is
 * worse than one of them being wrong, because nobody can tell which answer
 * they are looking at.
 *
 * Every figure and every deal name below is invented. Nothing here was run
 * against a live HubSpot account.
 *
 *   npm run verify-hubspot-deal-status
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dealStatus, dealStageLabel, dealClosedAt, CLOSED_WON_STAGE, CLOSED_LOST_STAGE } from "./hubspot-deal-status";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const fail = (m: string) => { failures++; console.error(`  ✗ ${m}`); };
const pass = (m: string) => console.log(`  ✓ ${m}`);
const is = (what: string, got: unknown, want: unknown) =>
  got === want ? pass(`${what} — ${String(got)}`) : fail(`${what}: expected ${String(want)}, got ${String(got)}`);

console.log("1. HubSpot's own booleans answer first");
is("a win", dealStatus({ isClosedWon: "true", isClosed: "true" }).status, "won");
is("a loss", dealStatus({ isClosedWon: "false", isClosed: "true" }).status, "lost");
is("still open", dealStatus({ isClosedWon: "false", isClosed: "false" }).status, "open");
is("and the run can say which rung answered", dealStatus({ isClosedWon: "true" }).decidedBy, "hubspot_flags");
// The flags beat the stage: a pipeline whose closed stage is mis-configured
// must not turn a won deal into a lost one.
is("a win beats a closed stage at probability 0",
  dealStatus({ isClosedWon: "true", isClosed: "true", stageIsClosed: true, stageProbability: 0 }).status, "won");

console.log("2. the pipeline's own stage metadata is the fallback");
is("a closed stage at probability 1 is a win", dealStatus({ stageIsClosed: true, stageProbability: 1 }).status, "won");
is("a closed stage below it is a loss", dealStatus({ stageIsClosed: true, stageProbability: 0 }).status, "lost");
is("an open stage is open", dealStatus({ stageIsClosed: false, stageProbability: 0.25 }).status, "open");
is("and it says so", dealStatus({ stageIsClosed: false }).decidedBy, "stage_metadata");

console.log("3. an unresolved stage is never read as closed");
is("no flags, no stage", dealStatus({}).status, "open");
is("and that is named as the default it is", dealStatus({}).decidedBy, "default_open");
// This is the call the old `isOpen` already made (`!si ? true`), kept rather
// than re-decided: a stage id this run could not resolve is a gap in what we
// fetched, not a fact about the deal.
is("a null stage does not close anything", dealStatus({ stageIsClosed: null, stageProbability: null }).status, "open");

console.log("4. closed with nothing saying which way is a REFUSAL, not a guess");
{
  // hs_is_closed says closed; the win flag was never returned; the stage could
  // not be resolved. Guessing "lost" takes a real win off the board and out of
  // every revenue figure that reads it. Guessing "open" leaves a stale row.
  // Neither is a reading, so there is no status at all.
  const r = dealStatus({ isClosed: "true" });
  is("no status", r.status, null);
  is("and it is named as such", r.decidedBy, "cant_tell");
  if (r.why.length > 20) pass("and it says what it could not see"); else fail("the refusal carries no reason");
  // A PRESENT "false" is an answer, not an absence — which is exactly what
  // src/import-hubspot.ts has always relied on.
  is("a present 'false' win flag is an answer", dealStatus({ isClosed: "true", isClosedWon: "false" }).status, "lost");
  is("an empty string is not", dealStatus({ isClosed: "true", isClosedWon: "" }).status, null);
  // …unless the stage settles it.
  is("the stage settles it where it can",
    dealStatus({ isClosed: "true", stageIsClosed: true, stageProbability: 1 }).status, "won");
}

console.log("5. the label and the close stamp follow the status");
is("a win takes the app's own closed label", dealStageLabel("won", "Qualified to buy"), CLOSED_WON_STAGE);
is("a loss takes the other", dealStageLabel("lost", "Contract sent"), CLOSED_LOST_STAGE);
is("an open deal keeps the stage the caller worked out", dealStageLabel("open", "Contract sent"), "Contract sent");
is("a closed deal is stamped with its close date", dealClosedAt("won", "2026-09-20"), "2026-09-20");
// A closed deal with no date in HubSpot gets none here rather than today's,
// which nobody recorded.
is("a closed deal with no date gets none", dealClosedAt("lost", null), null);
is("an open deal is never stamped", dealClosedAt("open", "2026-09-20"), null);

console.log("6. both importers go through it, and neither decides on its own");
{
  // Comments are stripped first. The prose in both importers explains exactly
  // which two lines used to make the scheduled path unable to close a deal, by
  // quoting them — and a guard that trips over its own explanation is useless
  // (the same lesson scripts/verify-deal-delete.ts learned in the app repo).
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const read = (f: string) => (existsSync(path.join(ROOT, f)) ? strip(readFileSync(path.join(ROOT, f), "utf8")) : null);
  for (const f of ["src/import-hubspot.ts", "src/import-hubspot-deals.ts"]) {
    const src = read(f);
    if (!src) { fail(`${f} is missing — this check is reading nothing`); continue; }
    if (/dealStatus\(\s*\{/.test(src)) pass(`${f} asks the shared rule`);
    else fail(`${f} no longer calls dealStatus() — it is deciding won/lost on its own again`);
    // The ternary this module replaced, in either importer's spelling.
    if (/\?\s*"won"\s*:\s*\w+\s*\?\s*"lost"\s*:\s*"open"/.test(src)) {
      fail(`${f} has an inline won/lost ternary again — that is the drift this module exists to end`);
    } else pass(`${f} holds no won/lost ternary of its own`);
  }
  const sched = read("src/import-hubspot-deals.ts");
  if (sched) {
    // The two lines that made the scheduled path unable to close anything.
    if (/status\s*=\s*'open'/.test(sched)) {
      fail("src/import-hubspot-deals.ts hardcodes status='open' in a write path again — a deal closed in HubSpot cannot close here");
    } else pass("src/import-hubspot-deals.ts writes the status it read, not a literal");
    // The other line, and it has to be checked by its SHAPE rather than by the
    // helper's old name: `salesDeals.filter(isOpen)` is one spelling of it and
    // an inline predicate is another, and both make every counter below read 0
    // with nothing failing. So: every sales deal must reach the classification
    // loop, and nothing may narrow that list on the way in — the pipeline
    // allowlist is what PRODUCES salesDeals and runs before this.
    if (!/for \(const d of salesDeals\)/.test(sched)) {
      fail("src/import-hubspot-deals.ts no longer classifies every sales deal — something is narrowing the list before the outcome is read, and a closed deal cannot close what it never reaches");
    } else if (/salesDeals\.filter\(/.test(sched)) {
      fail("src/import-hubspot-deals.ts filters salesDeals again before classifying them — that is how closed deals were thrown out of the write set in the first place, and it fails silently: every closed-deal counter reads 0 and nothing errors");
    } else pass("every sales deal reaches the outcome rule — closed ones are no longer thrown out before the write");
    // And the guard that must survive it, in the other direction.
    // Anchored on the EXISTING row, not on any `status !== "open"` in the
    // file: the classification's own `else if (status !== "open")` branch
    // satisfied the loose version, so this check passed with the guard deleted.
    if (/existing\.rows\[0\]\.status\s*!==\s*"open"/.test(sched)) pass("a deal already closed in the app is still left alone");
    else fail("src/import-hubspot-deals.ts lost its `existing.status !== \"open\"` guard — it can now overwrite an outcome recorded in the app");
    // History is the manual importer's job: a schedule that silently inserted
    // hundreds of won/lost rows would move every revenue figure in the app
    // with nobody having pressed anything.
    if (/closedNotHere/.test(sched)) pass("a closed deal that is not on the board here is reported, not created");
    else fail("src/import-hubspot-deals.ts no longer reports the closed deals it did not create — either it is inserting history, or it is discarding it silently");
  }
}

console.log("");
if (failures) { console.error(`verify-hubspot-deal-status: ${failures} check(s) failed.`); process.exit(1); }
console.log("verify-hubspot-deal-status: one rule, read by both importers.");

#!/usr/bin/env tsx
import "dotenv/config";
import { runDashboardSync, type SyncEntry } from "./emit.js";
import { TRACKER_CONFIGS, resolveConfig, countedFromNote, sheetRefsOf, type TrackerConfig } from "./tracker/config.js";
import { FINDINGS, hasStop, lineFor, worstLine, type Finding } from "./tracker/causes.js";
import { buildFeedEntries, buildFeedSummary, readRows, type RowItem } from "./tracker/reading.js";
import { buildMergedSummary, mergeSheets, sheetLabels, type SheetRead } from "./tracker/merge.js";
import { resolveLayouts } from "./tracker/table.js";
import { openSource } from "./tracker/source.js";
import { diagnoseLines } from "./tracker/diagnose.js";
import { findCandidates, indexLeads, leadMatchLine, noMatch, resolveLeadColumns, type LeadMatchSummary } from "./tracker/lead-match.js";
import type { FeedSummary } from "./tracker/reading.js";
import type { Table } from "./tracker/table.js";
import type { RoleFound } from "./tracker/table.js";
import type { RoleName } from "./tracker/config.js";

/**
 * Closed-deal trackers for clients other than DPG (whose importer is
 * import-dpg-tracker.ts): reads a client's sales sheet from Smartsheet or Google
 * Sheets, READ ONLY, counts the wins that are ours, and writes monthly won
 * revenue by CLOSED date plus a summary through the dashboard's sync contract.
 * It never writes to the sheet.
 *
 *   npm run import-tracker -- --client=franklin --diagnose   # headings and counts only, writes nothing
 *   npm run import-tracker -- --client=franklin --dry-run    # read, print counts, write nothing
 *   npm run import-tracker                                   # every configured client
 *
 * A heading it cannot find, a sheet it cannot open, or a sheet too long to read
 * is a STOP with a named cause: nothing is written, the last good figures stand,
 * and the heartbeat note says why. Its last printed line is that note
 * (`TRACKER-FEED <slug> ok|warn|stop <cause>: sentence`), a contract with the
 * dashboard. It prints counts, dates, headings and row numbers only: never a
 * name, a phone number, an email or a sheet link.
 */
const businessDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const arg = (name: string): string | undefined => { const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : undefined; };
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);
const whoSays = (w: Finding["who"]) => (w === "us" ? "ours to fix" : w === "client" ? "the client's to fix" : w === "provider" ? "the platform's" : "find out first");


/**
 * The lead match: untagged quote-log rows that match a real ad lead. READ ONLY and ADDITIVE. It reads the lead sheet through the
 * same door, adds one list to the summary and changes nothing else: the counted wins, the months, the fee and the pending rows
 * are computed before this runs and are not touched by it. A lead sheet that cannot be read is recorded in the summary and
 * stops nothing, because it contributes no counted sale. Null: this client has no lead sheet, so the summary is as it was.
 */
async function leadMatchFor(
  base: TrackerConfig,
  quote: { table: Table; found: Partial<Record<RoleName, RoleFound>>; cfg: TrackerConfig } | null,
  today: string,
): Promise<LeadMatchSummary | null> {
  const spec = base.leadMatch;
  if (!spec) return null;
  const readAt = new Date().toISOString();
  try {
    // Only a lead sheet somebody NAMED is read. The second merged sheet is never borrowed for this: naming it here as well is one
    // more variable, and it keeps a merged read's summary exactly what it was for a client with no lead sheet.
    if (!base.leadSheetId) return null;
    const o = await openSource({ ...base, sheetId: base.leadSheetId }, process.env, { headersOnly: false });
    if (o.kind === "stop") return noMatch("stopped", readAt, o.finding.line, o.finding.code);
    const table = o.table;
    if (!quote) return noMatch("no_quote_log", readAt, "The main sheet is not laid out as a quote log, so there is nothing to compare the leads against.");
    const cols = resolveLeadColumns(table.headers, spec);
    if (!cols.ok) {
      const bits = [cols.missing.length ? `no heading for ${cols.missing.join(", ")}` : "", cols.duplicate.length ? `more than one heading for ${cols.duplicate.join(", ")}` : ""].filter(Boolean).join("; ");
      return noMatch("headings", readAt, `The lead sheet has ${bits}, so no lead was compared.`);
    }
    const idx = indexLeads(table, cols.cols, { countedFrom: base.countedFrom, today });
    return findCandidates(quote, idx, spec, { today, readAt });
  } catch (e) {
    return noMatch("stopped", readAt, `The lead sheet could not be compared (${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 100)}).`, "check_crashed");
  }
}
/** Diagnose for the lead sheet: its name, its headings and which of them each job found. Headings only, never a cell. */
async function diagnoseLead(cfg: TrackerConfig) {
  if (!cfg.leadMatch || !cfg.leadSheetId) return;
  const o = await openSource({ ...cfg, sheetId: cfg.leadSheetId }, process.env, { headersOnly: true });
  if (o.kind === "stop") { console.log(`\nLead sheet: stopped (${o.finding.code}). ${o.finding.line}`); return; }
  const cols = resolveLeadColumns(o.table.headers, cfg.leadMatch);
  console.log(`\nLead sheet${o.sheetName ? ` "${o.sheetName}"` : ""}: ${o.table.headers.length} headings: ${o.table.headers.join(" | ")}`);
  if (cols.ok) console.log(`Lead sheet columns found: email "${cols.cols.headers.email}", submitted "${cols.cols.headers.submittedOn}", spam "${cols.cols.headers.spam}", click id ${cols.cols.headers.clickIds.length ? cols.cols.headers.clickIds.map((h) => `"${h}"`).join(", ") : "none"}.`);
  else console.log(`Lead sheet columns NOT found: ${[...cols.missing.map((m) => `no heading for ${m}`), ...cols.duplicate.map((m) => `more than one heading for ${m}`)].join("; ")}. Add the heading as an alias in FRANKLIN_LEAD_MATCH (src/tracker/config.ts).`);
}
const withLeadMatch = (s: FeedSummary, lm: LeadMatchSummary | null): FeedSummary => (lm ? { ...s, leadMatch: lm } : s);

function printFindings(findings: Finding[]) {
  for (const f of findings) {
    console.log(`\n[${f.level}] ${f.code} (${whoSays(f.who)}): ${f.line}`);
    f.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  }
}

async function one(base: TrackerConfig, o: { dryRun: boolean; diagnose: boolean; today: string }): Promise<{ line: string; findings: Finding[] }> {
  const resolved = resolveConfig(base);
  const ignored = countedFromNote(base);
  if (ignored) console.log(ignored);
  const refs = sheetRefsOf(resolved);
  if (o.diagnose) await diagnoseLead(resolved);
  // Several sheets are a merged read. One (or none) is exactly the single-sheet path below, unchanged.
  if (refs.length > 1) return many(resolved, refs, o);
  return single(refs.length === 1 ? { ...resolved, sheetId: refs[0]! } : resolved, o);
}

/** Several sheets for one client: each is opened and laid out on its own, a stop on one leaves the others reading, and the rows are merged once. */
async function many(cfg: TrackerConfig, refs: string[], o: { dryRun: boolean; diagnose: boolean; today: string }): Promise<{ line: string; findings: Finding[] }> {
  console.log(`\n-- ${cfg.key} (${cfg.source}) ${refs.length} sheets${o.diagnose ? " diagnose" : o.dryRun ? " dry-run" : ""}: counted from ${cfg.countedFrom}, kept by ${cfg.keptBy}, today ${o.today}`);
  type Opened = { index: number; layout: string | null; finding: Finding | null; read?: SheetRead; warns: Finding[]; layoutName: string | null };
  const results: Opened[] = [];
  const readOnes: { index: number; layout: string; reading: ReturnType<typeof readRows>; items: RowItem[]; edited: string | null; columns: Record<string, string>; accessLevel: string | null; resolvedFromLink: boolean; found: ReturnType<typeof resolveLayouts>; table: Table }[] = [];
  for (let i = 0; i < refs.length; i++) {
    const scfg: TrackerConfig = { ...cfg, sheetId: refs[i]! };
    console.log(`\nSheet ${i + 1} of ${refs.length}:`);
    const opened = await openSource(scfg, process.env, { headersOnly: o.diagnose });
    if (opened.kind === "stop") { results.push({ index: i, layout: null, layoutName: null, finding: opened.finding, warns: [] }); continue; }
    const lr = resolveLayouts(opened.table.headers, scfg);
    const f: Finding | null = lr.res.ok ? null
      : lr.leadListOnly ? FINDINGS.lead_list_only()
      : lr.res.reason === "missing" ? FINDINGS.headers_missing(lr.res.missing, Object.fromEntries(lr.res.missing.map((r) => [r, lr.cfg.roles[r]?.aliases ?? []])))
      : FINDINGS.headers_duplicate(lr.res.duplicate);
    if (o.diagnose) for (const l of diagnoseLines({ cfg: scfg, source: scfg.source, sheetName: opened.sheetName, tab: opened.tab, accessLevel: opened.accessLevel, modifiedAt: opened.sheetEditedAt, resolvedFromLink: opened.resolvedFromLink, table: opened.table })) console.log(l);
    if (f || !lr.res.ok) { results.push({ index: i, layout: lr.layout, layoutName: lr.layout, finding: f ?? FINDINGS.check_crashed("a layout did not resolve"), warns: [] }); continue; }
    if (o.diagnose) { results.push({ index: i, layout: lr.layout, layoutName: lr.layout, finding: null, warns: [] }); continue; }
    const collect = { sheet: i, items: [] as RowItem[] };
    const reading = readRows(opened.table, lr.res.found, lr.cfg, { today: o.today, collect });
    const columns: Record<string, string> = {};
    for (const [k, v] of Object.entries(lr.res.found)) if (v) columns[k] = v.header;
    readOnes.push({ index: i, layout: lr.layout, reading, items: collect.items, edited: opened.sheetEditedAt, columns, accessLevel: opened.accessLevel, resolvedFromLink: opened.resolvedFromLink, found: lr, table: opened.table });
    results.push({ index: i, layout: lr.layout, layoutName: lr.layout, finding: null, warns: [] });
  }

  const labels = sheetLabels(results.map((r) => r.layout));
  const stops = results.filter((r) => r.finding);
  const stopFindings = stops.map((r) => r.finding!);
  for (const r of stops) console.log(`Sheet ${r.index + 1} (${labels[r.index]}) stopped: ${r.finding!.code}.`);

  if (o.diagnose) {
    const first = stops[0];
    const line = first
      ? `TRACKER-FEED ${cfg.clientSlug} warn ${first.finding!.code}: diagnose only, sheet ${first.index + 1}: ${first.finding!.line}`.slice(0, 295)
      : `TRACKER-FEED ${cfg.clientSlug} ok: diagnose found every needed heading on all ${refs.length} sheets (${labels.join(", ")}).`;
    return { line, findings: [] };
  }
  if (stops.length > 0) {
    // ONE SHEET THAT CANNOT BE READ HOLDS THE WHOLE READ. A figure built from the sheets that did read would silently lose every
    // sale that is only on the sheet that did not, and each month's newest row wins, so the loss would reach the page as a
    // lower number. Nothing is written: the last good figures of both sheets stand, and the line names the sheet and its own cause
    // (the cause is the sheet's, so "not connected" stays not connected and the prompt can ask for the right thing).
    for (const x of readOnes) console.log(`${labels[x.index]}: read, ${x.reading.rows} rows. Not recorded, because the other sheet could not be read.`);
    const first = stops[0]!;
    const many2 = stops.length > 1 ? `${stops.length} sheets could not be read. ` : "";
    const held: Finding = { ...first.finding!, level: "stop", line: `${many2}${labels[first.index]}: ${first.finding!.line}` };
    console.log("Nothing was written, so the figures on the dashboard are from the last read in which every sheet could be read.");
    return { line: lineFor(cfg.clientSlug, [held], null), findings: [held, ...stopFindings.slice(1)] };
  }

  const now = new Date().toISOString();
  const reads: SheetRead[] = readOnes.map((r) => ({ index: r.index, layout: r.layout, label: labels[r.index]!, reading: r.reading, items: r.items, readAt: now, editedAt: r.edited, columns: r.columns }));
  const merged = mergeSheets(reads, [], cfg, o.today);
  const r = merged.reading;

  const warns: Finding[] = [];
  if (merged.merge.conflicts.length || merged.merge.couldBeSame.length) warns.push(FINDINGS.sheets_disagree(merged.merge.conflicts.length, merged.merge.couldBeSame.length));
  if (r.problems.length) warns.push(FINDINGS.rows_refused(r.problems));
  if (r.otherStatus) warns.push(FINDINGS.other_status(r.otherStatus));
  for (const x of readOnes) if (x.accessLevel && !["VIEWER", "COMMENTER"].includes(x.accessLevel.toUpperCase())) { warns.push(FINDINGS.access_too_wide(x.accessLevel)); break; }

  for (const s of merged.sheets) {
    console.log(`${s.label}: ${s.rows} rows, ${s.ourRows} ours, ${s.wins} won in the combined figure (${s.onBoth} also on the other sheet), ${s.held} held as could-be-the-same, ${s.pending} pending, ${s.refused} refused. ${s.sheetEditedAt ? `Last modified ${s.sheetEditedAt}.` : "Modified time not available."}`);
  }
  console.log(`Merged: ${merged.merge.sameOnBoth} deal${merged.merge.sameOnBoth === 1 ? "" : "s"} on both sheets counted once, ${merged.merge.inSeed} already in the entered figure, ${merged.merge.conflicts.length} with different amounts or dates, ${merged.merge.couldBeSame.length} held as could-be-the-same.`);
  console.log(`Counted since ${cfg.countedFrom}: ${r.counted.length} won, ${dollars(r.countedCents)}. Pending (not counted): ${r.pending.length}, ${dollars(r.pendingCents)}. Refused: ${r.problems.length}. Unrecognised status: ${r.otherStatus}.`);
  console.log(`Closed before the feed starts (${cfg.countedFrom}): ${r.beforeFeed.deals} in the entered figure's window, ${dollars(r.beforeFeed.cents)}${r.beforeFeed.noAmount ? `, ${r.beforeFeed.noAmount} with no amount` : ""}; ${r.beforeSeed} earlier still. None of these is counted by the feed.`);
  console.log(`Click id on ${r.keys.withClickId} of ${r.counted.length} counted wins${r.keys.badClickId ? ` (${r.keys.badClickId} not a usable id)` : ""}; email ${r.keys.withEmail}, phone ${r.keys.withPhone}, form id ${r.keys.withFormId}, name only ${r.keys.nameOnly}.`);

  const quoteOne = readOnes.find((x) => x.layout === "rfq_log" && x.found.res.ok);
  const lm = await leadMatchFor(
    cfg,
    quoteOne && quoteOne.found.res.ok ? { table: quoteOne.table, found: quoteOne.found.res.found, cfg: quoteOne.found.cfg } : null,
    o.today,
  );
  if (lm) console.log(leadMatchLine(lm));
  const summary = withLeadMatch(buildMergedSummary(merged, cfg, now), lm);
  const entries = buildFeedEntries(cfg.clientSlug, r, summary, cfg, o.today);
  for (const e of entries) {
    if (e.external_id.endsWith("-summary")) continue;
    console.log(`  ${e.period_start.slice(0, 7)}: ${e.metrics["manual.tracker_won_deals"] ?? "-"} won, ${dollars(Number(e.metrics["manual.revenue_system_cents"]))}`);
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const dashboardDir = process.env.DASHBOARD_DIR?.trim();
  if (!databaseUrl || !dashboardDir) {
    const f = FINDINGS.check_crashed("DATABASE_URL or DASHBOARD_DIR is not set, so nothing could be recorded");
    return { line: lineFor(cfg.clientSlug, [f], null), findings: [f] };
  }
  const code = runDashboardSync({ databaseUrl, dashboardDir }, entries as SyncEntry[], { dryRun: o.dryRun });
  if (code !== 0) {
    const f = FINDINGS.check_crashed(`the dashboard sync exited ${code}`);
    return { line: lineFor(cfg.clientSlug, [f], null), findings: [f] };
  }
  return { line: lineFor(cfg.clientSlug, warns, { sourceKind: cfg.source, rows: r.rows, counted: r.counted.length, pending: r.pending.length, sheetsRead: readOnes.length }), findings: warns };
}

async function single(cfg: TrackerConfig, o: { dryRun: boolean; diagnose: boolean; today: string }): Promise<{ line: string; findings: Finding[] }> {
  console.log(`\n-- ${cfg.key} (${cfg.source})${o.diagnose ? " diagnose" : o.dryRun ? " dry-run" : ""}: counted from ${cfg.countedFrom}, kept by ${cfg.keptBy}, today ${o.today}`);
  const opened = await openSource(cfg, process.env, { headersOnly: o.diagnose });
  if (opened.kind === "stop") return { line: lineFor(cfg.clientSlug, [opened.finding], null), findings: [opened.finding] };

  const lr = resolveLayouts(opened.table.headers, cfg);
  const layoutFinding = (): Finding | null =>
    lr.res.ok ? null
      : lr.leadListOnly ? FINDINGS.lead_list_only()
      : lr.res.reason === "missing" ? FINDINGS.headers_missing(lr.res.missing, Object.fromEntries(lr.res.missing.map((r) => [r, lr.cfg.roles[r]?.aliases ?? []])))
      : FINDINGS.headers_duplicate(lr.res.duplicate);

  if (o.diagnose) {
    for (const l of diagnoseLines({ cfg, source: cfg.source, sheetName: opened.sheetName, tab: opened.tab, accessLevel: opened.accessLevel, modifiedAt: opened.sheetEditedAt, resolvedFromLink: opened.resolvedFromLink, table: opened.table })) console.log(l);
    const f = layoutFinding();
    return { line: f ? `TRACKER-FEED ${cfg.clientSlug} warn ${f.code}: diagnose only, ${f.line}`.slice(0, 295) : `TRACKER-FEED ${cfg.clientSlug} ok: diagnose found every needed heading (layout ${lr.layout}).`, findings: [] };
  }

  const lf = layoutFinding();
  if (lf) return { line: lineFor(cfg.clientSlug, [lf], null), findings: [lf] };
  if (!lr.res.ok) throw new Error("unreachable");
  const r = readRows(opened.table, lr.res.found, lr.cfg, { today: o.today });
  const warns: Finding[] = [];
  if (r.problems.length) warns.push(FINDINGS.rows_refused(r.problems));
  if (r.otherStatus) warns.push(FINDINGS.other_status(r.otherStatus));
  if (opened.accessLevel && !["VIEWER", "COMMENTER"].includes(opened.accessLevel.toUpperCase())) warns.push(FINDINGS.access_too_wide(opened.accessLevel));

  console.log(`Read layout ${lr.layout}${opened.resolvedFromLink ? " (sheet found from its link)" : ""}: ${r.rows} rows, ${r.ourRows} ours, ${r.notOurs} not ours (${r.wonNotOurs} of them marked Won), ${r.sourceBlank} with no source.`);
  console.log(`Counted since ${cfg.countedFrom}: ${r.counted.length} won, ${dollars(r.countedCents)}. Pending (not counted): ${r.pending.length}, ${dollars(r.pendingCents)}. Refused: ${r.problems.length}. Unrecognised status: ${r.otherStatus}.`);
  console.log(`Closed before the feed starts (${cfg.countedFrom}): ${r.beforeFeed.deals} in the entered figure's window, ${dollars(r.beforeFeed.cents)}${r.beforeFeed.noAmount ? `, ${r.beforeFeed.noAmount} with no amount` : ""}; ${r.beforeSeed} earlier still. None of these is counted by the feed.`);
  console.log(`Click id on ${r.keys.withClickId} of ${r.counted.length} counted wins${r.keys.badClickId ? ` (${r.keys.badClickId} not a usable id)` : ""}; email ${r.keys.withEmail}, phone ${r.keys.withPhone}, form id ${r.keys.withFormId}, name only ${r.keys.nameOnly}.`);
  console.log(opened.sheetEditedAt ? `Sheet last modified ${opened.sheetEditedAt}.` : "Sheet modified time not available.");

  const lm = await leadMatchFor(cfg, lr.layout === "rfq_log" ? { table: opened.table, found: lr.res.found, cfg: lr.cfg } : null, o.today);
  if (lm) console.log(leadMatchLine(lm));
  const summary = withLeadMatch(buildFeedSummary(r, lr.cfg, lr.res.found, new Date().toISOString(), opened.sheetEditedAt), lm);
  const entries = buildFeedEntries(cfg.clientSlug, r, summary, lr.cfg, o.today);
  for (const e of entries) {
    if (e.external_id.endsWith("-summary")) continue;
    console.log(`  ${e.period_start.slice(0, 7)}: ${e.metrics["manual.tracker_won_deals"] ?? "-"} won, ${dollars(Number(e.metrics["manual.revenue_system_cents"]))}`);
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const dashboardDir = process.env.DASHBOARD_DIR?.trim();
  if (!databaseUrl || !dashboardDir) {
    const f = FINDINGS.check_crashed("DATABASE_URL or DASHBOARD_DIR is not set, so nothing could be recorded");
    return { line: lineFor(cfg.clientSlug, [f], null), findings: [f] };
  }
  const code = runDashboardSync({ databaseUrl, dashboardDir }, entries as SyncEntry[], { dryRun: o.dryRun });
  if (code !== 0) {
    const f = FINDINGS.check_crashed(`the dashboard sync exited ${code}`);
    return { line: lineFor(cfg.clientSlug, [f], null), findings: [f] };
  }
  return { line: lineFor(cfg.clientSlug, warns, { sourceKind: cfg.source, rows: r.rows, counted: r.counted.length, pending: r.pending.length }), findings: warns };
}

async function main() {
  const dryRun = flag("dry-run");
  const diagnose = flag("diagnose");
  const want = arg("client")?.trim();
  const configs = TRACKER_CONFIGS.filter((c) => !want || c.key === want || c.clientSlug === want);
  if (configs.length === 0) {
    console.error(`TRACKER-FEED ${want ?? "none"} stop check_crashed: the import itself failed (no tracker is configured for "${want}").`);
    process.exit(1);
  }
  const today = businessDay();
  console.log(`Tracker import${diagnose ? " (diagnose)" : dryRun ? " (dry-run)" : ""}, ${configs.length} client${configs.length === 1 ? "" : "s"}, today ${today}`);
  const lines: string[] = [];
  const all: Finding[] = [];
  for (const c of configs) {
    const res = await one(c, { dryRun, diagnose, today });
    lines.push(res.line); all.push(...res.findings);
    printFindings(res.findings);
    console.log(res.line);
  }
  // The heartbeat reads the LAST line: the worst client's. Keep it last.
  console.log(`\n${worstLine(lines)}`);
  const stopped = lines.some((l) => /^TRACKER-FEED \S+ stop /.test(l)) || hasStop(all);
  process.exit(stopped ? 1 : 0);
}

main().catch((e) => {
  const why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ");
  console.error(`TRACKER-FEED ${arg("client") ?? "all"} stop check_crashed: the import itself failed (${why.slice(0, 150)}).`);
  process.exit(1);
});

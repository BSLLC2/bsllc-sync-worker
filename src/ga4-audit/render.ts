/**
 * Markdown for the standing report and the one-page client summary. Pure.
 * Every table prints its date range and what it leaves out above its rows, and
 * every column header carries its label ("confirmed from data" or "inference").
 */
import { DEFINITIONS, fmt, fmtChange, change, type Table } from "./metrics.js";
import { label, periodsFor } from "./periods.js";
import { effectTable, headlineTable } from "./reconcile.js";
import { buildHelp } from "./help.js";
import type { Audit } from "./run.js";

const BASIS_MARK = { "confirmed from data": "", inference: " (inference)" } as const;

export function tableMd(t: Table): string {
  const head = `| ${t.columns.map((c) => `${c.title}${BASIS_MARK[c.basis]}`).join(" | ")} |`;
  const sep = `| ${t.columns.map(() => "---").join(" | ")} |`;
  const rows = t.rows.map((r) => `| ${t.columns.map((c) => String(fmt(r[c.key] as number | string | null | undefined ?? null, c.unit)).replace(/\|/g, "/")).join(" | ")} |`);
  return [`**${t.title}**`, `Dates: ${t.range}. Left out or applied: ${t.filter}.`, "", head, sep, ...(rows.length ? rows : [`| ${t.columns.map((_, i) => (i === 0 ? "nothing to show" : "")).join(" | ")} |`]), ...(t.note ? ["", `_${t.note}_`] : []), ""].join("\n");
}

export function reportMd(a: Audit): string {
  const h = buildHelp(a);
  const p = periodsFor(a.window);
  const out: string[] = [];
  out.push(`# ${a.client}: GA4 and Search Console audit`, "", `Run on ${a.generatedOn}. Window: ${label(a.window)}. Period before: ${label(p.prior)}. Same dates a year earlier: ${label(p.priorYear)}.`, "", "Read-only. Nothing here writes to Google Analytics, Search Console or any database. Every figure is labelled \"confirmed from data\" or \"inference\". An inference says what the data suggests and is never proof.", "");
  const changed = a.checks.filter((c) => c.status === "changed");
  out.push("## 0. Stored facts, re-checked", "");
  if (changed.length) out.push(`**${changed.length} stored fact${changed.length > 1 ? "s" : ""} no longer hold.** Everything below may rest on them. Read these first.`, ""); else if (a.checks.length) out.push("Every stored fact that could be checked still holds. Facts that cannot be checked are listed in section 10.", "");
  for (const c of a.checks) out.push(`- **${c.status.toUpperCase()}** (${c.basis}). ${c.claim}. Expected: ${c.expected}. Found: ${c.found}. Dates: ${c.range}. Applied: ${c.filter}.`);
  out.push("", "## 1. Headline", "", tableMd(headlineTable(a.reconciliation)));
  if (a.reconciliation.warning) out.push(`**Comparability warning.** ${a.reconciliation.warning}`, "");
  out.push(tableMd(effectTable(a.reconciliation)));
  out.push("## 2. What moved", "", ...a.movers.tables.map(tableMd));
  out.push("## 3. Advisor microsites", "", a.advisors.note, "", a.advisors.directoryNote, "", tableMd(a.advisors.tables.leaders), tableMd(a.advisors.tables.risers), tableMd(a.advisors.tables.fallers));
  out.push("## 4. The form funnel", "", "A form submit event is not an enquiry, a lead or a conversion. It is one firing of an event. It includes advisor searches on the homepage and directory, and repeats.", "", tableMd(a.funnel.tables.byGroup), tableMd(a.funnel.tables.excludingSearches), tableMd(a.funnel.byChannel), tableMd(a.funnel.organic));
  out.push("## 5. Sources", "", tableMd(a.sources.tables.byClass), tableMd(a.sources.tables.ai), ...a.sources.notes.map((x) => `- ${x}`), "");
  out.push("## 6. Search Console", "");
  if (a.gsc) out.push(`Property: ${a.gsc.property} (${a.gsc.permission || "permission not reported"}). History starts ${a.gsc.firstDay ?? "unknown"}.`, "", ...a.gsc.tables.map(tableMd), ...(a.cross ? [tableMd(a.cross)] : []), ...a.gsc.notes.map((x) => `- ${x}`), ""); else out.push("Search Console was not read. See section 10.", "");
  out.push("## 7. Bot and quality watch", "", "Flags are our reading of low engagement on many sessions. Google Analytics does not say a visit was automated.", "", tableMd(a.bots.landing.table), tableMd(a.bots.country.table), tableMd(a.bots.city.table), tableMd(a.bots.source.table));
  out.push("## 8. Anomalies and projection", "");
  for (const s of a.series) {
    out.push(`**${s.name}.** ${s.weeks} complete weeks, ${s.range}. Applied: ${s.filter}.`, "");
    if (s.step) out.push(`- Largest step change (inference): between the week of ${s.step.before} and the week of ${s.step.after}, average ${fmt(s.step.meanBefore, "count")} a week before and ${fmt(s.step.meanAfter, "count")} after (${fmtChange(s.step.shift)}). The data shows where it moved. It cannot say why.`);
    else out.push("- No step change large enough (25% and six weeks each side).");
    for (const f of s.flags.slice(-8)) out.push(`- Week of ${f.week}: ${fmt(f.value, "count")} against about ${fmt(f.expected, "count")} expected from the eight weeks before (${fmtChange(f.deviation)}, ${f.direction}).`);
    out.push("");
  }
  out.push(`**Projection (inference).** ${a.projection.reason}${a.projection.ok ? ` Range: ${fmt(a.projection.low, "count")} to ${fmt(a.projection.high, "count")} sessions.` : ""}`, "");
  out.push("## 9. For the person presenting", "", "**Talking points**", "", ...h.talkingPoints.map((t, i) => `${i + 1}. ${t.point} Caveat: ${t.caveat}`), "", "**Next steps, in order**", "", ...h.nextSteps.map((t, i) => `${i + 1}. ${t.step} Because: ${t.because}`), "", "**Likely questions**", "", ...h.questions.map((t) => `- *${t.q}* ${t.a}`), "");
  out.push("## 10. Data quality and what could not be verified", "", ...a.quality.map((x) => `- ${x}`), "", "Could not be verified:", "", ...h.unverified.map((x) => `- ${x}`), "");
  out.push("## Definitions", "", ...DEFINITIONS.map((d) => `- **${d.term}.** ${d.means}`), "");
  return out.join("\n");
}

/** One page for the client: plain language, no internal terms, every figure dated. */
export function clientSummaryMd(a: Audit): string {
  const h = buildHelp(a);
  const p = periodsFor(a.window);
  const hd = a.reconciliation.headline;
  const lines: string[] = [];
  lines.push(`# ${a.client}: website summary`, "", `Dates: ${label(a.window)}. Compared with ${label(p.prior)}${a.reconciliation.comparable.priorYear ? ` and ${label(p.priorYear)}` : ""}.`, "");
  lines.push(`- **Visits:** ${fmt(hd[0].sessions, "count")}${a.reconciliation.comparable.prior ? ` (${fmtChange(change(hd[0].sessions, hd[1].sessions))} on the period before)` : ""}. A visit is one session, not one person.`);
  lines.push(`- **Engaged visits:** ${fmt(hd[0].rate, "percent")}. A visit counts as engaged when it lasts at least 10 seconds, views two pages, or submits a form.`);
  lines.push(`- **Average time engaged per visit:** ${fmt(hd[0].avgSeconds, "seconds")}.`);
  lines.push(`- **Form submit events:** ${fmt(a.funnel.submitRequestLike[0], "count")} on pages other than the homepage and directory. This is how often the form event fired. It is not a count of enquiries.`);
  if (a.gsc?.available[0]) lines.push(`- **Clicks from Google search:** ${fmt(a.gsc.tables[0]!.rows[0]!.clicks as number, "count")}, measured by Google Search Console.`);
  lines.push("", "## What this means", "", ...h.talkingPoints.slice(0, 4).map((t) => `- ${t.point}`), "", "## What these numbers cannot tell you", "", ...[h.talkingPoints[0]!.caveat, "Automated visits were present on the site for part of the last year. The figures above leave out the traffic our rule identifies as automated. Our rule is a judgement and is stated in the full report.", "Form submit events are not enquiries. The Airtable is the count of leads."].map((x) => `- ${x}`), "", "## What we would do next", "", ...h.nextSteps.slice(0, 3).map((t, i) => `${i + 1}. ${t.step}`), "");
  return lines.join("\n");
}

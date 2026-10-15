/**
 * The diagnose report: the sheet's NAME, its column headings and counts, and
 * which heading each role was found in. No cell value is read into it and none
 * is printed. This is how the owner tells which sheet it is (the RFQ log or the
 * form submissions) and what the headings are called, with nobody reading rows.
 *
 * The only things printed are the sheet's own design: its name, its tab, its
 * column titles and types, a picklist column's declared options, and counts.
 */
import { normHeader, ROLE_NAMES, type TrackerConfig } from "./config.js";
import { ROLE_PLAIN } from "./causes.js";
import { resolveLayouts, type Table } from "./table.js";

export interface DiagnoseInput {
  cfg: TrackerConfig;
  source: string;
  sheetName: string | null;
  tab: string | null;
  accessLevel: string | null;
  modifiedAt: string | null;
  resolvedFromLink: boolean;
  table: Table;
}

const q = (s: string) => `"${s.replace(/\s+/g, " ").slice(0, 80)}"`;

export function diagnoseLines(d: DiagnoseInput): string[] {
  const t = d.table;
  const out: string[] = [];
  out.push(`Sheet: ${d.sheetName ? q(d.sheetName) : "(name not available)"}${d.tab ? `, tab ${q(d.tab)}` : ""}${d.resolvedFromLink ? " (found from the link)" : ""}`);
  out.push(`Source: ${d.source}. Access for this job: ${d.accessLevel ?? "not reported"}. Last modified: ${d.modifiedAt ?? "not available"}.`);
  out.push(`Rows: ${t.totalRows != null ? t.totalRows.toLocaleString("en-US") : "not reported"}. Columns: ${t.headers.length}.`);
  out.push("Column headings (position, type, hidden):");
  t.headers.forEach((h, i) => out.push(`  ${i + 1}. ${q(h)}${t.types[i] ? ` [${t.types[i]}]` : ""}${t.hidden[i] ? " (hidden)" : ""}`));

  const lr = resolveLayouts(t.headers, d.cfg);
  out.push("Layouts tried:");
  for (const x of lr.tried) {
    out.push(`  ${x.layout}: ${x.ok ? "every required heading found" : `not usable${x.missing.length ? `, no heading for ${x.missing.map((r) => ROLE_PLAIN[r]).join(", ")}` : ""}${x.duplicate.length ? `, ambiguous: ${x.duplicate.map((p) => `${ROLE_PLAIN[p.role]} (${p.headers.map(q).join(" or ")})`).join("; ")}` : ""}`}`);
  }
  out.push(lr.res.ok ? `Reading as: ${lr.layout}.` : lr.leadListOnly ? "This looks like a list of leads (click ids, emails, dates) with no outcome columns, so wins cannot be counted from it." : `No layout fits. Closest: ${lr.layout}.`);

  out.push(`Which heading each job found (layout ${lr.layout}):`);
  for (const role of ROLE_NAMES) {
    const spec = lr.cfg.roles[role];
    if (!spec) continue;
    const f = lr.res.found[role];
    out.push(`  ${role}${spec.required ? " (needed)" : ""}: ${f ? q(f.header) : `not found (looked for ${spec.aliases.slice(0, 5).map(q).join(", ")}${spec.aliases.length > 5 ? ", more" : ""})`}`);
  }
  const unclaimed = t.headers.filter((h) => !Object.values(lr.res.found).some((f) => f && f.header === h));
  if (unclaimed.length) out.push(`Headings no job uses: ${unclaimed.map(q).join(", ")}.`);

  // A picklist's options are the column's definition, so they can be shown: that is how the owner sees the words the sheet uses.
  const won = new Set(lr.cfg.wonValues.map(normHeader)), notWon = new Set(lr.cfg.knownNotWonValues.map(normHeader)), ours = new Set(lr.cfg.ourSourceValues.map(normHeader));
  for (const role of ["status", "source"] as const) {
    const f = lr.res.found[role];
    const opts = f ? t.options[f.index] : null;
    if (!f || !opts || !opts.length) continue;
    out.push(`Options in the ${q(f.header)} column:`);
    for (const o of opts.slice(0, 40)) {
      const n = normHeader(o);
      const what = role === "status" ? (won.has(n) ? "counts as Won" : notWon.has(n) ? "known, not Won" : "not recognised") : ours.size === 0 ? "every row is read as ours" : ours.has(n) ? "means ours" : "means not ours";
      out.push(`  ${q(o)}: ${what}`);
    }
  }
  const textual = (["status", "source"] as const).filter((r) => { const f = lr.res.found[r]; return f && !t.options[f.index]?.length; });
  if (textual.length) out.push(`The ${textual.join(" and ")} column${textual.length > 1 ? "s are" : " is"} plain text, so the words in ${textual.length > 1 ? "them" : "it"} are only checked on a real read, which reports counts.`);
  out.push(`Keys the sheet carries for a won row: click id ${lr.res.found.gclid ? "yes" : "no"}, email ${lr.res.found.email ? "yes" : "no"}, phone ${lr.res.found.phone ? "yes" : "no"}, form id ${lr.res.found.formId ? "yes" : "no"}. First-contact date ${lr.res.found.firstContact ? "yes" : "no"}.`);
  out.push("No cell value was read into this report.");
  return out;
}

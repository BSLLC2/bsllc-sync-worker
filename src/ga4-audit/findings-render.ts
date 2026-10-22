/** Markdown for the cross-source findings. Pure. Disagreements first, then what could not be joined. */
import { fmt, fmtChange, change } from "./metrics.js";
import { tableMd } from "./render.js";
import type { Agreement, Findings } from "./findings.js";

const WORD: Record<Agreement, string> = { disagree: "DISAGREE", one_source: "ONE SOURCE", cant_tell: "CANNOT TELL", agree: "AGREE" };

export function findingsMd(f: Findings): string[] {
  const out: string[] = ["## 6b. Where the sources agree and disagree", "", f.summary, ""];
  if (f.floors) out.push(f.floors, "");
  for (const it of f.items) {
    out.push(`**${WORD[it.agreement]}.** ${it.claim}`, "");
    for (const e of it.evidence) {
      const chg = e.before != null && e.now != null ? `, ${fmtChange(change(e.now, e.before))}` : "";
      out.push(`- ${e.source}: ${e.what} ${fmt(e.now, e.unit)}${e.before != null ? ` against ${fmt(e.before, e.unit)}${chg}` : ""} (${e.basis}; ${e.range}; ${e.filter}).`);
    }
    if (it.hypothesis) out.push(`- Hypothesis (inference, not a finding): ${it.hypothesis}`);
    out.push(`- What would settle it: ${it.settleBy}`);
    if (it.action) out.push(`- Next: ${it.action}`);
    out.push("");
  }
  for (const t of f.tables) out.push(tableMd(t));
  if (f.notJoined.length) out.push("**Not joined here** (these are real sources, but this audit does not read them):", "", ...f.notJoined.map((n) => `- ${n.source}: ${n.why}`), "");
  return out;
}

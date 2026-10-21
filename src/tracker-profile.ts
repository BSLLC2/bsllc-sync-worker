#!/usr/bin/env tsx
import "dotenv/config";
import { TRACKER_CONFIGS, type TrackerConfig } from "./tracker/config.js";
import { openSource } from "./tracker/source.js";

/**
 * Aggregates-only profile of a client's sales sheet: which columns are filled on
 * the rows that read as won, and how the date columns spread over months. It
 * prints counts, months and one total per column, and NEVER a cell's text (no
 * name, phone, email or note). It writes nothing. Used once to decide which
 * column is the sale date and which is the amount before the mapping is set.
 *   npm run tracker-profile -- --client=franklin
 */
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

function ymd(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t);
  if (m) return `${m[3]!.length === 2 ? "20" + m[3] : m[3]}-${m[1]!.padStart(2, "0")}`;
  return null;
}
function day(s: string): number | null {
  const t = s.trim();
  const d = /^\d{4}-\d{2}-\d{2}/.test(t) ? new Date(t.slice(0, 10)) : /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(t) ? new Date(t) : null;
  return d && !Number.isNaN(d.getTime()) ? Math.floor(d.getTime() / 86400000) : null;
}
function money(s: string): number | null {
  const n = Number(s.replace(/[^0-9.\-]/g, ""));
  return s.trim() !== "" && Number.isFinite(n) ? n : null;
}
const median = (a: number[]) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]!; };

async function main() {
  const want = arg("client") ?? "franklin";
  const cfg = TRACKER_CONFIGS.find((c) => c.key === want || c.clientSlug === want);
  if (!cfg) throw new Error(`no tracker configured for ${want}`);
  const refs = [process.env.FRANKLIN_TRACKER_SHEET, process.env.FRANKLIN_TRACKER_SHEET_2].filter((x): x is string => !!x && x.trim() !== "");
  for (let i = 0; i < refs.length; i++) {
    const scfg: TrackerConfig = { ...cfg, sheetId: refs[i]! };
    const o = await openSource(scfg, process.env, { headersOnly: false });
    if (o.kind === "stop") { console.log(`Sheet ${i + 1}: stopped (${o.finding.code}).`); continue; }
    const t = o.table;
    const H = t.headers.map(fold);
    const col = (name: string) => H.indexOf(fold(name));
    const status = col("status"), source = col("rfq source");
    console.log(`\n=== Sheet ${i + 1}: ${t.rows.length} rows, ${t.headers.length} columns ===`);
    const byStatus = new Map<string, number>();
    for (const r of t.rows) { const s = (r[status] ?? "").trim() || "(blank)"; byStatus.set(s, (byStatus.get(s) ?? 0) + 1); }
    console.log("Rows by status:", [...byStatus].map(([k, v]) => `${k}=${v}`).join(" | "));
    const dateCols = t.headers.map((h, k) => ({ h, k })).filter(({ h, k }) => t.types[k] === "DATE" || /date|created|launch/i.test(h));
    const amountCols = t.headers.map((h, k) => ({ h, k })).filter(({ h }) => /\$|value|amount|price/i.test(h));
    const groups: [string, (r: string[]) => boolean][] = [
      ["won (any 'won' status)", (r) => /won/.test(fold(r[status] ?? ""))],
      ["verbally awarded", (r) => /verbal/.test(fold(r[status] ?? ""))],
      ["quote sent", (r) => /quote sent/.test(fold(r[status] ?? ""))],
    ];
    for (const [label, test] of groups) {
      const rows = t.rows.filter(test);
      const ours = source >= 0 ? rows.filter((r) => /bs llc ad campaign/.test(fold(r[source] ?? ""))) : [];
      console.log(`\n-- ${label}: ${rows.length} rows, ${ours.length} with the BS LLC ad source`);
      if (!rows.length) continue;
      const rfq = col("date of rfq");
      for (const { h, k } of dateCols) {
        const vals = rows.map((r) => r[k] ?? "").filter((v) => v.trim() !== "");
        const months = new Map<string, number>();
        for (const v of vals) { const m = ymd(v); if (m) months.set(m, (months.get(m) ?? 0) + 1); }
        const lag = rfq >= 0 && k !== rfq ? rows.map((r) => { const a = day(r[rfq] ?? ""), b = day(r[k] ?? ""); return a != null && b != null ? b - a : null; }).filter((x): x is number => x != null) : [];
        const span = [...months.keys()].sort();
        console.log(`   date "${h}": filled ${vals.length}/${rows.length}${span.length ? `, ${span[0]} to ${span[span.length - 1]}` : ""}${lag.length ? `, median days after "Date of RFQ" ${median(lag)} (n=${lag.length})` : ""}`);
        if (label.startsWith("won") && months.size) console.log(`      by month: ${[...months].sort().map(([m, n]) => `${m}:${n}`).join(" ")}`);
      }
      for (const { h, k } of amountCols) {
        const nums = rows.map((r) => money(r[k] ?? "")).filter((x): x is number => x != null);
        const nonNum = rows.filter((r) => (r[k] ?? "").trim() !== "" && money(r[k] ?? "") == null).length;
        console.log(`   amount "${h}": filled ${rows.filter((r) => (r[k] ?? "").trim() !== "").length}/${rows.length}, readable as a number ${nums.length}, text that is not a number ${nonNum}, total ${Math.round(nums.reduce((a, b) => a + b, 0))}, largest ${nums.length ? Math.max(...nums) : "n/a"}`);
      }
    }
  }
}
main().catch((e) => { console.error(`profile failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`); process.exit(1); });

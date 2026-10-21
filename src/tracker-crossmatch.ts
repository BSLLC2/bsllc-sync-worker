#!/usr/bin/env tsx
import "dotenv/config";
import { TRACKER_CONFIGS, type TrackerConfig } from "./tracker/config.js";
import { openSource } from "./tracker/source.js";

/**
 * Aggregates-only cross-check of a client's two sales sheets: which rows in the quote log belong to a person who
 * also filled in the ad-form sheet (matched on email, then phone), whether or not the log tags them as ours.
 * Prints counts, headings, months and totals. NEVER a cell's text: no name, phone, email, note or click id.
 * Writes nothing. A match here is a CANDIDATE for a person to confirm, never a count.
 *   QUOTE_SHEET=<link> FORM_SHEET=<link> npm run tracker-crossmatch -- --client=franklin
 */
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const emailKey = (s: string): string | null => { const m = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i.exec(s); return m ? m[0].toLowerCase() : null; };
const phoneKey = (s: string): string | null => { const d = s.replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : null; };
const num = (s: string): number | null => { const n = Number(s.replace(/[^0-9.\-]/g, "")); return s.trim() !== "" && Number.isFinite(n) ? n : null; };
function month(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})/.exec(t); if (m) return `${m[1]}-${m[2]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t); if (m) return `${m[3]!.length === 2 ? "20" + m[3] : m[3]}-${m[1]!.padStart(2, "0")}`;
  return null;
}

async function open(cfg: TrackerConfig, ref: string, label: string) {
  const o = await openSource({ ...cfg, sheetId: ref }, process.env, { headersOnly: false });
  if (o.kind === "stop") { console.log(`${label}: stopped (${o.finding.code}).`); process.exit(1); }
  return o.table;
}

async function main() {
  const cfg = TRACKER_CONFIGS.find((c) => c.key === (arg("client") ?? "franklin") || c.clientSlug === (arg("client") ?? "franklin"));
  if (!cfg) throw new Error("no tracker configured");
  const q = await open(cfg, process.env.QUOTE_SHEET ?? "", "Quote log");
  const f = await open(cfg, process.env.FORM_SHEET ?? "", "Ad form sheet");
  const qH = q.headers.map(fold), fH = f.headers.map(fold);
  console.log(`Quote log: ${q.rows.length} rows. Headings: ${q.headers.join(" | ")}`);
  console.log(`Ad form sheet: ${f.rows.length} rows. Headings: ${f.headers.join(" | ")}`);

  const qCols = (re: RegExp) => qH.map((h, i) => (re.test(h) ? i : -1)).filter((i) => i >= 0);
  const fCols = (re: RegExp) => fH.map((h, i) => (re.test(h) ? i : -1)).filter((i) => i >= 0);
  const qEmail = qCols(/e ?mail/), qPhone = qCols(/phone|mobile|tel/);
  const fEmail = fCols(/e ?mail/), fPhone = fCols(/phone|mobile|tel/), fClick = fCols(/gclid|click id|gbraid|wbraid/);
  const qStatus = qH.indexOf("status"), qSource = qH.indexOf("rfq source"), qRfq = qH.indexOf("date of rfq");
  const qAmt = qH.findIndex((h) => /quote value|quote \$/.test(h));
  console.log(`Columns found. Quote log: email ${qEmail.length}, phone ${qPhone.length}. Form sheet: email ${fEmail.length}, phone ${fPhone.length}, click id ${fClick.length}.`);

  const fEmails = new Map<string, number>(), fPhones = new Map<string, number>();
  let fWithClick = 0, fWithKey = 0;
  f.rows.forEach((r, i) => {
    let any = false;
    for (const c of fEmail) { const k = emailKey(r[c] ?? ""); if (k) { fEmails.set(k, i); any = true; } }
    for (const c of fPhone) { const k = phoneKey(r[c] ?? ""); if (k) { fPhones.set(k, i); any = true; } }
    if (any) fWithKey++;
    if (fClick.some((c) => (r[c] ?? "").trim() !== "")) fWithClick++;
  });
  console.log(`Form sheet rows with an email or phone: ${fWithKey}/${f.rows.length}; with a click id: ${fWithClick}.`);

  const isOurs = (r: string[]) => qSource >= 0 && /bs llc ad campaign/.test(fold(r[qSource] ?? ""));
  const matchOf = (r: string[]): "email" | "phone" | null => {
    for (const c of qEmail) { const k = emailKey(r[c] ?? ""); if (k && fEmails.has(k)) return "email"; }
    for (const c of qPhone) { const k = phoneKey(r[c] ?? ""); if (k && fPhones.has(k)) return "phone"; }
    return null;
  };
  type Bucket = { n: number; amt: number; months: Map<string, number> };
  const mk = (): Bucket => ({ n: 0, amt: 0, months: new Map() });
  const add = (b: Bucket, r: string[]) => {
    b.n++; const a = qAmt >= 0 ? num(r[qAmt] ?? "") : null; if (a != null) b.amt += a;
    const m = qRfq >= 0 ? month(r[qRfq] ?? "") : null; if (m) b.months.set(m, (b.months.get(m) ?? 0) + 1);
  };
  const stat = (r: string[]) => { const s = fold(r[qStatus] ?? ""); return /won/.test(s) ? "won" : /verbal/.test(s) ? "verbally awarded" : /quote sent/.test(s) ? "quote sent" : /lost/.test(s) ? "lost" : /no quote/.test(s) ? "no quote" : "other"; };
  const table = new Map<string, Bucket>();
  const get = (k: string) => { let b = table.get(k); if (!b) { b = mk(); table.set(k, b); } return b; };
  const matchedKeys = new Set<string>();
  q.rows.forEach((r) => {
    const m = matchOf(r);
    const key = `${stat(r)} | ${isOurs(r) ? "tagged ours" : "not tagged"} | ${m ? "matches a form lead (" + m + ")" : "no form match"}`;
    add(get(key), r);
    if (m) matchedKeys.add(key);
  });
  console.log("\nQuote log rows by status, tag and form match (count, total quote value):");
  for (const k of [...table.keys()].sort()) { const b = table.get(k)!; console.log(`  ${k}: ${b.n} rows, $${Math.round(b.amt)}`); }


  // The form sheet's own columns: outcomes, spam, months, sources. Aggregates only, never a cell of free text.
  const fc = (name: string) => fH.indexOf(fold(name));
  const cnt = (vals: string[]) => { const m = new Map<string, number>(); for (const v of vals) { const k = v.trim() || "(blank)"; m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
  const fStatus = fc("status"), fSpam = fc("spam"), fSub = fc("submitted on"), fVal = fc("notes value"), fSrc = fc("utm source"), fMed = fc("utm medium");
  console.log("\nForm sheet columns:");
  if (fStatus >= 0) console.log(`  Status values: ${cnt(f.rows.map((r) => r[fStatus] ?? "")).slice(0, 12).map(([k, v]) => `${k}=${v}`).join(" | ")}`);
  if (fSpam >= 0) console.log(`  SPAM column: ${cnt(f.rows.map((r) => r[fSpam] ?? "")).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(" | ")}`);
  if (fSrc >= 0) console.log(`  utm_source: ${cnt(f.rows.map((r) => r[fSrc] ?? "")).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(" | ")}`);
  if (fMed >= 0) console.log(`  utm_medium: ${cnt(f.rows.map((r) => r[fMed] ?? "")).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(" | ")}`);
  if (fVal >= 0) { const filled = f.rows.filter((r) => (r[fVal] ?? "").trim() !== ""); const nums = filled.map((r) => num(r[fVal] ?? "")).filter((x): x is number => x != null); console.log(`  Notes/Value: filled ${filled.length}/${f.rows.length}, readable as a number ${nums.length}, total ${Math.round(nums.reduce((a, b) => a + b, 0))}`); }
  if (fSub >= 0) { const mm = new Map<string, number>(); const gm = new Map<string, number>(); f.rows.forEach((r) => { const m = month(r[fSub] ?? ""); if (!m) return; mm.set(m, (mm.get(m) ?? 0) + 1); if (fClick.some((c) => (r[c] ?? "").trim() !== "")) gm.set(m, (gm.get(m) ?? 0) + 1); }); console.log(`  Leads by month: ${[...mm].sort().map(([m, n]) => `${m}:${n}`).join(" ")}`); console.log(`  with a click id by month: ${[...gm].sort().map(([m, n]) => `${m}:${n}`).join(" ")}`); }
  // Outcome recorded on the form sheet itself, split by whether the same person is in the quote log as won.
  if (fStatus >= 0) {
    const qWonEmails = new Set<string>();
    q.rows.forEach((r) => { if (stat(r) === "won") for (const c of qEmail) { const k = emailKey(r[c] ?? ""); if (k) qWonEmails.add(k); } });
    const won = f.rows.filter((r) => /won|closed|sold|customer/.test(fold(r[fStatus] ?? "")));
    const wonIn = won.filter((r) => fEmail.some((c) => { const k = emailKey(r[c] ?? ""); return !!k && qWonEmails.has(k); }));
    console.log(`  Form rows whose Status reads won/closed/sold/customer: ${won.length}; of those the same email is a won row in the quote log: ${wonIn.length}.`);
  }

  const cand = [...table].filter(([k]) => /not tagged \| matches/.test(k) && /^(won|verbally awarded|quote sent)/.test(k));
  console.log("\nCANDIDATES (a person in the form sheet who is in the quote log but not tagged as ours):");
  for (const [k, b] of cand) console.log(`  ${k}: ${b.n} rows, $${Math.round(b.amt)}; RFQ months ${[...b.months].sort().map(([m, n]) => `${m}:${n}`).join(" ") || "n/a"}`);
  const wonOursMatched = [...table].filter(([k]) => /^won \| tagged ours \| matches/.test(k)).reduce((s, [, b]) => s + b.n, 0);
  const wonOurs = [...table].filter(([k]) => /^won \| tagged ours/.test(k)).reduce((s, [, b]) => s + b.n, 0);
  console.log(`\nCheck: of ${wonOurs} won rows the log tags as ours, ${wonOursMatched} also match a form lead (a low number means the form sheet is not where those came from, or the log carries no email/phone for them).`);
}
main().catch((e) => { console.error(`crossmatch failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`); process.exit(1); });

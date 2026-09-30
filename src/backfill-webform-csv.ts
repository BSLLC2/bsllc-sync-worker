#!/usr/bin/env tsx
import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Replay a call-tracking or form export into the dashboard's webform endpoint.
 *
 * WHY THIS EXISTS. OCH's lead capture was dead from 2026-09-10 to 2026-09-30:
 * the shared WEBFORM_SECRET was rotated and neither of their two senders was
 * updated, so every post was answered 401 and CallTrackingMetrics eventually
 * switched its own webhook off. Nothing on our side is recoverable — the rows
 * were never written — so the only way back is the source system's own export.
 *
 * WHY IT POSTS RATHER THAN WRITING SQL. `/api/webform/:client` already holds
 * every rule this needs and they are rules we want applied: field extraction
 * by type and label, the CallTrackingMetrics shape detection, the 10-minute
 * same-person dedupe in `storage.createWebInquiry`, and `external_id` as the
 * idempotence key. A direct INSERT would be a second implementation of all of
 * it, drifting from the live path the day either changed. This worker holds no
 * database credential for `web_inquiries` and does not acquire one here.
 *
 * IDEMPOTENT BY CONSTRUCTION. Every row carries `call_id`, which the endpoint
 * turns into `external_id = ctm-<id>`, unique per client. Running this twice
 * writes once. That is what makes a partial run safe to simply re-run.
 *
 * DATED FROM THE SOURCE, NEVER FROM THE CLOCK. `submitted_at` is the call's
 * own date and time. Without it 300 calls land dated today, which is a worse
 * lie than the gap it was meant to fill — every month-by-month figure on that
 * client's dashboard would move.
 *
 * IT PRINTS NO ROW, EVER. These are a healthcare client's callers: names,
 * phone numbers, and in a form export dates of birth. Output is counts, dates
 * and — on a failure — the row INDEX and the status code. A row's content
 * never reaches a log, a summary or an error message. `--sample` prints the
 * SHAPE of what would be sent, with every value replaced by its type.
 *
 * Usage:
 *   npm run backfill-webform -- --file=export.csv --client=och --from=2026-09-11
 *   ...add --apply to actually send. Dry run is the default.
 *
 * Env: WEBFORM_KEY (required to apply), WEBFORM_URL (default work.bsllc.biz).
 */

/**
 * Exact misspellings seen in a source system's own tracking setup, and what
 * they were meant to be.
 *
 * AN ALLOWLIST OF EXACT STRINGS, NEVER A FUZZY MATCH. "googke" is a typo in
 * OCH's CallTrackingMetrics configuration on 74 calls; "google" is what it was
 * meant to say, and nothing else in that account's 25 distinct sources is
 * wrong. A distance-based guess would also "correct" `recoverycom`,
 * `rehabpath` and `an`, which are real values somebody chose.
 *
 * EVERY CORRECTION IS COUNTED AND PRINTED. A silent repair is indistinguishable
 * from data that was always right, and the next person to read the account's
 * own reports will still see the typo there. This fixes what WE store; the
 * client's own system is not written to by this tool or by anything it calls.
 *
 * NOT corrected, deliberately: `facebook` / `fb` / `www.facebook.com` are three
 * spellings of one source rather than a misspelling of any of them, and
 * choosing which is canonical is a decision about that account's taxonomy. They
 * are reported instead.
 */
const SOURCE_CORRECTIONS: Record<string, string> = {
  googke: "google",
};

/** Sources that differ only by punctuation, a www. prefix or a domain suffix —
 *  fragmentation a person should settle in the source system, not here. */
function fragmentedSources(counts: Map<string, number>): string[] {
  const stem = (v: string) => v.toLowerCase().replace(/^www\./, "").replace(/\.(com|org|net|de)$/, "");
  const groups = new Map<string, string[]>();
  for (const v of counts.keys()) {
    const k = stem(v);
    groups.set(k, [...(groups.get(k) ?? []), v]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.join(" / "));
}

type Row = string[];

/** RFC4180. The export has embedded newlines in its notes and transcript
 *  columns, so a line-based split reports 327,089 records where there are
 *  11,583 — which is how a backfill silently imports a third of nothing. */
function parseCsv(text: string): Row[] {
  const rows: Row[] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const arg = (n: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const has = (n: string): boolean => process.argv.includes(`--${n}`);

/** The export's own local wall-clock date and time, as an ISO instant.
 *  CallTrackingMetrics exports in the ACCOUNT's timezone with no offset on the
 *  value, so the offset is named on the command line rather than guessed — a
 *  silent UTC read would move an evening call into the next day and shift a
 *  month boundary. */
function instantFrom(date: string, time: string, offset: string): string | null {
  const d = (date ?? "").trim(), t = ((time ?? "").trim() || "00:00:00");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const hhmmss = /^\d{2}:\d{2}(:\d{2})?$/.test(t) ? (t.length === 5 ? `${t}:00` : t) : "00:00:00";
  const iso = `${d}T${hhmmss}${offset}`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() >= Date.now()) return null; // the endpoint refuses a future replay
  return parsed.toISOString();
}

async function main(): Promise<void> {
  const file = arg("file");
  const client = arg("client") ?? "och";
  const from = arg("from") ?? "1900-01-01";
  const to = arg("to") ?? "2999-12-31";
  const offset = arg("offset") ?? "-04:00";
  const apply = has("apply");
  const sample = has("sample");
  const perSecond = Number(arg("rate") ?? "2");

  if (!file) { console.error("Missing --file=<export.csv>"); process.exit(1); }

  // A directory is read as every .csv in it: Elementor exports ONE FILE PER
  // FORM, and a run per file would report six separate answers to one question.
  const files = statSync(file).isDirectory()
    ? readdirSync(file).filter((f) => f.toLowerCase().endsWith(".csv")).sort().map((f) => join(file, f))
    : [file];

  let outbound = 0, outOfWindow = 0, noId = 0, noPhone = 0, noDate = 0, parsed = 0;
  const corrected = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  /** Correct an exact known typo, count it, and leave everything else alone. */
  const fixSource = (v: string): string => {
    const raw = v.trim();
    if (!raw) return raw;
    sourceCounts.set(raw, (sourceCounts.get(raw) ?? 0) + 1);
    const fix = SOURCE_CORRECTIONS[raw.toLowerCase()];
    if (!fix) return raw;
    corrected.set(`${raw} -> ${fix}`, (corrected.get(`${raw} -> ${fix}`) ?? 0) + 1);
    return fix;
  };
  const bodies: { body: Record<string, unknown>; index: number }[] = [];

  for (const path of files) {
  const rows = parseCsv(readFileSync(path, "utf8"));
  const head = (rows[0] ?? []).map((h) => h.trim());
  // Elementor's column names vary BY FORM on the same site — "DOB" on one and
  // "DATE OF BIRTH" on the next, "gclid" and "GCLID" — so a column is found by
  // any of its spellings, case-insensitively, rather than by one literal.
  const ix = (...names: string[]) => {
    for (const n of names) {
      const hit = head.findIndex((h) => h.toLowerCase() === n.toLowerCase());
      if (hit >= 0) return hit;
    }
    return -1;
  };

  /** Which export this is, read from its OWN columns rather than a flag: a
   *  person passing --kind wrongly is a silent mis-import, and the two shapes
   *  share no identifying column. */
  const kind: "ctm" | "elementor" = ix("CallId") >= 0 ? "ctm"
    : ix("Submission ID") >= 0 ? "elementor"
    : (() => { console.error(`${path}: neither a CallTrackingMetrics export (no CallId) nor an Elementor one (no Submission ID) — refusing.`); process.exit(1); })() as never;

  const C = kind === "ctm" ? {
    name: ix("Name"), caller: ix("Customer #"), src: ix("Tracking Source"),
    date: ix("Date"), time: ix("Time"), gclid: ix("Google Click ID"),
    email: ix("Email"), dir: ix("Direction"), id: ix("CallId"), page: ix("Last URL"),
    // CallTrackingMetrics records the visit's own campaign attribution beside
    // the call. These are OBSERVED values, not ones we are inventing, so they
    // travel — `ATTRIBUTABLE_UTM_WORDS` in import-och.ts decides which of them
    // amount to a channel, and a blank stays blank. Without them a paid call
    // from 2025 lands as a lead with no channel and can never be attributed,
    // which is the whole reason for importing the history.
    utmCampaign: ix("campaign"), utmSource: ix("source"),
    utmMedium: ix("medium"), utmTerm: ix("keyword"),
  } : {
    first: ix("FIRST NAME"), last: ix("LAST NAME"), phone: ix("PHONE"), email: ix("EMAIL"),
    dob: ix("DATE OF BIRTH", "DOB"), gclid: ix("GCLID", "gclid"), created: ix("Created At"),
    id: ix("Submission ID"), form: ix("Form Name (ID)"), page: ix("Referrer"),
    utmCampaign: ix("utm_campaign"), utmSource: ix("utm_source"), utmMedium: ix("utm_medium"),
    utmContent: ix("utm_content"), utmTerm: ix("utm_term"),
  };
  for (const [k, v] of Object.entries(C)) {
    // An Elementor form with no DOB field is ordinary; a missing key column is not.
    if (v < 0 && !(kind === "elementor" && (k === "dob" || k === "gclid" || k.startsWith("utm")))) {
      console.error(`${path}: no "${k}" column — refusing rather than importing a column short.`);
      process.exit(1);
    }
  }

  const data = rows.slice(1).filter((r) => r.length > 3 && r.some((c) => c.trim()));
  parsed += data.length;

  if (kind === "elementor") {
    data.forEach((r, i) => {
      const at = (c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");
      const created = at(C.created as number);
      const day = created.slice(0, 10);
      if (day < from || day > to) { outOfWindow++; return; }
      const id = at(C.id as number);
      if (!id) { noId++; return; }
      const phone = at(C.phone as number).replace(/\D/g, "");
      const email = at(C.email as number);
      if (phone.length < 10 && !email) { noPhone++; return; }
      const submittedAt = instantFrom(day, created.slice(11) || "00:00:00", offset);
      if (!submittedAt) { noDate++; return; }
      // The form's own name, without Elementor's parenthesised id — a live
      // submission carries the plain name, and two spellings of one form would
      // read as two forms on the client's own per-form breakdown.
      const formName = at(C.form as number).replace(/\s*\([0-9a-f]+\)\s*$/i, "").trim();
      // DELIBERATELY NOT SENT: MESSAGE, Insurance Provider, Insurance ID
      // Number, User Agent, User IP, User ID and every field_<hash> column.
      // The insurance pair is health data about a named person and nothing
      // downstream reads it; the rest identifies a device, not a lead.
      bodies.push({
        index: i + 2,
        body: {
          external_id: `elementor-${id}`,
          submitted_at: submittedAt,
          form_name: formName || undefined,
          first_name: at(C.first as number),
          last_name: at(C.last as number),
          phone: at(C.phone as number),
          email,
          dob: at(C.dob as number) || undefined,
          gclid: at(C.gclid as number) || undefined,
          utm_campaign: at(C.utmCampaign as number) || undefined,
          utm_source: fixSource(at(C.utmSource as number)) || undefined,
          utm_medium: at(C.utmMedium as number) || undefined,
          utm_content: at(C.utmContent as number) || undefined,
          utm_term: at(C.utmTerm as number) || undefined,
          page_url: at(C.page as number) || undefined,
        },
      });
    });
    continue;
  }

  data.forEach((r, i) => {
    const at = (c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");
    if (at(C.dir as number) !== "inbound") { outbound++; return; }
    const d = at(C.date as number);
    if (d < from || d > to) { outOfWindow++; return; }
    const callId = at(C.id as number);
    if (!callId) { noId++; return; }               // no stable key = no idempotence = never send
    const phone = at(C.caller as number).replace(/\D/g, "");
    if (phone.length < 10) { noPhone++; return; }
    const submittedAt = instantFrom(d, at(C.time as number), offset);
    if (!submittedAt) { noDate++; return; }

    bodies.push({
      index: i + 2,                                 // the line a person would look at
      body: {
        source: "ctm",                              // recognised outright by extractWebformFields
        tracking_source: at(C.src as number) || undefined,
        call_id: callId,
        submitted_at: submittedAt,
        first_name: at(C.name as number) || "UNKNOWN CALLER",
        last_name: "",
        phone: at(C.caller as number),
        email: at(C.email as number),
        gclid: at(C.gclid as number),
        page_url: at(C.page as number),
        utm_campaign: at(C.utmCampaign as number) || undefined,
        utm_source: fixSource(at(C.utmSource as number)) || undefined,
        utm_medium: at(C.utmMedium as number) || undefined,
        utm_term: at(C.utmTerm as number) || undefined,
      },
    });
  });
  }

  const days = new Set(bodies.map((b) => String(b.body.submitted_at).slice(0, 10)));
  console.log(`${file}${files.length > 1 ? ` (${files.length} files)` : ""}`);
  console.log(`  parsed ${parsed} record(s); ${bodies.length} to send across ${days.size} day(s)`);
  console.log(`  left out — outbound ${outbound} · outside ${from}..${to} ${outOfWindow} · no call id ${noId} · no caller number ${noPhone} · undateable ${noDate}`);
  console.log(`  dates are read as ${offset}; pass --offset= to change that.`);
  if (corrected.size) {
    for (const [what, n] of corrected) console.log(`  corrected ${n} row(s): source ${what} — a typo in the source system, fixed here and NOT in their account.`);
  }
  const frags = fragmentedSources(sourceCounts);
  if (frags.length) console.log(`  not corrected — ${frags.length} source(s) spelled several ways, which is a taxonomy decision rather than a typo: ${frags.join(" · ")}`);

  if (sample && bodies[0]) {
    const shape = Object.fromEntries(Object.entries(bodies[0].body).map(([k, v]) =>
      [k, v === undefined ? "(absent)" : `<${typeof v}, ${String(v).length} chars>`]));
    console.log("  shape of one body (values replaced by their type):", JSON.stringify(shape));
  }

  if (!apply) { console.log("\nDry run — nothing was sent. Add --apply to send."); return; }

  const key = process.env.WEBFORM_KEY?.trim();
  if (!key) { console.error("WEBFORM_KEY is not set — refusing to send."); process.exit(1); }
  const base = (process.env.WEBFORM_URL ?? "https://work.bsllc.biz").replace(/\/$/, "");
  const url = `${base}/api/webform/${encodeURIComponent(client)}?key=${encodeURIComponent(key)}`;

  let sent = 0; const failures: { index: number; status: number | string }[] = [];
  const gap = Math.max(0, Math.round(1000 / Math.max(1, perSecond)));
  for (const { body, index } of bodies) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) sent++; else failures.push({ index, status: res.status });
    } catch (e) {
      failures.push({ index, status: e instanceof Error ? e.message.slice(0, 60) : "threw" });
    }
    if (gap) await new Promise((r) => setTimeout(r, gap));
  }

  console.log(`\nSent ${sent} of ${bodies.length}.`);
  if (failures.length) {
    // The INDEX and the status. Never the row.
    console.log(`${failures.length} failed:`);
    for (const f of failures.slice(0, 40)) console.log(`  line ${f.index} → ${f.status}`);
    if (failures.length > 40) console.log(`  ...and ${failures.length - 40} more`);
    console.log("Re-running is safe: every row carries call_id, so what landed will not land twice.");
    process.exit(2);
  }
  console.log("Re-running is safe: every row carries call_id, so nothing would be written twice.");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); });

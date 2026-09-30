#!/usr/bin/env tsx
import "dotenv/config";
import { readFileSync } from "node:fs";

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

  const rows = parseCsv(readFileSync(file, "utf8"));
  const head = (rows[0] ?? []).map((h) => h.trim());
  const ix = (n: string) => head.indexOf(n);
  const C = {
    name: ix("Name"), caller: ix("Customer #"), src: ix("Tracking Source"),
    date: ix("Date"), time: ix("Time"), gclid: ix("Google Click ID"),
    email: ix("Email"), dir: ix("Direction"), callId: ix("CallId"), page: ix("Last URL"),
  };
  for (const [k, v] of Object.entries(C)) {
    if (v < 0) { console.error(`This export has no "${k}" column — refusing rather than importing a column short.`); process.exit(1); }
  }

  const data = rows.slice(1).filter((r) => r.length > 5);
  let outbound = 0, outOfWindow = 0, noId = 0, noPhone = 0, noDate = 0;
  const bodies: { body: Record<string, unknown>; index: number }[] = [];

  data.forEach((r, i) => {
    const at = (c: number) => (r[c] ?? "").trim();
    if (at(C.dir) !== "inbound") { outbound++; return; }
    const d = at(C.date);
    if (d < from || d > to) { outOfWindow++; return; }
    const callId = at(C.callId);
    if (!callId) { noId++; return; }               // no stable key = no idempotence = never send
    const phone = at(C.caller).replace(/\D/g, "");
    if (phone.length < 10) { noPhone++; return; }
    const submittedAt = instantFrom(d, at(C.time), offset);
    if (!submittedAt) { noDate++; return; }

    bodies.push({
      index: i + 2,                                 // the line a person would look at
      body: {
        source: "ctm",                              // recognised outright by extractWebformFields
        tracking_source: at(C.src) || undefined,
        call_id: callId,
        submitted_at: submittedAt,
        first_name: at(C.name) || "UNKNOWN CALLER",
        last_name: "",
        phone: at(C.caller),
        email: at(C.email),
        gclid: at(C.gclid),
        page_url: at(C.page),
      },
    });
  });

  const days = new Set(bodies.map((b) => String(b.body.submitted_at).slice(0, 10)));
  console.log(`${file}`);
  console.log(`  parsed ${data.length} record(s); ${bodies.length} to send across ${days.size} day(s)`);
  console.log(`  left out — outbound ${outbound} · outside ${from}..${to} ${outOfWindow} · no call id ${noId} · no caller number ${noPhone} · undateable ${noDate}`);
  console.log(`  dates are read as ${offset}; pass --offset= to change that.`);

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

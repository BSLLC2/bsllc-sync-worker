/**
 * ENHANCED CONVERSIONS FOR LEADS: the hashed phone and email that ride with an offline conversion (R25).
 *
 * One code path for every client in the offline catalog (app: shared/offline-pipelines.ts). The OCH admissions job uses
 * it today; the sales-sheet uploader gets it by moving to src/ads/data-manager.ts, which it must do anyway. Never a
 * second pipeline.
 *
 * NORMALISATION, per Google's Data Manager formatting guide (developers.google.com/data-manager/api/devguides/concepts/formatting,
 * read 2026-11-22):
 *   - Email: trim, lowercase. For gmail.com and googlemail.com only: remove every dot before the @, and remove a plus
 *     sign and everything after it in the local part. Other domains keep their dots and plus signs.
 *   - Phone: E.164, the plus sign and the country code, digits only after the plus. A 10 digit number is a US number
 *     (+1); 11 digits starting 1 is a US number; a number typed with a leading + keeps its own country code. Anything
 *     else is not a phone we can send.
 *   - Hash: SHA-256 of the normalised value, hex encoded. The request says so with `encoding: "HEX"`.
 *
 * PRIVACY. The raw value and the hash live only in memory for the length of one request: computed, sent, discarded.
 * Nothing here logs, stores or returns them except inside the request body. What may be logged or recorded is
 * `identifierCounts()` (numbers only). `src/verify-enhanced-identifiers.ts` holds this file, the job and the Data
 * Manager module to that, and plants a leak to prove it would catch one.
 *
 * THE OCH GATE. OCH's identifiers go to Google, on a send or a validate pass, only when the repo variable
 * OCH_ENHANCED_IDENTIFIERS is exactly "send" (default off: waiting on OCH's written compliance OK, 42 CFR Part 2
 * consent). A validate call still transmits, so it is gated too. Other live clients carry them whenever
 * their upload is live. A churned client never does.
 */
import { createHash } from "node:crypto";

export const OCH_SLUG = "ohio-community-health-och";
/** Churned: never sent anything. Kept in step with the app's churned-client catalog. */
const CHURNED_SLUGS = new Set(["franklin-brazing"]);
export const OCH_SWITCH_VAR = "OCH_ENHANCED_IDENTIFIERS";

export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1 || /\s/.test(s)) return null;
  let local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!domain.includes(".")) return null;
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replace(/\./g, "");
    if (!local) return null;
  }
  return `${local}@${domain}`;
}

export function normalisePhoneE164(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  const d = s.replace(/\D/g, "");
  if (s.startsWith("+")) return d.length >= 8 && d.length <= 15 && d[0] !== "0" ? `+${d}` : null;
  if (d.length === 10 && /^[2-9]/.test(d)) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1") && /^[2-9]/.test(d.slice(1))) return `+${d}`;
  return null;
}

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** One Data Manager UserIdentifier: exactly one field set. */
export type UserIdentifier = { emailAddress: string } | { phoneNumber: string };

/** The hashed identifiers for one person. Empty when neither value normalises. Goes straight into a request body. */
export function hashedIdentifiers(person: { phone?: unknown; email?: unknown }): UserIdentifier[] {
  const out: UserIdentifier[] = [];
  const e = normaliseEmail(person.email);
  if (e) out.push({ emailAddress: sha256Hex(e) });
  const p = normalisePhoneE164(person.phone);
  if (p) out.push({ phoneNumber: sha256Hex(p) });
  return out;
}

export interface IdentifierGate { include: boolean; switchOn: boolean; reason: string }

/** Whether this run's rows carry identifiers. Pure: the caller passes the environment. */
export function identifierGate(clientSlug: string, sending: boolean, env: Record<string, string | undefined>): IdentifierGate {
  if (CHURNED_SLUGS.has(clientSlug)) return { include: false, switchOn: false, reason: "churned client, nothing is sent" };
  if (clientSlug !== OCH_SLUG) return { include: true, switchOn: true, reason: "on for a live upload" };
  const switchOn = env[OCH_SWITCH_VAR]?.trim() === "send";
  // A validate call still transmits the hashes to Google, so OCH's gate covers validate too:
  // nothing about an OCH patient leaves us before OCH's written compliance OK.
  return switchOn
    ? { include: true, switchOn, reason: sending ? `${OCH_SWITCH_VAR}=send` : `validate with ${OCH_SWITCH_VAR}=send` }
    : { include: false, switchOn, reason: `off until ${OCH_SWITCH_VAR}=send (waiting on OCH's compliance OK)` };
}

export interface IdentifierCounts { rows: number; withPhone: number; withEmail: number; withEither: number }

/** Counts only: how many rows carried each kind. The one thing about identifiers that may be logged or recorded. */
export function identifierCounts(rows: readonly { userIdentifiers?: readonly UserIdentifier[] }[]): IdentifierCounts {
  let withPhone = 0, withEmail = 0, withEither = 0;
  for (const r of rows) {
    const ids = r.userIdentifiers ?? [];
    const p = ids.some((i) => "phoneNumber" in i), e = ids.some((i) => "emailAddress" in i);
    if (p) withPhone++;
    if (e) withEmail++;
    if (p || e) withEither++;
  }
  return { rows: rows.length, withPhone, withEmail, withEither };
}

/** The one log line. Numbers and words only. */
export function identifierSummary(c: IdentifierCounts, gate: IdentifierGate): string {
  const counts = `${c.withPhone} of ${c.rows} carried a phone hash, ${c.withEmail} an email hash`;
  return gate.include ? `Matching by phone or email: on (${gate.reason}). ${counts}.` : `Matching by phone or email: off (${gate.reason}). Would have been: ${counts}.`;
}

/** What the job records in app_settings under `enhanced_identifiers:<slug>` for the app's Setup row. Counts only. */
export const identifierRecordKey = (clientSlug: string): string => `enhanced_identifiers:${clientSlug}`;
export function identifierRecord(c: IdentifierCounts, gate: IdentifierGate, api: "validate" | "send", at: Date): string {
  return JSON.stringify({ at: at.toISOString(), api, switchOn: gate.switchOn, included: gate.include, ...c });
}

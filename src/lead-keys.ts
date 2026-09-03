/**
 * The keys that tie a website lead (web_inquiries) to a real admission (the
 * Admission Board sheet). Shared by import-och, import-offline-conversions and
 * import-web-inquiries so all three agree — the DOB key was silently dead
 * before this: the webhook stored "1990-05-06" (→ digits 19900506) while the
 * sheet's formatted cell gave "5/6/1990" (→ 561990), so lastname|dob never
 * matched anything.
 */

export const digits = (s: unknown): string => String(s ?? "").replace(/[^0-9]/g, "");

/** Last 10 digits, or null when there aren't 10 — never a partial number. */
export function phone10(s: unknown): string | null {
  const d = digits(s).slice(-10);
  return d.length === 10 ? d : null;
}

/** Canonical YYYY-MM-DD for a DOB in any of the shapes we see: an HTML date
 *  input (1990-05-06), a typed US date (5/6/1990, 05-06-90), or a spreadsheet
 *  serial-formatted cell. Unknown shapes come back verbatim (trimmed). */
export function normalizeDob(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += y < 30 ? 2000 : 1900;
    return `${y}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return s;
}

/** "lastname|YYYYMMDD" or null — the secondary match key when phone is absent. */
export function lastDobKey(lastName: unknown, dob: unknown): string | null {
  const last = String(lastName ?? "").trim().toLowerCase();
  const d = digits(normalizeDob(dob));
  return last && d.length === 8 ? `${last}|${d}` : null;
}

/** Last word of a full name, lowercased — what the sheet's single Name column
 *  yields; the webhook stores last_name separately. */
export function lastNameOf(fullName: unknown): string {
  return String(fullName ?? "").trim().split(/\s+/).pop()?.toLowerCase() ?? "";
}

/** A sheet date cell → a UTC Date at midnight, or null. Explicit M/D/YYYY
 *  first so the result never depends on the runner's local timezone (a bare
 *  `new Date("9/1/2026")` is local time and, read back as UTC, can land on
 *  8/31 in a UTC+ zone). */
export function parseSheetDate(v: unknown): Date | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2])));
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ── Admission status classification ─────────────────────────────────────
// Shared by import-och and import-offline-conversions so both agree on
// which sheet rows count as an admission. Whole-word tokens, not substring
// matches: the old regexes turned "Admitted (no insurance)" into a denial
// via the "no" inside the parenthetical and treated "Discharged" (an
// admission that already ended) as not admitted. OCH's live vocabulary —
// "Admitted", "Did Not Admit", "Not Qualified", "Referred Out", "Potential"
// — all classify correctly here.
const STATUS_DENY = new Set(["not", "no", "denied", "lost", "inactive", "potential", "referred", "qualified", "tbd"]);
const STATUS_DENY_PREFIXES = ["declin", "reject"];
const STATUS_ALLOW = new Set(["admitted", "enrolled", "accepted", "active", "discharged", "won", "y", "yes", "1"]);
const STATUS_ALLOW_PREFIXES = ["admit", "complete"];

/** True only when the status carries an ALLOW word and no DENY word.
 *  Parenthetical qualifiers ("Admitted (no insurance)") are dropped before
 *  tokenizing so a note never negates the disposition. Anything with
 *  neither kind of word is NOT admitted, and is collected into
 *  `unrecognized` (when given) so the run can print it once at the end —
 *  a new label appearing on the sheet should be visible, not silently
 *  dropped. */
export function isAdmittedStatus(cell: unknown, unrecognized?: Set<string>): boolean {
  const raw = String(cell ?? "").trim();
  const tokens = raw.toLowerCase().replace(/\([^)]*\)/g, " ").split(/[^a-z0-9]+/).filter(Boolean);
  const deny = tokens.some((t) => STATUS_DENY.has(t) || STATUS_DENY_PREFIXES.some((p) => t.startsWith(p)));
  const allow = tokens.some((t) => STATUS_ALLOW.has(t) || STATUS_ALLOW_PREFIXES.some((p) => t.startsWith(p)));
  if (allow && !deny) return true;
  if (!deny && !allow) unrecognized?.add(raw || "(blank)");
  return false;
}

/** Print the statuses isAdmittedStatus couldn't classify — once, at the end
 *  of a run — so a new sheet label gets added to the lists above instead of
 *  quietly zeroing out admissions. */
export function reportUnrecognizedStatuses(unrecognized: Set<string>): void {
  if (!unrecognized.size) return;
  console.warn(
    `Unrecognized status value(s) treated as NOT admitted — add to lead-keys.ts if any is a real admission: ${Array.from(unrecognized).map((s) => `"${s}"`).join(", ")}`,
  );
}

export const ymd = (d: Date): string => d.toISOString().slice(0, 10);
export const ym = (d: Date): string => d.toISOString().slice(0, 7);

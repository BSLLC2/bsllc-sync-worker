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

export const ymd = (d: Date): string => d.toISOString().slice(0, 10);
export const ym = (d: Date): string => d.toISOString().slice(0, 7);

/**
 * Bringing every source's address to one form: a path.
 *
 * COPIED BYTE FOR BYTE from the dashboard app's `normPath` in
 * `shared/seo-ux-readings.ts`, because the repositories cannot import from each
 * other. `npm run verify:wiring` in the app reads both and fails on drift, and
 * `npm run verify-page-behaviour` here runs this against the same cases the app's
 * tests use. The reading applies the rule again on its side so a row written by an
 * older build still lines up; the rule is idempotent.
 */
export function normPath(input: string): string {
  const raw = String(input ?? "").trim();
  if (raw === "*") return "*";
  let p = raw;
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(p);
  if (m) p = m[1] ?? "/";
  p = p.split("#")[0]!.split("?")[0]!;
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

/** The origin of a client's site from what is on the record, or null. */
export function siteOrigin(domain: string | null | undefined, observedUrls: readonly string[] = []): string | null {
  // A page the page reader actually reached beats a typed domain: it shows www or not.
  for (const u of observedUrls) {
    const m = /^(https?:\/\/[^/]+)/i.exec(String(u ?? "").trim());
    if (m) return m[1]!.toLowerCase();
  }
  const raw = String(domain ?? "").trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const m = /^(https?:\/\/[^/\s]+)/i.exec(withScheme);
  return m ? m[1]!.toLowerCase() : null;
}

/** GA4 reports "(not set)" for a page it could not place; that is not a page. */
export const isRealPath = (p: string): boolean => p.length > 0 && !/^\(.*\)$/.test(p.trim()) && p.trim() !== "";

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return ymd(new Date(Date.UTC(y, m - 1, d + n)));
}

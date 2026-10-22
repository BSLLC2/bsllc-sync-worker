/**
 * The Postgres connection string, with the certificate check spelled out.
 *
 * `pg` treats sslmode=require, prefer and verify-ca as aliases for verify-full and
 * prints a warning about it. Saying verify-full ourselves keeps the behaviour that
 * is already in force and removes the warning. A local database (a test cluster on
 * this machine) is left alone: it has no certificate to check.
 */
export function withVerifyFull(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return raw;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return raw;
  if (u.searchParams.get("sslmode") === "disable") return raw;
  u.searchParams.set("sslmode", "verify-full");
  return u.toString();
}

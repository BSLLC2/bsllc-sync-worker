/**
 * The secrets the WebOps readers use, read HERE and nowhere else.
 *
 *   WP_UMBRELLA_API_KEY   one Bearer key per WP Umbrella account (also accepted under
 *                         the older name WPUMBRELLA_API_KEY, which the existing
 *                         import-webops workflow already maps).
 *
 * The public site check and the RDAP domain check need no secret. SiteGround has no
 * API and nothing here talks to it. A missing secret is a value the caller handles and
 * a message that says where it goes; a guard fails any other file under src/ that
 * names it.
 */
export type Env = Record<string, string | undefined>;

export const WEBOPS_SECRET = "WP_UMBRELLA_API_KEY" as const;

export const missingUmbrellaMessage = (): string =>
  `${WEBOPS_SECRET} is not set on the worker, so WordPress versions, backups and uptime were not read. Add it as a repository secret named ${WEBOPS_SECRET}; docs/WEBOPS-READERS.md has the steps.`;

export function umbrellaKey(env: Env = process.env): string | null {
  const v = (env[WEBOPS_SECRET] ?? env.WPUMBRELLA_API_KEY ?? "").trim();
  return v || null;
}

/** Base URL override, for the guard's pretend server and for a white-label host. Not a secret. */
export function umbrellaBase(env: Env = process.env): string {
  return (env.WP_UMBRELLA_BASE?.trim() || "https://api.wp-umbrella.com").replace(/\/+$/, "");
}

export function webopsSecretValues(env: Env = process.env): string[] {
  const k = umbrellaKey(env);
  return k ? [k] : [];
}

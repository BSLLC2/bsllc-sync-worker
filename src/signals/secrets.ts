/**
 * Every secret the four newer readers use, read HERE and nowhere else.
 *
 * WHY ONE FILE. A secret read in six places is a secret whose absence is handled
 * in six ways, and one of them is silence. Here a missing secret is a value the
 * caller must handle, and the helper below turns it into a message that names the
 * secret and says where it goes. The guards fail if any other file under src/
 * reads one of these by name.
 *
 *   BING_WEBMASTER_API_KEY     one key per Bing account (Bing Webmaster Tools).
 *   GBP_OAUTH_CLIENT_JSON      the Google Cloud OAuth client for Business Profile:
 *                              {"clientId": "...", "clientSecret": "..."}.
 *   GBP_TOKENS_JSON            {"<client slug>": {"refreshToken": "..."}}, one per
 *                              client whose Business Profile has been authorised.
 *   CTM_ACCOUNT_KEYS_JSON      {"<client slug>": {"accessKey": "...", "secretKey": "...",
 *                              "accountId": "..."}} (accountId is CTM's account number).
 *   CTM_CALLER_HASH_KEY        the key a caller's number is hashed with (HMAC-SHA256).
 *                              It must stay the same for ever, or repeat callers stop
 *                              matching. There is NO fallback: without it no call is
 *                              written, because an unsalted hash of a phone number is
 *                              the number.
 *
 * The existing GOOGLE_SERVICE_ACCOUNT_JSON (URL Inspection) is read where the other
 * Google readers read it; it is named in the run's message when it is missing.
 */

export type Env = Record<string, string | undefined>;

export const SECRET_NAMES = {
  bing: "BING_WEBMASTER_API_KEY",
  gbpClient: "GBP_OAUTH_CLIENT_JSON",
  gbpTokens: "GBP_TOKENS_JSON",
  ctmKeys: "CTM_ACCOUNT_KEYS_JSON",
  ctmHash: "CTM_CALLER_HASH_KEY",
  serviceAccount: "GOOGLE_SERVICE_ACCOUNT_JSON",
} as const;

/** Where each secret is created and where it goes, for the message a missing one prints. */
export const SECRET_WHERE: Record<string, string> = {
  BING_WEBMASTER_API_KEY: "Create the key in Bing Webmaster Tools (Settings, API access), then add it as a repository secret named BING_WEBMASTER_API_KEY. docs/INTEGRATIONS-SETUP.md in the dashboard repository has the steps.",
  GBP_OAUTH_CLIENT_JSON: "Add the Google Cloud OAuth client for Business Profile as a repository secret named GBP_OAUTH_CLIENT_JSON. docs/INTEGRATIONS-SETUP.md has the steps.",
  GBP_TOKENS_JSON: "Add a repository secret named GBP_TOKENS_JSON holding each client's refresh token by client slug. docs/INTEGRATIONS-SETUP.md has the steps.",
  CTM_ACCOUNT_KEYS_JSON: "Add a repository secret named CTM_ACCOUNT_KEYS_JSON holding each client's CallTrackingMetrics keys by client slug. docs/INTEGRATIONS-SETUP.md has the steps.",
  CTM_CALLER_HASH_KEY: "Add a repository secret named CTM_CALLER_HASH_KEY: any long random string, kept for good. docs/INTEGRATIONS-SETUP.md has the steps.",
  GOOGLE_SERVICE_ACCOUNT_JSON: "This is the service account the other Google readers use. It is already a repository secret; check it was not removed.",
};

/** A message that names the secret, says what it stops, and where it is added. */
export const missingSecretMessage = (name: string, stops: string): string =>
  `${name} is not set on the worker, so ${stops}. ${SECRET_WHERE[name] ?? ""}`.trim();

const clean = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);

export function bingApiKey(env: Env = process.env): string | null {
  return clean(env[SECRET_NAMES.bing]);
}

export function ctmHashKey(env: Env = process.env): string | null {
  const k = clean(env[SECRET_NAMES.ctmHash]);
  // A short key is a weak one. The hash of a ten-digit number under a short key is
  // quickly reversed, so a key under 24 characters is treated as not set.
  return k && k.length >= 24 ? k : null;
}

export interface GbpClient { clientId: string; clientSecret: string }
export function gbpOAuthClient(env: Env = process.env): GbpClient | null {
  const raw = clean(env[SECRET_NAMES.gbpClient]);
  if (!raw) return null;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { throw new Error(`${SECRET_NAMES.gbpClient} is not valid JSON.`); }
  const o = (j ?? {}) as Record<string, unknown>;
  const clientId = typeof o.clientId === "string" ? o.clientId.trim() : "";
  const clientSecret = typeof o.clientSecret === "string" ? o.clientSecret.trim() : "";
  if (!clientId || !clientSecret) throw new Error(`${SECRET_NAMES.gbpClient} must be {"clientId": "...", "clientSecret": "..."}.`);
  return { clientId, clientSecret };
}

function slugMap(name: string, env: Env): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const raw = clean(env[name]);
  if (!raw) return out;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { throw new Error(`${name} is not valid JSON.`); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error(`${name} must be an object of client slug to an object.`);
  for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v)) out.set(k.trim().toLowerCase(), v as Record<string, unknown>);
  }
  return out;
}

export function gbpRefreshTokens(env: Env = process.env): Map<string, string> {
  const out = new Map<string, string>();
  for (const [slug, o] of slugMap(SECRET_NAMES.gbpTokens, env)) {
    const t = typeof o.refreshToken === "string" ? o.refreshToken.trim() : "";
    if (t) out.set(slug, t);
  }
  return out;
}

export interface CtmKeys { accessKey: string; secretKey: string; accountId: string | null }
export function ctmAccountKeys(env: Env = process.env): Map<string, CtmKeys> {
  const out = new Map<string, CtmKeys>();
  for (const [slug, o] of slugMap(SECRET_NAMES.ctmKeys, env)) {
    const accessKey = typeof o.accessKey === "string" ? o.accessKey.trim() : "";
    const secretKey = typeof o.secretKey === "string" ? o.secretKey.trim() : "";
    const accountId = typeof o.accountId === "string" || typeof o.accountId === "number" ? String(o.accountId).trim() : "";
    if (accessKey && secretKey) out.set(slug, { accessKey, secretKey, accountId: accountId || null });
  }
  return out;
}

/** The values a message or a stored detail must never carry, for `safeMessage`. */
export function secretValues(env: Env = process.env): string[] {
  const vals: string[] = [];
  for (const n of Object.values(SECRET_NAMES)) {
    const v = clean(env[n]);
    if (!v) continue;
    vals.push(v);
    // The parts of a JSON secret are secrets too.
    try {
      const j = JSON.parse(v) as unknown;
      const walk = (x: unknown) => {
        if (typeof x === "string" && x.length > 6) vals.push(x);
        else if (x && typeof x === "object") Object.values(x as Record<string, unknown>).forEach(walk);
      };
      walk(j);
    } catch { /* not JSON: the whole value is already in */ }
  }
  return vals;
}

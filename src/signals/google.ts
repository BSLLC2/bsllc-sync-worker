/**
 * A Google access token for the service account the other readers use.
 *
 * `GOOGLE_SERVICE_ACCOUNT_JSON` is read here for the URL Inspection reader, in the
 * same way `src/read-page-behaviour.ts` reads it. Under the test seam the token is
 * asked of `<SIGNALS_FAKE_BASE>/token`, so a pretend Google can refuse it.
 */
import { JWT } from "google-auth-library";
import { SECRET_NAMES, missingSecretMessage } from "./secrets.js";
import { signalsFakeBase } from "./common.js";

export interface ServiceAccount { client_email: string; private_key: string }

export function serviceAccount(env: Record<string, string | undefined> = process.env): ServiceAccount {
  const raw = env[SECRET_NAMES.serviceAccount];
  if (!raw || !raw.trim()) throw new Error(missingSecretMessage(SECRET_NAMES.serviceAccount, "no Search Console page can be inspected"));
  let json: { client_email?: string; private_key?: string };
  try { json = JSON.parse(raw); } catch { throw new Error(`${SECRET_NAMES.serviceAccount} is not valid JSON.`); }
  if (!json.client_email || !json.private_key) throw new Error(`${SECRET_NAMES.serviceAccount} is missing client_email or private_key.`);
  return json as ServiceAccount;
}

const cache = new Map<string, string>();

/** A token for one scope. Throws a plain message where Google refuses the key. */
export async function googleToken(scope: string, sa: ServiceAccount): Promise<string> {
  const hit = cache.get(scope);
  if (hit) return hit;
  const fake = signalsFakeBase();
  let token: string | null | undefined;
  if (fake) {
    const res = await fetch(`${fake}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope, email: sa.client_email }) });
    if (!res.ok) throw new Error(`Google refused the service account (${res.status}).`);
    token = ((await res.json()) as { access_token?: string }).access_token;
  } else {
    token = (await new JWT({ email: sa.client_email, key: sa.private_key, scopes: [scope] }).getAccessToken()).token;
  }
  if (!token) throw new Error("Could not mint a Google access token from the service account.");
  cache.set(scope, token);
  return token;
}
